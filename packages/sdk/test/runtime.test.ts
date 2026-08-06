import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DatabaseAccessRuntime,
  type DatabaseConnectionConfig,
  type IDatabaseDriver,
  type TableSummary,
} from '@dbagent/core-db';
import {
  LlmGateway,
  type LlmChatRequest,
  type LlmChatResponse,
  type LlmChatStreamEvent,
  type LlmProvider,
  type LlmProviderAvailability,
} from '@dbagent/core-llm';
import {
  agentProjectReference,
  createAgentProjectContext,
  type AgentRunRecord,
  type AgentRunStore,
} from '@dbagent/core-agent';
import {
  ok,
  type ConnectionProfile,
  type QueryCancelResponse,
  type QueryExecutionResult,
  type QueryJob,
  type QueryRequest,
  type Result,
  type ResultBatch,
  type ResourceDescriptor,
  type ResourceDiscoveryPage,
  type ResourceRelation,
  type SavedConnection,
  type TableDetail,
} from '@dbagent/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseAgentRuntime, toAgentSessionView, type AgentSession } from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('DatabaseAgentRuntime', () => {
  it('uses an explicit canonical model identity for a custom endpoint without inventing limits', async () => {
    const runtime = new DatabaseAgentRuntime({
      provider: new ScriptedAgentProvider([]),
      model: 'proxy-model-name',
      canonicalModel: 'openai/gpt-4o',
      sessionDatabasePath: ':memory:',
    });

    expect(runtime.llmModels()).toMatchObject([
      {
        model: 'proxy-model-name',
        canonicalModel: 'openai/gpt-4o',
        limits: { contextTokens: 128_000, maxInputTokens: null, maxOutputTokens: 16_384 },
        discovery: { source: 'models-dev' },
      },
    ]);
    await runtime.close();
  });

  it('merges one runtime generation config with per-run overrides', async () => {
    const provider = new ScriptedAgentProvider([
      { text: 'Configuration applied.', toolCalls: [] },
    ]);
    const runtime = new DatabaseAgentRuntime({
      provider,
      model: 'test-model',
      sessionDatabasePath: ':memory:',
      generation: {
        temperature: 0.2,
        topP: 0.9,
        maxOutputTokens: 1_500,
      },
    });

    await runtime.runAgent({
      message: 'Confirm the active configuration.',
      generation: { temperature: 0.4 },
    });

    expect(provider.requests[0]).toMatchObject({
      temperature: 0.4,
      topP: 0.9,
      maxTokens: 1_500,
    });
    await runtime.close();
  });

  it('projects task plans as user-facing progress without internal criteria, dependencies, or evidence', () => {
    const view = toAgentSessionView({
      id: 'session-plan-view',
      title: 'Plan view',
      mode: 'read',
      messages: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      taskPlan: {
        version: 1,
        goal: '完成查询',
        tasks: [
          {
            id: 'query',
            title: '执行查询',
            description: '生成并运行 SQL',
            status: 'in_progress',
            acceptanceCriteria: ['数据库返回结果'],
            dependsOn: ['discover'],
            evidence: [
              {
                kind: 'database-result',
                summary: 'internal runtime evidence',
                reference: 'result-handle-must-not-leak',
                createdAt: '2026-07-31T00:00:00.000Z',
              },
            ],
            createdAt: '2026-07-31T00:00:00.000Z',
            updatedAt: '2026-07-31T00:00:01.000Z',
          },
        ],
        createdAt: '2026-07-31T00:00:00.000Z',
        updatedAt: '2026-07-31T00:00:01.000Z',
      },
      aborted: false,
    });

    expect(view.taskPlan).toEqual({
      goal: '完成查询',
      tasks: [
        {
          id: 'query',
          title: '执行查询',
          description: '生成并运行 SQL',
          status: 'in_progress',
        },
      ],
    });
    expect(JSON.stringify(view.taskPlan)).not.toMatch(
      /acceptanceCriteria|dependsOn|evidence|result-handle/,
    );
  });

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
  ])('blocks generated reads with database side effects: %s', async (sql: string) => {
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
      sessionDatabasePath: ':memory:',
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

  it('clears schema but preserves reviewed runs when disconnecting', async () => {
    const runtime = createRuntime(
      new FakeDatabaseDriver(),
      new FakeProvider('{"sql":"select 1","explanation":"探活","assumptions":[]}'),
    );
    await runtime.connect(connectionInput());
    await runtime.indexSchema();
    const run = await runtime.generate({ question: '查询一条数据' });

    await runtime.disconnect();

    expect(runtime.schemaStatus().stage).toBe('not_connected');
    expect(runtime.getRun(run.runId)).toMatchObject({
      runId: run.runId,
      connectionId: 'connection-1',
      status: 'awaiting_execution',
    });
  });

  it('restores reviewed SQL runs after restart and binds execution to the original connection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'schemanaut-sdk-sql-run-restart-'));
    tempDirs.push(directory);
    const options = {
      driver: new FakeDatabaseDriver(),
      provider: new FakeProvider(
        '{"sql":"select count(*) from public.orders","explanation":"count","assumptions":[]}',
      ),
      model: 'test-model',
      projectDirectory: directory,
      sessionDatabasePath: join(directory, 'agent.db'),
      createRunId: () => 'durable-run',
    };
    const runtimeA = new DatabaseAgentRuntime(options);
    await runtimeA.connect({ ...connectionInput(), id: 'connection-a' });
    await runtimeA.indexSchema();
    const generated = await runtimeA.generate({ question: 'Count orders' });
    await runtimeA.close();

    const runtimeB = new DatabaseAgentRuntime({
      ...options,
      driver: new FakeDatabaseDriver(),
    });
    expect(runtimeB.getRun(generated.runId)).toMatchObject({
      status: 'awaiting_execution',
      connectionId: 'connection-a',
    });
    await runtimeB.connect({ ...connectionInput(), id: 'connection-b' });
    await expect(runtimeB.executeGenerated(generated.runId)).rejects.toMatchObject({
      code: 'RUN_NOT_EXECUTABLE',
    });
    await runtimeB.disconnect();
    await runtimeB.connect({ ...connectionInput(), id: 'connection-a' });
    await expect(runtimeB.executeGenerated(generated.runId)).resolves.toMatchObject({
      status: 'completed',
      connectionId: 'connection-a',
      executionResultAvailable: true,
    });
    await runtimeB.close();

    const runtimeC = new DatabaseAgentRuntime({
      ...options,
      driver: new FakeDatabaseDriver(),
    });
    expect(runtimeC.getRun(generated.runId)).toMatchObject({
      status: 'completed',
      executionResultAvailable: false,
      execution: { rows: [], returnedRowCount: 1 },
    });
    await runtimeC.connect({ ...connectionInput(), id: 'connection-b' });
    await expect(runtimeC.reexecuteGenerated(generated.runId)).rejects.toMatchObject({
      code: 'RUN_NOT_EXECUTABLE',
    });
    expect(runtimeC.getRun(generated.runId)).toMatchObject({
      status: 'completed',
      connectionId: 'connection-a',
      executionResultAvailable: false,
    });
    await runtimeC.disconnect();
    await runtimeC.connect({ ...connectionInput(), id: 'connection-a' });
    await expect(runtimeC.reexecuteGenerated(generated.runId)).resolves.toMatchObject({
      status: 'completed',
      executionResultAvailable: true,
      execution: { rows: [{ city: 'Shanghai', total_amount: 188 }] },
    });
    await runtimeC.close();
  });

  it('restores an explicitly persisted Schema RAG snapshot after a runtime restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'schemanaut-sdk-rag-snapshot-'));
    tempDirs.push(directory);
    const runtimeOptions = {
      driver: new FakeDatabaseDriver(),
      provider: new FakeProvider(
        '{"sql":"select 1","explanation":"restored schema","assumptions":[]}',
      ),
      model: 'test-model',
      projectDirectory: directory,
      sessionDatabasePath: join(directory, 'agent.db'),
      schemaSnapshotDirectory: join(directory, 'schema-rag'),
      createConnectionId: () => 'stable-connection',
    };
    const runtime = new DatabaseAgentRuntime(runtimeOptions);
    await runtime.connect({ ...connectionInput(), id: 'stable-connection' });
    const indexed = await runtime.indexSchema({ maxTables: 1 });
    await runtime.close();

    const restoredRuntime = new DatabaseAgentRuntime({
      ...runtimeOptions,
      driver: new FakeDatabaseDriver(),
    });
    await restoredRuntime.connect({ ...connectionInput(), id: 'stable-connection' });

    expect(indexed).toMatchObject({ ready: true, tableCount: 1, truncated: true });
    expect(restoredRuntime.schemaStatus()).toMatchObject({
      ready: true,
      tableCount: 1,
      truncated: true,
      connectionId: 'stable-connection',
    });
    await restoredRuntime.close();
  });

  it('rejects a blank Schema RAG snapshot directory instead of writing into the Project root', () => {
    expect(
      () =>
        new DatabaseAgentRuntime({
          driver: new FakeDatabaseDriver(),
          projectDirectory: process.cwd(),
          sessionDatabasePath: ':memory:',
          schemaSnapshotDirectory: '   ',
        }),
    ).toThrow('schemaSnapshotDirectory must not be blank');
  });

  it('does not restore a Schema RAG snapshot created by another tenant in the same Project', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'schemanaut-sdk-rag-tenant-scope-'));
    tempDirs.push(directory);
    const sharedOptions = {
      projectDirectory: directory,
      sessionDatabasePath: ':memory:',
      schemaSnapshotDirectory: join(directory, 'schema-rag'),
      createConnectionId: () => 'shared-connection-id',
    };
    const tenantA = new DatabaseAgentRuntime({
      ...sharedOptions,
      tenantId: 'tenant-a',
      driver: new FakeDatabaseDriver(),
    });
    await tenantA.connect({ ...connectionInput(), id: 'shared-connection-id' });
    await tenantA.indexSchema();
    await tenantA.close();

    const tenantB = new DatabaseAgentRuntime({
      ...sharedOptions,
      tenantId: 'tenant-b',
      driver: new FakeDatabaseDriver(),
    });
    await tenantB.connect({ ...connectionInput(), id: 'shared-connection-id' });

    expect(tenantB.schemaStatus()).toMatchObject({
      ready: false,
      stage: 'not_indexed',
      connectionId: 'shared-connection-id',
    });
    await tenantB.close();
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

  it('rejects unsupported PostgreSQL TLS modes at the JavaScript boundary', async () => {
    const runtime = new DatabaseAgentRuntime({
      driver: new FakeDatabaseDriver(),
      sessionDatabasePath: ':memory:',
    });

    await expect(
      runtime.connect({
        ...connectionInput(),
        ssl: 'prefer' as never,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await runtime.close();
  });

  it('aborts active Agent runs before waiting for runtime shutdown', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'schemanaut-sdk-close-agent-'));
    tempDirs.push(directory);
    const provider = new SlowAbortAwareProvider();
    const runtime = new DatabaseAgentRuntime({
      driver: new FakeDatabaseDriver(),
      provider,
      model: 'test-model',
      projectDirectory: directory,
      sessionDatabasePath: join(directory, 'agent.db'),
      createConnectionId: () => 'connection-1',
    });
    await runtime.connect(connectionInput());
    await runtime.indexSchema();

    const run = runtime
      .runAgent({ message: 'Keep working until shutdown.' })
      .catch((error: unknown) => error);
    await provider.started;
    await runtime.close();
    await run;

    expect(provider.signal).toBeDefined();
    expect(provider.signal?.aborted).toBe(true);
  });

  it('aborts and waits for active direct LLM calls during runtime shutdown', async () => {
    const provider = new SlowAbortAwareProvider();
    const runtime = new DatabaseAgentRuntime({
      provider,
      model: 'test-model',
      sessionDatabasePath: ':memory:',
    });
    const call = runtime
      .llmChat({ messages: [{ role: 'user', content: 'Keep this request open.' }] })
      .catch((error: unknown) => error);
    await provider.started;

    await runtime.close();
    await call;

    expect(provider.signal).toBeDefined();
    expect(provider.signal?.aborted).toBe(true);
  });

  it('cancels and waits for active LLM batch jobs during runtime shutdown', async () => {
    const provider = new SlowAbortAwareProvider();
    const runtime = new DatabaseAgentRuntime({
      provider,
      model: 'test-model',
      sessionDatabasePath: ':memory:',
    });
    const job = runtime.submitLlmBatch([
      { messages: [{ role: 'user', content: 'Keep this batch open.' }] },
    ]);
    await provider.started;

    await runtime.close();

    expect(provider.signal).toBeDefined();
    expect(provider.signal?.aborted).toBe(true);
    expect(runtime.getLlmJob(job.id)).toMatchObject({
      status: 'cancelled',
      cancelled: 1,
    });
  });

  it('isolates shared-gateway batch jobs and closes only jobs owned by this runtime', async () => {
    const gateway = new LlmGateway();
    const provider = new SlowAbortAwareProvider();
    const tenantA = new DatabaseAgentRuntime({
      gateway,
      provider,
      model: 'test-model',
      tenantId: 'tenant-a',
      sessionDatabasePath: ':memory:',
    });
    const tenantB = new DatabaseAgentRuntime({
      gateway,
      provider,
      model: 'test-model',
      tenantId: 'tenant-b',
      sessionDatabasePath: ':memory:',
    });

    try {
      const tenantBJob = tenantB.submitLlmBatch([
        { messages: [{ role: 'user', content: 'tenant-b-confidential-result' }] },
      ]);
      await provider.started;

      expect(tenantA.getLlmJob(tenantBJob.id)).toBeUndefined();
      expect(tenantA.cancelLlmJob(tenantBJob.id)).toBeUndefined();
      await tenantA.close();

      expect(provider.signal?.aborted).toBe(false);
      expect(tenantB.getLlmJob(tenantBJob.id)?.status).toBe('running');
    } finally {
      await Promise.allSettled([tenantA.close(), tenantB.close()]);
    }

    expect(provider.signal?.aborted).toBe(true);
  });

  it('aborts and closes a paused direct LLM stream during runtime shutdown', async () => {
    const provider = new SlowAbortAwareStreamProvider();
    const runtime = new DatabaseAgentRuntime({
      provider,
      model: 'test-model',
      sessionDatabasePath: ':memory:',
    });
    const stream = runtime.llmStream({
      messages: [{ role: 'user', content: 'Stream until shutdown.' }],
    });
    const iterator = stream[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'text-delta', text: 'working' },
    });
    await runtime.close();

    expect(provider.signal?.aborted).toBe(true);
    expect(provider.closed).toBe(true);
  });

  it('uses an injected DatabaseAccessRuntime for connect, discovery, and query execution', async () => {
    const database = new DatabaseAccessRuntime();
    const driver = new FakeDatabaseDriver();
    const databaseResource: ResourceDescriptor = {
      id: 'resource-database',
      kind: 'database',
      nativeId: 'demo',
      canonicalName: 'demo',
      version: 1,
      firstSeenAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
      sources: [
        {
          sourceId: 'injected-discovery',
          sourceType: 'connector',
          connectorId: 'postgres-native',
          observedAt: '2026-07-21T00:00:00.000Z',
        },
      ],
    };
    const tableResource: ResourceDescriptor = {
      id: 'resource-table-orders',
      kind: 'table',
      nativeId: 'public.orders',
      canonicalName: 'orders',
      attributes: { schema: 'public' },
      version: 1,
      firstSeenAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
      sources: [
        {
          sourceId: 'injected-discovery',
          sourceType: 'connector',
          connectorId: 'postgres-native',
          observedAt: '2026-07-21T00:00:00.000Z',
        },
      ],
    };
    const containsTable: ResourceRelation = {
      id: 'relation-database-orders',
      kind: 'contains',
      fromResourceId: databaseResource.id,
      toResourceId: tableResource.id,
      version: 1,
      firstSeenAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
      sources: [
        {
          sourceId: 'injected-discovery',
          sourceType: 'connector',
          connectorId: 'postgres-native',
          observedAt: '2026-07-21T00:00:00.000Z',
        },
      ],
    };
    const createProfile = vi
      .spyOn(database, 'createProfile')
      .mockImplementation((profile: ConnectionProfile) => structuredClone(profile));
    const connect = vi.spyOn(database, 'connect').mockResolvedValue({
      id: 'injected-session',
      connectionId: 'injected-connection',
      profileId: 'connection-1',
      connectorId: 'postgres-native',
      status: 'connected',
      endpointIndex: 0,
      connectedAt: '2026-07-21T00:00:00.000Z',
      generation: 1,
    });
    const disconnect = vi.spyOn(database, 'disconnect').mockResolvedValue();
    vi.spyOn(database, 'deleteProfile').mockReturnValue(true);
    const discoverPage = vi.spyOn(database, 'discoverPage').mockResolvedValue({
      resources: [databaseResource],
      relations: [],
      complete: true,
      snapshotId: 'injected-revision-1',
    });
    const queryJob: QueryJob = {
      id: 'injected-job',
      profileId: 'connection-1',
      connectorId: 'postgres-native',
      state: 'succeeded',
      submittedAt: '2026-07-21T00:00:00.000Z',
      completedAt: '2026-07-21T00:00:00.010Z',
      result: {
        id: 'injected-result',
        jobId: 'injected-job',
        format: 'rows',
        columns: [{ name: 'value', dataType: 'integer' }],
        rowCount: 1,
      },
    };
    const submit = vi.spyOn(database, 'submit').mockResolvedValue(queryJob);
    vi.spyOn(database, 'streamResult').mockImplementation(
      () =>
        ({
          async *[Symbol.asyncIterator](): AsyncIterator<ResultBatch> {
            await Promise.resolve();
            yield {
              handleId: 'injected-result',
              rows: [{ value: 1 }],
              rowOffset: 0,
              complete: true,
            };
          },
        }) as AsyncIterable<ResultBatch>,
    );
    const directory = await mkdtemp(join(tmpdir(), 'schemanaut-sdk-injected-database-'));
    tempDirs.push(directory);
    let nowTick = 0;
    let runTick = 0;
    const runtime = new DatabaseAgentRuntime({
      databaseAccess: database,
      driver,
      provider: new FakeProvider(
        '{"sql":"select 1 as value","explanation":"probe","assumptions":[]}',
      ),
      model: 'test-model',
      tenantId: 'tenant-injected',
      projectDirectory: directory,
      sessionDatabasePath: join(directory, 'agent.db'),
      createConnectionId: () => 'connection-1',
      createRunId: () => `run-${++runTick}`,
      now: () => new Date(Date.parse('2026-07-21T00:00:00.000Z') + nowTick++ * 1_000).toISOString(),
      schemaFreshnessIntervalMs: 0,
    });

    const connection = await runtime.connect(connectionInput());
    const index = await runtime.indexSchema({ maxTables: 7 });
    const refreshedDiscovery: ResourceDiscoveryPage = {
      resources: [databaseResource, tableResource],
      relations: [containsTable],
      complete: true,
      snapshotId: 'injected-revision-2',
    };
    let releaseBackgroundRefresh:
      | ((value: typeof refreshedDiscovery) => void)
      | undefined;
    discoverPage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseBackgroundRefresh = resolve;
        }),
    );
    await runtime.runAgent({ message: 'Return one.', mode: 'read' });
    const cachedIndex = runtime.schemaStatus();
    expect(discoverPage).toHaveBeenCalledTimes(2);
    const toolSession: AgentSession = {
      id: 'schema-refresh-session',
      title: 'Schema refresh',
      mode: 'read',
      messages: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      aborted: false,
    };
    const refreshedResource = expect(
      runtime.tools
        .get('resource_get')!
        .handler({ resource: 'orders' }, { session: toolSession }),
    ).resolves.toBeDefined();
    releaseBackgroundRefresh?.(refreshedDiscovery);
    await refreshedResource;
    const refreshedIndex = runtime.schemaStatus();
    discoverPage.mockResolvedValue(refreshedDiscovery);
    const generated = await runtime.generate({ question: 'Return one.' });
    const executed = await runtime.executeGenerated(generated.runId);
    await runtime.disconnect();
    await runtime.close();

    expect(connection.id).toBe('injected-connection');
    expect(index).toMatchObject({ ready: true, tableCount: 0 });
    expect(cachedIndex).toMatchObject({ ready: true, tableCount: 0 });
    expect(refreshedIndex).toMatchObject({ ready: true, tableCount: 1, truncated: false });
    expect(executed.execution.rows).toEqual([{ value: 1 }]);
    expect(createProfile).toHaveBeenCalledTimes(1);
    const createdProfile = createProfile.mock.calls[0]?.[0];
    expect(createdProfile?.scope?.tenantId).toBe('tenant-injected');
    expect(createdProfile?.scope?.projectId).toMatch(/^project:/);
    expect(connect).toHaveBeenCalledWith('connection-1', {
      username: 'postgres',
      password: 'postgres',
    });
    expect(discoverPage).toHaveBeenCalled();
    expect(discoverPage).toHaveBeenCalledTimes(3);
    expect(submit).toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledWith('connection-1');
    expect(driver.lastConnectConfig).toBeUndefined();
    expect(driver.executedSql).toEqual([]);
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
    const runtime = new DatabaseAgentRuntime({
      provider,
      model: 'qwen2.5-coder:14b',
      sessionDatabasePath: ':memory:',
    });

    const models = await runtime.discoverLlmModels();

    expect(chatCalls).toBe(0);
    expect(models).toHaveLength(2);
    expect(models.find((item) => item.model === 'qwen2.5-coder:14b')).toMatchObject({
      capabilities: { toolCalling: 'supported', reasoning: 'unsupported' },
      limits: { contextTokens: 32_768 },
      discovery: { source: 'provider-api' },
    });
  });

  it('loads selected-model metadata once before the first Agent run', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'schemanaut-sdk-model-metadata-'));
    tempDirs.push(directory);
    let metadataCalls = 0;
    let chatCalls = 0;
    const provider: LlmProvider = {
      id: 'metadata-provider',
      name: 'Metadata Provider',
      mode: 'byok',
      capabilities: { chat: 'supported', toolCalling: 'supported' },
      chat() {
        chatCalls += 1;
        return Promise.resolve({ text: 'Task complete.', toolCalls: [] });
      },
      getModelMetadata(model) {
        metadataCalls += 1;
        return Promise.resolve({
          model,
          source: 'provider-api',
          capabilities: { toolCalling: 'supported' },
          contextTokens: 131_072,
          maxOutputTokens: 8_192,
        });
      },
      isAvailable() {
        return Promise.resolve({ available: true });
      },
    };
    const runtime = new DatabaseAgentRuntime({
      provider,
      model: 'metadata-model',
      projectDirectory: directory,
      sessionDatabasePath: ':memory:',
    });

    await runtime.runAgent({ message: 'Answer directly.' });
    await runtime.runAgent({ message: 'Answer directly again.' });

    expect(metadataCalls).toBe(1);
    expect(chatCalls).toBe(2);
    expect(runtime.llmModels().find((item) => item.model === 'metadata-model')).toMatchObject({
      limits: { contextTokens: 131_072, maxOutputTokens: 8_192 },
      discovery: { source: 'provider-api' },
    });
    await runtime.close();
  });

  it('runs the main multi-step AI SQL Agent with knowledge lookup, complex SQL, execution, and persisted session evidence', async () => {
    const driver = new FakeDatabaseDriver();
    driver.resultRowCount = 1_500;
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
      message: '/query-and-answer 统计每个城市金额最高的三笔订单合计',
      mode: 'read',
    });

    expect(output.activatedSkills).toContain('query-and-answer');
    expect(output.result.runId).toEqual(expect.any(String));
    expect(output.queryResults).toHaveLength(1);
    expect(output.queryResults[0]).toMatchObject({
      connectionId: 'connection-1',
      returnedRowCount: 1_000,
      hasMore: true,
      truncated: true,
    });
    expect(output.queryResults[0]?.rows).toHaveLength(1_000);
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
    expect(output.result.session.knowledgeSnapshot?.connectionId).toBe('connection-1');
    expect(output.result.session.knowledgeSnapshot?.knowledgeSnapshotId).toMatch(/^knowledge:/);
    expect(typeof output.result.session.knowledgeSnapshot?.catalogRootHash).toBe('string');
    expect(typeof output.result.session.knowledgeSnapshot?.indexVersion).toBe('string');
    expect(driver.executedSql[0]).toContain('row_number() OVER');
    expect(provider.requests).toHaveLength(3);
    await expect(runtime.getAgentRun(output.result.runId)).resolves.toMatchObject({
      runId: output.result.runId,
      sessionId: output.result.session.id,
      status: 'done',
      phase: 'done',
      completion: {
        verified: true,
        deliveryReady: true,
      },
    });
    const modelToolMessage = provider.requests[2]?.messages.find(
      (message) => message.role === 'tool' && message.toolCallId === 'tool-query',
    );
    const modelToolPayload = JSON.parse(modelToolMessage?.content ?? '{}') as {
      rows?: unknown[];
    };
    expect(modelToolPayload.rows).toHaveLength(20);
    const persisted = await runtime.sessions.load(output.result.session.id);
    expect(persisted).toMatchObject({
      id: output.result.session.id,
      userId: 'user-alice',
      knowledgeSnapshot: {
        catalogRootHash: output.result.session.knowledgeSnapshot?.catalogRootHash,
      },
    });
    const persistedToolMessage = persisted?.messages.find(
      (message) => message.role === 'tool' && message.toolCallId === 'tool-query',
    );
    expect(persistedToolMessage?.content).not.toContain('"rows"');
    expect(persistedToolMessage?.content).not.toContain('resultHandleId');
    await runtime.close();
    const restoredRuntime = new DatabaseAgentRuntime({
      driver: new FakeDatabaseDriver(),
      sessionDatabasePath: join(directory, 'agent.db'),
    });
    await expect(restoredRuntime.getAgentRun(output.result.runId)).resolves.toMatchObject({
      status: 'done',
      sessionId: output.result.session.id,
    });
    await restoredRuntime.close();
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
    const directory = await mkdtemp(join(tmpdir(), 'dbagent-sdk-manual-compact-'));
    tempDirs.push(directory);
    const runtime = new DatabaseAgentRuntime({
      provider,
      model: 'test-model',
      projectDirectory: directory,
      sessionDatabasePath: join(directory, 'agent.db'),
      now: () => '2026-07-24T01:00:00.000Z',
    });
    const session: AgentSession = {
      id: 'session-manual-compact',
      title: '订单长期分析',
      userId: 'user-alice',
      mode: 'read',
      project: agentProjectReference(createAgentProjectContext(directory)),
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
    await expect(runtime.agentContextCheckpoints(session.id)).resolves.toMatchObject([
      { sequence: 1, trigger: 'manual', method: 'model' },
    ]);
    expect(provider.requests[0]?.metadata).toMatchObject({
      purpose: 'context-compaction',
      trigger: 'manual',
    });
  });

  it('reads public Agent run history from the configured durable run store', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dbagent-sdk-custom-run-store-'));
    tempDirs.push(directory);
    const record: AgentRunRecord = {
      runId: 'custom-run-1',
      sessionId: 'custom-session-1',
      status: 'done',
      phase: 'done',
      iteration: 2,
      finalText: '查询已完成，结果已单独返回。',
      toolExecutions: [
        {
          toolName: 'sql_execute',
          status: 'success',
          completionEvidence: { kind: 'database-result', deliveryReady: true },
        },
      ],
      completion: {
        verified: true,
        deliveryReady: true,
        finalResponseReady: true,
        phase: 'done',
        unresolvedTaskIds: [],
        missing: [],
        evidenceKinds: ['database-result'],
      },
      createdAt: '2026-07-27T00:00:00.000Z',
      updatedAt: '2026-07-27T00:00:01.000Z',
    };
    let recoveryCalls = 0;
    const runStore: AgentRunStore = {
      saveRun: () => Promise.resolve(),
      getRun: (runId) => Promise.resolve(runId === record.runId ? structuredClone(record) : undefined),
      listRuns: (sessionId) =>
        Promise.resolve(
          sessionId === undefined || sessionId === record.sessionId
            ? [structuredClone(record)]
            : [],
        ),
      recoverInterrupted: () => {
        recoveryCalls += 1;
        return Promise.resolve(0);
      },
    };
    const runtime = new DatabaseAgentRuntime({
      sessionDatabasePath: join(directory, 'state.db'),
      agentDependencies: { runStore },
    });

    await expect(runtime.getAgentRun(record.runId)).resolves.toEqual(record);
    await expect(runtime.listAgentRuns(record.sessionId, 10)).resolves.toEqual([record]);
    expect(recoveryCalls).toBe(1);
    await runtime.close();
  });

  it('keeps all Session management and resume paths inside the current Project', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dbagent-sdk-project-sessions-'));
    tempDirs.push(directory);
    const projectAPath = join(directory, 'project-a');
    const projectBPath = join(directory, 'project-b');
    await Promise.all([
      mkdir(projectAPath, { recursive: true }),
      mkdir(projectBPath, { recursive: true }),
    ]);
    const sessionDatabasePath = join(directory, 'shared-agent.db');
    const projectA = agentProjectReference(createAgentProjectContext(projectAPath));
    const session: AgentSession = {
      id: 'session-project-a',
      title: 'Project A durable analysis',
      mode: 'read',
      project: projectA,
      messages: Array.from({ length: 10 }, (_, index) => [
        {
          role: 'user' as const,
          content: `Project A question ${index + 1}`,
          createdAt: `2026-07-26T00:${String(index).padStart(2, '0')}:00.000Z`,
        },
        {
          role: 'assistant' as const,
          content: `Project A answer ${index + 1}`,
          createdAt: `2026-07-26T00:${String(index).padStart(2, '0')}:01.000Z`,
        },
      ]).flat(),
      tokenUsage: { promptTokens: 1_000, completionTokens: 200, totalTokens: 1_200 },
      aborted: false,
    };
    const runtimeA = new DatabaseAgentRuntime({
      provider: new ScriptedAgentProvider([
        {
          text: 'Project A compacted state.',
          toolCalls: [],
        },
      ]),
      model: 'test-model',
      projectDirectory: projectAPath,
      sessionDatabasePath,
    });
    const runtimeB = new DatabaseAgentRuntime({
      provider: new ScriptedAgentProvider([
        {
          text: 'This response must never be used for Project A.',
          toolCalls: [],
        },
      ]),
      model: 'test-model',
      projectDirectory: projectBPath,
      sessionDatabasePath,
    });

    await runtimeA.sessions.save({ session });
    const compacted = await runtimeA.compactAgentSession({ sessionId: session.id });
    expect(compacted.status).toBe('compacted');
    await expect(runtimeA.listAgentSessions()).resolves.toMatchObject([{ id: session.id }]);
    await expect(runtimeA.getAgentSession(session.id)).resolves.toMatchObject({ id: session.id });
    await expect(runtimeA.agentContextCheckpoints(session.id)).resolves.toHaveLength(1);

    await expect(runtimeB.listAgentSessions()).resolves.toEqual([]);
    await expect(runtimeB.getAgentSession(session.id)).resolves.toBeUndefined();
    await expect(runtimeB.sessions.load(session.id)).resolves.toBeUndefined();
    await expect(runtimeB.sessions.archive(session.id)).rejects.toThrow('Agent session not found');
    await expect(runtimeB.compactAgentSession({ sessionId: session.id })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(runtimeB.agentContextCheckpoints(session.id)).resolves.toEqual([]);
    expect(runtimeB.steerAgentSession(session.id, 'foreign steering')).toBe(false);
    await expect(runtimeB.deleteAgentSession(session.id)).resolves.toBe(false);

    await expect(runtimeA.sessions.archive(session.id)).resolves.toMatchObject({ archived: true });
    await expect(runtimeA.sessions.archive(session.id, false)).resolves.toMatchObject({
      archived: false,
    });
    await runtimeA.close();
    await runtimeB.close();

    const restoredRuntimeA = new DatabaseAgentRuntime({
      driver: new FakeDatabaseDriver(),
      provider: new ScriptedAgentProvider([
        {
          text: 'Project A resumed successfully.',
          toolCalls: [],
        },
      ]),
      model: 'test-model',
      projectDirectory: projectAPath,
      sessionDatabasePath,
      createConnectionId: () => 'project-a-connection',
    });
    await restoredRuntimeA.connect(connectionInput());
    await restoredRuntimeA.indexSchema();
    const resumed = await restoredRuntimeA.runAgent({
      sessionId: session.id,
      message: 'Continue Project A.',
    });
    expect(resumed.result.session.id).toBe(session.id);
    expect(resumed.result.finalText).toBe('Project A resumed successfully.');
    await expect(restoredRuntimeA.deleteAgentSession(session.id)).resolves.toBe(true);
    await restoredRuntimeA.close();
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
              sql: 'UPDATE public.orders SET amount = 200 WHERE id = 42',
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
      message: '/write-and-verify 更新订单 42 的金额为 200',
      mode: 'read',
    });

    expect(approvalRequests).toEqual([{ mode: 'read', requiredPermission: 'edit' }]);
    expect(output.activatedSkills).toContain('write-and-verify');
    expect(output.result.toolExecutions[0]).toMatchObject({
      toolName: 'sql_execute',
      status: 'success',
      approval: {
        requestId: 'dialog-1',
        approvedBy: 'user-alice',
        reason: '本次允许',
      },
    });
    expect(driver.executedSql).toEqual(['UPDATE public.orders SET amount = 200 WHERE id = 42']);
  });

  it('exposes safe Session, Skill, approval and user-owned MCP management through the SDK', async () => {
    const driver = new FakeDatabaseDriver();
    const provider = new ScriptedAgentProvider([
      {
        text: '',
        toolCalls: [
          {
            id: 'tool-update',
            name: 'sql_execute',
            arguments: {
              sql: 'UPDATE public.orders SET amount = 201 WHERE id = 42',
            },
          },
        ],
      },
      {
        text: '订单 42 已更新。',
        toolCalls: [],
      },
    ]);
    const directory = await mkdtemp(join(tmpdir(), 'dbagent-sdk-management-'));
    tempDirs.push(directory);
    const runtime = new DatabaseAgentRuntime({
      driver,
      provider,
      model: 'test-model',
      projectDirectory: directory,
      sessionDatabasePath: join(directory, 'agent.db'),
      createConnectionId: () => 'connection-1',
    });
    await runtime.connect(connectionInput());
    await runtime.indexSchema();

    await expect(runtime.listMcpServers()).resolves.toEqual([]);
    const configuredMcp = await runtime.upsertMcpServer({
      id: 'company-tools',
      name: 'Company Tools',
      source: 'user',
      transport: 'streamable-http',
      url: 'https://mcp.example.test',
      headers: {
        Authorization: { ref: 'mcp:company-tools:authorization' },
      },
    });
    expect(configuredMcp).toEqual({
      id: 'company-tools',
      name: 'Company Tools',
      source: 'user',
      transport: 'streamable-http',
      enabled: true,
      autoStart: false,
      running: false,
      status: 'stopped',
      healthy: false,
      warnings: [],
    });
    expect(JSON.stringify(configuredMcp)).not.toMatch(/Authorization|authorization|headers|url/);

    const runPromise = runtime.runAgent({
      userId: 'user-alice',
      message: '更新订单 42 的金额为 201',
      mode: 'read',
    });
    const approval = await waitForPendingApproval(runtime);
    expect(approval).toMatchObject({
      status: 'pending',
      mode: 'read',
      toolName: 'sql_execute',
    });
    expect(approval.argumentPreview).toContain('UPDATE public.orders');
    expect(
      runtime.resolveAgentApproval(approval.id, true, {
        resolvedBy: 'user-alice',
        reason: '本次允许',
      }),
    ).toBe(true);
    const run = await runPromise;

    const sessions = await runtime.listAgentSessions({
      userId: 'user-alice',
      limit: 10,
    });
    expect(sessions).toMatchObject([
      {
        id: run.result.session.id,
        userId: 'user-alice',
        mode: 'read',
      },
    ]);
    const view = await runtime.getAgentSession(run.result.session.id);
    expect(view).toMatchObject({
      id: run.result.session.id,
      messages: [
        { role: 'user', content: '更新订单 42 的金额为 201' },
        { role: 'assistant', content: '订单 42 已更新。' },
      ],
    });
    expect(JSON.stringify(view)).not.toMatch(
      /toolCall|sql_execute|knowledgeSnapshot|catalogRootHash|instructions/,
    );
    expect(await runtime.listAgentSkills()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'query-and-answer',
          scope: 'system',
        }),
      ]),
    );

    await expect(runtime.removeMcpServer('company-tools')).resolves.toBe(true);
    await expect(runtime.listMcpServers()).resolves.toEqual([]);
    await expect(runtime.deleteAgentSession(run.result.session.id)).resolves.toBe(true);
    await expect(runtime.getAgentSession(run.result.session.id)).resolves.toBeUndefined();
    await runtime.close();
  });

  it('isolates, persists, restores, and concurrently resolves Session Markdown Skills', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dbagent-sdk-session-skills-'));
    tempDirs.push(directory);
    const sessionDatabasePath = join(directory, 'agent.db');
    const runtime = new DatabaseAgentRuntime({
      driver: new FakeDatabaseDriver(),
      provider: new SessionSkillProvider(),
      model: 'test-model',
      projectDirectory: directory,
      sessionDatabasePath,
      sessionSkills: [sessionSkillOverlay('DEFAULT_V1_TOKEN', 'Default v1 workflow.')],
      createConnectionId: () => 'connection-1',
    });
    await runtime.connect(connectionInput());
    await runtime.indexSchema();

    const [sessionA, sessionB] = await Promise.all([
      runtime.runAgent({
        message: 'Apply the private workflow for Session A.',
        sessionSkills: [sessionSkillOverlay('SESSION_A_TOKEN', 'Session A workflow.')],
      }),
      runtime.runAgent({
        message: 'Apply the default private workflow for Session B.',
      }),
    ]);

    expect(sessionA.result.finalText).toBe('SESSION_A_TOKEN');
    expect(sessionB.result.finalText).toBe('DEFAULT_V1_TOKEN');
    expect(sessionA.result.session.id).not.toBe(sessionB.result.session.id);
    expect(sessionA.result.session.sessionSkills?.[0]?.content).toContain('SESSION_A_TOKEN');
    expect(sessionB.result.session.sessionSkills?.[0]?.content).toContain('DEFAULT_V1_TOKEN');
    expect(sessionA.result.session.activeSkills?.[0]?.instructions).toContain('SESSION_A_TOKEN');
    expect(sessionB.result.session.activeSkills?.[0]?.instructions).toContain('DEFAULT_V1_TOKEN');

    expect((await runtime.listAgentSkills()).some(({ name }) => name === 'private-workflow')).toBe(
      false,
    );
    expect(
      (await runtime.refreshSkills()).skills.some(({ name }) => name === 'private-workflow'),
    ).toBe(false);
    await expect(
      runtime.listAgentSkills({ sessionId: sessionA.result.session.id }),
    ).resolves.toEqual(
      expect.arrayContaining([
        {
          name: 'private-workflow',
          description: 'Session A workflow.',
          scope: 'session',
        },
      ]),
    );
    await expect(
      runtime.listAgentSkills({ sessionId: sessionB.result.session.id }),
    ).resolves.toEqual(
      expect.arrayContaining([
        {
          name: 'private-workflow',
          description: 'Default v1 workflow.',
          scope: 'session',
        },
      ]),
    );
    expect(JSON.stringify(await runtime.getAgentSession(sessionA.result.session.id))).not.toContain(
      'Return the exact token',
    );
    await expect(
      runtime.runAgent({
        message: 'Attempt to replace the Session Skill.',
        sessionId: sessionA.result.session.id,
        sessionSkills: [sessionSkillOverlay('REPLACEMENT_TOKEN', 'Replacement workflow.')],
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(
      runtime.runAgent({
        message: 'Attempt to replace the Session Skill.',
        sessionId: sessionA.result.session.id,
        sessionSkills: [sessionSkillOverlay('REPLACEMENT_TOKEN', 'Replacement workflow.')],
      }),
    ).rejects.toThrow('不能替换已存在 Session');
    await runtime.close();

    const restoredRuntime = new DatabaseAgentRuntime({
      driver: new FakeDatabaseDriver(),
      provider: new SessionSkillProvider(),
      model: 'test-model',
      projectDirectory: directory,
      sessionDatabasePath,
      sessionSkills: [sessionSkillOverlay('DEFAULT_V2_TOKEN', 'Default v2 workflow.')],
      createConnectionId: () => 'connection-2',
    });
    await restoredRuntime.connect(connectionInput());
    await restoredRuntime.indexSchema();
    const [restoredA, restoredB] = await Promise.all([
      restoredRuntime.runAgent({
        message: 'Resume Session A with its original private workflow.',
        sessionId: sessionA.result.session.id,
      }),
      restoredRuntime.runAgent({
        message: 'Resume Session B with its original default snapshot.',
        sessionId: sessionB.result.session.id,
      }),
    ]);
    expect(restoredA.result.finalText).toBe('SESSION_A_TOKEN');
    expect(restoredB.result.finalText).toBe('DEFAULT_V1_TOKEN');
    await restoredRuntime.close();

    const foreignProject = await mkdtemp(join(tmpdir(), 'dbagent-sdk-foreign-project-'));
    tempDirs.push(foreignProject);
    const foreignRuntime = new DatabaseAgentRuntime({
      provider: new SessionSkillProvider(),
      model: 'test-model',
      projectDirectory: foreignProject,
      sessionDatabasePath,
    });
    await expect(
      foreignRuntime.listAgentSkills({ sessionId: sessionA.result.session.id }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(
      foreignRuntime.listAgentSkills({ sessionId: sessionA.result.session.id }),
    ).rejects.toThrow('Session');
    await foreignRuntime.close();
  });

  it('inherits Session Skills into a child Agent without activating them in the parent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dbagent-sdk-subagent-skills-'));
    tempDirs.push(directory);
    const provider = new DelegatingSessionSkillProvider();
    const runtime = new DatabaseAgentRuntime({
      driver: new FakeDatabaseDriver(),
      provider,
      model: 'test-model',
      projectDirectory: directory,
      sessionDatabasePath: join(directory, 'agent.db'),
      dynamicToolDiscovery: false,
      createConnectionId: () => 'connection-1',
    });
    await runtime.connect(connectionInput());
    await runtime.indexSchema();

    const result = await runtime.runAgent({
      message: 'Delegate the private workflow to one child Agent.',
      sessionSkills: [sessionSkillOverlay('SUBAGENT_SESSION_TOKEN', 'Child workflow.')],
      maxIterations: 4,
    });

    expect(result.result.finalText).toBe('PARENT_SPAWNED_CHILD');
    expect(result.result.session.activeSkills).toBeUndefined();
    expect(result.result.session.sessionSkills?.[0]?.content).toContain('SUBAGENT_SESSION_TOKEN');
    expect(result.result.toolExecutions).toEqual([
      expect.objectContaining({ toolName: 'subagent_spawn', status: 'success' }),
    ]);
    const parentSessionId = result.result.session.id;
    await vi.waitFor(
      () => {
        expect(runtime.sessions.listSubagents(parentSessionId)).toEqual([
          expect.objectContaining({
            parentSessionId,
            status: 'completed',
            summary: 'SUBAGENT_SESSION_TOKEN',
          }),
        ]);
      },
      { interval: 10, timeout: 5_000 },
    );
    expect(provider.toolPayloads.join('\n---\n')).toContain('SUBAGENT_SESSION_TOKEN');
    const storedSessions = await runtime.sessions.list({ limit: 10 });
    const childSummary = storedSessions.find(({ title }) => title.startsWith('Child must load'));
    expect(childSummary).toBeDefined();
    const childSession = await runtime.sessions.load(childSummary!.id);
    expect(childSession?.sessionSkills?.[0]?.content).toContain('SUBAGENT_SESSION_TOKEN');
    expect(childSession?.activeSkills?.[0]?.instructions).toContain('SUBAGENT_SESSION_TOKEN');
    expect(runtime.sessions.listSubagents(parentSessionId)).toEqual([
      expect.objectContaining({
        parentSessionId,
        childSessionId: childSummary!.id,
        status: 'completed',
        summary: 'SUBAGENT_SESSION_TOKEN',
      }),
    ]);
    await runtime.close();

    const restoredRuntime = new DatabaseAgentRuntime({
      driver: new FakeDatabaseDriver(),
      provider: new DelegatingSessionSkillProvider(),
      model: 'test-model',
      projectDirectory: directory,
      sessionDatabasePath: join(directory, 'agent.db'),
      dynamicToolDiscovery: false,
      createConnectionId: () => 'connection-2',
    });
    expect(restoredRuntime.sessions.listSubagents(parentSessionId)).toEqual([
      expect.objectContaining({
        parentSessionId,
        childSessionId: childSummary!.id,
        status: 'completed',
        summary: 'SUBAGENT_SESSION_TOKEN',
      }),
    ]);
    await restoredRuntime.close();
  });

  it('propagates a parent Agent cancellation into an already running child Agent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dbagent-sdk-subagent-cancel-'));
    tempDirs.push(directory);
    const provider = new AbortableDelegationProvider();
    const runtime = new DatabaseAgentRuntime({
      driver: new FakeDatabaseDriver(),
      provider,
      model: 'test-model',
      projectDirectory: directory,
      sessionDatabasePath: join(directory, 'agent.db'),
      dynamicToolDiscovery: false,
      createConnectionId: () => 'connection-1',
    });
    await runtime.connect(connectionInput());
    await runtime.indexSchema();
    const controller = new AbortController();

    const run = runtime.runAgent({
      message: 'Delegate a blocking child task.',
      maxIterations: 4,
      signal: controller.signal,
    });
    await Promise.all([provider.childStarted, provider.parentWaiting]);
    controller.abort(new Error('parent cancelled'));
    await expect(run).rejects.toThrow('parent provider call aborted');

    expect(provider.childSignal?.aborted).toBe(true);
    expect(runtime.sessions.listSubagents()).toEqual([
      expect.objectContaining({
        status: 'cancelled',
      }),
    ]);
    await runtime.close();
  });
});

