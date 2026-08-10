import type {
  ModelContentBlock, ModelFinishReason, ModelProtocolEnvelope, ModelTokenUsage,
} from '@dbagent/core-llm';
import type { PortableValue } from '@dbagent/shared';
import type {
  AgentEvent,
  AgentRunState,
  CanonicalToolIdFact,
  PersistedValidatedAttempt,
  ToolApprovalFact,
  ToolEffectFact,
  ToolExecutionErrorFact,
  ToolObservationFact,
} from './agent-event.js';
import {
  decideSchedule,
  runStateForSchedule,
  type ScheduledToolInvocation,
} from '../tools/tool-scheduler.js';

export type AgentRunProjection = {
  projectId: string;
  sessionId: string;
  runId: string;
  clientRequestId: string;
  visibility?: 'legacy-import-carrier';
  state: AgentRunState;
  revision: number;
  input?: PortableValue;
  createdAt: string;
  updatedAt: string;
};

export type AgentTurnProjection = {
  projectId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  attemptId: string;
  blocks: ModelContentBlock[];
  finishReason: ModelFinishReason;
  usage?: ModelTokenUsage;
  protocolEnvelopeRef: string;
  committedAt: string;
};

export type AgentAttemptProjection = {
  projectId: string;
  runId: string;
  turnId: string;
  attemptId: string;
  status: 'committed';
  committedAt: string;
};

export type AgentInvocationProjection = {
  projectId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  attemptId: string;
  invocationId: string;
  callId: string;
  actionOrdinal: number;
  name: string;
  arguments: PortableValue;
  state:
    | 'proposed'
    | 'validated'
    | 'awaiting_approval'
    | 'authorized'
    | 'denied'
    | 'started'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'outcome_unknown'
    | 'observed';
  revision: number;
  canonicalToolId?: CanonicalToolIdFact;
  toolRevision?: string;
  effect?: ToolEffectFact;
  normalizedArgumentsDigest?: string;
  proposedRevision?: number;
  approvalId?: string;
  retryOf?: string;
  retryPermitId?: string;
  retryPermit?: {
    permitId: string;
    toolRevision: string;
    effect: ToolEffectFact;
    normalizedArgumentsDigest: string;
    reason: string;
  };
  outcomeResolution?: {
    resolutionId: string;
    decisionDigest: string;
    outcome: 'succeeded' | 'failed';
    resolvedAt: string;
  };
  started?: {
    idempotencyKey: string;
    fencingToken: number;
    attempt: number;
    startedAt: string;
  };
  terminal?: {
    kind: 'succeeded' | 'failed' | 'cancelled' | 'outcome_unknown' | 'denied';
    summary: string;
    resultRefs: string[];
    durableSummary?: PortableValue;
    modelProjection?: PortableValue;
    userProjection?: PortableValue;
    error?: ToolExecutionErrorFact;
    occurredAt: string;
  };
  observation?: ToolObservationFact & { occurredAt: string };
  createdAt: string;
  updatedAt: string;
};

export type AgentReplayProjection = {
  runs: AgentRunProjection[];
  turns: AgentTurnProjection[];
  attempts: AgentAttemptProjection[];
  invocations: AgentInvocationProjection[];
  approvals: ToolApprovalFact[];
  observations: Array<ToolObservationFact & {
    projectId: string; runId: string; createdAt: string;
  }>;
  envelopes: ModelProtocolEnvelope[];
  validatedAttempts: PersistedValidatedAttempt[];
  lastSequenceByProject: Record<string, number>;
};

const RUN_STATES: Partial<Record<AgentEvent['type'], AgentRunState>> = {
  'run.started': 'Preparing',
  'run.resumed': 'Preparing',
  'run.input_requested': 'AwaitingUser',
  'run.cancel_requested': 'Cancelling',
  'run.limit_reached': 'LimitReached',
  'run.completed': 'Completed',
  'run.failed': 'Failed',
  'run.cancelled': 'Cancelled',
  'run.interrupted': 'Interrupted',
};

