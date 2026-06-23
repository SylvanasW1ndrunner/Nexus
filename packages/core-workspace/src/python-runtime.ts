import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { resolveInsideWorkspace } from './path-utils.js';
import type { WorkspaceConfig, WorkspacePythonMode } from './types.js';

const execFileAsync = promisify(execFile);

export type WorkspacePythonRuntimeSource =
  | 'explicit'
  | 'system'
  | 'venv'
  | 'conda-prefix'
  | 'conda-env'
  | 'embedded'
  | 'docker';

export type WorkspacePythonRuntimeResolution = {
  mode: WorkspacePythonMode;
  source: WorkspacePythonRuntimeSource;
  command: string;
  argsPrefix: string[];
  requirementsPath: string;
  timeoutMs: number;
  networkAllowed: boolean;
  warnings: string[];
};

export type WorkspacePythonRuntimeInfo = {
  resolution: WorkspacePythonRuntimeResolution;
  available: boolean;
  version?: string;
  executable?: string;
  errorMessage?: string;
};

export type WorkspacePythonRuntimeResolveOptions = {
  platform?: NodeJS.Platform;
};

export type WorkspacePythonRuntimeDetectOptions = WorkspacePythonRuntimeResolveOptions & {
  timeoutMs?: number;
};

export function resolveWorkspacePythonRuntime(
  workspace: WorkspaceConfig,
  options: WorkspacePythonRuntimeResolveOptions = {},
): WorkspacePythonRuntimeResolution {
  const platform = options.platform ?? process.platform;
  const python = workspace.python;
  const base = {
    mode: python.mode,
    requirementsPath: python.requirementsPath,
    timeoutMs: python.timeoutSeconds * 1000,
    networkAllowed: python.networkAllowed,
  };

  if (python.mode === 'embedded' || python.mode === 'docker') {
    return {
      ...base,
      source: python.mode,
      command: python.mode,
      argsPrefix: [],
      warnings: [`Python ${python.mode} runtime is not implemented in this backend build.`],
    };
  }

  if (python.pythonPath) {
    return {
      ...base,
      source: 'explicit',
      command: python.pythonPath,
      argsPrefix: [],
      warnings: [],
    };
  }

  if (python.mode === 'venv') {
    const venvPath = python.venvPath ?? 'scripts/.venv';
    return {
      ...base,
      source: 'venv',
      command: venvPythonPath(workspace.rootPath, venvPath, platform),
      argsPrefix: [],
      warnings: [],
    };
  }

  if (python.mode === 'conda') {
    if (python.condaPrefix) {
      return {
        ...base,
        source: 'conda-prefix',
        command: condaPrefixPythonPath(python.condaPrefix, platform),
        argsPrefix: [],
        warnings: [],
      };
    }
    if (python.condaEnvName) {
      return {
        ...base,
        source: 'conda-env',
        command: 'conda',
        argsPrefix: ['run', '-n', python.condaEnvName, 'python'],
        warnings: [],
      };
    }
    return {
      ...base,
      source: 'conda-env',
      command: 'conda',
      argsPrefix: ['run', 'python'],
      warnings: ['Conda runtime has no env name or prefix configured.'],
    };
  }

  return {
    ...base,
    source: 'system',
    command: 'python',
    argsPrefix: [],
    warnings: [],
  };
}

export async function detectWorkspacePythonRuntime(
  workspace: WorkspaceConfig,
  options: WorkspacePythonRuntimeDetectOptions = {},
): Promise<WorkspacePythonRuntimeInfo> {
  const resolution = resolveWorkspacePythonRuntime(workspace, options);
  if (resolution.source === 'embedded' || resolution.source === 'docker') {
    return {
      resolution,
      available: false,
      errorMessage: resolution.warnings[0] ?? 'Python runtime is not implemented.',
    };
  }

  try {
    if (resolution.source === 'venv' || resolution.source === 'conda-prefix' || resolution.source === 'explicit') {
      await access(resolution.command);
    }
    const output = await execFileAsync(resolution.command, [...resolution.argsPrefix, '--version'], {
      timeout: options.timeoutMs ?? 5_000,
    });
    const version = parsePythonVersion(`${output.stdout}${output.stderr}`);
    return {
      resolution,
      available: true,
      ...(version ? { version } : {}),
      ...(resolution.command ? { executable: resolution.command } : {}),
    };
  } catch (error) {
    return {
      resolution,
      available: false,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

function venvPythonPath(rootPath: string, venvPath: string, platform: NodeJS.Platform): string {
  const venvRoot = resolveInsideWorkspace(rootPath, venvPath);
  return join(venvRoot, platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
}

function condaPrefixPythonPath(prefix: string, platform: NodeJS.Platform): string {
  return join(prefix, platform === 'win32' ? 'python.exe' : 'bin/python');
}

function parsePythonVersion(output: string): string | undefined {
  const match = output.match(/Python\s+([0-9]+(?:\.[0-9]+){1,2})/);
  return match?.[0];
}