async function waitForPendingApproval(
  runtime: DatabaseAgentRuntime,
): Promise<ReturnType<DatabaseAgentRuntime['listAgentApprovals']>[number]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const approval = runtime.listAgentApprovals()[0];
    if (approval) return approval;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for an Agent approval request.');
}

function createRuntime(driver: FakeDatabaseDriver, provider: LlmProvider): DatabaseAgentRuntime {
  return new DatabaseAgentRuntime({
    driver,
    provider,
    model: 'test-model',
    sessionDatabasePath: ':memory:',
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

function sessionSkillOverlay(token: string, description: string) {
  return {
    content: [
      '---',
      'name: private-workflow',
      `description: ${description}`,
      '---',
      `Return the exact token ${token} after loading this Skill.`,
    ].join('\n'),
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

class SlowAbortAwareProvider implements LlmProvider {
  readonly id = 'slow-abort-aware';
  readonly name = 'Slow Abort Aware Provider';
  readonly mode = 'byok' as const;
  signal: AbortSignal | undefined;
  private markStarted: (() => void) | undefined;
  readonly started = new Promise<void>((resolve) => {
    this.markStarted = resolve;
  });

  chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    this.signal = request.signal;
    this.markStarted?.();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          resolve({
            text: 'finished without cancellation',
            toolCalls: [],
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          }),
        250,
      );
      request.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          const error = new Error('provider call aborted');
          error.name = 'AbortError';
          reject(error);
        },
        { once: true },
      );
    });
  }

  isAvailable(): Promise<LlmProviderAvailability> {
    return Promise.resolve({ available: true });
  }
}

