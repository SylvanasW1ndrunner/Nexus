import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueryExecutionResult, QuerySafetyReport } from '@dbagent/shared';
import { QuerySnapshotStore } from '../src/query-snapshot.js';

const tempDirs: string[] = [];
const safeSelect: QuerySafetyReport = {
  statementKind: 'SELECT',
  riskLevel: 'safe',
  requiresConfirmation: false,
  blocked: false,
  reasons: [],
};

async function snapshotPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-snapshots-'));
  tempDirs.push(dir);
  return join(dir, 'nested', 'query-snapshots.json');
}

function result(overrides: Partial<QueryExecutionResult> = {}): QueryExecutionResult {
  return {
    queryId: 'q1',
    columns: [
      { name: 'id', dataType: 'int8' },
      { name: 'created_at', dataType: 'timestamptz' },
      { name: 'payload', dataType: 'jsonb' },
      { name: 'raw', dataType: 'bytea' },
    ],
    rows: [
      {
        id: 9007199254740993n,
        created_at: new Date('2026-06-17T08:30:00.000Z'),
        payload: { status: 'paid', scores: [1, 2, 3] },
        raw: Buffer.from('hello'),
      },
    ],
    rowCount: 1,
    elapsedMs: 18,
    safety: safeSelect,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('QuerySnapshotStore', () => {
  it('pins a query result and preserves database-specific values after JSON persistence', async () => {
    const store = new QuerySnapshotStore(await snapshotPath());

    const created = await store.create({
      connectionId: 'prod-pg',
      sql: 'select * from orders limit 1',
      result: result(),
      title: '订单样本',
      tags: ['orders', 'orders', ' finance '],
      note: '给分析师复查的样本',
      sourceHistoryId: 'h1',
    });

    const loaded = await store.get(created.id);
    expect(loaded).toMatchObject({
      connectionId: 'prod-pg',
      queryId: 'q1',
      title: '订单样本',
      sql: 'select * from orders limit 1',
      rowCount: 1,
      elapsedMs: 18,
      tags: ['orders', 'finance'],
      note: '给分析师复查的样本',
      sourceHistoryId: 'h1',
    });
    expect(loaded?.rows[0]).toEqual({
      id: { type: 'bigint', value: '9007199254740993' },
      created_at: { type: 'date', value: '2026-06-17T08:30:00.000Z' },
      payload: { status: 'paid', scores: [1, 2, 3] },
      raw: { type: 'buffer', encoding: 'base64', value: 'aGVsbG8=' },
    });
  });

  it('preserves result truncation metadata for pinned large query results', async () => {
    const store = new QuerySnapshotStore(await snapshotPath());

    const created = await store.create({
      connectionId: 'prod-pg',
      sql: 'select * from traffic_events order by event_time desc',
      result: result({
        rows: [
          { id: 1, created_at: null, payload: { event: 'page_view' }, raw: null },
          { id: 2, created_at: null, payload: { event: 'checkout' }, raw: null },
        ],
        rowCount: 50_000,
        returnedRowCount: 2,
        rowLimit: 2,
        hasMore: true,
        truncated: true,
      }),
    });

    const loaded = await store.get(created.id);
    expect(loaded).toMatchObject({
      rowCount: 50_000,
      returnedRowCount: 2,
      rowLimit: 2,
      hasMore: true,
      truncated: true,
    });
    expect(loaded?.rows).toHaveLength(2);

    const summaries = await store.list();
    expect(summaries[0]).toMatchObject({
      rowCount: 50_000,
      returnedRowCount: 2,
      rowLimit: 2,
      hasMore: true,
      truncated: true,
    });
  });

  it('lists snapshots newest-first with connection filtering, search, and row previews', async () => {
    const store = new QuerySnapshotStore(await snapshotPath());
    await store.create({
      connectionId: 'c1',
      sql: 'select * from users',
      result: result({ queryId: 'q1' }),
      title: '用户查询',
      tags: ['user'],
    });
    await store.create({
      connectionId: 'c2',
      sql: 'select * from orders',
      result: result({
        queryId: 'q2',
        rows: [
          { id: 1, created_at: null, payload: { status: 'paid' }, raw: null },
          { id: 2, created_at: null, payload: { status: 'refunded' }, raw: null },
        ],
        rowCount: 2,
      }),
      title: '订单查询',
      tags: ['finance'],
    });

    const all = await store.list({ previewRowLimit: 1 });
    expect(all.map((item) => item.title)).toEqual(['订单查询', '用户查询']);
    expect(all[0]?.previewRows).toHaveLength(1);
    expect(all[0]?.rowCount).toBe(2);

    const filtered = await store.list({ connectionId: 'c2', searchText: 'finance' });
    expect(filtered.map((item) => item.title)).toEqual(['订单查询']);
  });

  it('removes snapshots and reports whether the target existed', async () => {
    const store = new QuerySnapshotStore(await snapshotPath());
    const snapshot = await store.create({
      connectionId: 'c1',
      sql: 'select 1',
      result: result({ queryId: 'q1' }),
    });

    await expect(store.remove(snapshot.id)).resolves.toBe(true);
    await expect(store.remove(snapshot.id)).resolves.toBe(false);
    await expect(store.get(snapshot.id)).resolves.toBeUndefined();
  });

  it('treats corrupt snapshot files as empty so the IDE can keep running', async () => {
    const filePath = await snapshotPath();
    const store = new QuerySnapshotStore(filePath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, '{ broken json', 'utf8');

    await expect(store.list()).resolves.toEqual([]);
  });

  it('caps stored snapshots to avoid unbounded local growth', async () => {
    const store = new QuerySnapshotStore(await snapshotPath(), 2);
    await store.create({ connectionId: 'c1', sql: 'select 1', result: result({ queryId: 'q1' }) });
    await store.create({ connectionId: 'c1', sql: 'select 2', result: result({ queryId: 'q2' }) });
    await store.create({ connectionId: 'c1', sql: 'select 3', result: result({ queryId: 'q3' }) });

    const snapshots = await store.list();
    expect(snapshots.map((item) => item.queryId)).toEqual(['q3', 'q2']);
  });
});
