import type {
  ModelTokenUsage,
  PersistedModelSessionBundleDescriptor,
} from '@dbagent/core-llm';
import type { UsageMode } from '@dbagent/shared';
import type { PortableValue } from '@dbagent/shared';
import type { AgentCapabilityDiscoveryManifestEntry } from '../capability-types.js';
import type { PromptSection } from '../context/prompt-runtime.js';
import type { AgentEvent, AgentRunState } from '../events/agent-event.js';
import {
  AgentJournalError,
  type RunLease,
  type RunLeaseReference,
} from '../events/agent-journal.js';
import type { SqliteAgentJournal } from '../events/sqlite-agent-journal.js';
import { openKernelJournalCommitter } from '../internal/kernel-journal-authority.js';

export type EnvironmentBindingInput = Readonly<{
  environmentBindingId: string;
  settingsRevision: string;
  permissionPolicyRevision: string;
  modelSession: PersistedModelSessionBundleDescriptor;
}>;

export type TurnSnapshotInput = Readonly<{
  turnSnapshotId: string;
  capability: Readonly<{ snapshotId: string; revision: string }>;
  promptRevision: string;
  /** Exact portable prompt bytes captured for this Turn; legacy snapshots omit it. */
  runtimeProtocol?: PromptSection;
  promptSections?: readonly PromptSection[];
  tools: readonly Readonly<{ name: string; revision: string }>[];
  /** Complete immutable discoverable Tool catalog for Tool search in this Turn. */
  discoverableTools?: readonly Readonly<{ name: string; revision: string }>[];
  /** Host-only semantic Capability manifest for the sealed discovery command. */
  discoverableCapabilities?: readonly AgentCapabilityDiscoveryManifestEntry[];
  skills: readonly Readonly<{
    id: string;
    revision: string;
    allowedTools?: readonly string[];
  }>[];
  hooks?: readonly Readonly<{ id: string; revision: string }>[];
  verifiers: readonly Readonly<{ id: string; revision: string; required: boolean }>[];
}>;

export type PersistedEnvironmentBinding = Readonly<{
  schemaVersion: 1;
  environmentBindingId: string;
  projectId: string;
  sessionId: string;
  runId: string;
  digest: string;
  payload: EnvironmentBindingInput;
  createdAt: string;
}>;

export type PersistedTurnSnapshot = Readonly<{
  schemaVersion: 1;
  turnSnapshotId: string;
  projectId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  environmentBindingId: string;
  digest: string;
  payload: TurnSnapshotInput;
  createdAt: string;
}>;

export type KernelRunProjection = Readonly<{
  schemaVersion: 1;
  projectId: string;
  sessionId: string;
  runId: string;
  state: AgentRunState;
  revision: number;
  environmentBindingId: string | null;
  currentTurnId: string | null;
  turnSnapshotId: string | null;
  currentAttemptId: string | null;
  waitReason: string | null;
  evidenceRevision: number;
  evidenceDigest: string | null;
  noProgressCount: number;
  finalContentRef: string | null;
  deliveryStatus: 'not-required' | 'verified' | 'unverified' | null;
  updatedAt: string;
}>;

type KernelCommandBase = Readonly<{
  projectId: string;
  sessionId: string;
  runId: string;
  commandId: string;
  lease: RunLeaseReference;
  expectedRunRevision: number;
}>;

export type CaptureTurnKernelCommand = KernelCommandBase & Readonly<{
  action: 'capture-turn';
  turnId: string;
  environment: EnvironmentBindingInput;
  snapshot: TurnSnapshotInput;
}>;

export type CommitContextReadyKernelCommand = KernelCommandBase & Readonly<{
  action: 'commit-context-ready';
  turnId: string;
  expectedTurnRevision: number;
  contextRef?: string;
  tokenEstimate?: number;
}>;

export type CloseObservedTurnKernelCommand = KernelCommandBase & Readonly<{
  action: 'close-observed-turn';
  turnId: string;
  expectedTurnRevision: number;
}>;

export type BlockOutcomeResolutionKernelCommand = KernelCommandBase & Readonly<{
  action: 'block-outcome-resolution';
  turnId: string;
  expectedTurnRevision: number;
  requests: readonly Readonly<{ invocationId: string; summary: string }>[];
}>;

export type CompleteOutcomeResolutionKernelCommand = KernelCommandBase & Readonly<{
  action: 'complete-outcome-resolution';
  turnId: string;
}>;

