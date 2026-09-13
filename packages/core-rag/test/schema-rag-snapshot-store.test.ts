import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import type * as FileSystemPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { TableDetail } from '@dbagent/shared';
import { SchemaRagEngine, SchemaRagSnapshotStore } from '../src/index.js';
import { column } from './schema-fixtures.js';

const writeGate = vi.hoisted(() => ({
  beforeTemporaryWrite: undefined as undefined | ((file: string) => Promise<void>),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FileSystemPromises>();
  return {
    ...actual,
    writeFile: async (...args: unknown[]) => {
      const file = args[0];
      if (typeof file === 'string' && file.endsWith('.tmp')) {
        await writeGate.beforeTemporaryWrite?.(file);
      }
      return await (actual.writeFile as (...values: unknown[]) => Promise<void>)(...args);
    },
  };
});

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
    expect(raw.version).toBe(2);
    expect(raw.connectionId).toBe('production/ecommerce');
    expect(raw.indexedAt).toBe('2026-06-24T00:00:00.000Z');
    const catalog = raw.catalog as Record<string, unknown>;
    expect(catalog.version).toBe(1);
    expect(catalog.connectionId).toBe('production/ecommerce');

    const restored = await store.load('production/ecommerce');
    expect(restored?.documents.map((document) => document.id)).toContain('column:public.orders.total_amount');
    expect(restored?.graph.get('table:public.orders')).toEqual(
      new Set([
        'column:public.orders.user_id',
        'column:public.orders.total_amount',
        'column:public.orders.id',
        'resource:schema:public',
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

  it('reports invalid snapshot diagnostics and quarantines the broken file', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'dbagent-rag-diagnostic-'));
    const store = new SchemaRagSnapshotStore({ rootDir });
    const snapshotPath = store.getSnapshotPath('broken_connection');
    await writeFile(
      snapshotPath,
      JSON.stringify({
        version: 2,
        connectionId: 'other',
        savedAt: '2026-07-08T00:00:00.000Z',
        indexedAt: '2026-07-08T00:00:00.000Z',
        documents: [],
        graph: [],
        glossary: [],
      }),
      'utf8',
    );

    const result = await store.loadDetailed('broken_connection');

    expect(result).toMatchObject({
      status: 'invalid',
      snapshotPath,
      reason: 'Snapshot connection id does not match the requested connection.',
    });
    expect(result.status === 'invalid' ? result.quarantinedPath : undefined).toContain('.corrupt-');
    await expect(store.load('broken_connection')).resolves.toBeUndefined();
    await expect(readdir(rootDir)).resolves.toEqual(expect.arrayContaining([expect.stringMatching(/broken_connection.*\.corrupt-/)]));
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

  it('serializes direct saves from separate Store instances to the same target', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'dbagent-rag-save-lane-'));
    const firstStore = new SchemaRagSnapshotStore({ rootDir });
    const secondStore = new SchemaRagSnapshotStore({ rootDir });
    const engine = new SchemaRagEngine();
    const firstIndex = engine.index({ connectionId: 'shared', tables: [fixtureTables()[0]!] });
    const secondIndex = engine.index({ connectionId: 'shared', tables: [fixtureTables()[1]!] });
    let releaseFirstWrite: (() => void) | undefined;
    let firstWriteStarted: (() => void) | undefined;
    const firstWrite = new Promise<void>((resolve) => {
      firstWriteStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let temporaryWrites = 0;
    writeGate.beforeTemporaryWrite = async () => {
      temporaryWrites += 1;
      if (temporaryWrites === 1) {
        firstWriteStarted?.();
        await release;
      }
    };

    try {
      const first = firstStore.save(firstIndex);
      await firstWrite;
      const second = secondStore.save(secondIndex);
      await Promise.resolve();
      expect(temporaryWrites).toBe(1);
      releaseFirstWrite?.();
      await Promise.all([first, second]);
    } finally {
      writeGate.beforeTemporaryWrite = undefined;
    }

    const restored = await firstStore.load('shared');
    expect(restored?.documents.some((document) => document.id === 'table:public.orders')).toBe(true);
    expect(restored?.documents.some((document) => document.id === 'table:public.users')).toBe(false);
  });

  it('lists snapshot summaries for startup diagnostics without loading every index into memory', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'dbagent-rag-list-'));
    const store = new SchemaRagSnapshotStore({ rootDir });
    const engine = new SchemaRagEngine();

    await store.save(
      engine.index({
        connectionId: 'production/ecommerce',
        tables: fixtureTables(),
        indexedAt: '2026-07-08T00:00:00.000Z',
        glossary: [{ term: 'GMV', documentIds: ['table:public.orders'], weight: 60 }],
      }),
    );
    await writeFile(path.join(rootDir, 'notes.txt'), 'not a snapshot', 'utf8');
    await writeFile(store.getSnapshotPath('broken'), '{broken-json', 'utf8');

    const summaries = await store.list();

    expect(summaries).toHaveLength(2);
    expect(summaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'available',
          connectionId: 'production/ecommerce',
          indexedAt: '2026-07-08T00:00:00.000Z',
          documentCount: 10,
          tableCount: 2,
          columnCount: 5,
          relationCount: 0,
          glossaryCount: 1,
        }),
        expect.objectContaining({
          status: 'invalid',
          snapshotPath: store.getSnapshotPath('broken'),
        }),
      ]),
    );
  });

  it('cleans up snapshots for deleted connections and can remove invalid snapshots', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'dbagent-rag-cleanup-'));
    const store = new SchemaRagSnapshotStore({ rootDir });
    const engine = new SchemaRagEngine();

    await store.save(engine.index({ connectionId: 'active_connection', tables: fixtureTables() }));
    await store.save(engine.index({ connectionId: 'deleted_connection', tables: fixtureTables() }));
    await writeFile(store.getSnapshotPath('broken'), '{broken-json', 'utf8');

    const dryCleanup = await store.cleanupInactive({
      activeConnectionIds: ['active_connection'],
    });

    expect(dryCleanup.kept).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'available', connectionId: 'active_connection' }),
        expect.objectContaining({ status: 'invalid', snapshotPath: store.getSnapshotPath('broken') }),
      ]),
    );
    expect(dryCleanup.removed).toEqual([
      expect.objectContaining({
        reason: 'inactive_connection',
        connectionId: 'deleted_connection',
        snapshotPath: store.getSnapshotPath('deleted_connection'),
      }),
    ]);
    await expect(store.load('active_connection')).resolves.toBeDefined();
    await expect(store.load('deleted_connection')).resolves.toBeUndefined();

    const strictCleanup = await store.cleanupInactive({
      activeConnectionIds: ['active_connection'],
      removeInvalid: true,
    });

    expect(strictCleanup.removed).toEqual([
      expect.objectContaining({
        reason: 'invalid_snapshot',
        snapshotPath: store.getSnapshotPath('broken'),
      }),
    ]);
    await expect(readdir(rootDir)).resolves.not.toContain(path.basename(store.getSnapshotPath('broken')));
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
