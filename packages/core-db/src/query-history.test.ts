import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QuerySafetyReport } from '@dbagent/shared';
import { QueryHistoryStore } from './query-history.js';

const tempDirs: string[] = [];
const safeSelect: QuerySafetyReport = {
  statementKind: 'SELECT',
  riskLevel: 'safe',
  requiresConfirmation: false,
  blocked: false,
  reasons: [],
};

async function historyPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-history-'));
  tempDirs.push(dir);
  return join(dir, 'nested', 'query-history.json');
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('QueryHistoryStore', () => {
  it('stores successful query history newest-first', async () => {
    const store = new QueryHistoryStore(await historyPath());

    await store.append({
      connectionId: 'c1',
      sql: 'select 1',
      status: 'success',
      rowCount: 1,
      elapsedMs: 12,
      safety: safeSelect,
    });
    await store.append({
      connectionId: 'c1',
      sql: 'select 2',
      status: 'success',
      rowCount: 1,
      elapsedMs: 9,
      safety: safeSelect,
    });

    const history = await store.list({ connectionId: 'c1' });
    expect(history.map((item) => item.sql)).toEqual(['select 2', 'select 1']);
  });

  it('keeps blocked query context for audit and recovery', async () => {
    const store = new QueryHistoryStore(await historyPath());
    const blocked: QuerySafetyReport = {
      statementKind: 'DELETE',
      riskLevel: 'blocked',
      requiresConfirmation: false,
      blocked: true,
      reasons: ['Connection is read-only.'],
    };

    const item = await store.append({
      connectionId: 'c1',
      sql: 'delete from users',
      status: 'blocked',
      errorMessage: 'Connection is read-only.',
      safety: blocked,
    });

    expect(item).toMatchObject({
      status: 'blocked',
      errorMessage: 'Connection is read-only.',
      safety: blocked,
    });
  });
});
