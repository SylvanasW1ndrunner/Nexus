import { randomUUID } from 'node:crypto';
import type { QueryHistoryItem, QueryRiskLevel, QuerySafetyReport, QueryTransactionReport } from '@dbagent/shared';
import { readJsonFile, writeJsonFileAtomic } from './json-file.js';

export type AppendQueryHistoryInput = {
  connectionId: string;
  sql: string;
  status: QueryHistoryItem['status'];
  rowCount?: number;
  returnedRowCount?: number;
  rowLimit?: number;
  hasMore?: boolean;
  truncated?: boolean;
  elapsedMs?: number;
  errorMessage?: string;
  safety: QuerySafetyReport;
  transaction?: QueryTransactionReport;
};

export type QueryHistoryListOptions = {
  connectionId?: string;
  limit?: number;
  offset?: number;
  searchText?: string;
  status?: QueryHistoryItem['status'] | QueryHistoryItem['status'][];
  riskLevel?: QueryRiskLevel | QueryRiskLevel[];
  statementKind?: string | string[];
  createdFrom?: string | Date;
  createdTo?: string | Date;
};

export type QueryHistorySearchResult = {
  items: QueryHistoryItem[];
  total: number;
  offset: number;
  limit: number;
};

export class QueryHistoryStore {
  constructor(private readonly filePath: string) {}

  async append(input: AppendQueryHistoryInput): Promise<QueryHistoryItem> {
    const item: QueryHistoryItem = {
      id: randomUUID(),
      connectionId: input.connectionId,
      sql: input.sql,
      status: input.status,
      safety: input.safety,
      createdAt: new Date().toISOString(),
    };
    if (input.rowCount !== undefined) item.rowCount = input.rowCount;
    if (input.returnedRowCount !== undefined) item.returnedRowCount = input.returnedRowCount;
    if (input.rowLimit !== undefined) item.rowLimit = input.rowLimit;
    if (input.hasMore !== undefined) item.hasMore = input.hasMore;
    if (input.truncated !== undefined) item.truncated = input.truncated;
    if (input.elapsedMs !== undefined) item.elapsedMs = input.elapsedMs;
    if (input.errorMessage !== undefined) item.errorMessage = input.errorMessage;
    if (input.transaction !== undefined) item.transaction = input.transaction;
    const history = await this.readAll();
    await this.save([item, ...history].slice(0, 500));
    return item;
  }

  async list(options: QueryHistoryListOptions = {}): Promise<QueryHistoryItem[]> {
    return (await this.search(options)).items;
  }

  async search(options: QueryHistoryListOptions = {}): Promise<QueryHistorySearchResult> {
    const all = await this.readAll();
    const filtered = filterHistoryItems(all, options);
    const offset = normalizeNonNegativeInteger(options.offset, 0);
    const limit = normalizeNonNegativeInteger(options.limit, 100);
    return {
      items: filtered.slice(offset, offset + limit),
      total: filtered.length,
      offset,
      limit,
    };
  }

  private async save(items: QueryHistoryItem[]): Promise<void> {
    await writeJsonFileAtomic(this.filePath, items);
  }

  private async readAll(): Promise<QueryHistoryItem[]> {
    return readJsonFile<QueryHistoryItem[]>(this.filePath, []);
  }
}

function filterHistoryItems(items: QueryHistoryItem[], options: QueryHistoryListOptions): QueryHistoryItem[] {
  const searchText = options.searchText?.trim().toLowerCase();
  const statuses = normalizeSet(options.status);
  const riskLevels = normalizeSet(options.riskLevel);
  const statementKinds = normalizeSet(options.statementKind, (value) => value.toUpperCase());
  const createdFrom = normalizeTimestamp(options.createdFrom);
  const createdTo = normalizeTimestamp(options.createdTo);

  return items.filter((item) => {
    if (options.connectionId && item.connectionId !== options.connectionId) return false;
    if (statuses && !statuses.has(item.status)) return false;
    if (riskLevels && !riskLevels.has(item.safety.riskLevel)) return false;
    if (statementKinds && !statementKinds.has(item.safety.statementKind.toUpperCase())) return false;
    if (createdFrom !== undefined || createdTo !== undefined) {
      const createdAt = Date.parse(item.createdAt);
      if (!Number.isFinite(createdAt)) return false;
      if (createdFrom !== undefined && createdAt < createdFrom) return false;
      if (createdTo !== undefined && createdAt > createdTo) return false;
    }
    if (!searchText) return true;
    return [item.sql, item.errorMessage ?? '', item.safety.statementKind, ...item.safety.reasons]
      .join('\n')
      .toLowerCase()
      .includes(searchText);
  });
}

function normalizeSet<T extends string>(
  value: T | T[] | undefined,
  map: (input: T) => string = (input) => input,
): Set<string> | undefined {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const normalized = values.map((item) => map(item)).filter((item) => item.length > 0);
  return normalized.length > 0 ? new Set(normalized) : undefined;
}

function normalizeTimestamp(value: string | Date | undefined): number | undefined {
  if (value === undefined) return undefined;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}
