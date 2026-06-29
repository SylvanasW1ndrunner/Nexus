import { describe, expect, it } from 'vitest';
import type { TableDetail } from '@dbagent/shared';
import {
  buildSchemaDocuments,
  extractExplicitSchemaReferences,
  SchemaRagEngine,
} from '../src/index.js';

describe('extractExplicitSchemaReferences', () => {
  it('parses explicit table and column references from user questions', () => {
    expect(
      extractExplicitSchemaReferences('Compare @public.orders and @public.orders.total_amount'),
    ).toEqual([
      { raw: 'public.orders', schema: 'public', table: 'orders' },
      {
        raw: 'public.orders.total_amount',
        schema: 'public',
        table: 'orders',
        column: 'total_amount',
      },
    ]);
    expect(extractExplicitSchemaReferences('Inspect @"Sales Data"."Order Items".sku')).toEqual([
      {
        raw: '"Sales Data"."Order Items".sku',
        schema: 'Sales Data',
        table: 'Order Items',
        column: 'sku',
      },
    ]);
  });
});

describe('buildSchemaDocuments', () => {
  it('turns tables and columns into stable schema documents', () => {
    const documents = buildSchemaDocuments({ connectionId: 'conn_1', tables: fixtureTables() });

    expect(documents.map((document) => document.id)).toContain('table:public.orders');
    expect(documents.map((document) => document.id)).toContain('column:public.orders.user_id');
    expect(documents.find((document) => document.id === 'table:public.orders')).toMatchObject({
      title: 'public.orders',
      kind: 'table',
      metadata: { primaryKey: ['id'], columnCount: 4 },
    });
  });

  it('links foreign-key columns and related tables', () => {
    const documents = buildSchemaDocuments({ connectionId: 'conn_1', tables: fixtureTables() });
    const userId = documents.find((document) => document.id === 'column:public.orders.user_id');
    const users = documents.find((document) => document.id === 'table:public.users');

    expect(userId?.relationIds).toContain('table:public.users');
    expect(users?.relationIds).toContain('column:public.orders.user_id');
  });
});