class SlowAbortAwareStreamProvider implements LlmProvider {
  readonly id = 'slow-abort-aware-stream';
  readonly name = 'Slow Abort Aware Stream Provider';
  readonly mode = 'byok' as const;
  signal: AbortSignal | undefined;
  closed = false;

  chat(): Promise<LlmChatResponse> {
    throw new Error('chat should not be used by the stream shutdown test');
  }

  async *stream(request: LlmChatRequest): AsyncIterable<LlmChatStreamEvent> {
    this.signal = request.signal;
    try {
      yield { type: 'text-delta', text: 'working' };
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 5_000);
        request.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            const error = new Error('provider stream aborted');
            error.name = 'AbortError';
            reject(error);
          },
          { once: true },
        );
      });
    } finally {
      this.closed = true;
    }
  }

  isAvailable(): Promise<LlmProviderAvailability> {
    return Promise.resolve({ available: true });
  }
}

class SessionSkillProvider implements LlmProvider {
  readonly id = 'session-skill-provider';
  readonly name = 'Session Skill Provider';
  readonly mode = 'byok' as const;
  private toolCallSequence = 0;

  chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    const latest = request.messages.at(-1);
    if (latest?.role === 'tool') {
      const token = ['SESSION_A_TOKEN', 'DEFAULT_V1_TOKEN', 'DEFAULT_V2_TOKEN'].find((candidate) =>
        latest.content.includes(candidate),
      );
      return Promise.resolve({
        text: token ?? 'UNKNOWN_SESSION_SKILL',
        toolCalls: [],
        usage: { promptTokens: 40, completionTokens: 5, totalTokens: 45 },
      });
    }
    this.toolCallSequence += 1;
    return Promise.resolve({
      text: '',
      toolCalls: [
        {
          id: `load-session-skill-${String(this.toolCallSequence)}`,
          name: 'skill',
          arguments: { action: 'load', name: 'private-workflow', scope: 'session' },
        },
      ],
      usage: { promptTokens: 30, completionTokens: 10, totalTokens: 40 },
    });
  }

  isAvailable(): Promise<LlmProviderAvailability> {
    return Promise.resolve({ available: true });
  }
}

