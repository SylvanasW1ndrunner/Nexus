import { describe, expect, it } from 'vitest';
import type { PythonEnvironmentInfo, WorkspacePythonConfig } from '@dbagent/shared';
import {
  canCreatePythonEnvironment,
  isWorkspaceRelativeDirectoryPath,
  pythonEnvironmentsForMode,
  pythonExecutableForEnvironmentCreation,
  selectPythonEnvironment,
  setCondaEnvironmentInput,
  switchPythonMode,
} from './python-config.js';

describe('Python configuration user flows', () => {
  const baseDraft: WorkspacePythonConfig = {
    mode: 'venv',
    requirementsPath: 'scripts/requirements.txt',
    venvPath: '.venv',
  };

  it('keeps venv and conda fields mutually exclusive when switching modes', () => {
    const condaDraft: WorkspacePythonConfig = {
      mode: 'conda',
      requirementsPath: 'scripts/requirements.txt',
      condaEnvName: 'analytics',
      condaPrefix: 'C:\\Miniconda3\\envs\\analytics',
    };

    expect(switchPythonMode(condaDraft, 'venv')).toEqual({
      mode: 'venv',
      requirementsPath: 'scripts/requirements.txt',
    });
    expect(switchPythonMode(baseDraft, 'conda')).toEqual({
      mode: 'conda',
      requirementsPath: 'scripts/requirements.txt',
    });
  });

  it('selects a detected venv environment without carrying stale conda fields', () => {
    const environment: PythonEnvironmentInfo = {
      id: 'workspace-venv',
      mode: 'venv',
      label: 'Workspace .venv',
      valid: true,
      pythonPath: 'C:\\Project\\.venv\\Scripts\\python.exe',
      venvPath: '.venv',
    };

    expect(selectPythonEnvironment({ ...baseDraft, mode: 'conda', condaEnvName: 'analytics' }, environment)).toEqual({
      mode: 'venv',
      requirementsPath: 'scripts/requirements.txt',
      pythonPath: 'C:\\Project\\.venv\\Scripts\\python.exe',
      venvPath: '.venv',
    });
  });

  it('stores Conda environment name and prefix as separate mutually exclusive shapes', () => {
    expect(setCondaEnvironmentInput(baseDraft, 'analytics')).toEqual({
      mode: 'conda',
      requirementsPath: 'scripts/requirements.txt',
      condaEnvName: 'analytics',
    });
    expect(setCondaEnvironmentInput(baseDraft, 'C:\\Miniconda3\\envs\\analytics')).toEqual({
      mode: 'conda',
      requirementsPath: 'scripts/requirements.txt',
      condaPrefix: 'C:\\Miniconda3\\envs\\analytics',
    });
  });

  it('shows detected environments only for the selected Python mode', () => {
    const environments: PythonEnvironmentInfo[] = [
      { id: 'system-python', mode: 'system', label: 'System Python', valid: true },
      { id: 'workspace-venv', mode: 'venv', label: 'Workspace .venv', valid: true },
      { id: 'conda-base', mode: 'conda', label: 'conda base', valid: true },
    ];

    expect(pythonEnvironmentsForMode(environments, 'venv').map((environment) => environment.id)).toEqual(['workspace-venv']);
    expect(pythonEnvironmentsForMode(environments, 'conda').map((environment) => environment.id)).toEqual(['conda-base']);
  });

  it('guards Python environment creation names before shelling out', () => {
    expect(canCreatePythonEnvironment('.venv')).toBe(true);
    expect(canCreatePythonEnvironment('dbagent-analytics')).toBe(true);
    expect(canCreatePythonEnvironment('dbagent-analytics', 'conda')).toBe(true);
    expect(canCreatePythonEnvironment('.venv', 'conda')).toBe(false);
    expect(canCreatePythonEnvironment('')).toBe(false);
    expect(canCreatePythonEnvironment('../outside')).toBe(false);
    expect(canCreatePythonEnvironment('envs/analytics')).toBe(false);
    expect(canCreatePythonEnvironment('envs\\analytics')).toBe(false);
  });

  it('accepts only workspace relative venv directories from manual input', () => {
    expect(isWorkspaceRelativeDirectoryPath('.venv')).toBe(true);
    expect(isWorkspaceRelativeDirectoryPath('.venv/smoke')).toBe(true);
    expect(isWorkspaceRelativeDirectoryPath('envs\\analytics')).toBe(true);
    expect(isWorkspaceRelativeDirectoryPath('')).toBe(false);
    expect(isWorkspaceRelativeDirectoryPath('../outside')).toBe(false);
    expect(isWorkspaceRelativeDirectoryPath('envs/../outside')).toBe(false);
    expect(isWorkspaceRelativeDirectoryPath('C:\\Project\\.venv')).toBe(false);
    expect(isWorkspaceRelativeDirectoryPath('/tmp/project/.venv')).toBe(false);
  });

  it('uses the selected system Python executable when creating venv environments', () => {
    expect(
      pythonExecutableForEnvironmentCreation(
        { mode: 'system', requirementsPath: 'requirements.txt', pythonPath: 'C:\\Python312\\python.exe' },
        'venv',
      ),
    ).toBe('C:\\Python312\\python.exe');
    expect(
      pythonExecutableForEnvironmentCreation(
        { mode: 'conda', requirementsPath: 'requirements.txt', pythonPath: 'C:\\Miniconda3\\envs\\analytics\\python.exe' },
        'conda',
      ),
    ).toBeUndefined();
  });
});
