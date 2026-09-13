import type { ToolQuestionBundle } from '../tools/tool-question.js';
import type {
  DecodedModelContentBlock, ModelFinishReason, ModelTokenUsage,
} from '@dbagent/core-llm';
import type { PortableValue, UsageMode } from '@dbagent/shared';
import type { ToolRecoveryClass, ToolAccess, PreparedToolIntent } from '../tools/tool-protocol.js';
import type { ToolScheduleDecision } from '../tools/tool-scheduler.js';
import type {
  AgentMode,
  AgentToolAuditEvidence,
  AgentToolCompletionEvidence,
  ToolDangerLevel,
  ToolPermissionAction,
  ToolPermissionDecision,
} from '../types.js';
import type {
  LegacyAgentContextCheckpoint as AgentContextCheckpoint,
  LegacyAgentMessage as AgentMessage,
  LegacyAgentRunRecord as AgentRunRecord,
  LegacyAgentSession as AgentSession,
  LegacyAgentSubagentRecord as AgentSubagentRecord,
  LegacyAgentUserPreference as AgentUserPreference,
} from '../session/legacy-import-types.js';

export const AGENT_EVENT_TYPES = [
  'input.received',
  'run.created',
  'run.environment_bound',
  'run.started',
  'run.resumed',
  'run.steered',
  'run.input_requested',
  'run.cancel_requested',
  'run.limit_reached',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.interrupted',
  'turn.started',
  'turn.context_compiled',
  'turn.no_progress',
  'model_attempt_started',
  'model_delta_batch',
  'model_block_completed',
  'model_attempt_committed',
  'model_attempt_discarded',
  'model_failed',
  'turn.closed',
  'delivery.decided',
  'plan.created',
  'plan.updated',
  'tool.activated',
  'tool.proposed',
  'tool.prepared',
  'tool.permission_evaluated',
  'tool.waiting_for_user',
  'tool.timed_out',
  'tool.unsupported_revision',
  'tool.approval_requested',
  'tool.authorized',
  'tool.denied',
  'tool.started',
  'tool.progress',
  'tool.hook_rejected',
  'tool.hook_warning',
  'tool.succeeded',
  'tool.failed',
  'tool.cancelled',
  'tool.unknown',
  'tool.outcome_resolution_requested',
  'tool.outcome_resolved',
  'tool.retry_authorized',
  'tool.observed',
  'tool.transition_committed',
  'context.compaction_requested',
  'context.compaction_started',
  'context.compacted',
  'context.compaction_failed',
  'artifact.created',
  'artifact.expired',
  'artifact.deleted',
  'legacy.imported',
  'skill.activated',
  'capability.discovered',
  'capability.snapshot_captured',
  'subagent.started',
  'subagent.steered',
  'subagent.completed',
  'subagent.failed',
  'subagent.cancelled',
  'runtime.command_applied',
  'usage.recorded',
] as const;

export type ToolPermissionAuditFact = {
  mode: AgentMode;
  decision: ToolPermissionDecision;
  /** Exact global enterprise policy used for this decision. */
  policyRevision: string;
  matchedRuleIds: string[];
  facts: {
    toolName: string;
    dangerLevel: ToolDangerLevel;
    readonly: boolean;
    recoveryClass: ToolRecoveryClass;
    access: ToolAccess;
    unknownRisk: boolean;
    resolvedAddresses: string[];
    targets: PortableValue[];
    actions: ToolPermissionAction[];
    paths: string[];
    hosts: string[];
    network: boolean;
    externalWrite: boolean;
    destructive: boolean;
    credentials: boolean;
    admin: boolean;
  };
};

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

export type AgentRunState =
  | 'created'
  | 'Preparing'
  | 'Compacting'
  | 'CallingModel'
  | 'ReceivingModel'
  | 'ResolvingActions'
  | 'AwaitingUser'
  | 'ExecutingTools'
  | 'ApplyingObservations'
  | 'Finalizing'
  | 'Cancelling'
  | 'LimitReached'
  | 'Interrupted'
  | 'Completed'
  | 'Failed'
  | 'Cancelled';

