import type { SchemaRagSnapshotCleanupResult } from '@dbagent/core-rag';

type ConnectionListReader = {
  list(): Promise<Array<{ id: string }>>;
};

type SchemaRagSnapshotCleaner = {
  cleanupInactive(input: {
    activeConnectionIds: Iterable<string>;
    removeInvalid?: boolean;
  }): Promise<SchemaRagSnapshotCleanupResult>;
};

export type SchemaRagStartupCleanupOptions = {
  connections: ConnectionListReader;
  snapshots: SchemaRagSnapshotCleaner;
  removeInvalid?: boolean;
};

export type SchemaRagStartupCleanupSummary = {
  activeConnectionCount: number;
  keptCount: number;
  invalidKeptCount: number;
  removedCount: number;
  removedInactiveCount: number;
  removedInvalidCount: number;
};

export async function cleanupSchemaRagSnapshotsAtStartup(
  options: SchemaRagStartupCleanupOptions,
): Promise<SchemaRagStartupCleanupSummary> {
  const connections = await options.connections.list();
  const activeConnectionIds = connections.map((connection) => connection.id);
  const cleanup = await options.snapshots.cleanupInactive({
    activeConnectionIds,
    removeInvalid: options.removeInvalid ?? true,
  });

  return summarizeCleanup(connections.length, cleanup);
}

function summarizeCleanup(
  activeConnectionCount: number,
  cleanup: SchemaRagSnapshotCleanupResult,
): SchemaRagStartupCleanupSummary {
  return {
    activeConnectionCount,
    keptCount: cleanup.kept.length,
    invalidKeptCount: cleanup.kept.filter((summary) => summary.status === 'invalid').length,
    removedCount: cleanup.removed.length,
    removedInactiveCount: cleanup.removed.filter((summary) => summary.reason === 'inactive_connection').length,
    removedInvalidCount: cleanup.removed.filter((summary) => summary.reason === 'invalid_snapshot').length,
  };
}