class DelegatingSessionSkillProvider implements LlmProvider {
  readonly id = 'delegating-session-skill-provider';
  readonly name = 'Delegating Session Skill Provider';
  readonly mode = 'byok' as const;
  readonly toolPayloads: string[] = [];
  private toolCallSequence = 0;

  chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    const latest = request.messages.at(-1);
    this.toolCallSequence += 1;
    if (latest?.role === 'tool') this.toolPayloads.push(latest.content);
    if (latest?.role === 'user' && latest.content.startsWith('Delegate the private workflow')) {
      return Promise.resolve({
        text: '',
        toolCalls: [
          {
            id: `spawn-child-${String(this.toolCallSequence)}`,
            name: 'subagent_spawn',
            arguments: { task: 'Child must load and apply the private-workflow Skill.' },
          },
        ],
      });
    }
    if (latest?.role === 'user' && latest.content.startsWith('Child must load')) {
      return Promise.resolve({
        text: '',
        toolCalls: [
          {
            id: `child-load-skill-${String(this.toolCallSequence)}`,
            name: 'skill',
            arguments: { action: 'load', name: 'private-workflow', scope: 'session' },
          },
        ],
      });
    }
    if (latest?.role === 'tool' && latest.content.includes('"task":"Child must load')) {
      return Promise.resolve({
        text: 'PARENT_SPAWNED_CHILD',
        toolCalls: [],
      });
    }
    if (latest?.role === 'tool' && latest.content.includes('SUBAGENT_SESSION_TOKEN')) {
      return Promise.resolve({
        text: 'SUBAGENT_SESSION_TOKEN',
        toolCalls: [],
      });
    }
    return Promise.resolve({ text: 'UNEXPECTED_DELEGATION_STATE', toolCalls: [] });
  }

  isAvailable(): Promise<LlmProviderAvailability> {
    return Promise.resolve({ available: true });
  }
}

