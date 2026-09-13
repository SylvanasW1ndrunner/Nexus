import type {
  ModelAttemptExecution,
  ModelAttemptLifecycleEvent,
  ModelAttemptLifecycleObserver,
  ModelAttemptOptions,
  ModelSession,
  ModelSessionBundle,
} from '@dbagent/core-llm';
import type { UsageMode } from '@dbagent/shared';
import type { CompiledPrompt } from '../context/prompt-runtime.js';
import type { RunEventCommitter, ModelTurnCommitResult } from '../events/run-event-committer.js';
import type { RunLeaseReference } from '../events/agent-journal.js';

export type ModelTurnLifecycleFact =
  | Exclude<ModelAttemptLifecycleEvent, { type: 'decoded-delta' }>
  | Readonly<{
      type: 'model-delta-batch';
      attemptId: string;
      routeId: string;
      batchOrdinal: number;
      idempotencyKey: string;
      events: readonly Extract<ModelAttemptLifecycleEvent, { type: 'decoded-delta' }>[];
    }>;

export interface ModelTurnLifecycleSink {
  publish(fact: ModelTurnLifecycleFact): Promise<Readonly<{ runRevision?: number }> | void>;
}

export interface ModelTurnGateway {
  executeAttempt(
    session: ModelSession | ModelSessionBundle,
    request: CompiledPrompt['request'],
    options: ModelAttemptOptions,
  ): Promise<ModelAttemptExecution>;
}

export class ModelTurnObserverError extends Error {
  constructor(override readonly cause: unknown) {
    super('Model lifecycle Journal sink failed.', { cause });
    this.name = 'ModelTurnObserverError';
  }
}

export class ModelTurnObserverClosedError extends Error {
  constructor() {
    super('Model lifecycle observer is closed.');
    this.name = 'ModelTurnObserverClosedError';
  }
}

/** Awaited lifecycle observer with bounded 4KiB/40ms delta transactions. */
export class BatchingModelTurnObserver implements ModelAttemptLifecycleObserver {
  readonly #sink: ModelTurnLifecycleSink;
  readonly #maxBytes: number;
  readonly #maxDelayMs: number;
  #pending: Extract<ModelAttemptLifecycleEvent, { type: 'decoded-delta' }>[] = [];
  #pendingBytes = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #timerFlushes = new Set<Promise<void>>();
  readonly #activeOperations = new Set<Promise<void>>();
  #latched: ModelTurnObserverError | undefined;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  readonly #startRevisions = new Map<string, number>();
  readonly #nextBatchOrdinal = new Map<string, number>();

  constructor(options: Readonly<{
    sink: ModelTurnLifecycleSink; maxBytes?: number; maxDelayMs?: number;
  }>) {
    this.#sink = options.sink;
    this.#maxBytes = options.maxBytes ?? 4_096;
    this.#maxDelayMs = options.maxDelayMs ?? 40;
    if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 1 ||
      !Number.isSafeInteger(this.#maxDelayMs) || this.#maxDelayMs < 1) {
      throw new TypeError('Model observer batching thresholds must be positive integers.');
    }
  }

  onEvent(event: ModelAttemptLifecycleEvent): Promise<void> {
    if (this.#closed) return Promise.reject(new ModelTurnObserverClosedError());
    return this.#trackOperation(this.#handleEvent(structuredClone(event)));
  }

  flush(): Promise<void> {
    if (this.#closed) return Promise.reject(new ModelTurnObserverClosedError());
    return this.#trackOperation(this.#flushWhileOpen());
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#pending = [];
    this.#pendingBytes = 0;
    this.#closePromise = this.#finishClose();
    return this.#closePromise;
  }

  startRevision(attemptId: string): number | undefined {
    return this.#startRevisions.get(attemptId);
  }

  async #handleEvent(event: ModelAttemptLifecycleEvent): Promise<void> {
    this.#throwLatched();
    this.#throwClosed();
    if (event.type === 'decoded-delta') {
      this.#pending.push(event);
      this.#pendingBytes += Buffer.byteLength(JSON.stringify(event), 'utf8');
      if (this.#pendingBytes >= this.#maxBytes) await this.#flushWhileOpen();
      else this.#armTimer();
      return;
    }
    await this.#flushWhileOpen();
    this.#throwClosed();
    const response = await this.#publish(event);
    if (event.type === 'attempt-started' && response?.runRevision !== undefined) {
      this.#startRevisions.set(event.attemptId, response.runRevision);
    }
  }

  async #flushWhileOpen(): Promise<void> {
    this.#throwLatched();
    this.#throwClosed();
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    await this.#waitForTimerFlushes();
    this.#throwLatched();
    this.#throwClosed();
    await this.#flushPending();
  }

  async #flushPending(): Promise<void> {
    const batch = this.#takePendingBatch();
    if (batch === undefined) return;
    await this.#publish(batch);
  }

