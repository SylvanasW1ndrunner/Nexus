import { randomUUID } from 'node:crypto';
import type { QueryHistoryItem, QuerySafetyReport } from '@dbagent/shared';
import { readJsonFile, writeJsonFileAtomic } from './json-file.js';

export type AppendQueryHistoryInput = {
  connectionId: string;
  sql: string;
  status: QueryHistoryItem['status'];
  rowCount?: number;
  elapsedMs?: number;
  errorMessage?: string;
  safety: QuerySafetyReport;
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
    if (input.elapsedMs !== undefined) item.elapsedMs = input.elapsedMs;
    if (input.errorMessage !== undefined) item.errorMessage = input.errorMessage;
    const history = await this.list({});
    await this.save([item, ...history].slice(0, 500));
    return item;
  }

  async list(options: { connectionId?: string; limit?: number }): Promise<QueryHistoryItem[]> {
    const all = await readJsonFile<QueryHistoryItem[]>(this.filePath, []);
    const filtered = options.connectionId ? all.filter((item) => item.connectionId === options.connectionId) : all;
    return filtered.slice(0, options.limit ?? 100);
  }

  private async save(items: QueryHistoryItem[]): Promise<void> {
    await writeJsonFileAtomic(this.filePath, items);
  }
}
