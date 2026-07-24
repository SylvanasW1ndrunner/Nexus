import { describe, expect, it } from 'vitest';
import type { TableDetail } from '@dbagent/shared';
import { SchemaRagEngine } from '../src/index.js';

describe('hybrid schema retriever', () => {
  it('keeps explicit column references ahead of broader keyword matches', () => {
    const engine = indexedBusinessEngine();

    const results = engine.search({
      connectionId: 'warehouse',
      query: 'Compare campaign traffic but inspect @commerce.orders.refund_status first',
      limit: 5,
    });

    expect(results[0]?.document.id).toBe('column:commerce.orders.refund_status');
    expect(results[0]?.reasons).toEqual(
      expect.arrayContaining(['explicit-column', 'channel:explicit']),
    );
    expect(results[0]?.scoreDetails).toEqual(expect.arrayContaining([
      expect.objectContaining({ channel: 'explicit', reasons: ['explicit-column'] }),
    ]));
    expect(results.map((result) => result.document.id)).toContain('table:commerce.orders');
  });

  it('fuses keyword and glossary channels for business metrics', () => {
    const engine = indexedBusinessEngine();

    const results = engine.search({
      connectionId: 'warehouse',
      query: 'GMV trend for paid orders',
      limit: 6,
    });
    const orders = results.find((result) => result.document.id === 'table:commerce.orders');
    const totalAmount = results.find(
      (result) => result.document.id === 'column:commerce.orders.total_amount',
    );

    expect(orders?.reasons).toEqual(
      expect.arrayContaining(['token:orders', 'glossary:GMV', 'channel:keyword', 'channel:glossary']),
    );
    expect(totalAmount?.reasons).toEqual(
      expect.arrayContaining(['glossary:GMV', 'channel:glossary']),
    );
  });

  it('expands graph context after direct retrieval so joins remain available', () => {
    const engine = indexedBusinessEngine();

    const results = engine.search({
      connectionId: 'warehouse',
      query: 'orders payment status',
      limit: 8,
      includeRelations: true,
    });
    const resultIds = results.map((result) => result.document.id);
    const customer = results.find((result) => result.document.id === 'table:commerce.customers');

    expect(resultIds).toContain('table:commerce.orders');
    expect(resultIds).toContain('table:commerce.customers');
    expect(customer?.reasons.some((reason) => reason.startsWith('graph:'))).toBe(true);
    expect(customer?.scoreDetails).toEqual(expect.arrayContaining([
      expect.objectContaining({ channel: 'graph', reasons: ['graph:table:commerce.orders'] }),
    ]));
  });

  it('can disable graph expansion for strict direct-hit result sets', () => {
    const engine = indexedBusinessEngine();

    const results = engine.search({
      connectionId: 'warehouse',
      query: 'orders payment status',
      limit: 8,
      includeRelations: false,
    });

    expect(results.map((result) => result.document.id)).toContain('table:commerce.orders');
    expect(results.flatMap((result) => result.reasons).some((reason) => reason.startsWith('graph:'))).toBe(
      false,
    );
  });

  it('honors configured graph expansion hops without changing direct-hit priority', () => {
    const engine = indexedBusinessEngine();

    const results = engine.search({
      connectionId: 'warehouse',
      query: '@commerce.customers',
      limit: 10,
      expandHops: 2,
    });

    expect(results[0]?.document.id).toBe('table:commerce.customers');
    expect(results.map((result) => result.document.id)).toContain('table:commerce.orders');
    expect(results.map((result) => result.document.id)).toContain('table:commerce.order_items');
    expect(
      results
        .find((result) => result.document.id === 'table:commerce.order_items')
        ?.reasons,
    ).toEqual(expect.arrayContaining(['channel:graph', 'hop:2']));
  });

  it('keeps retrieval isolated per connection even with the same business terms', () => {
    const engine = indexedBusinessEngine();
    engine.index({
      connectionId: 'traffic',
      tables: trafficTables(),
      glossary: [
        {
          term: 'GMV',
          description: 'Traffic catalog should not expose commerce order revenue documents.',
          documentIds: ['table:analytics.campaign_events'],
        },
      ],
    });

    expect(
      engine
        .search({ connectionId: 'warehouse', query: 'GMV', limit: 5 })
        .map((result) => result.document.id),
    ).toContain('column:commerce.orders.total_amount');
    expect(
      engine
        .search({ connectionId: 'traffic', query: 'GMV', limit: 5 })
        .map((result) => result.document.id),
    ).not.toContain('column:commerce.orders.total_amount');
  });
});

function indexedBusinessEngine(): SchemaRagEngine {
  const engine = new SchemaRagEngine();
  engine.index({
    connectionId: 'warehouse',
    tables: commerceTables(),
    glossary: [
      {
        term: 'GMV',
        aliases: ['gross merchandise value', 'gross revenue'],
        description: 'Paid order amount before refunds, calculated from commerce.orders.total_amount.',
        documentIds: ['table:commerce.orders', 'column:commerce.orders.total_amount'],
        weight: 80,
      },
      {
        term: 'refund risk',
        aliases: ['return risk'],
        description: 'Orders whose refund_status indicates refunded or pending refund.',
        documentIds: ['table:commerce.orders', 'column:commerce.orders.refund_status'],
        weight: 70,
      },
    ],
  });
  return engine;
}

function commerceTables(): TableDetail[] {
  return [
    {
      schema: 'commerce',
      name: 'customers',
      type: 'table',
      comment: 'Customer dimension with email, signup channel, and lifecycle status.',
      primaryKey: ['customer_id'],
      columns: [
        column('customer_id', 1, 'uuid', false, 'customer primary key', true),
        column('email', 2, 'text', false, 'customer email address'),
        column('signup_channel', 3, 'text', true, 'marketing channel where the user signed up'),
      ],
    },
    {
      schema: 'commerce',
      name: 'orders',
      type: 'table',
      comment: 'Commerce order fact table for payment status, refund status, and paid amount.',
      primaryKey: ['order_id'],
      columns: [
        column('order_id', 1, 'uuid', false, 'order primary key', true),
        {
          ...column('customer_id', 2, 'uuid', false, 'customer who placed the order'),
          foreignKey: { schema: 'commerce', table: 'customers', column: 'customer_id' },
        },
        column('total_amount', 3, 'numeric', false, 'paid amount used by GMV reporting'),
        column('payment_status', 4, 'text', false, 'paid, pending, failed, or charged back'),
        column('refund_status', 5, 'text', true, 'none, pending, refunded, or rejected'),
      ],
    },
    {
      schema: 'commerce',
      name: 'order_items',
      type: 'table',
      comment: 'Order line items with sku, quantity, and item level revenue.',
      primaryKey: ['order_item_id'],
      columns: [
        column('order_item_id', 1, 'uuid', false, 'line item primary key', true),
        {
          ...column('order_id', 2, 'uuid', false, 'parent order'),
          foreignKey: { schema: 'commerce', table: 'orders', column: 'order_id' },
        },
        column('sku', 3, 'text', false, 'stock keeping unit'),
        column('quantity', 4, 'integer', false, 'item quantity'),
      ],
    },
  ];
}

function trafficTables(): TableDetail[] {
  return [
    {
      schema: 'analytics',
      name: 'campaign_events',
      type: 'table',
      comment: 'Traffic event stream for campaign impressions, clicks, and conversion funnel visits.',
      primaryKey: ['event_id'],
      columns: [
        column('event_id', 1, 'uuid', false, 'event primary key', true),
        column('campaign_id', 2, 'text', false, 'advertising campaign id'),
        column('visitor_id', 3, 'text', false, 'anonymous visitor id'),
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
