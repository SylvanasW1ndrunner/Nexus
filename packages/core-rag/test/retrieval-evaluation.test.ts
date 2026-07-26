import { describe, expect, it } from 'vitest';
import type { TableDetail } from '@dbagent/shared';
import { evaluateSchemaRagRetrieval, SchemaRagEngine } from '../src/index.js';
import { column } from './schema-fixtures.js';

describe('evaluateSchemaRagRetrieval', () => {
  it('measures user-facing retrieval quality with required and optional schema hits', () => {
    const engine = indexedEngine();

    const summary = evaluateSchemaRagRetrieval({
      connectionId: 'conn_eval',
      search: (request) => engine.search(request),
      cases: [
        {
          id: 'RAG-001',
          query: '用户邮箱',
          mustInclude: ['column:public.users.email'],
          shouldInclude: ['table:public.users'],
          mustNotInclude: ['table:public.products'],
        },
        {
          id: 'RAG-002',
          query: '订单金额和下单用户',
          mustInclude: ['table:public.orders', 'column:public.orders.total_amount', 'column:public.orders.user_id'],
          shouldInclude: ['table:public.users'],
          limit: 6,
        },
      ],
    });

    expect(summary).toMatchObject({
      totalCases: 2,
      passedCases: 2,
      failedCases: 0,
      passRate: 1,
      averageMustHitRate: 1,
    });
    expect(summary.results[0]).toMatchObject({
      id: 'RAG-001',
      passed: true,
      missingMustInclude: [],
      unexpectedIds: [],
    });
  });

  it('evaluates glossary-assisted business metrics from user wording', () => {
    const engine = new SchemaRagEngine();
    engine.index({
      connectionId: 'conn_eval',
      tables: fixtureTables(),
      indexedAt: '2026-06-18T00:00:00.000Z',
      glossary: [
        {
          term: '客单价',
          aliases: ['AOV', '平均订单金额'],
          description: '订单金额除以下单用户或订单数，使用 orders.total_amount',
          documentIds: ['table:public.orders', 'column:public.orders.total_amount', 'column:public.orders.user_id'],
        },
      ],
    });

    const summary = evaluateSchemaRagRetrieval({
      connectionId: 'conn_eval',
      search: (request) => engine.search(request),
      cases: [
        {
          id: 'RAG-GLOSSARY-001',
          query: '最近 30 天客单价',
          mustInclude: ['table:public.orders', 'column:public.orders.total_amount'],
          shouldInclude: ['column:public.orders.user_id'],
          limit: 5,
        },
      ],
    });

    expect(summary).toMatchObject({
      totalCases: 1,
      passedCases: 1,
      failedCases: 0,
      passRate: 1,
    });
  });

  it('reports missing required documents without hiding partial recall', () => {
    const engine = indexedEngine();

    const summary = evaluateSchemaRagRetrieval({
      connectionId: 'conn_eval',
      search: (request) => engine.search(request),
      cases: [
        {
          id: 'RAG-003',
          query: '用户邮箱',
          mustInclude: ['column:public.users.email', 'table:public.products'],
          shouldInclude: ['column:public.products.name'],
          limit: 3,
        },
      ],
    });

    expect(summary.failedCases).toBe(1);
    expect(summary.passRate).toBe(0);
    expect(summary.results[0]).toMatchObject({
      passed: false,
      missingMustInclude: ['table:public.products'],
      missingShouldInclude: ['column:public.products.name'],
      mustHitRate: 0.5,
      shouldHitRate: 0,
    });
  });
});

function indexedEngine(): SchemaRagEngine {
  const engine = new SchemaRagEngine();
  engine.index({ connectionId: 'conn_eval', tables: fixtureTables(), indexedAt: '2026-06-18T00:00:00.000Z' });
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
      columns: [column('id', 1, 'uuid', false, '用户 ID', true), column('email', 2, 'text', false, '用户邮箱')],
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
      ],
    },
    {
      schema: 'public',
      name: 'products',
      type: 'table',
      comment: '商品主数据',
      primaryKey: ['sku'],
      columns: [column('sku', 1, 'text', false, '商品编码', true), column('name', 2, 'text', false, '商品名称')],
    },
  ];
}
