import type { SchemaRagEngine } from './schema-rag-engine.js';
import type { SchemaRagSnapshotStore } from './schema-rag-snapshot-store.js';
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
    const startedAt = new Date().toISOString();
    const stages = buildInitialStages(input.tables.length, options.hotTableLimit, startedAt);
    this.setStatus(input.connectionId, 'skeleton', false, stages, startedAt);

    try {
      completeStage(stages, 'skeleton', input.tables.length, startedAt);
      completeStage(stages, 'hot_tables', Math.min(input.tables.length, options.hotTableLimit ?? 50), startedAt);
      completeStage(stages, 'long_tail', Math.max(0, input.tables.length - (options.hotTableLimit ?? 50)), startedAt);

      const index = this.engine.index(input);
      if (this.snapshotStore) {
        await this.snapshotStore.save(index);
      }

      const status = buildStatus(index, 'ready', true, stages, new Date().toISOString());
      this.statuses.set(input.connectionId, status);
      return { index, status };
    } catch (error) {
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

function buildFailedRestoreStatus(connectionId: string, updatedAt: string, error: string): SchemaRagIndexStatus {
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

function buildInitialStages(tableCount: number, hotTableLimit: number | undefined, startedAt: string): SchemaRagIndexStageStatus[] {
  const hotCount = Math.min(tableCount, hotTableLimit ?? 50);
  const longTailCount = Math.max(0, tableCount - hotCount);
  return [
    { stage: 'skeleton', state: 'running', done: 0, total: tableCount, startedAt },
    { stage: 'hot_tables', state: 'pending', done: 0, total: hotCount },
    { stage: 'long_tail', state: 'pending', done: 0, total: longTailCount },
    { stage: 'ready', state: 'pending', done: 0, total: 1 },
  ];
}

function completeStage(stages: SchemaRagIndexStageStatus[], stage: SchemaRagIndexStage, done: number, startedAt: string): void {
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