export type AgentResumableState =
  | 'created'
  | 'Preparing'
  | 'Compacting'
  | 'CallingModel'
  | 'ReceivingModel'
  | 'ResolvingActions'
  | 'ExecutingTools'
  | 'ApplyingObservations'
  | 'Finalizing';

type EmptyPayload = Record<string, never>;
type ToolTerminalPayload = {
  intentDigest?: string;
  summary: string;
  /** Agent Artifact handles only. */
  resultRefs: string[];
  /** Provider-neutral durable evidence; ResultHandle references are not Agent Artifacts. */
  evidenceRefs: string[];
  durableSummary?: PortableValue;
  /** Bounded semantic result used to recreate the exact Observation after restart. */
  modelProjection?: PortableValue;
  /** Bounded user-facing view; full content is referenced through resultRefs. */
  userProjection?: PortableValue;
  auditEvidence?: AgentToolAuditEvidence;
  completionEvidence?: AgentToolCompletionEvidence;
  error?: ToolExecutionErrorFact;
};

export type ToolRecoveryClassFact = 'read' | 'idempotent' | 'transactional' | 'non_idempotent';

export type CanonicalToolIdFact = { namespace?: string; name: string };

export type ToolExecutionErrorFact = {
  code:
    | 'HANDLER_FAILED'
    | 'TOOL_TIMEOUT'
    | 'TOOL_CANCELLED'
    | 'INVALID_TOOL_RESULT'
    | 'TOOL_NOT_FOUND'
    | 'TOOL_REVISION_MISMATCH'
    | 'TOOL_INPUT_INVALID'
    | 'invalid_cursor'
    | 'TOOL_RESOURCE_NOT_FOUND'
    | 'TOOL_CONFLICT'
    | 'target_changed'
    | 'conflict'
    | 'TOOL_PRECONDITION_FAILED'
    | 'TOOL_EXTERNAL_FAILED'
    | 'TOOL_LIMIT_EXCEEDED'
    | 'TOOL_PERMISSION_DENIED'
    | 'OUTCOME_RESOLVED_FAILED';
  category:
    | 'internal'
    | 'timeout'
    | 'cancelled'
    | 'contract'
    | 'unavailable'
    | 'conflict'
    | 'validation'
    | 'authorization'
    | 'external'
    | 'precondition'
    | 'limit'
    | 'resolution';
  retryable: boolean;
  outcome: 'not_applied' | 'unknown';
};

export type ToolApprovalFact = {
  approvalId: string;
  projectId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  invocationId: string;
  canonicalToolId: CanonicalToolIdFact;
  toolRevision: string;
  recoveryClass: ToolRecoveryClassFact;
  intentDigest: string;
  proposedRevision: number;
  status: 'pending' | 'approved' | 'denied';
  decidedAt?: string;
  decidedBy?: string;
  reason?: string;
};

export type ToolObservationFact = {
  observationId: string;
  invocationId: string;
  summary: string;
  evidenceRefs: string[];
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'unknown' | 'denied' | 'timed_out' | 'unsupported_revision';
  modelProjection?: PortableValue;
  auditEvidence?: AgentToolAuditEvidence;
  completionEvidence?: AgentToolCompletionEvidence;
  errorCode?: ToolExecutionErrorFact['code'];
};

export type LegacyImportedToolCall = {
  id: string;
  name: string;
  arguments: Record<string, PortableValue>;
};

export type LegacyImportedSessionRecord = {
  session: AgentSession;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
};

export type RunIngressConfigurationSnapshot = Readonly<{
  schemaVersion: 1;
  /** Digest of the normalized public start request; excludes runtime-generated identities. */
  clientRequestDigest?: string;
  mode: AgentMode;
  /**
   * Exact, durable role-prompt layers.  This keeps the public append/replace
   * contract available when a Run is reopened or replayed instead of
   * persisting only a precompiled instruction string.
   */
  rolePrompt?: Readonly<{
    default?: Readonly<{ mode: 'append' | 'replace'; content: string }>;
    run?: Readonly<{ mode: 'append' | 'replace'; content: string }>;
  }>;
  capabilityInstructions: readonly string[];
  allowedTools?: readonly string[];
  sessionSkillRevision: number;
}>;

