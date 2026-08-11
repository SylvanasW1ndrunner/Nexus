import type { PortableValue } from '@dbagent/shared';
import type { AgentEvent, AgentRunState } from '../events/agent-event.js';
import type { RunLease, RunLeaseReference } from '../events/agent-journal.js';
import type { SqliteAgentJournal } from '../events/sqlite-agent-journal.js';
import { openKernelJournalCommitter } from '../internal/kernel-journal-authority.js';

export type ModelRouteCandidateSnapshot = Readonly<{
  connectionId: string;
  modelId: string;
  protocol: string;
  codecRevision: string;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  generation: Readonly<Record<string, PortableValue>>;
}>;

export type EnvironmentBindingInput = Readonly<{
  environmentBindingId: string;
  settingsRevision: string;
  permissionPolicyRevision: string;
  modelRoute: Readonly<{
    routeRevision: string;
    primary: ModelRouteCandidateSnapshot;
    fallbacks: readonly ModelRouteCandidateSnapshot[];
  }>;
}>;

export type TurnSnapshotInput = Readonly<{
  turnSnapshotId: string;
  capability: Readonly<{ snapshotId: string; revision: string }>;
  promptRevision: string;
  tools: readonly Readonly<{ name: string; revision: string }>[];
  skills: readonly Readonly<{ id: string; revision: string }>[];
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

export type PrepareTurnKernelCommand = KernelCommandBase & Readonly<{
  action: 'prepare-turn';
  turnId: string;
  resume: boolean;
  environment: EnvironmentBindingInput;
  snapshot: TurnSnapshotInput;
}>;

export type FinalizeRunKernelCommand = KernelCommandBase & Readonly<{
  action: 'finalize-run';
  turnId: string;
  expectedTurnRevision: number;
  finalContentRef: string;
  decision: Readonly<{
    evidenceRevision: number;
    status: 'not-required' | 'verified' | 'unverified';
    outcome: 'accepted' | 'failed';
    verifierId?: string;
    verifierRevision?: string;
    evidenceRefs: readonly string[];
    reason?: string;
  }>;
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
  fingerprint: string;
}>;

export type KernelJournalCommand =
  | PrepareTurnKernelCommand
  | StartModelAttemptKernelCommand
  | DiscardModelAttemptKernelCommand
  | RequestCancelKernelCommand
  | SettleCancellationKernelCommand
  | RecordNoProgressKernelCommand
  | FinalizeRunKernelCommand;

export type KernelJournalCommitResult = Readonly<{
  events: readonly AgentEvent[];
  run: KernelRunProjection;
  environment?: PersistedEnvironmentBinding;
  snapshot?: PersistedTurnSnapshot;
}>;

export type PrepareTurnInput = Readonly<{
  commandId: string;
  expectedRunRevision: number;
  turnId: string;
  resume?: boolean;
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

/** Owns Run lease/fence and is the only Kernel writer allowed to advance a Run. */
export class RunController {
  readonly #journal: SqliteAgentJournal;
  readonly #projectId: string;
  readonly #sessionId: string;
  readonly #runId: string;
  readonly #ownerId: string;
  readonly #leaseTtlMs: number;
  #lease: RunLease | null = null;

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
    const lease = await this.#journal.acquireRunLease({
      projectId: this.#projectId,
      runId: this.#runId,
      ownerId: this.#ownerId,
      ttlMs: this.#leaseTtlMs,
    });
    this.#lease = lease;
    return structuredClone(lease);
  }

  async renew(): Promise<RunLease> {
    const current = this.#requiredLease();
    const lease = await this.#journal.renewRunLease({
      projectId: this.#projectId,
      runId: this.#runId,
      ownerId: this.#ownerId,
      ttlMs: this.#leaseTtlMs,
      fencingToken: current.fencingToken,
    });
    this.#lease = lease;
    return structuredClone(lease);
  }

  async prepareTurn(input: PrepareTurnInput): Promise<Required<
    Pick<KernelJournalCommitResult, 'run' | 'environment' | 'snapshot'>
  > & Pick<KernelJournalCommitResult, 'events'>> {
    const result = await openKernelJournalCommitter(this.#journal).commit({
      action: 'prepare-turn',
      projectId: this.#projectId,
      sessionId: this.#sessionId,
      runId: this.#runId,
      commandId: requireText(input.commandId, 'commandId'),
      lease: leaseReference(this.#requiredLease()),
      expectedRunRevision: input.expectedRunRevision,
      turnId: requireText(input.turnId, 'turnId'),
      resume: input.resume ?? false,
      environment: structuredClone(input.environment),
      snapshot: structuredClone(input.snapshot),
    });
    if (result.environment === undefined || result.snapshot === undefined) {
      throw new TypeError('Kernel Journal returned an incomplete prepare result.');
    }
    return result as Required<Pick<KernelJournalCommitResult, 'run' | 'environment' | 'snapshot'>> &
      Pick<KernelJournalCommitResult, 'events'>;
  }

  async startModelAttempt(input: Readonly<{
    commandId: string;
    expectedRunRevision: number;
    turnId: string;
    expectedTurnRevision: number;
    attemptId: string;
    origin: Readonly<{ connectionId: string; model: string; protocol: string }>;
  }>): Promise<KernelJournalCommitResult> {
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
    fingerprint: string;
  }>): Promise<KernelJournalCommitResult> {
    return await openKernelJournalCommitter(this.#journal).commit({
      action: 'record-no-progress', projectId: this.#projectId,
      sessionId: this.#sessionId, runId: this.#runId,
      commandId: requireText(input.commandId, 'commandId'),
      lease: leaseReference(this.#requiredLease()),
      expectedRunRevision: input.expectedRunRevision,
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

  #requiredLease(): RunLease {
    if (this.#lease === null) throw new TypeError('RunController must acquire a lease first.');
    return this.#lease;
  }
}

function leaseReference(lease: RunLease): RunLeaseReference {
  return { ownerId: lease.ownerId, fencingToken: lease.fencingToken };
}

function requireText(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} is required.`);
  return value;
}
