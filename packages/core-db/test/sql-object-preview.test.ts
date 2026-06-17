import { describe, expect, it } from 'vitest';
import {
  buildCreateOrReplaceFunctionPreview,
  buildCreateOrReplaceProcedurePreview,
  buildCreateOrReplaceViewPreview,
  buildDropSqlObjectPreview,
  buildRoutineTestCall,
} from '../src/index.js';

describe('SQL object preview builder', () => {
  it('builds a safe create or replace view preview from a single SELECT query', () => {
    const preview = buildCreateOrReplaceViewPreview({
      schema: 'public',
      view: 'active_users',
      selectSql: `
        select u.*
        from users u
        where u.deleted_at is null;
      `,
      checkOption: 'local',
    });

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.data.requiresConfirmation).toBe(true);
    expect(preview.data.riskLevel).toBe('dangerous');
    expect(preview.data.sql).toBe(
      [
        'create or replace view "public"."active_users" as',
        'select u.*',
        '        from users u',
        '        where u.deleted_at is null',
        'with local check option;',
      ].join('\n'),
    );
  });

  it('accepts CTE-backed view definitions', () => {
    const preview = buildCreateOrReplaceViewPreview({
      schema: 'analytics',
      view: 'weekly_sales',
      selectSql: 'with recent_orders as (select * from orders) select count(*) from recent_orders',
    });

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.data.statements[0]).toContain('create or replace view "analytics"."weekly_sales" as');
  });

  it('rejects non-select and multi-statement view definitions before DDL preview', () => {
    const writePreview = buildCreateOrReplaceViewPreview({
      schema: 'public',
      view: 'bad',
      selectSql: 'delete from users',
    });
    const multiPreview = buildCreateOrReplaceViewPreview({
      schema: 'public',
      view: 'bad',
      selectSql: 'select * from users; drop table users',
    });

    expect(writePreview.ok).toBe(false);
    if (!writePreview.ok) {
      expect(writePreview.error).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'View definition must start with SELECT or WITH.',
      });
    }
    expect(multiPreview.ok).toBe(false);
    if (!multiPreview.ok) {
      expect(multiPreview.error).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'View definition must contain a single SELECT or WITH query.',
      });
    }
  });

  it('builds a function preview with parameters, return table, options, and body delimiter', () => {
    const preview = buildCreateOrReplaceFunctionPreview({
      schema: 'public',
      name: 'get_user_stats',
      parameters: [{ name: 'uid', dataType: 'bigint' }],
      returns: 'table (order_count int, total_amount numeric)',
      language: 'plpgsql',
      volatility: 'stable',
      security: 'definer',
      body: `
begin
  return query
    select count(*)::int, coalesce(sum(amount), 0)
    from orders
    where user_id = uid;
end
      `,
    });

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.data.sql).toBe(
      [
        'create or replace function "public"."get_user_stats"("uid" bigint)',
        'returns table (order_count int, total_amount numeric)',
        'language plpgsql',
        'stable',
        'security definer',
        'as $dbagent$',
        'begin',
        '  return query',
        '    select count(*)::int, coalesce(sum(amount), 0)',
        '    from orders',
        '    where user_id = uid;',
        'end',
        '$dbagent$;',
      ].join('\n'),
    );
  });

  it('builds a procedure preview with IN and INOUT parameters', () => {
    const preview = buildCreateOrReplaceProcedurePreview({
      schema: 'ops',
      name: 'mark_inactive_users',
      parameters: [
        { name: 'days_old', dataType: 'integer', mode: 'in' },
        { name: 'affected_rows', dataType: 'integer', mode: 'inout' },
      ],
      body: 'begin\n  affected_rows := 0;\nend',
    });

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.data.statements).toEqual([
      [
        'create or replace procedure "ops"."mark_inactive_users"(in "days_old" integer, inout "affected_rows" integer)',
        'language plpgsql',
        'as $dbagent$',
        'begin',
        '  affected_rows := 0;',
        'end',
        '$dbagent$;',
      ].join('\n'),
    ]);
  });

  it('rejects unsafe routine fragments and reserved body delimiters', () => {
    const unsafeType = buildCreateOrReplaceFunctionPreview({
      schema: 'public',
      name: 'bad',
      parameters: [{ name: 'payload', dataType: 'text; drop table users' }],
      returns: 'int',
      body: 'begin return 1; end',
    });
    const unsafeLanguage = buildCreateOrReplaceFunctionPreview({
      schema: 'public',
      name: 'bad',
      returns: 'int',
      language: 'plpgsql; drop table users',
      body: 'begin return 1; end',
    });
    const unsafeBody = buildCreateOrReplaceFunctionPreview({
      schema: 'public',
      name: 'bad',
      returns: 'int',
      body: 'begin raise notice $dbagent$; end',
    });

    expect(unsafeType.ok).toBe(false);
    if (!unsafeType.ok) expect(unsafeType.error.message).toBe('Routine parameter type contains unsafe SQL tokens.');
    expect(unsafeLanguage.ok).toBe(false);
    if (!unsafeLanguage.ok) expect(unsafeLanguage.error.message).toBe('Routine language contains unsafe SQL tokens.');
    expect(unsafeBody.ok).toBe(false);
    if (!unsafeBody.ok) expect(unsafeBody.error.message).toBe('Routine body contains the reserved DBAgent delimiter.');
  });

  it('builds parameterized routine test calls without interpolating user values', () => {
    const functionCall = buildRoutineTestCall({
      schema: 'public',
      name: 'get_user_stats',
      kind: 'function',
      args: [1234, "' OR 1=1 --"],
      limit: 20,
    });
    const scalarCall = buildRoutineTestCall({
      schema: 'public',
      name: 'is_vip',
      kind: 'function',
      resultShape: 'scalar',
      args: [1234],
    });
    const procedureCall = buildRoutineTestCall({
      schema: 'ops',
      name: 'refresh_metrics',
      kind: 'procedure',
      args: ['daily'],
    });

    expect(functionCall.ok).toBe(true);
    if (!functionCall.ok) return;
    expect(functionCall.data.sql).toBe('select * from "public"."get_user_stats"($1, $2) limit 20;');
    expect(functionCall.data.sql).not.toContain('OR 1=1');
    expect(functionCall.data.params).toEqual([1234, "' OR 1=1 --"]);

    expect(scalarCall.ok).toBe(true);
    if (!scalarCall.ok) return;
    expect(scalarCall.data.sql).toBe('select "public"."is_vip"($1) as value;');

    expect(procedureCall.ok).toBe(true);
    if (!procedureCall.ok) return;
    expect(procedureCall.data.sql).toBe('call "ops"."refresh_metrics"($1);');
    expect(procedureCall.data.params).toEqual(['daily']);
  });

  it('clamps set-returning function test call limits', () => {
    const call = buildRoutineTestCall({
      schema: 'public',
      name: 'search_orders',
      kind: 'function',
      args: ['paid'],
      limit: 50000,
    });

    expect(call.ok).toBe(true);
    if (!call.ok) return;
    expect(call.data.sql).toBe('select * from "public"."search_orders"($1) limit 1000;');
    expect(call.data.warnings).toEqual(['Test call limit exceeded 1000 and has been clamped.']);
  });

  it('builds destructive drop previews with signatures for routines', () => {
    const dropFunction = buildDropSqlObjectPreview({
      schema: 'public',
      name: 'get_user_stats',
      kind: 'function',
      signature: [{ dataType: 'bigint' }],
    });
    const dropView = buildDropSqlObjectPreview({
      schema: 'public',
      name: 'active_users',
      kind: 'view',
      cascade: true,
    });

    expect(dropFunction.ok).toBe(true);
    if (!dropFunction.ok) return;
    expect(dropFunction.data.sql).toBe('drop function "public"."get_user_stats"(bigint);');
    expect(dropFunction.data.requiresConfirmation).toBe(true);

    expect(dropView.ok).toBe(true);
    if (!dropView.ok) return;
    expect(dropView.data.sql).toBe('drop view "public"."active_users" cascade;');
  });
});
