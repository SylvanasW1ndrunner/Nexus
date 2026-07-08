import type { QueryExecutionResult } from './ipc.js';
import { createQueryResultView, formatResultCell, type QueryResultViewOptions } from './query-result-view.js';

export type QueryResultExportFormat = 'csv' | 'json' | 'ndjson' | 'excel-xml';

export type QueryResultExportOptions = QueryResultViewOptions & {
  format: QueryResultExportFormat;
  baseName?: string;
  jsonMode?: 'document' | 'rows';
  escapeSpreadsheetFormulas?: boolean;
};

export type QueryResultExportArtifact = {
  format: QueryResultExportFormat;
  filename: string;
  mimeType: string;
  content: string;
  rowCount: number;
  columnCount: number;
};

type QueryResultView = ReturnType<typeof createQueryResultView>;

export function exportQueryResult(
  result: QueryExecutionResult,
  options: QueryResultExportOptions,
): QueryResultExportArtifact {
  const view = createQueryResultView(result, normalizeExportViewOptions(result, options));
  const baseName = sanitizeExportBaseName(options.baseName ?? `query-${result.queryId}`);
  const escapeSpreadsheetFormulas = options.escapeSpreadsheetFormulas ?? true;
  switch (options.format) {
    case 'csv':
      return artifact(
        'csv',
        `${baseName}.csv`,
        'text/csv;charset=utf-8',
        viewToCsv(view, escapeSpreadsheetFormulas),
        view,
      );
    case 'json':
      return artifact(
        'json',
        `${baseName}.json`,
        'application/json;charset=utf-8',
        viewToJsonDocument(result, view, options.jsonMode ?? 'document'),
        view,
      );
    case 'ndjson':
      return artifact(
        'ndjson',
        `${baseName}.ndjson`,
        'application/x-ndjson;charset=utf-8',
        `${view.rows.map((row) => JSON.stringify(rowToNormalizedObject(row, view.columns))).join('\n')}\n`,
        view,
      );
    case 'excel-xml':
      return artifact(
        'excel-xml',
        `${baseName}.xls`,
        'application/vnd.ms-excel;charset=utf-8',
        viewToExcelXml(result, view, escapeSpreadsheetFormulas),
        view,
      );
  }
}

export function queryResultToCsv(result: QueryExecutionResult): string {
  return exportQueryResult(result, { format: 'csv' }).content;
}

export function queryResultToJson(result: QueryExecutionResult): string {
  return `${JSON.stringify(
    {
      queryId: result.queryId,
      rowCount: result.rowCount,
      ...(result.returnedRowCount === undefined ? {} : { returnedRowCount: result.returnedRowCount }),
      ...(result.rowLimit === undefined ? {} : { rowLimit: result.rowLimit }),
      ...(result.hasMore === undefined ? {} : { hasMore: result.hasMore }),
      ...(result.truncated === undefined ? {} : { truncated: result.truncated }),
      elapsedMs: result.elapsedMs,
      columns: result.columns,
      rows: result.rows.map((row) => rowToNormalizedObject(row, result.columns)),
      safety: result.safety,
      ...(result.transaction === undefined ? {} : { transaction: result.transaction }),
    },
    null,
    2,
  )}\n`;
}

function artifact(
  format: QueryResultExportFormat,
  filename: string,
  mimeType: string,
  content: string,
  view: QueryResultView,
): QueryResultExportArtifact {
  return {
    format,
    filename,
    mimeType,
    content,
    rowCount: view.rows.length,
    columnCount: view.columns.length,
  };
}

function viewToCsv(view: QueryResultView, escapeSpreadsheetFormulas: boolean): string {
  const header = view.columns.map((column) => escapeCsvCell(column.name)).join(',');
  const rows = view.rows.map((row) =>
    view.columns.map((column) => escapeCsvCell(row[column.name], escapeSpreadsheetFormulas)).join(','),
  );
  return [header, ...rows].join('\r\n');
}

function viewToJsonDocument(result: QueryExecutionResult, view: QueryResultView, mode: 'document' | 'rows'): string {
  const rows = view.rows.map((row) => rowToNormalizedObject(row, view.columns));
  if (mode === 'rows') return `${JSON.stringify(rows, null, 2)}\n`;
  return `${JSON.stringify(
    {
      queryId: result.queryId,
      rowCount: result.rowCount,
      ...(result.returnedRowCount === undefined ? {} : { returnedRowCount: result.returnedRowCount }),
      exportedRowCount: view.rows.length,
      filteredRowCount: view.filteredRows,
      ...(result.rowLimit === undefined ? {} : { rowLimit: result.rowLimit }),
      ...(result.hasMore === undefined ? {} : { hasMore: result.hasMore }),
      ...(result.truncated === undefined ? {} : { truncated: result.truncated }),
      elapsedMs: result.elapsedMs,
      columns: view.columns,
      rows,
      safety: result.safety,
      ...(result.transaction === undefined ? {} : { transaction: result.transaction }),
    },
    null,
    2,
  )}\n`;
}

