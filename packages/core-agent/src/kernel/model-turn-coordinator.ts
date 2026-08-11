import type {
  ModelAttemptExecution,
  ModelAttemptLifecycleEvent,
  ModelAttemptLifecycleObserver,
  ModelAttemptOptions,
  ModelSession,
  ModelSessionBundle,
} from '@dbagent/core-llm';
import type { CompiledPrompt } from '../context/prompt-runtime.js';
import type { RunEventCommitter, ModelTurnCommitResult } from '../events/run-event-committer.js';
import type { RunLeaseReference } from '../events/agent-journal.js';

export type ModelTurnLifecycleFact =
  | Exclude<ModelAttemptLifecycleEvent, { type: 'decoded-delta' }>
  | Readonly<{
      type: 'model-delta-batch';
      attemptId: string;
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

/** Awaited lifecycle observer with bounded 4KiB/40ms delta transactions. */
export class BatchingModelTurnObserver implements ModelAttemptLifecycleObserver {
  readonly #sink: ModelTurnLifecycleSink;
  readonly #maxBytes: number;
  readonly #maxDelayMs: number;
  #pending: Extract<ModelAttemptLifecycleEvent, { type: 'decoded-delta' }>[] = [];
  #pendingBytes = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #timerFlush: Promise<void> | undefined;
  #latched: ModelTurnObserverError | undefined;
  readonly #startRevisions = new Map<string, number>();

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

  async onEvent(event: ModelAttemptLifecycleEvent): Promise<void> {
    this.#throwLatched();
    if (event.type === 'decoded-delta') {
      this.#pending.push(structuredClone(event));
      this.#pendingBytes += Buffer.byteLength(JSON.stringify(event), 'utf8');
      if (this.#pendingBytes >= this.#maxBytes) await this.flush();
      else this.#armTimer();
      return;
    }
    await this.flush();
    const response = await this.#publish(structuredClone(event));
    if (event.type === 'attempt-started' && response?.runRevision !== undefined) {
      this.#startRevisions.set(event.attemptId, response.runRevision);
    }
  }

  async flush(): Promise<void> {
    this.#throwLatched();
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (this.#timerFlush !== undefined) await this.#timerFlush;
    this.#throwLatched();
    if (this.#pending.length === 0) return;
    const events = this.#pending;
    this.#pending = [];
    this.#pendingBytes = 0;
    await this.#publish({
      type: 'model-delta-batch', attemptId: events[0]!.attemptId,
      events: structuredClone(events),
    });
  }

  startRevision(attemptId: string): number | undefined {
    return this.#startRevisions.get(attemptId);
  }

  #armTimer(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#timerFlush = this.flush().catch((error: unknown) => {
        this.#latched = error instanceof ModelTurnObserverError
          ? error : new ModelTurnObserverError(error);
      }).finally(() => {
        this.#timerFlush = undefined;
      });
    }, this.#maxDelayMs);
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
  }>) {}

  async execute(input: CoordinateModelTurnInput): Promise<Readonly<{
    execution: ModelAttemptExecution;
    committed: ModelTurnCommitResult;
  }>> {
    const observer = new BatchingModelTurnObserver({ sink: this.options.lifecycleSink });
    const execution = await this.options.gateway.executeAttempt(
      this.options.session, input.prompt.request,
      {
        purpose: 'agent-turn', toolsEnabled: true, observer,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
    );
    await observer.flush();
    const expectedRunRevision = observer.startRevision(execution.attempt.attemptId);
    if (expectedRunRevision === undefined) {
      throw new ModelTurnObserverError(new Error('Attempt start was not durably acknowledged.'));
    }
    const committed = await this.options.committer.commitValidatedAttempt({
      projectId: input.projectId, sessionId: input.sessionId, runId: input.runId,
      turnId: input.turnId, commandId: input.commandId, lease: input.lease,
      expectedRunRevision, expectedTurnRevision: input.expectedTurnRevision,
      attempt: execution.attempt,
    });
    return deepFreeze({ execution, committed });
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  Object.values(value).forEach((item) => deepFreeze(item, seen));
  return Object.freeze(value);
}
