import { describe, expect, it } from 'vitest';
import type { TableConstraintSummary, TableDetail, TableIndexSummary } from '@dbagent/shared';
import { buildSchemaDocuments, SchemaRagEngine } from '../src/index.js';

describe('Schema RAG catalog metadata', () => {
  it('keeps PostgreSQL catalog metadata in table documents and Agent context', () => {
    const documents = buildSchemaDocuments({
      connectionId: 'catalog_conn',
      tables: catalogTables(),
    });
    const orders = documents.find((document) => document.id === 'table:public.orders');
    const paidSummary = documents.find(
      (document) => document.id === 'table:reporting.paid_order_summary',
    );

    expect(orders?.metadata.rowEstimate).toBe(120000);
    const orderIndexes = orders?.metadata.indexes as TableIndexSummary[] | undefined;
    expect(
      orderIndexes?.find((index) => index.name === 'idx_orders_customer_created_at'),
    ).toMatchObject({
      method: 'btree',
      unique: false,
    });
    const orderConstraints = orders?.metadata.constraints as TableConstraintSummary[] | undefined;
    expect(
      orderConstraints?.find((constraint) => constraint.name === 'chk_orders_amount_nonnegative'),
    ).toMatchObject({
      type: 'check',
    });
    expect(
      orderConstraints?.find((constraint) => constraint.name === 'uq_orders_order_no'),
    ).toMatchObject({
      type: 'unique',
      columns: ['order_no'],
    });
    expect(orders?.text).toContain('估算行数');
    expect(orders?.text).toContain('idx_orders_customer_created_at');
    expect(orders?.text).toContain('total_amount >= 0');
    expect(paidSummary?.text).toContain('视图定义');
    expect(paidSummary?.text).toContain('sum(total_amount)');
  });

  it('retrieves tables and views by index, constraint, and view-definition terms', () => {
    const engine = new SchemaRagEngine();
    engine.index({ connectionId: 'catalog_conn', tables: catalogTables() });

    const indexResults = engine.search({
      connectionId: 'catalog_conn',
      query: 'customer created_at index idx_orders_customer_created_at',
      limit: 4,
    });
    const constraintResults = engine.search({
      connectionId: 'catalog_conn',
      query: 'negative amount check total_amount',
      limit: 4,
    });
    const viewResults = engine.search({
      connectionId: 'catalog_conn',
      query: 'paid order summary view sum total_amount',
      limit: 4,
    });
    const description = engine.describeTable({
      connectionId: 'catalog_conn',
      table: 'public.orders',
      maxChars: 1200,
    });

    expect(indexResults.map((result) => result.document.id)).toContain('table:public.orders');
    expect(constraintResults.map((result) => result.document.id)).toContain('table:public.orders');
    expect(viewResults.map((result) => result.document.id)).toContain(
      'table:reporting.paid_order_summary',
    );
    expect(description.text).toContain('idx_orders_customer_created_at');
    expect(description.text).toContain('uq_orders_order_no');
  });
});

function catalogTables(): TableDetail[] {
  return [
    {
      schema: 'public',
      name: 'orders',
      type: 'table',
      comment: 'order fact table used for GMV and refund analysis',
      rowEstimate: 120000,
      primaryKey: ['id'],
      indexes: [
        {
          name: 'orders_pkey',
          method: 'btree',
          columns: ['id'],
          unique: true,
          primary: true,
          valid: true,
          definition: 'CREATE UNIQUE INDEX orders_pkey ON public.orders USING btree (id)',
        },
        {
          name: 'idx_orders_customer_created_at',
          method: 'btree',
          columns: ['customer_id', 'created_at'],
          unique: false,
          primary: false,
          valid: true,
          definition:
            'CREATE INDEX idx_orders_customer_created_at ON public.orders USING btree (customer_id, created_at)',
        },
      ],
      constraints: [
        {
          name: 'orders_pkey',
          type: 'primary_key',
          columns: ['id'],
          definition: 'PRIMARY KEY (id)',
        },
        {
          name: 'uq_orders_order_no',
          type: 'unique',
          columns: ['order_no'],
          definition: 'UNIQUE (order_no)',
        },
        {
          name: 'chk_orders_amount_nonnegative',
          type: 'check',
          columns: ['total_amount'],
          definition: 'CHECK (total_amount >= 0)',
        },
      ],
      columns: [
        {
          name: 'id',
          ordinal: 1,
          dataType: 'bigint',
          nullable: false,
          isPrimaryKey: true,
          isIndexed: true,
          isUnique: true,
        },
        {
          name: 'customer_id',
          ordinal: 2,
          dataType: 'bigint',
          nullable: false,
          isPrimaryKey: false,
          isIndexed: true,
        },
        {
          name: 'order_no',
          ordinal: 3,
          dataType: 'text',
          nullable: false,
          isPrimaryKey: false,
          isIndexed: true,
          isUnique: true,
        },
        {
          name: 'total_amount',
          ordinal: 4,
          dataType: 'numeric(12,2)',
          nullable: false,
          isPrimaryKey: false,
        },
        {
          name: 'created_at',
          ordinal: 5,
          dataType: 'timestamptz',
          nullable: false,
          isPrimaryKey: false,
          isIndexed: true,
        },
      ],
    },
    {
      schema: 'reporting',
      name: 'paid_order_summary',
      type: 'view',
      comment: 'paid order summary view for analysts',
      rowEstimate: 1000,
      viewDefinition:
        "SELECT customer_id, count(*) AS order_count, sum(total_amount) AS gmv FROM public.orders WHERE status = 'paid' GROUP BY customer_id",
      primaryKey: [],
      columns: [
        {
          name: 'customer_id',
          ordinal: 1,
          dataType: 'bigint',
          nullable: false,
          isPrimaryKey: false,
        },
        {
          name: 'order_count',
          ordinal: 2,
          dataType: 'bigint',
          nullable: false,
          isPrimaryKey: false,
        },
        { name: 'gmv', ordinal: 3, dataType: 'numeric', nullable: true, isPrimaryKey: false },
      ],
    },
  ];
}
