import { describe, expect, it } from 'vitest';
import { buildTableDataQuery, buildTablePreviewSql, quotePgIdentifier } from '../src/index.js';

describe('PostgreSQL SQL builder', () => {
  it('quotes identifiers without changing valid names', () => {
    expect(quotePgIdentifier('orders')).toBe('"orders"');
  });

  it('escapes embedded quotes in schema and table names', () => {
    expect(buildTablePreviewSql('tenant "A"', 'Order Items', 50)).toBe(
      'select * from "tenant ""A"""."Order Items" limit 50;',
    );
  });

  it('clamps preview limits to a product-safe range', () => {
    expect(buildTablePreviewSql('public', 'users', 0)).toBe('select * from "public"."users" limit 1;');
    expect(buildTablePreviewSql('public', 'users', 5000)).toBe('select * from "public"."users" limit 1000;');
  });

  it('builds a paged table data query with visible columns, filters, and sorting', () => {
    const query = buildTableDataQuery({
      schema: 'public',
      table: 'orders',
      visibleColumns: ['id', 'status', 'created_at'],
      filters: [
        { column: 'status', operator: '=', value: 'paid' },
        { column: 'created_at', operator: '>=', value: '2026-01-01' },
      ],
      sorts: [
        { column: 'created_at', direction: 'desc' },
        { column: 'id', direction: 'asc' },
      ],
      limit: 100,
      offset: 200,
    });

    expect(query.sql).toBe(
      [
        'select "id", "status", "created_at"',
        'from "public"."orders"',
        'where "status" = $1 and "created_at" >= $2',
        'order by "created_at" desc, "id" asc',
        'limit 100',
        'offset 200;',
      ].join('\n'),
    );
    expect(query.params).toEqual(['paid', '2026-01-01']);
    expect(query.page).toEqual({ limit: 100, offset: 200 });
    expect(query.warnings).toEqual([]);
  });

  it('keeps user filter values out of SQL text', () => {
    const query = buildTableDataQuery({
      schema: 'public',
      table: 'users',
      filters: [{ column: 'email', operator: 'like', value: "%' OR 1=1 --" }],
    });

    expect(query.sql).toContain('"email" like $1');
    expect(query.sql).not.toContain("OR 1=1");
    expect(query.params).toEqual(["%' OR 1=1 --"]);
  });

  it('supports IN, BETWEEN, NULL, and advanced WHERE clauses', () => {
    const query = buildTableDataQuery({
      schema: 'analytics',
      table: 'events',
      filters: [
        { column: 'status', operator: 'in', values: ['paid', 'refunded'] },
        { column: 'score', operator: 'between', values: [10, 20] },
        { column: 'deleted_at', operator: 'is_null' },
      ],
      advancedWhereSql: 'where tenant_id = current_setting(\'app.tenant_id\')::uuid',
      limit: 50,
    });

    expect(query.sql).toBe(
      [
        'select *',
        'from "analytics"."events"',
        'where "status" = any($1) and "score" between $2 and $3 and "deleted_at" is null and (tenant_id = current_setting(\'app.tenant_id\')::uuid)',
        'limit 50;',
      ].join('\n'),
    );
    expect(query.params).toEqual([['paid', 'refunded'], 10, 20]);
    expect(query.warnings).toEqual(['Advanced WHERE SQL is appended verbatim and must be reviewed before execution.']);
  });

  it('clamps table data pagination to product-safe bounds', () => {
    const query = buildTableDataQuery({
      schema: 'public',
      table: 'users',
      limit: 50000,
      offset: -10,
    });

    expect(query.sql).toBe(['select *', 'from "public"."users"', 'limit 1000;'].join('\n'));
    expect(query.page).toEqual({ limit: 1000, offset: 0 });
    expect(query.warnings).toEqual([
      'Page size exceeded 1000 and has been clamped.',
      'Page offset was below 0 and has been clamped to 0.',
    ]);
  });
});