export type FinalizeRunKernelCommand = KernelCommandBase & Readonly<{
  action: 'finalize-run';
  turnId: string;
  expectedTurnRevision: number;
  finalContentRef: string;
  decision: Readonly<{
    evidenceRevision: number;
    status: 'not-required' | 'verified' | 'unverified';
    outcome: 'accepted' | 'revision-requested' | 'failed';
    verifierId?: string;
    verifierRevision?: string;
    evidenceRefs: readonly string[];
    reason?: string;
    /** Bounded Model-visible semantic feedback, present only for revision-requested. */
    observation?: PortableValue;
  }>;
}>;

export type SteerRunKernelCommand = KernelCommandBase & Readonly<{
  action: 'steer-run';
  clientRequestId: string;
  input: PortableValue;
}>;

export type QueueSteeringKernelCommand = KernelCommandBase & Readonly<{
  action: 'queue-steering';
  clientRequestId: string;
  input: PortableValue;
}>;

export type ConsumeSteeringKernelCommand = KernelCommandBase & Readonly<{
  action: 'consume-steering';
  clientRequestId: string;
  input: PortableValue;
}>;

export type RequestInputKernelCommand = KernelCommandBase & Readonly<{
  action: 'request-input';
  reason: string;
  connectionId?: string;
}>;

export type ResumeRunKernelCommand = KernelCommandBase & Readonly<{
  action: 'resume-run';
  reason?: string;
}>;

export type ReachLimitKernelCommand = KernelCommandBase & Readonly<{
  action: 'reach-limit';
  limit: string;
  value?: number;
}>;

export type InterruptRunKernelCommand = KernelCommandBase & Readonly<{
  action: 'interrupt-run';
  code: string;
  detail?: PortableValue;
}>;

export type FailRunKernelCommand = KernelCommandBase & Readonly<{
  action: 'fail-run';
  code: string;
  detail?: PortableValue;
}>;

export type StartContextCompactionKernelCommand = KernelCommandBase & Readonly<{
  action: 'start-context-compaction';
  checkpointId: string;
  decisionId: string;
  reason: 'automatic' | 'manual';
  coveredSequence: number;
}>;

export type QueueContextCompactionKernelCommand = KernelCommandBase & Readonly<{
  action: 'queue-context-compaction';
  decisionId: string;
}>;

type ContextCompactionUsageReceipt =
  | Readonly<{ usage: ModelTokenUsage; billingMode: UsageMode }>
  | Readonly<{ usage?: undefined; billingMode?: undefined }>;

export type CompleteContextCompactionKernelCommand = KernelCommandBase & Readonly<{
  action: 'complete-context-compaction';
  checkpointId: string;
  decisionId: string;
  summaryRef: string;
  summary: string;
  coveredSequence: number;
  attemptId: string;
}> & ContextCompactionUsageReceipt;

export type FailContextCompactionKernelCommand = KernelCommandBase & Readonly<{
  action: 'fail-context-compaction';
  checkpointId: string;
  decisionId: string;
  code: string;
}>;

export type StartModelAttemptKernelCommand = KernelCommandBase & Readonly<{
  action: 'start-model-attempt';
  turnId: string;
  expectedTurnRevision: number;
  attemptId: string;
  origin: Readonly<{ connectionId: string; model: string; protocol: string }>;
}>;

export type DiscardModelAttemptKernelCommand = KernelCommandBase & Readonly<{
  action: 'discard-model-attempt';
  turnId: string;
  expectedTurnRevision: number;
  attemptId: string;
  reason: string;
  failure?: Readonly<{ code: string; retryable: boolean }>;
}>;

export type RequestCancelKernelCommand = KernelCommandBase & Readonly<{
  action: 'request-cancel';
  reason?: string;
}>;

export type SettleCancellationKernelCommand = KernelCommandBase & Readonly<{
  action: 'settle-cancellation';
}>;

export type RecordNoProgressKernelCommand = KernelCommandBase & Readonly<{
  action: 'record-no-progress';
  turnId: string;
  fingerprint: string;
}>;

