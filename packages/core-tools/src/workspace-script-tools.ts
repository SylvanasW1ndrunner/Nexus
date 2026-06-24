import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { resolveInsideWorkspace } from '@dbagent/core-workspace';
import type { ToolRegistry } from '@dbagent/core-agent';
import type { WorkspaceCore, WorkspaceScriptTool } from '@dbagent/core-workspace';

export type WorkspaceScriptRunRequest = {
  rootPath: string;
  relativePath: string;
  args: Record<string, unknown>;
  pythonPath?: string;
  pythonArgs?: string[];
  env?: Record<string, string | undefined>;
  outputLimitBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  archive?: boolean;
  archiveRetention?: number;
  runId?: string;
  now?: () => string;
};

export type WorkspaceScriptRunResult = {
  command?: string;
  cwd?: string;
  exitCode: number | null;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
  timedOut?: boolean;
  timeoutMs?: number;
  aborted?: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  runId?: string;
  archiveRelativePath?: string;
  stdoutRelativePath?: string;
  stderrRelativePath?: string;
  resultRelativePath?: string;
  historyRelativePath?: string;
  prunedArchiveRelativePaths?: string[];
};

export type WorkspaceScriptRunner = (request: WorkspaceScriptRunRequest) => Promise<WorkspaceScriptRunResult>;

export type WorkspaceScriptToolDependencies = {
  registry: ToolRegistry;
  workspace: WorkspaceCore;
  getWorkspaceRoot: () => string | undefined;
  runner: WorkspaceScriptRunner;
  timeoutMs?: number;
};

export async function registerWorkspaceScriptTools(
  dependencies: WorkspaceScriptToolDependencies,
): Promise<WorkspaceScriptTool[]> {
  const { registry, workspace, getWorkspaceRoot, runner, timeoutMs } = dependencies;
  const rootPath = requireWorkspaceRoot(getWorkspaceRoot);
  const scriptTools = await workspace.discoverScriptTools(rootPath);

  for (const scriptTool of scriptTools) {
    const definition = {
      name: scriptTool.name,
      description: scriptTool.description,
      inputSchema: scriptToolSchema(scriptTool),
      dangerLevel: 'medium' as const,
      readonly: false,
      source: 'workspace-script' as const,
      sourceId: scriptTool.relativePath,
      originalName: scriptTool.name,
    };

    registry.register(
      definition,
      async (args, context) =>
        runner({
          rootPath,
          relativePath: scriptTool.relativePath,
          args: normalizeScriptArgs(scriptTool, args),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        }),
    );
  }

  return scriptTools;
}

export class WorkspaceScriptExecutionError extends Error {
  constructor(
    message: string,
    readonly result: WorkspaceScriptRunResult,
  ) {
    super(message);
    this.name = 'WorkspaceScriptExecutionError';
  }
}

