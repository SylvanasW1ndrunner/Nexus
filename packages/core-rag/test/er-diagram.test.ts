import { describe, expect, it } from 'vitest';
import type { TableDetail } from '@dbagent/shared';
import { generateMermaidErDiagram } from '../src/index.js';

describe('generateMermaidErDiagram', () => {
  it('generates Mermaid ER text from table metadata and foreign keys', () => {
    const diagram = generateMermaidErDiagram(fixtureTables());

    expect(diagram.tableCount).toBe(3);
    expect(diagram.relationCount).toBe(2);
    expect(diagram.mermaid).toContain('erDiagram');
    expect(diagram.mermaid).toContain('public_users {');
    expect(diagram.mermaid).toContain('uuid id "PK,not_null"');
    expect(diagram.mermaid).toContain('uuid user_id "FK,not_null"');
    expect(diagram.mermaid).toContain('public_users ||--o{ public_orders : "user_id -> id"');
    expect(diagram.mermaid).toContain('public_orders ||--o{ public_order_items : "order_id -> id"');
    expect(diagram.warnings).toEqual([]);
  });

  it('limits columns per table and reports truncated tables', () => {
    const diagram = generateMermaidErDiagram(fixtureTables(), { maxColumnsPerTable: 2 });

    expect(diagram.truncatedTables).toEqual(['public.orders', 'public.order_items']);
    expect(diagram.mermaid).toContain('string __more_columns__ "truncated 2 columns"');
    expect(diagram.warnings).toEqual(['Columns were truncated for 2 table(s).']);
  });

  it('generates a selected relation subgraph', () => {
    const diagram = generateMermaidErDiagram(fixtureTables(), {
      selectedTables: [
        { schema: 'public', table: 'users' },
        { schema: 'public', table: 'orders' },
      ],
    });

    expect(diagram.tableCount).toBe(2);
    expect(diagram.relationCount).toBe(1);
    expect(diagram.mermaid).toContain('public_users ||--o{ public_orders');
    expect(diagram.mermaid).not.toContain('public_order_items');
  });

  it('sanitizes identifiers that Mermaid cannot use directly', () => {
    const diagram = generateMermaidErDiagram([
      {
        schema: 'tenant-A',
        name: '2026 orders',
        type: 'table',
        primaryKey: ['id'],
        columns: [column('id', 1, 'bigint', false, undefined, true), column('total.amount', 2, 'numeric(10,2)', false)],
      },
    ]);

    expect(diagram.mermaid).toContain('tenant_A_2026_orders {');
    expect(diagram.mermaid).toContain('numeric total_amount "not_null"');
  });

  it('warns when selected tables are missing and when diagrams are too large', () => {
    const manyTables = Array.from({ length: 31 }, (_, index) => ({
      schema: 'public',
      name: `t_${index}`,
      type: 'table' as const,
      primaryKey: ['id'],
      columns: [column('id', 1, 'uuid', false, undefined, true)],
    }));
    const large = generateMermaidErDiagram(manyTables);
    expect(large.warnings).toContain('ER diagram contains more than 30 tables; consider generating a relation subgraph.');

    const selected = generateMermaidErDiagram(fixtureTables(), {
      selectedTables: [
        { schema: 'public', table: 'users' },
        { schema: 'public', table: 'missing' },
      ],
    });
    expect(selected.warnings).toEqual(['Some selected tables were not found in schema metadata.']);
  });
});

function fixtureTables(): TableDetail[] {
  return [
    {
      schema: 'public',
      name: 'users',
      type: 'table',
      comment: '用户主表',
      primaryKey: ['id'],
      columns: [column('id', 1, 'uuid', false, '用户 ID', true), column('email', 2, 'text', false, '邮箱')],
    },
    {
      schema: 'public',
      name: 'orders',
      type: 'table',
      primaryKey: ['id'],
      columns: [
        column('id', 1, 'uuid', false, '订单 ID', true),
        {
          ...column('user_id', 2, 'uuid', false, '用户 ID'),
          foreignKey: { schema: 'public', table: 'users', column: 'id' },
        },
        column('total_amount', 3, 'numeric(10,2)', false, '金额'),
        column('created_at', 4, 'timestamptz', false, '下单时间'),
      ],
    },
    {
      schema: 'public',
      name: 'order_items',
      type: 'table',
      primaryKey: ['id'],
      columns: [
        column('id', 1, 'uuid', false, '明细 ID', true),
        {
          ...column('order_id', 2, 'uuid', false, '订单 ID'),
          foreignKey: { schema: 'public', table: 'orders', column: 'id' },
        },
        column('sku', 3, 'text', false, 'SKU'),
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
