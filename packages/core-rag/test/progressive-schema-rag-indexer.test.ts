import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TableDetail } from '@dbagent/shared';
import { ProgressiveSchemaRagIndexer, SchemaRagEngine, SchemaRagSnapshotStore } from '../src/index.js';

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
    expect(result.status.stages.map((stage) => [stage.stage, stage.state, stage.done, stage.total])).toEqual([
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
    const secondIndexer = new ProgressiveSchemaRagIndexer({ engine: secondEngine, snapshotStore: store });
    const status = await secondIndexer.restore('traffic_warehouse');

    expect(status?.ready).toBe(true);
    expect(secondEngine.search({ connectionId: 'traffic_warehouse', query: 'campaign visits', limit: 4 }).map((item) => item.document.id)).toContain(
      'table:public.campaign_events',
    );
    expect(
      secondEngine.buildContext({ connectionId: 'traffic_warehouse', query: 'conversion revenue', limit: 4, maxChars: 800 }).text,
    ).toContain('public.conversions');
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
