import { mkdir, readdir, readFile, rename, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { ToolRegistry } from '@dbagent/core-agent';
import { resolveInsideWorkspace, toPortablePath, type WorkspaceCore } from '@dbagent/core-workspace';
import { optionalPositiveInteger, optionalString, requireString } from './validation.js';

export type WorkspaceToolDependencies = {
  registry: ToolRegistry;
  workspace: WorkspaceCore;
  getWorkspaceRoot: () => string | undefined | Promise<string | undefined>;
};

const managedSearchRoots = ['queries', 'sql', 'scripts', 'skills', 'docs', 'outputs', 'notebooks'] as const;
const defaultSearchLimit = 100;
const defaultGrepMaxFileBytes = 512 * 1024;
const defaultReadMaxBytes = 1024 * 1024;
const ignoredDirectoryNames = new Set(['.git', '.dbagent', 'node_modules']);

export function registerWorkspaceTools(dependencies: WorkspaceToolDependencies): void {
  const { registry, workspace, getWorkspaceRoot } = dependencies;

  registry.register(
    {
      name: 'list_workspace_dir',
      description: 'List files and directories under the active workspace. Paths must be workspace-relative.',
      inputSchema: objectSchema({
        path: { type: 'string' },
      }),
      dangerLevel: 'safe',
      readonly: true,
    },
    async (args) => {
      const rootPath = await requireWorkspaceRoot(getWorkspaceRoot);
      const relativePath = optionalString(args, 'path') ?? '.';
      return {
        entries: await workspace.listFiles(rootPath, relativePath),
      };
    },
  );

  registry.register(
    {
      name: 'read_workspace_file',
      description: 'Read a UTF-8 text file from the active workspace. Paths must be workspace-relative.',
      inputSchema: objectSchema({
        path: { type: 'string' },
        maxBytes: { type: 'number' },
      }),
      dangerLevel: 'safe',
      readonly: true,
    },
    async (args) => {
      const rootPath = await requireWorkspaceRoot(getWorkspaceRoot);
      const path = requireString(args, 'path');
      const maxBytes = optionalPositiveInteger(args, 'maxBytes', defaultReadMaxBytes);
      const content = await workspace.readFile(rootPath, path, maxBytes);
      return {
        path,
        content,
        bytes: Buffer.byteLength(content, 'utf8'),
      };
    },
  );

  registry.register(
    {
      name: 'write_workspace_file',
      description:
        'Write a UTF-8 text file inside the active workspace using the workspace atomic-write boundary. Paths must be workspace-relative.',
      inputSchema: objectSchema({
        path: { type: 'string' },
        content: { type: 'string' },
      }),
      dangerLevel: 'medium',
      readonly: false,
    },
    async (args) => {
      const rootPath = await requireWorkspaceRoot(getWorkspaceRoot);
      const path = requireString(args, 'path');
      const content = requireString(args, 'content');
      return workspace.writeFile(rootPath, path, content);
    },
  );

  registry.register(
    {
      name: 'edit_workspace_file',
      description:
        'Edit a UTF-8 text file inside the active workspace by replacing an exact text fragment. Multiple matches require replaceAll=true.',
      inputSchema: objectSchema({
        path: { type: 'string' },
        oldText: { type: 'string' },
        newText: { type: 'string' },
        replaceAll: { type: 'boolean' },
        maxBytes: { type: 'number' },
      }),
      dangerLevel: 'medium',
      readonly: false,
    },
    async (args) => {
      const rootPath = await requireWorkspaceRoot(getWorkspaceRoot);
      const path = requireString(args, 'path');
      const oldText = requireString(args, 'oldText');
      const newText = requireString(args, 'newText');
      const replaceAll = optionalBoolean(args, 'replaceAll', false);
      const maxBytes = optionalPositiveInteger(args, 'maxBytes', defaultReadMaxBytes);
      const content = await workspace.readFile(rootPath, path, maxBytes);
      const matches = countOccurrences(content, oldText);
      if (matches === 0) throw new Error('Workspace edit target text was not found.');
      if (matches > 1 && !replaceAll) {
        throw new Error('Workspace edit target text is ambiguous. Set replaceAll=true or provide a more specific oldText.');
      }

      const updated = replaceAll ? content.split(oldText).join(newText) : replaceOnce(content, oldText, newText);
      const result = await workspace.writeFile(rootPath, path, updated);
      return {
        ...result,
        path,
        replacements: replaceAll ? matches : 1,
        oldBytes: Buffer.byteLength(content, 'utf8'),
        newBytes: result.bytes,
      };
    },
  );

  registry.register(
    {
      name: 'delete_workspace_file',
      description:
        'Move a file from the active workspace into the managed workspace trash folder. Directories cannot be deleted by this tool.',
      inputSchema: objectSchema({
        path: { type: 'string' },
      }),
      dangerLevel: 'medium',
      readonly: false,
    },
    async (args) => {
      const rootPath = await requireWorkspaceRoot(getWorkspaceRoot);
      const path = requireString(args, 'path');
      const normalizedPath = normalizeToolPath(path);
      if (normalizedPath.startsWith('outputs/_trash/')) throw new Error('Workspace trash files cannot be deleted by this tool.');
      const absolutePath = resolveInsideWorkspace(rootPath, normalizedPath);
      const info = await stat(absolutePath);
      if (!info.isFile()) throw new Error('Workspace delete only supports files.');

      const trashPath = buildTrashPath(normalizedPath);
      const absoluteTrashPath = resolveInsideWorkspace(rootPath, trashPath);
      await mkdir(dirname(absoluteTrashPath), { recursive: true });
      await rename(absolutePath, absoluteTrashPath);
      return {
        path: normalizedPath,
        deleted: true,
        trashPath,
        undoAvailable: true,
        bytes: info.size,
      };
    },
  );

  registry.register(
    {
      name: 'glob_workspace',
      description:
        'Find files and directories in the active workspace that match a glob pattern such as sql/**/*.sql or scripts/**/*.py.',
      inputSchema: objectSchema({
        pattern: { type: 'string' },
        limit: { type: 'number' },
        includeHidden: { type: 'boolean' },
      }),
      dangerLevel: 'safe',
      readonly: true,
    },
    async (args) => {
      const rootPath = await requireWorkspaceRoot(getWorkspaceRoot);
      const pattern = normalizeGlobPattern(requireString(args, 'pattern'));
      const limit = optionalPositiveInteger(args, 'limit') ?? defaultSearchLimit;
      const includeHidden = optionalBoolean(args, 'includeHidden', false);
      const matcher = globPatternToRegExp(pattern);
      const searchRoots = searchRootsForPattern(rootPath, pattern);
      const matches: Array<{ path: string; type: 'file' | 'directory' }> = [];
      for (const searchRoot of searchRoots) {
        await walkWorkspace(rootPath, searchRoot, { includeHidden, shouldStop: () => matches.length >= limit }, (entry) => {
          if (matches.length >= limit) return;
          if (matcher.test(entry.path)) matches.push(entry);
        });
      }
      return { pattern, matches, count: matches.length, truncated: matches.length >= limit };
    },
  );

  registry.register(
    {
      name: 'grep_workspace',
      description:
        'Search UTF-8 workspace files for a text query and return path, line, column, and preview matches.',
      inputSchema: objectSchema({
        query: { type: 'string' },
        path: { type: 'string' },
        include: { type: 'string' },
        limit: { type: 'number' },
        maxFileBytes: { type: 'number' },
        caseSensitive: { type: 'boolean' },
      }),
      dangerLevel: 'safe',
      readonly: true,
    },
    async (args) => {
      const rootPath = await requireWorkspaceRoot(getWorkspaceRoot);
      const query = requireString(args, 'query');
      const relativePath = optionalString(args, 'path') ?? '.';
      const include = optionalString(args, 'include');
      const includeMatcher = include ? globPatternToRegExp(normalizeGlobPattern(include)) : undefined;
      const limit = optionalPositiveInteger(args, 'limit') ?? defaultSearchLimit;
      const maxFileBytes = optionalPositiveInteger(args, 'maxFileBytes') ?? defaultGrepMaxFileBytes;
      const caseSensitive = optionalBoolean(args, 'caseSensitive', false);
      const searchRoots = searchRootsForPath(rootPath, relativePath);
      const matches: Array<{ path: string; line: number; column: number; preview: string }> = [];
      for (const searchRoot of searchRoots) {
        await walkWorkspace(rootPath, searchRoot, { includeHidden: false, shouldStop: () => matches.length >= limit }, async (entry) => {
          if (matches.length >= limit || entry.type !== 'file') return;
          if (includeMatcher && !includeMatcher.test(entry.path)) return;
          const fileMatches = await grepFile(entry.absolutePath, entry.path, query, {
            caseSensitive,
            limit: limit - matches.length,
            maxFileBytes,
          });
          matches.push(...fileMatches);
        });
      }
      return {
        query,
        path: relativePath,
        matches,
        count: matches.length,
        truncated: matches.length >= limit,
      };
    },
  );
}

async function requireWorkspaceRoot(
  getWorkspaceRoot: () => string | undefined | Promise<string | undefined>,
): Promise<string> {
  const rootPath = await getWorkspaceRoot();
  if (!rootPath) throw new Error('No active workspace.');
  return rootPath;
}

function objectSchema(properties: Record<string, Record<string, unknown>>): Record<string, unknown> {
  return {
    type: 'object',
    properties,
  };
}

function optionalBoolean(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`Tool argument "${key}" must be a boolean.`);
  return value;
}

