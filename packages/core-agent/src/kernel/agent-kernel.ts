import { createHash } from 'node:crypto';
import type { PortableValue } from '@dbagent/shared';
import {
  transitionAgentRunState,
  type AgentRunStateSnapshot,
  type AgentStateSignal,
  type AgentWaitReason,
} from './agent-state-machine.js';
import type { KernelRunProjection } from './run-controller.js';

export type StartRunInput = Readonly<{
  projectId: string;
  sessionId: string;
  clientRequestId: string;
  input: PortableValue;
}>;
export type SteerRunInput = Readonly<{
  runId: string; clientRequestId: string; input: PortableValue;
}>;
export type CancelRunInput = Readonly<{ runId: string; reason?: string }>;
export type ResumeRunInput = Readonly<{ runId: string; reason?: string }>;
export type ApproveRunInput = Readonly<{
  runId: string;
  approvalId: string;
  decision: 'approve' | 'deny';
  reason?: string;
}>;
export type ManualCompactionInput = Readonly<{ runId: string }>;

export type AgentPendingRequest =
  | Readonly<{ kind: 'approval'; requestId: string; invocationId: string }>
  | Readonly<{ kind: 'input'; requestId: string; reason: AgentWaitReason }>;

export type AgentRunLimits = Readonly<{
  maxTurns?: number;
  deadlineAt?: string;
  maxCostMicrounits?: number;
}>;

export type AdvanceRunOptions = Readonly<{ limits?: AgentRunLimits }>;

export type AgentKernelEffect = Readonly<{
  run: KernelRunProjection;
  signal: AgentStateSignal;
}>;

export interface AgentKernel {
  start(input: StartRunInput): Promise<KernelRunProjection>;
  open(runId: string): Promise<KernelRunProjection>;
  advance(runId: string, options?: AdvanceRunOptions): Promise<KernelRunProjection>;
  pending(runId: string): Promise<readonly AgentPendingRequest[]>;
  steer(input: SteerRunInput): Promise<KernelRunProjection>;
  approve(input: ApproveRunInput): Promise<KernelRunProjection>;
  cancel(input: CancelRunInput): Promise<KernelRunProjection>;
  resume(input: ResumeRunInput): Promise<KernelRunProjection>;
  requestManualCompaction(input: ManualCompactionInput): Promise<KernelRunProjection>;
}

/** Stateful effects are narrow ports; every committed transition returns a typed state signal. */
export interface AgentKernelPort {
  start(input: StartRunInput): Promise<KernelRunProjection>;
  read(runId: string): Promise<KernelRunProjection>;
  prepare(run: KernelRunProjection): Promise<AgentKernelEffect>;
  callModel(run: KernelRunProjection): Promise<AgentKernelEffect>;
  runTools(run: KernelRunProjection): Promise<AgentKernelEffect>;
  finalize(run: KernelRunProjection): Promise<AgentKernelEffect>;
  settleCancellation(run: KernelRunProjection): Promise<AgentKernelEffect>;
  steer(input: SteerRunInput, run: KernelRunProjection): Promise<AgentKernelEffect>;
  approve(input: ApproveRunInput, run: KernelRunProjection): Promise<AgentKernelEffect>;
  cancel(input: CancelRunInput, run: KernelRunProjection): Promise<AgentKernelEffect>;
  resume(input: ResumeRunInput, run: KernelRunProjection): Promise<AgentKernelEffect>;
  requestManualCompaction(
    input: ManualCompactionInput,
    run: KernelRunProjection,
    mode: 'queue' | 'start',
  ): Promise<AgentKernelEffect>;
  recordNoProgress(
    run: KernelRunProjection,
    input: Readonly<{ fingerprint: string }>,
  ): Promise<AgentKernelEffect>;
  listPending(run: KernelRunProjection): Promise<readonly AgentPendingRequest[]>;
  checkLimits(
    run: KernelRunProjection,
    limits: AgentRunLimits,
  ): Promise<AgentKernelEffect | null>;
}

export class AgentKernelError extends Error {
  constructor(
    readonly code: 'KERNEL_NO_PROGRESS' | 'KERNEL_PROJECTION_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'AgentKernelError';
  }
}

const PASSIVE = new Set<KernelRunProjection['state']>([
  'AwaitingUser', 'LimitReached', 'Interrupted', 'Completed', 'Failed', 'Cancelled',
]);

export class JournalDrivenAgentKernel implements AgentKernel {
  readonly #port: AgentKernelPort;

  constructor(options: Readonly<{ port: AgentKernelPort }>) {
    this.#port = options.port;
  }

  async start(input: StartRunInput): Promise<KernelRunProjection> {
    const run = await this.#port.start(structuredClone(input));
    validateProjectionIdentity(run, {
      projectId: requireText(input.projectId, 'projectId'),
      sessionId: requireText(input.sessionId, 'sessionId'),
    });
    return run;
  }

  async open(runId: string): Promise<KernelRunProjection> {
    return await this.#port.read(requireText(runId, 'runId'));
  }

