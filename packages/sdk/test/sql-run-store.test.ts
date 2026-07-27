import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqlRunStore, type SqlRunSnapshot } from '../src/index.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('SqlRunStore', () => {
  it('restores reviewed runs, isolates Projects, and recovers uncertain execution', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'schemanaut-sql-runs-'));
    directories.push(directory);
    const filePath = join(directory, 'state.db');
    const storeA = new SqlRunStore({
      filePath,
      projectKey: 'project:a',
      now: () => '2026-07-27T00:00:00.000Z',
    });
    storeA.put(run('reviewed', 'awaiting_execution'));
    storeA.put(run('executing', 'executing'));
    storeA.close();

    const restoredA = new SqlRunStore({
      filePath,
      projectKey: 'project:a',
      now: () => '2026-07-27T00:01:00.000Z',
    });
    expect(restoredA.get('reviewed')?.status).toBe('awaiting_execution');
    expect(restoredA.get('executing')?.status).toBe('outcome_unknown');

    const storeB = new SqlRunStore({
      filePath,
      projectKey: 'project:b',
      now: () => '2026-07-27T00:01:00.000Z',
    });
    expect(storeB.get('reviewed')).toBeUndefined();
    expect(() => storeB.put(run('reviewed', 'awaiting_execution'))).toThrow(
      'another Project',
    );
    storeB.close();
    restoredA.close();
  });

  it('bounds record count and persists completed results without row values', () => {
    const store = new SqlRunStore({
      filePath: ':memory:',
      projectKey: 'project:a',
      maxRecords: 2,
      now: () => '2026-07-27T00:00:00.000Z',
    });
    store.put(run('one', 'awaiting_execution', '2026-07-27T00:00:00.000Z'));
    store.put(run('two', 'awaiting_execution', '2026-07-27T00:00:01.000Z'));
    store.put({
      ...run('three', 'completed', '2026-07-27T00:00:02.000Z'),
      execution: {
        queryId: 'query-3',
        columns: [{ name: 'phone', dataType: 'text' }],
        rows: [{ phone: '13800138000' }],
        rowCount: 1,
        returnedRowCount: 1,
        elapsedMs: 4,
        safety: {
          statementKind: 'SELECT',
          riskLevel: 'safe',
          requiresConfirmation: false,
          blocked: false,
          reasons: [],
        },
      },
    });

    expect(store.count()).toBe(2);
    expect(store.get('one')).toBeUndefined();
    expect(store.get('three')?.execution?.rows).toEqual([]);
    expect(store.get('three')?.execution?.returnedRowCount).toBe(1);
    store.close();
  });
});

function run(
  runId: string,
  status: SqlRunSnapshot['status'],
  updatedAt = '2026-07-27T00:00:00.000Z',
): SqlRunSnapshot {
  return {
    runId,
    connectionId: 'connection-1',
    executionResultAvailable: false,
    status,
    question: 'Count orders',
    sql: 'select count(*) from orders',
    explanation: 'Count rows',
    assumptions: [],
    evidence: [],
    safety: {
      statementKind: 'SELECT',
      riskLevel: 'safe',
      requiresConfirmation: false,
      blocked: false,
      reasons: [],
    },
    createdAt: updatedAt,
    updatedAt,
  };
}
