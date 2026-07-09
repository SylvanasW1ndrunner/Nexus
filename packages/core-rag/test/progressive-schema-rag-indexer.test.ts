import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TableDetail } from '@dbagent/shared';
import {
  ProgressiveSchemaRagIndexer,
  SchemaRagEngine,
  SchemaRagSnapshotStore,
} from '../src/index.js';

describe('ProgressiveSchemaRagIndexer', () => {
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

function column(
  name: string,
  ordinal: number,
  dataType: string,
  nullable: boolean,
  comment?: string,
  isPrimaryKey = false,
) {
  return {
    name,
    ordinal,
    dataType,
    nullable,
    comment,
    isPrimaryKey,
  };
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