export async function runWorkspacePythonScript(request: WorkspaceScriptRunRequest): Promise<WorkspaceScriptRunResult> {
  if (!request.relativePath.endsWith('.py')) {
    throw new Error('Workspace script runner only supports Python files.');
  }
  if (request.signal?.aborted) {
    throw new Error('Python script execution was aborted before launch.');
  }

  const pythonPath = request.pythonPath ?? 'python';
  const pythonArgs = request.pythonArgs ?? [];
  const scriptPath = resolveInsideWorkspace(request.rootPath, request.relativePath);
  const startedAt = Date.now();
  const outputLimitBytes = request.outputLimitBytes ?? 100 * 1024;
  const output = createOutputCapture(outputLimitBytes);
  let timedOut = false;
  let aborted = false;

  return new Promise<WorkspaceScriptRunResult>((resolve, reject) => {
    const child = spawn(pythonPath, [...pythonArgs, scriptPath, JSON.stringify(request.args)], {
      cwd: request.rootPath,
      env: buildProcessEnv(request.env),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let timeout: ReturnType<typeof setTimeout> | undefined;
    let forceKillTimeout: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (forceKillTimeout) clearTimeout(forceKillTimeout);
      request.signal?.removeEventListener('abort', abortFromSignal);
    };
    const killChild = () => {
      if (!child.killed) child.kill();
      forceKillTimeout = setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 2_000);
    };
    const abortFromSignal = () => {
      aborted = true;
      killChild();
    };

    child.stdout?.on('data', (chunk: Buffer) => output.appendStdout(chunk));
    child.stderr?.on('data', (chunk: Buffer) => output.appendStderr(chunk));

    child.once('error', (error) => {
      cleanup();
      reject(error);
    });

    child.once('close', (exitCode, exitSignal) => {
      cleanup();
      const result: WorkspaceScriptRunResult = {
        command: [pythonPath, ...pythonArgs, request.relativePath].join(' '),
        cwd: request.rootPath,
        exitCode,
        signal: exitSignal,
        stdout: output.stdout(),
        stderr: output.stderr(),
        elapsedMs: Date.now() - startedAt,
        ...(timedOut ? { timedOut: true } : {}),
        ...(timedOut && request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
        ...(aborted ? { aborted: true } : {}),
        ...(output.stdoutTruncated() ? { stdoutTruncated: true } : {}),
        ...(output.stderrTruncated() ? { stderrTruncated: true } : {}),
      };

      void archiveAndSettle(request, result, resolve, reject);
    });

    request.signal?.addEventListener('abort', abortFromSignal, { once: true });
    if (request.timeoutMs !== undefined && request.timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        killChild();
      }, request.timeoutMs);
    }
  });
}

function requireWorkspaceRoot(getWorkspaceRoot: () => string | undefined): string {
  const rootPath = getWorkspaceRoot();
  if (!rootPath) throw new Error('No active workspace.');
  return rootPath;
}

function scriptToolSchema(scriptTool: WorkspaceScriptTool): Record<string, unknown> {
  const properties = Object.fromEntries(
    scriptTool.params.map((param) => [
      param.name,
      {
        type: jsonSchemaType(param.type),
        ...(param.description === undefined ? {} : { description: param.description }),
      },
    ]),
  );
  return {
    type: 'object',
    properties,
    required: scriptTool.params.map((param) => param.name),
  };
}

function normalizeScriptArgs(
  scriptTool: WorkspaceScriptTool,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const param of scriptTool.params) {
    const value = args[param.name];
    if (value === undefined) {
      throw new Error(`Tool argument "${param.name}" is required.`);
    }
    assertParamType(param, value);
    normalized[param.name] = value;
  }
  return normalized;
}

function assertParamType(param: WorkspaceScriptTool['params'][number], value: unknown): void {
  const type = param.type?.toLowerCase();
  if (!type || type === 'any') return;
  if ((type === 'str' || type === 'string') && typeof value !== 'string') {
    throw new Error(`Tool argument "${param.name}" must be a string.`);
  }
  if ((type === 'int' || type === 'integer') && (!Number.isInteger(value) || typeof value !== 'number')) {
    throw new Error(`Tool argument "${param.name}" must be an integer.`);
  }
  if ((type === 'float' || type === 'number') && typeof value !== 'number') {
    throw new Error(`Tool argument "${param.name}" must be a number.`);
  }
  if ((type === 'bool' || type === 'boolean') && typeof value !== 'boolean') {
    throw new Error(`Tool argument "${param.name}" must be a boolean.`);
  }
}

function jsonSchemaType(type?: string): string {
  const normalized = type?.toLowerCase();
  if (normalized === 'int' || normalized === 'integer') return 'integer';
  if (normalized === 'float' || normalized === 'number') return 'number';
  if (normalized === 'bool' || normalized === 'boolean') return 'boolean';
  if (normalized === 'object' || normalized === 'array') return normalized;
  return 'string';
}

