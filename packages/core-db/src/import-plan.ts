import type { Result } from '@dbagent/shared';
import { err, ok } from '@dbagent/shared';
import { quotePgIdentifier } from './sql-builder.js';

export type ImportSourceFormat = 'csv' | 'json';

export type CsvImportParseOptions = {
  delimiter?: string;
  quote?: string;
  hasHeader?: boolean;
  previewRows?: number;
};

export type JsonImportParseOptions = {
  previewRows?: number;
};

export type ImportPreviewColumn = {
  name: string;
  index: number;
};

export type ImportPreview = {
  format: ImportSourceFormat;
  columns: ImportPreviewColumn[];
  rows: ImportPreviewRow[];
  totalRows: number;
  truncated: boolean;
  warnings: string[];
};

export type ImportPreviewRow = {
  rowNumber: number;
  values: Record<string, string | number | boolean | null>;
};

export type ImportColumnMapping = {
  sourceColumn?: string;
  targetColumn: string;
  defaultValue?: string | number | boolean | null;
  skipEmpty?: boolean;
};

export type BuildImportPlanRequest = {
  schema: string;
  table: string;
  rows: ImportPreviewRow[];
  mappings: ImportColumnMapping[];
  mode: 'insert' | 'upsert' | 'truncate-insert';
  conflictColumns?: string[];
  batchSize?: number;
  transactionMode?: 'single' | 'batch';
  errorHandling?: 'abort' | 'skip';
};

export type ImportSqlBatch = {
  index: number;
  sql: string;
  params: unknown[];
  rowNumbers: number[];
};

export type ImportExecutionPlan = {
  mode: BuildImportPlanRequest['mode'];
  transactionMode: 'single' | 'batch';
  errorHandling: 'abort' | 'skip';
  target: {
    schema: string;
    table: string;
  };
  columns: string[];
  totalRows: number;
  batchSize: number;
  batches: ImportSqlBatch[];
  preludeSql: string[];
  warnings: string[];
  requiresConfirmation: true;
};

const DEFAULT_PREVIEW_ROWS = 10;
const DEFAULT_IMPORT_BATCH_SIZE = 1000;
const MAX_IMPORT_BATCH_SIZE = 5000;

export function parseCsvImportPreview(content: string, options: CsvImportParseOptions = {}): Result<ImportPreview> {
  const delimiter = options.delimiter ?? ',';
  const quote = options.quote ?? '"';
  if (delimiter.length !== 1) return err({ code: 'VALIDATION_ERROR', message: 'CSV delimiter must be one character.' });
  if (quote.length !== 1) return err({ code: 'VALIDATION_ERROR', message: 'CSV quote must be one character.' });

  const records = parseCsvRecords(content, delimiter, quote);
  if (!records.ok) return records;
  if (records.data.length === 0) {
    return ok({ format: 'csv', columns: [], rows: [], totalRows: 0, truncated: false, warnings: ['CSV source is empty.'] });
  }

  const hasHeader = options.hasHeader ?? true;
  const header = hasHeader ? records.data[0] ?? [] : records.data[0]?.map((_, index) => `column_${index + 1}`) ?? [];
  const dataRows = hasHeader ? records.data.slice(1) : records.data;
  const columns = buildPreviewColumns(header);
  const previewLimit = normalizePreviewRows(options.previewRows);
  const warnings: string[] = [];
  if (columns.length === 0 && dataRows.length > 0) warnings.push('CSV source has rows but no columns.');

  return ok({
    format: 'csv',
    columns,
    rows: dataRows.slice(0, previewLimit).map((row, index) => toPreviewRow(row, columns, index + (hasHeader ? 2 : 1))),
    totalRows: dataRows.length,
    truncated: dataRows.length > previewLimit,
    warnings,
  });
}

