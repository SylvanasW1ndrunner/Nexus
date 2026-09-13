import type { PreparedToolIntent } from '../tools/tool-protocol.js';
import type { ToolQuestionBundle } from '../tools/tool-question.js';
import type {
  ModelContentBlock, ModelFinishReason, ModelProtocolEnvelope, ModelTokenUsage,
} from '@dbagent/core-llm';
import type { PortableValue } from '@dbagent/shared';
import type { AgentToolAuditEvidence, AgentToolCompletionEvidence } from '../types.js';
import type {
  AgentEvent,
  AgentRunState,
  CanonicalToolIdFact,
  PersistedValidatedAttempt,
  ToolApprovalFact,
  ToolRecoveryClassFact,
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
  parent?: Readonly<{ runId: string; turnId: string; invocationId: string }>;
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
    | 'prepared'
    | 'waiting_for_user'
    | 'timed_out'
    | 'unsupported_revision'
    | 'awaiting_approval'
    | 'authorized'
    | 'denied'
    | 'started'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'unknown'
    | 'observed';
  revision: number;
  canonicalToolId?: CanonicalToolIdFact;
  toolRevision?: string;
  catalogRevision?: string;
  intent?: PreparedToolIntent;
  deadline?: string;
  question?: ToolQuestionBundle;
  recoveryClass?: ToolRecoveryClassFact;
  intentDigest?: string;
  proposedRevision?: number;
  approvalId?: string;
  retryOf?: string;
  retryPermitId?: string;
  retryPermit?: {
    permitId: string;
    toolRevision: string;
    recoveryClass: ToolRecoveryClassFact;
    intentDigest: string;
    reason: string;
  };
  outcomeResolution?: {
    resolutionId: string;
    decisionDigest: string;
    outcome: 'succeeded' | 'failed';
    resolvedAt: string;
  };
  started?: {
    intentDigest: string;
    idempotencyKey: string;
    fencingToken: number;
    attempt: number;
    runRevision: number;
    startedAt: string;
  };
  terminal?: {
    kind: 'succeeded' | 'failed' | 'cancelled' | 'unknown' | 'denied' | 'timed_out' | 'unsupported_revision';
    summary: string;
    resultRefs: string[];
    evidenceRefs: string[];
    durableSummary?: PortableValue;
    modelProjection?: PortableValue;
    userProjection?: PortableValue;
    auditEvidence?: AgentToolAuditEvidence;
    completionEvidence?: AgentToolCompletionEvidence;
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
  'run.steered': 'Preparing',
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
        ...(event.payload.parent === undefined
          ? {}
          : { parent: structuredClone(event.payload.parent) }),
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
    if (event.type === 'run.resumed') {
      const run = runs.get(event.runId);
      if (run !== undefined) {
        run.state = event.payload.resumeState;
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
    if (
      event.type === 'turn.closed' &&
      (event.payload.reason === 'observed' || event.payload.reason === 'revision-requested')
    ) {
      const run = runs.get(event.runId);
      if (run !== undefined) {
        run.state = 'Preparing';
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
      const run = runs.get(event.runId);
      if (run !== undefined) {
        run.state = validatedAttempt.blocks.some((block) => block.type === 'tool-call-draft')
          ? 'ResolvingActions'
          : 'Finalizing';
      }
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
      continue;
    }
    if (event.type === 'tool.transition_committed') {
      const facts = [...invocations.values()]
        .filter((invocation) => invocation.runId === event.runId && invocation.turnId === event.turnId)
        .map(scheduledInvocationFact);
      const derived = decideSchedule({
        invocations: facts,
        maxConcurrency: Number.MAX_SAFE_INTEGER,
      });
      if (canonicalJson(derived) !== canonicalJson(event.payload.schedule)) {
        throw new TypeError('Persisted Tool transition schedule disagrees with Tool facts.');
      }
      const run = runs.get(event.runId);
      if (run !== undefined) {
        if (!isProtectedReplayToolTransition(run.state, event.payload.action)) {
          run.state = runStateForSchedule(derived);
        }
        run.revision += 1;
        run.updatedAt = event.occurredAt;
      }
      continue;
    }
    const invocationId = event.invocationId;
    if (invocationId === undefined) continue;
    const invocation = invocations.get(invocationId);
    if (invocation === undefined) continue;
    if (event.type === 'tool.prepared') {
      invocation.state = 'prepared';
      if (!('validationError' in event.payload)) {
        invocation.intent = structuredClone(event.payload.intent);
        invocation.deadline = event.payload.deadline;
        invocation.catalogRevision = event.payload.catalogRevision;
        invocation.canonicalToolId = structuredClone(event.payload.canonicalToolId);
        invocation.toolRevision = event.payload.toolRevision;
        invocation.recoveryClass = event.payload.recoveryClass;
        invocation.intentDigest = event.payload.intentDigest;
        invocation.proposedRevision = event.payload.proposedRevision;
        if (event.payload.retryOf !== undefined) invocation.retryOf = event.payload.retryOf;
        if (event.payload.retryPermitId !== undefined) {
          invocation.retryPermitId = event.payload.retryPermitId;
        }
      }
    } else if (event.type === 'tool.permission_evaluated') {
      if (event.payload.retryOf !== undefined) invocation.retryOf = event.payload.retryOf;
      if (event.payload.retryPermitId !== undefined) invocation.retryPermitId = event.payload.retryPermitId;
    } else if (event.type === 'tool.waiting_for_user') {
      invocation.state = 'waiting_for_user';
      invocation.question = structuredClone(event.payload.bundle);
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
        approval.decidedAt = event.payload.decision?.decidedAt ?? event.occurredAt;
        if (event.payload.decision?.decidedBy !== undefined) {
          approval.decidedBy = event.payload.decision.decidedBy;
        }
        if (event.payload.decision?.reason !== undefined) {
          approval.reason = event.payload.decision.reason;
        }
      }
    } else if (event.type === 'tool.denied') {
      invocation.state = 'denied';
      invocation.approvalId = event.payload.approvalId;
      invocation.terminal = {
        kind: 'denied', summary: event.payload.reason, resultRefs: [], evidenceRefs: [],
        occurredAt: event.occurredAt,
      };
      const approval = approvals.get(event.payload.approvalId);
      if (approval !== undefined) {
        approval.status = 'denied';
        approval.decidedAt = event.payload.decision?.decidedAt ?? event.occurredAt;
        approval.reason = event.payload.decision?.reason ?? event.payload.reason;
        if (event.payload.decision?.decidedBy !== undefined) {
          approval.decidedBy = event.payload.decision.decidedBy;
        }
      }
    } else if (event.type === 'tool.started') {
      invocation.state = 'started';
      invocation.started = {
        intentDigest: event.payload.intentDigest,
        idempotencyKey: event.payload.idempotencyKey,
        fencingToken: event.payload.fencingToken,
        attempt: event.payload.attempt,
        runRevision: event.payload.runRevision,
        startedAt: event.occurredAt,
      };
    } else if (
      event.type === 'tool.succeeded' || event.type === 'tool.failed' ||
      event.type === 'tool.cancelled' || event.type === 'tool.unknown' ||
      event.type === 'tool.timed_out' || event.type === 'tool.unsupported_revision'
    ) {
      const kind = event.type.slice('tool.'.length) as
        'succeeded' | 'failed' | 'cancelled' | 'unknown' | 'timed_out' | 'unsupported_revision';
      invocation.state = kind;
      invocation.terminal = {
        kind,
        summary: event.payload.summary,
        resultRefs: [...event.payload.resultRefs],
        evidenceRefs: [...event.payload.evidenceRefs],
        ...(event.payload.durableSummary === undefined
          ? {}
          : { durableSummary: structuredClone(event.payload.durableSummary) }),
        ...(event.payload.modelProjection === undefined
          ? {}
          : { modelProjection: structuredClone(event.payload.modelProjection) }),
        ...(event.payload.userProjection === undefined
          ? {}
          : { userProjection: structuredClone(event.payload.userProjection) }),
        ...(event.payload.auditEvidence === undefined
          ? {}
          : { auditEvidence: structuredClone(event.payload.auditEvidence) }),
        ...(event.payload.completionEvidence === undefined
          ? {}
          : { completionEvidence: structuredClone(event.payload.completionEvidence) }),
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
        evidenceRefs: [...event.payload.evidenceRefs],
        ...(event.payload.durableSummary === undefined
          ? {}
          : { durableSummary: structuredClone(event.payload.durableSummary) }),
        ...(event.payload.modelProjection === undefined
          ? {}
          : { modelProjection: structuredClone(event.payload.modelProjection) }),
        ...(event.payload.userProjection === undefined
          ? {}
          : { userProjection: structuredClone(event.payload.userProjection) }),
        ...(event.payload.auditEvidence === undefined
          ? {}
          : { auditEvidence: structuredClone(event.payload.auditEvidence) }),
        ...(event.payload.completionEvidence === undefined
          ? {}
          : { completionEvidence: structuredClone(event.payload.completionEvidence) }),
        ...(event.payload.error === undefined
          ? {}
          : { error: structuredClone(event.payload.error) }),
        occurredAt: event.occurredAt,
      };
      invocation.observation = {
        observationId: previousObservation.observationId,
        invocationId: previousObservation.invocationId,
        summary: event.payload.summary,
        evidenceRefs: [...new Set([
          ...event.payload.resultRefs,
          ...event.payload.evidenceRefs,
        ])],
        outcome: event.payload.outcome,
        ...(event.payload.modelProjection === undefined
          ? {}
          : { modelProjection: structuredClone(event.payload.modelProjection) }),
        ...(event.payload.auditEvidence === undefined
          ? {}
          : { auditEvidence: structuredClone(event.payload.auditEvidence) }),
        ...(event.payload.completionEvidence === undefined
          ? {}
          : { completionEvidence: structuredClone(event.payload.completionEvidence) }),
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
        recoveryClass: event.payload.recoveryClass,
        intentDigest: event.payload.intentDigest,
        reason: event.payload.reason,
      };
    } else {
      continue;
    }
    invocation.revision += 1;
    invocation.updatedAt = event.occurredAt;
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

function isProtectedReplayToolTransition(
  state: AgentRunState,
  action: Extract<AgentEvent, { type: 'tool.transition_committed' }>['payload']['action'],
): boolean {
  if (state === 'AwaitingUser') {
    return action !== 'decide-approval' && action !== 'resolve-outcome' && action !== 'settle-question';
  }
  return state === 'Finalizing' || state === 'Cancelling' || state === 'LimitReached' ||
    state === 'Interrupted' || state === 'Completed' || state === 'Failed' ||
    state === 'Cancelled';
}

function scheduledInvocationFact(
  invocation: AgentInvocationProjection,
): ScheduledToolInvocation {

  return {
    invocationId: invocation.invocationId,
    actionOrdinal: invocation.actionOrdinal,
    recoveryClass: invocation.recoveryClass ?? 'unresolved',
    access: invocation.intent?.access ?? 'external',
    concurrency: invocation.intent?.concurrency ?? 'exclusive',
    resourceKeys: invocation.intent?.resourceKeys ?? [],
    state: invocation.state,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('Tool schedule contains a non-JSON value.');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
  ).join(',')}}`;
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
    ...(observation.auditEvidence === undefined
      ? {}
      : { auditEvidence: structuredClone(observation.auditEvidence) }),
    ...(observation.completionEvidence === undefined
      ? {}
      : { completionEvidence: structuredClone(observation.completionEvidence) }),
    ...(observation.errorCode === undefined ? {} : { errorCode: observation.errorCode }),
  };
}
