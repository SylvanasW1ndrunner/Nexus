import type { DatabaseConnectionConfig, IDatabaseDriver, TableSummary } from '@dbagent/core-db';
import type {
  LlmChatRequest,
  LlmChatResponse,
  LlmProvider,
  LlmProviderAvailability,
} from '@dbagent/core-llm';
import {
  ok,
  type QueryCancelResponse,
  type QueryExecutionResult,
  type QueryRequest,
  type Result,
  type SavedConnection,
  type TableDetail,
} from '@dbagent/shared';
import { describe, expect, it } from 'vitest';
import { DatabaseAgentRuntime } from '../src/index.js';

describe('DatabaseAgentRuntime', () => {
  it('connects, indexes, generates a safe query, and executes only after an explicit call', async () => {
    const driver = new FakeDatabaseDriver();
    const provider = new FakeProvider(
      JSON.stringify({
        sql: `select u.city, sum(o.amount) as total_amount
from public.orders o
join public.users u on u.id = o.user_id
group by u.city
order by total_amount desc`,
        explanation: '关联用户与订单后按城市汇总。',
        assumptions: ['amount 已是统一币种'],
      }),
    );
    const runtime = createRuntime(driver, provider);

    const connection = await runtime.connect(connectionInput());
    expect(connection.readOnly).toBe(true);
    expect(driver.lastConnectConfig?.readOnly).toBe(true);
    expect(driver.lastConnectConfig?.connectionTimeoutMs).toBe(10_000);
    expect(driver.lastConnectConfig?.statementTimeoutMs).toBe(30_000);

    const index = await runtime.indexSchema();
    expect(index).toMatchObject({ ready: true, tableCount: 2, truncated: false });

    const generated = await runtime.generate({ question: '每个城市的订单金额是多少？' });
    expect(generated.status).toBe('awaiting_execution');
    expect(generated.safety.riskLevel).toBe('safe');
    expect(generated.evidence.some((item) => item.title.includes('orders'))).toBe(true);
    expect(driver.executedSql).toEqual([]);
    expect(provider.lastRequest?.messages.at(-1)?.content).toContain('public.orders');

    const executed = await runtime.executeGenerated(generated.runId);
    expect(executed.status).toBe('completed');
    expect(executed.execution.rows).toEqual([{ city: 'Shanghai', total_amount: 188 }]);
    expect(driver.executedSql).toHaveLength(1);

    await expect(runtime.executeGenerated(generated.runId)).rejects.toMatchObject({
      code: 'RUN_NOT_EXECUTABLE',
    });
  });

  it('blocks generated write SQL before the driver can execute it', async () => {
    const driver = new FakeDatabaseDriver();
    const runtime = createRuntime(
      driver,
      new FakeProvider(
        JSON.stringify({
          sql: 'delete from public.orders',
          explanation: '错误的写入建议',
          assumptions: [],
        }),
      ),
    );
    await runtime.connect(connectionInput());
    await runtime.indexSchema();

    const generated = await runtime.generate({ question: '删除所有订单' });
    expect(generated.status).toBe('blocked');
    expect(generated.safety.riskLevel).toBe('blocked');
    await expect(runtime.executeGenerated(generated.runId)).rejects.toMatchObject({
      code: 'RUN_NOT_EXECUTABLE',
    });
    expect(driver.executedSql).toEqual([]);
  });

  it.each([
    "select nextval('orders_id_seq')",
    'select * from public.orders for update',
    'select * into temporary copied_orders from public.orders',
  ])('blocks generated reads with database side effects: %s', async (sql) => {
    const driver = new FakeDatabaseDriver();
    const runtime = createRuntime(
      driver,
      new FakeProvider(JSON.stringify({ sql, explanation: '不安全查询', assumptions: [] })),
    );
    await runtime.connect(connectionInput());
    await runtime.indexSchema();

    const generated = await runtime.generate({ question: '执行一个有副作用的查询' });

    expect(generated).toMatchObject({ status: 'blocked', safety: { blocked: true } });
    expect(driver.executedSql).toEqual([]);
  });

  it('records a failed run when the database driver throws unexpectedly', async () => {
    const driver = new FakeDatabaseDriver();
    const runtime = createRuntime(
      driver,
      new FakeProvider('{"sql":"select 1","explanation":"探活","assumptions":[]}'),
    );
    await runtime.connect(connectionInput());
    await runtime.indexSchema();
    const generated = await runtime.generate({ question: '查询一条数据' });
    driver.throwOnExecute = new Error('socket closed');

    await expect(runtime.executeGenerated(generated.runId)).rejects.toMatchObject({
      code: 'QUERY_FAILED',
      message: 'socket closed',
    });
    expect(runtime.getRun(generated.runId)).toMatchObject({
      status: 'failed',
      error: { code: 'QUERY_FAILED', message: 'socket closed' },
    });
  });

  it('requires configuration, connection, and schema indexing in order', async () => {
    const runtime = new DatabaseAgentRuntime({
      driver: new FakeDatabaseDriver(),
      createConnectionId: () => 'connection-1',
      createRunId: () => 'run-1',
    });

    await expect(runtime.generate({ question: 'select one' })).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });

    runtime.configureProvider(new FakeProvider('{"sql":"select 1"}'), 'test-model');
    await runtime.connect(connectionInput());
    await expect(runtime.generate({ question: 'select one' })).rejects.toMatchObject({
      code: 'SCHEMA_NOT_INDEXED',
    });
  });

  it('returns a stable error when the model response cannot be parsed', async () => {
    const runtime = createRuntime(new FakeDatabaseDriver(), new FakeProvider('无法生成 SQL'));
    await runtime.connect(connectionInput());
    await runtime.indexSchema();

    await expect(runtime.generate({ question: '查询订单' })).rejects.toMatchObject({
      code: 'LLM_RESPONSE_INVALID',
      retryable: true,
    });
  });

  it('clears schema and pending runs when disconnecting', async () => {
    const runtime = createRuntime(
      new FakeDatabaseDriver(),
      new FakeProvider('{"sql":"select 1","explanation":"探活","assumptions":[]}'),
    );
    await runtime.connect(connectionInput());
    await runtime.indexSchema();
    const run = await runtime.generate({ question: '查询一条数据' });

    await runtime.disconnect();

    expect(runtime.schemaStatus().stage).toBe('not_connected');
    expect(runtime.getRun(run.runId)).toBeUndefined();
  });
});

