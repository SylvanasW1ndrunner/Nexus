import { describe, expect, it } from 'vitest';
import { resolveSqlEditorExecutionTarget } from '../src/sql-editor-execution-target.js';

const connectionId = 'conn_editor_pg';

describe('resolveSqlEditorExecutionTarget', () => {
  it('builds a query request from the selected SQL text', () => {
    const documentText = `
select * from users limit 10;

update users set status = 'inactive' where id = 1;
`;
    const startOffset = documentText.indexOf('update');
    const endOffset = documentText.indexOf(';', startOffset);

    const result = resolveSqlEditorExecutionTarget({
      connectionId,
      documentText,
      mode: 'selection',
      selection: { startOffset, endOffset },
      readOnly: false,
      supportsTransactions: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      mode: 'selection',
      sourceSql: "update users set status = 'inactive' where id = 1",
      executableSql: "update users set status = 'inactive' where id = 1",
      statementKind: 'UPDATE',
      queryRequest: {
        connectionId,
        sql: "update users set status = 'inactive' where id = 1",
      },
      executionPlan: {
        decision: 'requires-confirmation',
        transactionPolicy: 'recommended',
        rollbackAvailable: true,
      },
    });
  });

  it('resolves the statement at the cursor without executing neighboring statements', () => {
    const documentText = `select 1;

select id, email
from users
where email like '%@example.com';

select 3;`;

    const result = resolveSqlEditorExecutionTarget({
      connectionId,
      documentText,
      mode: 'current-statement',
      cursor: { offset: documentText.indexOf('email like') },
      readOnly: true,
      supportsExplain: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.sourceSql).toBe(
      "select id, email\nfrom users\nwhere email like '%@example.com'",
    );
    expect(result.data.range).toMatchObject({
      startLine: 3,
      startColumn: 1,
      endLine: 5,
    });
    expect(result.data.executionPlan.decision).toBe('execute');
  });

  it('uses one-based line and column cursors for editor integrations', () => {
    const documentText = `select 1;

delete from users where id = 42;`;

    const result = resolveSqlEditorExecutionTarget({
      connectionId,
      documentText,
      mode: 'current-statement',
      cursor: { line: 3, column: 8 },
      readOnly: false,
      supportsTransactions: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.sourceSql).toBe('delete from users where id = 42');
    expect(result.data.executionPlan).toMatchObject({
      statementKind: 'DELETE',
      decision: 'requires-confirmation',
      transactionPolicy: 'recommended',
    });
  });

  it('builds a full-file target and preserves multi-statement preflight review', () => {
    const documentText = `
select * from users limit 10;
select * from orders limit 10;
`;

    const result = resolveSqlEditorExecutionTarget({
      connectionId,
      documentText,
      mode: 'full-file',
      readOnly: false,
      supportsTransactions: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.sourceSql).toBe(
      'select * from users limit 10;\nselect * from orders limit 10;',
    );
    expect(result.data.executionPlan).toMatchObject({
      decision: 'requires-confirmation',
      confirmationRequired: true,
      transactionPolicy: 'required',
    });
    expect(result.data.executionPlan.confirmationReasons.join(' ')).toContain(
      'Multiple statements',
    );
  });

  it('builds EXPLAIN ANALYZE SQL for the current read statement', () => {
    const documentText = `select 1;

select * from orders where created_at >= current_date - interval '7 days';
`;

    const result = resolveSqlEditorExecutionTarget({
      connectionId,
      documentText,
      mode: 'explain-current-statement',
      cursor: { offset: documentText.indexOf('orders') },
      readOnly: true,
      supportsExplain: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.sourceSql).toBe(
      "select * from orders where created_at >= current_date - interval '7 days'",
    );
    expect(result.data.executableSql).toBe(
      "explain (analyze, buffers, format json)\nselect * from orders where created_at >= current_date - interval '7 days';",
    );
    expect(result.data.queryRequest.sql).toBe(result.data.executableSql);
    expect(result.data.executionPlan.shouldExplainBeforeRun).toBe(true);
    expect(result.data.warnings.join(' ')).toContain('EXPLAIN ANALYZE executes');
  });

  it('can build non-analyze EXPLAIN SQL when runtime execution is not desired', () => {
    const documentText = 'select * from orders limit 20;';

    const result = resolveSqlEditorExecutionTarget({
      connectionId,
      documentText,
      mode: 'explain-current-statement',
      cursor: { offset: 3 },
      readOnly: true,
      supportsExplain: true,
      explainAnalyze: false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.executableSql).toBe('explain (format json)\nselect * from orders limit 20;');
    expect(result.data.warnings).toEqual([]);
  });

  it('rejects EXPLAIN ANALYZE for write statements from editor shortcuts', () => {
    const result = resolveSqlEditorExecutionTarget({
      connectionId,
      documentText: "update users set status = 'inactive' where id = 1;",
      mode: 'explain-current-statement',
      cursor: { offset: 4 },
      readOnly: false,
      supportsExplain: true,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'UNSUPPORTED_OPERATION',
      },
    });
  });

  it('returns a clear validation error for empty selections', () => {
    const result = resolveSqlEditorExecutionTarget({
      connectionId,
      documentText: 'select 1;',
      mode: 'selection',
      selection: { startOffset: 0, endOffset: 0 },
      readOnly: true,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Selected SQL is empty.',
      },
    });
  });

  it('returns a clear validation error when the cursor is between statements', () => {
    const documentText = 'select 1;\n\nselect 2;';
    const result = resolveSqlEditorExecutionTarget({
      connectionId,
      documentText,
      mode: 'current-statement',
      cursor: { offset: documentText.indexOf('\n\n') + 1 },
      readOnly: true,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'No executable SQL statement was found at the cursor.',
      },
    });
  });
});
