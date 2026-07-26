import { describe, expect, it, vi } from 'vitest';
import {
  createSingleToolCallExecutionGrant,
  ToolRegistry,
  type AgentAccessMode,
  type AgentToolApproval,
  type AgentToolContext,
} from '@dbagent/core-agent';
import { DatabaseAccessRuntimeError, type IDatabaseDriver } from '@dbagent/core-db';
import { SchemaRagEngine } from '@dbagent/core-rag';
import {
  err,
  ok,
  stringifyPublicJson,
  type QueryExecutionResult,
  type QueryRequest,
  type Result,
  type SavedConnection,
  type TableDetail,
  type TableSummary,
} from '@dbagent/shared';
import {
  AiSqlResultStore,
  registerAiSqlTools,
  type AiSqlToolDependencies,
  type AiSqlQueryExecutionInput,
  type AiSqlQueryExecutor,
} from '../src/index.js';

describe('AI SQL built-in tools', () => {
  it('registers the six-tool surface and returns only task-relevant database content', async () => {
    const harness = createHarness();
    expect(harness.registry.list().map((tool) => tool.name)).toEqual([
      'resource_list',
      'resource_get',
      'knowledge_search',
      'sql_execute',
      'sql_explain',
      'result_read',
    ]);
    expect(
      harness.registry
        .llmTools()
        .some((tool) => JSON.stringify(tool.inputSchema).includes('connectionId')),
    ).toBe(false);
    expect(harness.registry.get('sql_execute')?.source).toBe('database');
    expect(harness.registry.get('sql_explain')?.source).toBe('database');
    expect(harness.registry.get('result_read')?.source).toBe('database');

    const root = (await harness.registry
      .get('resource_list')!
      .handler({}, context('session-a'))) as ResourceListOutput;
    expect(
      root.resources.some((resource) => resource.name === 'conn_1' && resource.kind === 'database'),
    ).toBe(true);

    const schemaChildren = (await harness.registry
      .get('resource_list')!
      .handler({ scope: 'conn_1' }, context('session-a'))) as ResourceListOutput;
    expect(
      schemaChildren.resources.some(
        (resource) => resource.name === 'public' && resource.kind === 'schema',
      ),
    ).toBe(true);

    const table = (await harness.registry
      .get('resource_get')!
      .handler({ resource: 'public.orders' }, context('session-a'))) as ResourceDetailOutput;
    expect(table.resource).toMatchObject({
      name: 'public.orders',
      displayName: 'orders',
    });
    expect(
      table.columns.some(
        (column) => column.name === 'public.orders.id' && column.facts.dataType === 'bigint',
      ),
    ).toBe(true);
    expect(
      table.columns.some(
        (column) => column.name === 'public.orders.payload' && column.facts.dataType === 'jsonb',
      ),
    ).toBe(true);
    expect(JSON.stringify(table).length).toBeLessThan(12_000);

    const search = (await harness.registry
      .get('knowledge_search')!
      .handler(
        { query: '订单 JSON payload', limit: 5 },
        context('session-a'),
      )) as KnowledgeSearchOutput;
    expect(
      search.items.some(
        (item) =>
          item.document.kind === 'table' &&
          item.document.table === 'orders' &&
          item.document.title === 'public.orders',
      ),
    ).toBe(true);
    expect(JSON.stringify(search).length).toBeLessThan(12_000);
    for (const output of [root, schemaChildren, table, search]) {
      expectKnowledgeInternalsAbsent(output);
    }
  });

  it('derives read/edit/full from the actual SQL and keeps execution previews compact', async () => {
    const harness = createHarness();
    const execute = harness.registry.get('sql_execute')!;

    expect(execute.resolveRequiredPermission?.({ sql: 'SELECT * FROM orders' })).toBe('read');
    expect(
      execute.resolveRequiredPermission?.({
        sql: "UPDATE orders SET status = 'paid' WHERE id = 1",
      }),
    ).toBe('edit');
    expect(
      execute.resolveRequiredPermission?.({
        sql: 'ALTER TABLE orders ADD COLUMN source text',
      }),
    ).toBe('full');
    expect(execute.resolveRequiredPermission?.({})).toBe('full');

    const output = (await execute.handler(
      {
        sql: 'SELECT id, payload FROM public.orders ORDER BY id',
        maxRows: 500,
        previewRows: 5,
      },
      context('session-a'),
    )) as SqlExecutionToolOutput;
    expect(output.resultHandleId).toBe('result-1');
    expect(output.storedRowCount).toBe(250);
    expect(output.previewTruncated).toBe(true);
    expect(Array.isArray(output.rows)).toBe(true);
    expect(output).not.toHaveProperty('parsed');
    expect(output).not.toHaveProperty('transaction');
    expect(() => stringifyPublicJson(output)).not.toThrow();
    expect(output.rows).toHaveLength(5);
    expect(harness.requests[0]).toMatchObject({
      connectionId: 'conn_1',
      limit: 500,
    });
    expect(harness.requests[0]).not.toHaveProperty('confirmed');
  });

  it('uses the unified query executor and forwards Agent authorization provenance', async () => {
    const executions: AiSqlQueryExecutionInput[] = [];
    const queryExecutor: AiSqlQueryExecutor = (input) => {
      executions.push(structuredClone(input));
      return Promise.resolve(queryResult(1));
    };
    const harness = createHarness({ queryExecutor });
    const toolContext = context('session-foundation');
    toolContext.session.userId = 'user-alice';
    toolContext.session.mode = 'edit';

    await harness.registry
      .get('sql_execute')!
      .handler({ sql: 'SELECT id FROM public.orders LIMIT 1' }, toolContext);

    expect(harness.requests).toEqual([]);
    expect(executions).toHaveLength(1);
    expect(executions[0]?.request.connectionId).toBe('conn_1');
    expect(executions[0]?.request.sql).toBe('SELECT id FROM public.orders LIMIT 1');
    expect(executions[0]?.authorization).toEqual({
      actorId: 'user-alice',
      permissionMode: 'edit',
    });
    expect(executions[0]?.connection.readOnly).toBe(false);
  });

  it('elevates only the currently approved UPDATE and rejects reuse, later calls, and other Sessions', async () => {
    const executions: AiSqlQueryExecutionInput[] = [];
    const harness = createHarness({
      queryExecutor(input) {
        executions.push(structuredClone(input));
        return Promise.resolve(queryResult(0));
      },
    });
    const execute = harness.registry.get('sql_execute')!;
    const sql = "UPDATE public.orders SET status = 'paid' WHERE id = 1";
    const approved = approvedToolContext({
      sessionId: 'session-approved',
      toolCallId: 'update-1',
      requiredPermission: 'edit',
      requestId: 'approval-update-1',
    });

    await execute.handler({ sql }, approved);

    expect(executions).toHaveLength(1);
    expect(executions[0]?.authorization).toEqual({
      approvalId: 'approval-update-1',
      permissionMode: 'edit',
    });
    expect(executions[0]?.connection.readOnly).toBe(false);

    await expect(Promise.resolve().then(() => execute.handler({ sql }, approved))).rejects.toThrow(
      'one-time approval',
    );

    const laterCall = context('session-approved');
    laterCall.session.mode = 'read';
    laterCall.invocation = {
      toolCallId: 'update-2',
      toolName: 'sql_execute',
      requiredPermission: 'edit',
    };
    await expect(Promise.resolve().then(() => execute.handler({ sql }, laterCall))).rejects.toThrow(
      'one-time approval',
    );

    const otherSession = approvedToolContext({
      sessionId: 'session-approved',
      toolCallId: 'update-cross-session',
      requiredPermission: 'edit',
      requestId: 'approval-cross-session',
    });
    otherSession.session.id = 'session-other';
    await expect(
      Promise.resolve().then(() => execute.handler({ sql }, otherSession)),
    ).rejects.toThrow('one-time approval');
    expect(executions).toHaveLength(1);
  });

  it('uses a separate one-time full grant for DDL and never weakens a read-only connection', async () => {
    const executions: AiSqlQueryExecutionInput[] = [];
    const harness = createHarness({
      connection: { ...connection(), readOnly: true },
      queryExecutor(input) {
        executions.push(structuredClone(input));
        return Promise.resolve(queryResult(0));
      },
    });
    const ddlContext = approvedToolContext({
      sessionId: 'session-ddl',
      toolCallId: 'ddl-1',
      requiredPermission: 'full',
      requestId: 'approval-ddl-1',
    });

    await harness.registry
      .get('sql_execute')!
      .handler({ sql: 'ALTER TABLE public.orders ADD COLUMN source text' }, ddlContext);

    expect(executions[0]?.authorization).toEqual({
      approvalId: 'approval-ddl-1',
      permissionMode: 'full',
    });
    expect(executions[0]?.connection.readOnly).toBe(true);
    expect(harness.onSchemaChanged).toHaveBeenCalledOnce();
  });

  it('blocks direct read-mode write and DDL calls when no execution grant exists', async () => {
    const executions: AiSqlQueryExecutionInput[] = [];
    const harness = createHarness({
      queryExecutor(input) {
        executions.push(structuredClone(input));
        return Promise.resolve(queryResult(0));
      },
    });
    const execute = harness.registry.get('sql_execute')!;
    const readContext = context('session-no-approval');
    readContext.session.mode = 'read';

    await expect(
      Promise.resolve().then(() =>
        execute.handler(
          { sql: "UPDATE public.orders SET status = 'paid' WHERE id = 1" },
          readContext,
        ),
      ),
    ).rejects.toThrow('requires edit permission');
    await expect(
      Promise.resolve().then(() =>
        execute.handler({ sql: 'ALTER TABLE public.orders ADD COLUMN bypass text' }, readContext),
      ),
    ).rejects.toThrow('requires full permission');
    expect(executions).toEqual([]);
  });

  it('enforces read mode at the database boundary and forwards cancellation to SQL and EXPLAIN', async () => {
    const executions: AiSqlQueryExecutionInput[] = [];
    const queryExecutor: AiSqlQueryExecutor = (input) => {
      executions.push(input);
      return Promise.resolve(
        input.request.sql.startsWith('EXPLAIN')
          ? {
              ...queryResult(1),
              columns: [{ name: 'QUERY PLAN', dataType: 'json' }],
              rows: [{ 'QUERY PLAN': [{ Plan: { 'Node Type': 'Result' } }] }],
            }
          : queryResult(1),
      );
    };
    const harness = createHarness({ queryExecutor });
    const controller = new AbortController();
    const toolContext = context('session-read-only');
    toolContext.session.mode = 'read';
    toolContext.signal = controller.signal;

    await harness.registry
      .get('sql_execute')!
      .handler({ sql: 'SELECT volatile_writer()', timeoutMs: 1_234 }, toolContext);
    await harness.registry
      .get('sql_explain')!
      .handler({ sql: 'SELECT * FROM public.orders', timeoutMs: 2_345 }, toolContext);

    expect(executions).toHaveLength(2);
    for (const execution of executions) {
      expect(execution.authorization.permissionMode).toBe('read');
      expect(execution.connection.readOnly).toBe(true);
      expect(execution.signal).toBe(controller.signal);
    }
    expect(executions[1]?.request.sql).toMatch(/^EXPLAIN \(FORMAT JSON\)/);
    expect(executions[0]?.request.timeoutMs).toBe(1_234);
    expect(executions[1]?.request.timeoutMs).toBe(2_345);
  });

  it('returns redacted database diagnostics to the Agent so it can repair SQL', async () => {
    const harness = createHarness({
      queryExecutor: () =>
        Promise.reject(
          new DatabaseAccessRuntimeError({
            code: 'QUERY_FAILED',
            category: 'syntax',
            stage: 'execute',
            message: 'PostgreSQL query failed.',
            detail: 'column "event_time" does not exist',
            retryable: false,
            outcome: 'unchanged',
          }),
        ),
    });

    await expect(
      harness.registry
        .get('sql_execute')!
        .handler({ sql: 'SELECT event_time FROM raw.kafka_events' }, context('session-a')),
    ).rejects.toThrow('PostgreSQL query failed. column "event_time" does not exist');
  });

  it('pages large results and prevents handles leaking across sessions', async () => {
    const harness = createHarness();
    const execute = harness.registry.get('sql_execute')!;
    const resultRead = harness.registry.get('result_read')!;
    const output = (await execute.handler(
      { sql: 'SELECT * FROM public.orders', previewRows: 3 },
      context('session-a'),
    )) as { resultHandleId: string };

    const firstPage = await resultRead.handler(
      { resultHandleId: output.resultHandleId, limit: 100 },
      context('session-a'),
    );
    expect(firstPage).toMatchObject({
      offset: 0,
      returnedRowCount: 100,
      totalStoredRows: 250,
      nextCursor: '100',
    });
    const lastPage = await resultRead.handler(
      {
        resultHandleId: output.resultHandleId,
        cursor: '200',
        limit: 100,
      },
      context('session-a'),
    );
    expect(lastPage).toMatchObject({
      offset: 200,
      returnedRowCount: 50,
    });
    expect(lastPage).not.toHaveProperty('nextCursor');

    await expect(
      Promise.resolve().then(() =>
        resultRead.handler({ resultHandleId: output.resultHandleId }, context('session-b')),
      ),
    ).rejects.toThrow('belongs to another session');
  });

  it('refreshes schema only after committed DDL and validates EXPLAIN as a read-only tool', async () => {
    const harness = createHarness();
    const execute = harness.registry.get('sql_execute')!;
    await execute.handler(
      { sql: 'ALTER TABLE public.orders ADD COLUMN source text' },
      context('session-a'),
    );
    expect(harness.requests[0]).toMatchObject({ confirmed: true });
    expect(harness.onSchemaChanged).toHaveBeenCalledOnce();
    const schemaChange = harness.onSchemaChanged.mock.calls[0]?.[0];
    expect(schemaChange?.connectionId).toBe('conn_1');
    expect(schemaChange?.parsed.requiredPermission).toBe('full');
    expect(schemaChange?.parsed.statementKinds).toEqual(['ALTER']);

    const explain = await harness.registry.get('sql_explain')!.handler(
      {
        sql: `
            SELECT customer_id, count(*)
            FROM public.orders
            WHERE created_at >= current_date - interval '30 days'
            GROUP BY customer_id
          `,
      },
      context('session-a'),
    );
    expect(typeof (explain as { plan: unknown }).plan).toBe('object');
    expect(explain).not.toHaveProperty('parsed');
    expect(harness.requests.at(-1)?.sql).toMatch(/^EXPLAIN \(FORMAT JSON\)/);

    await expect(
      Promise.resolve().then(() =>
        harness.registry
          .get('sql_explain')!
          .handler({ sql: 'DELETE FROM public.orders WHERE id = 1' }, context('session-a')),
      ),
    ).rejects.toThrow('exactly one non-EXPLAIN read query');
  });

  it('keeps committed DDL successful when schema refresh fails and warns against replay', async () => {
    const harness = createHarness();
    harness.onSchemaChanged.mockRejectedValueOnce(
      new Error('schema index is temporarily unavailable'),
    );

    const output = (await harness.registry
      .get('sql_execute')!
      .handler(
        { sql: 'ALTER TABLE public.orders ADD COLUMN source_system text' },
        context('session-ddl-warning'),
      )) as {
      resultHandleId: string;
      messages: Array<{ level: string; message: string }>;
    };

    expect(harness.requests).toHaveLength(1);
    expect(harness.onSchemaChanged).toHaveBeenCalledOnce();
    expect(output.resultHandleId).toBe('result-1');
    expect(output.messages).toHaveLength(1);
    expect(output.messages[0]?.level).toBe('warning');
    expect(output.messages[0]?.message).toContain('SQL 已成功执行');
    expect(output.messages[0]?.message).toContain('不要重新执行该 DDL');
    expect(() =>
      harness.resultStore.read({
        id: output.resultHandleId,
        sessionId: 'session-ddl-warning',
      }),
    ).not.toThrow();
  });

  it('expires results, validates cursors, and handles high-volume paging within budget', () => {
    let now = new Date('2026-07-24T00:00:00.000Z');
    let id = 0;
    const store = new AiSqlResultStore({
      ttlMs: 1_000,
      maxEntries: 1_000,
      now: () => now,
      createId: () => `result-${++id}`,
    });
    const started = performance.now();
    for (let index = 0; index < 500; index += 1) {
      const item = store.put({
        sessionId: `session-${index % 10}`,
        connectionId: 'conn_1',
        result: queryResult(100),
      });
      expect(
        store.read({
          id: item.id,
          sessionId: `session-${index % 10}`,
          cursor: '50',
          limit: 25,
        }).returnedRowCount,
      ).toBe(25);
    }
    expect(performance.now() - started).toBeLessThan(1_500);

    expect(() =>
      store.read({
        id: 'result-1',
        sessionId: 'session-0',
        cursor: '-1',
      }),
    ).toThrow('cursor is invalid');
    now = new Date('2026-07-24T00:00:02.000Z');
    expect(store.prune()).toBe(500);
  });

  it('bounds retained handles and oversized row payloads, then clears by Session', () => {
    let id = 0;
    const store = new AiSqlResultStore({
      maxEntries: 2,
      maxResultChars: 1_024,
      createId: () => `bounded-${++id}`,
    });
    const first = store.put({
      sessionId: 'session-a',
      connectionId: 'conn_1',
      result: queryResult(2),
    });
    const second = store.put({
      sessionId: 'session-a',
      connectionId: 'conn_1',
      result: {
        ...queryResult(2),
        rows: [{ payload: 'x'.repeat(20_000) }, { payload: 'later' }],
      },
    });
    const third = store.put({
      sessionId: 'session-b',
      connectionId: 'conn_1',
      result: queryResult(2),
    });

    expect(() => store.read({ id: first.id, sessionId: 'session-a' })).toThrow('missing, expired');
    const oversized = store.read({ id: second.id, sessionId: 'session-a' });
    expect(JSON.stringify(oversized.rows).length).toBeLessThan(1_200);
    expect(oversized.truncated).toBe(true);
    expect(store.clearSession('session-a')).toBe(1);
    expect(store.read({ id: third.id, sessionId: 'session-b' }).returnedRowCount).toBe(2);
    expect(store.clear()).toBe(1);
  });

  it('stores and pages Portable database values without serialization failures', () => {
    const store = new AiSqlResultStore({
      createId: () => 'portable-result',
    });
    const item = store.put({
      sessionId: 'session-portable',
      connectionId: 'conn_1',
      result: {
        ...queryResult(1),
        rows: [
          {
            exact_count: 9_007_199_254_740_993n,
            observed_at: new Date('2026-07-26T05:00:00.000Z'),
            fingerprint: Uint8Array.from([1, 2, 255]),
          },
        ],
      },
    });

    expect(item.result.rows[0]).toEqual({
      exact_count: 9_007_199_254_740_993n,
      observed_at: new Date('2026-07-26T05:00:00.000Z'),
      fingerprint: Uint8Array.from([1, 2, 255]),
    });
    expect(
      store.read({ id: item.id, sessionId: 'session-portable' }).rows[0],
    ).toEqual(item.result.rows[0]);
  });

  it('enforces a total byte budget with oldest-first eviction', () => {
    const sampleResult = {
      ...queryResult(1),
      rows: [{ id: 1, payload: 'x'.repeat(240) }],
    };
    const sizingStore = new AiSqlResultStore({
      createId: () => 'budgeted-0',
      now: () => new Date('2026-07-26T05:30:00.000Z'),
      maxResultChars: 4_096,
    });
    const sampleItem = sizingStore.put({
      sessionId: 'session-budget',
      connectionId: 'conn_1',
      result: sampleResult,
    });
    const twoItemBudget = Buffer.byteLength(stringifyPublicJson(sampleItem)) * 2;
    let id = 0;
    const store = new AiSqlResultStore({
      createId: () => `budgeted-${++id}`,
      now: () => new Date('2026-07-26T05:30:00.000Z'),
      maxEntries: 10,
      maxResultChars: 4_096,
      maxTotalBytes: twoItemBudget,
    });

    const first = store.put({
      sessionId: 'session-budget',
      connectionId: 'conn_1',
      result: sampleResult,
    });
    const second = store.put({
      sessionId: 'session-budget',
      connectionId: 'conn_1',
      result: sampleResult,
    });
    const third = store.put({
      sessionId: 'session-budget',
      connectionId: 'conn_1',
      result: sampleResult,
    });

    expect(() => store.read({ id: first.id, sessionId: 'session-budget' })).toThrow(
      'missing, expired',
    );
    expect(store.read({ id: second.id, sessionId: 'session-budget' }).returnedRowCount).toBe(1);
    expect(store.read({ id: third.id, sessionId: 'session-budget' }).returnedRowCount).toBe(1);
  });

  it('caps nested result sets without retaining the original oversized payload', () => {
    const store = new AiSqlResultStore({
      createId: () => 'nested-oversized',
      maxResultChars: 2_048,
      maxTotalBytes: 8_192,
    });
    const item = store.put({
      sessionId: 'session-nested',
      connectionId: 'conn_1',
      result: {
        ...queryResult(1),
        rows: [{ id: 1, payload: 'top-'.repeat(25_000) }],
        resultSets: [
          {
            index: 0,
            command: 'SELECT',
            columns: [{ name: 'payload', dataType: 'text' }],
            rows: [{ payload: 'nested-'.repeat(25_000) }],
            rowCount: 1,
            returnedRowCount: 1,
          },
        ],
      },
    });

    expect(Buffer.byteLength(stringifyPublicJson(item.result))).toBeLessThanOrEqual(2_048);
    expect(item.result.truncated).toBe(true);
    expect(item.result.resultSets?.[0]?.truncated).toBe(true);
  });

  it('propagates database failures without storing an unusable result handle', async () => {
    const harness = createHarness({ failSql: 'broken_query' });
    await expect(
      Promise.resolve().then(() =>
        harness.registry
          .get('sql_execute')!
          .handler({ sql: 'SELECT broken_query' }, context('session-a')),
      ),
    ).rejects.toThrow('database rejected SQL');
    expect(() =>
      harness.resultStore.read({
        id: 'result-1',
        sessionId: 'session-a',
      }),
    ).toThrow('missing, expired');
  });
});

