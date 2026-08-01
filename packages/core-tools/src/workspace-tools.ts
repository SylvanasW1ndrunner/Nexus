import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  createAgentToolResultEnvelope,
  type AgentArtifactReference,
  type ToolRegistry,
} from '@dbagent/core-agent';
import { ProcessRuntime } from './process-runtime.js';
import { optionalPositiveInteger, optionalString, requireString } from './validation.js';

const DEFAULT_MAX_READ_BYTES = 256 * 1024;
const DEFAULT_MAX_OUTPUT_CHARS = 64 * 1024;
const DEFAULT_MAX_SEARCH_MATCHES = 200;
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist']);

export type WorkspaceToolOptions = {
  rootPath: string;
  maxReadBytes?: number;
  maxOutputChars?: number;
  shellTimeoutMs?: number;
  processRuntime?: ProcessRuntime;
  /**
   * Shell execution is intentionally opt-in because it runs with the host
   * process's operating-system permissions. File tools remain available when
   * this is false.
   */
  enableShell?: boolean;
};

export function registerWorkspaceTools(
  registry: ToolRegistry,
  options: WorkspaceToolOptions,
): void {
  const workspace = new WorkspaceBoundary(options.rootPath);
  const maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;

  registry.register(
    {
      name: 'workspace_list',
      description:
        'List project files and directories using project-relative paths. Does not follow symbolic links.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          depth: { type: 'integer', minimum: 1, maximum: 8 },
          maxEntries: { type: 'integer', minimum: 1, maximum: 2000 },
        },
        additionalProperties: false,
      },
      dangerLevel: 'safe',
      readonly: true,
      source: 'builtin',
    },
    async (args) => {
      const path = await workspace.existing(optionalString(args, 'path') ?? '.');
      const depth = Math.min(optionalPositiveInteger(args, 'depth', 2) ?? 2, 8);
      const maxEntries = Math.min(optionalPositiveInteger(args, 'maxEntries', 500) ?? 500, 2_000);
      const entries: Array<{
        path: string;
        type: 'file' | 'directory' | 'symlink';
        sizeBytes?: number;
      }> = [];
      await walkDirectory(path, path, depth, maxEntries, entries);
      return { path: workspace.display(path), entries, truncated: entries.length >= maxEntries };
    },
  );

  registry.register(
    {
      name: 'workspace_read',
      description:
        'Read a bounded UTF-8 text range from a project file. Use line ranges instead of loading large files.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          startLine: { type: 'integer', minimum: 1 },
          endLine: { type: 'integer', minimum: 1 },
        },
        required: ['path'],
        additionalProperties: false,
      },
      dangerLevel: 'safe',
      readonly: true,
      source: 'builtin',
    },
    async (args) => {
      const path = await workspace.existing(requireString(args, 'path'));
      const info = await stat(path);
      if (!info.isFile()) throw new Error('workspace_read requires a file.');
      if (info.size > maxReadBytes) {
        throw new Error(
          `File is ${info.size} bytes; read a smaller artifact or use workspace_search.`,
        );
      }
      const content = await readFile(path, 'utf8');
      const lines = content.split(/\r?\n/);
      const start = optionalPositiveInteger(args, 'startLine', 1) ?? 1;
      const end = Math.min(
        optionalPositiveInteger(args, 'endLine', start + 399) ?? start + 399,
        lines.length,
      );
      if (end < start) throw new Error('endLine must be greater than or equal to startLine.');
      return {
        path: workspace.display(path),
        startLine: start,
        endLine: end,
        totalLines: lines.length,
        content: lines.slice(start - 1, end).join('\n'),
      };
    },
  );

  registry.register(
    {
      name: 'workspace_search',
      description: 'Search project text files for a literal query and return bounded line matches.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          path: { type: 'string' },
          caseSensitive: { type: 'boolean' },
          maxMatches: { type: 'integer', minimum: 1, maximum: 1000 },
        },
        required: ['query'],
        additionalProperties: false,
      },
      dangerLevel: 'safe',
      readonly: true,
      source: 'builtin',
    },
    async (args) => {
      const root = await workspace.existing(optionalString(args, 'path') ?? '.');
      const query = requireString(args, 'query');
      const caseSensitive = args.caseSensitive === true;
      const maxMatches = Math.min(
        optionalPositiveInteger(args, 'maxMatches', DEFAULT_MAX_SEARCH_MATCHES) ??
          DEFAULT_MAX_SEARCH_MATCHES,
        1_000,
      );
      const matches = await searchWorkspace({
        workspace,
        root,
        query,
        caseSensitive,
        maxMatches,
        maxReadBytes,
      });
      return { query, matches, truncated: matches.length >= maxMatches };
    },
  );

  registry.register(
    {
      name: 'workspace_write',
      description:
        'Create or replace a UTF-8 project file. Prefer sql/ or artifacts/ for durable Agent outputs.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          overwrite: { type: 'boolean' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      dangerLevel: 'medium',
      readonly: false,
      requiredPermission: 'edit',
      source: 'builtin',
      completion: { role: 'deliverable', group: 'workspace-artifact' },
    },
    async (args, context) => {
      const path = await workspace.target(requireString(args, 'path'));
      const content = typeof args.content === 'string' ? args.content : undefined;
      if (content === undefined) throw new Error('Tool argument "content" must be a string.');
      if (args.overwrite !== true && (await pathExists(path))) {
        throw new Error('File already exists. Set overwrite=true to replace it.');
      }
      await atomicWrite(path, content);
      const artifact = registerArtifact(
        context.session.artifacts ?? [],
        workspace.display(path),
        Buffer.byteLength(content),
      );
      context.session.artifacts = artifact.artifacts;
      return artifactEnvelope(artifact.artifact, {
        path: workspace.display(path),
        bytes: Buffer.byteLength(content),
      });
    },
  );

  registry.register(
    {
      name: 'workspace_edit',
      description: 'Replace an exact text fragment in an existing UTF-8 project file.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          oldText: { type: 'string' },
          newText: { type: 'string' },
          replaceAll: { type: 'boolean' },
        },
        required: ['path', 'oldText', 'newText'],
        additionalProperties: false,
      },
      dangerLevel: 'medium',
      readonly: false,
      requiredPermission: 'edit',
      source: 'builtin',
      completion: { role: 'deliverable', group: 'workspace-artifact' },
    },
    async (args, context) => {
      const path = await workspace.existing(requireString(args, 'path'));
      const oldText = requireString(args, 'oldText');
      if (typeof args.newText !== 'string') {
        throw new Error('Tool argument "newText" must be a string.');
      }
      const original = await readFile(path, 'utf8');
      const occurrences = original.split(oldText).length - 1;
      if (occurrences === 0) throw new Error('oldText was not found.');
      if (occurrences > 1 && args.replaceAll !== true) {
        throw new Error(
          `oldText occurs ${occurrences} times. Provide a unique fragment or set replaceAll=true.`,
        );
      }
      const content =
        args.replaceAll === true
          ? original.split(oldText).join(args.newText)
          : original.replace(oldText, args.newText);
      await atomicWrite(path, content);
      const artifact = registerArtifact(
        context.session.artifacts ?? [],
        workspace.display(path),
        Buffer.byteLength(content),
      );
      context.session.artifacts = artifact.artifacts;
      return artifactEnvelope(artifact.artifact, {
        path: workspace.display(path),
        replacements: args.replaceAll === true ? occurrences : 1,
        bytes: Buffer.byteLength(content),
      });
    },
  );

  registry.register(
    {
      name: 'workspace_patch',
      title: 'Patch project file',
      aliases: ['apply patch', 'multi edit', '批量修改文件'],
      tags: ['workspace', 'file', 'patch', 'edit'],
      description:
        'Atomically apply multiple ordered exact-text edits to one existing UTF-8 project file. The file is not changed if any edit cannot be validated.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          edits: {
            type: 'array',
            minItems: 1,
            maxItems: 50,
            items: {
              type: 'object',
              properties: {
                oldText: { type: 'string', minLength: 1 },
                newText: { type: 'string' },
                replaceAll: { type: 'boolean' },
              },
              required: ['oldText', 'newText'],
              additionalProperties: false,
            },
          },
        },
        required: ['path', 'edits'],
        additionalProperties: false,
      },
      dangerLevel: 'medium',
      readonly: false,
      requiredPermission: 'edit',
      source: 'builtin',
      exposure: 'deferred',
      execution: { concurrency: 'write' },
      completion: { role: 'deliverable', group: 'workspace-artifact' },
    },
    async (args, context) => {
      const path = await workspace.existing(requireString(args, 'path'));
      const info = await stat(path);
      if (!info.isFile()) throw new Error('workspace_patch requires a file.');
      if (info.size > maxReadBytes) {
        throw new Error(`File is ${info.size} bytes; patch a smaller text artifact.`);
      }
      const edits = requirePatchEdits(args.edits);
      let content = await readFile(path, 'utf8');
      let replacements = 0;
      for (let index = 0; index < edits.length; index += 1) {
        const edit = edits[index]!;
        const occurrences = content.split(edit.oldText).length - 1;
        if (occurrences === 0) {
          throw new Error(`workspace_patch edit ${index + 1}: oldText was not found.`);
        }
        if (occurrences > 1 && edit.replaceAll !== true) {
          throw new Error(
            `workspace_patch edit ${index + 1}: oldText occurs ${occurrences} times; provide a unique fragment or set replaceAll=true.`,
          );
        }
        content =
          edit.replaceAll === true
            ? content.split(edit.oldText).join(edit.newText)
            : content.replace(edit.oldText, edit.newText);
        replacements += edit.replaceAll === true ? occurrences : 1;
      }
      await atomicWrite(path, content);
      const artifact = registerArtifact(
        context.session.artifacts ?? [],
        workspace.display(path),
        Buffer.byteLength(content),
      );
      context.session.artifacts = artifact.artifacts;
      return artifactEnvelope(artifact.artifact, {
        path: workspace.display(path),
        edits: edits.length,
        replacements,
        bytes: Buffer.byteLength(content),
      });
    },
  );

  if (options.enableShell === true) {
    registry.register(
      {
        name: 'shell_run',
        description:
          'Run a bounded shell command inside the project. Use only when dedicated tools are insufficient.',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            cwd: { type: 'string' },
            timeoutMs: { type: 'integer', minimum: 1, maximum: 300000 },
          },
          required: ['command'],
          additionalProperties: false,
        },
        dangerLevel: 'critical',
        readonly: false,
        requiredPermission: 'full',
        source: 'builtin',
      },
      async (args, context) => {
        const cwd = await workspace.existing(optionalString(args, 'cwd') ?? '.');
        if (!(await stat(cwd)).isDirectory()) throw new Error('shell cwd must be a directory.');
        return runShell({
          sessionId: context.session.id,
          command: requireString(args, 'command'),
          cwd,
          timeoutMs: Math.min(
            optionalPositiveInteger(args, 'timeoutMs', options.shellTimeoutMs ?? 60_000) ?? 60_000,
            300_000,
          ),
          maxOutputChars,
          ...(options.processRuntime === undefined
            ? {}
            : { runtime: options.processRuntime }),
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        });
      },
    );
  }
}

