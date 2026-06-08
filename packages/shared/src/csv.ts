import type { QueryExecutionResult } from './ipc.js';

export function queryResultToCsv(result: QueryExecutionResult): string {
  const header = result.columns.map((column) => escapeCsvCell(column.name)).join(',');
  const rows = result.rows.map((row) =>
    result.columns.map((column) => escapeCsvCell(row[column.name])).join(','),
  );
  return [header, ...rows].join('\r\n');
}

function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = stringifyCell(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function stringifyCell(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value.toString();
  }
  return JSON.stringify(value);
}
