import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolveInsideWorkspace } from '@dbagent/core-workspace';
import type { AgentToolContext, ToolRegistry } from '@dbagent/core-agent';
import { optionalPositiveInteger, optionalString, requireString } from './validation.js';
import {
  runWorkspacePythonScript,
  type WorkspaceScriptRunner,
} from './workspace-script-tools.js';

export type PythonRuntimeToolWorkspace = {
  rootPath: string;
  requirementsPath: string;
  pythonPath?: string;
  pythonArgs?: string[];
  timeoutMs?: number;
};

export type PythonRuntimeToolDependencies = {
  registry: ToolRegistry;
  getWorkspace: () => PythonRuntimeToolWorkspace | undefined | Promise<PythonRuntimeToolWorkspace | undefined>;
  scriptRunner?: WorkspaceScriptRunner;
  timeoutMs?: number;
  outputLimitBytes?: number;
};

export type PythonReplRunRequest = {
  rootPath: string;
  code: string;
  pythonPath?: string;
  pythonArgs?: string[];
  timeoutMs?: number;
  outputLimitBytes?: number;
  signal?: AbortSignal;
};

export type PythonReplRunResult = {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
  timedOut?: boolean;
  aborted?: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
};

export type PythonDependencyInstallRequest = {
  rootPath: string;
  requirementsPath?: string;
  packages?: string[];
  pythonPath?: string;
  pythonArgs?: string[];
  timeoutMs?: number;
  outputLimitBytes?: number;
  upgrade?: boolean;
  writeRequirements?: boolean;
  signal?: AbortSignal;
};

export type PythonDependencyInstallResult = PythonReplRunResult & {
  requirementsRelativePath?: string;
  writtenPackageSpecs?: string[];
};