function createRuntime(driver: FakeDatabaseDriver, provider: LlmProvider): DatabaseAgentRuntime {
  return new DatabaseAgentRuntime({
    driver,
    provider,
    model: 'test-model',
    createConnectionId: () => 'connection-1',
    createRunId: () => 'run-1',
    now: () => '2026-07-21T00:00:00.000Z',
  });
}

function connectionInput() {
  return {
    name: 'demo',
    host: '127.0.0.1',
    port: 5432,
    database: 'dbagent_demo',
    username: 'postgres',
    password: 'postgres',
  };
}

class FakeProvider implements LlmProvider {
  readonly id = 'fake';
  readonly name = 'Fake Provider';
  readonly mode = 'byok' as const;
  lastRequest?: LlmChatRequest;

  constructor(private readonly responseText: string) {}

  chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    this.lastRequest = request;
    return Promise.resolve({
      text: this.responseText,
      toolCalls: [],
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    });
  }

  isAvailable(): Promise<LlmProviderAvailability> {
    return Promise.resolve({ available: true });
  }
}

class FakeDatabaseDriver implements IDatabaseDriver {
  readonly capabilities = {
    engine: 'postgres' as const,
    supportsTransactions: true,
    supportsExplain: true,
    supportsSchemas: true,
  };
  lastConnectConfig?: DatabaseConnectionConfig;
  executedSql: string[] = [];
  throwOnExecute?: Error;
  private connection?: SavedConnection;

  test(): Promise<Result<{ latencyMs: number }>> {
    return Promise.resolve(ok({ latencyMs: 3 }));
  }

  connect(config: DatabaseConnectionConfig): Promise<Result<SavedConnection>> {
    this.lastConnectConfig = config;
    this.connection = {
      id: config.id!,
      name: config.name,
      engine: 'postgres',
      host: config.host,
      port: config.port,
      database: config.database,
      username: config.username,
      readOnly: config.readOnly,
      status: 'connected',
      createdAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
    };
    return Promise.resolve(ok(this.connection));
  }

  disconnect(): Promise<Result<void>> {
    this.connection = undefined;
    return Promise.resolve(ok(undefined));
  }

  execute(request: QueryRequest): Promise<Result<QueryExecutionResult>> {
    if (this.throwOnExecute) return Promise.reject(this.throwOnExecute);
    this.executedSql.push(request.sql);
    return Promise.resolve(
      ok({
        queryId: 'query-1',
        columns: [
          { name: 'city', dataType: 'text' },
          { name: 'total_amount', dataType: 'numeric' },
        ],
        rows: [{ city: 'Shanghai', total_amount: 188 }],
        rowCount: 1,
        returnedRowCount: 1,
        elapsedMs: 4,
        safety: {
          statementKind: 'SELECT',
          riskLevel: 'safe',
          requiresConfirmation: false,
          blocked: false,
          reasons: [],
        },
      }),
    );
  }

  cancel(request: QueryCancelResponse): Promise<Result<QueryCancelResponse>> {
    return Promise.resolve(ok(request));
  }

  listTables(): Promise<Result<TableSummary[]>> {
    return Promise.resolve(
      ok([
        { schema: 'public', name: 'users', type: 'table', comment: '用户及所在城市' },
        { schema: 'public', name: 'orders', type: 'table', comment: '订单金额' },
      ]),
    );
  }

  describeTable(
    _connectionId: string,
    schema: string,
    table: string,
  ): Promise<Result<TableDetail>> {
    if (table === 'users') {
      return Promise.resolve(
        ok({
          schema,
          name: table,
          type: 'table',
          comment: '用户及所在城市',
          primaryKey: ['id'],
          columns: [
            { name: 'id', ordinal: 1, dataType: 'integer', nullable: false, isPrimaryKey: true },
            { name: 'city', ordinal: 2, dataType: 'text', nullable: false, isPrimaryKey: false },
          ],
        }),
      );
    }
    return Promise.resolve(
      ok({
        schema,
        name: table,
        type: 'table',
        comment: '订单金额',
        primaryKey: ['id'],
        columns: [
          { name: 'id', ordinal: 1, dataType: 'integer', nullable: false, isPrimaryKey: true },
          {
            name: 'user_id',
            ordinal: 2,
            dataType: 'integer',
            nullable: false,
            isPrimaryKey: false,
            foreignKey: { schema: 'public', table: 'users', column: 'id' },
          },
          { name: 'amount', ordinal: 3, dataType: 'numeric', nullable: false, isPrimaryKey: false },
        ],
      }),
    );
  }
}
