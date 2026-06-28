import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ReactAgent, ToolRegistry, type AgentToolApproval } from '@dbagent/core-agent';
import { LlmRouter, type LlmChatResponse, type LlmProvider } from '@dbagent/core-llm';
import { UsageTracker } from '@dbagent/core-usage';
import { SchemaRagEngine } from '@dbagent/core-rag';
import type { DatabaseConnectionConfig, IDatabaseDriver } from '@dbagent/core-db';
import type {
  QueryExecutionResult,
  QueryRequest,
  Result,
  SavedConnection,
  TableDetail,
  TableSummary,
} from '@dbagent/shared';
import { err, ok } from '@dbagent/shared';
import { registerDatabaseTools } from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('registerDatabaseTools', () => {
  it('lets the agent inspect schema, query data, and answer a user question', async () => {
    const registry = new ToolRegistry();
    const driver = fakeDriver();
    const rag = indexedRag();
    registerDatabaseTools({
      registry,
      driver,
      rag,
      getConnection: (connectionId) => (connectionId === 'conn_1' ? savedConnection() : undefined),
    });
    const usage = new UsageTracker(await usagePath());
    const agent = new ReactAgent(
      new LlmRouter(usage, [
        scriptedProvider([
          responseWithTool('call_schema', 'search_schema', {
            connectionId: 'conn_1',
            query: '订单金额',
            limit: 3,
          }),
          responseWithTool('call_query', 'query_database', {
            connectionId: 'conn_1',
            sql: 'select count(*) as order_count from orders',
            limit: 100,
          }),
          { text: '订单总数是 42，金额字段是 orders.total_amount。', toolCalls: [] },
        ]),
      ]),
      registry,
      usage,
      undefined,
      fixedDependencies(),
    );

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: '订单总数是多少，金额字段在哪里？',
      mode: 'readonly',
      maxIterations: 3,
    });

    expect(result.status).toBe('done');
    expect(result.finalText).toBe('订单总数是 42，金额字段是 orders.total_amount。');
    expect(result.toolExecutions).toMatchObject([
      { toolName: 'search_schema', status: 'success' },
      { toolName: 'query_database', status: 'success' },
    ]);
    expect(driver.executedSql).toEqual(['select count(*) as order_count from orders']);
  });

  it('provides list and describe tools for schema exploration', async () => {
    const registry = new ToolRegistry();
    registerDatabaseTools({
      registry,
      driver: fakeDriver(),
      getConnection: () => savedConnection(),
    });

    await expect(registry.get('list_schemas')?.handler({ connectionId: 'conn_1' }, toolContext())).resolves.toEqual({
      schemas: [{ schema: 'analytics' }, { schema: 'public' }],
    });
    await expect(
      registry.get('list_tables')?.handler({ connectionId: 'conn_1', schema: 'public' }, toolContext()),
    ).resolves.toEqual({
      tables: [{ schema: 'public', name: 'orders', type: 'table', comment: '订单事实表' }],
    });
    await expect(
      registry
        .get('describe_table')
        ?.handler({ connectionId: 'conn_1', schema: 'public', table: 'orders' }, toolContext()),
    ).resolves.toMatchObject({
      schema: 'public',
      name: 'orders',
      columns: expect.arrayContaining([expect.objectContaining({ name: 'total_amount' })]),
    });
  });

  it('composes database and RAG tools without duplicate tool names', async () => {
    const registry = new ToolRegistry();
    registerDatabaseTools({
      registry,
      driver: fakeDriver(),
      rag: indexedRag(),
      getConnection: () => savedConnection(),
    });

    const names = registry.llmTools().map((tool) => tool.name);
    expect(names).toEqual([...new Set(names)]);
    expect(names).toEqual([
      'list_schemas',
      'list_tables',
      'describe_table',
      'audit_sql',
      'query_database',
      'execute_sql',
      'search_schema',
      'get_relations',
      'build_schema_context',
    ]);
    await expect(
      Promise.resolve().then(() =>
        registry
          .get('get_relations')
          ?.handler({ connectionId: 'conn_1', schema: 'public', table: 'orders' }, toolContext()),
      ),
    ).resolves.toMatchObject({
      table: { id: 'table:public.orders' },
    });
    await expect(
      Promise.resolve().then(() =>
        registry.get('build_schema_context')?.handler({ connectionId: 'conn_1', query: 'orders' }, toolContext()),
      ),
    ).resolves.toMatchObject({
      query: 'orders',
    });
  });

  it('blocks write SQL in readonly agent mode before the driver executes it', async () => {
    const registry = new ToolRegistry();
    const driver = fakeDriver();
    registerDatabaseTools({
      registry,
      driver,
      getConnection: () => savedConnection(),
    });
    const usage = new UsageTracker(await usagePath());
    const agent = new ReactAgent(
      new LlmRouter(usage, [
        scriptedProvider([
          responseWithTool('call_delete', 'execute_sql', {
            connectionId: 'conn_1',
            sql: 'delete from orders',
            confirmed: true,
          }),
        ]),
      ]),
      registry,
      usage,
      undefined,
      fixedDependencies(),
    );

    const result = await agent.run({
      providerId: 'fake',
      model: 'fake-model',
      userMessage: '删除订单',
      mode: 'readonly',
    });

    expect(result.status).toBe('permission_denied');
    expect(driver.executedSql).toEqual([]);
  });

  it('lets the agent audit SQL before execution', async () => {
    const registry = new ToolRegistry();
    registerDatabaseTools({
      registry,
      driver: fakeDriver(),
      getConnection: () => writableConnection(),
    });

    await expect(
      registry.get('audit_sql')?.handler(
        {
          connectionId: 'conn_1',
          sql: 'delete from orders',
        },
        toolContext(),
      ),
    ).resolves.toMatchObject({
      statementKind: 'DELETE',
      riskLevel: 'dangerous',
      requiresConfirmation: true,
    });
  });

  it('rejects write SQL passed through the readonly query tool even on writable connections', async () => {
    const registry = new ToolRegistry();
    const driver = fakeDriver();
    registerDatabaseTools({
      registry,
      driver,
      getConnection: () => writableConnection(),
    });

    await expect(
      registry.get('query_database')?.handler(
        {
          connectionId: 'conn_1',
          sql: 'delete from orders where id = 1',
        },
        toolContext(),
      ),
    ).rejects.toThrow('query_database only accepts readonly single-statement SQL');
    expect(driver.executedSql).toEqual([]);
  });

  it('requires explicit confirmation before execute_sql reaches the driver', async () => {
    const registry = new ToolRegistry();
    const driver = fakeDriver();
    registerDatabaseTools({
      registry,
      driver,
      getConnection: () => writableConnection(),
    });

    await expect(
      registry.get('execute_sql')?.handler(
        {
          connectionId: 'conn_1',
          sql: "update orders set status = 'paid'",
          confirmed: false,
        },
        toolContext(),
      ),
    ).rejects.toThrow('SQL requires explicit confirmation');
    expect(driver.executedSql).toEqual([]);
  });

  it('rejects model-provided confirmation without an approval context', async () => {
    const registry = new ToolRegistry();
    const driver = fakeDriver();
    registerDatabaseTools({
      registry,
      driver,
      getConnection: () => writableConnection(),
    });

    await expect(
      registry.get('execute_sql')?.handler(
        {
          connectionId: 'conn_1',
          sql: "update orders set status = 'paid'",
          confirmed: true,
        },
        toolContext(),
      ),
    ).rejects.toThrow('SQL requires explicit confirmation');
    expect(driver.executedSql).toEqual([]);
  });

  it('executes confirmed SQL only when the tool context carries approval provenance', async () => {
    const registry = new ToolRegistry();
    const driver = fakeDriver();
    registerDatabaseTools({
      registry,
      driver,
      getConnection: () => writableConnection(),
    });

    await expect(
      registry.get('execute_sql')?.handler(
        {
          connectionId: 'conn_1',
          sql: "update orders set status = 'paid'",
          confirmed: true,
        },
        toolContext({
          granted: true,
          source: 'approval-provider',
          toolCallId: 'call_write',
          toolName: 'execute_sql',
          approvedAt: '2026-06-24T00:00:00.000Z',
        }),
      ),
    ).resolves.toMatchObject({
      rowCount: 1,
    });
    expect(driver.executedSql).toEqual(["update orders set status = 'paid'"]);
  });

  it('returns a clear error when the active connection is missing', async () => {
    const registry = new ToolRegistry();
    registerDatabaseTools({
      registry,
      driver: fakeDriver(),
      getConnection: () => undefined,
    });

    await expect(
      registry.get('query_database')?.handler(
        {
          connectionId: 'missing',
          sql: 'select 1',
        },
        toolContext(),
      ),
    ).rejects.toThrow('Connection is not active: missing');
  });
});

