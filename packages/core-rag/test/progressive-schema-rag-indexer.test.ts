import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { TableDetail } from '@dbagent/shared';
import {
  ProgressiveSchemaRagIndexer,
  SchemaRagEngine,
  SchemaRagSnapshotStore,
  type SchemaRagEmbeddingAdapter,
  type SchemaRagRetrievalProfile,
} from '../src/index.js';
import { column } from './schema-fixtures.js';

describe('ProgressiveSchemaRagIndexer', () => {
  it('does not expose a partially indexed schema when embedding generation fails', async () => {
    const profile: SchemaRagRetrievalProfile = {
      id: 'failing-embedding-profile',
      version: 1,
      backend: { type: 'memory' },
      embedding: {
        providerInstanceId: 'embedding-provider',
        modelId: 'embedding-model',
        dimensions: 2,
        normalization: 'l2',
        distanceMetric: 'cosine',
        requestTemplateVersion: 'v1',
      },
    };
    const engine = new SchemaRagEngine({
      retrievalProfile: profile,
      embeddingAdapter: {
        embed: () => Promise.reject(new Error('embedding unavailable')),
      },
    });
    const indexer = new ProgressiveSchemaRagIndexer({ engine });

    await expect(
      indexer.indexAsync({
        connectionId: 'failed-embedding',
        tables: fixtureTables().slice(0, 1),
      }),
    ).rejects.toThrow('embedding unavailable');

    expect(engine.hasIndex('failed-embedding')).toBe(false);
    expect(indexer.getStatus('failed-embedding')).toMatchObject({
      ready: false,
      stage: 'failed',
    });
  });

  it('restores the previous ready index when durable snapshot persistence fails', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'schemanaut-rag-save-failure-'));
    const blockedRoot = path.join(directory, 'not-a-directory');
    await writeFile(blockedRoot, 'blocked', 'utf8');
    const engine = new SchemaRagEngine();
    engine.index({
      connectionId: 'warehouse',
      tables: [fixtureTables()[0]!],
    });
    const previousCatalog = engine.getCatalog('warehouse');
    const indexer = new ProgressiveSchemaRagIndexer({
      engine,
      snapshotStore: new SchemaRagSnapshotStore({ rootDir: blockedRoot }),
    });

    await expect(
      indexer.index({
        connectionId: 'warehouse',
        tables: [fixtureTables()[1]!],
      }),
    ).rejects.toThrow();

    expect(engine.getCatalog('warehouse').catalogRootHash).toBe(previousCatalog.catalogRootHash);
    expect(engine.hasTable({ connectionId: 'warehouse', schema: 'public', table: 'campaign_events' }))
      .toBe(true);
    expect(engine.hasTable({ connectionId: 'warehouse', schema: 'public', table: 'conversions' }))
      .toBe(false);
  });

  it('persists vectors when progressive indexing uses an asynchronous embedding adapter', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'dbagent-rag-progressive-async-'));
    const profile: SchemaRagRetrievalProfile = {
      id: 'async-profile',
      version: 1,
      backend: { type: 'memory' },
      embedding: {
        providerInstanceId: 'embedding-provider',
        modelId: 'embedding-model',
        dimensions: 2,
        normalization: 'l2',
        distanceMetric: 'cosine',
        requestTemplateVersion: 'v1',
      },
    };
    const embed = vi.fn<SchemaRagEmbeddingAdapter['embed']>(({ texts }) =>
      Promise.resolve(texts.map(() => [1, 0])),
    );
    const engine = new SchemaRagEngine({
      retrievalProfile: profile,
      embeddingAdapter: { embed },
    });
    const store = new SchemaRagSnapshotStore({ rootDir });
    const indexer = new ProgressiveSchemaRagIndexer({ engine, snapshotStore: store });

    const result = await indexer.indexAsync({
      connectionId: 'async-warehouse',
      tables: fixtureTables().slice(0, 1),
      indexedAt: '2026-07-24T00:00:00.000Z',
    });
    const restored = await store.load('async-warehouse');

    expect(embed).toHaveBeenCalledOnce();
    expect(result.index.vectors).toBeDefined();
    expect(restored?.vectors).toEqual(result.index.vectors);
  });

  it('indexes schema metadata, records progressive stages, and persists a snapshot', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'dbagent-rag-progressive-'));
    const engine = new SchemaRagEngine();
    const store = new SchemaRagSnapshotStore({ rootDir });
    const indexer = new ProgressiveSchemaRagIndexer({ engine, snapshotStore: store });

    const result = await indexer.index(
      {
        connectionId: 'traffic_warehouse',
        tables: fixtureTables(),
        indexedAt: '2026-06-24T01:00:00.000Z',
      },
      { hotTableLimit: 1 },
    );

    expect(result.status).toMatchObject({
      connectionId: 'traffic_warehouse',
      stage: 'ready',
      ready: true,
      tableCount: 2,
      columnCount: 5,
      indexedAt: '2026-06-24T01:00:00.000Z',
    });
    expect(
      result.status.stages.map((stage) => [stage.stage, stage.state, stage.done, stage.total]),
    ).toEqual([
      ['skeleton', 'completed', 2, 2],
      ['hot_tables', 'completed', 1, 1],
      ['long_tail', 'completed', 1, 1],
      ['ready', 'completed', 1, 1],
    ]);
    expect(indexer.getStatus('traffic_warehouse').ready).toBe(true);
    await expect(store.load('traffic_warehouse')).resolves.toBeDefined();
  });

  it('restores a persisted snapshot into a new engine after process restart', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'dbagent-rag-restore-'));
    const firstEngine = new SchemaRagEngine();
    const store = new SchemaRagSnapshotStore({ rootDir });
    await new ProgressiveSchemaRagIndexer({ engine: firstEngine, snapshotStore: store }).index({
      connectionId: 'traffic_warehouse',
      tables: fixtureTables(),
    });

    const secondEngine = new SchemaRagEngine();
    const secondIndexer = new ProgressiveSchemaRagIndexer({
      engine: secondEngine,
      snapshotStore: store,
    });
    const status = await secondIndexer.restore('traffic_warehouse');

    expect(status?.ready).toBe(true);
    expect(
      secondEngine
        .search({ connectionId: 'traffic_warehouse', query: 'campaign visits', limit: 4 })
        .map((item) => item.document.id),
    ).toContain('table:public.campaign_events');
    expect(
      secondEngine.buildContext({
        connectionId: 'traffic_warehouse',
        query: 'conversion revenue',
        limit: 4,
        maxChars: 800,
      }).text,
    ).toContain('public.conversions');
  });

  it('keeps hybrid retrieval reasons after snapshot restore', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'dbagent-rag-hybrid-restore-'));
    const firstEngine = new SchemaRagEngine();
    const store = new SchemaRagSnapshotStore({ rootDir });
    await new ProgressiveSchemaRagIndexer({ engine: firstEngine, snapshotStore: store }).index({
      connectionId: 'traffic_warehouse',
      tables: fixtureTables(),
      glossary: [
        {
          term: 'ROAS',
          aliases: ['return on ad spend'],
          description: 'Revenue attributed to campaign traffic.',
          documentIds: ['table:public.conversions', 'column:public.conversions.revenue'],
          weight: 80,
        },
      ],
    });

    const before = firstEngine.search({
      connectionId: 'traffic_warehouse',
      query: 'ROAS revenue',
      limit: 4,
    });
    const secondEngine = new SchemaRagEngine();
    await new ProgressiveSchemaRagIndexer({
      engine: secondEngine,
      snapshotStore: store,
    }).restore('traffic_warehouse');
    const after = secondEngine.search({
      connectionId: 'traffic_warehouse',
      query: 'ROAS revenue',
      limit: 4,
    });

    expect(after.map((item) => item.document.id)).toEqual(before.map((item) => item.document.id));
    expect(after[0]?.reasons).toEqual(expect.arrayContaining(['glossary:ROAS']));
    expect(after[0]?.scoreDetails?.map((detail) => detail.channel)).toContain('glossary');
  });

  it('persists on-demand upserted tables so they survive process restart', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'dbagent-rag-upsert-restore-'));
    const firstEngine = new SchemaRagEngine();
    const store = new SchemaRagSnapshotStore({ rootDir });
    const firstIndexer = new ProgressiveSchemaRagIndexer({
      engine: firstEngine,
      snapshotStore: store,
    });
    await firstIndexer.index({
      connectionId: 'traffic_warehouse',
      tables: [fixtureTables()[0]!],
    });
    await firstIndexer.upsertTables({
      connectionId: 'traffic_warehouse',
      tables: [fixtureTables()[1]!],
    });

    const secondEngine = new SchemaRagEngine();
    const secondIndexer = new ProgressiveSchemaRagIndexer({
      engine: secondEngine,
      snapshotStore: store,
    });
    await secondIndexer.restore('traffic_warehouse');

    expect(
      secondEngine
        .search({
          connectionId: 'traffic_warehouse',
          query: '@public.conversions revenue',
          limit: 3,
        })
        .map((item) => item.document.id),
    ).toContain('table:public.conversions');
  });

  it('rebuilds and persists embedding vectors after an incremental table upsert', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'schemanaut-rag-upsert-vectors-'));
    const profile: SchemaRagRetrievalProfile = {
      id: 'incremental-vector-profile',
      version: 1,
      backend: { type: 'memory' },
      embedding: {
        providerInstanceId: 'embedding-provider',
        modelId: 'embedding-model',
        dimensions: 2,
        normalization: 'l2',
        distanceMetric: 'cosine',
        requestTemplateVersion: 'v1',
      },
    };
    const embed = vi.fn<SchemaRagEmbeddingAdapter['embed']>(({ texts }) =>
      Promise.resolve(texts.map(() => [1, 0])),
    );
    const engine = new SchemaRagEngine({ embeddingAdapter: { embed } });
    const store = new SchemaRagSnapshotStore({ rootDir });
    const indexer = new ProgressiveSchemaRagIndexer({ engine, snapshotStore: store });
    await indexer.indexAsync({
      connectionId: 'incremental-warehouse',
      tables: [fixtureTables()[0]!],
      retrievalProfile: profile,
    });

    const result = await indexer.upsertTables({
      connectionId: 'incremental-warehouse',
      tables: [fixtureTables()[1]!],
    });
    const restored = await store.load('incremental-warehouse');
    const expectedVectorIds = result.index.documents.map((document) => document.id).sort();

    expect(embed).toHaveBeenCalledTimes(2);
    expect(Object.keys(result.index.vectors ?? {}).sort()).toEqual(expectedVectorIds);
    expect(Object.keys(restored?.vectors ?? {}).sort()).toEqual(expectedVectorIds);
    expect(result.status).toMatchObject({ stage: 'ready', ready: true });
  });

  it('rolls back an incremental index and its vectors when snapshot persistence fails', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'schemanaut-rag-upsert-rollback-'));
    const blockedRoot = path.join(directory, 'not-a-directory');
    await writeFile(blockedRoot, 'blocked', 'utf8');
    const profile: SchemaRagRetrievalProfile = {
      id: 'incremental-rollback-profile',
      version: 1,
      backend: { type: 'memory' },
      embedding: {
        providerInstanceId: 'embedding-provider',
        modelId: 'embedding-model',
        dimensions: 2,
        normalization: 'l2',
        distanceMetric: 'cosine',
        requestTemplateVersion: 'v1',
      },
    };
    const engine = new SchemaRagEngine({
      retrievalProfile: profile,
      embeddingAdapter: {
        embed: ({ texts }) => Promise.resolve(texts.map(() => [1, 0])),
      },
    });
    const initial = await engine.indexAsync({
      connectionId: 'rollback-warehouse',
      tables: [fixtureTables()[0]!],
    });
    const previousCatalogRootHash = initial.catalog?.catalogRootHash;
    const previousVectors = structuredClone(initial.vectors);
    const indexer = new ProgressiveSchemaRagIndexer({
      engine,
      snapshotStore: new SchemaRagSnapshotStore({ rootDir: blockedRoot }),
    });

    await expect(
      indexer.upsertTables({
        connectionId: 'rollback-warehouse',
        tables: [fixtureTables()[1]!],
      }),
    ).rejects.toThrow();

    const restored = engine.createCheckpoint('rollback-warehouse').index;
    expect(restored?.catalog?.catalogRootHash).toBe(previousCatalogRootHash);
    expect(restored?.vectors).toEqual(previousVectors);
    expect(
      engine.hasTable({
        connectionId: 'rollback-warehouse',
        schema: 'public',
        table: 'campaign_events',
      }),
    ).toBe(true);
    expect(
      engine.hasTable({
        connectionId: 'rollback-warehouse',
        schema: 'public',
        table: 'conversions',
      }),
    ).toBe(false);
    expect(indexer.getStatus('rollback-warehouse')).toMatchObject({
      stage: 'failed',
      ready: false,
    });
  });

  it('reports idle when no snapshot exists for a connection', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'dbagent-rag-idle-'));
    const engine = new SchemaRagEngine();
    const indexer = new ProgressiveSchemaRagIndexer({
      engine,
      snapshotStore: new SchemaRagSnapshotStore({ rootDir }),
    });

    await expect(indexer.restore('unknown_connection')).resolves.toBeUndefined();
    expect(indexer.getStatus('unknown_connection')).toMatchObject({
      connectionId: 'unknown_connection',
      stage: 'idle',
      ready: false,
      documentCount: 0,
    });
  });

  it('reports a failed restore status for a corrupted snapshot without throwing', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'dbagent-rag-restore-failed-'));
    const engine = new SchemaRagEngine();
    const store = new SchemaRagSnapshotStore({ rootDir });
    const indexer = new ProgressiveSchemaRagIndexer({ engine, snapshotStore: store });

    await writeFile(store.getSnapshotPath('traffic_warehouse'), '{not-json', 'utf8');

    const status = await indexer.restore('traffic_warehouse');

    expect(status).toMatchObject({
      connectionId: 'traffic_warehouse',
      stage: 'failed',
      ready: false,
      documentCount: 0,
    });
    expect(status?.stages[0]).toMatchObject({
      stage: 'failed',
      state: 'failed',
      done: 0,
      total: 1,
    });
    expect(indexer.getStatus('traffic_warehouse').stage).toBe('failed');
    expect(engine.hasIndex('traffic_warehouse')).toBe(false);
  });

  it('restores all available snapshots on startup and reports invalid snapshots', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'dbagent-rag-restore-all-'));
    const store = new SchemaRagSnapshotStore({ rootDir });
    await new ProgressiveSchemaRagIndexer({
      engine: new SchemaRagEngine(),
      snapshotStore: store,
    }).index({
      connectionId: 'traffic_warehouse',
      tables: fixtureTables(),
      indexedAt: '2026-06-24T01:00:00.000Z',
    });
    await new ProgressiveSchemaRagIndexer({
      engine: new SchemaRagEngine(),
      snapshotStore: store,
    }).index({
      connectionId: 'commerce_warehouse',
      tables: [commerceOrdersTable()],
      indexedAt: '2026-06-24T02:00:00.000Z',
    });
    await writeFile(path.join(rootDir, 'broken.schema-rag.json'), '{not-json', 'utf8');
    const engine = new SchemaRagEngine();
    const indexer = new ProgressiveSchemaRagIndexer({ engine, snapshotStore: store });

    const result = await indexer.restoreAll();

    expect(result.failed).toEqual([]);
    expect(result.invalidSnapshots).toEqual([
      expect.objectContaining({ snapshotPath: path.join(rootDir, 'broken.schema-rag.json') }),
    ]);
    expect(result.restored.map((status) => status.connectionId).sort()).toEqual([
      'commerce_warehouse',
      'traffic_warehouse',
    ]);
    expect(engine.hasIndex('traffic_warehouse')).toBe(true);
    expect(engine.hasIndex('commerce_warehouse')).toBe(true);
    expect(
      engine
        .search({ connectionId: 'commerce_warehouse', query: 'refund orders', limit: 3 })
        .map((item) => item.document.id),
    ).toContain('table:public.orders');
  });

  it('restores only selected connection snapshots when a startup filter is provided', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'dbagent-rag-restore-filtered-'));
    const store = new SchemaRagSnapshotStore({ rootDir });
    await new ProgressiveSchemaRagIndexer({
      engine: new SchemaRagEngine(),
      snapshotStore: store,
    }).index({ connectionId: 'traffic_warehouse', tables: fixtureTables() });
    await new ProgressiveSchemaRagIndexer({
      engine: new SchemaRagEngine(),
      snapshotStore: store,
    }).index({ connectionId: 'commerce_warehouse', tables: [commerceOrdersTable()] });
    const engine = new SchemaRagEngine();
    const indexer = new ProgressiveSchemaRagIndexer({ engine, snapshotStore: store });

    const result = await indexer.restoreAll({ connectionIds: ['commerce_warehouse'] });

    expect(result.restored.map((status) => status.connectionId)).toEqual(['commerce_warehouse']);
    expect(engine.hasIndex('commerce_warehouse')).toBe(true);
    expect(engine.hasIndex('traffic_warehouse')).toBe(false);
  });

  it('returns an empty startup restore result when no snapshot store is configured', async () => {
    const indexer = new ProgressiveSchemaRagIndexer({ engine: new SchemaRagEngine() });

    await expect(indexer.restoreAll()).resolves.toEqual({
      restored: [],
      invalidSnapshots: [],
      failed: [],
    });
  });
});