function viewToExcelXml(
  result: QueryExecutionResult,
  view: QueryResultView,
  escapeSpreadsheetFormulas: boolean,
): string {
  const resultRows = [
    `<Row>${view.columns.map((column) => excelCell(column.name, 'String')).join('')}</Row>`,
    ...view.rows.map(
      (row) =>
        `<Row>${view.columns.map((column) => excelCell(row[column.name], undefined, escapeSpreadsheetFormulas)).join('')}</Row>`,
    ),
  ];
  const metadataRows = [
    ['queryId', result.queryId],
    ['sourceRowCount', String(result.rowCount)],
    ...(result.returnedRowCount === undefined ? [] : [['returnedRowCount', String(result.returnedRowCount)]]),
    ['filteredRowCount', String(view.filteredRows)],
    ['exportedRowCount', String(view.rows.length)],
    ...(result.rowLimit === undefined ? [] : [['rowLimit', String(result.rowLimit)]]),
    ...(result.hasMore === undefined ? [] : [['hasMore', String(result.hasMore)]]),
    ...(result.truncated === undefined ? [] : [['truncated', String(result.truncated)]]),
    ['elapsedMs', String(result.elapsedMs)],
    ['riskLevel', result.safety.riskLevel],
    ['statementKind', result.safety.statementKind],
  ].map(([key, value]) => `<Row>${excelCell(key, 'String')}${excelCell(value, 'String')}</Row>`);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<?mso-application progid="Excel.Sheet"?>',
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"',
    ' xmlns:o="urn:schemas-microsoft-com:office:office"',
    ' xmlns:x="urn:schemas-microsoft-com:office:excel"',
    ' xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">',
    '<Worksheet ss:Name="Result"><Table>',
    ...resultRows,
    '</Table></Worksheet>',
    '<Worksheet ss:Name="Metadata"><Table>',
    ...metadataRows,
    '</Table></Worksheet>',
    '</Workbook>',
  ].join('');
}

function rowToNormalizedObject(
  row: QueryExecutionResult['rows'][number],
  columns: QueryExecutionResult['columns'],
): Record<string, unknown> {
  return Object.fromEntries(columns.map((column) => [column.name, normalizeJsonValue(row[column.name])]));
}

function escapeCsvCell(value: unknown, escapeSpreadsheetFormulas = false): string {
  if (value === null || value === undefined) return '';
  const text = formatSpreadsheetText(value, escapeSpreadsheetFormulas);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
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

function excelCell(value: unknown, explicitType?: 'String' | 'Number', escapeSpreadsheetFormulas = false): string {
  const type = explicitType ?? (typeof value === 'number' && Number.isFinite(value) ? 'Number' : 'String');
  const text = type === 'Number' ? String(value) : formatSpreadsheetText(value, escapeSpreadsheetFormulas);
  return `<Cell><Data ss:Type="${type}">${escapeXml(text)}</Data></Cell>`;
}

function formatSpreadsheetText(value: unknown, escapeSpreadsheetFormulas: boolean): string {
  const text = formatResultCell(value);
  if (!escapeSpreadsheetFormulas || typeof value !== 'string') return text;
  return isSpreadsheetFormulaLike(text) ? `'${text}` : text;
}

function isSpreadsheetFormulaLike(value: string): boolean {
  return /^[\t\r\n]/.test(value) || /^\s*[=+\-@]/.test(value);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function sanitizeExportBaseName(name: string): string {
  const sanitized = Array.from(name.trim().replace(/[<>:"/\\|?*]/g, '_'))
    .map((char) => (char.charCodeAt(0) < 32 ? '_' : char))
    .join('');
  return sanitized.length > 0 ? sanitized : 'query-result';
}

function normalizeExportViewOptions(
  result: QueryExecutionResult,
  options: QueryResultExportOptions,
): QueryResultViewOptions {
  return {
    ...options,
    visibleColumnNames: options.visibleColumnNames ?? result.columns.map((column) => column.name),
  };
}