function buildProcessEnv(extraEnv?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(extraEnv ?? {})) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

async function archiveAndSettle(
  request: WorkspaceScriptRunRequest,
  result: WorkspaceScriptRunResult,
  resolve: (value: WorkspaceScriptRunResult) => void,
  reject: (reason?: unknown) => void,
): Promise<void> {
  try {
    const archived = await maybeArchiveWorkspaceScriptRun(request, result);
    if (archived.exitCode === 0 && !archived.timedOut && !archived.aborted) {
      resolve(archived);
      return;
    }
    reject(new WorkspaceScriptExecutionError(scriptRunFailureMessage(archived), archived));
  } catch (error) {
    reject(error);
  }
}

async function maybeArchiveWorkspaceScriptRun(
  request: WorkspaceScriptRunRequest,
  result: WorkspaceScriptRunResult,
): Promise<WorkspaceScriptRunResult> {
  if (request.archive === false) return result;

  const runId = request.runId ?? createRunId(request.relativePath, request.now?.() ?? new Date().toISOString());
  const archiveRelativePath = `scripts/_runs/${runId}`;
  const stdoutRelativePath = `${archiveRelativePath}/stdout.log`;
  const stderrRelativePath = `${archiveRelativePath}/stderr.log`;
  const resultRelativePath = `${archiveRelativePath}/result.json`;
  const historyRelativePath = '.dbagent/history.jsonl';
  const archived: WorkspaceScriptRunResult = {
    ...result,
    runId,
    archiveRelativePath,
    stdoutRelativePath,
    stderrRelativePath,
    resultRelativePath,
    historyRelativePath,
  };

  await atomicWriteText(join(request.rootPath, stdoutRelativePath), result.stdout);
  await atomicWriteText(join(request.rootPath, stderrRelativePath), result.stderr);
  await atomicWriteText(join(request.rootPath, resultRelativePath), `${JSON.stringify(resultManifest(request, archived), null, 2)}\n`);
  await appendHistoryLine(request.rootPath, {
    ts: request.now?.() ?? new Date().toISOString(),
    action: 'run_script',
    path: request.relativePath,
    runId,
    archivePath: archiveRelativePath,
    duration_ms: result.elapsedMs,
    exit_code: result.exitCode,
    timed_out: result.timedOut === true,
    aborted: result.aborted === true,
    stdout_truncated: result.stdoutTruncated === true,
    stderr_truncated: result.stderrTruncated === true,
  });
  const prunedArchiveRelativePaths = await pruneArchivedRuns(
    request.rootPath,
    Math.floor(request.archiveRetention ?? 50),
  );

  if (prunedArchiveRelativePaths.length > 0) {
    return {
      ...archived,
      prunedArchiveRelativePaths,
    };
  }

  return archived;
}

function resultManifest(request: WorkspaceScriptRunRequest, result: WorkspaceScriptRunResult): Record<string, unknown> {
  return {
    version: 1,
    runId: result.runId,
    script: request.relativePath,
    command: result.command,
    cwd: result.cwd,
    exitCode: result.exitCode,
    signal: result.signal,
    elapsedMs: result.elapsedMs,
    timedOut: result.timedOut === true,
    timeoutMs: result.timeoutMs,
    aborted: result.aborted === true,
    stdoutTruncated: result.stdoutTruncated === true,
    stderrTruncated: result.stderrTruncated === true,
    stdoutPath: result.stdoutRelativePath,
    stderrPath: result.stderrRelativePath,
  };
}

async function appendHistoryLine(rootPath: string, event: Record<string, unknown>): Promise<void> {
  const historyPath = join(rootPath, '.dbagent', 'history.jsonl');
  let existing = '';
  try {
    existing = await readFile(historyPath, 'utf8');
  } catch {
    // missing history file is normal for new workspaces
  }
  await atomicWriteText(historyPath, `${existing}${JSON.stringify(event)}\n`);
}

