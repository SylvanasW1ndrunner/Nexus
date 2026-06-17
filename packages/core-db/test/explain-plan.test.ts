import { describe, expect, it } from 'vitest';
import { analyzePostgresExplainJson } from '../src/index.js';

describe('PostgreSQL EXPLAIN JSON analyzer', () => {
  it('normalizes a PostgreSQL FORMAT JSON array into a stable plan tree and warnings', () => {
    const analysis = analyzePostgresExplainJson([
      {
        Plan: {
          'Node Type': 'Nested Loop',
          'Join Type': 'Inner',
          'Startup Cost': 0.57,
          'Total Cost': 150000,
          'Plan Rows': 20000,
          'Actual Rows': 25000,
          'Actual Total Time': 1500,
          Plans: [
            {
              'Node Type': 'Seq Scan',
              'Relation Name': 'users',
              Filter: "status = 'active'",
              'Plan Rows': 100000,
              'Actual Rows': 1200,
              'Rows Removed by Filter': 50000,
              'Actual Total Time': 1200,
            },
            {
              'Node Type': 'Index Scan',
              'Relation Name': 'orders',
              'Index Name': 'ix_orders_user_id',
              'Index Cond': 'user_id = users.id',
              'Plan Rows': 10,
              'Actual Rows': 8,
              'Actual Total Time': 12,
            },
          ],
        },
        'Planning Time': 1.2,
        'Execution Time': 1550.5,
      },
    ]);

    expect(analysis.ok).toBe(true);
    if (!analysis.ok) return;
    expect(analysis.data.planningTimeMs).toBe(1.2);
    expect(analysis.data.executionTimeMs).toBe(1550.5);
    expect(analysis.data.root).toMatchObject({
      id: '0',
      nodeType: 'Nested Loop',
      joinType: 'Inner',
      actualRows: 25000,
      totalCost: 150000,
    });
    expect(analysis.data.root.children).toHaveLength(2);
    expect(analysis.data.flattened.map((node) => node.id)).toEqual(['0', '0.0', '0.1']);
    expect(analysis.data.flattened[1]).toMatchObject({
      nodeType: 'Seq Scan',
      relationName: 'users',
      filter: "status = 'active'",
      rowsRemovedByFilter: 50000,
    });
    expect(analysis.data.warnings.map((warning) => warning.kind)).toEqual([
      'high_cost',
      'slow_node',
      'nested_loop_large_input',
      'sequential_scan',
      'slow_node',
      'large_filter',
    ]);
  });

  it('accepts the QUERY PLAN cell shape returned by the query workflow', () => {
    const analysis = analyzePostgresExplainJson({
      'QUERY PLAN': [
        {
          Plan: {
            'Node Type': 'Sort',
            'Plan Rows': 150000,
            'Total Cost': 4000,
            Plans: [{ 'Node Type': 'Index Scan', 'Index Name': 'ix_orders_created_at' }],
          },
        },
      ],
    });

    expect(analysis.ok).toBe(true);
    if (!analysis.ok) return;
    expect(analysis.data.root.nodeType).toBe('Sort');
    expect(analysis.data.root.children[0]?.indexName).toBe('ix_orders_created_at');
    expect(analysis.data.warnings).toEqual([
      {
        kind: 'sort_spill_risk',
        nodeId: '0',
        severity: 'info',
        message: 'Sort sorts many rows; check work_mem and supporting indexes.',
      },
    ]);
  });

  it('keeps optional metrics absent instead of inventing values', () => {
    const analysis = analyzePostgresExplainJson([{ Plan: { 'Node Type': 'Limit' } }]);

    expect(analysis.ok).toBe(true);
    if (!analysis.ok) return;
    expect(analysis.data.root).toEqual({
      id: '0',
      nodeType: 'Limit',
      children: [],
    });
    expect(analysis.data.warnings).toEqual([]);
  });

  it('rejects malformed explain payloads with validation errors', () => {
    const nonJson = analyzePostgresExplainJson('not-json');
    const missingPlan = analyzePostgresExplainJson([{ 'Execution Time': 1 }]);

    expect(nonJson.ok).toBe(false);
    if (!nonJson.ok) {
      expect(nonJson.error).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'EXPLAIN JSON must be an object or a PostgreSQL FORMAT JSON array.',
      });
    }
    expect(missingPlan.ok).toBe(false);
    if (!missingPlan.ok) {
      expect(missingPlan.error).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'EXPLAIN JSON does not contain a Plan object.',
      });
    }
  });
});