function fakeDriver(): IDatabaseDriver & { executedSql: string[] } {
  const executedSql: string[] = [];
  return {
    executedSql,
    capabilities: {
      engine: 'postgres',
      supportsTransactions: true,
      supportsExplain: true,
      supportsSchemas: true,
    },
    async test(_config: DatabaseConnectionConfig) {
      return ok({ latencyMs: 3 });
    },
    async connect() {
      return ok(savedConnection());
    },
    async disconnect() {
      return ok(undefined);
    },
    async execute(request: QueryRequest): Promise<Result<QueryExecutionResult>> {
      executedSql.push(request.sql);
      if (/delete/i.test(request.sql) && !request.confirmed) {
        return err({
          code: 'CONFIRMATION_REQUIRED',
          message: 'Confirmation required.',
        });
      }
      return ok({
        queryId: 'query_1',
        columns: [{ name: 'order_count', dataType: 'int8' }],
        rows: [{ order_count: 42 }],
        rowCount: 1,
        elapsedMs: 12,
        safety: {
          statementKind: 'select',
          riskLevel: 'safe',
          requiresConfirmation: false,
          blocked: false,
          reasons: [],
        },
      });
    },
    async listTables(): Promise<Result<TableSummary[]>> {
      return ok([
        { schema: 'public', name: 'orders', type: 'table', comment: '订单事实表' },
        { schema: 'analytics', name: 'daily_orders', type: 'view' },
      ]);
    },
    async describeTable(): Promise<Result<TableDetail>> {
      return ok(orderTable());
    },
  };
}

