import type { QueryRiskLevel, Result } from '@dbagent/shared';
import { err, ok } from '@dbagent/shared';
import { quotePgIdentifier } from './sql-builder.js';

export type TableColumnDefinition = {
  name: string;
  dataType: string;
  nullable?: boolean;
  defaultValue?: string;
  primaryKey?: boolean;
  unique?: boolean;
  identity?: boolean;
  checkExpression?: string;
  comment?: string;
};

export type TableIndexDefinition = {
  name?: string;
  columns: string[];
  method?: 'btree' | 'hash' | 'gin' | 'gist' | 'brin';
  unique?: boolean;
};

export type TableForeignKeyDefinition = {
  name?: string;
  columns: string[];
  references: {
    schema?: string;
    table: string;
    columns: string[];
  };
  onDelete?: 'no action' | 'restrict' | 'cascade' | 'set null' | 'set default';
  onUpdate?: 'no action' | 'restrict' | 'cascade' | 'set null' | 'set default';
};

export type BuildCreateTablePreviewRequest = {
  schema: string;
  table: string;
  columns: TableColumnDefinition[];
  indexes?: TableIndexDefinition[];
  foreignKeys?: TableForeignKeyDefinition[];
  comment?: string;
};

export type BuildAlterTablePreviewRequest = {
  schema: string;
  table: string;
  addColumns?: TableColumnDefinition[];
  addIndexes?: TableIndexDefinition[];
  addForeignKeys?: TableForeignKeyDefinition[];
  tableComment?: string;
};

export type TableDesignerPreview = {
  sql: string;
  statements: string[];
  riskLevel: QueryRiskLevel;
  requiresConfirmation: boolean;
  warnings: string[];
};

export function buildCreateTablePreview(request: BuildCreateTablePreviewRequest): Result<TableDesignerPreview> {
  const target = validateTarget(request.schema, request.table);
  if (!target.ok) return target;
  if (request.columns.length === 0) {
    return err({ code: 'VALIDATION_ERROR', message: 'Create table requires at least one column.' });
  }

  const columnLines: string[] = [];
  const primaryKeyColumns: string[] = [];
  const statements: string[] = [];
  const warnings = new Set<string>();

  for (const column of request.columns) {
    const validation = validateColumn(column);
    if (!validation.ok) return validation;
    columnLines.push(`  ${buildColumnSql(column)}`);
    if (column.primaryKey) primaryKeyColumns.push(column.name);
  }

  if (primaryKeyColumns.length > 0) {
    columnLines.push(`  primary key (${primaryKeyColumns.map(quotePgIdentifier).join(', ')})`);
  } else {
    warnings.add('Table has no primary key. Editing rows safely will be limited.');
  }

  statements.push(`create table ${qualifiedTable(request.schema, request.table)} (\n${columnLines.join(',\n')}\n);`);
  appendTableAndColumnComments(statements, request.schema, request.table, request.comment, request.columns);

  for (const index of request.indexes ?? []) {
    const built = buildIndexSql(request.schema, request.table, index);
    if (!built.ok) return built;
    statements.push(built.data);
  }

  for (const foreignKey of request.foreignKeys ?? []) {
    const built = buildForeignKeySql(request.schema, request.table, foreignKey);
    if (!built.ok) return built;
    statements.push(built.data);
  }

  return ok(toPreview(statements, [...warnings]));
}

export function buildAlterTablePreview(request: BuildAlterTablePreviewRequest): Result<TableDesignerPreview> {
  const target = validateTarget(request.schema, request.table);
  if (!target.ok) return target;

  const statements: string[] = [];
  for (const column of request.addColumns ?? []) {
    const validation = validateColumn(column);
    if (!validation.ok) return validation;
    statements.push(`alter table ${qualifiedTable(request.schema, request.table)} add column ${buildColumnSql(column)};`);
    if (column.comment !== undefined) {
      statements.push(buildColumnCommentSql(request.schema, request.table, column.name, column.comment));
    }
  }

  for (const index of request.addIndexes ?? []) {
    const built = buildIndexSql(request.schema, request.table, index);
    if (!built.ok) return built;
    statements.push(built.data);
  }

  for (const foreignKey of request.addForeignKeys ?? []) {
    const built = buildForeignKeySql(request.schema, request.table, foreignKey);
    if (!built.ok) return built;
    statements.push(built.data);
  }

  if (request.tableComment !== undefined) {
    statements.push(buildTableCommentSql(request.schema, request.table, request.tableComment));
  }

  if (statements.length === 0) {
    return err({ code: 'VALIDATION_ERROR', message: 'Alter table preview requires at least one change.' });
  }

  return ok(toPreview(statements, []));
}

function toPreview(statements: string[], warnings: string[]): TableDesignerPreview {
  return {
    sql: statements.join('\n'),
    statements,
    riskLevel: 'dangerous',
    requiresConfirmation: true,
    warnings,
  };
}

