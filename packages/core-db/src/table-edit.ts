import type { DbColumnValue, QueryRiskLevel, Result } from '@dbagent/shared';
import { err, ok } from '@dbagent/shared';
import { quotePgIdentifier } from './sql-builder.js';

export type TableEditOperation =
  | {
      type: 'insert';
      values: Record<string, DbColumnValue>;
    }
  | {
      type: 'update';
      key: Record<string, DbColumnValue>;
      values: Record<string, DbColumnValue>;
    }
  | {
      type: 'delete';
      key: Record<string, DbColumnValue>;
    };

export type BuildTableEditPreviewRequest = {
  schema: string;
  table: string;
  primaryKey: string[];
  operations: TableEditOperation[];
  maxOperationsBeforeExtraConfirmation?: number;
};

export type TableEditStatementPreview = {
  operation: TableEditOperation['type'];
  sql: string;
  riskLevel: QueryRiskLevel;
  warnings: string[];
};

export type TableEditPreview = {
  sql: string;
  statements: TableEditStatementPreview[];
  operationCount: number;
  estimatedAffectedRows: number;
  riskLevel: QueryRiskLevel;
  requiresConfirmation: boolean;
  requiresExtraConfirmation: boolean;
  warnings: string[];
};

const DEFAULT_EXTRA_CONFIRMATION_THRESHOLD = 50;

export function buildTableEditPreview(request: BuildTableEditPreviewRequest): Result<TableEditPreview> {
  const target = validateTableTarget(request.schema, request.table);
  if (!target.ok) return target;

  if (request.operations.length === 0) {
    return err({ code: 'VALIDATION_ERROR', message: 'At least one table edit operation is required.' });
  }

  const primaryKey = request.primaryKey.map((column) => column.trim()).filter(Boolean);
  const statements: TableEditStatementPreview[] = [];
  const warnings = new Set<string>();

  for (const operation of request.operations) {
    const statement = buildOperationSql(request.schema, request.table, primaryKey, operation);
    if (!statement.ok) return statement;
    statements.push(statement.data);
    statement.data.warnings.forEach((warning) => warnings.add(warning));
  }

  const operationCount = statements.length;
  const threshold = request.maxOperationsBeforeExtraConfirmation ?? DEFAULT_EXTRA_CONFIRMATION_THRESHOLD;
  const requiresExtraConfirmation = operationCount > threshold;
  if (requiresExtraConfirmation) {
    warnings.add(`Batch contains ${operationCount} operations and requires extra confirmation.`);
  }

  const riskLevel = mergeRiskLevels(statements.map((statement) => statement.riskLevel));
  return ok({
    sql: statements.map((statement) => statement.sql).join('\n'),
    statements,
    operationCount,
    estimatedAffectedRows: operationCount,
    riskLevel,
    requiresConfirmation: true,
    requiresExtraConfirmation,
    warnings: [...warnings],
  });
}

function buildOperationSql(
  schema: string,
  table: string,
  primaryKey: string[],
  operation: TableEditOperation,
): Result<TableEditStatementPreview> {
  switch (operation.type) {
    case 'insert':
      return buildInsertSql(schema, table, operation.values);
    case 'update':
      return buildUpdateSql(schema, table, primaryKey, operation.key, operation.values);
    case 'delete':
      return buildDeleteSql(schema, table, primaryKey, operation.key);
  }
}

function buildInsertSql(
  schema: string,
  table: string,
  values: Record<string, DbColumnValue>,
): Result<TableEditStatementPreview> {
  const entries = validatedEntries(values);
  if (!entries.ok) return entries;
  if (entries.data.length === 0) {
    return err({ code: 'VALIDATION_ERROR', message: 'Insert operation requires at least one column value.' });
  }

  const columns = entries.data.map(([column]) => quotePgIdentifier(column)).join(', ');
  const literals = entries.data.map(([, value]) => toPostgresLiteral(value)).join(', ');
  return ok({
    operation: 'insert',
    sql: `insert into ${qualifiedTable(schema, table)} (${columns}) values (${literals});`,
    riskLevel: 'caution',
    warnings: ['INSERT writes data and must run inside a transaction.'],
  });
}

