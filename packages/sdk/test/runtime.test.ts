import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { afterEach, describe, expect, it } from 'vitest';
import {
  DatabaseAgentRuntime,
  type AgentSession,
} from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

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
    // Database credentials remain writable by default; Agent read/edit/full
    // permission is enforced independently at the tool boundary.
    expect(connection.readOnly).toBe(false);
    expect(driver.lastConnectConfig?.readOnly).toBe(false);
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

  it('closes legacy and unified database resources idempotently', async () => {
    const driver = new FakeDatabaseDriver();
    const runtime = createRuntime(
      driver,
      new FakeProvider('{"sql":"select 1","explanation":"probe","assumptions":[]}'),
    );
    await runtime.connect(connectionInput());

    await runtime.close();
    await runtime.close();

    expect(runtime.status().connected).toBe(false);
    expect(driver.disconnectCount).toBe(1);
  });

  it('exposes one product-wide resource runtime through SDK and database access', () => {
    const runtime = createRuntime(
      new FakeDatabaseDriver(),
      new FakeProvider('{"sql":"select 1","explanation":"ok","assumptions":[]}'),
    );
    runtime.resources.upsertResource({
      id: 'resource-sdk-test',
      kind: 'database',
      nativeId: 'analytics',
      canonicalName: 'analytics',
      engine: 'mock',
      version: 1,
      firstSeenAt: '2026-07-23T00:00:00.000Z',
      updatedAt: '2026-07-23T00:00:00.000Z',
      sources: [
        {
          sourceId: 'sdk-test',
          sourceType: 'manual',
          observedAt: '2026-07-23T00:00:00.000Z',
        },
      ],
    });

    expect(runtime.resources).toBe(runtime.database.resources);
    expect(runtime.resources.query({ kinds: ['database'] }).items).toEqual([
      expect.objectContaining({ id: 'resource-sdk-test' }),
    ]);
    expect(runtime.resources.state('resource-sdk-test')).toMatchObject({
      status: 'unknown',
      freshness: 'unknown',
      lifecycle: 'active',
    });
  });

  it('builds the model catalog from metadata APIs without sending a chat request', async () => {
    let chatCalls = 0;
    const provider: LlmProvider = {
      id: 'ollama',
      name: 'Ollama',
      mode: 'private',
      capabilities: { chat: 'supported', streaming: 'supported', toolCalling: 'unknown' },
      chat() {
        chatCalls += 1;
        return Promise.resolve({ text: 'unexpected', toolCalls: [] });
      },
      listModels() {
        return Promise.resolve(['qwen2.5-coder:14b', 'embedding-model']);
      },
      getModelMetadata(model) {
        return Promise.resolve({
          model,
          source: 'provider-api',
          capabilities: { toolCalling: 'supported', reasoning: 'unsupported' },
          contextTokens: 32_768,
        });
      },
      isAvailable() {
        return Promise.resolve({ available: true });
      },
    };
    const runtime = new DatabaseAgentRuntime({ provider, model: 'qwen2.5-coder:14b' });

    const models = await runtime.discoverLlmModels();

    expect(chatCalls).toBe(0);
    expect(models).toHaveLength(2);
    expect(models.find((item) => item.model === 'qwen2.5-coder:14b')).toMatchObject({
      capabilities: { toolCalling: 'supported', reasoning: 'unsupported' },
      limits: { contextTokens: 32_768 },
      discovery: { source: 'provider-api' },
    });
  });

  it('runs the main multi-step AI SQL Agent with knowledge lookup, complex SQL, execution, and persisted session evidence', async () => {
    const driver = new FakeDatabaseDriver();
    const provider = new ScriptedAgentProvider([
      {
        text: '',
        toolCalls: [
          {
            id: 'tool-knowledge',
            name: 'knowledge_search',
            arguments: { query: 'orders amount users city', limit: 8 },
          },
        ],
      },
      {
        text: '',
        toolCalls: [
          {
            id: 'tool-query',
            name: 'sql_execute',
            arguments: {
              sql: `
                WITH ranked_orders AS (
                  SELECT
                    u.city,
                    o.amount,
                    row_number() OVER (
                      PARTITION BY u.city
                      ORDER BY o.amount DESC
                    ) AS amount_rank
                  FROM public.orders o
                  JOIN public.users u ON u.id = o.user_id
                )
                SELECT city, sum(amount) AS top_amount
                FROM ranked_orders
                WHERE amount_rank <= 3
                GROUP BY city
                ORDER BY top_amount DESC
              `,
              previewRows: 20,
            },
          },
        ],
      },
      {
        text: '上海前三笔订单合计金额为 188。',
        toolCalls: [],
      },
    ]);
    const directory = await mkdtemp(join(tmpdir(), 'dbagent-sdk-agent-'));
    tempDirs.push(directory);
    const runtime = new DatabaseAgentRuntime({
      driver,
      provider,
      model: 'test-model',
      sessionDatabasePath: join(directory, 'agent.db'),
      createConnectionId: () => 'connection-1',
      now: () => '2026-07-24T00:00:00.000Z',
    });
    await runtime.connect(connectionInput());
    await runtime.indexSchema();

    const output = await runtime.runAgent({
      userId: 'user-alice',
      message: '统计每个城市金额最高的三笔订单合计',
      mode: 'read',
    });

    expect(output.selectedSkill).toBe('query-and-answer');
    expect(output.result).toMatchObject({
      status: 'done',
      finalText: '上海前三笔订单合计金额为 188。',
      session: {
        userId: 'user-alice',
        mode: 'read',
      },
      toolExecutions: [
        { toolName: 'knowledge_search', status: 'success' },
        { toolName: 'sql_execute', status: 'success' },
      ],
    });
    expect(output.result.session.knowledgeSnapshot?.connectionId).toBe(
      'connection-1',
    );
    expect(
      output.result.session.knowledgeSnapshot?.knowledgeSnapshotId,
    ).toMatch(/^knowledge:/);
    expect(
      typeof output.result.session.knowledgeSnapshot?.catalogRootHash,
    ).toBe('string');
    expect(
      typeof output.result.session.knowledgeSnapshot?.indexVersion,
    ).toBe('string');
    expect(driver.executedSql[0]).toContain('row_number() OVER');
    expect(provider.requests).toHaveLength(3);
    await expect(runtime.sessions.load(output.result.session.id)).resolves.toMatchObject({
      id: output.result.session.id,
      userId: 'user-alice',
      knowledgeSnapshot: {
        catalogRootHash:
          output.result.session.knowledgeSnapshot?.catalogRootHash,
      },
    });
  });

  it('manually compacts a persisted Agent session and exposes its checkpoint history', async () => {
    const provider = new ScriptedAgentProvider([
      {
        text: [
          '## Goal',
          '持续分析订单。',
          '## Decisions and constraints',
          '保持只读，回答中保留精确 SQL。',
          '## Current state',
          '已完成前十轮分析。',
        ].join('\n'),
        toolCalls: [],
      },
    ]);
    const directory = await mkdtemp(
      join(tmpdir(), 'dbagent-sdk-manual-compact-'),
    );
    tempDirs.push(directory);
    const runtime = new DatabaseAgentRuntime({
      provider,
      model: 'test-model',
      sessionDatabasePath: join(directory, 'agent.db'),
      now: () => '2026-07-24T01:00:00.000Z',
    });
    const session: AgentSession = {
      id: 'session-manual-compact',
      title: '订单长期分析',
      userId: 'user-alice',
      mode: 'read',
      strategy: 'react',
      messages: Array.from({ length: 10 }, (_, index) => [
        {
          role: 'user' as const,
          content: `第 ${index + 1} 轮：分析订单指标`,
          createdAt: `2026-07-24T00:${String(index).padStart(2, '0')}:00.000Z`,
        },
        {
          role: 'assistant' as const,
          content: `第 ${index + 1} 轮结果已确认。`,
          createdAt: `2026-07-24T00:${String(index).padStart(2, '0')}:01.000Z`,
        },
      ]).flat(),
      tokenUsage: {
        promptTokens: 1_000,
        completionTokens: 200,
        totalTokens: 1_200,
      },
      aborted: false,
    };

    const compacted = await runtime.compactAgentSession({
      session,
      focus: '重点保留只读约束和已执行 SQL。',
    });

    expect(compacted.status).toBe('compacted');
    expect(compacted.checkpoint).toMatchObject({
      sequence: 1,
      trigger: 'manual',
      method: 'model',
      focus: '重点保留只读约束和已执行 SQL。',
    });
    expect(compacted.session.messages).toEqual(session.messages);
    const persisted = await runtime.sessions.load(session.id);
    expect(persisted?.contextCheckpoint?.sequence).toBe(1);
    expect(persisted?.contextCheckpoint?.summary).toContain('保持只读');
    expect(persisted?.messages).toEqual(session.messages);
    await expect(
      runtime.agentContextCheckpoints(session.id),
    ).resolves.toMatchObject([
      { sequence: 1, trigger: 'manual', method: 'model' },
    ]);
    expect(provider.requests[0]?.metadata).toMatchObject({
      purpose: 'context-compaction',
      trigger: 'manual',
    });
  });

  it('requests one-time approval when read mode attempts an edit and records the approval provenance', async () => {
    const driver = new FakeDatabaseDriver();
    const provider = new ScriptedAgentProvider([
      {
        text: '',
        toolCalls: [
          {
            id: 'tool-update',
            name: 'sql_execute',
            arguments: {
              sql: "UPDATE public.orders SET amount = 200 WHERE id = 42",
            },
          },
        ],
      },
      {
        text: '订单 42 已更新。',
        toolCalls: [],
      },
    ]);
    const approvalRequests: Array<{ mode: string; requiredPermission?: string }> = [];
    const directory = await mkdtemp(join(tmpdir(), 'dbagent-sdk-approval-'));
    tempDirs.push(directory);
    const runtime = new DatabaseAgentRuntime({
      driver,
      provider,
      model: 'test-model',
      sessionDatabasePath: join(directory, 'agent.db'),
      createConnectionId: () => 'connection-1',
      approvalProvider(request) {
        approvalRequests.push({
          mode: request.mode,
          ...(request.tool.requiredPermission === undefined
            ? {}
            : { requiredPermission: request.tool.requiredPermission }),
        });
        return {
          approved: true,
          requestId: 'dialog-1',
          approvedBy: 'user-alice',
          reason: '本次允许',
        };
      },
    });
    await runtime.connect(connectionInput());
    await runtime.indexSchema();

    const output = await runtime.runAgent({
      userId: 'user-alice',
      message: '更新订单 42 的金额为 200',
      mode: 'read',
    });

    expect(approvalRequests).toEqual([
      { mode: 'read', requiredPermission: 'edit' },
    ]);
    expect(output.selectedSkill).toBe('write-and-verify');
    expect(output.result.toolExecutions[0]).toMatchObject({
      toolName: 'sql_execute',
      status: 'success',
      approval: {
        requestId: 'dialog-1',
        approvedBy: 'user-alice',
        reason: '本次允许',
      },
    });
    expect(driver.executedSql).toEqual([
      "UPDATE public.orders SET amount = 200 WHERE id = 42",
    ]);
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

class ScriptedAgentProvider implements LlmProvider {
  readonly id = 'fake';
  readonly name = 'Scripted Agent Provider';
  readonly mode = 'byok' as const;
  readonly requests: LlmChatRequest[] = [];

  constructor(private readonly script: LlmChatResponse[]) {}

  chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    this.requests.push(structuredClone(request));
    const response = this.script.shift();
    if (!response) throw new Error('No scripted Agent response remains.');
    return Promise.resolve({
      ...response,
      usage: response.usage ?? {
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
      },
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
  disconnectCount = 0;
  throwOnExecute?: Error;
  private connection: SavedConnection | undefined;

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
    this.disconnectCount += 1;
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
