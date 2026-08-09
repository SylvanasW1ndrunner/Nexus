import type { PortableValue } from '@dbagent/shared';
import type { AgentEvent, AgentEventDraft, AgentEventType } from './agent-event.js';
import type { AgentRunProjection } from './event-projectors.js';

export type AgentJournalErrorCode =
  | 'INVALID_ARGUMENT'
  | 'INVALID_EVENT_PAYLOAD'
  | 'UNKNOWN_EVENT_TYPE'
  | 'PRODUCER_METADATA_FORBIDDEN'
  | 'COMMITTER_REQUIRED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'COMMAND_CONFLICT'
  | 'RUN_NOT_FOUND'
  | 'RUN_IDENTITY_CONFLICT'
  | 'TURN_NOT_FOUND'
  | 'REVISION_CONFLICT'
  | 'LEASE_HELD'
  | 'STALE_LEASE'
  | 'FENCING_TOKEN_STALE'
  | 'PARENT_EVENT_INVALID'
  | 'ATTEMPT_NOT_VALIDATED'
  | 'MODEL_COMMIT_CONFLICT'
  | 'CORRUPT_EVENT'
  | 'UNSUPPORTED_EVENT_SCHEMA'
  | 'JOURNAL_BUSY';

export class AgentJournalError extends Error {
  constructor(
    readonly code: AgentJournalErrorCode,
    message: string,
    readonly detail?: PortableValue,
  ) {
    super(message);
    this.name = 'AgentJournalError';
  }
}

export type CreateRunCommand = {
  projectId: string;
  sessionId: string;
  clientRequestId: string;
  input: PortableValue;
};

export type CreateRunResult = {
  runId: string;
  inputEventId: string;
  runCreatedEventId: string;
};

export type RunLeaseReference = { ownerId: string; fencingToken: number };

export type JournalCommand = {
  projectId: string;
  sessionId: string;
  runId: string;
  commandId: string;
  lease: RunLeaseReference;
  expectedRunRevision: number;
  events: AgentEventDraft[];
};

export type StartRunCommand = Omit<JournalCommand, 'events'>;
export type StartTurnCommand = StartRunCommand & { turnId: string };

export type JournalCommitResult = { events: AgentEvent[] };

export type AcquireRunLeaseInput = {
  projectId: string;
  runId: string;
  ownerId: string;
  ttlMs: number;
};

export type RenewRunLeaseInput = AcquireRunLeaseInput & { fencingToken: number };

export type RunLease = {
  projectId: string;
  runId: string;
  ownerId: string;
  fencingToken: number;
  expiresAt: string;
};

export interface AgentJournal {
  createRun(command: CreateRunCommand): Promise<CreateRunResult>;
  startRun(command: StartRunCommand): Promise<JournalCommitResult>;
  startTurn(command: StartTurnCommand): Promise<JournalCommitResult>;
  commit(command: JournalCommand): Promise<JournalCommitResult>;
  readProject(projectId: string, afterSequence: number, limit: number): Promise<AgentEvent[]>;
  acquireRunLease(input: AcquireRunLeaseInput): Promise<RunLease>;
  renewRunLease(input: RenewRunLeaseInput): Promise<RunLease>;
  getRunProjection(runId: string): Promise<AgentRunProjection | null>;
  countEvents(type?: AgentEventType, projectId?: string): Promise<number>;
  rebuildProjectProjections(projectId: string): Promise<void>;
}
