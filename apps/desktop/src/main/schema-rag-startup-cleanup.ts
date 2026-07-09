import type { SchemaRagRestoreAllResult, SchemaRagSnapshotCleanupResult } from '@dbagent/core-rag';

type ConnectionListReader = {
  list(): Promise<Array<{ id: string }>>;
};

type SchemaRagSnapshotStoreLifecycle = {
  cleanupInactive(input: {
    activeConnectionIds: Iterable<string>;
    removeInvalid?: boolean;
  }): Promise<SchemaRagSnapshotCleanupResult>;
};

type SchemaRagStartupRestorer = {
  restoreAll(input?: { connectionIds?: Iterable<string> }): Promise<SchemaRagRestoreAllResult>;
};

export type SchemaRagStartupCleanupOptions = {
  connections: ConnectionListReader;
  snapshots: Pick<SchemaRagSnapshotStoreLifecycle, 'cleanupInactive'>;
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

export type SchemaRagStartupRecoveryOptions = {
  connections: ConnectionListReader;
  snapshots: Pick<SchemaRagSnapshotStoreLifecycle, 'cleanupInactive'>;
  indexer: SchemaRagStartupRestorer;
  removeInvalid?: boolean;
};

export type SchemaRagStartupRecoverySummary = SchemaRagStartupCleanupSummary & {
  loadedCount: number;
  missingCount: number;
  invalidCount: number;
  errorCount: number;
  failedConnectionIds: string[];
  restoredConnectionIds: string[];
  invalidSnapshotPaths: string[];
  cleanupError?: string;
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

export async function recoverSchemaRagSnapshotsAtStartup(
  options: SchemaRagStartupRecoveryOptions,
): Promise<SchemaRagStartupRecoverySummary> {
  const connections = await options.connections.list();
  const activeConnectionIds = connections.map((connection) => connection.id);
  let cleanupSummary: SchemaRagStartupCleanupSummary = emptyCleanupSummary(connections.length);
  let cleanupError: string | undefined;

  try {
    const cleanup = await options.snapshots.cleanupInactive({
      activeConnectionIds,
      removeInvalid: options.removeInvalid ?? true,
    });
    cleanupSummary = summarizeCleanup(connections.length, cleanup);
  } catch (error) {
    cleanupError = errorMessage(error);
  }

  const recovery = {
    loadedCount: 0,
    missingCount: 0,
    invalidCount: 0,
    errorCount: 0,
    failedConnectionIds: [] as string[],
    restoredConnectionIds: [] as string[],
    invalidSnapshotPaths: [] as string[],
  };

  try {
    const restoreAll = await options.indexer.restoreAll({ connectionIds: activeConnectionIds });
    recovery.loadedCount = restoreAll.restored.length;
    recovery.restoredConnectionIds = restoreAll.restored
      .map((status) => status.connectionId)
      .sort();
    recovery.invalidCount = restoreAll.invalidSnapshots.length;
    recovery.invalidSnapshotPaths = restoreAll.invalidSnapshots
      .map((snapshot) => snapshot.snapshotPath)
      .sort();
    recovery.errorCount = restoreAll.failed.length;
    recovery.failedConnectionIds = restoreAll.failed
      .map((failure) => failure.connectionId)
      .filter((connectionId): connectionId is string => connectionId !== undefined)
      .sort();
    recovery.missingCount = countMissingConnections(activeConnectionIds, restoreAll);
  } catch (error) {
    recovery.errorCount = activeConnectionIds.length || 1;
    recovery.failedConnectionIds = activeConnectionIds;
    if (!cleanupError) cleanupError = errorMessage(error);
  }

  return {
    ...cleanupSummary,
    ...recovery,
    ...(cleanupError ? { cleanupError } : {}),
  };
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
    removedInactiveCount: cleanup.removed.filter(
      (summary) => summary.reason === 'inactive_connection',
    ).length,
    removedInvalidCount: cleanup.removed.filter((summary) => summary.reason === 'invalid_snapshot')
      .length,
  };
}

function countMissingConnections(
  activeConnectionIds: string[],
  restoreAll: SchemaRagRestoreAllResult,
): number {
  const knownConnectionIds = new Set<string>();
  for (const status of restoreAll.restored) knownConnectionIds.add(status.connectionId);
  for (const failure of restoreAll.failed) {
    if (failure.connectionId) knownConnectionIds.add(failure.connectionId);
  }
  return activeConnectionIds.filter((connectionId) => !knownConnectionIds.has(connectionId)).length;
}

function emptyCleanupSummary(activeConnectionCount: number): SchemaRagStartupCleanupSummary {
  return {
    activeConnectionCount,
    keptCount: 0,
    invalidKeptCount: 0,
    removedCount: 0,
    removedInactiveCount: 0,
    removedInvalidCount: 0,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
