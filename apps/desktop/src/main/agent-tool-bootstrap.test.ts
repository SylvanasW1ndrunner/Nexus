import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolRegistry, type AgentToolContext } from '@dbagent/core-agent';
import type { IDatabaseDriver, TableSummary } from '@dbagent/core-db';
import type { WorkspaceScriptRunRequest } from '@dbagent/core-tools';
import { WorkspaceCore } from '@dbagent/core-workspace';
import {
  ok,
  type DatabaseEngine,
  type QueryCancelResponse,
  type QueryExecutionResult,
  type QueryRequest,
  type Result,
  type SavedConnection,
  type TableDetail,
  type WorkspaceProject,
} from '@dbagent/shared';
import { registerDesktopAgentTools } from './agent-tool-bootstrap.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('registerDesktopAgentTools', () => {
  it('registers database, schema RAG, and workspace tools for the headless desktop agent', () => {
    const registry = new ToolRegistry();

    registerDesktopAgentTools({
      registry,
      connections: connectionReader([connectedConnection()]),
      workspaceProjects: workspaceReader(),
      driverForEngine: () => fakeDriver(),
    });

    expect(registry.list().map((tool) => tool.name).sort()).toEqual([
      'audit_sql',
      'build_schema_context',
      'describe_table',
      'execute_sql',
      'get_relations',
      'list_schemas',
      'list_tables',
      'list_workspace_dir',
      'query_database',
      'read_workspace_file',
      'search_schema',
      'write_workspace_file',
    ]);
  });

  it('reads the latest async connection state and routes SQL execution by engine', async () => {
    const registry = new ToolRegistry();
    const driver = fakeDriver();
    const routedEngines: DatabaseEngine[] = [];

    registerDesktopAgentTools({
      registry,
      connections: connectionReader([connectedConnection()]),
      workspaceProjects: workspaceReader(),
      driverForEngine: (engine) => {
        routedEngines.push(engine);
        return driver;
      },
    });

    await expect(
      registry.get('query_database')?.handler(
        {
          connectionId: 'conn_desktop',
          sql: 'select count(*) as order_count from public.orders',
          limit: 20,
        },
        toolContext(),
      ),
    ).resolves.toMatchObject({
      rowCount: 1,
      rows: [{ order_count: 42 }],
    });

    expect(driver.executed).toEqual([
      {
        connectionId: 'conn_desktop',
        database: 'analytics',
        sql: 'select count(*) as order_count from public.orders',
      },
    ]);
    expect(routedEngines).toEqual(['postgres']);
  });

  it('rejects SQL tools when the requested connection is not currently connected', async () => {
    const registry = new ToolRegistry();
    const driver = fakeDriver();

    registerDesktopAgentTools({
      registry,
      connections: connectionReader([{ ...connectedConnection(), status: 'disconnected' }]),
      workspaceProjects: workspaceReader(),
      driverForEngine: () => driver,
    });

    await expect(
      registry.get('query_database')?.handler(
        {
          connectionId: 'conn_desktop',
          sql: 'select 1',
        },
        toolContext(),
      ),
    ).rejects.toThrow('Connection is not active: conn_desktop');
    expect(driver.executed).toEqual([]);
  });

  it('keeps workspace tools registered with a clear inactive-workspace boundary', async () => {
    const registry = new ToolRegistry();

    registerDesktopAgentTools({
      registry,
      connections: connectionReader([connectedConnection()]),
      workspaceProjects: workspaceReader(),
      driverForEngine: () => fakeDriver(),
    });

    await expect(registry.get('list_workspace_dir')?.handler({ path: '.' }, toolContext())).rejects.toThrow(
      'No active workspace.',
    );
  });

  it('resolves the active workspace root at tool execution time', async () => {
    const registry = new ToolRegistry();
    const rootPath = await mkdtemp(join(tmpdir(), 'dbagent-desktop-agent-workspace-'));
    tempDirs.push(rootPath);
    const workspace = new WorkspaceCore();
    await workspace.create({
      name: 'Desktop Agent Workspace',
      rootPath,
    });
    const activeProject: { value: WorkspaceProject | undefined } = { value: undefined };

    registerDesktopAgentTools({
      registry,
      connections: connectionReader([connectedConnection()]),
      workspaceProjects: {
        loadActive() {
          return Promise.resolve(activeProject.value);
        },
      },
      driverForEngine: () => fakeDriver(),
      workspace,
    });

    await expect(
      registry.get('read_workspace_file')?.handler({ path: 'outputs/summary.md' }, toolContext()),
    ).rejects.toThrow('No active workspace.');

    activeProject.value = workspaceProject(rootPath);

    await expect(
      registry
        .get('write_workspace_file')
        ?.handler({ path: 'outputs/summary.md', content: '# Summary\n\nactive workspace\n' }, toolContext()),
    ).resolves.toMatchObject({
      relativePath: 'outputs/summary.md',
      bytes: 28,
    });
    await expect(readFile(join(rootPath, 'outputs', 'summary.md'), 'utf8')).resolves.toBe(
      '# Summary\n\nactive workspace\n',
    );
    await expect(
      registry.get('read_workspace_file')?.handler({ path: 'outputs/summary.md' }, toolContext()),
    ).resolves.toMatchObject({
      path: 'outputs/summary.md',
      content: '# Summary\n\nactive workspace\n',
      bytes: 28,
    });
  });

  it('refreshes workspace Python script tools from the active workspace', async () => {
    const registry = new ToolRegistry();
    const { workspace, rootPath } = await scriptWorkspace('summarize_orders');
    const activeProject = workspaceProject(rootPath);
    const launched: WorkspaceScriptRunRequest[] = [];
    const desktopTools = registerDesktopAgentTools({
      registry,
      connections: connectionReader([connectedConnection()]),
      workspaceProjects: workspaceReader(activeProject),
      driverForEngine: () => fakeDriver(),
      workspace,
      scriptRunner: (request) => {
        launched.push(request);
        return Promise.resolve({ exitCode: 0, stdout: 'ok', stderr: '', elapsedMs: 12 });
      },
    });

    await expect(desktopTools.refreshWorkspaceScriptTools()).resolves.toMatchObject([
      {
        name: 'workspace_script:summarize_orders',
        relativePath: 'scripts/summarize_orders.py',
      },
    ]);
    expect(desktopTools.registeredWorkspaceScriptToolNames()).toEqual(['workspace_script:summarize_orders']);
    expect(registry.get('workspace_script:summarize_orders')).toMatchObject({
      dangerLevel: 'medium',
      readonly: false,
      source: 'workspace-script',
      sourceId: 'scripts/summarize_orders.py',
      originalName: 'workspace_script:summarize_orders',
    });

    await expect(
      registry.get('workspace_script:summarize_orders')?.handler({ count: 3, region: 'east' }, toolContext()),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: 'ok',
    });
    expect(launched).toHaveLength(1);
    expect(launched[0]).toMatchObject({
      rootPath,
      relativePath: 'scripts/summarize_orders.py',
      args: { count: 3, region: 'east' },
      pythonPath: 'python',
      timeoutMs: 300_000,
    });
  });

  it('unregisters stale workspace script tools when the active workspace changes', async () => {
    const registry = new ToolRegistry();
    const first = await scriptWorkspace('summarize_orders');
    const second = await scriptWorkspace('plot_gmv');
    const activeProject: { value: WorkspaceProject | undefined } = { value: workspaceProject(first.rootPath) };
    const desktopTools = registerDesktopAgentTools({
      registry,
      connections: connectionReader([connectedConnection()]),
      workspaceProjects: {
        loadActive() {
          return Promise.resolve(activeProject.value);
        },
      },
      driverForEngine: () => fakeDriver(),
      workspace: first.workspace,
      scriptRunner: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '', elapsedMs: 0 }),
    });

    await desktopTools.refreshWorkspaceScriptTools();
    expect(registry.has('workspace_script:summarize_orders')).toBe(true);

    activeProject.value = undefined;
    await expect(
      registry.get('workspace_script:summarize_orders')?.handler({ count: 1, region: 'east' }, toolContext()),
    ).rejects.toThrow('Workspace script tool is no longer active.');

    activeProject.value = workspaceProject(second.rootPath);
    await desktopTools.refreshWorkspaceScriptTools();
    expect(registry.has('workspace_script:summarize_orders')).toBe(false);
    expect(registry.has('workspace_script:plot_gmv')).toBe(true);
    expect(desktopTools.registeredWorkspaceScriptToolNames()).toEqual(['workspace_script:plot_gmv']);
  });
});

