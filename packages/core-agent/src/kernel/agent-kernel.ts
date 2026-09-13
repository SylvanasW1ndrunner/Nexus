import { createHash } from 'node:crypto';
import type { ToolQuestionBundle, QuestionRuntimeCommand } from '../tools/tool-question.js';
import type { PortableValue } from '@dbagent/shared';
import type { RunIngressConfigurationSnapshot } from '../events/agent-event.js';
import {
  transitionAgentRunState,
  type AgentRunStateSnapshot,
  type AgentStateSignal,
  type AgentWaitReason,
} from './agent-state-machine.js';
import type { KernelRunProjection } from './run-controller.js';
import {
  JournalAgentKernelPort,
  type JournalAgentKernelPortOptions,
} from './journal-agent-kernel-port.js';

export type StartRunInput = Readonly<{
  projectId: string;
  sessionId: string;
  clientRequestId: string;
  input: PortableValue;
  /** Exact internal Run configuration, excluded from model/user message projections. */
  configuration?: RunIngressConfigurationSnapshot;
}>;
export type SteerRunInput = Readonly<{
  runId: string; clientRequestId: string; input: PortableValue;
}>;
export type CancelRunInput = Readonly<{ runId: string; reason?: string }>;
export type ResumeRunInput = Readonly<{ runId: string; reason?: string }>;
/** @internal Durable executor-failure boundary used by Runtime composition roots. */
export type InterruptExecutionInput = Readonly<{
  runId: string;
  code: string;
  detail?: PortableValue;
}>;
export type ApproveRunInput = Readonly<{
  runId: string;
  approvalId: string;
  decision: 'approve' | 'deny';
  reason?: string;
}>;
export type ManualCompactionInput = Readonly<{ runId: string }>;
export type SubmitQuestionInput = Readonly<{ runId: string; invocationId: string; command: QuestionRuntimeCommand }>;
export type ResolveOutcomeInput = Readonly<{
  runId: string;
  invocationId: string;
  outcome: 'succeeded' | 'failed';
  summary: string;
}>;
export type AuthorizeRiskyRetryInput = Readonly<{
  runId: string;
  invocationId: string;
  reason: string;
  clientRequestId: string;
}>;

export type AgentPendingRequest =
  | Readonly<{ kind: 'tool-question'; requestId: string; invocationId: string; bundle: ToolQuestionBundle }>
  | Readonly<{ kind: 'approval'; requestId: string; invocationId: string }>
  | Readonly<{
      kind: 'outcome-resolution';
      requestId: string;
      invocationId: string;
      summary: string;
    }>
  | Readonly<{ kind: 'input'; requestId: string; reason: AgentWaitReason }>;

export type AgentRunLimits = Readonly<{
  maxTurns?: number;
  deadlineAt?: string;
  maxCostMicrounits?: number;
}>;

export type AdvanceRunOptions = Readonly<{ limits?: AgentRunLimits }>;

/** @internal State-machine test seam; intentionally not re-exported from the package root. */
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
  submitQuestion(input: SubmitQuestionInput): Promise<KernelRunProjection>;
  resolveOutcome(input: ResolveOutcomeInput): Promise<KernelRunProjection>;
  authorizeRiskyRetry(input: AuthorizeRiskyRetryInput): Promise<KernelRunProjection>;
  cancel(input: CancelRunInput): Promise<KernelRunProjection>;
  resume(input: ResumeRunInput): Promise<KernelRunProjection>;
  /** @internal Persists an unexpected executor failure without creating a second driver path. */
  interruptExecution(input: InterruptExecutionInput): Promise<KernelRunProjection>;
  requestManualCompaction(input: ManualCompactionInput): Promise<KernelRunProjection>;
  /** Releases only this process' executor/lease; it does not cancel or terminalize the Run. */
  releaseExecution(runId: string): Promise<void>;
}