function buildColumnSql(column: TableColumnDefinition): string {
  const parts = [quotePgIdentifier(column.name), normalizeDataType(column.dataType)];
  if (column.identity) parts.push('generated by default as identity');
  if (column.nullable === false || column.primaryKey) parts.push('not null');
  if (column.defaultValue !== undefined && column.defaultValue.trim()) parts.push(`default ${column.defaultValue.trim()}`);
  if (column.unique) parts.push('unique');
  if (column.checkExpression !== undefined && column.checkExpression.trim()) parts.push(`check (${column.checkExpression.trim()})`);
  return parts.join(' ');
}

function buildIndexSql(schema: string, table: string, index: TableIndexDefinition): Result<string> {
  if (index.columns.length === 0) {
    return err({ code: 'VALIDATION_ERROR', message: 'Index requires at least one column.' });
  }
  for (const column of index.columns) {
    const validation = validateIdentifier(column, 'Index column');
    if (!validation.ok) return validation;
  }
  const method = index.method ?? 'btree';
  const name = index.name?.trim() || `idx_${table}_${index.columns.join('_')}`;
  const nameValidation = validateIdentifier(name, 'Index name');
  if (!nameValidation.ok) return nameValidation;
  const unique = index.unique ? 'unique ' : '';
  return ok(
    `create ${unique}index ${quotePgIdentifier(name)} on ${qualifiedTable(schema, table)} using ${method} (${index.columns
      .map(quotePgIdentifier)
      .join(', ')});`,
  );
}

function buildForeignKeySql(schema: string, table: string, foreignKey: TableForeignKeyDefinition): Result<string> {
  if (foreignKey.columns.length === 0 || foreignKey.references.columns.length === 0) {
    return err({ code: 'VALIDATION_ERROR', message: 'Foreign key requires local and referenced columns.' });
  }
  if (foreignKey.columns.length !== foreignKey.references.columns.length) {
    return err({ code: 'VALIDATION_ERROR', message: 'Foreign key local and referenced column counts must match.' });
  }
  const referencedSchema = foreignKey.references.schema ?? schema;
  const identifiers = [
    ...foreignKey.columns.map((column) => [column, 'Foreign key column'] as const),
    ...foreignKey.references.columns.map((column) => [column, 'Referenced column'] as const),
    [foreignKey.references.table, 'Referenced table'] as const,
    [referencedSchema, 'Referenced schema'] as const,
  ];
  for (const [identifier, label] of identifiers) {
    const validation = validateIdentifier(identifier, label);
    if (!validation.ok) return validation;
  }
  const name = foreignKey.name?.trim() || `fk_${table}_${foreignKey.columns.join('_')}`;
  const nameValidation = validateIdentifier(name, 'Foreign key name');
  if (!nameValidation.ok) return nameValidation;

  const parts = [
    `alter table ${qualifiedTable(schema, table)} add constraint ${quotePgIdentifier(name)}`,
    `foreign key (${foreignKey.columns.map(quotePgIdentifier).join(', ')})`,
    `references ${qualifiedTable(referencedSchema, foreignKey.references.table)} (${foreignKey.references.columns
      .map(quotePgIdentifier)
      .join(', ')})`,
  ];
  if (foreignKey.onDelete) parts.push(`on delete ${foreignKey.onDelete}`);
  if (foreignKey.onUpdate) parts.push(`on update ${foreignKey.onUpdate}`);
  return ok(`${parts.join(' ')};`);
}

function appendTableAndColumnComments(
  statements: string[],
  schema: string,
  table: string,
  tableComment: string | undefined,
  columns: TableColumnDefinition[],
): void {
  if (tableComment !== undefined) statements.push(buildTableCommentSql(schema, table, tableComment));
  for (const column of columns) {
    if (column.comment !== undefined) statements.push(buildColumnCommentSql(schema, table, column.name, column.comment));
  }
}

function buildTableCommentSql(schema: string, table: string, comment: string): string {
  return `comment on table ${qualifiedTable(schema, table)} is ${toSqlString(comment)};`;
}

function buildColumnCommentSql(schema: string, table: string, column: string, comment: string): string {
  return `comment on column ${qualifiedTable(schema, table)}.${quotePgIdentifier(column)} is ${toSqlString(comment)};`;
}

function qualifiedTable(schema: string, table: string): string {
  return `${quotePgIdentifier(schema)}.${quotePgIdentifier(table)}`;
}

function normalizeDataType(dataType: string): string {
  return dataType.trim().replace(/\s+/g, ' ');
}

function validateColumn(column: TableColumnDefinition): Result<void> {
  const name = validateIdentifier(column.name, 'Column');
  if (!name.ok) return name;
  if (!column.dataType.trim()) return err({ code: 'VALIDATION_ERROR', message: 'Column data type is required.' });
  if (column.dataType.includes(';') || column.dataType.includes('--')) {
    return err({ code: 'VALIDATION_ERROR', message: 'Column data type contains unsafe SQL tokens.' });
  }
  return ok(undefined);
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

function toSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