function indexedRag(): SchemaRagEngine {
  const rag = new SchemaRagEngine();
  rag.index({ connectionId: 'conn_1', tables: [orderTable()] });
  return rag;
}

function orderTable(): TableDetail {
  return {
    schema: 'public',
    name: 'orders',
    type: 'table',
    comment: '订单事实表，保存订单金额',
    primaryKey: ['id'],
    columns: [
      { name: 'id', ordinal: 1, dataType: 'uuid', nullable: false, isPrimaryKey: true, comment: '订单 ID' },
      {
        name: 'total_amount',
        ordinal: 2,
        dataType: 'numeric',
        nullable: false,
        isPrimaryKey: false,
        comment: '订单金额',
      },
    ],
  };
}

function savedConnection(): SavedConnection {
  return {
    id: 'conn_1',
    name: 'Local PG',
    engine: 'postgres',
    host: 'localhost',
    port: 5432,
    database: 'dbagent',
    username: 'tester',
    readOnly: true,
    status: 'connected',
    createdAt: '2026-06-17T00:00:00.000Z',
    updatedAt: '2026-06-17T00:00:00.000Z',
  };
}

function writableConnection(): SavedConnection {
  return {
    ...savedConnection(),
    readOnly: false,
  };
}

function scriptedProvider(script: LlmChatResponse[]): LlmProvider {
  return {
    id: 'fake',
    name: 'Fake Provider',
    mode: 'byok',
    async chat() {
      const next = script.shift();
      if (!next) throw new Error('No scripted response left.');
      return next;
    },
    async isAvailable() {
      return { available: true };
    },
  };
}

function responseWithTool(id: string, name: string, args: Record<string, unknown>): LlmChatResponse {
  return {
    text: '',
    toolCalls: [{ id, name, arguments: args }],
  };
}

async function usagePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-tools-'));
  tempDirs.push(dir);
  return join(dir, 'usage-history.json');
}

function fixedDependencies() {
  return {
    now: () => '2026-06-17T00:00:00.000Z',
    createSessionId: () => 'session_tools',
  };
}

function toolContext(approval?: AgentToolApproval) {
  return {
    session: {
      id: 'session_tools',
      title: 'tools',
      mode: 'readonly' as const,
      strategy: 'react' as const,
      messages: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      aborted: false,
    },
    ...(approval === undefined ? {} : { approval }),
  };
}
