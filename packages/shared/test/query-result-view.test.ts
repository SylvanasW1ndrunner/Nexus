import { describe, expect, it } from 'vitest';
import type { QueryExecutionResult } from '../src/index.js';
import {
  createQueryResultView,
  filterResultRows,
  formatResultCell,
  resolveVisibleResultColumns,
  toggleResultColumnVisibility,
} from '../src/index.js';

const result: QueryExecutionResult = {
  queryId: 'query-1',
  columns: [{ name: 'id' }, { name: 'customer' }, { name: 'metadata' }, { name: 'created_at' }],
  rows: [
    { id: 1, customer: 'Acme', metadata: { tier: 'enterprise' }, created_at: new Date('2026-06-01T00:00:00Z') },
    { id: 2, customer: 'Northwind', metadata: { tier: 'starter' }, created_at: new Date('2026-06-02T00:00:00Z') },
    { id: 3, customer: null, metadata: { tier: 'enterprise' }, created_at: new Date('2026-06-03T00:00:00Z') },
  ],
  rowCount: 3,
  elapsedMs: 12,
  safety: {
    statementKind: 'SELECT',
    riskLevel: 'safe',
    requiresConfirmation: false,
    blocked: false,
    reasons: [],
  },
};

describe('query result view contract', () => {
  it('keeps at least one visible column', () => {
    expect(resolveVisibleResultColumns(result.columns, ['customer']).map((column) => column.name)).toEqual(['customer']);
    expect(resolveVisibleResultColumns(result.columns, []).map((column) => column.name)).toEqual(['id']);
  });

  it('toggles columns without allowing an empty visible set', () => {
    expect(toggleResultColumnVisibility(['id', 'customer'], 'customer')).toEqual(['id']);
    expect(toggleResultColumnVisibility(['id'], 'id')).toEqual(['id']);
    expect(toggleResultColumnVisibility(['id'], 'metadata')).toEqual(['id', 'metadata']);
  });

  it('filters rows across visible columns only', () => {
    const customerColumn = result.columns[1]!;
    const metadataColumn = result.columns[2]!;
    expect(filterResultRows(result.rows, [customerColumn], 'north').map((row) => row.id)).toEqual([2]);
    expect(filterResultRows(result.rows, [metadataColumn], 'enterprise').map((row) => row.id)).toEqual([1, 3]);
    expect(filterResultRows(result.rows, [customerColumn], 'enterprise')).toEqual([]);
  });

  it('builds paged result views for export and table browsing', () => {
    const view = createQueryResultView(result, {
      visibleColumnNames: ['id', 'metadata'],
      searchText: 'enterprise',
      offset: 1,
      limit: 1,
    });

    expect(view.columns.map((column) => column.name)).toEqual(['id', 'metadata']);
    expect(view.totalRows).toBe(3);
    expect(view.filteredRows).toBe(2);
    expect(view.rows).toEqual([expect.objectContaining({ id: 3 })]);
  });

  it('formats SQL result values consistently for search', () => {
    expect(formatResultCell(null)).toBe('');
    expect(formatResultCell({ amount: 42 })).toBe('{"amount":42}');
    expect(formatResultCell(new Date('2026-06-01T00:00:00Z'))).toBe('2026-06-01T00:00:00.000Z');
    expect(formatResultCell(Buffer.from('abc'))).toBe('616263');
  });
});