/** @internal Stateful test seam; production construction remains createJournalAgentKernel only. */
export interface AgentKernelPort {
  start(input: StartRunInput): Promise<KernelRunProjection>;
  read(runId: string): Promise<KernelRunProjection>;
  prepare(run: KernelRunProjection): Promise<AgentKernelEffect>;
  callModel(run: KernelRunProjection): Promise<AgentKernelEffect>;
  runTools(run: KernelRunProjection): Promise<AgentKernelEffect>;
  finalize(run: KernelRunProjection): Promise<AgentKernelEffect>;
  settleCancellation(run: KernelRunProjection): Promise<AgentKernelEffect>;
  steer(input: SteerRunInput, run: KernelRunProjection): Promise<AgentKernelEffect | null>;
  approve(input: ApproveRunInput, run: KernelRunProjection): Promise<AgentKernelEffect | null>;
  submitQuestion(input: SubmitQuestionInput, run: KernelRunProjection): Promise<AgentKernelEffect | null>;
  resolveOutcome(
    input: ResolveOutcomeInput,
    run: KernelRunProjection,
  ): Promise<AgentKernelEffect | null>;
  authorizeRiskyRetry(
    input: AuthorizeRiskyRetryInput,
    run: KernelRunProjection,
  ): Promise<AgentKernelEffect | null>;
  cancel(input: CancelRunInput, run: KernelRunProjection): Promise<AgentKernelEffect>;
  resume(input: ResumeRunInput, run: KernelRunProjection): Promise<AgentKernelEffect>;
  interruptExecution(
    input: InterruptExecutionInput,
    run: KernelRunProjection,
  ): Promise<AgentKernelEffect>;
  requestManualCompaction(
    input: ManualCompactionInput,
    run: KernelRunProjection,
    mode: 'queue' | 'start',
  ): Promise<AgentKernelEffect>;
  recordNoProgress(
    run: KernelRunProjection,
    input: Readonly<{ fingerprint: string; turnId: string }>,
  ): Promise<AgentKernelEffect>;
  listPending(run: KernelRunProjection): Promise<readonly AgentPendingRequest[]>;
  checkLimits(
    run: KernelRunProjection,
    limits: AgentRunLimits,
  ): Promise<AgentKernelEffect | null>;
  releaseRun(
    run: KernelRunProjection,
    options?: Readonly<{ waitForWork?: boolean }>,
  ): Promise<void>;
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

const EXECUTION_STATES = new Set<KernelRunProjection['state']>([
  'created', 'Preparing', 'Compacting', 'CallingModel', 'ReceivingModel',
  'ResolvingActions', 'ExecutingTools', 'ApplyingObservations', 'Finalizing',
]);

/** @internal State-machine driver; production callers must use createJournalAgentKernel. */
export class JournalDrivenAgentKernel implements AgentKernel {
  readonly #port: AgentKernelPort;
  readonly #advances = new Map<string, Promise<KernelRunProjection>>();

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
    if (!isArrayValue(pending)) {
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
    const exactRunId = requireText(runId, 'runId');
    const active = this.#advances.get(exactRunId);
    if (active !== undefined) return await active;
    const advancing = this.#advance(exactRunId, options);
    this.#advances.set(exactRunId, advancing);
    try {
      return await advancing;
    } finally {
      if (this.#advances.get(exactRunId) === advancing) this.#advances.delete(exactRunId);
    }
  }

  async #advance(
    runId: string,
    options: AdvanceRunOptions,
  ): Promise<KernelRunProjection> {
    let current = await this.open(runId);
    const transitionCursor = new Set<string>();
    const limits = options.limits === undefined ? undefined : validateLimits(options.limits);
    try {
      while (true) {
        if (PASSIVE.has(current.state)) {
          await this.#port.releaseRun(current);
          return current;
        }
        if (limits !== undefined) {
          const limited = await this.#port.checkLimits(current, limits);
          if (limited !== null) {
            const applied = applyCommittedEffect(current, limited);
            if (limited.signal.type !== 'limit-reached' || applied.state !== 'LimitReached') {
              throw projectionError('Limit evaluation returned a non-limit transition.');
            }
            await this.#port.releaseRun(applied);
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
        // A verifier revision is a committed semantic boundary. Yield so the
        // Runtime can schedule a fresh drive instead of spinning inside one
        // unbounded advance call with the same Evidence revision.
        if (effect.signal.type === 'delivery-revision-requested') return next;
        if (effect.signal.type === 'turn-observed' && !committedEvidenceAdvanced(current, next)) {
          if (current.currentTurnId === null) {
            throw projectionError('A no-progress fact requires the exact closed Turn identity.');
          }
          const recorded = await this.#port.recordNoProgress(next, {
            fingerprint: evidenceFingerprint(next, current.currentTurnId),
            turnId: current.currentTurnId,
          });
          const observed = applyCommittedEffect(next, recorded);
          if (recorded.signal.type !== 'no-progress-recorded') {
            throw projectionError('No-progress persistence returned the wrong transition signal.');
          }
          if (PASSIVE.has(observed.state)) await this.#port.releaseRun(observed);
          return observed;
        }
        current = next;
      }
    } catch (error) {
      await this.#port.releaseRun(await this.open(runId)).catch(() => undefined);
      throw error;
    }
  }

