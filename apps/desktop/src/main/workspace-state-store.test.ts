import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceStateStore } from './workspace-state-store.js';

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe('WorkspaceStateStore', () => {
  it('saves and restores SQL draft plus active connection id', async () => {
    const filePath = await tempWorkspacePath();
    const store = new WorkspaceStateStore(filePath);

    const saved = await store.save({
      activeConnectionId: 'conn-prod',
      sqlDraft: 'select * from users limit 10',
      updatedAt: 'stale',
    });

    expect(saved.updatedAt).not.toBe('stale');
    await expect(store.load()).resolves.toEqual(saved);
    expect(await readFile(filePath, 'utf8')).toContain('select * from users limit 10');
  });

  it('returns undefined when the workspace state file is missing', async () => {
    const store = new WorkspaceStateStore(join(await tempDir(), 'missing', 'workspace-state.json'));

    await expect(store.load()).resolves.toBeUndefined();
  });

  it('ignores corrupt JSON so startup can continue', async () => {
    const filePath = await tempWorkspacePath();
    await writeFile(filePath, '{ not valid json', 'utf8');
    const store = new WorkspaceStateStore(filePath);

    await expect(store.load()).resolves.toBeUndefined();
  });

  it('ignores structurally invalid state', async () => {
    const filePath = await tempWorkspacePath();
    await writeFile(filePath, JSON.stringify({ activeConnectionId: 'conn-prod', updatedAt: '2026-06-08' }), 'utf8');
    const store = new WorkspaceStateStore(filePath);

    await expect(store.load()).resolves.toBeUndefined();
  });
});

async function tempWorkspacePath(): Promise<string> {
  const filePath = join(await tempDir(), 'data', 'workspace-state.json');
  await mkdir(dirname(filePath), { recursive: true });
  return filePath;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-workspace-state-'));
  tempDirs.push(dir);
  return dir;
}
