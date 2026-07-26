import { describe, expect, it } from 'vitest';
import { err, ok, type Result, type TableDetail } from '@dbagent/shared';
import {
  ensureSchemaCatalogTablesIndexed,
  indexSchemaCatalogFromReader,
  ProgressiveSchemaRagIndexer,
  SchemaRagEngine,
  type SchemaCatalogReader,
  type SchemaCatalogTableSummary,
} from '../src/index.js';

describe('indexSchemaCatalogFromReader', () => {
  it('filters database catalog tables and builds a progressive Schema RAG index', async () => {
    const engine = new SchemaRagEngine();
    const result = await indexSchemaCatalogFromReader({
      connectionId: 'warehouse',
      reader: fakeCatalogReader([ordersTable(), trafficSessionsTable(), internalAuditTable()]),
      indexer: new ProgressiveSchemaRagIndexer({ engine }),
      includeSchemas: ['public', 'analytics'],
      hotTableLimit: 1,
      indexedAt: '2026-06-29T00:00:00.000Z',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      requestedTableCount: 2,
      indexedTableCount: 2,
      skippedTableCount: 0,
    });
    expect(
      result.data.status.stages.map((stage) => [stage.stage, stage.done, stage.total]),
    ).toEqual([
      ['skeleton', 2, 2],
      ['hot_tables', 1, 1],
      ['long_tail', 1, 1],
      ['ready', 1, 1],
    ]);
    expect(
      engine
        .search({ connectionId: 'warehouse', query: 'GMV campaign conversion', limit: 6 })
        .map((item) => item.document.id),
    ).toEqual(expect.arrayContaining(['table:public.orders', 'table:analytics.traffic_sessions']));
  });

  it('on-demand indexes explicitly referenced cold tables from the database catalog', async () => {
    const engine = new SchemaRagEngine();
    const indexer = new ProgressiveSchemaRagIndexer({ engine });
    const reader = fakeCatalogReader([ordersTable(), refundsTable()]);
    await indexSchemaCatalogFromReader({
      connectionId: 'warehouse',
      reader,
      indexer,
      includeSchemas: ['public'],
      tableLimit: 1,
    });

    expect(engine.hasTable({ connectionId: 'warehouse', table: 'public.refunds' })).toBe(false);

    const result = await ensureSchemaCatalogTablesIndexed({
      connectionId: 'warehouse',
      reader,
      indexer,
      references: ['@public.refunds'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.indexedTableCount).toBe(1);
    expect(result.data.skippedReferenceCount).toBe(0);
    expect(engine.hasTable({ connectionId: 'warehouse', table: 'public.refunds' })).toBe(true);
    expect(
      engine.search({
        connectionId: 'warehouse',
        query: '@public.refunds refund approval',
        limit: 4,
      })[0]?.document.id,
    ).toBe('table:public.refunds');
  });

  it('reports ambiguous or missing on-demand references without mutating the index', async () => {
    const engine = new SchemaRagEngine();
    const indexer = new ProgressiveSchemaRagIndexer({ engine });
    const result = await ensureSchemaCatalogTablesIndexed({
      connectionId: 'warehouse',
      reader: fakeCatalogReader([ordersTable(), reportingOrdersTable()]),
      indexer,
      references: ['@orders', '@public.missing_table'],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
    expect(engine.hasIndex('warehouse')).toBe(false);
  });

  it('continues indexing available tables and reports catalog warnings when a table describe fails', async () => {
    const engine = new SchemaRagEngine();
    const result = await indexSchemaCatalogFromReader({
      connectionId: 'warehouse',
      reader: fakeCatalogReader([ordersTable()], {
        failures: new Set(['public.refunds']),
        extraSummaries: [{ schema: 'public', name: 'refunds', type: 'table' }],
      }),
      indexer: new ProgressiveSchemaRagIndexer({ engine }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.indexedTableCount).toBe(1);
    expect(result.data.skippedTableCount).toBe(1);
    expect(result.data.warnings).toEqual([
      expect.objectContaining({
        schema: 'public',
        table: 'refunds',
        code: 'QUERY_FAILED',
      }),
    ]);
    expect(engine.listTables({ connectionId: 'warehouse' }).map((table) => table.id)).toEqual([
      'table:public.orders',
    ]);
  });

  it('returns the table describe error in strict mode', async () => {
    const result = await indexSchemaCatalogFromReader({
      connectionId: 'warehouse',
      reader: fakeCatalogReader([], {
        extraSummaries: [{ schema: 'public', name: 'orders', type: 'table' }],
        failures: new Set(['public.orders']),
      }),
      indexer: new ProgressiveSchemaRagIndexer({ engine: new SchemaRagEngine() }),
      continueOnTableError: false,
    });

    expect(result).toEqual(
      err({
        code: 'QUERY_FAILED',
        message: 'Cannot inspect public.orders.',
        retryable: true,
      }),
    );
  });

  it('returns the catalog list error before indexing', async () => {
    const reader: SchemaCatalogReader = {
      listTables: () =>
        Promise.resolve(
          err({
            code: 'CONNECTION_FAILED',
            message: 'Database connection is not active.',
            retryable: true,
          }),
        ),
      describeTable: () => {
        throw new Error('describeTable should not be called when listTables fails.');
      },
    };

    const result = await indexSchemaCatalogFromReader({
      connectionId: 'warehouse',
      reader,
      indexer: new ProgressiveSchemaRagIndexer({ engine: new SchemaRagEngine() }),
    });

    expect(result).toEqual(
      err({
        code: 'CONNECTION_FAILED',
        message: 'Database connection is not active.',
        retryable: true,
      }),
    );
  });
});

function fakeCatalogReader(
  tables: TableDetail[],
  options: { extraSummaries?: SchemaCatalogTableSummary[]; failures?: Set<string> } = {},
): SchemaCatalogReader {
  const byName = new Map(tables.map((table) => [`${table.schema}.${table.name}`, table]));
  return {
    listTables() {
      return Promise.resolve(
        ok([
          ...tables.map((table) => ({
            schema: table.schema,
            name: table.name,
            type: table.type,
            ...(table.comment === undefined ? {} : { comment: table.comment }),
          })),
          ...(options.extraSummaries ?? []),
        ]),
      );
    },
    describeTable(
      _connectionId: string,
      schema: string,
      table: string,
    ): Promise<Result<TableDetail>> {
      const key = `${schema}.${table}`;
      if (options.failures?.has(key)) {
        return Promise.resolve(
          err({
            code: 'QUERY_FAILED',
            message: `Cannot inspect ${key}.`,
            retryable: true,
          }),
        );
      }
      const detail = byName.get(key);
      return Promise.resolve(
        detail ? ok(detail) : err({ code: 'NOT_FOUND', message: `${key} not found.` }),
      );
    },
  };
}

function ordersTable(): TableDetail {
  return {
    schema: 'public',
    name: 'orders',
    type: 'table',
    comment: 'ecommerce order fact table with GMV and payment status',
    primaryKey: ['id'],
    columns: [
      { name: 'id', ordinal: 1, dataType: 'uuid', nullable: false, isPrimaryKey: true },
      {
        name: 'customer_id',
        ordinal: 2,
        dataType: 'uuid',
        nullable: false,
        isPrimaryKey: false,
      },
      {
        name: 'total_amount',
        ordinal: 3,
        dataType: 'numeric',
        nullable: false,
        comment: 'GMV amount',
        isPrimaryKey: false,
      },
    ],
  };
}

function trafficSessionsTable(): TableDetail {
  return {
    schema: 'analytics',
    name: 'traffic_sessions',
    type: 'table',
    comment: 'traffic analysis sessions with campaign conversion data',
    primaryKey: ['session_id'],
    columns: [
      { name: 'session_id', ordinal: 1, dataType: 'uuid', nullable: false, isPrimaryKey: true },
      {
        name: 'converted_order_id',
        ordinal: 2,
        dataType: 'uuid',
        nullable: true,
        isPrimaryKey: false,
        foreignKey: { schema: 'public', table: 'orders', column: 'id' },
      },
      {
        name: 'utm_source',
        ordinal: 3,
        dataType: 'text',
        nullable: true,
        isPrimaryKey: false,
      },
    ],
  };
}

function refundsTable(): TableDetail {
  return {
    schema: 'public',
    name: 'refunds',
    type: 'table',
    comment: 'refund workflow table with approval status and refund amount',
    primaryKey: ['id'],
    columns: [
      { name: 'id', ordinal: 1, dataType: 'uuid', nullable: false, isPrimaryKey: true },
      {
        name: 'order_id',
        ordinal: 2,
        dataType: 'uuid',
        nullable: false,
        isPrimaryKey: false,
      },
      {
        name: 'refund_amount',
        ordinal: 3,
        dataType: 'numeric',
        nullable: false,
        isPrimaryKey: false,
      },
    ],
  };
}

function reportingOrdersTable(): TableDetail {
  return {
    schema: 'reporting',
    name: 'orders',
    type: 'view',
    comment: 'reporting order view for analyst dashboards',
    primaryKey: [],
    columns: [
      {
        name: 'id',
        ordinal: 1,
        dataType: 'uuid',
        nullable: false,
        isPrimaryKey: false,
      },
    ],
  };
}

function internalAuditTable(): TableDetail {
  return {
    schema: 'internal',
    name: 'audit_log',
    type: 'table',
    comment: 'internal audit table excluded from analyst schema indexing',
    primaryKey: ['id'],
    columns: [{ name: 'id', ordinal: 1, dataType: 'uuid', nullable: false, isPrimaryKey: true }],
  };
}
