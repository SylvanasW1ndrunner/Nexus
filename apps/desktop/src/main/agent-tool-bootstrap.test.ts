import { describe, expect, it } from 'vitest';
import { ToolRegistry, type AgentToolContext } from '@dbagent/core-agent';
import type { IDatabaseDriver, TableSummary } from '@dbagent/core-db';
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
      return Promise.resolve(ok({
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
      }));
    },
    cancel(request: QueryCancelResponse) {
      return Promise.resolve(ok(request));
    },
    listTables(): Promise<Result<TableSummary[]>> {
      return Promise.resolve(ok([{ schema: 'public', name: 'orders', type: 'table' }]));
    },
    describeTable(): Promise<Result<TableDetail>> {
      return Promise.resolve(ok({
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
      }));
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