export type KernelJournalCommand =
  | CaptureTurnKernelCommand
  | CommitContextReadyKernelCommand
  | CloseObservedTurnKernelCommand
  | BlockOutcomeResolutionKernelCommand
  | CompleteOutcomeResolutionKernelCommand
  | SteerRunKernelCommand
  | QueueSteeringKernelCommand
  | ConsumeSteeringKernelCommand
  | RequestInputKernelCommand
  | ResumeRunKernelCommand
  | ReachLimitKernelCommand
  | InterruptRunKernelCommand
  | FailRunKernelCommand
  | QueueContextCompactionKernelCommand
  | StartContextCompactionKernelCommand
  | CompleteContextCompactionKernelCommand
  | FailContextCompactionKernelCommand
  | StartModelAttemptKernelCommand
  | DiscardModelAttemptKernelCommand
  | RequestCancelKernelCommand
  | SettleCancellationKernelCommand
  | RecordNoProgressKernelCommand
  | FinalizeRunKernelCommand;

type LocalKernelJournalCommand = KernelJournalCommand extends infer Command
  ? Command extends KernelJournalCommand
    ? Omit<Command, 'projectId' | 'sessionId' | 'runId' | 'lease'>
    : never
  : never;

export type KernelJournalCommitResult = Readonly<{
  events: readonly AgentEvent[];
  run: KernelRunProjection;
  environment?: PersistedEnvironmentBinding;
  snapshot?: PersistedTurnSnapshot;
  checkpoint?: PersistedContextCheckpoint;
}>;

export type PersistedContextCheckpoint = Readonly<{
  schemaVersion: 1;
  checkpointId: string;
  projectId: string;
  sessionId: string;
  runId: string;
  decisionId: string;
  reason: 'automatic' | 'manual';
  status: 'started' | 'compacted' | 'failed';
  coveredSequence: number;
  summaryRef?: string;
  summary?: string;
  attemptId?: string;
  usage?: ModelTokenUsage;
  failureCode?: string;
  createdAt: string;
  updatedAt: string;
}>;

export type CaptureTurnInput = Readonly<{
  commandId: string;
  expectedRunRevision: number;
  turnId: string;
  environment: EnvironmentBindingInput;
  snapshot: TurnSnapshotInput;
}>;

export type RunControllerOptions = Readonly<{
  journal: SqliteAgentJournal;
  projectId: string;
  sessionId: string;
  runId: string;
  ownerId: string;
  leaseTtlMs: number;
}>;

export class RunLeaseLostError extends Error {
  readonly code = 'RUN_LEASE_LOST' as const;

  constructor(message = 'The Agent Run lease was lost.', override readonly cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'RunLeaseLostError';
  }
}

/** Owns Run lease/fence and is the only Kernel writer allowed to advance a Run. */
export class RunController {
  readonly #journal: SqliteAgentJournal;
  readonly #projectId: string;
  readonly #sessionId: string;
  readonly #runId: string;
  readonly #ownerId: string;
  readonly #leaseTtlMs: number;
  #lease: RunLease | null = null;
  #leaseAbort = new AbortController();
  #workAbort = new AbortController();
  #heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  #heartbeatRunning = false;
  #leaseFailure: RunLeaseLostError | null = null;
  #leaseGeneration = 0;
  readonly #activeWork = new Set<Promise<unknown>>();

  constructor(options: RunControllerOptions) {
    this.#journal = options.journal;
    this.#projectId = requireText(options.projectId, 'projectId');
    this.#sessionId = requireText(options.sessionId, 'sessionId');
    this.#runId = requireText(options.runId, 'runId');
    this.#ownerId = requireText(options.ownerId, 'ownerId');
    if (!Number.isSafeInteger(options.leaseTtlMs) || options.leaseTtlMs < 1) {
      throw new TypeError('leaseTtlMs must be a positive integer.');
    }
    this.#leaseTtlMs = options.leaseTtlMs;
  }

