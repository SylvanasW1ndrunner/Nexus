import type { QueryExecutionResult, QueryResultRow } from '@dbagent/shared';

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
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value.toString();
  if (typeof value === 'symbol') return value.description ?? '';
  if (typeof value === 'function') return '[Function]';
  return '';
}