export type PersistedValidatedAttempt = {
  attemptId: string;
  origin: { connectionId: string; model: string; protocol: string };
  blocks: DecodedModelContentBlock[];
  terminal: true;
  validation: 'validated';
  finishReason?: ModelFinishReason;
  usage?: ModelTokenUsage;
  providerResponseId?: string;
  opaqueBlockRefs: string[];
};

export interface AgentEventPayloadMap {
  'input.received': {
    clientRequestId: string;
    content: PortableValue;
    steeringTarget?: { runId: string };
  };
  'run.created': {
    clientRequestId: string;
    /** Internal exact Run configuration, excluded from user/model input projections. */
    configuration?: RunIngressConfigurationSnapshot;
    visibility?: 'legacy-import-carrier';
    parent?: {
      runId: string;
      turnId: string;
      invocationId: string;
    };
  };
  'run.environment_bound': {
    environmentBindingId: string;
    digest: string;
    /** Immutable portable payload; required for Journal-only projection rebuilds. */
    binding?: PortableValue;
  };
  'run.started': EmptyPayload;
  'run.resumed': {
    resumeState: AgentResumableState;
    reason?: string;
    /** True only when a previously blocked, already-closed Turn is retired. */
    clearTurn?: boolean;
  };
  'run.steered': { clientRequestId: string; content: PortableValue };
  'run.input_requested': { reason: string; connectionId?: string };
  'run.cancel_requested': { reason?: string };
  'run.limit_reached': {
    limit: string;
    value?: number;
    resumeState: AgentResumableState;
  };
  'run.completed': {
    finalContentRef: string;
    deliveryStatus: 'not-required' | 'verified' | 'unverified';
    evidenceRefs: string[];
  };
  'run.failed': { code: string; detail?: PortableValue };
  'run.cancelled': { reason?: string };
  'run.interrupted': {
    code: string;
    detail?: PortableValue;
    resumeState: AgentResumableState;
  };
  'turn.started': {
    turnSnapshotId?: string;
    environmentBindingId?: string;
    digest?: string;
    /** Immutable portable payload; required for Journal-only projection rebuilds. */
    snapshot?: PortableValue;
  };
  'turn.context_compiled': { contextRef?: string; tokenEstimate?: number };
  'turn.no_progress': { fingerprint: string };
  model_attempt_started: { origin: { connectionId: string; model: string; protocol: string } };
  model_delta_batch: { blocks: PortableValue[] };
  model_block_completed: { draftCallKey?: string; block: PortableValue };
  model_attempt_committed: {
    validatedAttempt: PersistedValidatedAttempt;
    turn: { protocolEnvelopeRef: string };
    protocolEnvelope: {
      schemaVersion: 1;
      correlations: Array<{
        callId: string;
        draftCallKey: string;
        wireIdentity?: { callId?: string; providerItemId?: string };
        replay: 'same-connection-only' | 'compatible-protocol';
      }>;
    };
  };
  model_attempt_discarded: { reason: string };
  model_failed: { code: string; retryable: boolean; detail?: PortableValue };
  'turn.closed': { reason: string };
  'delivery.decided': {
    evidenceRevision: number;
    status: 'not-required' | 'verified' | 'unverified';
    outcome: 'accepted' | 'revision-requested' | 'failed';
    verifierId?: string;
    verifierRevision?: string;
    evidenceRefs: string[];
    reason?: string;
    /** Bounded Model-visible semantic feedback, present only for revision-requested. */
    observation?: PortableValue;
  };
  'plan.created': { planId: string; revision: number; plan: PortableValue };
  'plan.updated': { planId: string; revision: number; plan: PortableValue };
  'tool.activated': {
    tools: Array<{ name: string; toolRevision: string; handlerRevision: string }>;
  };
  'tool.proposed': {
    invocationId: string;
    callId: string;
    actionOrdinal: number;
    name: string;
    arguments: PortableValue;
  };
  'tool.prepared':
    | {
        invocationId: string;
        actionSummary: string;
        intent: PreparedToolIntent;
        deadline: string;
        catalogRevision: string;
        canonicalToolId: CanonicalToolIdFact;
        toolRevision: string;
        recoveryClass: ToolRecoveryClassFact;
        intentDigest: string;
        proposedRevision: number;
        permissionAudit?: ToolPermissionAuditFact;
        retryOf?: string;
        retryPermitId?: string;
      }
    | {
        invocationId: string;
        actionSummary: string;
        validationError: ToolExecutionErrorFact;
      };
  'tool.approval_requested': { approval: ToolApprovalFact; summary: string };
  'tool.permission_evaluated': { invocationId: string; intentDigest: string; permissionAudit: ToolPermissionAuditFact; retryOf?: string; retryPermitId?: string };
  'tool.waiting_for_user': { invocationId: string; intentDigest: string; questionId: string; questionRevision: number; bundle: ToolQuestionBundle };
  'tool.timed_out': ToolTerminalPayload;
  'tool.unsupported_revision': ToolTerminalPayload;
  'tool.authorized': {
    intentDigest: string;
    approvalId: string;
    invocationId: string;
    actionSummary?: string;
    decision?: {
      status: 'approved';
      decidedAt: string;
      decidedBy?: string;
      reason?: string;
    };
  };
  'tool.denied': {
    intentDigest: string;
    approvalId: string;
    invocationId: string;
    actionSummary?: string;
    reason: string;
    decision?: {
      status: 'denied';
      decidedAt: string;
      decidedBy?: string;
      reason?: string;
    };
  };
  'tool.started': {
    intentDigest: string;
    access: ToolAccess;
    concurrency: 'read' | 'write' | 'exclusive';
    resourceKeys: string[];
    invocationId: string;
    idempotencyKey: string;
    fencingToken: number;
    attempt: number;
    /** Run revision after the atomic Tool start transition committed. */
    runRevision: number;
    /** Fresh authorization evaluated immediately before the execution fence. */
    permissionAudit: ToolPermissionAuditFact;
  };
  'tool.progress': { invocationId: string; summary: string };
  'tool.hook_rejected': {
    invocationId: string;
    hookId: string;
    hookRevision: string;
    summary: string;
  };
  'tool.hook_warning': {
    invocationId: string;
    hookId: string;
    hookRevision: string;
    summary: string;
  };
  'tool.succeeded': ToolTerminalPayload;
  'tool.failed': ToolTerminalPayload;
  'tool.cancelled': ToolTerminalPayload;
  'tool.unknown': ToolTerminalPayload;
  'tool.outcome_resolution_requested': { invocationId: string; summary: string };
  'tool.outcome_resolved': ToolTerminalPayload & {
    resolutionId: string;
    decisionDigest: string;
    invocationId: string;
    outcome: 'succeeded' | 'failed';
    canonicalToolId: CanonicalToolIdFact;
    toolRevision: string;
    recoveryClass: ToolRecoveryClassFact;
    intentDigest: string;
    proposedRevision: number;
  };
  'tool.retry_authorized': {
    invocationId: string;
    permitId: string;
    toolRevision: string;
    recoveryClass: ToolRecoveryClassFact;
    intentDigest: string;
    reason: string;
  };
  'tool.observed': ToolObservationFact;
  'tool.transition_committed': {
    action:
      | 'prepare'
      | 'wait-for-user'
      | 'settle-question'
      | 'validate'
      | 'reject-validation'
      | 'decide-approval'
      | 'start'
      | 'finish'
      | 'observe'
      | 'authorize-retry'
      | 'resolve-outcome';
    schedule: ToolScheduleDecision;
  };
  'context.compaction_requested': { decisionId: string };
  'context.compaction_started': {
    checkpointId: string;
    decisionId: string;
    reason: 'automatic' | 'manual';
    coveredSequence: number;
  };
  'context.compacted': {
    checkpointId: string;
    decisionId: string;
    summaryRef: string;
    summary: string;
    coveredSequence: number;
    attemptId: string;
    usage?: ModelTokenUsage;
  };
  'context.compaction_failed': { checkpointId: string; decisionId: string; code: string };
  'artifact.created':
    | {
        artifactId: string;
        handle: string;
        checksum: string;
        byteSize: number;
        mediaType: string;
        availability: 'available';
        summary: string;
        expiresAt?: string;
      }
    | {
        artifactId: string;
        handle: string;
        checksum: null;
        byteSize: null;
        mediaType: string;
        availability: 'legacy-unavailable';
        summary: string;
        expiresAt?: string;
      };
  'artifact.expired': { artifactId: string };
  'artifact.deleted': { artifactId: string };
  'legacy.imported':
    | {
        entityType: 'session'; legacyId: string;
        projectKey: string; projectRoot: string; record: LegacyImportedSessionRecord;
      }
    | {
        entityType: 'message'; legacyId: string;
        messageIndex: number; sourceRunId: string; record: AgentMessage;
      }
    | {
        entityType: 'run'; legacyId: string; record: AgentRunRecord;
        sourceStatus: AgentRunRecord['status']; legacyPlan: PortableValue | null;
      }
    | {
        entityType: 'preference'; legacyId: string;
        record: AgentUserPreference;
      }
    | {
        entityType: 'checkpoint'; legacyId: string; sessionId: string;
        record: AgentContextCheckpoint;
      }
    | {
        entityType: 'subagent'; legacyId: string;
        record: AgentSubagentRecord;
      }
    | { entityType: 'diagnostic'; legacyId: string; code: string; evidence: string }
    | {
        entityType: 'archive'; legacyId: string; relativePath: string;
        archiveHandle: string; checksum: string; byteSize: number;
      };
  'skill.activated': { skillId: string; revision: string };
  'capability.discovered': { targets: Array<{ moduleId: string; instanceId: string }> };
  'capability.snapshot_captured': { snapshotId: string; revision: string };
  'subagent.started': { subagentId: string; summary: string };
  'subagent.steered': { subagentId: string; summary: string };
  'subagent.completed': { subagentId: string; summary: string; refs: string[] };
  'subagent.failed': { subagentId: string; code: string; summary: string };
  'subagent.cancelled': { subagentId: string; reason: string };
  'runtime.command_applied': {
    commandId: string;
    kind:
      | 'plan.create'
      | 'plan.update'
      | 'discovery.activate'
      | 'skill.activate'
      | 'child.start'
      | 'child.list'
      | 'child.wait'
      | 'child.steer'
      | 'child.cancel';
    origin: { runId: string; turnId: string; invocationId: string };
    expectedRunRevision: number;
    fencingToken: number;
    projectionRevision: number;
    effect: PortableValue;
  };
  'usage.recorded': {
    scope: 'run' | 'turn' | 'attempt' | 'tool';
    usageId: string;
    purpose: 'agent-turn' | 'context-compaction' | 'tool';
    /** Immutable provider billing classification; v1/v2 facts are upcast as byok. */
    billingMode: UsageMode;
    turnId?: string;
    attemptId?: string;
    invocationId?: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

type AgentEventShape<T extends AgentEventType> = {
  eventId: string;
  projectId: string;
  sequence: number;
  schemaVersion: number;
  sessionId: string;
  runId: string;
  turnId?: string;
  parentEventId?: string;
  invocationId?: string;
  attemptId?: string;
  type: T;
  occurredAt: string;
  payload: AgentEventPayloadMap[T];
};

export type AgentEvent<T extends AgentEventType = AgentEventType> = T extends AgentEventType
  ? AgentEventShape<T>
  : never;

type AgentEventDraftShape<T extends AgentEventType> = {
  type: T;
  payload: AgentEventPayloadMap[T];
  turnId?: string;
  parentEventId?: string;
  invocationId?: string;
  attemptId?: string;
};

export type AgentEventDraft<T extends AgentEventType = AgentEventType> = T extends AgentEventType
  ? AgentEventDraftShape<T>
  : never;
