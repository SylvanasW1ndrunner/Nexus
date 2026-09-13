import type { AgentResumableState, AgentRunState } from '../events/agent-event.js';
import type { ToolScheduleDecision } from '../tools/tool-scheduler.js';

export type AgentWaitReason =
  | 'tool_input'
  | 'approval'
  | 'input_required'
  | 'outcome_resolution'
  | 'model_connection_required'
  | 'capability_revision_required';

type NonWaitingAgentRunState = Exclude<AgentRunState, 'AwaitingUser'>;

export type AgentRunStateSnapshot =
  | Readonly<{ state: NonWaitingAgentRunState }>
  | Readonly<{ state: 'AwaitingUser'; waitReason: AgentWaitReason }>;

export type AgentStateSignal =
  | Readonly<{ type: 'run-started' }>
  | Readonly<{ type: 'turn-captured' }>
  | Readonly<{ type: 'run-steered' }>
  | Readonly<{ type: 'context-compaction-required'; coveredSequence?: number }>
  | Readonly<{ type: 'context-compacted'; coveredSequence?: number }>
  | Readonly<{ type: 'context-ready' }>
  | Readonly<{ type: 'model-attempt-started' }>
  | Readonly<{ type: 'model-attempt-discarded' }>
  | Readonly<{ type: 'model-attempt-committed'; hasActions: boolean }>
  | Readonly<{ type: 'model-turn-completed'; hasActions: boolean }>
  | Readonly<{ type: 'schedule-decided'; decision: ToolScheduleDecision }>
  | Readonly<{ type: 'turn-observed' }>
  | Readonly<{ type: 'delivery-revision-requested' }>
  | Readonly<{ type: 'outcome-resolution-required' }>
  | Readonly<{ type: 'delivery-accepted' }>
  | Readonly<{ type: 'input-required'; reason: AgentWaitReason }>
  | Readonly<{ type: 'input-supplied' }>
  | Readonly<{ type: 'cancel-requested' }>
  | Readonly<{ type: 'cancellation-pending' }>
  | Readonly<{ type: 'cancellation-settled' }>
  | Readonly<{ type: 'manual-compaction-queued' }>
  | Readonly<{ type: 'no-progress-recorded' }>
  | Readonly<{ type: 'limit-reached' }>
  | Readonly<{
      type: 'run-resumed';
      resumeState: AgentResumableState;
    }>
  | Readonly<{ type: 'interrupted' }>
  | Readonly<{ type: 'failed' }>;

export type AgentStateMachineErrorCode = 'RUN_PROJECTION_INVALID';

export class AgentStateMachineError extends Error {
  constructor(
    readonly code: AgentStateMachineErrorCode,
    message: string,
    readonly detail?: Readonly<Record<string, string | number | boolean | null>>,
  ) {
    super(message);
    this.name = 'AgentStateMachineError';
  }
}

export type AgentRunCompletionProjection = Readonly<{
  current: AgentRunStateSnapshot;
  openAttempt: boolean;
  pendingApproval: boolean;
  pendingInput: boolean;
  unresolvedOutcomes: number;
  committedInvocationCount: number;
  observationCount: number;
  finalContentRef: string | null;
  delivery: Readonly<{
    status: 'not-required' | 'verified' | 'unverified';
    evidenceRevision: number;
  }> | null;
}>;

const TERMINAL_STATES = new Set<AgentRunState>(['Completed', 'Failed', 'Cancelled']);
const CANCELLABLE_STATES = new Set<AgentRunState>([
  'created',
  'Preparing',
  'Compacting',
  'CallingModel',
  'ReceivingModel',
  'ResolvingActions',
  'AwaitingUser',
  'ExecutingTools',
  'ApplyingObservations',
  'Finalizing',
  'LimitReached',
  'Interrupted',
]);
const LIMITABLE_STATES = new Set<AgentRunState>([
  'Preparing',
  'Compacting',
  'CallingModel',
  'ReceivingModel',
  'ResolvingActions',
  'AwaitingUser',
  'ExecutingTools',
  'ApplyingObservations',
  'Finalizing',
]);

/**
 * Pure transition reducer. It consumes only committed, typed lifecycle facts;
 * it never inspects model prose, Tool names, SQL, or exception messages.
 */
