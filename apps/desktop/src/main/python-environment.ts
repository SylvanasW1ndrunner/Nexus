import { execFile } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type {
  PythonCreateEnvironmentRequest,
  PythonDetectRequest,
  PythonEnvironmentInfo,
  PythonRunResult,
  PythonRunScriptRequest,
  WorkspacePythonConfig,
} from '@dbagent/shared';

const execFileAsync = promisify(execFile);
const defaultTimeoutMs = 30_000;

export class PythonEnvironmentService {
  async detect(request: PythonDetectRequest = {}): Promise<PythonEnvironmentInfo[]> {
    const environments: PythonEnvironmentInfo[] = [];
    const system = await inspectPython('python', 'system-python', 'System Python', 'system');
    environments.push(system);

    if (request.rootPath) {
      const venvPath = join(request.rootPath, '.venv');
      const venvPython = pythonFromVenvPath(venvPath);
      environments.push({
        ...(await inspectPython(venvPython, 'workspace-venv', 'Workspace .venv', 'venv')),
        venvPath: '.venv',
      });
    }

    environments.push(...(await detectCondaEnvironments()));
    return environments;
  }

  async createEnvironment(request: PythonCreateEnvironmentRequest): Promise<PythonEnvironmentInfo> {
    const rootPath = resolve(request.rootPath);
    const name = sanitizeEnvironmentName(request.name);
    if (request.mode === 'venv') {
      const relativeVenvPath = name === '.venv' ? '.venv' : join('.venv', name);
      const absoluteVenvPath = join(rootPath, relativeVenvPath);
      await mkdir(rootPath, { recursive: true });
      const executable = request.pythonExecutable?.trim() || 'python';
      await execFileAsync(executable, ['-m', 'venv', absoluteVenvPath], { cwd: rootPath, timeout: 120_000 });
      return {
        ...(await inspectPython(pythonFromVenvPath(absoluteVenvPath), `venv-${name}`, `venv ${name}`, 'venv')),
        venvPath: relativeVenvPath,
      };
    }

    await execFileAsync('conda', ['create', '-y', '-n', name, 'python'], { cwd: rootPath, timeout: 180_000 });
    const environments = await detectCondaEnvironments();
    return (
      environments.find((environment) => environment.condaEnvName === name) ?? {
        id: `conda-${name}`,
        mode: 'conda',
        label: `conda ${name}`,
        condaEnvName: name,
        valid: true,
      }
    );
  }

  async runScript(request: PythonRunScriptRequest): Promise<PythonRunResult> {
    const cwd = resolve(request.rootPath);
    const scriptArgs = resolvePythonArgs(cwd, request);
    const invocation = resolvePythonInvocation(cwd, request.config, scriptArgs);
    const startedAt = Date.now();
    try {
      const output = await execFileAsync(invocation.command, invocation.args, {
        cwd,
        timeout: request.timeoutMs ?? defaultTimeoutMs,
        maxBuffer: 1024 * 1024 * 4,
      });
      return {
        command: describeInvocation(invocation),
        cwd,
        exitCode: 0,
        stdout: output.stdout,
        stderr: output.stderr,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (error) {
      const failed = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | null };
      return {
        command: describeInvocation(invocation),
        cwd,
        exitCode: typeof failed.code === 'number' ? failed.code : null,
        stdout: failed.stdout ?? '',
        stderr: failed.stderr ?? failed.message,
        elapsedMs: Date.now() - startedAt,
      };
    }
  }
}

function resolvePythonArgs(rootPath: string, request: PythonRunScriptRequest): string[] {
  if (request.relativePath?.trim()) return [resolveWorkspaceScriptPath(rootPath, request.relativePath)];
  if (typeof request.code === 'string') return ['-c', request.code];
  throw new Error('Python run requires code or a workspace relative path.');
}

function resolveWorkspaceScriptPath(rootPath: string, relativePath: string): string {
  if (isAbsolute(relativePath)) throw new Error('Python script path must be relative to the workspace.');
  const resolved = resolve(rootPath, relativePath);
  const relativeToRoot = relative(rootPath, resolved);
  if (relativeToRoot.startsWith('..') || isAbsolute(relativeToRoot)) {
    throw new Error('Python script path must stay inside the workspace.');
  }
  if (!relativePath.endsWith('.py')) throw new Error('Only Python files can be executed by the Python runner.');
  return resolved;
}

function resolvePythonInvocation(
  rootPath: string,
  config: WorkspacePythonConfig,
  scriptArgs: string[],
): { command: string; args: string[] } {
  if (config.mode === 'system') return { command: config.pythonPath?.trim() || 'python', args: scriptArgs };
  if (config.mode === 'venv') {
    const venvPath = config.venvPath ? resolve(rootPath, config.venvPath) : join(rootPath, '.venv');
    return { command: pythonFromVenvPath(venvPath), args: scriptArgs };
  }
  if (config.pythonPath?.trim()) return { command: config.pythonPath.trim(), args: scriptArgs };
  if (config.condaPrefix) return { command: pythonFromCondaPrefix(config.condaPrefix), args: scriptArgs };
  if (config.condaEnvName?.trim()) {
    return { command: 'conda', args: ['run', '-n', config.condaEnvName.trim(), 'python', ...scriptArgs] };
  }
  throw new Error('Conda environment requires a selected environment name or path.');
}

function describeInvocation(invocation: { command: string; args: string[] }): string {
  return [invocation.command, ...invocation.args].join(' ');
}

async function inspectPython(
  executable: string,
  id: string,
  label: string,
  mode: WorkspacePythonConfig['mode'],
): Promise<PythonEnvironmentInfo> {
  try {
    const output = await execFileAsync(executable, ['--version'], { timeout: 5_000 });
    return {
      id,
      mode,
      label,
      pythonPath: executable,
      version: `${output.stdout}${output.stderr}`.trim(),
      valid: true,
    };
  } catch (error) {
    return {
      id,
      mode,
      label,
      pythonPath: executable,
      valid: false,
      detail: error instanceof Error ? error.message : 'Python executable is not available.',
    };
  }
}

async function detectCondaEnvironments(): Promise<PythonEnvironmentInfo[]> {
  try {
    const output = await execFileAsync('conda', ['env', 'list', '--json'], { timeout: 10_000 });
    const parsed = JSON.parse(output.stdout) as { envs?: string[] };
    const envs = parsed.envs ?? [];
    return Promise.all(
      envs.map(async (prefix) => {
        const name = prefix.split(/[\\/]/).pop();
        return {
          ...(await inspectPython(pythonFromCondaPrefix(prefix), `conda-${prefix}`, `conda ${name ?? prefix}`, 'conda')),
          ...(name ? { condaEnvName: name } : {}),
          condaPrefix: prefix,
        };
      }),
    );
  } catch {
    return [];
  }
}

function pythonFromVenvPath(venvPath: string): string {
  return process.platform === 'win32' ? join(venvPath, 'Scripts', 'python.exe') : join(venvPath, 'bin', 'python');
}

function pythonFromCondaPrefix(prefix: string): string {
  return process.platform === 'win32' ? join(prefix, 'python.exe') : join(prefix, 'bin', 'python');
}

function sanitizeEnvironmentName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes('..') || /[\\/]/.test(trimmed)) throw new Error('Invalid environment name.');
  return trimmed;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