  async steer(input: SteerRunInput): Promise<KernelRunProjection> {
    const current = await this.open(input.runId);
    const committed = await this.#port.steer(structuredClone(input), current);
    return committed === null ? current : applyCommittedEffect(current, committed);
  }

  async approve(input: ApproveRunInput): Promise<KernelRunProjection> {
    const current = await this.open(input.runId);
    const committed = await this.#port.approve(structuredClone(input), current);
    return committed === null ? current : applyCommittedEffect(current, committed);
  }

  async submitQuestion(input: SubmitQuestionInput): Promise<KernelRunProjection> {
    const current = await this.open(input.runId);
    const committed = await this.#port.submitQuestion(structuredClone(input), current);
    return committed === null ? current : applyCommittedEffect(current, committed);
  }

  async resolveOutcome(input: ResolveOutcomeInput): Promise<KernelRunProjection> {
    const current = await this.open(input.runId);
    const committed = await this.#port.resolveOutcome(structuredClone(input), current);
    return committed === null ? current : applyCommittedEffect(current, committed);
  }

  async authorizeRiskyRetry(input: AuthorizeRiskyRetryInput): Promise<KernelRunProjection> {
    const current = await this.open(input.runId);
    const committed = await this.#port.authorizeRiskyRetry(structuredClone(input), current);
    return committed === null ? current : applyCommittedEffect(current, committed);
  }

  async cancel(input: CancelRunInput): Promise<KernelRunProjection> {
    const exact = structuredClone(input);
    for (let retry = 0; retry < 32; retry += 1) {
      const current = await this.open(exact.runId);
      if (current.state === 'Cancelled') {
        await this.#port.releaseRun(current);
        return current;
      }
      if (current.state === 'Cancelling') return await this.advance(current.runId);
      try {
        const cancelling = applyCommittedEffect(
          current,
          await this.#port.cancel(exact, current),
        );
        if (cancelling.state !== 'Cancelling') {
          throw projectionError('Cancellation must first commit the Cancelling state.');
        }
        return await this.advance(cancelling.runId);
      } catch (error) {
        const observed = await this.open(exact.runId);
        if (observed.state === 'Cancelled') return observed;
        if (observed.state === 'Cancelling') return await this.advance(observed.runId);
        if (observed.revision === current.revision) throw error;
      }
    }
    throw new AgentKernelError(
      'KERNEL_NO_PROGRESS',
      `Run ${exact.runId} cancellation could not acquire a stable revision.`,
    );
  }

