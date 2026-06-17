import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseWorkspaceScriptTool, WorkspaceCore } from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('WorkspaceCore', () => {
  it('creates a standard analytics workspace with SQL, script, docs, outputs, and skills folders', async () => {
    const rootPath = join(await tempDir(), 'ecommerce-analytics');
    const core = new WorkspaceCore();

    const workspace = await core.create({
      name: '电商分析项目',
      rootPath,
      description: 'GMV and cohort analysis',
      connections: [{ connectionId: 'prod_pg', isDefault: true }],
      python: { mode: 'venv', venvPath: 'scripts/.venv', requirementsPath: 'scripts/requirements-dev.txt' },
      tags: ['ecommerce', 'analytics'],
    });

    expect(workspace.name).toBe('电商分析项目');
    expect(workspace.defaults.connectionId).toBe('prod_pg');
    expect(workspace.python).toMatchObject({
      mode: 'venv',
      venvPath: 'scripts/.venv',
      requirementsPath: 'scripts/requirements-dev.txt',
      timeoutSeconds: 300,
      networkAllowed: false,
    });
    await expect(readFile(join(rootPath, '.dbagent', 'workspace.json'), 'utf8')).resolves.toContain('电商分析项目');
    await expect(readFile(join(rootPath, 'scripts', 'requirements-dev.txt'), 'utf8')).resolves.toContain('pandas');
  });

  it('saves reusable SQL with metadata into the configured SQL library', async () => {
    const rootPath = join(await tempDir(), 'workspace');
    const core = new WorkspaceCore();
    await core.create({ name: 'SQL 项目', rootPath, assetPaths: { sqlLibrary: 'sql/reports' } });

    const saved = await core.saveSql({
      rootPath,
      name: '每日 GMV',
      description: '统计每日 GMV',
      connectionId: 'prod_pg',
      tags: ['gmv', 'daily'],
      sql: 'select date(created_at), sum(amount) from orders group by 1;',
    });
    const content = await core.readFile(rootPath, saved.relativePath);

    expect(saved.relativePath).toBe('sql/reports/每日-gmv.sql');
    expect(content).toContain('-- @name: 每日 GMV');
    expect(content).toContain('-- @connection: prod_pg');
    expect(content).toContain('-- @tags: [gmv, daily]');
  });

  it('atomically writes workspace files while blocking protected and escaping paths', async () => {
    const rootPath = join(await tempDir(), 'workspace');
    const core = new WorkspaceCore();
    await core.create({ name: '脚本项目', rootPath });

    const saved = await core.writeFile(rootPath, 'scripts/analyze_orders.py', 'print("orders")\n');

    await expect(core.readFile(rootPath, saved.relativePath)).resolves.toBe('print("orders")\n');
    await expect(core.writeFile(rootPath, '../escape.py', 'print("bad")')).rejects.toThrow('escapes');
    await expect(core.writeFile(rootPath, '.dbagent/workspace.json', '{}')).rejects.toThrow('managed project directory');
  });

  it('discovers Python scripts declared as workspace tools', async () => {
    const rootPath = join(await tempDir(), 'workspace');
    const core = new WorkspaceCore();
    await core.create({ name: '工具脚本项目', rootPath });
    await core.writeFile(
      rootPath,
      'scripts/decrypt_phone.py',
      [
        '"""',
        'DBAgent Tool: decrypt_phone',
        '解密手机号字段。',
        '@param encrypted: str 加密手机号',
        '"""',
        'print("ok")',
        '',
      ].join('\n'),
    );
    await core.writeFile(rootPath, 'scripts/no_tool.py', 'print("not a tool")\n');

    await expect(core.discoverScriptTools(rootPath)).resolves.toEqual([
      {
        name: 'workspace_script:decrypt_phone',
        description: '解密手机号字段。',
        relativePath: 'scripts/decrypt_phone.py',
        params: [{ name: 'encrypted', type: 'str', description: '加密手机号' }],
      },
    ]);
  });

  it('lists visible workspace files without exposing .dbagent internals', async () => {
    const rootPath = join(await tempDir(), 'workspace');
    const core = new WorkspaceCore();
    await core.create({ name: '列表项目', rootPath });
    await core.writeFile(rootPath, 'docs/reports/gmv.md', '# GMV\n');

    const files = await core.listFiles(rootPath);
    const serialized = JSON.stringify(files);

    expect(serialized).toContain('docs');
    expect(serialized).toContain('gmv.md');
    expect(serialized).not.toContain('.dbagent');
  });

  it('rejects a normal folder without a valid workspace config', async () => {
    const rootPath = await tempDir();
    await writeFile(join(rootPath, 'notes.txt'), 'not a workspace', 'utf8');

    await expect(new WorkspaceCore().open(rootPath)).rejects.toThrow();
  });
});

describe('parseWorkspaceScriptTool', () => {
  it('supports @tool shorthand in Python docstrings', () => {
    expect(
      parseWorkspaceScriptTool(
        'scripts/plot.py',
        [
          "'''",
          '@tool plot_gmv',
          '绘制 GMV 趋势图。',
          '@param days: int 最近天数',
          "'''",
        ].join('\n'),
      ),
    ).toEqual({
      name: 'workspace_script:plot_gmv',
      description: '绘制 GMV 趋势图。',
      relativePath: 'scripts/plot.py',
      params: [{ name: 'days', type: 'int', description: '最近天数' }],
    });
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-core-workspace-'));
  tempDirs.push(dir);
  return dir;
}