function connectionReader(connections: SavedConnection[]) {
  return {
    list() {
      return Promise.resolve(connections);
    },
  };
}

function workspaceReader(project?: WorkspaceProject) {
  return {
    loadActive() {
      return Promise.resolve(project);
    },
  };
}

function workspaceProject(rootPath: string): WorkspaceProject {
  return {
    version: 1,
    id: 'workspace_desktop_agent',
    name: 'Desktop Agent Workspace',
    rootPath,
    template: 'standard',
    createdAt: '2026-06-28T00:00:00.000Z',
    updatedAt: '2026-06-28T00:00:00.000Z',
    connections: [],
    defaults: {
      agentMode: 'ask',
    },
    assetPaths: {
      sqlLibrary: 'sql/analytics',
      scripts: 'scripts',
      docs: 'docs',
      outputs: 'outputs',
    },
    python: {
      mode: 'system',
      requirementsPath: 'scripts/requirements.txt',
    },
    enabledSkills: [],
    enabledMcpServers: [],
    tags: [],
  };
}

async function scriptWorkspace(toolName: string): Promise<{ workspace: WorkspaceCore; rootPath: string }> {
  const rootPath = await mkdtemp(join(tmpdir(), 'dbagent-desktop-agent-script-workspace-'));
  tempDirs.push(rootPath);
  const workspace = new WorkspaceCore();
  await workspace.create({
    name: `Script Workspace ${toolName}`,
    rootPath,
  });
  await workspace.writeFile(rootPath, `scripts/${toolName}.py`, scriptToolContent(toolName));
  return { workspace, rootPath };
}