export class WorkspaceBoundary {
  private readonly root: string;

  constructor(rootPath: string) {
    this.root = realpathSync(resolve(rootPath));
  }

  async existing(input: string): Promise<string> {
    const target = this.resolve(input);
    const canonical = await realpath(target);
    this.assertInside(canonical);
    return canonical;
  }

  async target(input: string): Promise<string> {
    const target = this.resolve(input);
    const parent = await nearestExistingDirectory(dirname(target));
    this.assertInside(parent);
    return target;
  }

  display(path: string): string {
    const value = relative(this.root, path).replaceAll('\\', '/');
    return value || '.';
  }

  private resolve(input: string): string {
    if (isAbsolute(input)) {
      throw new Error('Workspace paths must be project-relative.');
    }
    const target = resolve(this.root, input);
    this.assertInside(target);
    return target;
  }

  private assertInside(target: string): void {
    const rel = relative(this.root, target);
    if (rel === '..' || rel.startsWith(`..\\`) || rel.startsWith('../') || isAbsolute(rel)) {
      throw new Error('Path escapes the project workspace.');
    }
  }
}

async function nearestExistingDirectory(start: string): Promise<string> {
  let current = start;
  while (true) {
    try {
      const canonical = await realpath(current);
      if (!(await stat(canonical)).isDirectory()) {
        throw new Error(`Workspace parent is not a directory: ${canonical}.`);
      }
      return canonical;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

async function walkDirectory(
  root: string,
  current: string,
  depth: number,
  maxEntries: number,
  output: Array<{
    path: string;
    type: 'file' | 'directory' | 'symlink';
    sizeBytes?: number;
  }>,
): Promise<void> {
  if (depth < 1 || output.length >= maxEntries) return;
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (output.length >= maxEntries) return;
    if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const path = resolve(current, entry.name);
    const relativePath = relative(root, path).replaceAll('\\', '/');
    if (entry.isSymbolicLink()) {
      output.push({ path: relativePath, type: 'symlink' });
      continue;
    }
    if (entry.isDirectory()) {
      output.push({ path: relativePath, type: 'directory' });
      await walkDirectory(root, path, depth - 1, maxEntries, output);
      continue;
    }
    const info = await stat(path);
    output.push({ path: relativePath, type: 'file', sizeBytes: info.size });
  }
}

async function searchWorkspace(input: {
  workspace: WorkspaceBoundary;
  root: string;
  query: string;
  caseSensitive: boolean;
  maxMatches: number;
  maxReadBytes: number;
}): Promise<Array<{ path: string; line: number; text: string }>> {
  const files: string[] = [];
  await collectFiles(input.root, files, 20_000);
  const needle = input.caseSensitive ? input.query : input.query.toLocaleLowerCase();
  const matches: Array<{ path: string; line: number; text: string }> = [];
  for (const path of files) {
    if (matches.length >= input.maxMatches) break;
    const info = await stat(path);
    if (info.size > input.maxReadBytes) continue;
    let content: string;
    try {
      content = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    if (content.includes('\u0000')) continue;
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      const haystack = input.caseSensitive ? line : line.toLocaleLowerCase();
      if (!haystack.includes(needle)) continue;
      matches.push({
        path: input.workspace.display(path),
        line: index + 1,
        text: line.slice(0, 500),
      });
      if (matches.length >= input.maxMatches) break;
    }
  }
  return matches;
}

async function collectFiles(directory: string, output: string[], maxFiles: number): Promise<void> {
  if (output.length >= maxFiles) return;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (output.length >= maxFiles) return;
    if (entry.isSymbolicLink()) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        await collectFiles(path, output, maxFiles);
      }
    } else if (entry.isFile()) {
      output.push(path);
    }
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.schemanaut-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, 'utf8');
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function registerArtifact(
  existing: AgentArtifactReference[],
  path: string,
  sizeBytes: number,
): { artifacts: AgentArtifactReference[]; artifact: AgentArtifactReference } {
  const previous = existing.find((artifact) => artifact.path === path);
  const artifact: AgentArtifactReference = {
    id: previous?.id ?? randomUUID(),
    path,
    mediaType: path.toLocaleLowerCase().endsWith('.sql') ? 'application/sql' : 'text/plain',
    sizeBytes,
    createdAt: new Date().toISOString(),
    source: 'tool',
  };
  return {
    artifacts: [...existing.filter((item) => item.path !== path), artifact],
    artifact,
  };
}