  async pending(runId: string): Promise<readonly AgentPendingRequest[]> {
    const run = await this.open(runId);
    const pending = await this.#port.listPending(run);
    if (!Array.isArray(pending)) {
      throw new AgentKernelError(
        'KERNEL_PROJECTION_INVALID', 'Kernel pending request projection is not an array.',
      );
    }
    return deepFreeze(structuredClone(pending));
  }

  async advance(
    runId: string,
    options: AdvanceRunOptions = {},
  ): Promise<KernelRunProjection> {
    let current = await this.open(runId);
    const transitionCursor = new Set<string>();
    const limits = options.limits === undefined ? undefined : validateLimits(options.limits);
    while (true) {
      if (PASSIVE.has(current.state)) return current;
      if (limits !== undefined) {
        const limited = await this.#port.checkLimits(current, limits);
        if (limited !== null) {
          const applied = applyCommittedEffect(current, limited);
          if (limited.signal.type !== 'limit-reached' || applied.state !== 'LimitReached') {
            throw projectionError('Limit evaluation returned a non-limit transition.');
          }
          return applied;
        }
      }
      const effect = await this.#step(current);
      const next = applyCommittedEffect(current, effect);
      const cursor = transitionFingerprint(current, effect);
      if (transitionCursor.has(cursor)) {
        throw new AgentKernelError(
          'KERNEL_NO_PROGRESS',
          `Run ${current.runId} repeated a committed transition without semantic progress.`,
        );
      }
      transitionCursor.add(cursor);
      if (effect.signal.type === 'cancellation-pending') return next;
      if (effect.signal.type === 'turn-observed' && !committedEvidenceAdvanced(current, next)) {
        const recorded = await this.#port.recordNoProgress(next, {
          fingerprint: evidenceFingerprint(next),
        });
        const observed = applyCommittedEffect(next, recorded);
        if (recorded.signal.type !== 'no-progress-recorded') {
          throw projectionError('No-progress persistence returned the wrong transition signal.');
        }
        return observed;
      }
      current = next;
    }
  }

  async steer(input: SteerRunInput): Promise<KernelRunProjection> {
    const current = await this.open(input.runId);
    return applyCommittedEffect(current, await this.#port.steer(structuredClone(input), current));
  }

  async approve(input: ApproveRunInput): Promise<KernelRunProjection> {
    const current = await this.open(input.runId);
    if (current.state !== 'AwaitingUser' || current.waitReason !== 'approval') {
      throw projectionError('Approval decisions require an approval wait projection.');
    }
    return applyCommittedEffect(current, await this.#port.approve(structuredClone(input), current));
  }

  async cancel(input: CancelRunInput): Promise<KernelRunProjection> {
    const current = await this.open(input.runId);
    if (current.state === 'Cancelled') return current;
    const cancelling = applyCommittedEffect(
      current,
      await this.#port.cancel(structuredClone(input), current),
    );
    if (cancelling.state !== 'Cancelling') {
      throw projectionError('Cancellation must first commit the Cancelling state.');
    }
    return await this.advance(cancelling.runId);
  }

  async resume(input: ResumeRunInput): Promise<KernelRunProjection> {
    const current = await this.open(input.runId);
    return applyCommittedEffect(current, await this.#port.resume(structuredClone(input), current));
  }

  async requestManualCompaction(input: ManualCompactionInput): Promise<KernelRunProjection> {
    const current = await this.open(input.runId);
    const mode = current.state === 'Preparing' ? 'start' : 'queue';
    const requested = await this.#port.requestManualCompaction(
      structuredClone(input), current, mode,
    );
    const next = applyCommittedEffect(current, requested);
    const expectedSignal = mode === 'start'
      ? 'context-compaction-required'
      : 'manual-compaction-queued';
    if (requested.signal.type !== expectedSignal) {
      throw projectionError('Manual compaction returned the wrong safe-boundary transition.');
    }
    return next;
  }

  async #step(run: KernelRunProjection): Promise<AgentKernelEffect> {
    switch (run.state) {
      case 'created':
      case 'Preparing':
      case 'Compacting':
        return await this.#port.prepare(run);
      case 'CallingModel':
      case 'ReceivingModel':
        return await this.#port.callModel(run);
      case 'ResolvingActions':
      case 'ExecutingTools':
      case 'ApplyingObservations':
        return await this.#port.runTools(run);
      case 'Finalizing':
        return await this.#port.finalize(run);
      case 'Cancelling':
        return await this.#port.settleCancellation(run);
      case 'AwaitingUser':
      case 'LimitReached':
      case 'Interrupted':
      case 'Completed':
      case 'Failed':
      case 'Cancelled':
        throw projectionError(`Passive Run state ${run.state} cannot execute an effect.`);
      default:
        return assertNever(run.state);
    }
  }
}