describe('SchemaRagEngine', () => {
  it('retrieves a table by explicit table name and expands related columns', () => {
    const engine = indexedEngine();

    const results = engine.search({ connectionId: 'conn_1', query: 'orders', limit: 4 });

    expect(results[0]?.document.id).toBe('table:public.orders');
    expect(results.map((result) => result.document.id)).toContain('column:public.orders.user_id');
    expect(results[0]?.reasons).toContain('token:orders');
  });

  it('prioritizes explicit schema table references over fuzzy token matches', () => {
    const engine = indexedEngine();

    const results = engine.search({
      connectionId: 'conn_1',
      query: 'Ignore the broad order discussion and inspect @public.order_items',
      limit: 4,
    });

    expect(results[0]?.document.id).toBe('table:public.order_items');
    expect(results[0]?.reasons).toContain('explicit-table');
    expect(
      engine
        .getRelations({ connectionId: 'conn_1', table: 'public.order_items' })
        .relatedTables.map((table) => table.id),
    ).toContain('table:public.orders');
  });

  it('prioritizes explicit column references while keeping table context available', () => {
    const engine = indexedEngine();

    const results = engine.search({
      connectionId: 'conn_1',
      query: 'Explain @public.orders.total_amount',
      limit: 4,
    });

    expect(results[0]?.document.id).toBe('column:public.orders.total_amount');
    expect(results[0]?.reasons).toContain('explicit-column');
    expect(results.map((result) => result.document.id)).toContain('table:public.orders');
  });

  it('upserts on-demand table details into an existing skeleton index', () => {
    const engine = new SchemaRagEngine();
    engine.index({
      connectionId: 'conn_1',
      tables: [
        {
          schema: 'archive',
          name: 'cold_orders',
          type: 'table',
          comment: 'Cold order archive skeleton',
          primaryKey: [],
          columns: [],
        },
      ],
    });

    engine.upsertTables({
      connectionId: 'conn_1',
      tables: [
        {
          schema: 'archive',
          name: 'cold_orders',
          type: 'table',
          comment: 'Cold order archive with refund and retention facts',
          primaryKey: ['id'],
          columns: [
            column('id', 1, 'uuid', false, 'archive id', true),
            column('refund_amount', 2, 'numeric', false, 'refund amount'),
          ],
        },
      ],
    });

    const description = engine.describeTable({
      connectionId: 'conn_1',
      table: 'archive.cold_orders',
    });
    expect(description.columns.map((item) => item.id)).toContain(
      'column:archive.cold_orders.refund_amount',
    );
    expect(
      engine.search({ connectionId: 'conn_1', query: '@archive.cold_orders refund', limit: 3 })[0]
        ?.document.id,
    ).toBe('table:archive.cold_orders');
  });

  it('retrieves Chinese business comments for user-facing questions', () => {
    const engine = indexedEngine();

    const results = engine.search({ connectionId: 'conn_1', query: '订单金额', limit: 3 });

    expect(results.map((result) => result.document.id)).toContain(
      'column:public.orders.total_amount',
    );
  });

  it('retrieves relation context when the question crosses tables', () => {
    const engine = indexedEngine();

    const results = engine.search({ connectionId: 'conn_1', query: '用户订单', limit: 6 });

    expect(results.map((result) => result.document.id)).toContain('table:public.users');
    expect(results.map((result) => result.document.id)).toContain('table:public.orders');
  });

  it('uses business glossary terms to retrieve schema that does not share literal tokens', () => {
    const engine = new SchemaRagEngine();
    engine.index({
      connectionId: 'conn_1',
      tables: fixtureTables(),
      indexedAt: '2026-06-17T00:00:00.000Z',
      glossary: [
        {
          term: 'GMV',
          aliases: ['成交额', '销售额'],
          description: '订单总金额，通常按 orders.total_amount 汇总',
          documentIds: ['table:public.orders', 'column:public.orders.total_amount'],
          weight: 60,
        },
      ],
    });

    const results = engine.search({ connectionId: 'conn_1', query: '按月统计 GMV', limit: 4 });

    expect(results.map((result) => result.document.id)).toContain(
      'column:public.orders.total_amount',
    );
    expect(results.map((result) => result.document.id)).toContain('table:public.orders');
    expect(
      results.find((result) => result.document.id === 'column:public.orders.total_amount')?.reasons,
    ).toContain('glossary:GMV');
  });

  it('ignores glossary entries that point to missing schema documents', () => {
    const engine = new SchemaRagEngine();
    const index = engine.index({
      connectionId: 'conn_1',
      tables: fixtureTables(),
      glossary: [
        {
          term: '不存在指标',
          documentIds: ['table:public.missing_table'],
        },
      ],
    });

    expect(index.glossary).toEqual([]);
    expect(engine.search({ connectionId: 'conn_1', query: '不存在指标', limit: 3 })).toEqual([]);
  });

  it('keeps glossary isolated per connection', () => {
    const engine = new SchemaRagEngine();
    engine.index({
      connectionId: 'conn_1',
      tables: fixtureTables(),
      glossary: [{ term: 'GMV', documentIds: ['column:public.orders.total_amount'] }],
    });
    engine.index({ connectionId: 'conn_2', tables: fixtureTables() });

    expect(
      engine
        .search({ connectionId: 'conn_1', query: 'GMV', limit: 3 })
        .map((result) => result.document.id),
    ).toContain('column:public.orders.total_amount');
    expect(engine.search({ connectionId: 'conn_2', query: 'GMV', limit: 3 })).toEqual([]);
  });

  it('builds a token-budgeted context for agent prompts', () => {
    const engine = indexedEngine();

    const context = engine.buildContext({
      connectionId: 'conn_1',
      query: '订单金额和用户邮箱',
      maxChars: 260,
      limit: 8,
    });

    expect(context.text).toContain('## public.orders');
    expect(context.text.length).toBeLessThanOrEqual(260);
    expect(context.truncated).toBe(true);
  });

  it('lists indexed tables for lightweight Agent schema browsing', () => {
    const engine = indexedEngine();

    const tables = engine.listTables({ connectionId: 'conn_1', schema: 'public', limit: 2 });

    expect(tables).toEqual([
      {
        id: 'table:public.order_items',
        schema: 'public',
        table: 'order_items',
        title: 'public.order_items',
        type: 'table',
        columnCount: 4,
      },
      {
        id: 'table:public.orders',
        schema: 'public',
        table: 'orders',
        title: 'public.orders',
        type: 'table',
        columnCount: 4,
      },
    ]);
  });

  it('describes a table with columns and related tables for Agent tools', () => {
    const engine = indexedEngine();

    const description = engine.describeTable({
      connectionId: 'conn_1',
      table: 'public.orders',
      maxChars: 800,
    });

    expect(description.table.id).toBe('table:public.orders');
    expect(description.columns.map((column) => column.id)).toContain(
      'column:public.orders.total_amount',
    );
    expect(description.relatedTables.map((table) => table.id)).toEqual([
      'table:public.order_items',
      'table:public.users',
    ]);
    expect(description.text).toContain('## public.orders');
    expect(description.truncated).toBe(false);
  });

  it('returns direct relation documents for a table', () => {
    const engine = indexedEngine();

    const relations = engine.getRelations({
      connectionId: 'conn_1',
      table: 'orders',
      schema: 'public',
    });

    expect(relations.table.id).toBe('table:public.orders');
    expect(relations.relatedTables.map((table) => table.id)).toEqual([
      'table:public.order_items',
      'table:public.users',
    ]);
    expect(relations.relationDocuments.map((document) => document.id)).toContain(
      'column:public.orders.user_id',
    );
  });

  it('rejects ambiguous bare table references so Agent asks for schema instead of guessing', () => {
    const engine = new SchemaRagEngine();
    engine.index({
      connectionId: 'conn_1',
      tables: [
        ...fixtureTables(),
        {
          schema: 'reporting',
          name: 'orders',
          type: 'table',
          primaryKey: ['id'],
          columns: [column('id', 1, 'uuid', false, 'report order id', true)],
        },
      ],
    });

    expect(() => engine.describeTable({ connectionId: 'conn_1', table: 'orders' })).toThrow(
      'Schema RAG table reference is ambiguous: orders',
    );
  });

  it('clears per-connection indexes on disconnect', () => {
    const engine = indexedEngine();

    engine.clear('conn_1');

    expect(() => engine.search({ connectionId: 'conn_1', query: 'orders' })).toThrow(
      'Schema RAG index is not available for connection: conn_1',
    );
  });
});