function artifactEnvelope(
  artifact: AgentArtifactReference,
  projection: Record<string, unknown>,
) {
  return createAgentToolResultEnvelope({
    modelProjection: projection,
    userProjection: projection,
    durableSummary: projection,
    auditEvidence: { status: 'success', resultType: 'artifact' },
    completionEvidence: {
      kind: 'artifact',
      deliveryReady: true,
      outcome: 'succeeded',
      source: 'runtime',
      executionId: artifact.id,
    },
  });
}

function requirePatchEdits(value: unknown): Array<{
  oldText: string;
  newText: string;
  replaceAll: boolean;
}> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
    throw new Error('Tool argument "edits" must contain between 1 and 50 edits.');
  }
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`workspace_patch edit ${index + 1} must be an object.`);
    }
    const edit = item as Record<string, unknown>;
    if (typeof edit.oldText !== 'string' || edit.oldText.length === 0) {
      throw new Error(`workspace_patch edit ${index + 1} requires non-empty oldText.`);
    }
    if (typeof edit.newText !== 'string') {
      throw new Error(`workspace_patch edit ${index + 1} requires string newText.`);
    }
    if (edit.replaceAll !== undefined && typeof edit.replaceAll !== 'boolean') {
      throw new Error(`workspace_patch edit ${index + 1} replaceAll must be boolean.`);
    }
    return {
      oldText: edit.oldText,
      newText: edit.newText,
      replaceAll: edit.replaceAll === true,
    };
  });
}

async function runShell(input: {
  sessionId: string;
  command: string;
  cwd: string;
  timeoutMs: number;
  maxOutputChars: number;
  runtime?: ProcessRuntime;
  signal?: AbortSignal;
}): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}> {
  const ownsRuntime = input.runtime === undefined;
  const runtime =
    input.runtime ??
    new ProcessRuntime({
      spoolDirectory: join(tmpdir(), `schemanaut-shell-${randomUUID()}`),
      maxProjectionBytes: input.maxOutputChars,
    });
  try {
    const result = await runtime.exec({
      sessionId: input.sessionId,
      command: input.command,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return {
      exitCode: result.exitCode,
      stdout: result.output.stdout.text,
      stderr: result.output.stderr.text,
      timedOut: result.timedOut,
      truncated: result.output.stdout.truncated || result.output.stderr.truncated,
      ...(result.error === undefined ? {} : { error: result.error }),
    };
  } finally {
    if (ownsRuntime) await runtime.close();
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