function normalizeToolPath(path: string): string {
  return toPortablePath(path.trim()).replace(/^\/+/, '');
}

function countOccurrences(content: string, text: string): number {
  let count = 0;
  let index = content.indexOf(text);
  while (index !== -1) {
    count += 1;
    index = content.indexOf(text, index + text.length);
  }
  return count;
}

function replaceOnce(content: string, oldText: string, newText: string): string {
  const index = content.indexOf(oldText);
  return `${content.slice(0, index)}${newText}${content.slice(index + oldText.length)}`;
}

function buildTrashPath(path: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = Math.random().toString(36).slice(2, 10);
  return `outputs/_trash/deleted/${timestamp}-${suffix}/${basename(path)}`;
}

function normalizeGlobPattern(pattern: string): string {
  const normalized = toPortablePath(pattern.trim()).replace(/^\/+/, '');
  if (!normalized || normalized.includes('\0') || normalized.split('/').some((segment) => segment === '..')) {
    throw new Error('Invalid workspace glob pattern.');
  }
  const root = normalized.split('/')[0];
  if (!root || !managedSearchRoots.includes(root as (typeof managedSearchRoots)[number])) {
    throw new Error('Workspace glob pattern must start with a managed project directory.');
  }
  return normalized;
}

function searchRootsForPattern(rootPath: string, pattern: string): string[] {
  const firstSegment = pattern.split('/')[0]!;
  return [resolveInsideWorkspace(rootPath, firstSegment)];
}