  #takePendingBatch(): Extract<ModelTurnLifecycleFact, { type: 'model-delta-batch' }> | undefined {
    if (this.#pending.length === 0) return undefined;
    const events = this.#pending;
    this.#pending = [];
    this.#pendingBytes = 0;
    const attemptId = events[0]!.attemptId;
    const routeId = events[0]!.routeId;
    if (events.some((event) => event.attemptId !== attemptId || event.routeId !== routeId)) {
      throw new ModelTurnObserverError(
        new Error('A model delta batch cannot span multiple attempts or routes.'),
      );
    }
    const batchOrdinal = this.#nextBatchOrdinal.get(attemptId) ?? 0;
    this.#nextBatchOrdinal.set(attemptId, batchOrdinal + 1);
    return {
      type: 'model-delta-batch',
      attemptId,
      routeId,
      batchOrdinal,
      idempotencyKey: `model-delta-batch:${attemptId}:${batchOrdinal}`,
      events: structuredClone(events),
    };
  }

  #armTimer(): void {
    if (this.#closed || this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      const batch = this.#takePendingBatch();
      if (batch === undefined) return;
      const priorFlushes = [...this.#timerFlushes];
      const timerFlush = (async () => {
        await Promise.all(priorFlushes);
        this.#throwLatched();
        await this.#publish(batch);
      })().catch((error: unknown) => {
        this.#latched = error instanceof ModelTurnObserverError
          ? error : new ModelTurnObserverError(error);
      }).finally(() => {
        this.#timerFlushes.delete(timerFlush);
      });
      this.#timerFlushes.add(timerFlush);
    }, this.#maxDelayMs);
  }

  #trackOperation(operation: Promise<void>): Promise<void> {
    this.#activeOperations.add(operation);
    void operation.then(
      () => this.#activeOperations.delete(operation),
      () => this.#activeOperations.delete(operation),
    );
    return operation;
  }

  async #finishClose(): Promise<void> {
    while (this.#activeOperations.size > 0 || this.#timerFlushes.size > 0) {
      await Promise.allSettled([
        ...this.#activeOperations,
        ...this.#timerFlushes,
      ]);
    }
    this.#throwLatched();
  }

  async #waitForTimerFlushes(): Promise<void> {
    while (this.#timerFlushes.size > 0) {
      await Promise.all(this.#timerFlushes);
    }
  }

  async #publish(
    fact: ModelTurnLifecycleFact,
  ): Promise<Readonly<{ runRevision?: number }> | void> {
    try {
      return await this.#sink.publish(deepFreeze(structuredClone(fact)));
    } catch (error) {
      const wrapped = error instanceof ModelTurnObserverError ? error : new ModelTurnObserverError(error);
      this.#latched = wrapped;
      throw wrapped;
    }
  }

  #throwLatched(): void {
    if (this.#latched !== undefined) throw this.#latched;
  }

  #throwClosed(): void {
    if (this.#closed) throw new ModelTurnObserverClosedError();
  }
}

export type CoordinateModelTurnInput = Readonly<{
  projectId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  commandId: string;
  lease: RunLeaseReference;
  expectedTurnRevision: number;
  prompt: CompiledPrompt;
  signal?: AbortSignal;
}>;

/** Owns exactly one Gateway Attempt transaction and its atomic Turn commit. */
export class ModelTurnCoordinator {
  constructor(private readonly options: Readonly<{
    gateway: ModelTurnGateway;
    session: ModelSession | ModelSessionBundle;
    committer: RunEventCommitter;
    lifecycleSink: ModelTurnLifecycleSink;
    resolveUsageBillingMode(routeId: string): UsageMode;
  }>) {}

  async execute(input: CoordinateModelTurnInput): Promise<Readonly<{
    execution: ModelAttemptExecution;
    committed: ModelTurnCommitResult;
  }>> {
    const observer = new BatchingModelTurnObserver({ sink: this.options.lifecycleSink });
    let execution: ModelAttemptExecution;
    try {
      execution = await this.options.gateway.executeAttempt(
        this.options.session, input.prompt.request,
        {
          purpose: 'agent-turn', toolsEnabled: true, observer,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        },
      );
      await observer.flush();
    } catch (error) {
      try {
        await observer.close();
      } catch {
        // The primary Gateway/observer error already describes the failed Turn boundary.
      }
      throw error;
    }
    await observer.close();
    const expectedRunRevision = observer.startRevision(execution.attempt.attemptId);
    if (expectedRunRevision === undefined) {
      throw new ModelTurnObserverError(new Error('Attempt start was not durably acknowledged.'));
    }
    const committed = await this.options.committer.commitValidatedAttempt({
      projectId: input.projectId, sessionId: input.sessionId, runId: input.runId,
      turnId: input.turnId, commandId: input.commandId, lease: input.lease,
      expectedRunRevision, expectedTurnRevision: input.expectedTurnRevision,
      billingMode: this.options.resolveUsageBillingMode(execution.session.route.routeId),
      attempt: execution.attempt,
    });
    return deepFreeze({ execution, committed });
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}
