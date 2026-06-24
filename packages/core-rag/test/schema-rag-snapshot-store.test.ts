import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TableDetail } from '@dbagent/shared';
import { SchemaRagEngine, SchemaRagSnapshotStore } from '../src/index.js';

describe('SchemaRagSnapshotStore', () => {
  it('round-trips a connection-level schema index through the real file system', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'dbagent-rag-snapshot-'));
    const store = new SchemaRagSnapshotStore({ rootDir });
    const engine = new SchemaRagEngine();
    const index = engine.index({
      connectionId: 'production/ecommerce',
      tables: fixtureTables(),
      indexedAt: '2026-06-24T00:00:00.000Z',
      glossary: [{ term: 'GMV', documentIds: ['table:public.orders', 'column:public.orders.total_amount'], weight: 60 }],
    });

    await store.save(index);
    const raw = JSON.parse(await readFile(store.getSnapshotPath('production/ecommerce'), 'utf8')) as Record<string, unknown>;
    expect(raw).toMatchObject({
      version: 1,
      connectionId: 'production/ecommerce',
      indexedAt: '2026-06-24T00:00:00.000Z',
    });

    const restored = await store.load('production/ecommerce');
    expect(restored?.documents.map((document) => document.id)).toContain('column:public.orders.total_amount');
    expect(restored?.graph.get('table:public.orders')).toEqual(
      new Set([
        'column:public.orders.user_id',
        'column:public.orders.total_amount',
        'column:public.orders.id',
        'table:public.users',
      ]),
    );
    expect(restored?.glossary).toEqual([
      { term: 'GMV', aliases: [], documentIds: ['table:public.orders', 'column:public.orders.total_amount'], weight: 60 },
    ]);

    const newEngine = new SchemaRagEngine();
    newEngine.loadIndex(restored!);
    expect(newEngine.search({ connectionId: 'production/ecommerce', query: 'GMV', limit: 3 }).map((item) => item.document.id)).toContain(
      'column:public.orders.total_amount',
    );
  });

  it('returns undefined for missing or corrupted snapshots without blocking database use', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'dbagent-rag-corrupt-'));
    const store = new SchemaRagSnapshotStore({ rootDir });

    await expect(store.load('missing')).resolves.toBeUndefined();

    await writeFile(store.getSnapshotPath('corrupt'), '{broken-json', 'utf8');
    await expect(store.load('corrupt')).resolves.toBeUndefined();

    await writeFile(store.getSnapshotPath('old-version'), JSON.stringify({ version: 0, connectionId: 'old-version' }), 'utf8');
    await expect(store.load('old-version')).resolves.toBeUndefined();
  });

  it('removes only the selected connection snapshot', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'dbagent-rag-remove-'));
    const store = new SchemaRagSnapshotStore({ rootDir });
    const engine = new SchemaRagEngine();

    await store.save(engine.index({ connectionId: 'conn_a', tables: fixtureTables() }));
    await store.save(engine.index({ connectionId: 'conn_b', tables: fixtureTables() }));

    await store.remove('conn_a');

    await expect(store.load('conn_a')).resolves.toBeUndefined();
    await expect(store.load('conn_b')).resolves.toBeDefined();
  });
});

function fixtureTables(): TableDetail[] {
  return [
    {
      schema: 'public',
      name: 'users',
      type: 'table',
      comment: 'registered user account table',
      primaryKey: ['id'],
      columns: [
        column('id', 1, 'uuid', false, 'user id', true),
        column('email', 2, 'text', false, 'user email'),
      ],
    },
    {
      schema: 'public',
      name: 'orders',
      type: 'table',
      comment: 'order fact table with owner and total amount',
      primaryKey: ['id'],
      columns: [
        column('id', 1, 'uuid', false, 'order id', true),
        {
          ...column('user_id', 2, 'uuid', false, 'buyer user id'),
          foreignKey: { schema: 'public', table: 'users', column: 'id' },
        },
        column('total_amount', 3, 'numeric', false, 'order GMV amount'),
      ],
    },
  ];
}

function column(name: string, ordinal: number, dataType: string, nullable: boolean, comment?: string, isPrimaryKey = false) {
  return {
    name,
    ordinal,
    dataType,
    nullable,
    comment,
    isPrimaryKey,
  };
}
