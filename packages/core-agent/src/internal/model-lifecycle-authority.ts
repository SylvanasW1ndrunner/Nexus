import type { AgentJournal, RunLeaseReference } from '../events/agent-journal.js';
import type { AgentEvent } from '../events/agent-event.js';
import type {
  DecodedModelContentBlock,
  ModelAttemptLifecycleEvent,
  ModelTokenUsage,
} from '@dbagent/core-llm';
import type { UsageMode } from '@dbagent/shared';

export type DurableModelLifecycleFact =
  | Readonly<{
      type: 'model-delta-batch';
      attemptId: string;
      routeId: string;
      batchOrdinal: number;
      idempotencyKey: string;
      events: readonly Extract<ModelAttemptLifecycleEvent, { type: 'decoded-delta' }>[];
    }>
  | Readonly<{
      type: 'block-completed';
      attemptId: string;
      routeId: string;
      blockOrdinal: number;
      block: DecodedModelContentBlock;
      occurredAt: number;
    }>
  | Readonly<{
      type: 'usage-observed';
      attemptId: string;
      routeId: string;
      purpose: 'agent-turn' | 'context-compaction';
      usage: ModelTokenUsage;
      occurredAt: number;
    }>;

type ModelLifecycleJournalCommandBase = Readonly<{
  schemaVersion: 1;
  projectId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  attemptId: string;
  commandId: string;
  lease: RunLeaseReference;
  expectedRunRevision: number;
}>;

type ModelLifecycleDeltaFact = Readonly<{
  type: 'model-delta-batch';
  attemptId: string;
  routeId: string;
  batchOrdinal: number;
  idempotencyKey: string;
  events: readonly Extract<ModelAttemptLifecycleEvent, { type: 'decoded-delta' }>[];
}>;

type ModelLifecycleBlockFact = Readonly<{
  type: 'block-completed';
  attemptId: string;
  routeId: string;
  blockOrdinal: number;
  block: DecodedModelContentBlock;
  occurredAt: number;
}>;

type ModelLifecycleUsageFact = Readonly<{
  type: 'usage-observed';
  attemptId: string;
  routeId: string;
  purpose: 'agent-turn' | 'context-compaction';
  billingMode: UsageMode;
  usage: ModelTokenUsage;
  occurredAt: number;
}>;

export type ModelLifecycleJournalCommand =
  | (ModelLifecycleJournalCommandBase & Readonly<{ fact: ModelLifecycleDeltaFact }>)
  | (ModelLifecycleJournalCommandBase & Readonly<{ fact: ModelLifecycleBlockFact }>)
  | (ModelLifecycleJournalCommandBase & Readonly<{
      fact: ModelLifecycleUsageFact & Readonly<{
        purpose: 'agent-turn';
      }>;
    }>);

export type ContextUsageJournalCommand = ModelLifecycleJournalCommandBase & Readonly<{
  checkpointId: string;
  decisionId: string;
  fact: ModelLifecycleUsageFact & Readonly<{
    purpose: 'context-compaction';
  }>;
}>;

export type DurableModelLifecycleJournalCommand =
  | ModelLifecycleJournalCommand
  | ContextUsageJournalCommand;

export type AgentModelLifecycleJournalCommand = ModelLifecycleJournalCommand;
export type DurableModelLifecycleJournalFact = DurableModelLifecycleJournalCommand['fact'];

export type ModelLifecycleJournalResult = Readonly<{
  events: readonly AgentEvent[];
  runRevision: number;
}>;

export type ModelLifecycleJournalApplication = Readonly<{
  commit(command: DurableModelLifecycleJournalCommand): Promise<ModelLifecycleJournalResult>;
}>;

const applications = new WeakMap<
  object,
  (command: DurableModelLifecycleJournalCommand) => Promise<ModelLifecycleJournalResult>
>();

/** Package-internal binding: Model diagnostics never pass through public Journal.commit(). */
export function bindModelLifecycleJournalApplication(
  journal: AgentJournal,
  committer: (
    command: DurableModelLifecycleJournalCommand,
  ) => Promise<ModelLifecycleJournalResult>,
): void {
  if (applications.has(journal)) {
    throw new Error('Model lifecycle Journal application is already bound.');
  }
  applications.set(journal, committer);
}

export function openModelLifecycleJournalApplication(
  journal: AgentJournal,
): ModelLifecycleJournalApplication {
  const commit = applications.get(journal);
  if (commit === undefined) {
    throw new Error('Journal has no sealed Model lifecycle application.');
  }
  return Object.freeze({
    async commit(
      command: DurableModelLifecycleJournalCommand,
    ): Promise<ModelLifecycleJournalResult> {
      return await commit(command);
    },
  });
}
