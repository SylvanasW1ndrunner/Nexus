import type { SchemaRagEngine } from './schema-rag-engine.js';
import type {
  SchemaRagSnapshotStore,
  SchemaRagSnapshotSummary,
} from './schema-rag-snapshot-store.js';
import type {
  SchemaRagIndex,
  SchemaRagIndexInput,
  SchemaRagIndexStage,
  SchemaRagIndexStageStatus,
  SchemaRagIndexStatus,
  SchemaRagProgressiveIndexOptions,
} from './types.js';

export type ProgressiveSchemaRagIndexerOptions = {
  engine: SchemaRagEngine;
  snapshotStore?: SchemaRagSnapshotStore;
};

export type ProgressiveSchemaRagIndexResult = {
  index: SchemaRagIndex;
  status: SchemaRagIndexStatus;
};

export type SchemaRagRestoreAllResult = {
  restored: SchemaRagIndexStatus[];
  invalidSnapshots: Array<{
    snapshotPath: string;
    reason: string;
  }>;
  failed: Array<{
    connectionId?: string;
    snapshotPath?: string;
    error: string;
  }>;
};

export class ProgressiveSchemaRagIndexer {
  private readonly engine: SchemaRagEngine;
  private readonly snapshotStore: SchemaRagSnapshotStore | undefined;
  private readonly statuses = new Map<string, SchemaRagIndexStatus>();

  constructor(options: ProgressiveSchemaRagIndexerOptions) {
    this.engine = options.engine;
    this.snapshotStore = options.snapshotStore;
  }

  async index(
    input: SchemaRagIndexInput,
    options: SchemaRagProgressiveIndexOptions = {},
  ): Promise<ProgressiveSchemaRagIndexResult> {
    return await this.runIndex(input, options, () => Promise.resolve(this.engine.index(input)));
  }

  async indexAsync(
    input: SchemaRagIndexInput,
    options: SchemaRagProgressiveIndexOptions = {},
  ): Promise<ProgressiveSchemaRagIndexResult> {
    return await this.runIndex(input, options, () => this.engine.indexAsync(input));
  }

  private async runIndex(
    input: SchemaRagIndexInput,
    options: SchemaRagProgressiveIndexOptions,
    buildIndex: () => Promise<SchemaRagIndex>,
  ): Promise<ProgressiveSchemaRagIndexResult> {
    const checkpoint = this.engine.createCheckpoint(input.connectionId);
    const startedAt = new Date().toISOString();
    const tableCount = input.tables?.length ?? 0;
    const stages = buildInitialStages(tableCount, options.hotTableLimit, startedAt);
    this.setStatus(input.connectionId, 'skeleton', false, stages, startedAt);

    try {
      completeStage(stages, 'skeleton', tableCount, startedAt);
      completeStage(
        stages,
        'hot_tables',
        Math.min(tableCount, options.hotTableLimit ?? 50),
        startedAt,
      );
      completeStage(
        stages,
        'long_tail',
        Math.max(0, tableCount - (options.hotTableLimit ?? 50)),
        startedAt,
      );

      const index = await buildIndex();
      if (this.snapshotStore) {
        await this.snapshotStore.save(index);
      }

      const status = buildStatus(index, 'ready', true, stages, new Date().toISOString());
      this.statuses.set(input.connectionId, status);
      return { index, status };
    } catch (error) {
      this.engine.restoreCheckpoint(checkpoint);
      const failedAt = new Date().toISOString();
      const message = error instanceof Error ? error.message : String(error);
      const failedStages = stages.map((stage) =>
        stage.state === 'running' || stage.state === 'pending'
          ? { ...stage, state: 'failed' as const, completedAt: failedAt, error: message }
          : stage,
      );
      this.setStatus(input.connectionId, 'failed', false, failedStages, failedAt);
      throw error;
    }
  }

  async upsertTables(input: SchemaRagIndexInput): Promise<ProgressiveSchemaRagIndexResult> {
    const checkpoint = this.engine.createCheckpoint(input.connectionId);
    try {
      const index = await this.engine.upsertTablesAsync(input);
      if (this.snapshotStore) {
        await this.snapshotStore.save(index);
      }
      const status = buildStatus(
        index,
        'ready',
        true,
        buildUpsertStages(input.tables?.length ?? 0),
        new Date().toISOString(),
      );
      this.statuses.set(input.connectionId, status);
      return { index, status };
    } catch (error) {
      this.engine.restoreCheckpoint(checkpoint);
      const failedAt = new Date().toISOString();
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus(
        input.connectionId,
        'failed',
        false,
        [
          {
            stage: 'failed',
            state: 'failed',
            done: 0,
            total: 1,
            completedAt: failedAt,
            error: message,
          },
        ],
        failedAt,
      );
      throw error;
    }
  }

  async restore(connectionId: string): Promise<SchemaRagIndexStatus | undefined> {
    if (!this.snapshotStore) return undefined;
    const restoredAt = new Date().toISOString();
    const result = await this.snapshotStore.loadDetailed(connectionId);
    if (result.status === 'missing') return undefined;
    if (result.status === 'invalid') {
      const status = buildFailedRestoreStatus(connectionId, restoredAt, result.reason);
      this.statuses.set(connectionId, status);
      return status;
    }
    if (result.status === 'error') {
      const message = result.error instanceof Error ? result.error.message : String(result.error);
      const status = buildFailedRestoreStatus(connectionId, restoredAt, message);
      this.statuses.set(connectionId, status);
      return status;
    }

    try {
      this.engine.loadIndex(result.index);
      const status = this.engine.getIndexStatus(connectionId);
      this.statuses.set(connectionId, status);
      return status;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = buildFailedRestoreStatus(connectionId, restoredAt, message);
      this.statuses.set(connectionId, status);
      return status;
    }
  }

