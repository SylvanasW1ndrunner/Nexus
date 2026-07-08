import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QuerySafetyReport } from '@dbagent/shared';
import { QueryHistoryStore } from '../src/query-history.js';

const tempDirs: string[] = [];
const safeSelect: QuerySafetyReport = {
  statementKind: 'SELECT',
  riskLevel: 'safe',
  requiresConfirmation: false,
  blocked: false,
  reasons: [],
};

const dangerousDelete: QuerySafetyReport = {
  statementKind: 'DELETE',
  riskLevel: 'dangerous',
  requiresConfirmation: true,
  blocked: false,
  reasons: ['Write operation requires confirmation.'],
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

  it('stores transaction metadata so rollback previews are auditable', async () => {
    const store = new QueryHistoryStore(await historyPath());

    const item = await store.append({
      connectionId: 'c1',
      sql: 'update orders set status = paid',
      status: 'success',
      rowCount: 2,
      elapsedMs: 18,
      safety: dangerousDelete,
      transaction: {
        mode: 'rollback',
        started: true,
        committed: false,
        rolledBack: true,
        rollbackOnly: true,
      },
    });

    expect(item.transaction).toEqual({
      mode: 'rollback',
      started: true,
      committed: false,
      rolledBack: true,
      rollbackOnly: true,
    });
    await expect(store.list({ connectionId: 'c1' })).resolves.toMatchObject([
      { transaction: { mode: 'rollback', rolledBack: true } },
    ]);
  });

  it('searches history by SQL text, error text and safety reason for user recovery', async () => {
    const store = new QueryHistoryStore(await historyPath());
    await store.append({
      connectionId: 'analytics',
      sql: 'select * from orders where buyer_id = 42',
      status: 'success',
      rowCount: 15,
      elapsedMs: 32,
      safety: safeSelect,
    });
    await store.append({
      connectionId: 'analytics',
      sql: 'delete from orders where buyer_id = 42',
      status: 'failed',
      errorMessage: 'permission denied for table orders',
      safety: dangerousDelete,
    });

    await expect(store.list({ searchText: 'buyer_id = 42' })).resolves.toHaveLength(2);
    await expect(store.list({ searchText: 'permission denied' })).resolves.toMatchObject([
      { status: 'failed', sql: 'delete from orders where buyer_id = 42' },
    ]);
    await expect(store.list({ searchText: 'confirmation' })).resolves.toMatchObject([
      { safety: { riskLevel: 'dangerous' } },
    ]);
  });

  it('filters by connection, status, risk level and statement kind', async () => {
    const store = new QueryHistoryStore(await historyPath());
    await store.append({
      connectionId: 'prod',
      sql: 'delete from users where id = 1',
      status: 'blocked',
      errorMessage: 'Read-only connection blocked this statement.',
      safety: { ...dangerousDelete, riskLevel: 'blocked', blocked: true },
    });
    await store.append({
      connectionId: 'prod',
      sql: 'select count(*) from users',
      status: 'success',
      rowCount: 1,
      elapsedMs: 8,
      safety: safeSelect,
    });
    await store.append({
      connectionId: 'dev',
      sql: 'select * from users limit 10',
      status: 'success',
      rowCount: 10,
      elapsedMs: 5,
      safety: safeSelect,
    });

    const history = await store.list({
      connectionId: 'prod',
      status: ['blocked', 'failed'],
      riskLevel: 'blocked',
      statementKind: 'delete',
    });

    expect(history).toMatchObject([{ connectionId: 'prod', sql: 'delete from users where id = 1', status: 'blocked' }]);
  });

  it('returns paged search metadata for a history panel', async () => {
    const store = new QueryHistoryStore(await historyPath());
    await store.append({ connectionId: 'c1', sql: 'select 1', status: 'success', safety: safeSelect });
    await store.append({ connectionId: 'c1', sql: 'select 2', status: 'success', safety: safeSelect });
    await store.append({ connectionId: 'c1', sql: 'select 3', status: 'success', safety: safeSelect });

    const page = await store.search({ connectionId: 'c1', limit: 1, offset: 1 });

    expect(page).toMatchObject({ total: 3, offset: 1, limit: 1 });
    expect(page.items.map((item) => item.sql)).toEqual(['select 2']);
  });

  it('retains five hundred records while default list reads the newest hundred', async () => {
    const filePath = await historyPath();
    const store = new QueryHistoryStore(filePath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify(
        Array.from({ length: 520 }, (_, index) => ({
          id: `existing-${520 - index}`,
          connectionId: 'c1',
          sql: `select ${520 - index}`,
          status: 'success',
          createdAt: '2026-06-18T10:00:00.000Z',
          safety: safeSelect,
        })),
      ),
      'utf8',
    );
    await store.append({ connectionId: 'c1', sql: 'select newest', status: 'success', safety: safeSelect });

    const defaultHistory = await store.list({});
    const fullSearch = await store.search({ limit: 600 });

    expect(defaultHistory).toHaveLength(100);
    expect(defaultHistory[0]?.sql).toBe('select newest');
    expect(fullSearch.total).toBe(500);
    expect(fullSearch.items.at(-1)?.sql).toBe('select 22');
  });

  it('filters by created time range when users inspect recent incidents', async () => {
    const filePath = await historyPath();
    const store = new QueryHistoryStore(filePath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify(
        [
          {
            id: 'recent',
            connectionId: 'prod',
            sql: 'select now()',
            status: 'success',
            createdAt: '2026-06-18T10:00:00.000Z',
            safety: safeSelect,
          },
          {
            id: 'old',
            connectionId: 'prod',
            sql: 'select 1',
            status: 'success',
            createdAt: '2026-06-17T10:00:00.000Z',
            safety: safeSelect,
          },
        ],
        null,
        2,
      ),
      'utf8',
    );

    const history = await store.list({
      createdFrom: '2026-06-18T00:00:00.000Z',
      createdTo: new Date('2026-06-18T23:59:59.000Z'),
    });

    expect(history.map((item) => item.id)).toEqual(['recent']);
  });

  it('treats corrupt query history as empty so query execution can continue', async () => {
    const filePath = await historyPath();
    const store = new QueryHistoryStore(filePath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, '{ broken json', 'utf8');

    await expect(store.list({})).resolves.toEqual([]);
  });
});
