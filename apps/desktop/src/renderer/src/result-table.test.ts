import { describe, expect, it } from 'vitest';
import type { QueryExecutionResult } from '@dbagent/shared';
import {
  filterResultRows,
  formatResultCell,
  resolveVisibleResultColumns,
  toggleResultColumnVisibility,
} from './result-table.js';

const columns: QueryExecutionResult['columns'] = [
  { name: 'id' },
  { name: 'customer' },
  { name: 'metadata' },
];

const rows: QueryExecutionResult['rows'] = [
  { id: 1, customer: 'Acme', metadata: { tier: 'enterprise' } },
  { id: 2, customer: 'Northwind', metadata: { tier: 'starter' } },
  { id: 3, customer: null, metadata: { tier: 'enterprise' } },
];

describe('result table filtering', () => {
  const customerColumn = columns[1]!;
  const metadataColumn = columns[2]!;

  it('resolves selected columns and keeps at least one visible column', () => {
    expect(resolveVisibleResultColumns(columns, ['customer']).map((column) => column.name)).toEqual(['customer']);
    expect(resolveVisibleResultColumns(columns, []).map((column) => column.name)).toEqual(['id']);
  });

  it('toggles columns without allowing an empty visible column set', () => {
    expect(toggleResultColumnVisibility(['id', 'customer'], 'customer')).toEqual(['id']);
    expect(toggleResultColumnVisibility(['id'], 'id')).toEqual(['id']);
    expect(toggleResultColumnVisibility(['id'], 'metadata')).toEqual(['id', 'metadata']);
  });

  it('filters rows across currently visible columns', () => {
    expect(filterResultRows(rows, [customerColumn], 'north').map((row) => row.id)).toEqual([2]);
    expect(filterResultRows(rows, [metadataColumn], 'enterprise').map((row) => row.id)).toEqual([1, 3]);
    expect(filterResultRows(rows, [customerColumn], 'enterprise')).toEqual([]);
  });

  it('formats SQL result cell values for display and search', () => {
    expect(formatResultCell(null)).toBe('');
    expect(formatResultCell({ amount: 42 })).toBe('{"amount":42}');
    expect(formatResultCell('paid')).toBe('paid');
  });
});
