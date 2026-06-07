import { describe, expect, it } from 'vitest';
import { analyzeSqlSafety } from './sql-safety.js';

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

  it('marks DDL as dangerous', () => {
    expect(analyzeSqlSafety('drop table customers', { readOnly: false })).toMatchObject({
      statementKind: 'DROP',
      riskLevel: 'dangerous',
      requiresConfirmation: true,
    });
  });

  it('flags multiple statements for review', () => {
    const report = analyzeSqlSafety('select 1; select 2;', { readOnly: false });

    expect(report.requiresConfirmation).toBe(true);
    expect(report.reasons.join(' ')).toContain('Multiple statements');
  });
});
