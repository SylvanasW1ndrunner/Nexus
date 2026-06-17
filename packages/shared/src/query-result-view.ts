import type { QueryResultRow } from './domain.js';
import type { QueryExecutionResult } from './ipc.js';

export type QueryResultViewOptions = {
  visibleColumnNames?: string[];
  searchText?: string;
  offset?: number;
  limit?: number;
};

export type QueryResultView = {
  columns: QueryExecutionResult['columns'];
  rows: QueryResultRow[];
  totalRows: number;
  filteredRows: number;
  offset: number;
  limit: number;
};

export function createQueryResultView(
  result: QueryExecutionResult,
  options: QueryResultViewOptions = {},
): QueryResultView {
  const columns = resolveVisibleResultColumns(result.columns, options.visibleColumnNames ?? []);
  const filtered = filterResultRows(result.rows, columns, options.searchText ?? '');
  const offset = normalizeOffset(options.offset);
  const limit = normalizeLimit(options.limit, filtered.length);
  return {
    columns,
    rows: filtered.slice(offset, offset + limit),
    totalRows: result.rows.length,
    filteredRows: filtered.length,
    offset,
    limit,
  };
}

export function resolveVisibleResultColumns(
  columns: QueryExecutionResult['columns'],
  visibleColumnNames: string[],
): QueryExecutionResult['columns'] {
  const selected = columns.filter((column) => visibleColumnNames.includes(column.name));
  return selected.length > 0 ? selected : columns.slice(0, 1);
}

export function toggleResultColumnVisibility(visibleColumnNames: string[], columnName: string): string[] {
  if (!visibleColumnNames.includes(columnName)) return [...visibleColumnNames, columnName];
  if (visibleColumnNames.length <= 1) return visibleColumnNames;
  return visibleColumnNames.filter((name) => name !== columnName);
}

export function filterResultRows(
  rows: QueryResultRow[],
  columns: QueryExecutionResult['columns'],
  searchText: string,
): QueryResultRow[] {
  const keyword = searchText.trim().toLowerCase();
  if (!keyword) return rows;
  return rows.filter((row) => columns.some((column) => formatResultCell(row[column.name]).toLowerCase().includes(keyword)));
}

export function formatResultCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('hex');
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value.toString();
  if (typeof value === 'symbol') return value.description ?? '';
  if (typeof value === 'function') return '[Function]';
  return '';
}

function normalizeOffset(offset: number | undefined): number {
  if (!Number.isFinite(offset) || offset === undefined) return 0;
  return Math.max(0, Math.floor(offset));
}

function normalizeLimit(limit: number | undefined, rowCount: number): number {
  if (!Number.isFinite(limit) || limit === undefined) return rowCount;
  return Math.max(0, Math.floor(limit));
}
