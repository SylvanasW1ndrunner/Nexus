import { spawn } from 'node:child_process';
import { resolveInsideWorkspace } from '@dbagent/core-workspace';
import type { ToolRegistry } from '@dbagent/core-agent';
import type { WorkspaceCore, WorkspaceScriptTool } from '@dbagent/core-workspace';

export type WorkspaceScriptRunRequest = {
  rootPath: string;
  relativePath: string;
  args: Record<string, unknown>;
  pythonPath?: string;
  env?: Record<string, string | undefined>;
  outputLimitBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
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
    registry.register(
      {
        name: scriptTool.name,
        description: scriptTool.description,
        inputSchema: scriptToolSchema(scriptTool),
        dangerLevel: 'medium',
        readonly: false,
      },
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
  const scriptPath = resolveInsideWorkspace(request.rootPath, request.relativePath);
  const startedAt = Date.now();
  const outputLimitBytes = request.outputLimitBytes ?? 100 * 1024;
  const output = createOutputCapture(outputLimitBytes);
  let timedOut = false;
  let aborted = false;

  return new Promise<WorkspaceScriptRunResult>((resolve, reject) => {
    const child = spawn(pythonPath, [scriptPath, JSON.stringify(request.args)], {
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
        command: `${pythonPath} ${request.relativePath}`,
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

      if (exitCode === 0 && !timedOut && !aborted) {
        resolve(result);
        return;
      }
      reject(new WorkspaceScriptExecutionError(scriptRunFailureMessage(result), result));
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
