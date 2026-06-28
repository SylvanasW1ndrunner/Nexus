import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  detectWorkspacePythonRuntime,
  resolveWorkspacePythonRuntime,
  WorkspaceCore,
} from '../src/index.js';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('Workspace Python runtime resolution', () => {
  it('detects a real explicitly configured Python interpreter', async () => {
    const python = await availablePython();
    if (!python) return;
    const workspace = await new WorkspaceCore().create({
      name: 'Python 检测项目',
      rootPath: join(await tempDir(), 'workspace'),
      python: { mode: 'system', pythonPath: python },
    });

    const info = await detectWorkspacePythonRuntime(workspace);

    expect(info.available).toBe(true);
    expect(info.version).toMatch(/^Python \d+\.\d+/);
    expect(info.resolution).toMatchObject({
      mode: 'system',
      source: 'explicit',
      command: python,
      argsPrefix: [],
    });
  });

  it('reports an invalid interpreter as unavailable without throwing', async () => {
    const workspace = await new WorkspaceCore().create({
      name: '坏解释器项目',
      rootPath: join(await tempDir(), 'workspace'),
      python: { mode: 'system', pythonPath: 'missing-python-dbagent-test' },
    });

    const info = await detectWorkspacePythonRuntime(workspace, { timeoutMs: 500 });

    expect(info.available).toBe(false);
    expect(info.resolution.command).toBe('missing-python-dbagent-test');
    expect(info.errorMessage).toBeTruthy();
  });

  it('resolves venv interpreter paths for Windows and Linux layouts', async () => {
    const workspace = await new WorkspaceCore().create({
      name: 'venv 项目',
      rootPath: join(await tempDir(), 'workspace'),
      python: { mode: 'venv', venvPath: 'scripts/.venv' },
    });

    const windowsResolution = resolveWorkspacePythonRuntime(workspace, { platform: 'win32' });
    const linuxResolution = resolveWorkspacePythonRuntime(workspace, { platform: 'linux' });

    expect(windowsResolution.source).toBe('venv');
    expect(windowsResolution.command.replace(/\\/g, '/')).toContain('scripts/.venv/Scripts/python.exe');
    expect(linuxResolution.source).toBe('venv');
    expect(linuxResolution.command.replace(/\\/g, '/')).toContain('scripts/.venv/bin/python');
  });

  it('resolves conda env names as conda run commands', async () => {
    const workspace = await new WorkspaceCore().create({
      name: 'conda 项目',
      rootPath: join(await tempDir(), 'workspace'),
      python: { mode: 'conda', condaEnvName: 'analytics' },
    });

    expect(resolveWorkspacePythonRuntime(workspace)).toMatchObject({
      mode: 'conda',
      source: 'conda-env',
      command: 'conda',
      argsPrefix: ['run', '-n', 'analytics', 'python'],
    });
  });

  it('marks embedded and docker runtimes as explicit unsupported contracts for now', async () => {
    const workspace = await new WorkspaceCore().create({
      name: 'embedded 项目',
      rootPath: join(await tempDir(), 'workspace'),
      python: { mode: 'embedded' },
    });

    const info = await detectWorkspacePythonRuntime(workspace);

    expect(info.available).toBe(false);
    expect(info.resolution).toMatchObject({
      mode: 'embedded',
      source: 'embedded',
    });
    expect(info.errorMessage).toContain('not implemented');
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-python-runtime-'));
  tempDirs.push(dir);
  return dir;
}

async function availablePython(): Promise<string | undefined> {
  for (const candidate of ['python', 'python3']) {
    try {
      await execFileAsync(candidate, ['--version'], { timeout: 5_000 });
      return candidate;
    } catch {
      // try next candidate
    }
  }
  return undefined;
}
