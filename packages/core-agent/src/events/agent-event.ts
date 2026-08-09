import type { ModelContentBlock, ModelFinishReason, ModelTokenUsage } from '@dbagent/core-llm';
import type { PortableValue } from '@dbagent/shared';

export const AGENT_EVENT_TYPES = [
  'input.received',
  'run.created',
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
export type PortableObject = { [key: string]: PortableValue };

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

export interface AgentEventPayloadMap {
  'input.received': {
    clientRequestId: string;
    content: PortableValue;
    steeringTarget?: { runId: string };
  };
  'run.created': { clientRequestId: string };
  'run.started': EmptyPayload;
  'run.resumed': { reason?: string };
  'run.steered': { clientRequestId: string; content: PortableValue };
  'run.input_requested': { reason: string; connectionId?: string };
  'run.cancel_requested': { reason?: string };
  'run.limit_reached': { limit: string; value?: number };
  'run.completed': {
    finalContentRef: string;
    deliveryStatus: string;
    evidenceRefs: string[];
  };
  'run.failed': { code: string; detail?: PortableValue };
  'run.cancelled': { reason?: string };
  'run.interrupted': { code: string; detail?: PortableValue };
  'turn.started': { turnSnapshotId?: string };
  'turn.context_compiled': { contextRef?: string; tokenEstimate?: number };
  'turn.no_progress': { fingerprint: string };
  model_attempt_started: { origin: PortableObject };
  model_delta_batch: { blocks: PortableValue[] };
  model_block_completed: { draftCallKey?: string; block: PortableValue };
  model_attempt_committed: {
    attemptId: string;
    blocks: ModelContentBlock[];
    finishReason: ModelFinishReason;
    usage?: ModelTokenUsage;
    protocolEnvelopeRef: string;
  };
  model_attempt_discarded: { reason: string };
  model_failed: { code: string; retryable: boolean; detail?: PortableValue };
  'turn.closed': { reason: string };
  'tool.proposed': {
    invocationId: string;
    callId: string;
    actionOrdinal: number;
    name: string;
    arguments: PortableValue;
  };
  'tool.validated': { toolRevision: string; normalizedArgumentsDigest: string };
  'tool.approval_requested': PortableObject;
  'tool.authorized': PortableObject;
  'tool.denied': PortableObject;
  'tool.started': PortableObject;
  'tool.progress': PortableObject;
  'tool.succeeded': PortableObject;
  'tool.failed': PortableObject;
  'tool.cancelled': PortableObject;
  'tool.outcome_unknown': PortableObject;
  'tool.outcome_resolution_requested': PortableObject;
  'tool.outcome_resolved': PortableObject;
  'tool.retry_authorized': PortableObject;
  'tool.observed': PortableObject;
  'context.compaction_started': PortableObject;
  'context.compacted': PortableObject;
  'context.compaction_failed': PortableObject;
  'artifact.created': PortableObject;
  'artifact.expired': PortableObject;
  'artifact.deleted': PortableObject;
  'skill.activated': PortableObject;
  'capability.snapshot_captured': PortableObject;
  'subagent.started': PortableObject;
  'subagent.steered': PortableObject;
  'subagent.completed': PortableObject;
  'subagent.failed': PortableObject;
  'subagent.cancelled': PortableObject;
  'usage.recorded': PortableObject;
}

type AgentEventShape<T extends AgentEventType> = {
  eventId: string;
  projectId: string;
  sequence: number;
  schemaVersion: 1;
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