function expectKnowledgeInternalsAbsent(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const forbidden of [
    'knowledgeSnapshotId',
    'catalogRootHash',
    'containmentRootHash',
    'relationRootHash',
    'knowledgeRootHash',
    'resourceId',
    'parentId',
    'ancestorIds',
    'childIds',
    'relationIds',
    'knowledgeBindingIds',
    'localHash',
    'childBlockHashes',
    'subtreeHash',
    '"node":',
    '"children":',
    'scoreDetails',
    '"score"',
    '"reasons"',
    '"tokens"',
    '资源:',
  ]) {
    expect(serialized, `tool output leaked ${forbidden}`).not.toContain(forbidden);
  }
}

function createHarness(
  options: {
    failSql?: string;
    queryExecutor?: AiSqlQueryExecutor;
    connection?: SavedConnection;
  } = {},
) {
  const registry = new ToolRegistry();
  const rag = new SchemaRagEngine();
  rag.index({
    connectionId: 'conn_1',
    tables: [ordersTable()],
    indexedAt: '2026-07-24T00:00:00.000Z',
  });
  const requests: QueryRequest[] = [];
  const driver = fakeDriver(requests, options.failSql);
  const resultStore = new AiSqlResultStore({
    createId: (() => {
      let id = 0;
      return () => `result-${++id}`;
    })(),
  });
  const onSchemaChanged = vi.fn<NonNullable<AiSqlToolDependencies['onSchemaChanged']>>();
  registerAiSqlTools({
    registry,
    rag,
    driver,
    ...(options.queryExecutor === undefined ? {} : { queryExecutor: options.queryExecutor }),
    resultStore,
    getActiveConnection: () => ({
      connectionId: 'conn_1',
      connection: options.connection ?? connection(),
    }),
    onSchemaChanged,
  });
  return {
    registry,
    rag,
    driver,
    requests,
    resultStore,
    onSchemaChanged,
  };
}

