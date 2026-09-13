import type { ToolRecoveryClass, ToolAccess } from './tool-protocol.js';

export type ScheduledToolRecoveryClass = ToolRecoveryClass | 'unresolved';

export type ToolInvocationScheduleState =
  | 'prepared'
  | 'waiting_for_user'
  | 'timed_out'
  | 'unsupported_revision'
  | 'proposed'
  | 'awaiting_approval'
  | 'authorized'
  | 'denied'
  | 'started'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'unknown'
  | 'observed';

export type ScheduledToolInvocation = Readonly<{
  invocationId: string;
  actionOrdinal: number;
  recoveryClass: ScheduledToolRecoveryClass;
  access: ToolAccess;
  concurrency: 'read' | 'write' | 'exclusive';
  resourceKeys: readonly string[];
  state: ToolInvocationScheduleState;
}>;

export type ToolScheduleSnapshot = Readonly<{
  invocations: readonly ScheduledToolInvocation[];
  maxConcurrency: number;
}>;

export type ToolScheduleDecision =
  | { state: 'ResolvingActions'; invocationIds: string[] }
  | { state: 'AwaitingUser'; reason: 'approval' | 'tool_input'; invocationIds: string[] }
  | { state: 'ExecutingTools'; invocationIds: string[] }
  | { state: 'ApplyingObservations'; invocationIds: string[] }
  | { state: 'TurnReadyToClose'; invocationIds: [] };

export type ToolScheduleRunState =
  | 'ResolvingActions'
  | 'AwaitingUser'
  | 'ExecutingTools'
  | 'ApplyingObservations'
  | 'Finalizing';

export type ToolScheduleErrorCode =
  | 'INVALID_CONCURRENCY'
  | 'INVALID_INVOCATION'
  | 'DUPLICATE_INVOCATION_ID'
  | 'DUPLICATE_ACTION_ORDINAL'
  | 'INVALID_INVOCATION_STATE';

export class ToolScheduleError extends Error {
  constructor(readonly code: ToolScheduleErrorCode, message: string) {
    super(message);
    this.name = 'ToolScheduleError';
  }
}

const TERMINAL_UNOBSERVED = new Set<ToolInvocationScheduleState>([
  'denied', 'succeeded', 'failed', 'cancelled', 'unknown', 'timed_out', 'unsupported_revision',
]);

const VALID_STATES = new Set<ToolInvocationScheduleState>([
  'proposed', 'prepared', 'waiting_for_user', 'timed_out', 'unsupported_revision', 'awaiting_approval', 'authorized', 'denied', 'started',
  'succeeded', 'failed', 'cancelled', 'unknown', 'observed',
]);

const VALID_EFFECTS = new Set<ScheduledToolRecoveryClass>([
  'read', 'idempotent', 'transactional', 'non_idempotent', 'unresolved',
]);

/**
 * Pure scheduler for one committed Turn. It reads immutable invocation facts
 * and returns one decision; it never invokes a Handler or changes the input.
 */
export function decideSchedule(snapshot: ToolScheduleSnapshot): ToolScheduleDecision {
  validateSnapshot(snapshot);
  const ordered = [...snapshot.invocations].sort(
    (left, right) => left.actionOrdinal - right.actionOrdinal,
  );
  const firstPendingIndex = ordered.findIndex(({ state }) => state !== 'observed');
  if (firstPendingIndex < 0) return { state: 'TurnReadyToClose', invocationIds: [] };

  const first = ordered[firstPendingIndex];
  if (first === undefined) return { state: 'TurnReadyToClose', invocationIds: [] };
  const window = parallelRead(first)
    ? contiguousReadWindow(ordered, firstPendingIndex)
    : [first];

  const terminalPrefix: ScheduledToolInvocation[] = [];
  for (const invocation of ordered.slice(firstPendingIndex)) {
    if (invocation.state === 'observed') continue;
    if (!TERMINAL_UNOBSERVED.has(invocation.state)) break;
    terminalPrefix.push(invocation);
  }
  if (terminalPrefix.length > 0) return { state: 'ApplyingObservations', invocationIds: ids(terminalPrefix) };
  const running = window.filter(({ state }) => state === 'started');
  if (running.length > 0) {
    return { state: 'ExecutingTools', invocationIds: ids(running) };
  }
  const proposed = window.filter(({ state }) => state === 'proposed' || state === 'prepared');
  if (proposed.length > 0) {
    return { state: 'ResolvingActions', invocationIds: ids(proposed) };
  }
  const authorized = window.filter(({ state }) => state === 'authorized');
  if (authorized.length > 0) {
    return {
      state: 'ExecutingTools',
      invocationIds: ids(authorized.slice(0, snapshot.maxConcurrency)),
    };
  }
  const waiting = window.filter(({ state }) => state === 'waiting_for_user');
  if (waiting.length) return { state: 'AwaitingUser', reason: 'tool_input', invocationIds: ids(waiting) };
  const awaitingApproval = window.filter(({ state }) => state === 'awaiting_approval');
  if (awaitingApproval.length > 0) {
    return {
      state: 'AwaitingUser', reason: 'approval', invocationIds: ids(awaitingApproval),
    };
  }
  throw new ToolScheduleError(
    'INVALID_INVOCATION_STATE',
    'The eligible Tool window cannot be reduced to one authoritative decision.',
  );
}