function buildUpdateSql(
  schema: string,
  table: string,
  primaryKey: string[],
  key: Record<string, DbColumnValue>,
  values: Record<string, DbColumnValue>,
): Result<TableEditStatementPreview> {
  const keyValidation = validatePrimaryKey(primaryKey, key, 'Update');
  if (!keyValidation.ok) return keyValidation;

  const entries = validatedEntries(values);
  if (!entries.ok) return entries;
  if (entries.data.length === 0) {
    return err({ code: 'VALIDATION_ERROR', message: 'Update operation requires at least one changed column.' });
  }
  const keyColumns = new Set(primaryKey);
  if (entries.data.some(([column]) => keyColumns.has(column))) {
    return err({ code: 'VALIDATION_ERROR', message: 'Primary key columns cannot be edited through table cell updates.' });
  }

  const assignments = entries.data.map(([column, value]) => `${quotePgIdentifier(column)} = ${toPostgresLiteral(value)}`);
  return ok({
    operation: 'update',
    sql: `update ${qualifiedTable(schema, table)} set ${assignments.join(', ')} where ${whereByPrimaryKey(primaryKey, key)};`,
    riskLevel: 'caution',
    warnings: ['UPDATE uses the table primary key in WHERE and must run inside a transaction.'],
  });
}

function buildDeleteSql(
  schema: string,
  table: string,
  primaryKey: string[],
  key: Record<string, DbColumnValue>,
): Result<TableEditStatementPreview> {
  const keyValidation = validatePrimaryKey(primaryKey, key, 'Delete');
  if (!keyValidation.ok) return keyValidation;

  return ok({
    operation: 'delete',
    sql: `delete from ${qualifiedTable(schema, table)} where ${whereByPrimaryKey(primaryKey, key)};`,
    riskLevel: 'dangerous',
    warnings: ['DELETE removes data and must run inside a transaction.'],
  });
}

function validatePrimaryKey(primaryKey: string[], key: Record<string, DbColumnValue>, operationName: string): Result<void> {
  if (primaryKey.length === 0) {
    return err({
      code: 'UNSUPPORTED_OPERATION',
      message: `${operationName} operation requires a primary key. Tables without primary keys cannot be edited safely.`,
    });
  }

  for (const column of primaryKey) {
    if (!(column in key)) {
      return err({ code: 'VALIDATION_ERROR', message: `${operationName} operation is missing primary key column: ${column}.` });
    }
    const value = key[column];
    if (value === undefined) {
      return err({ code: 'VALIDATION_ERROR', message: `${operationName} primary key value cannot be undefined: ${column}.` });
    }
    if (value === null) {
      return err({ code: 'VALIDATION_ERROR', message: `${operationName} primary key value cannot be null: ${column}.` });
    }
    const valueValidation = validateSupportedValue(value, `Primary key ${column}`);
    if (!valueValidation.ok) return valueValidation;
  }
  return ok(undefined);
}

function validatedEntries(values: Record<string, DbColumnValue>): Result<Array<[string, DbColumnValue]>> {
  const entries = Object.entries(values);
  for (const [column, value] of entries) {
    const validation = validateIdentifier(column, 'Column');
    if (!validation.ok) return validation;
    const valueValidation = validateSupportedValue(value, `Column ${column}`);
    if (!valueValidation.ok) return valueValidation;
  }
  return ok(entries);
}

function validateTableTarget(schema: string, table: string): Result<void> {
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

function validateSupportedValue(value: DbColumnValue, label: string): Result<void> {
  if (value === undefined) {
    return err({ code: 'VALIDATION_ERROR', message: `${label} value cannot be undefined.` });
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return err({ code: 'VALIDATION_ERROR', message: `${label} value must be a finite number.` });
  }
  if (value instanceof Date && Number.isNaN(value.getTime())) {
    return err({ code: 'VALIDATION_ERROR', message: `${label} value must be a valid date.` });
  }
  return ok(undefined);
}

function qualifiedTable(schema: string, table: string): string {
  return `${quotePgIdentifier(schema)}.${quotePgIdentifier(table)}`;
}

function whereByPrimaryKey(primaryKey: string[], key: Record<string, DbColumnValue>): string {
  return primaryKey
    .map((column) => `${quotePgIdentifier(column)} = ${toPostgresLiteral(getPrimaryKeyValue(key, column))}`)
    .join(' and ');
}

function getPrimaryKeyValue(key: Record<string, DbColumnValue>, column: string): DbColumnValue {
  const value = key[column];
  if (value === undefined) {
    throw new Error(`Primary key column was not validated before SQL generation: ${column}`);
  }
  return value;
}

function toPostgresLiteral(value: DbColumnValue): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return `'${escapeSqlString(value.toISOString())}'`;
  if (Buffer.isBuffer(value)) return `'\\\\x${value.toString('hex')}'::bytea`;
  if (typeof value === 'object') return `'${escapeSqlString(JSON.stringify(value))}'::jsonb`;
  return `'${escapeSqlString(value)}'`;
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function mergeRiskLevels(levels: QueryRiskLevel[]): QueryRiskLevel {
  if (levels.includes('blocked')) return 'blocked';
  if (levels.includes('dangerous')) return 'dangerous';
  if (levels.includes('caution')) return 'caution';
  return 'safe';
}
