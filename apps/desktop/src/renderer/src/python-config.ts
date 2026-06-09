import type { PythonEnvironmentInfo, WorkspacePythonConfig } from '@dbagent/shared';

export function switchPythonMode(
  draft: WorkspacePythonConfig,
  mode: WorkspacePythonConfig['mode'],
): WorkspacePythonConfig {
  return {
    mode,
    requirementsPath: draft.requirementsPath,
    ...(mode === 'system' && draft.pythonPath ? { pythonPath: draft.pythonPath } : {}),
    ...(mode === 'venv' && draft.venvPath ? { venvPath: draft.venvPath } : {}),
    ...(mode === 'conda' && draft.condaEnvName ? { condaEnvName: draft.condaEnvName } : {}),
    ...(mode === 'conda' && draft.condaPrefix ? { condaPrefix: draft.condaPrefix } : {}),
    ...(mode === 'conda' && draft.pythonPath ? { pythonPath: draft.pythonPath } : {}),
  };
}

export function selectPythonEnvironment(
  draft: WorkspacePythonConfig,
  environment: PythonEnvironmentInfo,
): WorkspacePythonConfig {
  return {
    mode: environment.mode,
    requirementsPath: draft.requirementsPath,
    ...(environment.pythonPath ? { pythonPath: environment.pythonPath } : {}),
    ...(environment.venvPath ? { venvPath: environment.venvPath } : {}),
    ...(environment.condaEnvName ? { condaEnvName: environment.condaEnvName } : {}),
    ...(environment.condaPrefix ? { condaPrefix: environment.condaPrefix } : {}),
  };
}

export function setCondaEnvironmentInput(draft: WorkspacePythonConfig, value: string): WorkspacePythonConfig {
  const input = value.trim();
  return {
    mode: 'conda',
    requirementsPath: draft.requirementsPath,
    ...(isPathLike(input) ? { condaPrefix: input } : { condaEnvName: input }),
  };
}

function isPathLike(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('/') || value.includes('\\') || value.includes('/');
}
