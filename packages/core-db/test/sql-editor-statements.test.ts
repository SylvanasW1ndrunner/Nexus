import { describe, expect, it } from 'vitest';
import {
  findSqlStatementAtLineColumn,
  findSqlStatementAtPosition,
  splitSqlStatements,
} from '../src/sql-editor-statements.js';
import { analyzeSqlSafety } from '../src/sql-safety.js';

describe('sql editor statement parsing', () => {
  it('splits ordinary multi-statement SQL and records stable ranges', () => {
    const sql = 'select 1;\n\nselect * from users limit 10;';

    const statements = splitSqlStatements(sql);

    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatchObject({
      index: 0,
      text: 'select 1',
      statementKind: 'SELECT',
      startOffset: 0,
      endOffset: 'select 1'.length,
      terminatorOffset: 'select 1'.length,
      startLine: 1,
      startColumn: 1,
    });
    expect(statements[1]).toMatchObject({
      index: 1,
      text: 'select * from users limit 10',
      statementKind: 'SELECT',
      startLine: 3,
      startColumn: 1,
    });
  });

  it('does not split on semicolons inside quoted literals or identifiers', () => {
    const sql = `select ';' as semicolon, 'it''s ok; really' as note, "weird;name" from logs; select 2;`;

    const statements = splitSqlStatements(sql);

    expect(statements.map((statement) => statement.text)).toEqual([
      `select ';' as semicolon, 'it''s ok; really' as note, "weird;name" from logs`,
      'select 2',
    ]);
  });

  it('does not split PostgreSQL dollar-quoted function bodies', () => {
    const sql = `
create or replace function audit_touch()
returns trigger
language plpgsql
as $fn$
begin
  insert into audit_log(message) values ('before;after');
  return new;
end;
$fn$;
select audit_touch();
`;

    const statements = splitSqlStatements(sql);

    expect(statements).toHaveLength(2);
    expect(statements[0].statementKind).toBe('CREATE');
    expect(statements[0].text).toContain("values ('before;after');");
    expect(statements[1].text).toBe('select audit_touch()');
  });

  it('ignores semicolons inside comments and skips comment-only input', () => {
    const sql = `
-- analyst note: check Q1; Q2; Q3
/* block comment ; still comment */
select * from orders limit 20;
`;

    expect(splitSqlStatements('-- only comment;\n/* no sql; */')).toEqual([]);
    expect(splitSqlStatements(sql)).toHaveLength(1);
    expect(splitSqlStatements(sql)[0].text).toContain('select * from orders limit 20');
  });

  it('finds the statement under an editor cursor offset', () => {
    const sql = `select 1;\n\nupdate users set status = 'active' where id = 1;\nselect 3;`;
    const position = sql.indexOf('status');

    const statement = findSqlStatementAtPosition(sql, position);

    expect(statement).toMatchObject({
      index: 1,
      statementKind: 'UPDATE',
      text: "update users set status = 'active' where id = 1",
    });
  });

  it('finds the current statement from one-based editor line and column', () => {
    const sql = `select 1;\n\nselect id, email\nfrom users\nwhere email like '%@example.com';`;

    const statement = findSqlStatementAtLineColumn(sql, 4, 3);

    expect(statement).toMatchObject({
      index: 1,
      statementKind: 'SELECT',
    });
    expect(statement?.text).toContain('from users');
  });

  it('returns undefined when the cursor is only between statements', () => {
    const sql = 'select 1;\n\nselect 2;';

    expect(findSqlStatementAtPosition(sql, sql.indexOf('\n\n') + 1)).toBeUndefined();
  });

  it('improves safety multi-statement detection for semicolons in strings', () => {
    const report = analyzeSqlSafety("select ';' as literal", { readOnly: true });

    expect(report.requiresConfirmation).toBe(false);
    expect(report.reasons).not.toContain('Multiple statements require review before execution.');
  });
});