function fakeDriver(requests: QueryRequest[], failSql?: string): IDatabaseDriver {
  return {
    capabilities: {
      engine: 'postgres',
      supportsTransactions: true,
      supportsExplain: true,
      supportsSchemas: true,
    },
    test: () => Promise.resolve(ok({ latencyMs: 1 })),
    connect: () => Promise.resolve(ok(connection())),
    disconnect: () => Promise.resolve(ok(undefined)),
    execute: (request): Promise<Result<QueryExecutionResult>> => {
      requests.push(structuredClone(request));
      if (failSql && request.sql.includes(failSql)) {
        return Promise.resolve(
          err({
            code: 'QUERY_FAILED',
            message: 'database rejected SQL',
          }),
        );
      }
      if (request.sql.startsWith('EXPLAIN (FORMAT JSON)')) {
        return Promise.resolve(
          ok({
            queryId: 'explain-1',
            columns: [{ name: 'QUERY PLAN', dataType: 'json' }],
            rows: [
              {
                'QUERY PLAN': [
                  {
                    Plan: {
                      'Node Type': 'Aggregate',
                      'Total Cost': 42.5,
                    },
                  },
                ],
              },
            ],
            rowCount: 1,
            returnedRowCount: 1,
            elapsedMs: 2,
            safety: safety('EXPLAIN'),
          }),
        );
      }
      const kind = request.sql.trim().split(/\s+/)[0]!.toUpperCase();
      return Promise.resolve(
        ok({
          ...queryResult(kind === 'SELECT' ? 250 : 0),
          queryId: `query-${requests.length}`,
          safety: safety(kind),
          ...(kind === 'ALTER'
            ? {
                transaction: {
                  mode: 'auto' as const,
                  started: true,
                  committed: true,
                  rolledBack: false,
                  rollbackOnly: false,
                },
              }
            : {}),
        }),
      );
    },
    listTables: (): Promise<Result<TableSummary[]>> =>
      Promise.resolve(ok([{ schema: 'public', name: 'orders', type: 'table' }])),
    describeTable: () => Promise.resolve(ok(ordersTable())),
  };
}

