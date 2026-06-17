import { describe, expect, it } from 'vitest';
import { buildCreateIndexPreview, buildDropIndexPreview } from '../src/index.js';

describe('index management preview builder', () => {
  it('builds a concurrent composite btree index preview for a large production table', () => {
    const preview = buildCreateIndexPreview({
      schema: 'public',
      table: 'orders',
      name: 'ix_orders_user_created',
      method: 'btree',
      concurrently: true,
      columns: [
        { column: 'user_id' },
        { column: 'created_at', direction: 'desc', nulls: 'last' },
      ],
    });

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.data.sql).toBe(
      'create index concurrently "ix_orders_user_created" on "public"."orders" using btree ("user_id", "created_at" desc nulls last);',
    );
    expect(preview.data.requiresConfirmation).toBe(true);
    expect(preview.data.riskLevel).toBe('dangerous');
    expect(preview.data.warnings).toEqual([
      'CONCURRENTLY cannot run inside an explicit transaction block in PostgreSQL.',
    ]);
  });

  it('builds a unique partial index preview and keeps WHERE SQL visible for review', () => {
    const preview = buildCreateIndexPreview({
      schema: 'public',
      table: 'users',
      name: 'uk_users_active_email',
      unique: true,
      columns: [{ column: 'email' }],
      whereSql: "where deleted_at is null and status = 'active'",
    });

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.data.sql).toBe(
      'create unique index "uk_users_active_email" on "public"."users" using btree ("email") where deleted_at is null and status = \'active\';',
    );
    expect(preview.data.warnings).toEqual([
      'Partial index WHERE SQL is appended verbatim and must be reviewed before execution.',
    ]);
  });

  it('builds an expression index preview with a generated default name', () => {
    const preview = buildCreateIndexPreview({
      schema: 'crm',
      table: 'customers',
      method: 'gin',
      columns: [{ expression: "lower(email)" }],
    });

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.data.sql).toBe(
      'create index "idx_customers_expr_1" on "crm"."customers" using gin ((lower(email)));',
    );
  });

  it('rejects unsafe columns, expressions, operator classes, and WHERE clauses before preview', () => {
    const unsafeColumn = buildCreateIndexPreview({
      schema: 'public',
      table: 'users',
      columns: [{ column: 'email; drop table users' }],
    });
    const unsafeExpression = buildCreateIndexPreview({
      schema: 'public',
      table: 'users',
      columns: [{ expression: 'lower(email); drop table users' }],
    });
    const unsafeOpClass = buildCreateIndexPreview({
      schema: 'public',
      table: 'users',
      columns: [{ column: 'metadata', opClass: 'jsonb_path_ops; drop table users' }],
    });
    const unsafeWhere = buildCreateIndexPreview({
      schema: 'public',
      table: 'users',
      columns: [{ column: 'email' }],
      whereSql: 'deleted_at is null; drop table users',
    });

    expect(unsafeColumn.ok).toBe(false);
    if (!unsafeColumn.ok) expect(unsafeColumn.error.message).toBe('Index column name contains unsafe SQL tokens.');
    expect(unsafeExpression.ok).toBe(false);
    if (!unsafeExpression.ok) expect(unsafeExpression.error.message).toBe('Index expression contains unsafe SQL tokens.');
    expect(unsafeOpClass.ok).toBe(false);
    if (!unsafeOpClass.ok) expect(unsafeOpClass.error.message).toBe('Index operator class name contains unsafe SQL tokens.');
    expect(unsafeWhere.ok).toBe(false);
    if (!unsafeWhere.ok) expect(unsafeWhere.error.message).toBe('Partial index WHERE clause contains unsafe SQL tokens.');
  });

  it('requires at least one index column or expression', () => {
    const preview = buildCreateIndexPreview({
      schema: 'public',
      table: 'users',
      columns: [],
    });

    expect(preview.ok).toBe(false);
    if (preview.ok) return;
    expect(preview.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Index requires at least one column or expression.',
    });
  });

  it('builds drop index previews and rejects PostgreSQL-invalid concurrently cascade combinations', () => {
    const drop = buildDropIndexPreview({
      schema: 'public',
      name: 'ix_orders_user_created',
      concurrently: true,
      ifExists: true,
    });
    const invalid = buildDropIndexPreview({
      schema: 'public',
      name: 'ix_orders_user_created',
      concurrently: true,
      cascade: true,
    });

    expect(drop.ok).toBe(true);
    if (!drop.ok) return;
    expect(drop.data.sql).toBe('drop index concurrently if exists "public"."ix_orders_user_created";');
    expect(drop.data.warnings).toEqual([
      'Dropping an index can degrade query performance and must be confirmed.',
      'CONCURRENTLY cannot run inside an explicit transaction block in PostgreSQL.',
    ]);

    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'DROP INDEX CONCURRENTLY cannot be combined with CASCADE in PostgreSQL.',
      });
    }
  });
});
