import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { QueryHistoryItem, QuerySafetyReport } from '@dbagent/shared';

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
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const all = JSON.parse(raw) as QueryHistoryItem[];
      const filtered = options.connectionId
        ? all.filter((item) => item.connectionId === options.connectionId)
        : all;
      return filtered.slice(0, options.limit ?? 100);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private async save(items: QueryHistoryItem[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
  }
}