type ResourceListOutput = {
  resources: Array<{ name: string; kind: string }>;
};

type ResourceDetailOutput = {
  resource: { name: string; displayName: string };
  columns: Array<{
    name: string;
    facts: { dataType?: string };
  }>;
};

type KnowledgeSearchOutput = {
  items: Array<{
    document: {
      kind: string;
      table?: string;
      title: string;
    };
  }>;
};

type SqlExecutionToolOutput = {
  resultHandleId: string;
  rows: unknown[];
  storedRowCount: number;
  previewTruncated: boolean;
};

function queryResult(rowCount: number): QueryExecutionResult {
  return {
    queryId: 'query-result',
    columns: [
      { name: 'id', dataType: 'integer' },
      { name: 'payload', dataType: 'jsonb' },
    ],
    rows: Array.from({ length: rowCount }, (_, index) => ({
      id: index + 1,
      payload: { status: index % 2 === 0 ? 'paid' : 'pending' },
    })),
    rowCount,
    returnedRowCount: rowCount,
    elapsedMs: 4,
    safety: safety('SELECT'),
  };
}

function safety(statementKind: string) {
  return {
    statementKind,
    riskLevel: 'safe' as const,
    requiresConfirmation: false,
    blocked: false,
    reasons: [],
  };
}

function ordersTable(): TableDetail {
  return {
    schema: 'public',
    name: 'orders',
    type: 'table',
    comment: '订单事实表，payload 保存来自 Kafka 的 JSON 数据',
    primaryKey: ['id'],
    columns: [
      {
        name: 'id',
        ordinal: 1,
        dataType: 'bigint',
        nullable: false,
        isPrimaryKey: true,
      },
      {
        name: 'customer_id',
        ordinal: 2,
        dataType: 'bigint',
        nullable: false,
        isPrimaryKey: false,
      },
      {
        name: 'payload',
        ordinal: 3,
        dataType: 'jsonb',
        nullable: false,
        isPrimaryKey: false,
      },
      {
        name: 'created_at',
        ordinal: 4,
        dataType: 'timestamptz',
        nullable: false,
        isPrimaryKey: false,
      },
    ],
  };
}

