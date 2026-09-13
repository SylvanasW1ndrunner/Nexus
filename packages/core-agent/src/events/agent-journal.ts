import type { PreparedToolIntent } from '../tools/tool-protocol.js';
import type { ToolQuestionBundle, QuestionRuntimeCommand } from '../tools/tool-question.js';
import type { PortableValue } from '@dbagent/shared';
import type { AgentToolAuditEvidence, AgentToolCompletionEvidence } from '../types.js';
import type {
  AgentEvent,
  AgentEventDraft,
  AgentEventType,
  CanonicalToolIdFact,
  ToolApprovalFact,
  ToolRecoveryClassFact,
  ToolExecutionErrorFact,
  ToolObservationFact,
  RunIngressConfigurationSnapshot,
  ToolPermissionAuditFact,
} from './agent-event.js';
import type { AgentInvocationProjection, AgentRunProjection } from './event-projectors.js';
import type { RuntimeCommandProjection } from '../kernel/runtime-command.js';
import type { EnvironmentBindingInput } from '../kernel/run-controller.js';
import type { SessionModelBinding } from '../kernel/session-model-binding.js';
import type {
  ListSessionIndexesInput,
  SessionIndexProjection,
  SessionJournalEvent,
  SessionStateProjection,
  SessionSkillConfiguration,
} from '../session/session-journal.js';

export type AgentJournalErrorCode =
  | 'incompatible_state_store'
  | 'INVALID_ARGUMENT'
  | 'INVALID_EVENT_PAYLOAD'
  | 'UNKNOWN_EVENT_TYPE'
  | 'PRODUCER_METADATA_FORBIDDEN'
  | 'COMMITTER_REQUIRED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'COMMAND_CONFLICT'
  | 'RUN_NOT_FOUND'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_RUN_ACTIVE'
  | 'RUN_IDENTITY_CONFLICT'
  | 'TURN_NOT_FOUND'
  | 'INVOCATION_NOT_FOUND'
  | 'INVOCATION_STATE_CONFLICT'
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_BINDING_MISMATCH'
  | 'APPROVAL_DECISION_CONFLICT'
  | 'OUTCOME_RESOLUTION_CONFLICT'
  | 'RISKY_RETRY_AUTHORIZATION_CONFLICT'
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
  /** Trusted deterministic identity used only for a child Run. */
  runId?: string;
  clientRequestId: string;
  input: PortableValue;
  /** Exact internal Run configuration. It is never part of the user message projection. */
  configuration?: RunIngressConfigurationSnapshot;
  /** Exact immutable execution environment committed atomically with a top-level Run ingress. */
  environment?: EnvironmentBindingInput;
  /** Durable child-to-parent causality. Never carries an approval or authorization. */
  parent?: Readonly<{
    runId: string;
    turnId: string;
    invocationId: string;
  }>;
};

export type CreateRunResult = {
  runId: string;
  inputEventId: string;
  runCreatedEventId: string;
};

/** Durable, replayable Run tree record; never inferred from a live scheduler. */
export type RunAncestryProjection = Readonly<{
  projectId: string;
  runId: string;
  parentRunId: string | null;
  rootRunId: string;
  depth: number;
  /** Immutable creation ordinal among all non-root children of this root. */
  rootChildOrdinal: number;
}>;

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

export type PrepareToolInvocationCommand = ToolInvocationCommandBase & {
  action: 'prepare';
  canonicalToolId: CanonicalToolIdFact;
  catalogRevision: string;
  intent: PreparedToolIntent;
  intentDigest: string;
  deadline: string;
};

export type ValidateToolInvocationCommand = ToolInvocationCommandBase & {
  action: 'validate';
  canonicalToolId: CanonicalToolIdFact;
  toolRevision: string;
  recoveryClass: ToolRecoveryClassFact;
  intentDigest: string;
  authorization: 'allow' | 'ask' | 'deny';
  permissionAudit: Omit<ToolPermissionAuditFact, 'decision'>;
  actionSummary: string;
  approvalSummary: string;
};

export type RejectToolInvocationCommand = ToolInvocationCommandBase & {
  action: 'reject-validation';
  actionSummary: string;
  summary: string;
  error: ToolExecutionErrorFact;
  hookRejection?: Readonly<{ hookId: string; hookRevision: string; summary: string }>;
};