function fixtureTables(): TableDetail[] {
  return [
    {
      schema: 'public',
      name: 'campaign_events',
      type: 'table',
      comment: 'traffic analysis event stream for campaign visits and clicks',
      primaryKey: ['event_id'],
      columns: [
        column('event_id', 1, 'uuid', false, 'event id', true),
        column('campaign_id', 2, 'text', false, 'campaign identifier'),
        column('visitor_id', 3, 'text', false, 'visitor identifier'),
      ],
    },
    {
      schema: 'public',
      name: 'conversions',
      type: 'table',
      comment: 'conversion table with revenue attributed to campaign traffic',
      primaryKey: ['conversion_id'],
      columns: [
        column('conversion_id', 1, 'uuid', false, 'conversion id', true),
        column('revenue', 2, 'numeric', false, 'conversion revenue'),
      ],
    },
  ];
}

function commerceOrdersTable(): TableDetail {
  return {
    schema: 'public',
    name: 'orders',
    type: 'table',
    comment: 'commerce orders with refund and payment status',
    primaryKey: ['order_id'],
    columns: [
      column('order_id', 1, 'uuid', false, 'order id', true),
      column('customer_id', 2, 'uuid', false, 'customer id'),
      column('refund_status', 3, 'text', true, 'refund status'),
    ],
  };
}