export function transitionAgentRunState(
  current: AgentRunStateSnapshot,
  signal: AgentStateSignal,
): AgentRunStateSnapshot {
  if (TERMINAL_STATES.has(current.state)) return invalidTransition(current, signal);
  if (signal.type === 'cancel-requested' && CANCELLABLE_STATES.has(current.state)) {
    return { state: 'Cancelling' };
  }
  if (signal.type === 'limit-reached' && LIMITABLE_STATES.has(current.state)) {
    return { state: 'LimitReached' };
  }
  if (signal.type === 'interrupted' && current.state !== 'Cancelling') {
    return { state: 'Interrupted' };
  }
  if (signal.type === 'failed') return { state: 'Failed' };
  if (signal.type === 'manual-compaction-queued' && current.state !== 'Cancelling') {
    return current;
  }

  switch (current.state) {
    case 'created':
      return signal.type === 'run-started'
        ? { state: 'Preparing' }
        : invalidTransition(current, signal);
    case 'Preparing':
      if (signal.type === 'turn-captured' || signal.type === 'run-steered') return current;
      if (signal.type === 'no-progress-recorded') return current;
      if (signal.type === 'context-compaction-required') return { state: 'Compacting' };
      if (signal.type === 'context-ready') return { state: 'CallingModel' };
      if (signal.type === 'input-required') {
        return { state: 'AwaitingUser', waitReason: signal.reason };
      }
      return invalidTransition(current, signal);
    case 'Compacting':
      return signal.type === 'context-compacted'
        ? { state: 'Preparing' }
        : invalidTransition(current, signal);
    case 'CallingModel':
      if (signal.type === 'model-turn-completed') {
        return { state: signal.hasActions ? 'ResolvingActions' : 'Finalizing' };
      }
      if (signal.type === 'model-attempt-started') return { state: 'ReceivingModel' };
      if (signal.type === 'input-required') {
        return { state: 'AwaitingUser', waitReason: signal.reason };
      }
      return invalidTransition(current, signal);
    case 'ReceivingModel':
      if (signal.type === 'model-attempt-discarded') return { state: 'CallingModel' };
      if (signal.type === 'model-attempt-committed') {
        return { state: signal.hasActions ? 'ResolvingActions' : 'Finalizing' };
      }
      if (signal.type === 'input-required') {
        return { state: 'AwaitingUser', waitReason: signal.reason };
      }
      return invalidTransition(current, signal);
    case 'ResolvingActions':
    case 'ExecutingTools':
    case 'ApplyingObservations':
      if (signal.type === 'schedule-decided') return stateFromSchedule(signal.decision);
      if (current.state === 'ApplyingObservations' && signal.type === 'turn-observed') {
        return { state: 'Preparing' };
      }
      if (
        current.state === 'ApplyingObservations' &&
        signal.type === 'outcome-resolution-required'
      ) {
        return { state: 'AwaitingUser', waitReason: 'outcome_resolution' };
      }
      return invalidTransition(current, signal);
    case 'AwaitingUser':
      if (signal.type === 'schedule-decided') return stateFromSchedule(signal.decision);
      if (signal.type === 'input-supplied') return { state: 'Preparing' };
      if (
        signal.type === 'outcome-resolution-required' &&
        current.waitReason === 'outcome_resolution'
      ) return current;
      if (signal.type === 'run-resumed') return { state: signal.resumeState };
      return invalidTransition(current, signal);
    case 'Finalizing':
      if (signal.type === 'run-steered') return { state: 'Preparing' };
      if (signal.type === 'delivery-revision-requested') return { state: 'Preparing' };
      if (signal.type === 'outcome-resolution-required') {
        return { state: 'AwaitingUser', waitReason: 'outcome_resolution' };
      }
      if (signal.type === 'delivery-accepted') return { state: 'Completed' };
      return invalidTransition(current, signal);
    case 'Cancelling':
      if (signal.type === 'cancellation-pending') return current;
      return signal.type === 'cancellation-settled'
        ? { state: 'Cancelled' }
        : invalidTransition(current, signal);
    case 'LimitReached':
    case 'Interrupted':
      return signal.type === 'run-resumed'
        ? { state: signal.resumeState }
        : invalidTransition(current, signal);
    case 'Completed':
    case 'Failed':
    case 'Cancelled':
      return invalidTransition(current, signal);
  }
}

/** Finalization guard over one immutable committed projection snapshot. */
export function deriveAgentRunState(
  projection: AgentRunCompletionProjection,
): AgentRunStateSnapshot {
  requireFinalizationProjection(projection);
  if (projection.pendingApproval) return { state: 'AwaitingUser', waitReason: 'approval' };
  if (projection.pendingInput) return { state: 'AwaitingUser', waitReason: 'input_required' };
  if (projection.unresolvedOutcomes > 0) {
    return { state: 'AwaitingUser', waitReason: 'outcome_resolution' };
  }
  if (projection.openAttempt) {
    throw invalidProjection('A Run with an uncommitted Attempt cannot complete.');
  }
  if (projection.observationCount !== projection.committedInvocationCount) {
    throw invalidProjection('Every committed Invocation requires exactly one Observation.');
  }
  if (projection.finalContentRef === null || projection.finalContentRef.trim() === '') {
    throw invalidProjection('Final content must be a committed bounded content or Artifact reference.');
  }
  if (projection.delivery === null) {
    throw invalidProjection('Final delivery decision is missing.');
  }
  return { state: 'Completed' };
}

function stateFromSchedule(decision: ToolScheduleDecision): AgentRunStateSnapshot {
  switch (decision.state) {
    case 'ResolvingActions': return { state: 'ResolvingActions' };
    case 'AwaitingUser': return { state: 'AwaitingUser', waitReason: decision.reason };
    case 'ExecutingTools': return { state: 'ExecutingTools' };
    case 'ApplyingObservations': return { state: 'ApplyingObservations' };
    case 'TurnReadyToClose': return { state: 'ApplyingObservations' };
  }
}

function requireFinalizationProjection(projection: AgentRunCompletionProjection): void {
  if (projection.current.state !== 'Finalizing') {
    throw invalidProjection('Delivery completion may be derived only from Finalizing.');
  }
  for (const [label, value] of [
    ['unresolvedOutcomes', projection.unresolvedOutcomes],
    ['committedInvocationCount', projection.committedInvocationCount],
    ['observationCount', projection.observationCount],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw invalidProjection(`${label} must be a non-negative safe integer.`);
    }
  }
  if (
    projection.delivery !== null &&
    (!Number.isSafeInteger(projection.delivery.evidenceRevision) ||
      projection.delivery.evidenceRevision < 0)
  ) {
    throw invalidProjection('Delivery evidence revision must be a non-negative safe integer.');
  }
}

function invalidTransition(
  current: AgentRunStateSnapshot,
  signal: AgentStateSignal,
): never {
  throw new AgentStateMachineError(
    'RUN_PROJECTION_INVALID',
    `Invalid Agent Run transition: ${current.state} + ${signal.type}.`,
    { state: current.state, signal: signal.type },
  );
}

function invalidProjection(message: string): AgentStateMachineError {
  return new AgentStateMachineError('RUN_PROJECTION_INVALID', message);
}