export function replayAgentEvents(events: readonly AgentEvent[]): AgentReplayProjection {
  const ordered = [...events].sort(
    (left, right) => left.projectId.localeCompare(right.projectId) || left.sequence - right.sequence,
  );
  const inputs = new Map<string, PortableValue>();
  const runs = new Map<string, AgentRunProjection>();
  const turns = new Map<string, AgentTurnProjection>();
  const attempts = new Map<string, AgentAttemptProjection>();
  const invocations = new Map<string, AgentInvocationProjection>();
  const approvals = new Map<string, ToolApprovalFact>();
  const observations = new Map<string, ToolObservationFact & {
    projectId: string; runId: string; createdAt: string;
  }>();
  const envelopes = new Map<string, ModelProtocolEnvelope>();
  const validatedAttempts = new Map<string, PersistedValidatedAttempt>();
  const lastSequenceByProject: Record<string, number> = {};

  for (const event of ordered) {
    lastSequenceByProject[event.projectId] = event.sequence;
    if (event.type === 'input.received') {
      inputs.set(event.runId, event.payload.content);
      continue;
    }
    if (event.type === 'run.created') {
      const input = inputs.get(event.runId);
      runs.set(event.runId, {
        projectId: event.projectId,
        sessionId: event.sessionId,
        runId: event.runId,
        clientRequestId: event.payload.clientRequestId,
        ...(event.payload.visibility === undefined ? {} : { visibility: event.payload.visibility }),
        state: 'created',
        revision: 1,
        ...(input === undefined ? {} : { input: structuredClone(input) }),
        createdAt: event.occurredAt,
        updatedAt: event.occurredAt,
      });
      continue;
    }
    const runState = RUN_STATES[event.type];
    if (runState !== undefined) {
      const run = runs.get(event.runId);
      if (run !== undefined) {
        run.state = runState;
        run.revision += 1;
        run.updatedAt = event.occurredAt;
      }
    }
    if (event.type === 'turn.started' || event.type === 'model_attempt_committed') {
      const run = runs.get(event.runId);
      if (run !== undefined) {
        run.revision += 1;
        run.updatedAt = event.occurredAt;
      }
    }
    if (event.type === 'model_attempt_committed' && event.turnId !== undefined) {
      const validatedAttempt = structuredClone(event.payload.validatedAttempt);
      const correlations = structuredClone(event.payload.protocolEnvelope.correlations);
      const callIds = new Map(correlations.map((item) => [item.draftCallKey, item.callId]));
      const blocks: ModelContentBlock[] = validatedAttempt.blocks.map((block) => {
        if (block.type !== 'tool-call-draft') return structuredClone(block);
        const callId = callIds.get(block.draftCallKey);
        if (callId === undefined) {
          throw new TypeError(`Missing protocol correlation for ${block.draftCallKey}.`);
        }
        return {
          type: 'tool-call', callId, name: block.name, arguments: structuredClone(block.arguments),
        };
      });
      turns.set(event.turnId, {
        projectId: event.projectId,
        sessionId: event.sessionId,
        runId: event.runId,
        turnId: event.turnId,
        attemptId: validatedAttempt.attemptId,
        blocks,
        finishReason: validatedAttempt.finishReason ?? 'unknown',
        ...(validatedAttempt.usage === undefined
          ? {}
          : { usage: structuredClone(validatedAttempt.usage) }),
        protocolEnvelopeRef: event.payload.turn.protocolEnvelopeRef,
        committedAt: event.occurredAt,
      });
      envelopes.set(event.turnId, {
        schemaVersion: 1,
        attemptId: validatedAttempt.attemptId,
        origin: structuredClone(validatedAttempt.origin),
        correlations,
        opaqueBlockRefs: [...validatedAttempt.opaqueBlockRefs],
      });
      validatedAttempts.set(validatedAttempt.attemptId, validatedAttempt);
      attempts.set(validatedAttempt.attemptId, {
        projectId: event.projectId,
        runId: event.runId,
        turnId: event.turnId,
        attemptId: validatedAttempt.attemptId,
        status: 'committed',
        committedAt: event.occurredAt,
      });
    }
    if (
      event.type === 'tool.proposed' &&
      event.turnId !== undefined &&
      event.attemptId !== undefined
    ) {
      invocations.set(event.payload.invocationId, {
        projectId: event.projectId,
        sessionId: event.sessionId,
        runId: event.runId,
        turnId: event.turnId,
        attemptId: event.attemptId,
        invocationId: event.payload.invocationId,
        callId: event.payload.callId,
        actionOrdinal: event.payload.actionOrdinal,
        name: event.payload.name,
        arguments: structuredClone(event.payload.arguments),
        state: 'proposed',
        revision: 1,
        createdAt: event.occurredAt,
        updatedAt: event.occurredAt,
      });
      projectScheduledRunState(
        runs, invocations, event.runId, event.turnId, event.occurredAt,
        event.type,
      );
      continue;
    }
    const invocationId = event.invocationId;
    if (invocationId === undefined) continue;
    const invocation = invocations.get(invocationId);
    if (invocation === undefined) continue;
    const priorInvocationState = invocation.state;
    if (event.type === 'tool.validated') {
      invocation.state = 'validated';
      if (!('validationError' in event.payload)) {
        invocation.canonicalToolId = structuredClone(event.payload.canonicalToolId);
        invocation.toolRevision = event.payload.toolRevision;
        invocation.effect = event.payload.effect;
        invocation.normalizedArgumentsDigest = event.payload.normalizedArgumentsDigest;
        invocation.proposedRevision = event.payload.proposedRevision;
        if (event.payload.retryOf !== undefined) invocation.retryOf = event.payload.retryOf;
        if (event.payload.retryPermitId !== undefined) {
          invocation.retryPermitId = event.payload.retryPermitId;
        }
      }
    } else if (event.type === 'tool.approval_requested') {
      invocation.state = 'awaiting_approval';
      invocation.approvalId = event.payload.approval.approvalId;
      approvals.set(event.payload.approval.approvalId, structuredClone(event.payload.approval));
    } else if (event.type === 'tool.authorized') {
      invocation.state = 'authorized';
      invocation.approvalId = event.payload.approvalId;
      const approval = approvals.get(event.payload.approvalId);
      if (approval !== undefined) {
        approval.status = 'approved';
        approval.decidedAt = event.occurredAt;
      }
    } else if (event.type === 'tool.denied') {
      invocation.state = 'denied';
      invocation.approvalId = event.payload.approvalId;
      invocation.terminal = {
        kind: 'denied', summary: event.payload.reason, resultRefs: [], occurredAt: event.occurredAt,
      };
      const approval = approvals.get(event.payload.approvalId);
      if (approval !== undefined) {
        approval.status = 'denied';
        approval.decidedAt = event.occurredAt;
        approval.reason = event.payload.reason;
      }
    } else if (event.type === 'tool.started') {
      invocation.state = 'started';
      invocation.started = {
        idempotencyKey: event.payload.idempotencyKey,
        fencingToken: event.payload.fencingToken,
        attempt: event.payload.attempt,
        startedAt: event.occurredAt,
      };
    } else if (
      event.type === 'tool.succeeded' || event.type === 'tool.failed' ||
      event.type === 'tool.cancelled' || event.type === 'tool.outcome_unknown'
    ) {
      const kind = event.type.slice('tool.'.length) as
        'succeeded' | 'failed' | 'cancelled' | 'outcome_unknown';
      invocation.state = kind;
      invocation.terminal = {
        kind,
        summary: event.payload.summary,
        resultRefs: [...event.payload.resultRefs],
        ...(event.payload.durableSummary === undefined
          ? {}
          : { durableSummary: structuredClone(event.payload.durableSummary) }),
        ...(event.payload.modelProjection === undefined
          ? {}
          : { modelProjection: structuredClone(event.payload.modelProjection) }),
        ...(event.payload.userProjection === undefined
          ? {}
          : { userProjection: structuredClone(event.payload.userProjection) }),
        ...(event.payload.error === undefined
          ? {}
          : { error: structuredClone(event.payload.error) }),
        occurredAt: event.occurredAt,
      };
    } else if (event.type === 'tool.outcome_resolved') {
      const previousObservation = invocation.observation;
      if (previousObservation === undefined) {
        throw new TypeError('Outcome resolution requires an existing Tool Observation.');
      }
      invocation.state = 'observed';
      invocation.terminal = {
        kind: event.payload.outcome,
        summary: event.payload.summary,
        resultRefs: [...event.payload.resultRefs],
        ...(event.payload.durableSummary === undefined
          ? {}
          : { durableSummary: structuredClone(event.payload.durableSummary) }),
        ...(event.payload.modelProjection === undefined
          ? {}
          : { modelProjection: structuredClone(event.payload.modelProjection) }),
        ...(event.payload.userProjection === undefined
          ? {}
          : { userProjection: structuredClone(event.payload.userProjection) }),
        ...(event.payload.error === undefined
          ? {}
          : { error: structuredClone(event.payload.error) }),
        occurredAt: event.occurredAt,
      };
      invocation.observation = {
        observationId: previousObservation.observationId,
        invocationId: previousObservation.invocationId,
        summary: event.payload.summary,
        evidenceRefs: [...event.payload.resultRefs],
        outcome: event.payload.outcome,
        ...(event.payload.modelProjection === undefined
          ? {}
          : { modelProjection: structuredClone(event.payload.modelProjection) }),
        ...(event.payload.error === undefined ? {} : { errorCode: event.payload.error.code }),
        occurredAt: event.occurredAt,
      };
      invocation.outcomeResolution = {
        resolutionId: event.payload.resolutionId,
        decisionDigest: event.payload.decisionDigest,
        outcome: event.payload.outcome,
        resolvedAt: event.occurredAt,
      };
      observations.set(invocation.observation.observationId, {
        ...publicObservationProjection(invocation.observation),
        projectId: event.projectId,
        runId: event.runId,
        createdAt: event.occurredAt,
      });
    } else if (event.type === 'tool.observed') {
      invocation.state = 'observed';
      invocation.observation = { ...structuredClone(event.payload), occurredAt: event.occurredAt };
      observations.set(event.payload.observationId, {
        ...structuredClone(event.payload), projectId: event.projectId,
        runId: event.runId, createdAt: event.occurredAt,
      });
    } else if (event.type === 'tool.retry_authorized') {
      invocation.retryPermit = {
        permitId: event.payload.permitId,
        toolRevision: event.payload.toolRevision,
        effect: event.payload.effect,
        normalizedArgumentsDigest: event.payload.normalizedArgumentsDigest,
        reason: event.payload.reason,
      };
    } else {
      continue;
    }
    invocation.revision += 1;
    invocation.updatedAt = event.occurredAt;
    if (event.type !== 'tool.validated') {
      projectScheduledRunState(
        runs, invocations, event.runId, invocation.turnId, event.occurredAt,
        event.type, priorInvocationState,
      );
    }
  }

  return {
    runs: [...runs.values()].sort((a, b) => a.runId.localeCompare(b.runId)),
    turns: [...turns.values()].sort((a, b) => a.turnId.localeCompare(b.turnId)),
    attempts: [...attempts.values()].sort((a, b) => a.attemptId.localeCompare(b.attemptId)),
    invocations: [...invocations.values()].sort(
      (a, b) => a.runId.localeCompare(b.runId) || a.actionOrdinal - b.actionOrdinal,
    ),
    approvals: [...approvals.values()].sort((a, b) => a.approvalId.localeCompare(b.approvalId)),
    observations: [...observations.values()].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.observationId.localeCompare(b.observationId),
    ),
    envelopes: [...envelopes.values()].sort((a, b) => a.attemptId.localeCompare(b.attemptId)),
    validatedAttempts: [...validatedAttempts.values()].sort((a, b) => a.attemptId.localeCompare(b.attemptId)),
    lastSequenceByProject,
  };
}