/**
 * Projects the scheduler decision into the durable Run aggregate. Keeping this
 * mapping beside the pure scheduler prevents online and replay projections from
 * growing independent lifecycle algorithms.
 */
export function runStateForSchedule(decision: ToolScheduleDecision): ToolScheduleRunState {
  return decision.state === 'TurnReadyToClose' ? 'ApplyingObservations' : decision.state;
}

function contiguousReadWindow(
  ordered: readonly ScheduledToolInvocation[],
  start: number,
): ScheduledToolInvocation[] {
  const window: ScheduledToolInvocation[] = [];
  const keys = new Set<string>();
  for (let index = start; index < ordered.length; index += 1) {
    const invocation = ordered[index];
    if (invocation === undefined || !parallelRead(invocation)) break;
    if (invocation.state !== 'observed') {
      if (invocation.resourceKeys.some(key => keys.has(key))) break;
      window.push(invocation);
      invocation.resourceKeys.forEach(key => keys.add(key));
    }
    // An unresolved approval is an ordering boundary inside a read window.
    // Earlier authorized reads may still run, but no later Action can cross it.
    if (invocation.state === 'awaiting_approval' || invocation.state === 'waiting_for_user' || invocation.state === 'proposed' || invocation.state === 'prepared') break;
  }
  return window;
}

function parallelRead(invocation: ScheduledToolInvocation): boolean {
  return invocation.access === 'read' && invocation.concurrency === 'read' && invocation.resourceKeys.length > 0;
}

function ids(invocations: readonly ScheduledToolInvocation[]): string[] {
  return invocations.map(({ invocationId }) => invocationId);
}

function validateSnapshot(snapshot: ToolScheduleSnapshot): void {
  const invocations = snapshot.invocations;
  if (!Number.isSafeInteger(snapshot.maxConcurrency) || snapshot.maxConcurrency < 1) {
    throw new ToolScheduleError(
      'INVALID_CONCURRENCY', 'Tool maxConcurrency must be a positive safe integer.',
    );
  }
  if (!Array.isArray(snapshot.invocations)) {
    throw new ToolScheduleError('INVALID_INVOCATION', 'Tool invocations must be an array.');
  }
  const invocationIds = new Set<string>();
  const ordinals = new Set<number>();
  for (const invocation of invocations) {
    if (
      invocation === null || typeof invocation !== 'object' ||
      typeof invocation.invocationId !== 'string' || invocation.invocationId.trim() === '' ||
      !Number.isSafeInteger(invocation.actionOrdinal) || invocation.actionOrdinal < 0 ||
      !['read', 'write', 'external', 'destructive'].includes(invocation.access) ||
      !['read', 'write', 'exclusive'].includes(invocation.concurrency) || !Array.isArray(invocation.resourceKeys) ||
      !VALID_EFFECTS.has(invocation.recoveryClass) || !VALID_STATES.has(invocation.state)
    ) {
      throw new ToolScheduleError('INVALID_INVOCATION', 'Tool scheduling fact is invalid.');
    }
    if (invocationIds.has(invocation.invocationId)) {
      throw new ToolScheduleError(
        'DUPLICATE_INVOCATION_ID', 'Tool scheduling facts contain a duplicate Invocation ID.',
      );
    }
    if (ordinals.has(invocation.actionOrdinal)) {
      throw new ToolScheduleError(
        'DUPLICATE_ACTION_ORDINAL', 'Tool scheduling facts contain a duplicate action ordinal.',
      );
    }
    invocationIds.add(invocation.invocationId);
    ordinals.add(invocation.actionOrdinal);
  }
}
