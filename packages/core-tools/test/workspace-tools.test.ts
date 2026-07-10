import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolRegistry } from '@dbagent/core-agent';
import { WorkspaceCore } from '@dbagent/core-workspace';
import { registerWorkspaceTools } from '../src/workspace-tools.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('workspace Agent tools', () => {
  it('lets an Agent write, read, and list a report artifact in a real workspace', async () => {
    const { registry, rootPath } = await workspaceHarness();

    const write = registry.get('write_workspace_file');
    await expect(
      write?.handler(
        {
          path: 'outputs/reports/daily-gmv.md',
          content: '# 每日 GMV\n\n- GMV: 128000\n',
        },
        context(),
      ),
    ).resolves.toMatchObject({
      relativePath: 'outputs/reports/daily-gmv.md',
      bytes: 28,
    });
    await expect(readFile(join(rootPath, 'outputs', 'reports', 'daily-gmv.md'), 'utf8')).resolves.toBe(
      '# 每日 GMV\n\n- GMV: 128000\n',
    );

    const read = registry.get('read_workspace_file');
    await expect(
      read?.handler({ path: 'outputs/reports/daily-gmv.md', maxBytes: 1024 }, context()),
    ).resolves.toEqual({
      path: 'outputs/reports/daily-gmv.md',
      content: '# 每日 GMV\n\n- GMV: 128000\n',
      bytes: 28,
    });

    const list = registry.get('list_workspace_dir');
    await expect(list?.handler({ path: 'outputs' }, context())).resolves.toMatchObject({
      entries: [
        {
          name: 'reports',
          relativePath: 'outputs/reports',
          type: 'directory',
          children: [{ name: 'daily-gmv.md', relativePath: 'outputs/reports/daily-gmv.md', type: 'file' }],
        },
      ],
    });
  });

  it('blocks workspace tool paths that escape the active workspace', async () => {
    const { registry } = await workspaceHarness();

    await expect(
      registry.get('write_workspace_file')?.handler({ path: '../escape.md', content: 'bad' }, context()),
    ).rejects.toThrow('Workspace path escapes are not allowed.');
    await expect(
      registry.get('read_workspace_file')?.handler({ path: '../escape.md' }, context()),
    ).rejects.toThrow('Workspace path escapes are not allowed.');
    await expect(
      registry.get('delete_workspace_file')?.handler({ path: '../escape.md' }, context()),
    ).rejects.toThrow('Workspace path escapes are not allowed.');
  });

  it('edits a workspace file with exact replacement and rejects ambiguous edits', async () => {
    const { registry, rootPath } = await workspaceHarness();

    await registry.get('write_workspace_file')?.handler(
      {
        path: 'scripts/analyze_orders.py',
        content: [
          'def summarize():',
          '    status = "pending"',
          '    return status',
          '',
          'def audit():',
          '    return "pending"',
          '',
        ].join('\n'),
      },
      context(),
    );

    await expect(
      registry.get('edit_workspace_file')?.handler(
        {
          path: 'scripts/analyze_orders.py',
          oldText: 'status = "pending"',
          newText: 'status = "paid"',
        },
        context(),
      ),
    ).resolves.toMatchObject({
      path: 'scripts/analyze_orders.py',
      replacements: 1,
    });

    await expect(readFile(join(rootPath, 'scripts', 'analyze_orders.py'), 'utf8')).resolves.toContain(
      'status = "paid"',
    );

    await expect(
      registry.get('edit_workspace_file')?.handler(
        {
          path: 'scripts/analyze_orders.py',
          oldText: 'return',
          newText: 'yield',
        },
        context(),
      ),
    ).rejects.toThrow('Workspace edit target text is ambiguous.');

    await expect(
      registry.get('edit_workspace_file')?.handler(
        {
          path: 'scripts/analyze_orders.py',
          oldText: 'return',
          newText: 'yield',
          replaceAll: true,
        },
        context(),
      ),
    ).resolves.toMatchObject({
      replacements: 2,
    });
  });

  it('moves deleted files into workspace trash instead of permanently removing them', async () => {
    const { registry, rootPath } = await workspaceHarness();
    await registry.get('write_workspace_file')?.handler(
      { path: 'outputs/reports/obsolete.md', content: '# obsolete\n' },
      context(),
    );

    const result = await registry.get('delete_workspace_file')?.handler(
      { path: 'outputs/reports/obsolete.md' },
      context(),
    );

    expect(result).toMatchObject({
      path: 'outputs/reports/obsolete.md',
      deleted: true,
      undoAvailable: true,
      bytes: 11,
    });
    expect(String(result?.trashPath)).toMatch(/^outputs\/_trash\/deleted\/.+\/obsolete\.md$/);
    await expect(access(join(rootPath, 'outputs', 'reports', 'obsolete.md'))).rejects.toThrow();
    await expect(readFile(join(rootPath, String(result?.trashPath)), 'utf8')).resolves.toBe('# obsolete\n');
  });

  it('finds workspace paths with glob and searches file content with grep', async () => {
    const { registry } = await workspaceHarness();
    await registry.get('write_workspace_file')?.handler(
      {
        path: 'sql/analytics/orders.sql',
        content: 'select order_id, gmv from marts.orders where status = \'paid\';\n',
      },
      context(),
    );
    await registry.get('write_workspace_file')?.handler(
      {
        path: 'scripts/traffic/analyze.py',
        content: 'source = "traffic_events"\nprint(source)\n',
      },
      context(),
    );
    await registry.get('write_workspace_file')?.handler(
      {
        path: 'outputs/_trash/deleted/ignored/orders.sql',
        content: 'select should_not_appear from ignored;\n',
      },
      context(),
    );

    await expect(
      registry.get('glob_workspace')?.handler({ pattern: 'scripts/**/*.py' }, context()),
    ).resolves.toMatchObject({
      pattern: 'scripts/**/*.py',
      matches: [{ path: 'scripts/traffic/analyze.py', type: 'file' }],
      count: 1,
    });

    await expect(
      registry.get('grep_workspace')?.handler({ path: 'sql', query: 'GMV', include: 'sql/**/*.sql' }, context()),
    ).resolves.toMatchObject({
      query: 'GMV',
      matches: [
        {
          path: 'sql/analytics/orders.sql',
          line: 1,
          column: 18,
          preview: "select order_id, gmv from marts.orders where status = 'paid';",
        },
      ],
      count: 1,
    });

    await expect(
      registry.get('grep_workspace')?.handler({ path: '.', query: 'should_not_appear' }, context()),
    ).resolves.toMatchObject({
      matches: [],
      count: 0,
    });
  });

  it('requires an active workspace before touching the filesystem', async () => {
    const registry = new ToolRegistry();
    registerWorkspaceTools({
      registry,
      workspace: new WorkspaceCore(),
      getWorkspaceRoot: () => undefined,
    });

    await expect(
      registry.get('list_workspace_dir')?.handler({ path: '.' }, context()),
    ).rejects.toThrow('No active workspace.');
  });

  it('supports async active workspace root providers', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'dbagent-workspace-tools-async-'));
    tempDirs.push(rootPath);
    const workspace = new WorkspaceCore();
    await workspace.create({
      name: 'Async Workspace',
      rootPath,
    });
    const registry = new ToolRegistry();
    registerWorkspaceTools({
      registry,
      workspace,
      getWorkspaceRoot: () => Promise.resolve(rootPath),
    });

    await expect(
      registry
        .get('write_workspace_file')
        ?.handler({ path: 'outputs/async-root.txt', content: 'async root ok' }, context()),
    ).resolves.toMatchObject({
      relativePath: 'outputs/async-root.txt',
      bytes: 13,
    });
    await expect(
      registry.get('read_workspace_file')?.handler({ path: 'outputs/async-root.txt' }, context()),
    ).resolves.toMatchObject({
      content: 'async root ok',
      bytes: 13,
    });
  });
});

async function workspaceHarness(): Promise<{ registry: ToolRegistry; rootPath: string }> {
  const rootPath = await mkdtemp(join(tmpdir(), 'dbagent-workspace-tools-'));
  tempDirs.push(rootPath);
  const workspace = new WorkspaceCore();
  await workspace.create({
    name: '客户经营分析',
    rootPath,
  });
  const registry = new ToolRegistry();
  registerWorkspaceTools({
    registry,
    workspace,
    getWorkspaceRoot: () => rootPath,
  });
  return { registry, rootPath };
}

function context() {
  return {
    session: {
      id: 'session_workspace_tools',
      title: 'workspace tools',
      mode: 'full-auto' as const,
      strategy: 'react' as const,
      messages: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      aborted: false,
    },
  };
}
