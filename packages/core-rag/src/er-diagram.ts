import type { ColumnSummary, TableDetail } from '@dbagent/shared';

export type GenerateErDiagramOptions = {
  maxColumnsPerTable?: number;
  selectedTables?: Array<{ schema: string; table: string }>;
};

export type ErDiagramRelation = {
  fromTableKey: string;
  fromTable: string;
  fromColumn: string;
  toTableKey: string;
  toTable: string;
  toColumn: string;
  label: string;
};

export type ErDiagramResult = {
  mermaid: string;
  tableCount: number;
  relationCount: number;
  truncatedTables: string[];
  warnings: string[];
};

const DEFAULT_MAX_COLUMNS_PER_TABLE = 10;

export function generateMermaidErDiagram(tables: TableDetail[], options: GenerateErDiagramOptions = {}): ErDiagramResult {
  const maxColumns = normalizeMaxColumns(options.maxColumnsPerTable);
  const selected = selectedTableSet(options.selectedTables);
  const visibleTables = selected
    ? tables.filter((table) => selected.has(tableKey(table.schema, table.name)))
    : tables;
  const tableKeys = new Set(visibleTables.map((table) => tableKey(table.schema, table.name)));
  const lines = ['erDiagram'];
  const truncatedTables: string[] = [];
  const warnings: string[] = [];

  for (const table of visibleTables) {
    const displayName = mermaidEntityName(table.schema, table.name);
    lines.push(`  ${displayName} {`);
    const visibleColumns = table.columns.slice(0, maxColumns);
    for (const column of visibleColumns) {
      lines.push(`    ${mermaidType(column.dataType)} ${mermaidFieldName(column.name)} ${columnFlags(column)}`);
    }
    if (table.columns.length > maxColumns) {
      truncatedTables.push(`${table.schema}.${table.name}`);
      lines.push(`    string __more_columns__ "truncated ${table.columns.length - maxColumns} columns"`);
    }
    lines.push('  }');
  }

  const relations = extractRelations(visibleTables).filter(
    (relation) => tableKeys.has(relation.fromTableKey) && tableKeys.has(relation.toTableKey),
  );
  for (const relation of relations) {
    lines.push(`  ${relation.toTable} ||--o{ ${relation.fromTable} : "${escapeMermaidLabel(relation.label)}"`);
  }

  if (visibleTables.length > 30) {
    warnings.push('ER diagram contains more than 30 tables; consider generating a relation subgraph.');
  }
  if (truncatedTables.length > 0) {
    warnings.push(`Columns were truncated for ${truncatedTables.length} table(s).`);
  }
  if (selected && visibleTables.length < selected.size) {
    warnings.push('Some selected tables were not found in schema metadata.');
  }

  return {
    mermaid: lines.join('\n'),
    tableCount: visibleTables.length,
    relationCount: relations.length,
    truncatedTables,
    warnings,
  };
}

function extractRelations(tables: TableDetail[]): ErDiagramRelation[] {
  const relations: ErDiagramRelation[] = [];
  for (const table of tables) {
    const fromTable = mermaidEntityName(table.schema, table.name);
    for (const column of table.columns) {
      if (!column.foreignKey) continue;
      relations.push({
        fromTableKey: tableKey(table.schema, table.name),
        fromTable,
        fromColumn: column.name,
        toTableKey: tableKey(column.foreignKey.schema, column.foreignKey.table),
        toTable: mermaidEntityName(column.foreignKey.schema, column.foreignKey.table),
        toColumn: column.foreignKey.column,
        label: `${column.name} -> ${column.foreignKey.column}`,
      });
    }
  }
  return relations;
}

function columnFlags(column: ColumnSummary): string {
  const flags = [
    column.isPrimaryKey ? 'PK' : undefined,
    column.foreignKey ? 'FK' : undefined,
    column.nullable ? 'nullable' : 'not_null',
  ].filter(Boolean);
  return flags.length > 0 ? `"${flags.join(',')}"` : '';
}

function selectedTableSet(selectedTables: GenerateErDiagramOptions['selectedTables']): Set<string> | undefined {
  if (!selectedTables || selectedTables.length === 0) return undefined;
  return new Set(selectedTables.map((table) => tableKey(table.schema, table.table)));
}

function normalizeMaxColumns(maxColumns: number | undefined): number {
  if (maxColumns === undefined || !Number.isFinite(maxColumns)) return DEFAULT_MAX_COLUMNS_PER_TABLE;
  return Math.max(1, Math.min(Math.floor(maxColumns), 100));
}

function tableKey(schema: string, table: string): string {
  return `${schema}.${table}`;
}

function mermaidEntityName(schema: string, table: string): string {
  return sanitizeMermaidIdentifier(`${schema}_${table}`);
}

function mermaidFieldName(name: string): string {
  return sanitizeMermaidIdentifier(name);
}

function mermaidType(dataType: string): string {
  return sanitizeMermaidIdentifier(dataType.replace(/\(.+\)/g, ''));
}

function sanitizeMermaidIdentifier(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_]/g, '_').replace(/^([^A-Za-z_])/, '_$1');
  return sanitized || 'unnamed';
}

function escapeMermaidLabel(value: string): string {
  return value.replace(/"/g, '\\"');
}
