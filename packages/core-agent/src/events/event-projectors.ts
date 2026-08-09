import type {
  ModelContentBlock, ModelFinishReason, ModelProtocolEnvelope, ModelTokenUsage,
  ValidatedModelAttempt,
} from '@dbagent/core-llm';
import type { PortableValue } from '@dbagent/shared';
import type { AgentEvent, AgentRunState } from './agent-event.js';

export type AgentRunProjection = {
  projectId: string;
  sessionId: string;
  runId: string;
  clientRequestId: string;
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
  state: 'proposed';
  revision: number;
  createdAt: string;
};

export type AgentReplayProjection = {
  runs: AgentRunProjection[];
  turns: AgentTurnProjection[];
  attempts: AgentAttemptProjection[];
  invocations: AgentInvocationProjection[];
  envelopes: ModelProtocolEnvelope[];
  validatedAttempts: ValidatedModelAttempt[];
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
  const envelopes = new Map<string, ModelProtocolEnvelope>();
  const validatedAttempts = new Map<string, ValidatedModelAttempt>();
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
    if (event.type === 'model_attempt_committed' && event.turnId !== undefined) {
      turns.set(event.turnId, structuredClone(event.payload.turn));
      envelopes.set(event.turnId, structuredClone(event.payload.protocolEnvelope));
      validatedAttempts.set(event.payload.attemptId, structuredClone(event.payload.validatedAttempt));
      attempts.set(event.payload.attemptId, {
        projectId: event.projectId,
        runId: event.runId,
        turnId: event.turnId,
        attemptId: event.payload.attemptId,
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
      });
    }
  }

  return {
    runs: [...runs.values()].sort((a, b) => a.runId.localeCompare(b.runId)),
    turns: [...turns.values()].sort((a, b) => a.turnId.localeCompare(b.turnId)),
    attempts: [...attempts.values()].sort((a, b) => a.attemptId.localeCompare(b.attemptId)),
    invocations: [...invocations.values()].sort(
      (a, b) => a.runId.localeCompare(b.runId) || a.actionOrdinal - b.actionOrdinal,
    ),
    envelopes: [...envelopes.values()].sort((a, b) => a.attemptId.localeCompare(b.attemptId)),
    validatedAttempts: [...validatedAttempts.values()].sort((a, b) => a.attemptId.localeCompare(b.attemptId)),
    lastSequenceByProject,
  };
}
