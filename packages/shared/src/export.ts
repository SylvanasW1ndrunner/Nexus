import type { QueryExecutionResult } from './ipc.js';

export function queryResultToJson(result: QueryExecutionResult): string {
  return `${JSON.stringify(
    {
      queryId: result.queryId,
      rowCount: result.rowCount,
      elapsedMs: result.elapsedMs,
      columns: result.columns,
      rows: result.rows.map((row) =>
        Object.fromEntries(result.columns.map((column) => [column.name, normalizeJsonValue(row[column.name])])),
      ),
      safety: result.safety,
    },
    null,
    2,
  )}\n`;
}

function normalizeJsonValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (Array.isArray(value)) return value.map((item) => normalizeJsonValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeJsonValue(item)]));
  }
  return value;
}
