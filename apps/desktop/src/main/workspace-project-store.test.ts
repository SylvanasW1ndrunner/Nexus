import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceProjectStore } from './workspace-project-store.js';

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe('WorkspaceProjectStore', () => {
  it('creates a standard business workspace with reusable SQL and script directories', async () => {
    const rootPath = join(await tempDir(), 'ecommerce-analytics');
    const store = new WorkspaceProjectStore(join(await tempDir(), 'workspaces.json'));

    const project = await store.create({
      name: '电商分析项目',
      rootPath,
      description: '沉淀 GMV、用户分群和运营日报 SQL',
      template: 'standard',
    });

    expect(project.name).toBe('电商分析项目');
    expect(project.template).toBe('standard');
    expect(project.connections).toEqual([]);
    await expect(readFile(join(rootPath, '.dbagent', 'workspace.json'), 'utf8')).resolves.toContain('电商分析项目');
    await expect(readFile(join(rootPath, 'sql', 'README.md'), 'utf8')).resolves.toContain('@connection');
    await expect(readFile(join(rootPath, 'scripts', 'requirements.txt'), 'utf8')).resolves.toContain('pandas');
    await expect(readFile(join(rootPath, 'docs', 'README.md'), 'utf8')).resolves.toContain('Schema');
  });

  it('opens an existing workspace and promotes it to the active recent project', async () => {
    const statePath = join(await tempDir(), 'workspaces.json');
    const store = new WorkspaceProjectStore(statePath);
    const first = await store.create({ name: '财务日报', rootPath: join(await tempDir(), 'finance') });
    const second = await store.create({ name: '风控分析', rootPath: join(await tempDir(), 'risk') });

    const opened = await store.open(first.rootPath);
    const recent = await store.listRecent();

    expect(opened.id).toBe(first.id);
    expect(recent.activeWorkspaceId).toBe(first.id);
    expect(recent.workspaces.map((workspace) => workspace.id)).toEqual([first.id, second.id]);
    await expect(store.loadActive()).resolves.toMatchObject({ id: first.id, name: '财务日报' });
  });

  it('rejects invalid workspace config when opening a normal folder', async () => {
    const rootPath = await tempDir();
    await writeFile(join(rootPath, 'notes.txt'), 'not a workspace', 'utf8');
    const store = new WorkspaceProjectStore(join(await tempDir(), 'workspaces.json'));

    await expect(store.open(rootPath)).rejects.toThrow();
    await expect(store.listRecent()).resolves.toEqual({ workspaces: [] });
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-workspace-project-'));
  tempDirs.push(dir);
  return dir;
}
