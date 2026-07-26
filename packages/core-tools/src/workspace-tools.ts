import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
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
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { AgentArtifactReference, ToolRegistry } from '@dbagent/core-agent';
import { optionalPositiveInteger, optionalString, requireString } from './validation.js';

const DEFAULT_MAX_READ_BYTES = 256 * 1024;
const DEFAULT_MAX_OUTPUT_CHARS = 64 * 1024;
const DEFAULT_MAX_SEARCH_MATCHES = 200;
const PROCESS_TREE_KILL_GRACE_MS = 250;
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist']);

export type WorkspaceToolOptions = {
  rootPath: string;
  maxReadBytes?: number;
  maxOutputChars?: number;
  shellTimeoutMs?: number;
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
      return { path: workspace.display(path), bytes: Buffer.byteLength(content) };
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
      return {
        path: workspace.display(path),
        replacements: args.replaceAll === true ? occurrences : 1,
        bytes: Buffer.byteLength(content),
      };
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
          command: requireString(args, 'command'),
          cwd,
          timeoutMs: Math.min(
            optionalPositiveInteger(args, 'timeoutMs', options.shellTimeoutMs ?? 60_000) ?? 60_000,
            300_000,
          ),
          maxOutputChars,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        });
      },
    );
  }
}

class WorkspaceBoundary {
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
): { artifacts: AgentArtifactReference[] } {
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
  };
}

async function runShell(input: {
  command: string;
  cwd: string;
  timeoutMs: number;
  maxOutputChars: number;
  signal?: AbortSignal;
}): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}> {
  if (input.signal?.aborted) throw shellAbortError();
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(input.command, {
      cwd: input.cwd,
      shell: true,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: shellEnvironment(),
    });
    let stdout = '';
    let stderr = '';
    let truncated = false;
    const append = (current: string, chunk: Buffer): string => {
      const combined = current + chunk.toString('utf8');
      if (combined.length <= input.maxOutputChars) return combined;
      truncated = true;
      return combined.slice(0, input.maxOutputChars);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    let timedOut = false;
    let settled = false;
    let stopping = false;
    const cleanup = () => {
      clearTimeout(timeout);
      input.signal?.removeEventListener('abort', stop);
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      terminateProcessTree(child);
    };
    input.signal?.addEventListener('abort', stop, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, input.timeoutMs);
    if (input.signal?.aborted) stop();
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once('close', (exitCode) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise({ exitCode, stdout, stderr, timedOut, truncated });
    });
  });
}

function terminateProcessTree(child: ReturnType<typeof spawn>): void {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill();
    return;
  }
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    const executable = systemRoot ? join(systemRoot, 'System32', 'taskkill.exe') : 'taskkill.exe';
    const killer = spawn(executable, ['/PID', String(pid), '/T', '/F'], {
      env: shellEnvironment(),
      stdio: 'ignore',
      windowsHide: true,
    });
    let handled = false;
    const fallback = () => {
      if (handled) return;
      handled = true;
      child.kill();
    };
    killer.once('error', fallback);
    killer.once('close', (exitCode) => {
      if (exitCode !== 0) fallback();
      else handled = true;
    });
    return;
  }

  signalProcessGroup(pid, 'SIGTERM', child);
  const forceKill = setTimeout(() => {
    signalProcessGroup(pid, 'SIGKILL');
  }, PROCESS_TREE_KILL_GRACE_MS);
  forceKill.unref();
}

function signalProcessGroup(
  pid: number,
  signal: NodeJS.Signals,
  fallbackChild?: ReturnType<typeof spawn>,
): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    fallbackChild?.kill(signal);
  }
}

function shellAbortError(): Error {
  const error = new Error('Shell command was aborted before it started.');
  error.name = 'AbortError';
  return error;
}

function shellEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    'COMSPEC',
    'HOME',
    'LANG',
    'LC_ALL',
    'LOCALAPPDATA',
    'PATH',
    'PATHEXT',
    'SYSTEMDRIVE',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'USERPROFILE',
    'WINDIR',
  ] as const;
  return Object.fromEntries(
    allowed.flatMap((key) => {
      const value = process.env[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
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
