export function quotePgIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

export function buildTablePreviewSql(schema: string, table: string, limit = 100): string {
  const safeLimit = Math.max(1, Math.min(Math.floor(limit), 1000));
  return `select * from ${quotePgIdentifier(schema)}.${quotePgIdentifier(table)} limit ${safeLimit};`;
}

export type TableDataFilterOperator =
  | '='
  | '!='
  | '>'
  | '>='
  | '<'
  | '<='
  | 'like'
  | 'not_like'
  | 'in'
  | 'not_in'
  | 'between'
  | 'is_null'
  | 'is_not_null';

export type TableDataFilter = {
  column: string;
  operator: TableDataFilterOperator;
  value?: unknown;
  values?: unknown[];
};

export type TableDataSort = {
  column: string;
  direction: 'asc' | 'desc';
};

export type BuildTableDataQueryRequest = {
  schema: string;
  table: string;
  visibleColumns?: string[];
  filters?: TableDataFilter[];
  advancedWhereSql?: string;
  sorts?: TableDataSort[];
  limit?: number;
  offset?: number;
};

export type BuildTableDataQueryResult = {
  sql: string;
  params: unknown[];
  page: {
    limit: number;
    offset: number;
  };
  warnings: string[];
};

const DEFAULT_TABLE_PAGE_LIMIT = 100;
const MAX_TABLE_PAGE_LIMIT = 1000;
const MAX_TABLE_PAGE_OFFSET = 1_000_000;

export function buildTableDataQuery(request: BuildTableDataQueryRequest): BuildTableDataQueryResult {
  const params: unknown[] = [];
  const warnings: string[] = [];
  const columns = normalizeVisibleColumns(request.visibleColumns);
  const limit = normalizeLimit(request.limit, warnings);
  const offset = normalizeOffset(request.offset, warnings);
  const selectList = columns.length > 0 ? columns.map(quotePgIdentifier).join(', ') : '*';
  const whereParts = buildWhereParts(request.filters ?? [], request.advancedWhereSql, params, warnings);
  const orderBy = buildOrderBy(request.sorts ?? []);

  const sqlParts = [
    `select ${selectList}`,
    `from ${quotePgIdentifier(request.schema)}.${quotePgIdentifier(request.table)}`,
  ];
  if (whereParts.length > 0) sqlParts.push(`where ${whereParts.join(' and ')}`);
  if (orderBy) sqlParts.push(orderBy);
  sqlParts.push(`limit ${limit}`);
  if (offset > 0) sqlParts.push(`offset ${offset}`);

  return {
    sql: `${sqlParts.join('\n')};`,
    params,
    page: { limit, offset },
    warnings,
  };
}

function normalizeVisibleColumns(columns: string[] | undefined): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const column of columns ?? []) {
    const value = column.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

function normalizeLimit(limit: number | undefined, warnings: string[]): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_TABLE_PAGE_LIMIT;
  const floored = Math.floor(limit);
  if (floored < 1) {
    warnings.push('Page size was below 1 and has been clamped to 1.');
    return 1;
  }
  if (floored > MAX_TABLE_PAGE_LIMIT) {
    warnings.push(`Page size exceeded ${MAX_TABLE_PAGE_LIMIT} and has been clamped.`);
    return MAX_TABLE_PAGE_LIMIT;
  }
  return floored;
}

function normalizeOffset(offset: number | undefined, warnings: string[]): number {
  if (offset === undefined || !Number.isFinite(offset)) return 0;
  const floored = Math.floor(offset);
  if (floored < 0) {
    warnings.push('Page offset was below 0 and has been clamped to 0.');
    return 0;
  }
  if (floored > MAX_TABLE_PAGE_OFFSET) {
    warnings.push(`Page offset exceeded ${MAX_TABLE_PAGE_OFFSET} and has been clamped.`);
    return MAX_TABLE_PAGE_OFFSET;
  }
  return floored;
}

function buildWhereParts(
  filters: TableDataFilter[],
  advancedWhereSql: string | undefined,
  params: unknown[],
  warnings: string[],
): string[] {
  const parts = filters.map((filter) => buildFilterSql(filter, params)).filter((part): part is string => Boolean(part));
  const advanced = advancedWhereSql?.trim();
  if (advanced) {
    warnings.push('Advanced WHERE SQL is appended verbatim and must be reviewed before execution.');
    parts.push(`(${stripWhereKeyword(advanced)})`);
  }
  return parts;
}

function buildFilterSql(filter: TableDataFilter, params: unknown[]): string | undefined {
  const column = filter.column.trim();
  if (!column) return undefined;
  const quotedColumn = quotePgIdentifier(column);
  switch (filter.operator) {
    case '=':
    case '!=':
    case '>':
    case '>=':
    case '<':
    case '<=':
      return `${quotedColumn} ${filter.operator} ${pushParam(params, filter.value)}`;
    case 'like':
      return `${quotedColumn} like ${pushParam(params, filter.value)}`;
    case 'not_like':
      return `${quotedColumn} not like ${pushParam(params, filter.value)}`;
    case 'in':
      return `${quotedColumn} = any(${pushParam(params, normalizeArrayValue(filter))})`;
    case 'not_in':
      return `not (${quotedColumn} = any(${pushParam(params, normalizeArrayValue(filter))}))`;
    case 'between': {
      const values = normalizeArrayValue(filter);
      return `${quotedColumn} between ${pushParam(params, values[0] ?? null)} and ${pushParam(params, values[1] ?? null)}`;
    }
    case 'is_null':
      return `${quotedColumn} is null`;
    case 'is_not_null':
      return `${quotedColumn} is not null`;
  }
}

function normalizeArrayValue(filter: TableDataFilter): unknown[] {
  if (Array.isArray(filter.values)) return filter.values;
  if (Array.isArray(filter.value)) return filter.value;
  if (filter.value === undefined) return [];
  return [filter.value];
}

function pushParam(params: unknown[], value: unknown): string {
  params.push(value);
  return `$${params.length}`;
}

function buildOrderBy(sorts: TableDataSort[]): string | undefined {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const sort of sorts) {
    const column = sort.column.trim();
    if (!column || seen.has(column)) continue;
    seen.add(column);
    parts.push(`${quotePgIdentifier(column)} ${sort.direction}`);
  }
  return parts.length > 0 ? `order by ${parts.join(', ')}` : undefined;
}

function stripWhereKeyword(whereSql: string): string {
  return whereSql.replace(/^\s*where\s+/i, '');
}
