import { describe, expect, it } from 'vitest';
import type {
  SchemaRagRestoreAllResult,
  SchemaRagSnapshotCleanupResult,
  SchemaRagSnapshotSummary,
} from '@dbagent/core-rag';
import {
  cleanupSchemaRagSnapshotsAtStartup,
  recoverSchemaRagSnapshotsAtStartup,
} from './schema-rag-startup-cleanup.js';

describe('cleanupSchemaRagSnapshotsAtStartup', () => {
  it('cleans snapshots that do not belong to active connections and removes invalid snapshots by default', async () => {
    const calls: Array<{ activeConnectionIds: string[]; removeInvalid?: boolean }> = [];

    const summary = await cleanupSchemaRagSnapshotsAtStartup({
      connections: {
        list: () => Promise.resolve([{ id: 'active-a' }, { id: 'active-b' }]),
      },
      snapshots: {
        cleanupInactive: (input) => {
          calls.push({
            activeConnectionIds: [...input.activeConnectionIds],
            ...(input.removeInvalid === undefined ? {} : { removeInvalid: input.removeInvalid }),
          });
          return Promise.resolve(
            cleanupResult({
              kept: [availableSnapshot('active-a')],
              removed: [
                {
                  snapshotPath: 'inactive.schema-rag.json',
                  reason: 'inactive_connection',
                  connectionId: 'old-connection',
                },
                { snapshotPath: 'invalid.schema-rag.json', reason: 'invalid_snapshot' },
              ],
            }),
          );
        },
      },
    });

    expect(calls).toEqual([{ activeConnectionIds: ['active-a', 'active-b'], removeInvalid: true }]);
    expect(summary).toEqual({
      activeConnectionCount: 2,
      keptCount: 1,
      invalidKeptCount: 0,
      removedCount: 2,
      removedInactiveCount: 1,
      removedInvalidCount: 1,
    });
  });

  it('supports preserving invalid snapshots when the caller disables invalid cleanup', async () => {
    const summary = await cleanupSchemaRagSnapshotsAtStartup({
      connections: {
        list: () => Promise.resolve([{ id: 'active-a' }]),
      },
      snapshots: {
        cleanupInactive: (input) => {
          expect([...input.activeConnectionIds]).toEqual(['active-a']);
          expect(input.removeInvalid).toBe(false);
          return Promise.resolve(
            cleanupResult({
              kept: [availableSnapshot('active-a'), invalidSnapshot('broken.schema-rag.json')],
              removed: [],
            }),
          );
        },
      },
      removeInvalid: false,
    });

    expect(summary).toMatchObject({
      activeConnectionCount: 1,
      keptCount: 2,
      invalidKeptCount: 1,
      removedCount: 0,
    });
  });

  it('does not call snapshot cleanup when active connection loading fails', async () => {
    let cleanupCalled = false;

    await expect(
      cleanupSchemaRagSnapshotsAtStartup({
        connections: {
          list: () => Promise.reject(new Error('connections.json is unreadable')),
        },
        snapshots: {
          cleanupInactive: () => {
            cleanupCalled = true;
            return Promise.resolve(cleanupResult({ kept: [], removed: [] }));
          },
        },
      }),
    ).rejects.toThrow('connections.json is unreadable');
    expect(cleanupCalled).toBe(false);
  });
});

