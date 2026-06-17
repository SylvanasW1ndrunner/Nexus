import type { QueryRiskLevel, Result } from '@dbagent/shared';
import { err, ok } from '@dbagent/shared';
import { quotePgIdentifier } from './sql-builder.js';

export type PgIndexMethod = 'btree' | 'hash' | 'gin' | 'gist' | 'brin';

export type IndexColumnSort = {
  direction?: 'asc' | 'desc';
  nulls?: 'first' | 'last';
};

export type IndexColumnDefinition =
  | ({
      column: string;
      opClass?: string;
    } & IndexColumnSort)
  | ({
      expression: string;
    } & IndexColumnSort);

export type BuildCreateIndexPreviewRequest = {
  schema: string;
  table: string;
  name?: string;
  method?: PgIndexMethod;
  columns: IndexColumnDefinition[];
  unique?: boolean;
  concurrently?: boolean;
  whereSql?: string;
};

export type BuildDropIndexPreviewRequest = {
  schema: string;
  name: string;
  concurrently?: boolean;
  ifExists?: boolean;
  cascade?: boolean;
};

export type IndexPreview = {
  sql: string;
  statements: string[];
  riskLevel: QueryRiskLevel;
  requiresConfirmation: boolean;
  warnings: string[];
};

export function buildCreateIndexPreview(request: BuildCreateIndexPreviewRequest): Result<IndexPreview> {
  const target = validateTarget(request.schema, request.table, 'Table');
  if (!target.ok) return target;
  if (request.columns.length === 0) {
    return err({ code: 'VALIDATION_ERROR', message: 'Index requires at least one column or expression.' });
  }

  const method = request.method ?? 'btree';
  const name = request.name?.trim() || buildDefaultIndexName(request.table, request.columns);
  const nameValidation = validateIdentifier(name, 'Index');
  if (!nameValidation.ok) return nameValidation;

  const columns: string[] = [];
  for (const column of request.columns) {
    const built = buildIndexColumnSql(column);
    if (!built.ok) return built;
    columns.push(built.data);
  }

  const warnings: string[] = [];
  const parts = [
    'create',
    request.unique ? 'unique' : undefined,
    'index',
    request.concurrently ? 'concurrently' : undefined,
    quotePgIdentifier(name),
    'on',
    qualifiedName(request.schema, request.table),
    'using',
    method,
    `(${columns.join(', ')})`,
  ].filter((part): part is string => Boolean(part));

  const where = request.whereSql?.trim();
  if (where) {
    const validation = validateSqlFragment(where, 'Partial index WHERE clause');
    if (!validation.ok) return validation;
    parts.push(`where ${stripWhereKeyword(where)}`);
    warnings.push('Partial index WHERE SQL is appended verbatim and must be reviewed before execution.');
  }
  if (request.concurrently) {
    warnings.push('CONCURRENTLY cannot run inside an explicit transaction block in PostgreSQL.');
  }

  return ok(toPreview([`${parts.join(' ')};`], warnings));
}

export function buildDropIndexPreview(request: BuildDropIndexPreviewRequest): Result<IndexPreview> {
  const target = validateTarget(request.schema, request.name, 'Index');
  if (!target.ok) return target;
  if (request.concurrently && request.cascade) {
    return err({
      code: 'VALIDATION_ERROR',
      message: 'DROP INDEX CONCURRENTLY cannot be combined with CASCADE in PostgreSQL.',
    });
  }

  const warnings = ['Dropping an index can degrade query performance and must be confirmed.'];
  if (request.concurrently) {
    warnings.push('CONCURRENTLY cannot run inside an explicit transaction block in PostgreSQL.');
  }

  const parts = [
    'drop index',
    request.concurrently ? 'concurrently' : undefined,
    request.ifExists ? 'if exists' : undefined,
    qualifiedName(request.schema, request.name),
    request.cascade ? 'cascade' : undefined,
  ].filter((part): part is string => Boolean(part));

  return ok(toPreview([`${parts.join(' ')};`], warnings));
}

function toPreview(statements: string[], warnings: string[]): IndexPreview {
  return {
    sql: statements.join('\n'),
    statements,
    riskLevel: 'dangerous',
    requiresConfirmation: true,
    warnings,
  };
}

function buildIndexColumnSql(column: IndexColumnDefinition): Result<string> {
  const parts: string[] = [];
  if ('column' in column) {
    const validation = validateIdentifier(column.column, 'Index column');
    if (!validation.ok) return validation;
    parts.push(quotePgIdentifier(column.column));
    if (column.opClass) {
      const opClass = validateIdentifier(column.opClass, 'Index operator class');
      if (!opClass.ok) return opClass;
      parts.push(column.opClass);
    }
  } else {
    const validation = validateSqlFragment(column.expression, 'Index expression');
    if (!validation.ok) return validation;
    parts.push(`(${column.expression.trim()})`);
  }
  if (column.direction) parts.push(column.direction);
  if (column.nulls) parts.push(`nulls ${column.nulls}`);
  return ok(parts.join(' '));
}

function buildDefaultIndexName(table: string, columns: IndexColumnDefinition[]): string {
  const suffix = columns
    .map((column, index) => ('column' in column ? column.column : `expr_${index + 1}`))
    .join('_')
    .replace(/[^a-zA-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `idx_${table}_${suffix || 'expr'}`;
}

function validateTarget(schema: string, name: string, label: string): Result<void> {
  const schemaValidation = validateIdentifier(schema, 'Schema');
  if (!schemaValidation.ok) return schemaValidation;
  return validateIdentifier(name, label);
}

function validateIdentifier(identifier: string, label: string): Result<void> {
  if (!identifier || identifier.trim().length === 0) {
    return err({ code: 'VALIDATION_ERROR', message: `${label} name is required.` });
  }
  if (identifier.includes('\0')) {
    return err({ code: 'VALIDATION_ERROR', message: `${label} name contains an invalid null byte.` });
  }
  if (identifier.includes(';') || identifier.includes('--') || identifier.includes('/*') || identifier.includes('*/')) {
    return err({ code: 'VALIDATION_ERROR', message: `${label} name contains unsafe SQL tokens.` });
  }
  return ok(undefined);
}

function validateSqlFragment(value: string, label: string): Result<void> {
  const trimmed = value.trim();
  if (!trimmed) return err({ code: 'VALIDATION_ERROR', message: `${label} is required.` });
  if (trimmed.includes(';') || trimmed.includes('--') || trimmed.includes('/*') || trimmed.includes('*/')) {
    return err({ code: 'VALIDATION_ERROR', message: `${label} contains unsafe SQL tokens.` });
  }
  return ok(undefined);
}

function stripWhereKeyword(whereSql: string): string {
  return whereSql.replace(/^\s*where\s+/i, '');
}

function qualifiedName(schema: string, name: string): string {
  return `${quotePgIdentifier(schema)}.${quotePgIdentifier(name)}`;
}
