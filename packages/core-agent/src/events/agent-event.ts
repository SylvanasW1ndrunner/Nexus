import type {
  DecodedModelContentBlock, ModelFinishReason, ModelTokenUsage,
} from '@dbagent/core-llm';
import type { PortableValue } from '@dbagent/shared';
import type {
  AgentContextCheckpoint,
  AgentMessage,
  AgentRunRecord,
  AgentSession,
  AgentSubagentRecord,
  AgentUserPreference,
} from '../types.js';

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
  'tool.proposed',
  'tool.validated',
  'tool.approval_requested',
  'tool.authorized',
  'tool.denied',
  'tool.started',
  'tool.progress',
  'tool.succeeded',
  'tool.failed',
  'tool.cancelled',
  'tool.outcome_unknown',
  'tool.outcome_resolution_requested',
  'tool.outcome_resolved',
  'tool.retry_authorized',
  'tool.observed',
  'context.compaction_started',
  'context.compacted',
  'context.compaction_failed',
  'artifact.created',
  'artifact.expired',
  'artifact.deleted',
  'legacy.imported',
  'skill.activated',
  'capability.snapshot_captured',
  'subagent.started',
  'subagent.steered',
  'subagent.completed',
  'subagent.failed',
  'subagent.cancelled',
  'usage.recorded',
] as const;

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

type EmptyPayload = Record<string, never>;
type ToolTerminalPayload = {
  summary: string;
  resultRefs: string[];
  durableSummary?: PortableValue;
  /** Bounded semantic result used to recreate the exact Observation after restart. */
  modelProjection?: PortableValue;
  /** Bounded user-facing view; full content is referenced through resultRefs. */
  userProjection?: PortableValue;
  error?: ToolExecutionErrorFact;
};

export type ToolEffectFact = 'read' | 'idempotent' | 'transactional' | 'non_idempotent';

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
    | 'OUTCOME_RESOLVED_FAILED';
  category:
    | 'internal'
    | 'timeout'
    | 'cancelled'
    | 'contract'
    | 'unavailable'
    | 'conflict'
    | 'validation'
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
  effect: ToolEffectFact;
  normalizedArgumentsDigest: string;
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
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'outcome_unknown' | 'denied';
  modelProjection?: PortableValue;
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
    visibility?: 'legacy-import-carrier';
  };
  'run.environment_bound': {
    environmentBindingId: string;
    digest: string;
    /** Immutable portable payload; required for Journal-only projection rebuilds. */
    binding?: PortableValue;
  };
  'run.started': EmptyPayload;
  'run.resumed': { reason?: string };
  'run.steered': { clientRequestId: string; content: PortableValue };
  'run.input_requested': { reason: string; connectionId?: string };
  'run.cancel_requested': { reason?: string };
  'run.limit_reached': { limit: string; value?: number };
  'run.completed': {
    finalContentRef: string;
    deliveryStatus: 'not-required' | 'verified' | 'unverified';
    evidenceRefs: string[];
  };
  'run.failed': { code: string; detail?: PortableValue };
  'run.cancelled': { reason?: string };
  'run.interrupted': { code: string; detail?: PortableValue };
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
  };
  'plan.created': { planId: string; revision: number; plan: PortableValue };
  'plan.updated': { planId: string; revision: number; plan: PortableValue };
  'tool.proposed': {
    invocationId: string;
    callId: string;
    actionOrdinal: number;
    name: string;
    arguments: PortableValue;
  };
  'tool.validated':
    | {
        invocationId: string;
        canonicalToolId: CanonicalToolIdFact;
        toolRevision: string;
        effect: ToolEffectFact;
        normalizedArgumentsDigest: string;
        proposedRevision: number;
        retryOf?: string;
        retryPermitId?: string;
      }
    | {
        invocationId: string;
        validationError: ToolExecutionErrorFact;
      };
  'tool.approval_requested': { approval: ToolApprovalFact; summary: string };
  'tool.authorized': { approvalId: string; invocationId: string };
  'tool.denied': { approvalId: string; invocationId: string; reason: string };
  'tool.started': {
    invocationId: string;
    idempotencyKey: string;
    fencingToken: number;
    attempt: number;
  };
  'tool.progress': { invocationId: string; summary: string };
  'tool.succeeded': ToolTerminalPayload;
  'tool.failed': ToolTerminalPayload;
  'tool.cancelled': ToolTerminalPayload;
  'tool.outcome_unknown': ToolTerminalPayload;
  'tool.outcome_resolution_requested': { invocationId: string; summary: string };
  'tool.outcome_resolved': ToolTerminalPayload & {
    resolutionId: string;
    decisionDigest: string;
    invocationId: string;
    outcome: 'succeeded' | 'failed';
    canonicalToolId: CanonicalToolIdFact;
    toolRevision: string;
    effect: ToolEffectFact;
    normalizedArgumentsDigest: string;
    proposedRevision: number;
  };
  'tool.retry_authorized': {
    invocationId: string;
    permitId: string;
    toolRevision: string;
    effect: ToolEffectFact;
    normalizedArgumentsDigest: string;
    reason: string;
  };
  'tool.observed': ToolObservationFact;
  'context.compaction_started': { checkpointId: string };
  'context.compacted': { checkpointId: string; summaryRef: string; coveredSequence: number };
  'context.compaction_failed': { checkpointId: string; code: string };
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
  'capability.snapshot_captured': { snapshotId: string; revision: string };
  'subagent.started': { subagentId: string; summary: string };
  'subagent.steered': { subagentId: string; summary: string };
  'subagent.completed': { subagentId: string; summary: string; refs: string[] };
  'subagent.failed': { subagentId: string; code: string; summary: string };
  'subagent.cancelled': { subagentId: string; reason: string };
  'usage.recorded': {
    scope: 'run' | 'turn' | 'attempt' | 'tool';
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