describe('recoverSchemaRagSnapshotsAtStartup', () => {
  it('restores active connection snapshots through the shared progressive indexer after cleanup', async () => {
    const restoreCalls: string[][] = [];

    const summary = await recoverSchemaRagSnapshotsAtStartup({
      connections: {
        list: () => Promise.resolve([{ id: 'active-a' }, { id: 'active-b' }]),
      },
      snapshots: {
        cleanupInactive: (input) =>
          Promise.resolve(
            cleanupResult({
              kept: [...input.activeConnectionIds].map((connectionId) =>
                availableSnapshot(connectionId),
              ),
              removed: [],
            }),
          ),
      },
      indexer: {
        restoreAll(input) {
          restoreCalls.push([...(input?.connectionIds ?? [])]);
          return Promise.resolve(
            restoreAllResult({
              restoredConnectionIds: ['active-a', 'active-b'],
            }),
          );
        },
      },
    });

    expect(restoreCalls).toEqual([['active-a', 'active-b']]);
    expect(summary).toMatchObject({
      activeConnectionCount: 2,
      keptCount: 2,
      loadedCount: 2,
      missingCount: 0,
      invalidCount: 0,
      errorCount: 0,
      failedConnectionIds: [],
      restoredConnectionIds: ['active-a', 'active-b'],
    });
  });

  it('continues startup when some snapshots are missing, invalid, or failed', async () => {
    const summary = await recoverSchemaRagSnapshotsAtStartup({
      connections: {
        list: () => Promise.resolve([{ id: 'ready' }, { id: 'missing' }, { id: 'failed' }]),
      },
      snapshots: {
        cleanupInactive: () => Promise.resolve(cleanupResult({ kept: [], removed: [] })),
      },
      indexer: {
        restoreAll: () =>
          Promise.resolve(
            restoreAllResult({
              restoredConnectionIds: ['ready'],
              invalidSnapshots: [
                { snapshotPath: 'broken.schema-rag.json', reason: 'Snapshot JSON is invalid.' },
              ],
              failed: [
                {
                  connectionId: 'failed',
                  snapshotPath: 'failed.schema-rag.json',
                  error: 'disk read failed',
                },
              ],
            }),
          ),
      },
    });

    expect(summary).toMatchObject({
      loadedCount: 1,
      missingCount: 1,
      invalidCount: 1,
      errorCount: 1,
      failedConnectionIds: ['failed'],
      restoredConnectionIds: ['ready'],
      invalidSnapshotPaths: ['broken.schema-rag.json'],
    });
  });

  it('records cleanup failure but still attempts to restore active snapshots', async () => {
    const restoreCalls: string[][] = [];

    const summary = await recoverSchemaRagSnapshotsAtStartup({
      connections: {
        list: () => Promise.resolve([{ id: 'active-a' }]),
      },
      snapshots: {
        cleanupInactive: () =>
          Promise.reject(new Error('snapshot directory is temporarily locked')),
      },
      indexer: {
        restoreAll(input) {
          restoreCalls.push([...(input?.connectionIds ?? [])]);
          return Promise.resolve(restoreAllResult({ restoredConnectionIds: ['active-a'] }));
        },
      },
    });

    expect(restoreCalls).toEqual([['active-a']]);
    expect(summary).toMatchObject({
      activeConnectionCount: 1,
      loadedCount: 1,
      cleanupError: 'snapshot directory is temporarily locked',
    });
  });
});

function cleanupResult(input: SchemaRagSnapshotCleanupResult): SchemaRagSnapshotCleanupResult {
  return input;
}

function availableSnapshot(connectionId: string): SchemaRagSnapshotSummary {
  return {
    status: 'available',
    connectionId,
    snapshotPath: `${connectionId}.schema-rag.json`,
    savedAt: '2026-07-08T00:00:00.000Z',
    indexedAt: '2026-07-08T00:00:00.000Z',
    documentCount: 1,
    tableCount: 1,
    columnCount: 0,
    relationCount: 0,
    glossaryCount: 0,
  };
}

function invalidSnapshot(snapshotPath: string): SchemaRagSnapshotSummary {
  return {
    status: 'invalid',
    snapshotPath,
    reason: 'Snapshot JSON is invalid.',
  };
}

function restoreAllResult(input: {
  restoredConnectionIds?: string[];
  invalidSnapshots?: SchemaRagRestoreAllResult['invalidSnapshots'];
  failed?: SchemaRagRestoreAllResult['failed'];
}): SchemaRagRestoreAllResult {
  return {
    restored: (input.restoredConnectionIds ?? []).map((connectionId) => ({
      connectionId,
      stage: 'ready',
      ready: true,
      documentCount: 1,
      tableCount: 1,
      columnCount: 0,
      relationCount: 0,
      glossaryCount: 0,
      indexedAt: '2026-07-08T00:00:00.000Z',
      updatedAt: '2026-07-08T00:00:00.000Z',
      stages: [],
    })),
    invalidSnapshots: input.invalidSnapshots ?? [],
    failed: input.failed ?? [],
  };
}
