import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry, type AgentToolContext } from '@dbagent/core-agent';
import type { IDatabaseDriver } from '@dbagent/core-db';
import { SchemaRagEngine } from '@dbagent/core-rag';
import {
  err,
  ok,
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

    const root = (await harness.registry
      .get('resource_list')!
      .handler({}, context('session-a'))) as ResourceListOutput;
    expect(
      root.resources.some(
        (resource) =>
          resource.name === 'conn_1' &&
          resource.kind === 'database',
      ),
    ).toBe(true);

    const schemaChildren = (await harness.registry
      .get('resource_list')!
      .handler(
        { scope: 'conn_1' },
        context('session-a'),
      )) as ResourceListOutput;
    expect(
      schemaChildren.resources.some(
        (resource) =>
          resource.name === 'public' &&
          resource.kind === 'schema',
      ),
    ).toBe(true);

    const table = (await harness.registry
      .get('resource_get')!
      .handler(
        { resource: 'public.orders' },
        context('session-a'),
      )) as ResourceDetailOutput;
    expect(table.resource).toMatchObject({
      name: 'public.orders',
      displayName: 'orders',
    });
    expect(
      table.columns.some(
        (column) =>
          column.name === 'public.orders.id' &&
          column.facts.dataType === 'bigint',
      ),
    ).toBe(true);
    expect(
      table.columns.some(
        (column) =>
          column.name === 'public.orders.payload' &&
          column.facts.dataType === 'jsonb',
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

    expect(execute.resolveRequiredPermission?.({ sql: 'SELECT * FROM orders' })).toBe(
      'read',
    );
    expect(
      execute.resolveRequiredPermission?.({
        sql: 'UPDATE orders SET status = \'paid\' WHERE id = 1',
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

    await harness.registry.get('sql_execute')!.handler(
      { sql: 'SELECT id FROM public.orders LIMIT 1' },
      toolContext,
    );

    expect(harness.requests).toEqual([]);
    expect(executions).toHaveLength(1);
    expect(executions[0]?.request.connectionId).toBe('conn_1');
    expect(executions[0]?.request.sql).toBe(
      'SELECT id FROM public.orders LIMIT 1',
    );
    expect(executions[0]?.authorization).toEqual({
      actorId: 'user-alice',
      permissionMode: 'non-high-risk',
    });
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
        resultRead.handler(
          { resultHandleId: output.resultHandleId },
          context('session-b'),
        ),
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

    const explain = await harness.registry
      .get('sql_explain')!
      .handler(
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
    expect(
      typeof (explain as { plan: unknown }).plan,
    ).toBe('object');
    expect(explain).not.toHaveProperty('parsed');
    expect(harness.requests.at(-1)?.sql).toMatch(/^EXPLAIN \(FORMAT JSON\)/);

    await expect(
      Promise.resolve().then(() =>
        harness.registry
          .get('sql_explain')!
          .handler(
            { sql: 'DELETE FROM public.orders WHERE id = 1' },
            context('session-a'),
          ),
      ),
    ).rejects.toThrow('exactly one non-EXPLAIN read query');
  });

  it('expires results, validates cursors, and handles high-volume paging within budget', () => {
    let now = new Date('2026-07-24T00:00:00.000Z');
    let id = 0;
    const store = new AiSqlResultStore({
      ttlMs: 1_000,
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
  const onSchemaChanged =
    vi.fn<NonNullable<AiSqlToolDependencies['onSchemaChanged']>>();
  registerAiSqlTools({
    registry,
    rag,
    driver,
    ...(options.queryExecutor === undefined
      ? {}
      : { queryExecutor: options.queryExecutor }),
    resultStore,
    getActiveConnection: () => ({
      connectionId: 'conn_1',
      connection: connection(),
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

function fakeDriver(
  requests: QueryRequest[],
  failSql?: string,
): IDatabaseDriver {
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
                  committed: true,
                  rolledBack: false,
                },
              }
            : {}),
        }),
      );
    },
    listTables: (): Promise<Result<TableSummary[]>> =>
      Promise.resolve(
        ok([{ schema: 'public', name: 'orders', type: 'table' }]),
      ),
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
      strategy: 'react',
      messages: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      aborted: false,
    },
  };
}