export function parseJsonImportPreview(content: string, options: JsonImportParseOptions = {}): Result<ImportPreview> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return err({ code: 'VALIDATION_ERROR', message: 'JSON source cannot be parsed.', detail: String(error) });
  }

  const rawRows = Array.isArray(parsed) ? parsed : [parsed];
  if (!rawRows.every((row) => typeof row === 'object' && row !== null && !Array.isArray(row))) {
    return err({ code: 'VALIDATION_ERROR', message: 'JSON import source must be an object or an array of objects.' });
  }

  const keys = new Set<string>();
  for (const row of rawRows as Record<string, unknown>[]) {
    Object.keys(row).forEach((key) => keys.add(key));
  }
  const columns = buildPreviewColumns([...keys]);
  const previewLimit = normalizePreviewRows(options.previewRows);
  return ok({
    format: 'json',
    columns,
    rows: (rawRows as Record<string, unknown>[])
      .slice(0, previewLimit)
      .map((row, index) => ({ rowNumber: index + 1, values: objectToPreviewValues(row, columns) })),
    totalRows: rawRows.length,
    truncated: rawRows.length > previewLimit,
    warnings: [],
  });
}

export function buildImportExecutionPlan(request: BuildImportPlanRequest): Result<ImportExecutionPlan> {
  const target = validateTarget(request.schema, request.table);
  if (!target.ok) return target;
  if (request.rows.length === 0) return err({ code: 'VALIDATION_ERROR', message: 'Import plan requires at least one row.' });
  if (request.mappings.length === 0) return err({ code: 'VALIDATION_ERROR', message: 'Import plan requires at least one column mapping.' });

  const columns = normalizeMappings(request.mappings);
  if (!columns.ok) return columns;
  if (request.mode === 'upsert' && (!request.conflictColumns || request.conflictColumns.length === 0)) {
    return err({ code: 'VALIDATION_ERROR', message: 'UPSERT import requires conflict columns.' });
  }

  const conflictColumns = request.conflictColumns ?? [];
  for (const column of conflictColumns) {
    const validation = validateIdentifier(column, 'Conflict column');
    if (!validation.ok) return validation;
  }

  const batchSize = normalizeBatchSize(request.batchSize);
  const warnings: string[] = [];
  if (request.errorHandling === 'skip') {
    warnings.push('Skip-on-error requires batch transaction mode or row-level retry by the caller.');
  }

  const batches: ImportSqlBatch[] = [];
  for (let offset = 0; offset < request.rows.length; offset += batchSize) {
    const rows = request.rows.slice(offset, offset + batchSize);
    batches.push(buildBatch(request, columns.data, conflictColumns, rows, batches.length));
  }

  return ok({
    mode: request.mode,
    transactionMode: request.transactionMode ?? 'single',
    errorHandling: request.errorHandling ?? 'abort',
    target: { schema: request.schema, table: request.table },
    columns: columns.data.map((mapping) => mapping.targetColumn),
    totalRows: request.rows.length,
    batchSize,
    batches,
    preludeSql: request.mode === 'truncate-insert' ? [`truncate table ${qualifiedTable(request.schema, request.table)};`] : [],
    warnings,
    requiresConfirmation: true,
  });
}

function buildBatch(
  request: BuildImportPlanRequest,
  mappings: Required<Pick<ImportColumnMapping, 'targetColumn'>>[] & ImportColumnMapping[],
  conflictColumns: string[],
  rows: ImportPreviewRow[],
  index: number,
): ImportSqlBatch {
  const params: unknown[] = [];
  const valueGroups = rows.map((row) => {
    const placeholders = mappings.map((mapping) => {
      params.push(readMappedValue(row, mapping));
      return `$${params.length}`;
    });
    return `(${placeholders.join(', ')})`;
  });

  const targetColumns = mappings.map((mapping) => quotePgIdentifier(mapping.targetColumn));
  const sqlParts = [
    `insert into ${qualifiedTable(request.schema, request.table)} (${targetColumns.join(', ')})`,
    `values ${valueGroups.join(', ')}`,
  ];

  if (request.mode === 'upsert') {
    const updates = mappings
      .filter((mapping) => !conflictColumns.includes(mapping.targetColumn))
      .map((mapping) => `${quotePgIdentifier(mapping.targetColumn)} = excluded.${quotePgIdentifier(mapping.targetColumn)}`);
    sqlParts.push(`on conflict (${conflictColumns.map(quotePgIdentifier).join(', ')})`);
    sqlParts.push(updates.length > 0 ? `do update set ${updates.join(', ')}` : 'do nothing');
  }

  return {
    index,
    sql: `${sqlParts.join('\n')};`,
    params,
    rowNumbers: rows.map((row) => row.rowNumber),
  };
}

