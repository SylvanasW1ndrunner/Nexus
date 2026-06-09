import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { PythonEnvironmentService } from './python-environment.js';

const execFileAsync = promisify(execFile);

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
});