function scriptToolContent(toolName: string): string {
  return [
    '"""',
    `@tool ${toolName}`,
    `Run ${toolName} for analytics.`,
    '@param count: int order count',
    '@param region: str region code',
    '"""',
    'import json',
    'import sys',
    'payload = json.loads(sys.argv[1])',
    'print(payload)',
    '',
  ].join('\n');
}

function connectedConnection(): SavedConnection {
  return {
    id: 'conn_desktop',
    name: 'Analytics Warehouse',
    engine: 'postgres',
    host: 'db.example.com',
    port: 5432,
    database: 'analytics',
    username: 'analyst',
    ssl: true,
    readOnly: false,
    status: 'connected',
    createdAt: '2026-06-28T00:00:00.000Z',
    updatedAt: '2026-06-28T00:00:00.000Z',
  };
}

function fakeDriver(): IDatabaseDriver & {
  executed: Array<{ connectionId: string; database: string; sql: string }>;
} {
  const executed: Array<{ connectionId: string; database: string; sql: string }> = [];
  return {
    executed,
    capabilities: {
      engine: 'postgres',
      supportsTransactions: true,
      supportsExplain: true,
      supportsSchemas: true,
    },
    test() {
      return Promise.resolve(ok({ latencyMs: 5 }));
    },
    connect() {
      return Promise.resolve(ok(connectedConnection()));
    },
    disconnect() {
      return Promise.resolve(ok(undefined));
    },
    execute(request: QueryRequest, connection: SavedConnection): Promise<Result<QueryExecutionResult>> {
      executed.push({
        connectionId: request.connectionId,
        database: connection.database,
        sql: request.sql,
      });
      return Promise.resolve(
        ok({
          queryId: 'query_desktop_agent',
          columns: [{ name: 'order_count', dataType: 'int8' }],
          rows: [{ order_count: 42 }],
          rowCount: 1,
          elapsedMs: 9,
          safety: {
            statementKind: 'SELECT',
            riskLevel: 'safe',
            requiresConfirmation: false,
            blocked: false,
            reasons: [],
          },
        }),
      );
    },
    cancel(request: QueryCancelResponse) {
      return Promise.resolve(ok(request));
    },
    listTables(): Promise<Result<TableSummary[]>> {
      return Promise.resolve(ok([{ schema: 'public', name: 'orders', type: 'table' }]));
    },
    describeTable(): Promise<Result<TableDetail>> {
      return Promise.resolve(
        ok({
          schema: 'public',
          name: 'orders',
          type: 'table',
          primaryKey: ['id'],
          columns: [
            {
              name: 'id',
              ordinal: 1,
              dataType: 'uuid',
              nullable: false,
              isPrimaryKey: true,
            },
          ],
        }),
      );
    },
  };
}

function toolContext(): AgentToolContext {
  return {
    session: {
      id: 'session_desktop_agent_tools',
      title: 'desktop agent tools',
      mode: 'readonly',
      strategy: 'react',
      messages: [],
      tokenUsage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      },
      aborted: false,
    },
  };
}
