import type { PortableValue } from '@dbagent/shared';
import type {
  AgentEvent,
  AgentEventDraft,
  AgentEventType,
  CanonicalToolIdFact,
  ToolApprovalFact,
  ToolEffectFact,
  ToolExecutionErrorFact,
  ToolObservationFact,
} from './agent-event.js';
import type { AgentInvocationProjection, AgentRunProjection } from './event-projectors.js';

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
  | 'INVOCATION_NOT_FOUND'
  | 'INVOCATION_STATE_CONFLICT'
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_BINDING_MISMATCH'
  | 'APPROVAL_DECISION_CONFLICT'
  | 'OUTCOME_RESOLUTION_CONFLICT'
  | 'REVISION_CONFLICT'
  | 'LEASE_HELD'
  | 'STALE_LEASE'
  | 'FENCING_TOKEN_STALE'
  | 'PARENT_EVENT_INVALID'
  | 'ATTEMPT_NOT_VALIDATED'
  | 'MODEL_COMMIT_CONFLICT'
  | 'CORRUPT_EVENT'
  | 'PROJECTION_CORRUPT'
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

type ToolInvocationCommandBase = {
  projectId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  invocationId: string;
  commandId: string;
  lease: RunLeaseReference;
  expectedRunRevision: number;
  expectedInvocationRevision: number;
};

export type ValidateToolInvocationCommand = ToolInvocationCommandBase & {
  action: 'validate';
  canonicalToolId: CanonicalToolIdFact;
  toolRevision: string;
  effect: ToolEffectFact;
  normalizedArgumentsDigest: string;
  authorization: 'allow' | 'ask' | 'deny';
  approvalSummary: string;
};

export type RejectToolInvocationCommand = ToolInvocationCommandBase & {
  action: 'reject-validation';
  summary: string;
  error: ToolExecutionErrorFact;
};

export type DecideToolApprovalCommand = ToolInvocationCommandBase & {
  action: 'decide-approval';
  approvalId: string;
  canonicalToolId: CanonicalToolIdFact;
  toolRevision: string;
  effect: ToolEffectFact;
  normalizedArgumentsDigest: string;
  proposedRevision: number;
  decision: 'approve' | 'deny';
  decidedBy?: string;
  reason?: string;
};

export type StartToolInvocationCommand = ToolInvocationCommandBase & {
  action: 'start';
  idempotencyKey: string;
  attempt: number;
  /** Prior start fence atomically superseded by this recovery claim. */
  recoveryOfFencingToken?: number;
};

export type FinishToolInvocationCommand = ToolInvocationCommandBase & {
  action: 'finish';
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'outcome_unknown';
  summary: string;
  resultRefs: string[];
  durableSummary?: PortableValue;
  modelProjection?: PortableValue;
  userProjection?: PortableValue;
  error?: ToolExecutionErrorFact;
  /** Exact stale start fence that a current lease is resolving as unknown. */
  interruptedFencingToken?: number;
};

export type ObserveToolInvocationCommand = ToolInvocationCommandBase & {
  action: 'observe';
  observation: ToolObservationFact;
};

export type AuthorizeToolRetryCommand = ToolInvocationCommandBase & {
  action: 'authorize-retry';
  permitId: string;
  toolRevision: string;
  effect: ToolEffectFact;
  normalizedArgumentsDigest: string;
  reason: string;
};

export type ResolveUnknownToolOutcomeCommand = ToolInvocationCommandBase & {
  action: 'resolve-outcome';
  resolutionId: string;
  outcome: 'succeeded' | 'failed';
  canonicalToolId: CanonicalToolIdFact;
  toolRevision: string;
  effect: ToolEffectFact;
  normalizedArgumentsDigest: string;
  proposedRevision: number;
  summary: string;
};

export type ToolInvocationJournalCommand =
  | ValidateToolInvocationCommand
  | RejectToolInvocationCommand
  | DecideToolApprovalCommand
  | StartToolInvocationCommand
  | FinishToolInvocationCommand
  | ObserveToolInvocationCommand
  | AuthorizeToolRetryCommand
  | ResolveUnknownToolOutcomeCommand;

export type ToolInvocationCommitResult = {
  events: AgentEvent[];
  invocation: AgentInvocationProjection;
  approval?: ToolApprovalFact;
  retryPermit?: {
    permitId: string;
    invocationId: string;
    toolRevision: string;
    effect: ToolEffectFact;
    normalizedArgumentsDigest: string;
    reason: string;
  };
};

export type AgentObservationProjection = ToolObservationFact & {
  projectId: string;
  runId: string;
  createdAt: string;
};

export type ListToolApprovalsInput = Readonly<{
  projectId: string;
  sessionId: string;
  runId: string;
  cursor?: string;
  limit: number;
  status?: ToolApprovalFact['status'];
}>;

export type ToolApprovalPage = Readonly<{
  items: ToolApprovalFact[];
  hasMore: boolean;
  nextCursor?: string;
}>;

export type GetToolApprovalInput = Readonly<{
  projectId: string;
  sessionId: string;
  runId: string;
  invocationId: string;
}>;

export type ListTurnInvocationsInput = Readonly<{
  projectId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  afterActionOrdinal?: number;
  limit: number;
}>;

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
  getRunLease(projectId: string, runId: string): Promise<RunLease | null>;
  getRunProjection(runId: string): Promise<AgentRunProjection | null>;
  getInvocation(invocationId: string): Promise<AgentInvocationProjection | null>;
  listInvocations(runId: string): Promise<AgentInvocationProjection[]>;
  listTurnInvocations(input: ListTurnInvocationsInput): Promise<AgentInvocationProjection[]>;
  /** @deprecated Legacy projection query; unified Runtime must use scoped getApproval(). */
  getApprovalForInvocation(invocationId: string): Promise<ToolApprovalFact | null>;
  getApproval(input: GetToolApprovalInput): Promise<ToolApprovalFact | null>;
  listApprovals(input: ListToolApprovalsInput): Promise<ToolApprovalPage>;
  listObservations(runId: string): Promise<AgentObservationProjection[]>;
  countEvents(type?: AgentEventType, projectId?: string): Promise<number>;
  rebuildProjectProjections(projectId: string): Promise<void>;
}
