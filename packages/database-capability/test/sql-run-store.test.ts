import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqlRunStore, type SqlRunSnapshot } from '../src/index.js';

const stores: SqlRunStore[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Database Capability SQL run history', () => {
  it('recovers uncertain execution and persists completed metadata without rows', () => {
    const store = remember(new SqlRunStore({ filePath: ':memory:', projectKey: 'project:a' }));
    store.put(run('executing', 'executing'));
    expect(store.recoverInterrupted('2026-09-04T00:00:00.000Z')).toBe(1);
    expect(store.get('executing')?.status).toBe('outcome_unknown');
    store.put({ ...run('completed', 'completed'), execution: queryResult() });
    expect(store.get('completed')?.execution).toMatchObject({ rows: [], returnedRowCount: 1 });
  });

  it('migrates legacy SDK rows once without overwriting Capability history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'database-capability-runs-'));
    directories.push(directory);
    const filePath = join(directory, 'state.db');
    const DatabaseSync = (createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (path: string) => { exec(sql: string): void; prepare(sql: string): { run(...values: unknown[]): unknown }; close(): void };
    }).DatabaseSync;
    const legacy = new DatabaseSync(filePath);
    legacy.exec('CREATE TABLE sdk_sql_runs (run_id TEXT PRIMARY KEY, project_key TEXT, status TEXT, created_at TEXT, updated_at TEXT, expires_at TEXT, payload_json TEXT)');
    const snapshot = run('legacy', 'awaiting_execution');
    legacy.prepare('INSERT INTO sdk_sql_runs VALUES (?, ?, ?, ?, ?, ?, ?)').run('legacy', 'project:a', 'awaiting_execution', snapshot.createdAt, snapshot.updatedAt, '2026-10-04T00:00:00.000Z', JSON.stringify(snapshot));
    legacy.close();
    const first = remember(new SqlRunStore({ filePath, projectKey: 'project:a' }));
    expect(first.get('legacy')?.status).toBe('awaiting_execution');
    first.close();
    const second = remember(new SqlRunStore({ filePath, projectKey: 'project:a' }));
    expect(second.get('legacy')?.runId).toBe('legacy');
  });
});

function remember<T extends SqlRunStore>(store: T): T { stores.push(store); return store; }
function run(runId: string, status: SqlRunSnapshot['status']): SqlRunSnapshot {
  return { runId, connectionId: 'connection-1', executionResultAvailable: false, status,
    question: 'Count orders', sql: 'select count(*) from orders', explanation: 'Count rows', assumptions: [], evidence: [],
    safety: { statementKind: 'SELECT', riskLevel: 'safe', requiresConfirmation: false, blocked: false, reasons: [] },
    createdAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-04T00:00:00.000Z' };
}
function queryResult() { return { queryId: 'query-1', columns: [{ name: 'id', dataType: 'integer' }], rows: [{ id: 1 }], rowCount: 1, returnedRowCount: 1, elapsedMs: 1, safety: { statementKind: 'SELECT', riskLevel: 'safe' as const, requiresConfirmation: false, blocked: false, reasons: [] } }; }