  async resume(input: ResumeRunInput): Promise<KernelRunProjection> {
    const current = await this.open(input.runId);
    return applyCommittedEffect(current, await this.#port.resume(structuredClone(input), current));
  }

  async interruptExecution(input: InterruptExecutionInput): Promise<KernelRunProjection> {
    const exact = structuredClone(input);
    for (let retry = 0; retry < 32; retry += 1) {
      const current = await this.open(exact.runId);
      if (current.state === 'Interrupted' || !EXECUTION_STATES.has(current.state)) return current;
      try {
        const interrupted = applyCommittedEffect(
          current,
          await this.#port.interruptExecution(exact, current),
        );
        if (interrupted.state !== 'Interrupted') {
          throw projectionError('Executor interruption must commit the Interrupted state.');
        }
        await this.#port.releaseRun(interrupted);
        return interrupted;
      } catch (error) {
        const observed = await this.open(exact.runId);
        if (observed.state === 'Interrupted' || !EXECUTION_STATES.has(observed.state)) {
          return observed;
        }
        if (observed.revision === current.revision) throw error;
      }
    }
    throw new AgentKernelError(
      'KERNEL_NO_PROGRESS',
      `Run ${exact.runId} interruption could not acquire a stable revision.`,
    );
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

  async releaseExecution(runId: string): Promise<void> {
    const current = await this.open(runId);
    await this.#port.releaseRun(current, { waitForWork: false });
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

export type CreateJournalAgentKernelOptions = JournalAgentKernelPortOptions;

/** The only production Agent construction path; callers supply dependencies, never state effects. */
export function createJournalAgentKernel(options: CreateJournalAgentKernelOptions): AgentKernel {
  return new JournalDrivenAgentKernel({ port: new JournalAgentKernelPort(options) });
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
  const contextBoundary =
    effect.signal.type === 'context-compaction-required' ||
    effect.signal.type === 'context-compacted'
      ? effect.signal.coveredSequence ?? ''
      : '';
  return [
    current.state,
    effect.signal.type,
    effect.run.state,
    current.currentTurnId ?? '',
    current.currentAttemptId ?? '',
    String(current.evidenceRevision),
    current.evidenceDigest ?? '',
    String(contextBoundary),
  ].join('|');
}

function evidenceFingerprint(run: KernelRunProjection, turnId: string): string {
  return createHash('sha256').update(JSON.stringify({
    runId: run.runId,
    turnId,
    evidenceRevision: run.evidenceRevision,
    evidenceDigest: run.evidenceDigest,
  })).digest('hex');
}

function stateSnapshot(run: KernelRunProjection): AgentRunStateSnapshot {
  if (run.state === 'AwaitingUser') {
    if (run.waitReason === null) throw projectionError('AwaitingUser requires a wait reason.');
    if (!isAgentWaitReason(run.waitReason)) {
      throw projectionError('AwaitingUser carries an unknown wait reason.');
    }
    return { state: run.state, waitReason: run.waitReason };
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
  const integerLimits: ReadonlyArray<readonly [string, number | undefined]> = [
    ['maxTurns', clone.maxTurns],
    ['maxCostMicrounits', clone.maxCostMicrounits],
  ];
  for (const [name, amount] of integerLimits) {
    if (amount !== undefined && (!Number.isSafeInteger(amount) || amount < 0)) {
      throw new TypeError(`${name} must be a non-negative integer.`);
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

function isAgentWaitReason(value: string): value is AgentWaitReason {
  return value === 'approval' || value === 'input_required' ||
    value === 'outcome_resolution' || value === 'model_connection_required' ||
    value === 'capability_revision_required';
}

function requireText(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} is required.`);
  return value;
}

function projectionError(message: string): AgentKernelError {
  return new AgentKernelError('KERNEL_PROJECTION_INVALID', message);
}

function isArrayValue(value: unknown): boolean {
  return Array.isArray(value);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function assertNever(value: never): never {
  throw projectionError(`Unknown Run state ${String(value)}.`);
}