function readMappedValue(row: ImportPreviewRow, mapping: ImportColumnMapping): unknown {
  if (!mapping.sourceColumn) return mapping.defaultValue ?? null;
  const value = row.values[mapping.sourceColumn];
  if (mapping.skipEmpty && value === '') return mapping.defaultValue ?? null;
  return value ?? mapping.defaultValue ?? null;
}

function normalizeMappings(mappings: ImportColumnMapping[]): Result<(Required<Pick<ImportColumnMapping, 'targetColumn'>> & ImportColumnMapping)[]> {
  const seen = new Set<string>();
  const normalized: (Required<Pick<ImportColumnMapping, 'targetColumn'>> & ImportColumnMapping)[] = [];
  for (const mapping of mappings) {
    const targetColumn = mapping.targetColumn.trim();
    const validation = validateIdentifier(targetColumn, 'Target column');
    if (!validation.ok) return validation;
    if (seen.has(targetColumn)) {
      return err({ code: 'VALIDATION_ERROR', message: `Duplicate target column mapping: ${targetColumn}.` });
    }
    seen.add(targetColumn);
    normalized.push({ ...mapping, targetColumn });
  }
  return ok(normalized);
}

function parseCsvRecords(content: string, delimiter: string, quote: string): Result<string[][]> {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuote = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index] ?? '';
    const next = content[index + 1];
    if (char === quote) {
      if (inQuote && next === quote) {
        cell += quote;
        index += 1;
      } else {
        inQuote = !inQuote;
      }
    } else if (char === delimiter && !inQuote) {
      row.push(cell);
      cell = '';
    } else if ((char === '\n' || char === '\r') && !inQuote) {
      if (char === '\r' && next === '\n') index += 1;
      row.push(cell);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (inQuote) return err({ code: 'VALIDATION_ERROR', message: 'CSV source has an unclosed quoted field.' });
  row.push(cell);
  if (row.some((value) => value.length > 0)) rows.push(row);
  return ok(rows);
}

function buildPreviewColumns(header: string[]): ImportPreviewColumn[] {
  const seen = new Map<string, number>();
  return header.map((rawName, index) => {
    const base = rawName.trim() || `column_${index + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return {
      name: count === 0 ? base : `${base}_${count + 1}`,
      index,
    };
  });
}

function toPreviewRow(row: string[], columns: ImportPreviewColumn[], rowNumber: number): ImportPreviewRow {
  const values: ImportPreviewRow['values'] = {};
  for (const column of columns) {
    values[column.name] = row[column.index] ?? '';
  }
  return { rowNumber, values };
}

function objectToPreviewValues(row: Record<string, unknown>, columns: ImportPreviewColumn[]): ImportPreviewRow['values'] {
  const values: ImportPreviewRow['values'] = {};
  for (const column of columns) {
    const value = row[column.name];
    values[column.name] = normalizeJsonScalar(value);
  }
  return values;
}

function normalizeJsonScalar(value: unknown): string | number | boolean | null {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value === undefined) return null;
  return JSON.stringify(value);
}

function normalizePreviewRows(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_PREVIEW_ROWS;
  return Math.max(0, Math.min(Math.floor(limit), 100));
}

function normalizeBatchSize(batchSize: number | undefined): number {
  if (batchSize === undefined || !Number.isFinite(batchSize)) return DEFAULT_IMPORT_BATCH_SIZE;
  return Math.max(1, Math.min(Math.floor(batchSize), MAX_IMPORT_BATCH_SIZE));
}

function validateTarget(schema: string, table: string): Result<void> {
  const schemaValidation = validateIdentifier(schema, 'Schema');
  if (!schemaValidation.ok) return schemaValidation;
  return validateIdentifier(table, 'Table');
}

function validateIdentifier(identifier: string, label: string): Result<void> {
  if (!identifier || identifier.trim().length === 0) {
    return err({ code: 'VALIDATION_ERROR', message: `${label} name is required.` });
  }
  if (identifier.includes('\0')) {
    return err({ code: 'VALIDATION_ERROR', message: `${label} name contains an invalid null byte.` });
  }
  return ok(undefined);
}

function qualifiedTable(schema: string, table: string): string {
  return `${quotePgIdentifier(schema)}.${quotePgIdentifier(table)}`;
}