export function registerPythonRuntimeTools(dependencies: PythonRuntimeToolDependencies): void {
  const timeoutMs = dependencies.timeoutMs ?? 300_000;
  const outputLimitBytes = dependencies.outputLimitBytes ?? 100 * 1024;

  dependencies.registry.register(
    {
      name: 'run_python_script',
      description: 'Run a Python script inside the active workspace and return stdout, stderr, exit code, and archive metadata.',
      inputSchema: objectSchema({
        path: { type: 'string' },
        relativePath: { type: 'string' },
        args: { type: 'object' },
        timeoutMs: { type: 'number' },
      }),
      dangerLevel: 'high',
      readonly: false,
      source: 'official',
      sourceId: 'official.workspace-python',
      originalName: 'run_python_script',
    },
    async (args, context) => {
      requirePythonToolApproval(context, 'run_python_script');
      const workspace = await requirePythonWorkspace(dependencies.getWorkspace);
      const relativePath = optionalString(args, 'relativePath') ?? requireString(args, 'path');
      const runArgs = optionalRecord(args, 'args') ?? {};
      const runScript = dependencies.scriptRunner ?? runWorkspacePythonScript;
      const result = await runScript({
        rootPath: workspace.rootPath,
        relativePath,
        args: runArgs,
        ...(workspace.pythonPath === undefined ? {} : { pythonPath: workspace.pythonPath }),
        ...(workspace.pythonArgs === undefined ? {} : { pythonArgs: workspace.pythonArgs }),
        timeoutMs: optionalPositiveInteger(args, 'timeoutMs', workspace.timeoutMs ?? timeoutMs) ?? timeoutMs,
        outputLimitBytes,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      return result;
    },
  );

  dependencies.registry.register(
    {
      name: 'python_repl',
      description: 'Run a short Python code snippet in the active workspace without creating a script file.',
      inputSchema: objectSchema({
        code: { type: 'string' },
        timeoutMs: { type: 'number' },
        maxOutputBytes: { type: 'number' },
      }),
      dangerLevel: 'high',
      readonly: false,
      source: 'official',
      sourceId: 'official.workspace-python',
      originalName: 'python_repl',
    },
    async (args, context) => {
      requirePythonToolApproval(context, 'python_repl');
      const workspace = await requirePythonWorkspace(dependencies.getWorkspace);
      return runPythonReplSnippet({
        rootPath: workspace.rootPath,
        code: requireString(args, 'code'),
        ...(workspace.pythonPath === undefined ? {} : { pythonPath: workspace.pythonPath }),
        ...(workspace.pythonArgs === undefined ? {} : { pythonArgs: workspace.pythonArgs }),
        timeoutMs: optionalPositiveInteger(args, 'timeoutMs', workspace.timeoutMs ?? timeoutMs) ?? timeoutMs,
        outputLimitBytes: optionalPositiveInteger(args, 'maxOutputBytes', outputLimitBytes) ?? outputLimitBytes,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
    },
  );

  dependencies.registry.register(
    {
      name: 'install_python_deps',
      description: 'Install Python dependencies for the active workspace using python -m pip and the workspace requirements file.',
      inputSchema: objectSchema({
        packages: { type: 'array', items: { type: 'string' } },
        requirementsPath: { type: 'string' },
        upgrade: { type: 'boolean' },
        writeRequirements: { type: 'boolean' },
        timeoutMs: { type: 'number' },
        maxOutputBytes: { type: 'number' },
      }),
      dangerLevel: 'high',
      readonly: false,
      source: 'official',
      sourceId: 'official.workspace-python',
      originalName: 'install_python_deps',
    },
    async (args, context) => {
      requirePythonToolApproval(context, 'install_python_deps');
      const workspace = await requirePythonWorkspace(dependencies.getWorkspace);
      return installWorkspacePythonDependencies({
        rootPath: workspace.rootPath,
        requirementsPath: optionalString(args, 'requirementsPath') ?? workspace.requirementsPath,
        packages: optionalStringArray(args, 'packages') ?? [],
        upgrade: optionalBoolean(args, 'upgrade') ?? false,
        writeRequirements: optionalBoolean(args, 'writeRequirements') ?? true,
        ...(workspace.pythonPath === undefined ? {} : { pythonPath: workspace.pythonPath }),
        ...(workspace.pythonArgs === undefined ? {} : { pythonArgs: workspace.pythonArgs }),
        timeoutMs: optionalPositiveInteger(args, 'timeoutMs', workspace.timeoutMs ?? timeoutMs) ?? timeoutMs,
        outputLimitBytes: optionalPositiveInteger(args, 'maxOutputBytes', outputLimitBytes) ?? outputLimitBytes,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
    },
  );
}

export async function runPythonReplSnippet(request: PythonReplRunRequest): Promise<PythonReplRunResult> {
  const pythonPath = request.pythonPath ?? 'python';
  const pythonArgs = request.pythonArgs ?? [];
  const processRequest: PythonProcessRequest = {
    rootPath: request.rootPath,
    command: pythonPath,
    args: [...pythonArgs, '-c', request.code],
    timeoutMs: request.timeoutMs ?? 300_000,
    outputLimitBytes: request.outputLimitBytes ?? 100 * 1024,
  };
  if (request.signal !== undefined) processRequest.signal = request.signal;
  return runPythonProcess(processRequest);
}

export async function installWorkspacePythonDependencies(
  request: PythonDependencyInstallRequest,
): Promise<PythonDependencyInstallResult> {
  const pythonPath = request.pythonPath ?? 'python';
  const pythonArgs = request.pythonArgs ?? [];
  const packages = normalizePackageSpecs(request.packages ?? []);
  const requirementsPath = request.requirementsPath;
  const pipArgs = ['-m', 'pip', 'install', '--disable-pip-version-check'];
  let requirementsRelativePath: string | undefined;
  let writtenPackageSpecs: string[] = [];

  if (request.upgrade) pipArgs.push('--upgrade');
  if (requirementsPath?.trim()) {
    requirementsRelativePath = requirementsPath.trim();
    const absoluteRequirementsPath = resolveInsideWorkspace(request.rootPath, requirementsRelativePath);
    if (request.writeRequirements !== false && packages.length) {
      writtenPackageSpecs = await appendMissingRequirements(absoluteRequirementsPath, packages);
    }
    pipArgs.push('-r', absoluteRequirementsPath);
  } else {
    pipArgs.push(...packages);
  }

  if (!requirementsPath?.trim() && packages.length === 0) {
    throw new Error('install_python_deps requires packages or a requirements file.');
  }

  const processRequest: PythonProcessRequest = {
    rootPath: request.rootPath,
    command: pythonPath,
    args: [...pythonArgs, ...pipArgs],
    timeoutMs: request.timeoutMs ?? 300_000,
    outputLimitBytes: request.outputLimitBytes ?? 100 * 1024,
  };
  if (request.signal !== undefined) processRequest.signal = request.signal;
  const result = await runPythonProcess(processRequest);
  return {
    ...result,
    ...(requirementsRelativePath === undefined ? {} : { requirementsRelativePath }),
    ...(writtenPackageSpecs.length === 0 ? {} : { writtenPackageSpecs }),
  };
}

type PythonProcessRequest = {
  rootPath: string;
  command: string;
  args: string[];
  timeoutMs: number;
  outputLimitBytes: number;
  signal?: AbortSignal;
};

async function runPythonProcess(request: PythonProcessRequest): Promise<PythonReplRunResult> {
  if (request.signal?.aborted) throw new Error('Python execution was aborted before launch.');

  const output = createOutputCapture(request.outputLimitBytes);
  const startedAt = Date.now();
  let timedOut = false;
  let aborted = false;

  return new Promise<PythonReplRunResult>((resolve) => {
    const child = spawn(request.command, request.args, {
      cwd: request.rootPath,
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let forceKillTimeout: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      clearTimeout(timeout);
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
    const timeout = setTimeout(() => {
      timedOut = true;
      killChild();
    }, request.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => output.appendStdout(chunk));
    child.stderr?.on('data', (chunk: Buffer) => output.appendStderr(chunk));
    child.once('error', (error) => output.appendStderr(Buffer.from(error.message)));
    child.once('close', (exitCode, signal) => {
      cleanup();
      resolve({
        command: [request.command, ...request.args].join(' '),
        cwd: request.rootPath,
        exitCode,
        signal,
        stdout: output.stdout(),
        stderr: output.stderr(),
        elapsedMs: Date.now() - startedAt,
        ...(timedOut ? { timedOut: true } : {}),
        ...(aborted ? { aborted: true } : {}),
        ...(output.stdoutTruncated() ? { stdoutTruncated: true } : {}),
        ...(output.stderrTruncated() ? { stderrTruncated: true } : {}),
      });
    });

    request.signal?.addEventListener('abort', abortFromSignal, { once: true });
  });
}

function requirePythonToolApproval(context: AgentToolContext, toolName: string): void {
  if (context.session.mode === 'readonly') {
    throw new Error(`${toolName} is not allowed in readonly mode.`);
  }
  if (context.session.mode === 'full-auto') return;
  if (isApprovedToolContext(context, toolName)) return;
  throw new Error(`${toolName} requires explicit approval.`);
}

async function requirePythonWorkspace(
  getWorkspace: PythonRuntimeToolDependencies['getWorkspace'],
): Promise<PythonRuntimeToolWorkspace> {
  const workspace = await getWorkspace();
  if (!workspace) throw new Error('Python tools require an active workspace.');
  return workspace;
}

async function appendMissingRequirements(absolutePath: string, packages: string[]): Promise<string[]> {
  const existing = await readTextIfExists(absolutePath);
  const existingLines = new Set(
    existing
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#')),
  );
  const missing = packages.filter((pkg) => !existingLines.has(pkg));
  if (missing.length === 0) return [];
  const next = `${existing}${existing.endsWith('\n') || existing.length === 0 ? '' : '\n'}${missing.join('\n')}\n`;
  await mkdir(dirname(absolutePath), { recursive: true });
  const tempPath = `${absolutePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, next, 'utf8');
  await rename(tempPath, absolutePath);
  return missing;
}

async function readTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

function normalizePackageSpecs(packages: string[]): string[] {
  const normalized = [...new Set(packages.map((pkg) => pkg.trim()).filter(Boolean))];
  for (const pkg of normalized) {
    if (pkg.startsWith('-') || pkg.includes('\r') || pkg.includes('\n') || pkg.includes('\0')) {
      throw new Error(`Invalid Python package spec: ${pkg}`);
    }
  }
  return normalized;
}

function optionalStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`Tool argument "${key}" must be an array of strings.`);
  }
  return value;
}

function optionalRecord(args: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Tool argument "${key}" must be an object.`);
  }
  return value as Record<string, unknown>;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`Tool argument "${key}" must be a boolean.`);
  return value;
}

function createOutputCapture(limitBytes: number): {
  appendStdout(chunk: Buffer): void;
  appendStderr(chunk: Buffer): void;
  stdout(): string;
  stderr(): string;
  stdoutTruncated(): boolean;
  stderrTruncated(): boolean;
} {
  let stdout = '';
  let stderr = '';
  let stdoutTruncated = false;
  let stderrTruncated = false;

  const trim = (value: string): { value: string; truncated: boolean } => {
    if (Buffer.byteLength(value) <= limitBytes) return { value, truncated: false };
    const chars = [...value];
    let output = '';
    for (let index = chars.length - 1; index >= 0; index -= 1) {
      const next = `${chars[index]}${output}`;
      if (Buffer.byteLength(next) > limitBytes) break;
      output = next;
    }
    return { value: output, truncated: true };
  };

  return {
    appendStdout(chunk) {
      const trimmed = trim(stdout + chunk.toString('utf8'));
      stdout = trimmed.value;
      stdoutTruncated = stdoutTruncated || trimmed.truncated;
    },
    appendStderr(chunk) {
      const trimmed = trim(stderr + chunk.toString('utf8'));
      stderr = trimmed.value;
      stderrTruncated = stderrTruncated || trimmed.truncated;
    },
    stdout: () => stdout,
    stderr: () => stderr,
    stdoutTruncated: () => stdoutTruncated,
    stderrTruncated: () => stderrTruncated,
  };
}

function isApprovedToolContext(context: unknown, toolName: string): boolean {
  if (!context || typeof context !== 'object') return false;
  const approval = (context as { approval?: unknown }).approval;
  if (!approval || typeof approval !== 'object') return false;
  const record = approval as { granted?: unknown; toolName?: unknown };
  return record.granted === true && record.toolName === toolName;
}

function objectSchema(properties: Record<string, Record<string, unknown>>): Record<string, unknown> {
  return {
    type: 'object',
    properties,
  };
}
