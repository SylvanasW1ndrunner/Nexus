import { describe, expect, it } from 'vitest';
import type { SchemaRagSnapshotCleanupResult, SchemaRagSnapshotSummary } from '@dbagent/core-rag';
import { cleanupSchemaRagSnapshotsAtStartup } from './schema-rag-startup-cleanup.js';

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
          return Promise.resolve(cleanupResult({
            kept: [availableSnapshot('active-a')],
            removed: [
              { snapshotPath: 'inactive.schema-rag.json', reason: 'inactive_connection', connectionId: 'old-connection' },
              { snapshotPath: 'invalid.schema-rag.json', reason: 'invalid_snapshot' },
            ],
          }));
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
          return Promise.resolve(cleanupResult({
            kept: [availableSnapshot('active-a'), invalidSnapshot('broken.schema-rag.json')],
            removed: [],
          }));
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
