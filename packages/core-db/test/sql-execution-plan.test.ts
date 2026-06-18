import { describe, expect, it } from 'vitest';
import { buildSqlExecutionPlan } from '../src/index.js';

describe('buildSqlExecutionPlan', () => {
  it('allows bounded readonly selects and recommends no transaction', () => {
    const plan = buildSqlExecutionPlan('select id, email from users limit 20', {
      readOnly: true,
      supportsTransactions: true,
      supportsExplain: true,
    });

    expect(plan).toMatchObject({
      statementKind: 'SELECT',
      decision: 'execute',
      transactionPolicy: 'none',
      rollbackAvailable: false,
      confirmationRequired: false,
      shouldExplainBeforeRun: false,
    });
  });

  it('requires confirmation and transaction rollback protection for unconfirmed writes', () => {
    const plan = buildSqlExecutionPlan("update orders set status = 'paid' where id = 1", {
      readOnly: false,
      supportsTransactions: true,
    });

    expect(plan).toMatchObject({
      statementKind: 'UPDATE',
      decision: 'requires-confirmation',
      transactionPolicy: 'recommended',
      rollbackAvailable: true,
      confirmationRequired: true,
    });
    expect(plan.confirmationReasons.join(' ')).toContain('UPDATE writes data');
  });

  it('marks UPDATE without WHERE as dangerous and requires transaction execution after confirmation', () => {
    const plan = buildSqlExecutionPlan("update users set status = 'inactive'", {
      readOnly: false,
      supportsTransactions: true,
      confirmed: true,
    });

    expect(plan).toMatchObject({
      statementKind: 'UPDATE',
      decision: 'execute',
      transactionPolicy: 'required',
      rollbackAvailable: true,
      confirmationRequired: false,
    });
    expect(plan.safety.riskLevel).toBe('dangerous');
    expect(plan.safety.reasons.join(' ')).toContain('without WHERE');
  });

  it('blocks writes on readonly connections before transaction planning', () => {
    const plan = buildSqlExecutionPlan('delete from users where id = 1', {
      readOnly: true,
      supportsTransactions: true,
    });

    expect(plan).toMatchObject({
      decision: 'blocked',
      transactionPolicy: 'none',
      rollbackAvailable: false,
    });
    expect(plan.executionNotes).toContain('Execution is blocked before reaching the database.');
  });

  it('warns when rollback protection is unavailable for multi-statement writes', () => {
    const plan = buildSqlExecutionPlan(
      "insert into audit_log(message) values ('a'); delete from audit_log;",
      {
        readOnly: false,
        supportsTransactions: false,
        confirmed: true,
      },
    );

    expect(plan).toMatchObject({
      decision: 'execute',
      transactionPolicy: 'unavailable',
      rollbackAvailable: false,
    });
    expect(plan.executionNotes.join(' ')).toContain('does not support rollback protection');
  });

  it('requires transaction protection for multi-statement files even when the first statement is a read', () => {
    const plan = buildSqlExecutionPlan(
      "select * from users limit 10; update users set status = 'active' where id = 1;",
      {
        readOnly: false,
        supportsTransactions: true,
        confirmed: true,
      },
    );

    expect(plan).toMatchObject({
      decision: 'execute',
      transactionPolicy: 'required',
      rollbackAvailable: true,
    });
  });

  it('requests EXPLAIN before broad exploratory reads with performance warnings', () => {
    const plan = buildSqlExecutionPlan('select * from orders offset 20000', {
      readOnly: true,
      supportsExplain: true,
    });

    expect(plan.decision).toBe('execute');
    expect(plan.shouldExplainBeforeRun).toBe(true);
    expect(plan.executionNotes.join(' ')).toContain('Run EXPLAIN before execution');
  });
});