export type DecideToolApprovalCommand = ToolInvocationCommandBase & {
  action: 'decide-approval';
  approvalId: string;
  canonicalToolId: CanonicalToolIdFact;
  toolRevision: string;
  recoveryClass: ToolRecoveryClassFact;
  intentDigest: string;
  proposedRevision: number;
  decision: 'approve' | 'deny';
  decidedBy?: string;
  reason?: string;
};

export type StartToolInvocationCommand = ToolInvocationCommandBase & {
  action: 'start';
  intentDigest: string;
  idempotencyKey: string;
  attempt: number;
  permissionAudit: ToolPermissionAuditFact;
  /** Prior start fence atomically superseded by this recovery claim. */
  recoveryOfFencingToken?: number;
};

export type PublishToolProgressCommand = ToolInvocationCommandBase & {
  action: 'progress';
  /** Exact Handler attempt that produced this diagnostic batch. */
  idempotencyKey: string;
  attempt: number;
  /** Bounded semantic status emitted by the Handler. */
  summary: string;
};

export type FinishToolInvocationCommand = ToolInvocationCommandBase & {
  action: 'finish';
  intentDigest: string;
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'unknown' | 'timed_out' | 'unsupported_revision';
  summary: string;
  resultRefs: string[];
  evidenceRefs?: string[];
  durableSummary?: PortableValue;
  modelProjection?: PortableValue;
  userProjection?: PortableValue;
  auditEvidence?: AgentToolAuditEvidence;
  completionEvidence?: AgentToolCompletionEvidence;
  error?: ToolExecutionErrorFact;
  /** Exact stale start fence that a current lease is settling after interruption. */
  interruptedFencingToken?: number;
  hookWarnings?: Array<{
    hookId: string;
    hookRevision: string;
    summary: string;
  }>;
};

export type ObserveToolInvocationCommand = ToolInvocationCommandBase & {
  action: 'observe';
  observation: ToolObservationFact;
};

export type WaitForToolQuestionCommand = ToolInvocationCommandBase & {
  action: 'wait-for-user';
  intentDigest: string;
  bundle: ToolQuestionBundle;
};

export type SettleToolQuestionCommand = Omit<FinishToolInvocationCommand, 'action'> & {
  action: 'settle-question';
  questionCommand: QuestionRuntimeCommand;
  observation: ToolObservationFact;
};

export type AuthorizeToolRetryCommand = ToolInvocationCommandBase & {
  action: 'authorize-retry';
  permitId: string;
  toolRevision: string;
  recoveryClass: ToolRecoveryClassFact;
  intentDigest: string;
  reason: string;
};

export type ResolveUnknownToolOutcomeCommand = ToolInvocationCommandBase & {
  action: 'resolve-outcome';
  resolutionId: string;
  outcome: 'succeeded' | 'failed';
  canonicalToolId: CanonicalToolIdFact;
  toolRevision: string;
  recoveryClass: ToolRecoveryClassFact;
  intentDigest: string;
  proposedRevision: number;
  summary: string;
  retryAuthorization?: Readonly<{
    permitId: string;
    reason: string;
  }>;
};

export type ToolInvocationJournalCommand =
  | WaitForToolQuestionCommand
  | SettleToolQuestionCommand
  | PrepareToolInvocationCommand
  | ValidateToolInvocationCommand
  | RejectToolInvocationCommand
  | DecideToolApprovalCommand
  | StartToolInvocationCommand
  | PublishToolProgressCommand
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
    recoveryClass: ToolRecoveryClassFact;
    intentDigest: string;
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

export type ReleaseRunLeaseInput = {
  projectId: string;
  runId: string;
  ownerId: string;
  fencingToken: number;
};

export type GetTurnLifecycleInput = Readonly<{
  projectId: string;
  sessionId: string;
  runId: string;
  turnId: string;
}>;

export type TurnLifecycleProjection = Readonly<{
  revision: number;
  status: 'started' | 'committed' | 'closed';
}>;

export type PendingContextCompaction = Readonly<{
  schemaVersion: 1;
  projectId: string;
  sessionId: string;
  runId: string;
  decisionId: string;
  requestedAt: string;
}>;

export type GetPendingContextCompactionInput = Readonly<{
  projectId: string;
  sessionId: string;
  runId: string;
}>;

export type GetRuntimeCommandProjectionInput = Readonly<{
  projectId: string;
  sessionId: string;
  runId: string;
}>;

export type PendingSteering = Readonly<{
  clientRequestId: string;
  input: PortableValue;
  queuedAt: string;
}>;

export type SteeringRequest = PendingSteering & Readonly<{ consumedAt?: string }>;

