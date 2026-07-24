import { describe, expect, it } from 'vitest';
import type {
  ResourceDescriptor,
  ResourceKind,
  ResourceRelation,
  ResourceSource,
} from '@dbagent/shared';
import {
  buildKnowledgeCatalog,
  buildKnowledgeDocuments,
  diffKnowledgeCatalogs,
  verifyKnowledgeCatalog,
} from '../src/index.js';

const observedAt = '2026-07-24T00:00:00.000Z';
const source: ResourceSource = {
  sourceId: 'test-connector:warehouse',
  sourceType: 'connector',
  connectionProfileId: 'warehouse',
  observedAt,
};

describe('hierarchical knowledge catalog', () => {
  it('builds a navigable tree and applies node/subtree business knowledge correctly', () => {
    const catalog = buildKnowledgeCatalog({
      connectionId: 'warehouse',
      resources: fixtureResources(),
      relations: fixtureRelations(),
      knowledge: [
        {
          id: 'knowledge:commerce-definition',
          title: '交易域口径',
          content: '仅统计 payment_status = paid 的订单。',
          source: { type: 'manual', id: 'finance-team' },
          version: 1,
          updatedAt: observedAt,
        },
        {
          id: 'knowledge:order-note',
          title: '订单表说明',
          content: 'orders 是订单事实表。',
          source: { type: 'manual', id: 'data-team' },
          version: 1,
          updatedAt: observedAt,
        },
      ],
      bindings: [
        {
          id: 'binding:commerce',
          knowledgeId: 'knowledge:commerce-definition',
          resourceId: 'schema:commerce',
          mode: 'subtree',
          version: 1,
          updatedAt: observedAt,
        },
        {
          id: 'binding:orders',
          knowledgeId: 'knowledge:order-note',
          resourceId: 'table:commerce.orders',
          mode: 'node',
          version: 1,
          updatedAt: observedAt,
        },
      ],
      builtAt: observedAt,
    });

    const root = catalog.nodes[catalog.rootIds[0]!];
    const schema = catalog.nodes['schema:commerce'];
    const table = catalog.nodes['table:commerce.orders'];
    const column = catalog.nodes['column:commerce.orders.total_amount'];

    expect(root?.kind).toBe('connection');
    expect(schema?.parentId).toBe('database:warehouse');
    expect(table?.parentId).toBe('schema:commerce');
    expect(table?.ancestorIds).toEqual(
      expect.arrayContaining(['database:warehouse', 'schema:commerce']),
    );
    expect(column?.parentId).toBe('table:commerce.orders');
    expect(column?.path).toContain('warehouse/commerce/orders/total_amount');

    const documents = buildKnowledgeDocuments(catalog);
    expect(
      documents.find((document) => document.id === 'column:commerce.orders.total_amount')
        ?.text,
    ).toContain('仅统计 payment_status = paid');
    expect(
      documents.find((document) => document.id === 'column:commerce.orders.total_amount')
        ?.text,
    ).not.toContain('orders 是订单事实表');
    expect(
      documents.find((document) => document.id === 'table:commerce.orders')?.text,
    ).toContain('orders 是订单事实表');
  });

  it('produces deterministic Merkle roots and reports only the changed leaf fact', () => {
    const first = buildKnowledgeCatalog({
      connectionId: 'warehouse',
      resources: fixtureResources(),
      relations: fixtureRelations(),
      builtAt: '2026-07-24T01:00:00.000Z',
    });
    const reordered = buildKnowledgeCatalog({
      connectionId: 'warehouse',
      resources: [...fixtureResources()].reverse(),
      relations: [...fixtureRelations()].reverse(),
      builtAt: '2026-07-25T01:00:00.000Z',
    });
    expect(reordered.catalogRootHash).toBe(first.catalogRootHash);
    expect(reordered.snapshotId).toBe(first.snapshotId);

    const changedResources = fixtureResources().map((resource) =>
      resource.id === 'column:commerce.orders.total_amount'
        ? {
            ...resource,
            attributes: { ...resource.attributes, dataType: 'numeric(20,4)' },
            version: 2,
          }
        : resource,
    );
    const changed = buildKnowledgeCatalog({
      connectionId: 'warehouse',
      resources: changedResources,
      relations: fixtureRelations(),
      builtAt: observedAt,
    });
    const diff = diffKnowledgeCatalogs(first, changed);

    expect(diff.equal).toBe(false);
    expect(diff.changedResources).toEqual([
      {
        resourceId: 'column:commerce.orders.total_amount',
        kind: 'changed',
      },
    ]);
    expect(changed.nodes['table:commerce.orders']?.subtreeHash).not.toBe(
      first.nodes['table:commerce.orders']?.subtreeHash,
    );
    expect(verifyKnowledgeCatalog(changed).valid).toBe(true);
  });

  it('detects tampering, duplicate parents, cycles, and detached topology', () => {
    const catalog = buildKnowledgeCatalog({
      connectionId: 'warehouse',
      resources: fixtureResources(),
      relations: fixtureRelations(),
      builtAt: observedAt,
    });
    const tampered = structuredClone(catalog);
    tampered.nodes['table:commerce.orders']!.displayName = 'tampered';
    expect(verifyKnowledgeCatalog(tampered).valid).toBe(false);

    expect(() =>
      buildKnowledgeCatalog({
        connectionId: 'warehouse',
        resources: fixtureResources(),
        relations: [
          ...fixtureRelations(),
          relation('contains:database-orders', 'contains', 'database:warehouse', 'table:commerce.orders'),
        ],
      }),
    ).toThrow('multiple containment parents');

    expect(() =>
      buildKnowledgeCatalog({
        connectionId: 'warehouse',
        resources: fixtureResources(),
        relations: [
          ...fixtureRelations().filter(
            (item) => item.id !== 'contains:database-schema',
          ),
          relation('contains:schema-database', 'contains', 'schema:commerce', 'database:warehouse'),
          relation('contains:database-schema-2', 'contains', 'database:warehouse', 'schema:commerce'),
        ],
      }),
    ).toThrow('cycle');
  });

  it('chunks large child sets while keeping each child independently verifiable', () => {
    const resources = [
      resource('database:warehouse', 'database', 'warehouse'),
      resource('schema:wide', 'schema', 'wide'),
      ...Array.from({ length: 300 }, (_, index) =>
        resource(`table:wide.t_${index}`, 'table', `t_${index}`, {
          schema: 'wide',
          table: `t_${index}`,
        }),
      ),
    ];
    const relations = [
      relation('contains:database-wide', 'contains', 'database:warehouse', 'schema:wide'),
      ...Array.from({ length: 300 }, (_, index) =>
        relation(
          `contains:wide-t-${index}`,
          'contains',
          'schema:wide',
          `table:wide.t_${index}`,
        ),
      ),
    ];
    const catalog = buildKnowledgeCatalog({
      connectionId: 'warehouse',
      resources,
      relations,
      builtAt: observedAt,
    });

    expect(catalog.nodes['schema:wide']?.childIds).toHaveLength(300);
    expect(catalog.nodes['schema:wide']?.childBlockHashes).toHaveLength(3);
    expect(verifyKnowledgeCatalog(catalog).valid).toBe(true);
  });

  it('isolates roots and hashes by connection identity', () => {
    const first = buildKnowledgeCatalog({
      connectionId: 'warehouse-a',
      resources: fixtureResources(),
      relations: fixtureRelations(),
      builtAt: observedAt,
    });
    const second = buildKnowledgeCatalog({
      connectionId: 'warehouse-b',
      resources: fixtureResources(),
      relations: fixtureRelations(),
      builtAt: observedAt,
    });

    expect(first.rootIds[0]).not.toBe(second.rootIds[0]);
    expect(first.catalogRootHash).not.toBe(second.catalogRootHash);
  });

  it('lifts a constraint reference to a direct table-to-table retrieval edge', () => {
    const resources = [
      resource('database:warehouse', 'database', 'warehouse'),
      resource('schema:commerce', 'schema', 'commerce'),
      resource('table:commerce.orders', 'table', 'orders'),
      resource('constraint:orders-customer', 'constraint', 'orders_customer_fk'),
      resource('table:commerce.customers', 'table', 'customers'),
    ];
    const catalog = buildKnowledgeCatalog({
      connectionId: 'warehouse',
      resources,
      relations: [
        relation('contains:database-schema', 'contains', 'database:warehouse', 'schema:commerce'),
        relation('contains:schema-orders', 'contains', 'schema:commerce', 'table:commerce.orders'),
        relation(
          'contains:orders-constraint',
          'contains',
          'table:commerce.orders',
          'constraint:orders-customer',
        ),
        relation(
          'contains:schema-customers',
          'contains',
          'schema:commerce',
          'table:commerce.customers',
        ),
        relation(
          'references:orders-customers',
          'references',
          'constraint:orders-customer',
          'table:commerce.customers',
        ),
      ],
      builtAt: observedAt,
    });

    const documents = buildKnowledgeDocuments(catalog);
    expect(
      documents.find((document) => document.id === 'table:commerce.orders')?.relationIds,
    ).toContain('table:commerce.customers');
    expect(
      documents.find((document) => document.id === 'table:commerce.customers')?.relationIds,
    ).toContain('table:commerce.orders');
  });
});