function applyCommittedEffect(
  current: KernelRunProjection,
  effect: AgentKernelEffect,
): KernelRunProjection {
  if (effect === null || typeof effect !== 'object' || effect.run === undefined) {
    throw projectionError('Kernel port returned a malformed committed effect.');
  }
  const next = effect.run;
  validateProjectionIdentity(next, current);
  if (!Number.isSafeInteger(next.revision) || next.revision <= current.revision) {
    throw new AgentKernelError(
      'KERNEL_NO_PROGRESS',
      `Run ${current.runId} did not commit a newer revision from ${current.state}.`,
    );
  }
  validateEvidenceCursor(current, next);
  let expected: AgentRunStateSnapshot;
  try {
    expected = transitionAgentRunState(stateSnapshot(current), effect.signal);
  } catch (error) {
    throw new AgentKernelError(
      'KERNEL_PROJECTION_INVALID',
      error instanceof Error ? error.message : 'Kernel transition signal is invalid.',
    );
  }
  if (next.state !== expected.state || next.waitReason !== expectedWaitReason(expected)) {
    throw projectionError(
      `Kernel port projected ${next.state} for ${current.state} + ${effect.signal.type}; ` +
      `expected ${expected.state}.`,
    );
  }
  return next;
}

function validateEvidenceCursor(
  current: KernelRunProjection,
  next: KernelRunProjection,
): void {
  if (
    !Number.isSafeInteger(next.evidenceRevision) || next.evidenceRevision < 0 ||
    !Number.isSafeInteger(next.noProgressCount) || next.noProgressCount < 0 ||
    next.evidenceRevision < current.evidenceRevision ||
    next.noProgressCount < current.noProgressCount
  ) {
    throw projectionError('Kernel evidence/no-progress cursor moved backwards or is invalid.');
  }
  if (
    next.evidenceRevision === current.evidenceRevision &&
    next.evidenceDigest !== current.evidenceDigest
  ) {
    throw projectionError('Evidence digest changed without a committed evidence revision.');
  }
  if (
    next.evidenceDigest !== null &&
    (typeof next.evidenceDigest !== 'string' || next.evidenceDigest.trim() === '')
  ) {
    throw projectionError('Evidence digest must be null or non-empty text.');
  }
}

function committedEvidenceAdvanced(
  previous: KernelRunProjection,
  next: KernelRunProjection,
): boolean {
  return next.evidenceRevision > previous.evidenceRevision &&
    next.evidenceDigest !== null && next.evidenceDigest !== previous.evidenceDigest;
}

function transitionFingerprint(
  current: KernelRunProjection,
  effect: AgentKernelEffect,
): string {
  return [
    current.state,
    effect.signal.type,
    effect.run.state,
    current.currentTurnId ?? '',
    current.currentAttemptId ?? '',
    String(current.evidenceRevision),
    current.evidenceDigest ?? '',
  ].join('|');
}

function evidenceFingerprint(run: KernelRunProjection): string {
  return createHash('sha256').update(JSON.stringify({
    runId: run.runId,
    turnId: run.currentTurnId,
    evidenceRevision: run.evidenceRevision,
    evidenceDigest: run.evidenceDigest,
  })).digest('hex');
}

function stateSnapshot(run: KernelRunProjection): AgentRunStateSnapshot {
  if (run.state === 'AwaitingUser') {
    if (run.waitReason === null) throw projectionError('AwaitingUser requires a wait reason.');
    return { state: run.state, waitReason: run.waitReason as AgentWaitReason };
  }
  if (run.waitReason !== null) {
    throw projectionError('Only AwaitingUser may carry a wait reason.');
  }
  return { state: run.state };
}

function expectedWaitReason(state: AgentRunStateSnapshot): string | null {
  return state.state === 'AwaitingUser' ? state.waitReason : null;
}

function validateProjectionIdentity(
  value: KernelRunProjection,
  expected: Readonly<{ projectId: string; sessionId: string; runId?: string }>,
): void {
  if (
    value === null || typeof value !== 'object' ||
    value.projectId !== expected.projectId || value.sessionId !== expected.sessionId ||
    (expected.runId !== undefined && value.runId !== expected.runId)
  ) {
    throw projectionError('Kernel port changed Run identity.');
  }
}

function validateLimits(value: AgentRunLimits): AgentRunLimits {
  const clone = structuredClone(value);
  const keys = Object.keys(clone);
  if (keys.some((key) => !['maxTurns', 'deadlineAt', 'maxCostMicrounits'].includes(key))) {
    throw new TypeError('Agent Run limits contain an unknown field.');
  }
  for (const [name, amount] of [
    ['maxTurns', clone.maxTurns], ['maxCostMicrounits', clone.maxCostMicrounits],
  ] as const) {
    if (amount !== undefined && (!Number.isSafeInteger(amount) || amount < 1)) {
      throw new TypeError(`${name} must be a positive integer.`);
    }
  }
  if (
    clone.deadlineAt !== undefined &&
    (typeof clone.deadlineAt !== 'string' || Number.isNaN(Date.parse(clone.deadlineAt)))
  ) {
    throw new TypeError('deadlineAt must be an ISO date-time string.');
  }
  return deepFreeze(clone);
}

function requireText(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} is required.`);
  return value;
}

function projectionError(message: string): AgentKernelError {
  return new AgentKernelError('KERNEL_PROJECTION_INVALID', message);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  Object.values(value).forEach((item) => deepFreeze(item, seen));
  return Object.freeze(value);
}

function assertNever(value: never): never {
  throw projectionError(`Unknown Run state ${String(value)}.`);
}
