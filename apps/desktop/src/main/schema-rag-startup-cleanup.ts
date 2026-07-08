import type {
  SchemaRagIndex,
  SchemaRagSnapshotCleanupResult,
  SchemaRagSnapshotLoadResult,
} from '@dbagent/core-rag';

type ConnectionListReader = {
  list(): Promise<Array<{ id: string }>>;
};

type SchemaRagSnapshotStoreLifecycle = {
  cleanupInactive(input: {
    activeConnectionIds: Iterable<string>;
    removeInvalid?: boolean;
  }): Promise<SchemaRagSnapshotCleanupResult>;
  loadDetailed(connectionId: string): Promise<SchemaRagSnapshotLoadResult>;
};

type SchemaRagIndexHydrator = {
  loadIndex(index: SchemaRagIndex): unknown;
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
  snapshots: SchemaRagSnapshotStoreLifecycle;
  rag: SchemaRagIndexHydrator;
  removeInvalid?: boolean;
};

export type SchemaRagStartupRecoverySummary = SchemaRagStartupCleanupSummary & {
  loadedCount: number;
  missingCount: number;
  invalidCount: number;
  errorCount: number;
  failedConnectionIds: string[];
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
  };

  for (const connection of connections) {
    const result = await loadSnapshotForConnection(options, connection.id);
    if (result.status === 'loaded') {
      recovery.loadedCount += 1;
      continue;
    }
    if (result.status === 'missing') {
      recovery.missingCount += 1;
      continue;
    }
    if (result.status === 'invalid') {
      recovery.invalidCount += 1;
      recovery.failedConnectionIds.push(connection.id);
      continue;
    }
    recovery.errorCount += 1;
    recovery.failedConnectionIds.push(connection.id);
  }

  return {
    ...cleanupSummary,
    ...recovery,
    ...(cleanupError ? { cleanupError } : {}),
  };
}

type LoadSnapshotForConnectionResult = {
  status: 'loaded' | 'missing' | 'invalid' | 'error';
};

async function loadSnapshotForConnection(
  options: Pick<SchemaRagStartupRecoveryOptions, 'snapshots' | 'rag'>,
  connectionId: string,
): Promise<LoadSnapshotForConnectionResult> {
  try {
    const result = await options.snapshots.loadDetailed(connectionId);
    if (result.status === 'loaded') {
      options.rag.loadIndex(result.index);
      return { status: 'loaded' };
    }
    if (result.status === 'missing') return { status: 'missing' };
    if (result.status === 'invalid') return { status: 'invalid' };
    return { status: 'error' };
  } catch {
    return { status: 'error' };
  }
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