export type WaitRunEventsInput = Readonly<{
  projectId: string;
  sessionId: string;
  runId: string;
  afterSequence: number;
  limit: number;
  timeoutMs: number;
  signal?: AbortSignal;
}>;

export type WaitRunEventsResult = Readonly<{
  events: readonly AgentEvent[];
  nextSequence: number | null;
  closed: boolean;
}>;

export type RunLease = {
  projectId: string;
  runId: string;
  ownerId: string;
  fencingToken: number;
  expiresAt: string;
};

export interface AgentJournal {
  createRun(command: CreateRunCommand): Promise<CreateRunResult>;
  findRunByClientRequest(input: Readonly<{
    projectId: string; sessionId: string; clientRequestId: string;
  }>): Promise<AgentRunProjection | null>;
  getRunIngressConfiguration(input: Readonly<{
    projectId: string; sessionId: string; runId: string;
  }>): Promise<RunIngressConfigurationSnapshot | null>;
  startRun(command: StartRunCommand): Promise<JournalCommitResult>;
  startTurn(command: StartTurnCommand): Promise<JournalCommitResult>;
  commit(command: JournalCommand): Promise<JournalCommitResult>;
  readProject(projectId: string, afterSequence: number, limit: number): Promise<AgentEvent[]>;
  readSession(input: Readonly<{
    projectId: string;
    sessionId: string;
    afterSequence: number;
    limit: number;
    throughSequence?: number;
    eventTypes?: readonly AgentEventType[];
  }>): Promise<AgentEvent[]>;
  getSessionIndex(projectId: string, sessionId: string): Promise<SessionIndexProjection | null>;
  getSessionState(projectId: string, sessionId: string): Promise<SessionStateProjection | null>;
  listSessionIndexes(input: ListSessionIndexesInput): Promise<SessionIndexProjection[]>;
  getSessionModelBinding(projectId: string, sessionId: string): Promise<SessionModelBinding | null>;
  getSessionSkillConfiguration(
    projectId: string,
    sessionId: string,
  ): Promise<SessionSkillConfiguration | null>;
  readSessionEvents(input: Readonly<{
    projectId: string; sessionId: string; afterSequence: number; limit: number;
  }>): Promise<Readonly<{ events: readonly SessionJournalEvent[]; nextSequence: number | null }>>;
  waitRunEvents(input: WaitRunEventsInput): Promise<WaitRunEventsResult>;
  acquireRunLease(input: AcquireRunLeaseInput): Promise<RunLease>;
  renewRunLease(input: RenewRunLeaseInput): Promise<RunLease>;
  releaseRunLease(input: ReleaseRunLeaseInput): Promise<boolean>;
  getRunLease(projectId: string, runId: string): Promise<RunLease | null>;
  getTurnLifecycle(input: GetTurnLifecycleInput): Promise<TurnLifecycleProjection | null>;
  getPendingContextCompaction(
    input: GetPendingContextCompactionInput,
  ): Promise<PendingContextCompaction | null>;
  getRuntimeCommandProjection(
    input: GetRuntimeCommandProjectionInput,
  ): Promise<RuntimeCommandProjection | null>;
  getPendingSteering(input: Readonly<{
    projectId: string; sessionId: string; runId: string;
  }>): Promise<PendingSteering | null>;
  getSteeringRequest(input: Readonly<{
    projectId: string; sessionId: string; runId: string; clientRequestId: string;
  }>): Promise<SteeringRequest | null>;
  getRunProjection(runId: string): Promise<AgentRunProjection | null>;
  getRunAncestry(runId: string): Promise<RunAncestryProjection | null>;
  countRootChildren(input: Readonly<{ projectId: string; rootRunId: string }>): Promise<number>;
  listRunDescendants(input: Readonly<{ projectId: string; rootRunId: string }>): Promise<RunAncestryProjection[]>;
  getInvocation(invocationId: string): Promise<AgentInvocationProjection | null>;
  listInvocations(runId: string): Promise<AgentInvocationProjection[]>;
  listTurnInvocations(input: ListTurnInvocationsInput): Promise<AgentInvocationProjection[]>;
  getApproval(input: GetToolApprovalInput): Promise<ToolApprovalFact | null>;
  listApprovals(input: ListToolApprovalsInput): Promise<ToolApprovalPage>;
  listObservations(runId: string): Promise<AgentObservationProjection[]>;
  countEvents(type?: AgentEventType, projectId?: string): Promise<number>;
  rebuildProjectProjections(projectId: string): Promise<void>;
}