function searchRootsForPath(rootPath: string, path: string): string[] {
  const normalized = toPortablePath(path.trim()).replace(/^\/+/, '');
  if (!normalized || normalized === '.') {
    return managedSearchRoots.map((root) => resolveInsideWorkspace(rootPath, root));
  }
  return [resolveInsideWorkspace(rootPath, normalized)];
}

function globPatternToRegExp(pattern: string): RegExp {
  const segments = pattern.split('/');
  let source = '^';
  segments.forEach((segment, index) => {
    if (segment === '**') {
      source += index === 0 ? '(?:[^/]+/)*' : '(?:/[^/]+)*';
      return;
    }
    if (index > 0) source += '/';
    source += globSegmentToRegExp(segment);
  });
  source += '$';
  return new RegExp(source);
}

function globSegmentToRegExp(segment: string): string {
  let source = '';
  for (const char of segment) {
    if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += escapeRegExp(char);
  }
  return source;
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

async function walkWorkspace(
  rootPath: string,
  absoluteStart: string,
  options: { includeHidden: boolean; shouldStop?: () => boolean },
  onEntry: (entry: { path: string; absolutePath: string; type: 'file' | 'directory' }) => Promise<void> | void,
): Promise<void> {
  if (options.shouldStop?.()) return;
  const startInfo = await stat(absoluteStart);
  if (startInfo.isFile()) {
    await onEntry({ path: toPortablePath(relative(resolve(rootPath), absoluteStart)), absolutePath: absoluteStart, type: 'file' });
    return;
  }
  if (!startInfo.isDirectory()) return;
  const entries = await readdir(absoluteStart, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (options.shouldStop?.()) return;
    if (!options.includeHidden && entry.name.startsWith('.')) continue;
    if (entry.isDirectory() && shouldSkipDirectory(entry.name)) continue;
    const absolutePath = join(absoluteStart, entry.name);
    const path = toPortablePath(relative(resolve(rootPath), absolutePath));
    if (entry.isDirectory()) {
      await onEntry({ path, absolutePath, type: 'directory' });
      await walkWorkspace(rootPath, absolutePath, options, onEntry);
    } else if (entry.isFile()) {
      await onEntry({ path, absolutePath, type: 'file' });
    }
  }
}

function shouldSkipDirectory(name: string): boolean {
  return ignoredDirectoryNames.has(name) || name === '_trash';
}

async function grepFile(
  absolutePath: string,
  relativePath: string,
  query: string,
  options: { caseSensitive: boolean; limit: number; maxFileBytes: number },
): Promise<Array<{ path: string; line: number; column: number; preview: string }>> {
  const info = await stat(absolutePath);
  if (!info.isFile() || info.size > options.maxFileBytes) return [];
  const content = await readFile(absolutePath, 'utf8');
  if (content.includes('\0')) return [];
  const needle = options.caseSensitive ? query : query.toLocaleLowerCase();
  const lines = content.split(/\r?\n/);
  const matches: Array<{ path: string; line: number; column: number; preview: string }> = [];
  for (const [index, line] of lines.entries()) {
    const haystack = options.caseSensitive ? line : line.toLocaleLowerCase();
    const column = haystack.indexOf(needle);
    if (column === -1) continue;
    matches.push({
      path: relativePath,
      line: index + 1,
      column: column + 1,
      preview: line.trim().slice(0, 240),
    });
    if (matches.length >= options.limit) break;
  }
  return matches;
}
