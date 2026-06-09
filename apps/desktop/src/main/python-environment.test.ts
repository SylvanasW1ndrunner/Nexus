import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { PythonEnvironmentService } from './python-environment.js';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('PythonEnvironmentService', () => {
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
});