function indexedEngine(): SchemaRagEngine {
  const engine = new SchemaRagEngine();
  engine.index({
    connectionId: 'conn_1',
    tables: fixtureTables(),
    indexedAt: '2026-06-17T00:00:00.000Z',
  });
  return engine;
}

function fixtureTables(): TableDetail[] {
  return [
    {
      schema: 'public',
      name: 'users',
      type: 'table',
      comment: '用户主表，保存邮箱和注册信息',
      primaryKey: ['id'],
      columns: [
        column('id', 1, 'uuid', false, '用户 ID', true),
        column('email', 2, 'text', false, '用户邮箱'),
      ],
    },
    {
      schema: 'public',
      name: 'orders',
      type: 'table',
      comment: '订单事实表，保存每笔订单金额和归属用户',
      primaryKey: ['id'],
      columns: [
        column('id', 1, 'uuid', false, '订单 ID', true),
        {
          ...column('user_id', 2, 'uuid', false, '下单用户 ID'),
          foreignKey: { schema: 'public', table: 'users', column: 'id' },
        },
        column('total_amount', 3, 'numeric', false, '订单金额'),
        column('created_at', 4, 'timestamptz', false, '下单时间'),
      ],
    },
    {
      schema: 'public',
      name: 'order_items',
      type: 'table',
      comment: '订单明细表，记录商品和数量',
      primaryKey: ['id'],
      columns: [
        column('id', 1, 'uuid', false, '明细 ID', true),
        {
          ...column('order_id', 2, 'uuid', false, '订单 ID'),
          foreignKey: { schema: 'public', table: 'orders', column: 'id' },
        },
        column('sku', 3, 'text', false, '商品编码'),
        column('quantity', 4, 'integer', false, '数量'),
      ],
    },
  ];
}

function column(
  name: string,
  ordinal: number,
  dataType: string,
  nullable: boolean,
  comment?: string,
  isPrimaryKey = false,
) {
  return {
    name,
    ordinal,
    dataType,
    nullable,
    comment,
    isPrimaryKey,
  };
}