function connection(): SavedConnection {
  return {
    id: 'conn_1',
    name: 'Writable PostgreSQL',
    engine: 'postgres',
    host: '127.0.0.1',
    port: 5432,
    database: 'dbagent',
    username: 'tester',
    readOnly: false,
    status: 'connected',
    createdAt: '2026-07-24T00:00:00.000Z',
    updatedAt: '2026-07-24T00:00:00.000Z',
  };
}

function context(sessionId: string): AgentToolContext {
  return {
    session: {
      id: sessionId,
      title: 'AI SQL tool test',
      mode: 'full',
      messages: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      aborted: false,
    },
  };
}

function approvedToolContext(input: {
  sessionId: string;
  toolCallId: string;
  requiredPermission: AgentAccessMode;
  requestId: string;
}): AgentToolContext {
  const approval: AgentToolApproval = {
    granted: true,
    source: 'approval-provider',
    sessionId: input.sessionId,
    toolCallId: input.toolCallId,
    toolName: 'sql_execute',
    grantedPermission: input.requiredPermission,
    approvedAt: '2026-07-26T00:00:00.000Z',
    requestId: input.requestId,
  };
  const toolContext = context(input.sessionId);
  toolContext.session.mode = 'read';
  toolContext.invocation = {
    toolCallId: input.toolCallId,
    toolName: 'sql_execute',
    requiredPermission: input.requiredPermission,
  };
  toolContext.approval = approval;
  toolContext.executionGrant = createSingleToolCallExecutionGrant(approval);
  return toolContext;
}
