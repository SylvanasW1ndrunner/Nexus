import { randomUUID } from 'node:crypto';
import type { ConnectionId, QueryExecutionResult, QuerySafetyReport } from '@dbagent/shared';
import { readJsonFile, writeJsonFileAtomic } from './json-file.js';

export type QuerySnapshotCellValue =
  | string
  | number
  | boolean
  | null
  | QuerySnapshotTypedValue
  | QuerySnapshotCellValue[]
  | { [key: string]: QuerySnapshotCellValue };

export type QuerySnapshotTypedValue =
  | { type: 'bigint'; value: string }
  | { type: 'date'; value: string }
  | { type: 'buffer'; encoding: 'base64'; value: string }
  | { type: 'number'; value: string };

export type QuerySnapshotRow = Record<string, QuerySnapshotCellValue>;

export type QuerySnapshot = {
  id: string;
  connectionId: ConnectionId;
  queryId: string;
  title: string;
  sql: string;
  columns: QueryExecutionResult['columns'];
  rows: QuerySnapshotRow[];
  rowCount: number;
  returnedRowCount?: number;
  rowLimit?: number;
  hasMore?: boolean;
  truncated?: boolean;
  elapsedMs: number;
  safety: QuerySafetyReport;
  tags: string[];
  note?: string;
  sourceHistoryId?: string;
  createdAt: string;
  updatedAt: string;
};

export type QuerySnapshotSummary = Omit<QuerySnapshot, 'rows'> & {
  previewRows: QuerySnapshotRow[];
};

export type CreateQuerySnapshotInput = {
  connectionId: ConnectionId;
  sql: string;
  result: QueryExecutionResult;
  title?: string;
  tags?: string[];
  note?: string;
  sourceHistoryId?: string;
};

export type ListQuerySnapshotsOptions = {
  connectionId?: ConnectionId;
  searchText?: string;
  limit?: number;
  offset?: number;
  previewRowLimit?: number;
};

export class QuerySnapshotStore {
  constructor(
    private readonly filePath: string,
    private readonly maxSnapshots = 200,
  ) {}

  async create(input: CreateQuerySnapshotInput): Promise<QuerySnapshot> {
    const now = new Date().toISOString();
    const snapshot: QuerySnapshot = {
      id: randomUUID(),
      connectionId: input.connectionId,
      queryId: input.result.queryId,
      title: buildSnapshotTitle(input),
      sql: input.sql,
      columns: input.result.columns,
      rows: input.result.rows.map(normalizeRow),
      rowCount: input.result.rowCount,
      ...(input.result.returnedRowCount === undefined ? {} : { returnedRowCount: input.result.returnedRowCount }),
      ...(input.result.rowLimit === undefined ? {} : { rowLimit: input.result.rowLimit }),
      ...(input.result.hasMore === undefined ? {} : { hasMore: input.result.hasMore }),
      ...(input.result.truncated === undefined ? {} : { truncated: input.result.truncated }),
      elapsedMs: input.result.elapsedMs,
      safety: input.result.safety,
      tags: normalizeTags(input.tags),
      createdAt: now,
      updatedAt: now,
    };
    if (input.note !== undefined) snapshot.note = input.note;
    if (input.sourceHistoryId !== undefined) snapshot.sourceHistoryId = input.sourceHistoryId;

    const snapshots = await this.readAll();
    await this.save([snapshot, ...snapshots.filter((item) => item.id !== snapshot.id)].slice(0, this.maxSnapshots));
    return snapshot;
  }

  async list(options: ListQuerySnapshotsOptions = {}): Promise<QuerySnapshotSummary[]> {
    const previewRowLimit = Math.max(0, options.previewRowLimit ?? 5);
    const offset = Math.max(0, options.offset ?? 0);
    const limit = Math.max(0, options.limit ?? 100);
    const searchText = options.searchText?.trim().toLowerCase();
    const filtered = (await this.readAll()).filter((snapshot) => {
      if (options.connectionId && snapshot.connectionId !== options.connectionId) return false;
      if (!searchText) return true;
      const haystack = [snapshot.title, snapshot.sql, snapshot.note ?? '', snapshot.tags.join(' ')]
        .join('\n')
        .toLowerCase();
      return haystack.includes(searchText);
    });

    return filtered.slice(offset, offset + limit).map((snapshot) => toSummary(snapshot, previewRowLimit));
  }

  async get(id: string): Promise<QuerySnapshot | undefined> {
    return (await this.readAll()).find((snapshot) => snapshot.id === id);
  }

  async remove(id: string): Promise<boolean> {
    const snapshots = await this.readAll();
    const next = snapshots.filter((snapshot) => snapshot.id !== id);
    if (next.length === snapshots.length) return false;
    await this.save(next);
    return true;
  }

  private async readAll(): Promise<QuerySnapshot[]> {
    return readJsonFile<QuerySnapshot[]>(this.filePath, []);
  }

  private async save(snapshots: QuerySnapshot[]): Promise<void> {
    await writeJsonFileAtomic(this.filePath, snapshots);
  }
}

function buildSnapshotTitle(input: CreateQuerySnapshotInput): string {
  const explicit = input.title?.trim();
  if (explicit) return explicit.slice(0, 120);
  const firstLine = input.sql
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return (firstLine ?? '未命名查询快照').slice(0, 120);
}

function normalizeTags(tags: string[] | undefined): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const tag of tags ?? []) {
    const value = tag.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

function normalizeRow(row: QueryExecutionResult['rows'][number]): QuerySnapshotRow {
  const normalized: QuerySnapshotRow = {};
  for (const [key, value] of Object.entries(row)) {
    normalized[key] = normalizeValue(value);
  }
  return normalized;
}

function normalizeValue(value: unknown): QuerySnapshotCellValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    return { type: 'number', value: String(value) };
  }
  if (typeof value === 'bigint') return { type: 'bigint', value: value.toString() };
  if (value instanceof Date) return { type: 'date', value: value.toISOString() };
  if (Buffer.isBuffer(value)) return { type: 'buffer', encoding: 'base64', value: value.toString('base64') };
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (typeof value === 'object' && value !== null) {
    const normalized: { [key: string]: QuerySnapshotCellValue } = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (nested !== undefined) normalized[key] = normalizeValue(nested);
    }
    return normalized;
  }
  return null;
}

function toSummary(snapshot: QuerySnapshot, previewRowLimit: number): QuerySnapshotSummary {
  const { rows, ...rest } = snapshot;
  return {
    ...rest,
    previewRows: rows.slice(0, previewRowLimit),
  };
}
