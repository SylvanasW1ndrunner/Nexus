import { describe, expect, it } from 'vitest';
import { ok, type QueryExecutionResult, type QueryRequest } from '@dbagent/shared';
import { buildExplainSql, createExplainWorkflow } from './explain-workflow.js';

describe('buildExplainSql', () => {
  it('wraps a single read query with PostgreSQL JSON explain', () => {
    const result = buildExplainSql('select * from orders where status = $1 limit 20');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toBe('EXPLAIN (FORMAT JSON) select * from orders where status = $1 limit 20');
  });

  it('allows WITH and VALUES read queries', () => {
    expect(buildExplainSql('with recent as (select * from orders) select * from recent').ok).toBe(true);
    expect(buildExplainSql('values (1), (2)').ok).toBe(true);
  });

  it('rejects empty and multi-statement input before execution', () => {
    expect(buildExplainSql('   ').ok).toBe(false);
    const result = buildExplainSql('select 1; select 2');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(result.error.message).toContain('one read query');
  });

  it('rejects writes and DDL instead of explaining them through read-only mode', () => {
    const updateResult = buildExplainSql("update orders set status = 'paid' where id = 1");
    const dropResult = buildExplainSql('drop table orders');

    expect(updateResult.ok).toBe(false);
    expect(dropResult.ok).toBe(false);
    if (updateResult.ok) return;
    expect(updateResult.error.code).toBe('VALIDATION_ERROR');
    expect(updateResult.error.detail).toBe('Received UPDATE.');
  });
});

describe('createExplainWorkflow', () => {
  it('delegates safe explain SQL to the normal query workflow', async () => {
    const calls: QueryRequest[] = [];
    const workflow = createExplainWorkflow({
      executeQuery(request) {
        calls.push(request);
        return Promise.resolve(ok(queryResult));
      },
    });

    const result = await workflow({
      connectionId: 'conn-local',
      sql: 'select id, total from orders limit 10',
      confirmed: true,
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      {
        connectionId: 'conn-local',
        sql: 'EXPLAIN (FORMAT JSON) select id, total from orders limit 10',
        confirmed: false,
      },
    ]);
  });

  it('does not delegate rejected SQL to the query workflow', async () => {
    const calls: QueryRequest[] = [];
    const workflow = createExplainWorkflow({
      executeQuery(request) {
        calls.push(request);
        return Promise.resolve(ok(queryResult));
      },
    });

    const result = await workflow({
      connectionId: 'conn-local',
      sql: 'delete from orders where created_at < now()',
    });

    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

const queryResult: QueryExecutionResult = {
  queryId: 'query-explain',
  columns: [{ name: 'QUERY PLAN', dataType: 'json' }],
  rows: [{ 'QUERY PLAN': { Plan: { 'Node Type': 'Limit' } } }],
  rowCount: 1,
  elapsedMs: 7,
  safety: {
    statementKind: 'EXPLAIN',
    riskLevel: 'safe',
    requiresConfirmation: false,
    blocked: false,
    reasons: [],
  },
};