function projectScheduledRunState(
  runs: ReadonlyMap<string, AgentRunProjection>,
  invocations: ReadonlyMap<string, AgentInvocationProjection>,
  runId: string,
  turnId: string,
  occurredAt: string,
  trigger: AgentEvent['type'],
  priorInvocationState?: AgentInvocationProjection['state'],
): void {
  const run = runs.get(runId);
  if (run === undefined) return;
  if (isProtectedReplayToolState(run.state, trigger, priorInvocationState)) return;
  const facts = [...invocations.values()]
    .filter((invocation) => invocation.runId === runId && invocation.turnId === turnId)
    .map(scheduledInvocationFact);
  run.state = runStateForSchedule(decideSchedule({
    invocations: facts,
    maxConcurrency: Number.MAX_SAFE_INTEGER,
  }));
  run.updatedAt = occurredAt;
}

function isProtectedReplayToolState(
  state: AgentRunState,
  trigger: AgentEvent['type'],
  priorInvocationState: AgentInvocationProjection['state'] | undefined,
): boolean {
  if (state === 'AwaitingUser') {
    const exactApprovalDecision =
      (trigger === 'tool.authorized' || trigger === 'tool.denied') &&
      priorInvocationState === 'awaiting_approval';
    return !exactApprovalDecision && trigger !== 'tool.outcome_resolved';
  }
  return state === 'Finalizing' || state === 'Cancelling' || state === 'LimitReached' ||
    state === 'Interrupted' || state === 'Completed' || state === 'Failed' ||
    state === 'Cancelled';
}

function scheduledInvocationFact(
  invocation: AgentInvocationProjection,
): ScheduledToolInvocation {
  if (invocation.state === 'validated') {
    throw new TypeError('A transient validated Tool state cannot be projected independently.');
  }
  return {
    invocationId: invocation.invocationId,
    actionOrdinal: invocation.actionOrdinal,
    effect: invocation.effect ?? 'unresolved',
    state: invocation.state,
  };
}

function publicObservationProjection(
  observation: ToolObservationFact & { occurredAt: string },
): ToolObservationFact {
  return {
    observationId: observation.observationId,
    invocationId: observation.invocationId,
    summary: observation.summary,
    evidenceRefs: [...observation.evidenceRefs],
    outcome: observation.outcome,
    ...(observation.modelProjection === undefined
      ? {}
      : { modelProjection: structuredClone(observation.modelProjection) }),
    ...(observation.errorCode === undefined ? {} : { errorCode: observation.errorCode }),
  };
}
