import { describe, expect, it } from 'vitest';
import type { TableDetail } from '@dbagent/shared';
import { buildSchemaDocuments, SchemaRagEngine } from '../src/index.js';

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

  it('retrieves Chinese business comments for user-facing questions', () => {
    const engine = indexedEngine();

    const results = engine.search({ connectionId: 'conn_1', query: '订单金额', limit: 3 });

    expect(results.map((result) => result.document.id)).toContain('column:public.orders.total_amount');
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

    expect(results.map((result) => result.document.id)).toContain('column:public.orders.total_amount');
    expect(results.map((result) => result.document.id)).toContain('table:public.orders');
    expect(results.find((result) => result.document.id === 'column:public.orders.total_amount')?.reasons).toContain(
      'glossary:GMV',
    );
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

    expect(engine.search({ connectionId: 'conn_1', query: 'GMV', limit: 3 }).map((result) => result.document.id)).toContain(
      'column:public.orders.total_amount',
    );
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
  engine.index({ connectionId: 'conn_1', tables: fixtureTables(), indexedAt: '2026-06-17T00:00:00.000Z' });
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