class AbortableDelegationProvider implements LlmProvider {
  readonly id = 'abortable-delegation-provider';
  readonly name = 'Abortable Delegation Provider';
  readonly mode = 'byok' as const;
  childSignal: AbortSignal | undefined;
  private resolveChildStarted: (() => void) | undefined;
  private resolveParentWaiting: (() => void) | undefined;
  readonly childStarted = new Promise<void>((resolve) => {
    this.resolveChildStarted = resolve;
  });
  readonly parentWaiting = new Promise<void>((resolve) => {
    this.resolveParentWaiting = resolve;
  });

  chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    const latest = request.messages.at(-1);
    if (latest?.role === 'user' && latest.content === 'Delegate a blocking child task.') {
      return Promise.resolve({
        text: '',
        toolCalls: [
          {
            id: 'spawn-blocking-child',
            name: 'subagent_spawn',
            arguments: { task: 'Child must block until its parent is cancelled.' },
          },
        ],
      });
    }
    if (latest?.role === 'user' && latest.content.startsWith('Child must block')) {
      this.childSignal = request.signal;
      this.resolveChildStarted?.();
      return abortableProviderResponse(request.signal, 'child');
    }
    if (latest?.role === 'tool' && latest.content.includes('"task":"Child must block')) {
      this.resolveParentWaiting?.();
      return abortableProviderResponse(request.signal, 'parent');
    }
    return Promise.resolve({ text: 'UNEXPECTED_ABORT_STATE', toolCalls: [] });
  }

  isAvailable(): Promise<LlmProviderAvailability> {
    return Promise.resolve({ available: true });
  }
}

function abortableProviderResponse(
  signal: AbortSignal | undefined,
  actor: string,
): Promise<LlmChatResponse> {
  return new Promise((_, reject) => {
    const rejectAborted = () => {
      const error = new Error(`${actor} provider call aborted`);
      error.name = 'AbortError';
      reject(error);
    };
    if (signal?.aborted) {
      rejectAborted();
      return;
    }
    signal?.addEventListener('abort', rejectAborted, { once: true });
  });
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
  resultRowCount = 1;
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
        rows: Array.from({ length: this.resultRowCount }, (_, index) => ({
          city: index % 2 === 0 ? 'Shanghai' : 'Beijing',
          total_amount: 188 + index,
        })),
        rowCount: this.resultRowCount,
        returnedRowCount: this.resultRowCount,
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
