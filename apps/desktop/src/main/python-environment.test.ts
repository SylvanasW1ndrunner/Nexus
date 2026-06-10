import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { PythonEnvironmentService, systemPythonCandidates } from './python-environment.js';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('PythonEnvironmentService', () => {
  it('checks common Python launchers for each operating system', () => {
    expect(systemPythonCandidates('linux').map((candidate) => candidate.command)).toEqual(['python', 'python3']);
    expect(systemPythonCandidates('win32').map((candidate) => candidate.command)).toEqual(['python', 'python3', 'py']);
  });

  it('detects Python environments without throwing', async () => {
    const service = new PythonEnvironmentService();
    const environments = await service.detect();

    expect(environments.length).toBeGreaterThanOrEqual(1);
    expect(environments[0]).toHaveProperty('valid');
  });

  it('runs Python code when system Python is available', async () => {
    try {
      await execFileAsync('python', ['--version']);
    } catch {
      return;
    }
    const service = new PythonEnvironmentService();
    const result = await service.runScript({
      rootPath: process.cwd(),
      config: { mode: 'system', requirementsPath: 'requirements.txt' },
      code: 'print(6 * 7)',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('42');
  });

  it('runs a Python file by workspace relative path', async () => {
    try {
      await execFileAsync('python', ['--version']);
    } catch {
      return;
    }
    const rootPath = await mkdtemp(join(tmpdir(), 'dbagent-python-run-'));
    tempDirs.push(rootPath);
    await writeFile(join(rootPath, 'script.py'), 'print("file-run-ok")\n', 'utf8');

    const result = await new PythonEnvironmentService().runScript({
      rootPath,
      config: { mode: 'system', requirementsPath: 'requirements.txt' },
      relativePath: 'script.py',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('file-run-ok');
  });

  it('creates a venv and runs code through that environment when Python venv is available', async () => {
    try {
      await execFileAsync('python', ['-m', 'venv', '--help']);
    } catch {
      return;
    }
    const rootPath = await mkdtemp(join(tmpdir(), 'dbagent-python-venv-'));
    tempDirs.push(rootPath);
    const service = new PythonEnvironmentService();

    const environment = await service.createEnvironment({
      rootPath,
      mode: 'venv',
      name: 'smoke',
      pythonExecutable: 'python',
    });

    expect(environment).toMatchObject({
      mode: 'venv',
      valid: true,
      venvPath: join('.venv', 'smoke'),
    });

    const result = await service.runScript({
      rootPath,
      config: { mode: 'venv', requirementsPath: 'requirements.txt', venvPath: join('.venv', 'smoke') },
      code: 'import sys; print("venv-run-ok"); print(sys.prefix)',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('venv-run-ok');
    expect(result.stdout.replaceAll('\\', '/')).toContain(join(rootPath, '.venv', 'smoke').replaceAll('\\', '/'));
  });

  it('rejects Python file paths outside the workspace', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'dbagent-python-run-'));
    tempDirs.push(rootPath);

    await expect(
      new PythonEnvironmentService().runScript({
        rootPath,
        config: { mode: 'system', requirementsPath: 'requirements.txt' },
        relativePath: '../escape.py',
      }),
    ).rejects.toThrow('inside the workspace');
  });

  it('rejects venv paths outside the workspace before launching Python', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'dbagent-python-run-'));
    tempDirs.push(rootPath);

    await expect(
      new PythonEnvironmentService().runScript({
        rootPath,
        config: { mode: 'venv', venvPath: '../outside-venv', requirementsPath: 'requirements.txt' },
        code: 'print("should-not-run")',
      }),
    ).rejects.toThrow('inside the workspace');
  });

  it('treats a Conda environment input that looks like a path as a prefix', async () => {
    try {
      await execFileAsync('python', ['--version']);
    } catch {
      return;
    }
    const locator = process.platform === 'win32' ? 'where' : 'which';
    const located = await execFileAsync(locator, ['python']);
    const pythonPath = located.stdout.split(/\r?\n/).find(Boolean);
    if (!pythonPath) return;
    const prefix = process.platform === 'win32' ? dirname(pythonPath) : dirname(dirname(pythonPath));

    const result = await new PythonEnvironmentService().runScript({
      rootPath: process.cwd(),
      config: { mode: 'conda', condaEnvName: prefix, requirementsPath: 'requirements.txt' },
      code: 'print("conda-prefix-input-ok")',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('conda-prefix-input-ok');
    expect(result.command).not.toContain('conda run -n');
  });

  it('runs Conda environments by environment name when conda is available', async () => {
    try {
      await execFileAsync('conda', ['--version']);
      await execFileAsync('conda', ['run', '-n', 'base', 'python', '--version']);
    } catch {
      return;
    }

    const result = await new PythonEnvironmentService().runScript({
      rootPath: process.cwd(),
      config: { mode: 'conda', condaEnvName: 'base', requirementsPath: 'requirements.txt' },
      code: 'print("conda-name-ok")',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('conda-name-ok');
    expect(result.command).toContain('conda run -n base python');
  });
});