  async acquire(): Promise<RunLease> {
    this.#stopHeartbeat();
    this.#leaseGeneration += 1;
    this.#leaseAbort = new AbortController();
    this.#workAbort = new AbortController();
    this.#leaseFailure = null;
    const lease = await this.#journal.acquireRunLease({
      projectId: this.#projectId,
      runId: this.#runId,
      ownerId: this.#ownerId,
      ttlMs: this.#leaseTtlMs,
    });
    this.#lease = lease;
    this.#scheduleHeartbeat();
    return structuredClone(lease);
  }

  async renew(): Promise<RunLease> {
    return structuredClone(await this.#renewLease());
  }

  async ensureLeaseFresh(
    safetyWindowMs = Math.max(1, Math.floor(this.#leaseTtlMs / 3)),
  ): Promise<RunLease> {
    if (!Number.isSafeInteger(safetyWindowMs) || safetyWindowMs < 0) {
      throw new TypeError('safetyWindowMs must be a non-negative integer.');
    }
    while (true) {
      const lease = this.#requiredLease();
      const remainingMs = Date.parse(lease.expiresAt) - Date.now();
      if (remainingMs > safetyWindowMs) return structuredClone(lease);
      try {
        return structuredClone(await this.#renewLease());
      } catch (error) {
        const retryRemainingMs = Date.parse(lease.expiresAt) - Date.now();
        if (
          !(error instanceof AgentJournalError) || error.code !== 'JOURNAL_BUSY' ||
          retryRemainingMs <= 1
        ) {
          throw error;
        }
        await delay(Math.max(1, Math.min(
          Math.floor(this.#leaseTtlMs / 10),
          Math.floor(retryRemainingMs / 2),
        )));
      }
    }
  }

  currentLease(): RunLease {
    return structuredClone(this.#requiredLease());
  }

  signal(): AbortSignal {
    this.#assertLeaseActive();
    return this.#workAbort.signal;
  }

  /** Aborts only the in-flight Model/Tool/compaction operation; the writer lease remains valid. */
  abortWork(reason?: string): void {
    this.#assertLeaseActive();
    if (!this.#workAbort.signal.aborted) {
      this.#workAbort.abort(new RunWorkCancelledError(reason));
    }
  }

  async runWork<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.#assertLeaseActive();
    const signal = this.#workAbort.signal;
    const tracked = Promise.resolve().then(async () => await operation(signal));
    this.#activeWork.add(tracked);
    try {
      return await tracked;
    } finally {
      this.#activeWork.delete(tracked);
    }
  }

  async waitForWork(): Promise<void> {
    while (this.#activeWork.size > 0) {
      await Promise.allSettled([...this.#activeWork]);
    }
  }

  assertLeaseActive(): void {
    this.#assertLeaseActive();
  }

  async release(options: Readonly<{ waitForWork?: boolean }> = {}): Promise<boolean> {
    const lease = this.#lease;
    this.#leaseGeneration += 1;
    this.#stopHeartbeat();
    this.#lease = null;
    if (!this.#leaseAbort.signal.aborted) {
      this.#leaseAbort.abort(new RunLeaseLostError('The Agent Run lease was released.'));
    }
    if (!this.#workAbort.signal.aborted) {
      this.#workAbort.abort(new RunLeaseLostError('The Agent Run lease was released.'));
    }
    if (options.waitForWork !== false) await this.waitForWork();
    if (lease === null) return false;
    return await this.#journal.releaseRunLease({
      projectId: this.#projectId,
      runId: this.#runId,
      ownerId: lease.ownerId,
      fencingToken: lease.fencingToken,
    });
  }

  async captureTurn(input: CaptureTurnInput): Promise<Required<
    Pick<KernelJournalCommitResult, 'run' | 'environment' | 'snapshot'>
  > & Pick<KernelJournalCommitResult, 'events'>> {
    await this.ensureLeaseFresh();
    const result = await openKernelJournalCommitter(this.#journal).commit({
      action: 'capture-turn',
      projectId: this.#projectId,
      sessionId: this.#sessionId,
      runId: this.#runId,
      commandId: requireText(input.commandId, 'commandId'),
      lease: leaseReference(this.#requiredLease()),
      expectedRunRevision: input.expectedRunRevision,
      turnId: requireText(input.turnId, 'turnId'),
      environment: structuredClone(input.environment),
      snapshot: structuredClone(input.snapshot),
    });
    if (result.environment === undefined || result.snapshot === undefined) {
      throw new TypeError('Kernel Journal returned an incomplete prepare result.');
    }
    return {
      events: result.events,
      run: result.run,
      environment: result.environment,
      snapshot: result.snapshot,
    };
  }

  async commitContextReady(input: Readonly<{
    commandId: string;
    expectedRunRevision: number;
    turnId: string;
    expectedTurnRevision: number;
    contextRef?: string;
    tokenEstimate?: number;
  }>): Promise<KernelJournalCommitResult> {
    await this.ensureLeaseFresh();
    return await openKernelJournalCommitter(this.#journal).commit({
      action: 'commit-context-ready',
      projectId: this.#projectId,
      sessionId: this.#sessionId,
      runId: this.#runId,
      commandId: requireText(input.commandId, 'commandId'),
      lease: leaseReference(this.#requiredLease()),
      expectedRunRevision: input.expectedRunRevision,
      turnId: requireText(input.turnId, 'turnId'),
      expectedTurnRevision: input.expectedTurnRevision,
      ...(input.contextRef === undefined
        ? {}
        : { contextRef: requireText(input.contextRef, 'contextRef') }),
      ...(input.tokenEstimate === undefined ? {} : { tokenEstimate: input.tokenEstimate }),
    });
  }

  async closeObservedTurn(input: Readonly<{
    commandId: string;
    expectedRunRevision: number;
    turnId: string;
    expectedTurnRevision: number;
  }>): Promise<KernelJournalCommitResult> {
    return await this.#commit({
      action: 'close-observed-turn',
      commandId: requireText(input.commandId, 'commandId'),
      expectedRunRevision: input.expectedRunRevision,
      turnId: requireText(input.turnId, 'turnId'),
      expectedTurnRevision: input.expectedTurnRevision,
    });
  }

  async blockOutcomeResolution(input: Readonly<{
    commandId: string;
    expectedRunRevision: number;
    turnId: string;
    expectedTurnRevision: number;
    requests: readonly Readonly<{ invocationId: string; summary: string }>[];
  }>): Promise<KernelJournalCommitResult> {
    return await this.#commit({
      action: 'block-outcome-resolution',
      commandId: requireText(input.commandId, 'commandId'),
      expectedRunRevision: input.expectedRunRevision,
      turnId: requireText(input.turnId, 'turnId'),
      expectedTurnRevision: input.expectedTurnRevision,
      requests: input.requests.map((request) => ({
        invocationId: requireText(request.invocationId, 'requests.invocationId'),
        summary: requireText(request.summary, 'requests.summary'),
      })),
    });
  }

  async completeOutcomeResolution(input: Readonly<{
    commandId: string;
    expectedRunRevision: number;
    turnId: string;
  }>): Promise<KernelJournalCommitResult> {
    return await this.#commit({
      action: 'complete-outcome-resolution',
      commandId: requireText(input.commandId, 'commandId'),
      expectedRunRevision: input.expectedRunRevision,
      turnId: requireText(input.turnId, 'turnId'),
    });
  }

  async steer(input: Readonly<{
    commandId: string; expectedRunRevision: number; clientRequestId: string; value: PortableValue;
  }>): Promise<KernelJournalCommitResult> {
    return await this.#commit({
      action: 'steer-run', commandId: input.commandId,
      expectedRunRevision: input.expectedRunRevision,
      clientRequestId: requireText(input.clientRequestId, 'clientRequestId'),
      input: structuredClone(input.value),
    });
  }

  async queueSteering(input: Readonly<{
    commandId: string; expectedRunRevision: number; clientRequestId: string; value: PortableValue;
  }>): Promise<KernelJournalCommitResult> {
    return await this.#commit({
      action: 'queue-steering', commandId: input.commandId,
      expectedRunRevision: input.expectedRunRevision,
      clientRequestId: requireText(input.clientRequestId, 'clientRequestId'),
      input: structuredClone(input.value),
    });
  }

  async consumeSteering(input: Readonly<{
    commandId: string; expectedRunRevision: number; clientRequestId: string; value: PortableValue;
  }>): Promise<KernelJournalCommitResult> {
    return await this.#commit({
      action: 'consume-steering', commandId: input.commandId,
      expectedRunRevision: input.expectedRunRevision,
      clientRequestId: requireText(input.clientRequestId, 'clientRequestId'),
      input: structuredClone(input.value),
    });
  }

  async requestInput(input: Readonly<{
    commandId: string; expectedRunRevision: number; reason: string; connectionId?: string;
  }>): Promise<KernelJournalCommitResult> {
    return await this.#commit({
      action: 'request-input', commandId: input.commandId,
      expectedRunRevision: input.expectedRunRevision,
      reason: requireText(input.reason, 'reason'),
      ...(input.connectionId === undefined
        ? {}
        : { connectionId: requireText(input.connectionId, 'connectionId') }),
    });
  }

  async resume(input: Readonly<{
    commandId: string; expectedRunRevision: number; reason?: string;
  }>): Promise<KernelJournalCommitResult> {
    return await this.#commit({
      action: 'resume-run', commandId: input.commandId,
      expectedRunRevision: input.expectedRunRevision,
      ...(input.reason === undefined ? {} : { reason: requireText(input.reason, 'reason') }),
    });
  }

  async reachLimit(input: Readonly<{
    commandId: string; expectedRunRevision: number; limit: string; value?: number;
  }>): Promise<KernelJournalCommitResult> {
    return await this.#commit({
      action: 'reach-limit', commandId: input.commandId,
      expectedRunRevision: input.expectedRunRevision,
      limit: requireText(input.limit, 'limit'),
      ...(input.value === undefined ? {} : { value: input.value }),
    });
  }

  async interrupt(input: Readonly<{
    commandId: string; expectedRunRevision: number; code: string; detail?: PortableValue;
  }>): Promise<KernelJournalCommitResult> {
    return await this.#commit({
      action: 'interrupt-run', commandId: input.commandId,
      expectedRunRevision: input.expectedRunRevision,
      code: requireText(input.code, 'code'),
      ...(input.detail === undefined ? {} : { detail: structuredClone(input.detail) }),
    });
  }

  async fail(input: Readonly<{
    commandId: string; expectedRunRevision: number; code: string; detail?: PortableValue;
  }>): Promise<KernelJournalCommitResult> {
    return await this.#commit({
      action: 'fail-run', commandId: input.commandId,
      expectedRunRevision: input.expectedRunRevision,
      code: requireText(input.code, 'code'),
      ...(input.detail === undefined ? {} : { detail: structuredClone(input.detail) }),
    });
  }

  async startContextCompaction(input: Readonly<{
    commandId: string; expectedRunRevision: number; checkpointId: string;
    decisionId: string; reason: 'automatic' | 'manual'; coveredSequence: number;
  }>): Promise<KernelJournalCommitResult> {
    return await this.#commit({
      action: 'start-context-compaction', commandId: input.commandId,
      expectedRunRevision: input.expectedRunRevision,
      checkpointId: requireText(input.checkpointId, 'checkpointId'),
      decisionId: requireText(input.decisionId, 'decisionId'),
      reason: input.reason,
      coveredSequence: input.coveredSequence,
    });
  }

  async queueContextCompaction(input: Readonly<{
    commandId: string;
    expectedRunRevision: number;
    decisionId: string;
  }>): Promise<KernelJournalCommitResult> {
    return await this.#commit({
      action: 'queue-context-compaction',
      commandId: requireText(input.commandId, 'commandId'),
      expectedRunRevision: input.expectedRunRevision,
      decisionId: requireText(input.decisionId, 'decisionId'),
    });
  }

  async completeContextCompaction(input: Readonly<{
    commandId: string; expectedRunRevision: number; checkpointId: string;
    decisionId: string; summaryRef: string; summary: string; coveredSequence: number;
    attemptId: string;
  }> & ContextCompactionUsageReceipt): Promise<KernelJournalCommitResult> {
    return await this.#commit({
      action: 'complete-context-compaction', commandId: input.commandId,
      expectedRunRevision: input.expectedRunRevision,
      checkpointId: requireText(input.checkpointId, 'checkpointId'),
      decisionId: requireText(input.decisionId, 'decisionId'),
      summaryRef: requireText(input.summaryRef, 'summaryRef'),
      summary: requireText(input.summary, 'summary'),
      coveredSequence: input.coveredSequence,
      attemptId: requireText(input.attemptId, 'attemptId'),
      ...(input.usage === undefined
        ? {}
        : { usage: structuredClone(input.usage), billingMode: input.billingMode }),
    });
  }

  async failContextCompaction(input: Readonly<{
    commandId: string; expectedRunRevision: number; checkpointId: string;
    decisionId: string; code: string;
  }>): Promise<KernelJournalCommitResult> {
    return await this.#commit({
      action: 'fail-context-compaction', commandId: input.commandId,
      expectedRunRevision: input.expectedRunRevision,
      checkpointId: requireText(input.checkpointId, 'checkpointId'),
      decisionId: requireText(input.decisionId, 'decisionId'),
      code: requireText(input.code, 'code'),
    });
  }

  async startModelAttempt(input: Readonly<{
    commandId: string;
    expectedRunRevision: number;
    turnId: string;
    expectedTurnRevision: number;
    attemptId: string;
    origin: Readonly<{ connectionId: string; model: string; protocol: string }>;
  }>): Promise<KernelJournalCommitResult> {
    await this.ensureLeaseFresh();
    return await openKernelJournalCommitter(this.#journal).commit({
      action: 'start-model-attempt',
      projectId: this.#projectId,
      sessionId: this.#sessionId,
      runId: this.#runId,
      commandId: requireText(input.commandId, 'commandId'),
      lease: leaseReference(this.#requiredLease()),
      expectedRunRevision: input.expectedRunRevision,
      turnId: requireText(input.turnId, 'turnId'),
      expectedTurnRevision: input.expectedTurnRevision,
      attemptId: requireText(input.attemptId, 'attemptId'),
      origin: structuredClone(input.origin),
    });
  }

  async discardModelAttempt(input: Readonly<{
    commandId: string; expectedRunRevision: number; turnId: string;
    expectedTurnRevision: number; attemptId: string; reason: string;
    failure?: Readonly<{ code: string; retryable: boolean }>;
  }>): Promise<KernelJournalCommitResult> {
    await this.ensureLeaseFresh();
    return await openKernelJournalCommitter(this.#journal).commit({
      action: 'discard-model-attempt', projectId: this.#projectId,
      sessionId: this.#sessionId, runId: this.#runId,
      commandId: requireText(input.commandId, 'commandId'),
      lease: leaseReference(this.#requiredLease()),
      expectedRunRevision: input.expectedRunRevision,
      turnId: requireText(input.turnId, 'turnId'),
      expectedTurnRevision: input.expectedTurnRevision,
      attemptId: requireText(input.attemptId, 'attemptId'),
      reason: requireText(input.reason, 'reason'),
      ...(input.failure === undefined ? {} : { failure: structuredClone(input.failure) }),
    });
  }

  async requestCancel(input: Readonly<{
    commandId: string;
    expectedRunRevision: number;
    reason?: string;
  }>): Promise<KernelJournalCommitResult> {
    await this.ensureLeaseFresh();
    return await openKernelJournalCommitter(this.#journal).commit({
      action: 'request-cancel', projectId: this.#projectId,
      sessionId: this.#sessionId, runId: this.#runId,
      commandId: requireText(input.commandId, 'commandId'),
      lease: leaseReference(this.#requiredLease()),
      expectedRunRevision: input.expectedRunRevision,
      ...(input.reason === undefined ? {} : { reason: requireText(input.reason, 'reason') }),
    });
  }

  async settleCancellation(input: Readonly<{
    commandId: string;
    expectedRunRevision: number;
  }>): Promise<KernelJournalCommitResult> {
    await this.ensureLeaseFresh();
    return await openKernelJournalCommitter(this.#journal).commit({
      action: 'settle-cancellation', projectId: this.#projectId,
      sessionId: this.#sessionId, runId: this.#runId,
      commandId: requireText(input.commandId, 'commandId'),
      lease: leaseReference(this.#requiredLease()),
      expectedRunRevision: input.expectedRunRevision,
    });
  }

  async recordNoProgress(input: Readonly<{
    commandId: string;
    expectedRunRevision: number;
    turnId: string;
    fingerprint: string;
  }>): Promise<KernelJournalCommitResult> {
    await this.ensureLeaseFresh();
    return await openKernelJournalCommitter(this.#journal).commit({
      action: 'record-no-progress', projectId: this.#projectId,
      sessionId: this.#sessionId, runId: this.#runId,
      commandId: requireText(input.commandId, 'commandId'),
      lease: leaseReference(this.#requiredLease()),
      expectedRunRevision: input.expectedRunRevision,
      turnId: requireText(input.turnId, 'turnId'),
      fingerprint: requireText(input.fingerprint, 'fingerprint'),
    });
  }

  async finalize(input: Readonly<{
    commandId: string;
    expectedRunRevision: number;
    turnId: string;
    expectedTurnRevision: number;
    finalContentRef: string;
    decision: FinalizeRunKernelCommand['decision'];
  }>): Promise<KernelJournalCommitResult> {
    await this.ensureLeaseFresh();
    return await openKernelJournalCommitter(this.#journal).commit({
      action: 'finalize-run',
      projectId: this.#projectId,
      sessionId: this.#sessionId,
      runId: this.#runId,
      commandId: requireText(input.commandId, 'commandId'),
      lease: leaseReference(this.#requiredLease()),
      expectedRunRevision: input.expectedRunRevision,
      turnId: requireText(input.turnId, 'turnId'),
      expectedTurnRevision: input.expectedTurnRevision,
      finalContentRef: requireText(input.finalContentRef, 'finalContentRef'),
      decision: structuredClone(input.decision),
    });
  }

  async #commit(command: LocalKernelJournalCommand): Promise<KernelJournalCommitResult> {
    await this.ensureLeaseFresh();
    const scoped: KernelJournalCommand = {
      ...command,
      projectId: this.#projectId,
      sessionId: this.#sessionId,
      runId: this.#runId,
      lease: leaseReference(this.#requiredLease()),
    };
    return await openKernelJournalCommitter(this.#journal).commit(scoped);
  }

  #requiredLease(): RunLease {
    this.#assertLeaseActive();
    if (this.#lease === null) throw new TypeError('RunController must acquire a lease first.');
    return this.#lease;
  }

  #assertLeaseActive(): void {
    if (this.#leaseFailure !== null) throw this.#leaseFailure;
  }

  #scheduleHeartbeat(delayOverrideMs?: number): void {
    if (this.#lease === null || this.#leaseFailure !== null || this.#heartbeatTimer !== undefined) {
      return;
    }
    const delayMs = delayOverrideMs ?? Math.max(1, Math.floor(this.#leaseTtlMs / 3));
    this.#heartbeatTimer = setTimeout(() => {
      this.#heartbeatTimer = undefined;
      void this.#heartbeat();
    }, delayMs);
    this.#heartbeatTimer.unref?.();
  }

  async #heartbeat(): Promise<void> {
    if (this.#heartbeatRunning || this.#lease === null || this.#leaseFailure !== null) return;
    this.#heartbeatRunning = true;
    try {
      await this.#renewLease();
    } catch (error) {
      if (this.#lease === null) return;
      const remainingMs = this.#lease === null
        ? 0
        : Date.parse(this.#lease.expiresAt) - Date.now();
      if (
        error instanceof AgentJournalError && error.code === 'JOURNAL_BUSY' &&
        remainingMs > 1
      ) {
        this.#heartbeatRunning = false;
        this.#scheduleHeartbeat(Math.max(1, Math.min(
          Math.floor(this.#leaseTtlMs / 10),
          Math.floor(remainingMs / 2),
        )));
        return;
      }
      const failure = error instanceof RunLeaseLostError
        ? error
        : new RunLeaseLostError('The Agent Run lease heartbeat failed.', error);
      this.#leaseFailure = failure;
      this.#abortForLeaseFailure(failure);
    } finally {
      this.#heartbeatRunning = false;
      this.#scheduleHeartbeat();
    }
  }

  async #renewLease(): Promise<RunLease> {
    const current = this.#requiredLease();
    const generation = this.#leaseGeneration;
    let lease: RunLease;
    try {
      lease = await this.#journal.renewRunLease({
        projectId: this.#projectId,
        runId: this.#runId,
        ownerId: this.#ownerId,
        ttlMs: this.#leaseTtlMs,
        fencingToken: current.fencingToken,
      });
    } catch (error) {
      if (error instanceof AgentJournalError && error.code === 'JOURNAL_BUSY') throw error;
      const failure = error instanceof RunLeaseLostError
        ? error
        : new RunLeaseLostError('The Agent Run lease could not be renewed.', error);
      this.#leaseFailure = failure;
      this.#abortForLeaseFailure(failure);
      throw failure;
    }
    if (generation !== this.#leaseGeneration || this.#lease === null) {
      throw new RunLeaseLostError('The Agent Run lease was released while renewal was in flight.');
    }
    if (
      lease.ownerId !== current.ownerId || lease.fencingToken !== current.fencingToken ||
      lease.projectId !== current.projectId || lease.runId !== current.runId
    ) {
      const failure = new RunLeaseLostError('The renewed Agent Run lease changed identity.');
      this.#leaseFailure = failure;
      this.#abortForLeaseFailure(failure);
      throw failure;
    }
    this.#lease = lease;
    return lease;
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatTimer !== undefined) clearTimeout(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
  }

  #abortForLeaseFailure(failure: RunLeaseLostError): void {
    if (!this.#leaseAbort.signal.aborted) this.#leaseAbort.abort(failure);
    if (!this.#workAbort.signal.aborted) this.#workAbort.abort(failure);
  }
}

export class RunWorkCancelledError extends Error {
  readonly code = 'RUN_WORK_CANCELLED' as const;

  constructor(reason?: string) {
    super(reason?.trim() === '' || reason === undefined ? 'The Agent Run work was cancelled.' : reason);
    this.name = 'RunWorkCancelledError';
  }
}

function leaseReference(lease: RunLease): RunLeaseReference {
  return { ownerId: lease.ownerId, fencingToken: lease.fencingToken };
}

function requireText(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} is required.`);
  return value;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