  async restoreAll(
    options: { connectionIds?: Iterable<string> } = {},
  ): Promise<SchemaRagRestoreAllResult> {
    if (!this.snapshotStore) return { restored: [], invalidSnapshots: [], failed: [] };
    const allowedConnectionIds =
      options.connectionIds === undefined ? undefined : new Set([...options.connectionIds]);
    const result: SchemaRagRestoreAllResult = {
      restored: [],
      invalidSnapshots: [],
      failed: [],
    };

    let summaries: SchemaRagSnapshotSummary[];
    try {
      summaries = await this.snapshotStore.list();
    } catch (error) {
      return {
        restored: [],
        invalidSnapshots: [],
        failed: [{ error: error instanceof Error ? error.message : String(error) }],
      };
    }

    for (const summary of summaries) {
      if (summary.status === 'invalid') {
        result.invalidSnapshots.push({
          snapshotPath: summary.snapshotPath,
          reason: summary.reason,
        });
        continue;
      }
      if (allowedConnectionIds && !allowedConnectionIds.has(summary.connectionId)) continue;
      try {
        const status = await this.restore(summary.connectionId);
        if (status) result.restored.push(status);
      } catch (error) {
        result.failed.push({
          connectionId: summary.connectionId,
          snapshotPath: summary.snapshotPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return result;
  }

  getStatus(connectionId: string): SchemaRagIndexStatus {
    return this.statuses.get(connectionId) ?? this.engine.getIndexStatus(connectionId);
  }

  private setStatus(
    connectionId: string,
    stage: SchemaRagIndexStage,
    ready: boolean,
    stages: SchemaRagIndexStageStatus[],
    updatedAt: string,
  ): void {
    this.statuses.set(connectionId, {
      connectionId,
      stage,
      ready,
      documentCount: 0,
      tableCount: 0,
      columnCount: 0,
      relationCount: 0,
      glossaryCount: 0,
      updatedAt,
      stages,
    });
  }
}

function buildFailedRestoreStatus(
  connectionId: string,
  updatedAt: string,
  error: string,
): SchemaRagIndexStatus {
  return {
    connectionId,
    stage: 'failed',
    ready: false,
    documentCount: 0,
    tableCount: 0,
    columnCount: 0,
    relationCount: 0,
    glossaryCount: 0,
    updatedAt,
    stages: [
      {
        stage: 'failed',
        state: 'failed',
        done: 0,
        total: 1,
        completedAt: updatedAt,
        error,
      },
    ],
  };
}

function buildInitialStages(
  tableCount: number,
  hotTableLimit: number | undefined,
  startedAt: string,
): SchemaRagIndexStageStatus[] {
  const hotCount = Math.min(tableCount, hotTableLimit ?? 50);
  const longTailCount = Math.max(0, tableCount - hotCount);
  return [
    { stage: 'skeleton', state: 'running', done: 0, total: tableCount, startedAt },
    { stage: 'hot_tables', state: 'pending', done: 0, total: hotCount },
    { stage: 'long_tail', state: 'pending', done: 0, total: longTailCount },
    { stage: 'ready', state: 'pending', done: 0, total: 1 },
  ];
}

function buildUpsertStages(tableCount: number): SchemaRagIndexStageStatus[] {
  const completedAt = new Date().toISOString();
  return [
    {
      stage: 'ready',
      state: 'completed',
      done: tableCount,
      total: tableCount,
      startedAt: completedAt,
      completedAt,
    },
  ];
}

function completeStage(
  stages: SchemaRagIndexStageStatus[],
  stage: SchemaRagIndexStage,
  done: number,
  startedAt: string,
): void {
  const target = stages.find((candidate) => candidate.stage === stage);
  if (!target) return;
  const completedAt = new Date().toISOString();
  target.state = 'completed';
  target.done = done;
  target.total = done;
  target.startedAt ??= startedAt;
  target.completedAt = completedAt;
  const next = stages[stages.indexOf(target) + 1];
  if (next && next.state === 'pending') {
    next.state = 'running';
    next.startedAt = completedAt;
  }
}

function buildStatus(
  index: SchemaRagIndex,
  stage: SchemaRagIndexStage,
  ready: boolean,
  stages: SchemaRagIndexStageStatus[],
  updatedAt: string,
): SchemaRagIndexStatus {
  const tableCount = index.documents.filter((document) => document.kind === 'table').length;
  const columnCount = index.documents.filter((document) => document.kind === 'column').length;
  const relationCount = index.documents.filter((document) => document.kind === 'relation').length;
  const finalStages = stages.map((item) =>
    item.stage === 'ready'
      ? { ...item, state: 'completed' as const, done: 1, total: 1, completedAt: updatedAt }
      : item,
  );
  return {
    connectionId: index.connectionId,
    stage,
    ready,
    documentCount: index.documents.length,
    tableCount,
    columnCount,
    relationCount,
    glossaryCount: index.glossary.length,
    indexedAt: index.indexedAt,
    updatedAt,
    stages: finalStages,
  };
}
