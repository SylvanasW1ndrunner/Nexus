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
    expect(project.python).toEqual({ mode: 'system', requirementsPath: 'scripts/requirements.txt' });
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

  it('saves reusable SQL into the workspace library with searchable metadata', async () => {
    const rootPath = join(await tempDir(), 'ecommerce-analytics');
    const store = new WorkspaceProjectStore(join(await tempDir(), 'workspaces.json'));
    const project = await store.create({ name: '电商分析项目', rootPath });

    const saved = await store.saveSqlFile({
      rootPath: project.rootPath,
      name: '每日 GMV',
      description: '统计昨日 GMV',
      connectionId: 'prod_pg',
      tags: ['gmv', 'daily'],
      sql: 'select date(created_at) as day, sum(amount) as gmv from orders group by 1;',
    });
    const content = await readFile(saved.absolutePath, 'utf8');
    const files = await store.listFiles(project.rootPath);
    const reopened = await store.readFile({ rootPath: project.rootPath, relativePath: saved.relativePath });

    expect(saved.relativePath).toBe('sql/analytics/每日-gmv.sql');
    expect(content).toContain('-- @name: 每日 GMV');
    expect(content).toContain('-- @connection: prod_pg');
    expect(content).toContain('-- @tags: [gmv, daily]');
    expect(JSON.stringify(files)).toContain('每日-gmv.sql');
    expect(reopened.content).toContain('sum(amount) as gmv');
    expect(reopened.relativePath).toBe(saved.relativePath);
  });

  it('blocks workspace file reads outside managed project directories', async () => {
    const rootPath = join(await tempDir(), 'ecommerce-analytics');
    const store = new WorkspaceProjectStore(join(await tempDir(), 'workspaces.json'));
    const project = await store.create({ name: '电商分析项目', rootPath });

    await expect(store.readFile({ rootPath: project.rootPath, relativePath: '../secret.txt' })).rejects.toThrow(
      'managed project directory',
    );
    await expect(store.readFile({ rootPath: project.rootPath, relativePath: '.dbagent/workspace.json' })).rejects.toThrow(
      'managed project directory',
    );
  });

  it('updates workspace SQL library settings and saves future SQL there', async () => {
    const rootPath = join(await tempDir(), 'ecommerce-analytics');
    const store = new WorkspaceProjectStore(join(await tempDir(), 'workspaces.json'));
    const project = await store.create({ name: '电商分析项目', rootPath });

    const updated = await store.updateSettings({
      rootPath: project.rootPath,
      assetPaths: { sqlLibrary: 'warehouse/sql' },
    });
    const saved = await store.saveSqlFile({
      rootPath: updated.rootPath,
      name: '库存周转',
      sql: 'select sku, sum(qty) from inventory group by sku;',
    });

    expect(updated.assetPaths.sqlLibrary).toBe('warehouse/sql');
    expect(saved.relativePath).toBe('warehouse/sql/库存周转.sql');
    await expect(store.readFile({ rootPath: updated.rootPath, relativePath: saved.relativePath })).resolves.toMatchObject({
      relativePath: saved.relativePath,
    });
  });

  it('persists Python environment settings for local data processing scripts', async () => {
    const rootPath = join(await tempDir(), 'ecommerce-analytics');
    const store = new WorkspaceProjectStore(join(await tempDir(), 'workspaces.json'));
    const project = await store.create({
      name: 'Python 绛栫暐鍒嗘瀽',
      rootPath,
      python: {
        mode: 'venv',
        venvPath: '.venv',
        requirementsPath: 'scripts/requirements-dev.txt',
      },
    });

    const updated = await store.updateSettings({
      rootPath: project.rootPath,
      python: {
        mode: 'conda',
        pythonPath: 'C:\\Miniconda3\\envs\\analytics\\python.exe',
        requirementsPath: 'scripts/requirements-prod.txt',
      },
    });
    const config = await readFile(join(rootPath, '.dbagent', 'workspace.json'), 'utf8');
    const reopened = await store.open(rootPath);

    expect(project.python).toMatchObject({
      mode: 'venv',
      venvPath: '.venv',
      requirementsPath: 'scripts/requirements-dev.txt',
    });
    expect(updated.python).toMatchObject({
      mode: 'conda',
      pythonPath: 'C:\\Miniconda3\\envs\\analytics\\python.exe',
      requirementsPath: 'scripts/requirements-prod.txt',
    });
    expect(updated.python.venvPath).toBeUndefined();
    await expect(readFile(join(rootPath, 'scripts', 'requirements-dev.txt'), 'utf8')).resolves.toContain('pandas');
    expect(config).toContain('requirements-prod.txt');
    expect(reopened.python.requirementsPath).toBe('scripts/requirements-prod.txt');
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