function fixtureResources(): ResourceDescriptor[] {
  return [
    resource('database:warehouse', 'database', 'warehouse'),
    resource('schema:commerce', 'schema', 'commerce'),
    resource('table:commerce.orders', 'table', 'orders', {
      schema: 'commerce',
      table: 'orders',
      comment: 'Order fact table',
    }),
    resource(
      'column:commerce.orders.total_amount',
      'column',
      'total_amount',
      {
        schema: 'commerce',
        table: 'orders',
        column: 'total_amount',
        dataType: 'numeric(18,2)',
      },
    ),
    resource(
      'column:commerce.orders.payment_status',
      'column',
      'payment_status',
      {
        schema: 'commerce',
        table: 'orders',
        column: 'payment_status',
        dataType: 'text',
      },
    ),
  ];
}

function fixtureRelations(): ResourceRelation[] {
  return [
    relation('contains:database-schema', 'contains', 'database:warehouse', 'schema:commerce'),
    relation('contains:schema-orders', 'contains', 'schema:commerce', 'table:commerce.orders'),
    relation(
      'contains:orders-total',
      'contains',
      'table:commerce.orders',
      'column:commerce.orders.total_amount',
    ),
    relation(
      'contains:orders-status',
      'contains',
      'table:commerce.orders',
      'column:commerce.orders.payment_status',
    ),
  ];
}

function resource(
  id: string,
  kind: ResourceKind,
  displayName: string,
  attributes: Record<string, string> = {},
): ResourceDescriptor {
  return {
    id,
    kind,
    nativeId: id,
    canonicalName: id,
    displayName,
    attributes,
    version: 1,
    firstSeenAt: observedAt,
    updatedAt: observedAt,
    sources: [source],
  };
}

function relation(
  id: string,
  kind: string,
  fromResourceId: string,
  toResourceId: string,
): ResourceRelation {
  return {
    id,
    kind,
    fromResourceId,
    toResourceId,
    version: 1,
    firstSeenAt: observedAt,
    updatedAt: observedAt,
    sources: [source],
  };
}
