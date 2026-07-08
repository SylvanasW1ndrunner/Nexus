import { describe, expect, it } from 'vitest';
import { analyzeSqlSafety } from '../src/sql-safety.js';

describe('analyzeSqlSafety', () => {
  it('allows read-only SELECT queries', () => {
    expect(analyzeSqlSafety('select * from orders limit 10', { readOnly: true })).toMatchObject({
      statementKind: 'SELECT',
      riskLevel: 'safe',
      blocked: false,
      requiresConfirmation: false,
    });
  });

  it('blocks DELETE queries on read-only connections', () => {
    const report = analyzeSqlSafety('delete from users where id = 1', { readOnly: true });

    expect(report).toMatchObject({
      statementKind: 'DELETE',
      riskLevel: 'blocked',
      blocked: true,
    });
    expect(report.reasons.join(' ')).toContain('read-only');
  });

  it('requires confirmation for write queries when read-only is disabled', () => {
    expect(analyzeSqlSafety('update orders set status = $1 where id = $2', { readOnly: false })).toMatchObject({
      statementKind: 'UPDATE',
      riskLevel: 'caution',
      blocked: false,
      requiresConfirmation: true,
    });
  });

  it('marks UPDATE and DELETE without WHERE as dangerous full-table mutations', () => {
    expect(analyzeSqlSafety("update users set status = 'inactive'", { readOnly: false })).toMatchObject({
      statementKind: 'UPDATE',
      riskLevel: 'dangerous',
      requiresConfirmation: true,
    });
    expect(analyzeSqlSafety('delete from users', { readOnly: false })).toMatchObject({
      statementKind: 'DELETE',
      riskLevel: 'dangerous',
      requiresConfirmation: true,
    });
  });

  it('marks DDL as dangerous', () => {
    expect(analyzeSqlSafety('drop table customers', { readOnly: false })).toMatchObject({
      statementKind: 'DROP',
      riskLevel: 'dangerous',
      requiresConfirmation: true,
    });
  });

  it('marks writable CTEs as dangerous instead of treating every WITH as readonly', () => {
    const report = analyzeSqlSafety(
      `
        with deleted_orders as (
          delete from orders where status = 'cancelled'
          returning id
        )
        select count(*) from deleted_orders
      `,
      { readOnly: false },
    );

    expect(report).toMatchObject({
      statementKind: 'WITH',
      riskLevel: 'dangerous',
      requiresConfirmation: true,
    });
    expect(report.reasons.join(' ')).toContain('contains DELETE');
  });

  it('blocks writable CTEs on read-only connections', () => {
    const report = analyzeSqlSafety(
      `
        with deleted_orders as (
          delete from orders where status = 'cancelled'
          returning id
        )
        select count(*) from deleted_orders
      `,
      { readOnly: true },
    );

    expect(report).toMatchObject({
      statementKind: 'WITH',
      riskLevel: 'blocked',
      blocked: true,
      requiresConfirmation: false,
    });
  });

  it('marks EXPLAIN ANALYZE around writes as dangerous because it executes the statement', () => {
    const report = analyzeSqlSafety("explain analyze update orders set status = 'paid' where id = 1", {
      readOnly: false,
    });

    expect(report).toMatchObject({
      statementKind: 'EXPLAIN',
      riskLevel: 'dangerous',
      requiresConfirmation: true,
    });
    expect(report.reasons.join(' ')).toContain('contains UPDATE');
  });

  it('requires review for administrative and unknown SQL instead of marking them safe', () => {
    expect(analyzeSqlSafety("copy orders from '/tmp/orders.csv' csv", { readOnly: false })).toMatchObject({
      statementKind: 'COPY',
      riskLevel: 'caution',
      requiresConfirmation: true,
    });
    expect(analyzeSqlSafety('grant select on orders to analyst', { readOnly: false })).toMatchObject({
      statementKind: 'GRANT',
      riskLevel: 'caution',
      requiresConfirmation: true,
    });
    expect(analyzeSqlSafety('do $$ begin raise notice $$', { readOnly: false })).toMatchObject({
      statementKind: 'DO',
      riskLevel: 'caution',
      requiresConfirmation: true,
    });
    expect(analyzeSqlSafety('??', { readOnly: false })).toMatchObject({
      statementKind: 'UNKNOWN',
      riskLevel: 'caution',
      requiresConfirmation: true,
    });
  });

  it('flags multiple statements for review', () => {
    const report = analyzeSqlSafety('select 1; select 2;', { readOnly: false });

    expect(report.requiresConfirmation).toBe(true);
    expect(report.reasons.join(' ')).toContain('Multiple statements');
  });

  it('blocks read-only multi-statement batches when a later statement writes data', () => {
    const report = analyzeSqlSafety(
      "select count(*) from users; update users set status = 'inactive' where id = 1;",
      { readOnly: true },
    );

    expect(report).toMatchObject({
      statementKind: 'SELECT',
      riskLevel: 'blocked',
      blocked: true,
      requiresConfirmation: false,
    });
    expect(report.reasons.join(' ')).toContain('read-only');
  });

  it('ignores comments before classifying complex CTE reads', () => {
    const report = analyzeSqlSafety(
      `
        -- analyst note: this query explores city revenue
        with city_revenue as (
          select u.city, sum(o.total_amount) as revenue
          from users u
          join orders o on o.user_id = u.id
          group by u.city
        )
        select * from city_revenue order by revenue desc limit 10
      `,
      { readOnly: true },
    );

    expect(report).toMatchObject({
      statementKind: 'WITH',
      riskLevel: 'safe',
      blocked: false,
    });
  });

  it('adds performance warnings to exploratory broad reads', () => {
    const report = analyzeSqlSafety("select * from users where lower(email) like '%@example.com' offset 20000", {
      readOnly: true,
    });

    expect(report.performanceWarnings?.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(['SELECT_STAR', 'MISSING_LIMIT', 'LEADING_WILDCARD_LIKE', 'LARGE_OFFSET']),
    );
  });
});
