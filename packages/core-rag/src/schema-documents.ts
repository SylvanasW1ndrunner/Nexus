import type { ColumnSummary, TableDetail } from '@dbagent/shared';
import type { SchemaRagDocument } from './types.js';

export function buildSchemaDocuments(input: {
  connectionId: string;
  tables: TableDetail[];
}): SchemaRagDocument[] {
  const documents: SchemaRagDocument[] = [];
  const relationPairs: Array<[string, string]> = [];

  for (const table of input.tables) {
    const tableId = tableDocumentId(table.schema, table.name);
    const columnIds = [...table.columns]
      .sort(columnExpansionOrder)
      .map((column) => columnDocumentId(table.schema, table.name, column.name));
    const relationIds = [...columnIds];

    documents.push({
      id: tableId,
      connectionId: input.connectionId,
      kind: 'table',
      schema: table.schema,
      table: table.name,
      title: `${table.schema}.${table.name}`,
      text: tableText(table),
      tokens: tableTokens(table),
      relationIds,
      metadata: {
        type: table.type,
        primaryKey: table.primaryKey,
        columnCount: table.columns.length,
        rowEstimate: table.rowEstimate,
        viewDefinition: table.viewDefinition,
        indexes: table.indexes,
        constraints: table.constraints,
      },
    });

    for (const column of table.columns) {
      const columnId = columnDocumentId(table.schema, table.name, column.name);
      const foreignRelationId = column.foreignKey
        ? tableDocumentId(column.foreignKey.schema, column.foreignKey.table)
        : undefined;

      if (foreignRelationId) {
        relationPairs.push([columnId, foreignRelationId]);
        relationPairs.push([tableId, foreignRelationId]);
      }

      documents.push({
        id: columnId,
        connectionId: input.connectionId,
        kind: 'column',
        schema: table.schema,
        table: table.name,
        column: column.name,
        title: `${table.schema}.${table.name}.${column.name}`,
        text: columnText(table, column),
        tokens: columnTokens(table, column),
        relationIds: [tableId, ...(foreignRelationId ? [foreignRelationId] : [])],
        metadata: {
          dataType: column.dataType,
          nullable: column.nullable,
          isPrimaryKey: column.isPrimaryKey,
          isIndexed: column.isIndexed,
          isUnique: column.isUnique,
          foreignKey: column.foreignKey,
        },
      });
    }
  }

  for (const [from, to] of relationPairs) {
    const fromDocument = documents.find((document) => document.id === from);
    const toDocument = documents.find((document) => document.id === to);
    if (!fromDocument || !toDocument) continue;
    fromDocument.relationIds = unique([...fromDocument.relationIds, to]);
    toDocument.relationIds = unique([...toDocument.relationIds, from]);
  }

  return documents;
}

export function tableDocumentId(schema: string, table: string): string {
  return `table:${schema}.${table}`;
}

export function columnDocumentId(schema: string, table: string, column: string): string {
  return `column:${schema}.${table}.${column}`;
}

export function tokenize(values: Array<string | undefined>): string[] {
  const text = values.filter(Boolean).join(' ').toLowerCase();
  const asciiTokens = text.match(/[a-z0-9_]+/g) ?? [];
  const cjkTokens = text.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  return unique([
    ...asciiTokens,
    ...asciiTokens.flatMap(splitIdentifier),
    ...cjkTokens,
    ...cjkTokens.flatMap(cjkBigrams),
  ]);
}

function tableTokens(table: TableDetail): string[] {
  return tokenize([
    table.schema,
    table.name,
    table.comment,
    table.viewDefinition,
    ...(table.indexes ?? []).flatMap((index) => [
      index.name,
      index.method,
      index.definition,
      ...index.columns,
    ]),
    ...(table.constraints ?? []).flatMap((constraint) => [
      constraint.name,
      constraint.type,
      constraint.definition,
      ...constraint.columns,
    ]),
    ...table.columns.map((column) => column.name),
  ]);
}

function columnTokens(table: TableDetail, column: ColumnSummary): string[] {
  return tokenize([
    table.schema,
    table.name,
    table.comment,
    column.name,
    column.comment,
    column.dataType,
    column.isIndexed ? 'indexed index' : undefined,
    column.isUnique ? 'unique' : undefined,
    column.foreignKey?.table,
    column.foreignKey?.column,
  ]);
}

function tableText(table: TableDetail): string {
  const columns = table.columns.map((column) => column.name).join(', ');
  return [
    `表: ${table.schema}.${table.name}`,
    `类型: ${table.type}`,
    table.comment ? `注释: ${table.comment}` : undefined,
    typeof table.rowEstimate === 'number' ? `估算行数: ${table.rowEstimate}` : undefined,
    table.primaryKey.length ? `主键: ${table.primaryKey.join(', ')}` : undefined,
    `字段: ${columns}`,
    table.indexes?.length
      ? `索引: ${table.indexes.map((index) => indexText(index)).join('; ')}`
      : undefined,
    table.constraints?.length
      ? `约束: ${table.constraints.map((constraint) => constraintText(constraint)).join('; ')}`
      : undefined,
    table.viewDefinition ? `视图定义: ${clipLine(table.viewDefinition, 500)}` : undefined,
  ]
    .filter(Boolean)
    .join('\n');
}

function columnText(table: TableDetail, column: ColumnSummary): string {
  return [
    `字段: ${table.schema}.${table.name}.${column.name}`,
    `类型: ${column.dataType}`,
    `可空: ${column.nullable ? '是' : '否'}`,
    column.isPrimaryKey ? '主键: 是' : undefined,
    column.isUnique ? '唯一: 是' : undefined,
    column.isIndexed ? '索引: 是' : undefined,
    column.comment ? `注释: ${column.comment}` : undefined,
    column.foreignKey
      ? `外键: ${column.foreignKey.schema}.${column.foreignKey.table}.${column.foreignKey.column}`
      : undefined,
  ]
    .filter(Boolean)
    .join('\n');
}

function indexText(index: NonNullable<TableDetail['indexes']>[number]): string {
  const columns = index.columns.length ? `(${index.columns.join(', ')})` : '';
  const markers = [
    index.unique ? 'unique' : undefined,
    index.primary ? 'primary' : undefined,
    index.valid ? undefined : 'invalid',
  ]
    .filter(Boolean)
    .join(',');
  return `${index.name}${columns} ${index.method}${markers ? ` [${markers}]` : ''}`.trim();
}

function constraintText(constraint: NonNullable<TableDetail['constraints']>[number]): string {
  const columns = constraint.columns.length ? `(${constraint.columns.join(', ')})` : '';
  return `${constraint.name}:${constraint.type}${columns} ${constraint.definition}`.trim();
}

function clipLine(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 15))}...[truncated]`;
}

function splitIdentifier(token: string): string[] {
  return token.split(/[_\-.]+/g).filter((part) => part.length > 1);
}

function cjkBigrams(token: string): string[] {
  const grams: string[] = [];
  for (let index = 0; index < token.length - 1; index += 1) {
    grams.push(token.slice(index, index + 2));
  }
  return grams;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function columnExpansionOrder(left: ColumnSummary, right: ColumnSummary): number {
  const leftRank = columnExpansionRank(left);
  const rightRank = columnExpansionRank(right);
  return leftRank - rightRank || left.ordinal - right.ordinal;
}

function columnExpansionRank(column: ColumnSummary): number {
  if (column.foreignKey) return 0;
  if (!column.isPrimaryKey) return 1;
  return 2;
}