async function pruneArchivedRuns(rootPath: string, retention: number): Promise<string[]> {
  if (!Number.isFinite(retention) || retention <= 0) return [];
  const runsPath = join(rootPath, 'scripts', '_runs');
  let entries: Array<{ name: string; mtimeMs: number }> = [];
  try {
    const children = await readdir(runsPath, { withFileTypes: true });
    entries = (
      await Promise.all(
        children
          .filter((entry) => entry.isDirectory())
          .map(async (entry) => ({
            name: entry.name,
            mtimeMs: await archivedRunModifiedAt(join(runsPath, entry.name)),
          })),
      )
    ).sort((left, right) => right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name));
  } catch {
    return [];
  }

  const stale = entries.slice(retention);
  const pruned: string[] = [];
  for (const entry of stale) {
    const relativePath = `scripts/_runs/${entry.name}`;
    await rm(join(rootPath, relativePath), { recursive: true, force: true });
    pruned.push(relativePath);
  }
  return pruned;
}

async function archivedRunModifiedAt(path: string): Promise<number> {
  try {
    return (await stat(join(path, 'result.json'))).mtimeMs;
  } catch {
    return (await stat(path)).mtimeMs;
  }
}

async function atomicWriteText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, content, 'utf8');
  await rename(tempPath, path);
}

function createRunId(relativePath: string, timestamp: string): string {
  const safeTime = timestamp.replace(/[:.]/g, '-');
  const scriptName = basename(relativePath, '.py')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${safeTime}-${scriptName || 'script'}`;
}

function createOutputCapture(limitBytes: number) {
  let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let stdoutWasTruncated = false;
  let stderrWasTruncated = false;
  const limit = Math.max(1, limitBytes);

  return {
    appendStdout(chunk: Buffer) {
      const captured = appendTail(stdout, chunk, limit);
      stdout = captured.buffer;
      stdoutWasTruncated ||= captured.truncated;
    },
    appendStderr(chunk: Buffer) {
      const captured = appendTail(stderr, chunk, limit);
      stderr = captured.buffer;
      stderrWasTruncated ||= captured.truncated;
    },
    stdout() {
      return decodeOutput(stdout, stdoutWasTruncated, limit);
    },
    stderr() {
      return decodeOutput(stderr, stderrWasTruncated, limit);
    },
    stdoutTruncated() {
      return stdoutWasTruncated;
    },
    stderrTruncated() {
      return stderrWasTruncated;
    },
  };
}

function appendTail(
  current: Buffer<ArrayBufferLike>,
  chunk: Buffer,
  limitBytes: number,
): { buffer: Buffer<ArrayBufferLike>; truncated: boolean } {
  const combined = Buffer.concat([current, chunk]);
  if (combined.byteLength <= limitBytes) return { buffer: combined, truncated: false };
  return { buffer: combined.subarray(combined.byteLength - limitBytes), truncated: true };
}

function decodeOutput(buffer: Buffer, truncated: boolean, limitBytes: number): string {
  const text = buffer.toString('utf8');
  if (!truncated) return text;
  return `[output truncated to last ${limitBytes} bytes]\n${text}`;
}

function scriptRunFailureMessage(result: WorkspaceScriptRunResult): string {
  const stderrTail = result.stderr.trim();
  if (result.timedOut) {
    return withStderrTail(`Python 脚本执行超时（${result.timeoutMs ?? result.elapsedMs}ms）。`, stderrTail);
  }
  if (result.aborted) {
    return withStderrTail('Python 脚本执行已取消。', stderrTail);
  }
  return withStderrTail(`Python 脚本执行失败，退出码 ${result.exitCode ?? 'unknown'}。`, stderrTail);
}

function withStderrTail(message: string, stderrTail: string): string {
  if (!stderrTail) return message;
  return `${message} stderr: ${stderrTail.slice(-2_000)}`;
}
