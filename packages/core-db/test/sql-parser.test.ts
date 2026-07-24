import { describe, expect, it } from 'vitest';
import {
  parseSql,
  permissionAllows,
  permissionRank,
} from '../src/index.js';

describe('PostgreSQL SQL parser and three-level permissions', () => {
  it('parses complex analytical SQL with English and Chinese identifiers', () => {
    const sql = `
      WITH order_lines AS (
        SELECT
          o.customer_id,
          date_trunc('month', o.created_at) AS month,
          (e."载荷" ->> 'amount')::numeric AS amount,
          row_number() OVER (
            PARTITION BY o.customer_id
            ORDER BY o.created_at DESC
          ) AS rn
        FROM commerce.orders AS o
        JOIN "事件中心"."订单事件" AS e ON e.order_id = o.id
        WHERE o.created_at >= current_date - interval '12 months'
          AND e."载荷" @> '{"status":"paid"}'::jsonb
      )
      SELECT customer_id, month, sum(amount) FILTER (WHERE rn <= 3) AS top3_amount
      FROM order_lines
      GROUP BY GROUPING SETS ((customer_id, month), (month))
      ORDER BY month, top3_amount DESC
    `;
    const parsed = parseSql(sql);

    expect(parsed).toMatchObject({
      dialect: 'postgresql',
      statementCount: 1,
      requiredPermission: 'read',
      hasWhere: true,
    });
    // PostgreSQL extensions not implemented by the generic AST grammar fall
    // back to the conservative statement scanner without escalating a read CTE.
    expect(['node-sql-parser', 'statement-scanner']).toContain(parsed.parser);
    expect(parsed.statementKinds).toEqual(
      parsed.parser === 'node-sql-parser' ? ['SELECT'] : ['WITH'],
    );
    expect(parsed.tables).toEqual(
      expect.arrayContaining(['commerce.orders', '事件中心.订单事件']),
    );
  });

  it.each([
    [
      'INSERT INTO audit.events(id, payload) VALUES (1, \'{"ok":true}\') ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload RETURNING id',
      'edit',
    ],
    [
      'UPDATE commerce.orders o SET status = s.status FROM staging.order_status s WHERE s.id = o.id RETURNING o.id',
      'edit',
    ],
    [
      'DELETE FROM commerce.orders o USING archive.deleted_orders d WHERE d.id = o.id',
      'edit',
    ],
    [
      'MERGE INTO inventory i USING updates u ON i.sku = u.sku WHEN MATCHED THEN UPDATE SET qty = u.qty WHEN NOT MATCHED THEN INSERT (sku, qty) VALUES (u.sku, u.qty)',
      'edit',
    ],
    [
      'CREATE TABLE "数据仓库"."日汇总" ("日期" date PRIMARY KEY, revenue numeric(18,2)) PARTITION BY RANGE ("日期")',
      'full',
    ],
    [
      'ALTER TABLE commerce.orders ADD COLUMN risk_score numeric GENERATED ALWAYS AS ((payload->>\'risk\')::numeric) STORED',
      'full',
    ],
    ['DROP TABLE IF EXISTS staging.expired_orders CASCADE', 'full'],
    ['TRUNCATE TABLE staging.import_buffer RESTART IDENTITY', 'full'],
    ['GRANT SELECT ON ALL TABLES IN SCHEMA commerce TO analyst', 'full'],
    ['VACUUM (ANALYZE, VERBOSE) commerce.orders', 'full'],
  ] as const)(
    'classifies %s at the required permission level',
    (sql, permission) => {
      expect(parseSql(sql).requiredPermission).toBe(permission);
    },
  );

  it('takes the highest permission across multiple statements and ignores keywords in literals', () => {
    const mixed = parseSql(`
      SELECT 'DROP TABLE users' AS harmless_text;
      UPDATE commerce.orders SET status = 'paid' WHERE id = 42;
      SELECT * FROM commerce.orders WHERE id = 42;
    `);

    expect(mixed.statementCount).toBe(3);
    expect(mixed.requiredPermission).toBe('edit');
    expect(mixed.statementKinds).toEqual(['SELECT', 'UPDATE', 'SELECT']);
    expect(parseSql(`SELECT 'ALTER TABLE x' AS note`).requiredPermission).toBe('read');
  });

  it('fails closed on unsupported dialects and malformed unknown statements', () => {
    const unsupported = parseSql('SELECT * FROM users', { dialect: 'mysql' });
    expect(unsupported).toMatchObject({
      valid: false,
      parser: 'statement-scanner',
      requiredPermission: 'read',
    });
    expect(unsupported.parseError).toContain('mysql AST adapter');

    const unknown = parseSql('SELEC * FORM users');
    expect(unknown).toMatchObject({
      valid: false,
      requiredPermission: 'full',
      statementKinds: ['SELEC'],
    });
    expect(parseSql('  -- no executable SQL  ')).toMatchObject({
      valid: false,
      statementCount: 0,
      requiredPermission: 'full',
    });
  });

  it('implements strictly increasing read/edit/full permission semantics', () => {
    expect(permissionRank('read')).toBeLessThan(permissionRank('edit'));
    expect(permissionRank('edit')).toBeLessThan(permissionRank('full'));
    expect(permissionAllows('read', 'read')).toBe(true);
    expect(permissionAllows('read', 'edit')).toBe(false);
    expect(permissionAllows('edit', 'read')).toBe(true);
    expect(permissionAllows('edit', 'full')).toBe(false);
    expect(permissionAllows('full', 'full')).toBe(true);
  });

  it('parses a sustained mixed workload within the engineering latency budget', () => {
    const statements = [
      'SELECT customer_id, sum(total_amount) FROM commerce.orders WHERE created_at >= now() - interval \'30 days\' GROUP BY customer_id',
      'UPDATE commerce.orders SET status = \'archived\' WHERE created_at < current_date - interval \'2 years\'',
      'CREATE INDEX CONCURRENTLY idx_orders_created_at ON commerce.orders(created_at)',
      'SELECT payload->>\'source\' AS source, count(*) FROM events.raw GROUP BY 1',
    ];
    const started = performance.now();
    const results = Array.from({ length: 1_000 }, (_, index) =>
      parseSql(statements[index % statements.length]!),
    );
    const elapsedMs = performance.now() - started;

    expect(results).toHaveLength(1_000);
    expect(results.every((result) => result.statementCount === 1)).toBe(true);
    expect(elapsedMs).toBeLessThan(2_500);
  });
});
