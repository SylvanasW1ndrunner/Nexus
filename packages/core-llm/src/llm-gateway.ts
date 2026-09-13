import { randomUUID } from 'node:crypto';
import {
  isAuthenticModelSession,
  isAuthenticModelSessionBundle,
  ModelClientError,
  type ModelSessionBundle,
  type ModelSession,
} from './model-client.js';
import {
  ModelProtocolError,
  type CanonicalModelRequest,
} from './protocol/codec.js';
import type {
  DecodedModelAttempt,
  ModelTokenUsage,
  ValidatedModelAttempt,
} from './protocol/envelope.js';
import type { DecodedModelContentBlock } from './protocol/content.js';
import type { DecodedModelStreamEvent } from './protocol/model-stream.js';
import { mintAuthenticValidatedModelAttempt } from './protocol/validated-attempt-authenticity.js';
import { retryAfterMilliseconds, retryDelayFromError } from './retry-policy.js';
import { LlmProviderError } from './types.js';

export type ModelAttemptTimeouts = {
  connectMs: number;
  firstEventMs: number;
  idleMs: number;
  totalMs: number;
};

export type ModelAttemptRetryPolicy = {
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
};

export type ModelTimeoutPhase = 'connect' | 'first-event' | 'idle' | 'total';

export type ModelAttemptOptions = {
  signal?: AbortSignal;
  maxRetries?: number;
  retry?: Partial<ModelAttemptRetryPolicy>;
  timeouts?: Partial<ModelAttemptTimeouts>;
  fallbacks?: readonly ModelSession[];
  observer?: ModelAttemptLifecycleObserver;
  purpose?: ModelAttemptPurpose;
  toolsEnabled?: boolean;
};

export type ModelAttemptPurpose = 'agent-turn' | 'context-compaction' | 'direct';

export type ModelDecodedDeltaEvent = Exclude<
  DecodedModelStreamEvent,
  { type: 'block-complete' | 'usage' | 'finish' }
>;

export type ModelAttemptLifecycleEvent =
  | Readonly<{
      type: 'attempt-started';
      attemptId: string;
      routeId: string;
      origin: Readonly<{ connectionId: string; model: string; protocol: string }>;
      purpose: ModelAttemptPurpose;
      startedAt: number;
    }>
  | Readonly<{
      type: 'decoded-delta';
      attemptId: string;
      routeId: string;
      event: ModelDecodedDeltaEvent;
      occurredAt: number;
    }>
  | Readonly<{
      type: 'block-completed';
      attemptId: string;
      routeId: string;
      blockOrdinal: number;
      block: DecodedModelContentBlock;
      occurredAt: number;
    }>
  | Readonly<{
      type: 'usage-observed';
      attemptId: string;
      routeId: string;
      purpose: ModelAttemptPurpose;
      usage: ModelTokenUsage;
      occurredAt: number;
    }>
  | Readonly<{
      type: 'attempt-failed';
      attemptId: string;
      routeId: string;
      code: ModelGatewayErrorCode;
      retryable: boolean;
      phase?: ModelTimeoutPhase;
      statusCode?: number;
      occurredAt: number;
    }>
  | Readonly<{
      type: 'attempt-discarded';
      attemptId: string;
      routeId: string;
      reason: string;
      discardedAt: number;
    }>;

export interface ModelAttemptLifecycleObserver {
  onEvent(event: ModelAttemptLifecycleEvent): void | Promise<void>;
}

export type DiscardedModelAttempt = {
  attemptId: string;
  routeId: string;
  reason: string;
  blocks: readonly DecodedModelContentBlock[];
  discardedAt: number;
};

export type ModelAttemptExecution = {
  attempt: ValidatedModelAttempt;
  session: ModelSession;
  discardedAttempts: readonly DiscardedModelAttempt[];
};

export type ModelGatewayErrorCode =
  | 'MODEL_TIMEOUT'
  | 'MODEL_CANCELLED'
  | 'MODEL_PROTOCOL_FAILED'
  | 'MODEL_TRANSPORT_FAILED'
  | 'MODEL_FALLBACK_INCOMPATIBLE'
  | 'MODEL_SESSION_INVALID'
  | 'MODEL_OBSERVER_FAILED';

export class ModelGatewayError extends Error {
  constructor(
    readonly code: ModelGatewayErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly options: {
      phase?: ModelTimeoutPhase;
      statusCode?: number;
      retryAfterMs?: number;
      cause?: unknown;
      discardedAttempts?: readonly DiscardedModelAttempt[];
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ModelGatewayError';
  }

  get phase(): ModelTimeoutPhase | undefined {
    return this.options.phase;
  }

  get statusCode(): number | undefined {
    return this.options.statusCode;
  }

  get retryAfterMs(): number | undefined {
    return this.options.retryAfterMs;
  }
}

export type ModelGatewayClock = {
  now(): number;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
};

export type ModelExecutionGatewayOptions = {
  clock?: ModelGatewayClock;
  random?: () => number;
  createAttemptId?: () => string;
};

const DEFAULT_MODEL_ATTEMPT_TIMEOUTS: ModelAttemptTimeouts = {
  connectMs: 30_000,
  firstEventMs: 30_000,
  idleMs: 30_000,
  totalMs: 120_000,
};

const DEFAULT_MODEL_ATTEMPT_RETRY: ModelAttemptRetryPolicy = {
  baseDelayMs: 100,
  maxDelayMs: 5_000,
  jitterRatio: 0.2,
};

/** The sole owner of canonical model attempt retry, fallback and discard. */
export class ModelExecutionGateway {
  private readonly clock: ModelGatewayClock;
  private readonly random: () => number;
  private readonly createAttemptId: () => string;

  constructor(options: ModelExecutionGatewayOptions = {}) {
    this.clock = options.clock ?? { now: Date.now, sleep: modelAttemptDelay };
    this.random = options.random ?? Math.random;
    this.createAttemptId = options.createAttemptId ?? randomUUID;
  }

  async executeAttempt(
    sessionOrBundle: ModelSession | ModelSessionBundle,
    request: CanonicalModelRequest,
    options: ModelAttemptOptions = {},
  ): Promise<ModelAttemptExecution> {
    if ((options.fallbacks?.length ?? 0) > 0) {
      throw new ModelGatewayError(
        'MODEL_FALLBACK_INCOMPATIBLE',
        'Fallback sessions must come from an authentic prepared ModelSessionBundle.',
        false,
      );
    }
    const bundle = isAuthenticModelSessionBundle(sessionOrBundle)
      ? sessionOrBundle
      : undefined;
    if ('primary' in sessionOrBundle && bundle === undefined) {
      throw new ModelGatewayError(
        'MODEL_FALLBACK_INCOMPATIBLE',
        'The supplied ModelSessionBundle is not an authentic prepared binding.',
        false,
      );
    }
    const session = bundle?.primary ?? sessionOrBundle as ModelSession;
    if (bundle === undefined && !isAuthenticModelSession(session)) {
      throw new ModelGatewayError(
        'MODEL_SESSION_INVALID',
        'The supplied ModelSession is not a factory-bound or rehydrated binding.',
        false,
      );
    }
    if (request.model !== session.route.modelId) {
      throw new ModelGatewayError(
        'MODEL_PROTOCOL_FAILED',
        `Canonical request model ${request.model} does not match frozen route ${session.route.modelId}.`,
        false,
      );
    }
    if (options.toolsEnabled === false && (request.tools?.length ?? 0) > 0) {
      throw new ModelGatewayError(
        'MODEL_PROTOCOL_FAILED',
        'This model attempt explicitly disables Tool exposure.',
        false,
      );
    }
    const fallbacks = [...(bundle?.fallbacks ?? [])];
    const maxRetries = boundedModelAttemptInteger(options.maxRetries ?? 1, 0, 10, 'maxRetries');
    const timeouts = modelAttemptTimeouts(options.timeouts);
    const retry = modelAttemptRetry(options.retry);
    const discarded: DiscardedModelAttempt[] = [];
    let terminalError: ModelGatewayError | undefined;
    const purpose = options.purpose ?? 'agent-turn';

    const candidates = [session, ...fallbacks];
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      const candidate = candidates[candidateIndex]!;
      for (let retryIndex = 0; retryIndex <= maxRetries; retryIndex += 1) {
        const attemptId = this.createAttemptId();
        const tentativeBlocks: DecodedModelContentBlock[] = [];
        const lifecycle = { started: false };
        try {
          const attempt = await this.executeOne(
            candidate,
            request,
            attemptId,
            timeouts,
            options.signal,
            tentativeBlocks,
            options.observer,
            purpose,
            lifecycle,
          );
          return Object.freeze({
            attempt,
            session: candidate,
            discardedAttempts: Object.freeze(discarded.map(freezeDiscardedAttempt)),
          });
        } catch (error) {
          terminalError = classifyModelAttemptError(error, options.signal, this.clock.now());
          if (terminalError.code === 'MODEL_OBSERVER_FAILED') {
            throw withDiscardedModelAttempts(terminalError, discarded);
          }
          if (!lifecycle.started) {
            throw withDiscardedModelAttempts(terminalError, discarded);
          }
          const discardedAttempt: DiscardedModelAttempt = {
            attemptId,
            routeId: candidate.route.routeId,
            reason: discardReason(error, terminalError),
            blocks: tentativeBlocks.map(cloneDecodedBlock),
            discardedAt: this.clock.now(),
          };
          await publishModelAttemptLifecycle(options.observer, {
            type: 'attempt-failed',
            attemptId,
            routeId: candidate.route.routeId,
            code: terminalError.code,
            retryable: terminalError.retryable,
            ...(terminalError.phase === undefined ? {} : { phase: terminalError.phase }),
            ...(terminalError.statusCode === undefined
              ? {}
              : { statusCode: terminalError.statusCode }),
            occurredAt: discardedAttempt.discardedAt,
          });
          await publishModelAttemptLifecycle(options.observer, {
            type: 'attempt-discarded',
            attemptId,
            routeId: candidate.route.routeId,
            reason: discardedAttempt.reason,
            discardedAt: discardedAttempt.discardedAt,
          });
          discarded.push(discardedAttempt);
          if (terminalError.code === 'MODEL_CANCELLED') {
            throw withDiscardedModelAttempts(terminalError, discarded);
          }
          if (!terminalError.retryable) {
            if (
              candidateIndex + 1 < candidates.length &&
              isModelFallbackEligible(terminalError)
            ) {
              break;
            }
            throw withDiscardedModelAttempts(terminalError, discarded);
          }
          if (retryIndex < maxRetries) {
            const delay = retryDelayFromError(
              modelRetryError(terminalError),
              {
                attempt: retryIndex,
                baseDelayMs: retry.baseDelayMs,
                maxDelayMs: retry.maxDelayMs,
                jitterRatio: retry.jitterRatio,
                random: this.random,
              },
            );
            try {
              await this.clock.sleep(delay, options.signal);
            } catch (error) {
              throw withDiscardedModelAttempts(
                classifyModelAttemptError(error, options.signal, this.clock.now()),
                discarded,
              );
            }
          }
        }
      }
    }
    throw withDiscardedModelAttempts(terminalError ?? new ModelGatewayError(
      'MODEL_TRANSPORT_FAILED',
      'No model attempt was executed.',
      false,
    ), discarded);
  }

  private async executeOne(
    session: ModelSession,
    request: CanonicalModelRequest,
    attemptId: string,
    timeouts: ModelAttemptTimeouts,
    sourceSignal: AbortSignal | undefined,
    tentativeBlocks: DecodedModelContentBlock[],
    observer: ModelAttemptLifecycleObserver | undefined,
    purpose: ModelAttemptPurpose,
    lifecycle: { started: boolean },
  ): Promise<ValidatedModelAttempt> {
    const controller = new AbortController();
    const abortFromSource = () => controller.abort(sourceSignal?.reason);
    sourceSignal?.addEventListener('abort', abortFromSource, { once: true });
    if (sourceSignal?.aborted) controller.abort(sourceSignal.reason);
    let encoded: ReturnType<ModelSession['codec']['encode']>;
    try {
      const canonicalRequest = applySessionGeneration(request, session);
      encoded = session.codec.encode(canonicalRequest, {
        requestId: attemptId,
        target: {
          connectionId: session.route.connectionId,
          model: session.route.modelId,
          protocol: session.route.protocol,
        },
        ...(session.route.encoding === undefined
          ? {}
          : { routeEncoding: session.route.encoding }),
        replay: session.replay,
      });
    } catch (error) {
      sourceSignal?.removeEventListener('abort', abortFromSource);
      throw error;
    }

    const run = async (): Promise<ValidatedModelAttempt> => {
      let observedUsage: ModelTokenUsage | undefined;
      const observeUsage = async (sourceUsage: ModelTokenUsage | undefined): Promise<void> => {
        if (sourceUsage === undefined) return;
        const usage = validObservedModelUsage(sourceUsage);
        if (observedUsage !== undefined) {
          if (!sameModelTokenUsage(observedUsage, usage)) {
            throw new ModelProtocolError(
              'INVALID_WIRE_RESPONSE',
              'One model attempt emitted conflicting token usage values.',
            );
          }
          return;
        }
        observedUsage = usage;
        await publishModelAttemptLifecycle(observer, {
          type: 'usage-observed',
          attemptId,
          routeId: session.route.routeId,
          purpose,
          usage,
          occurredAt: this.clock.now(),
        });
      };

      await publishModelAttemptLifecycle(observer, {
        type: 'attempt-started',
        attemptId,
        routeId: session.route.routeId,
        origin: {
          connectionId: session.route.connectionId,
          model: session.route.modelId,
          protocol: session.route.protocol,
        },
        purpose,
        startedAt: this.clock.now(),
      });
      lifecycle.started = true;
      if (controller.signal.aborted) {
        throw modelAttemptAbortError(controller.signal.reason, sourceSignal);
      }
      const response = await raceModelDeadline(
        session.client.execute({
          attemptId,
          route: session.route,
          wireRequest: encoded.wireRequest,
          signal: controller.signal,
        }),
        timeouts.connectMs,
        'connect',
        controller,
        sourceSignal,
      );
      const context = {
        attemptId,
        origin: {
          connectionId: session.route.connectionId,
          model: session.route.modelId,
          protocol: session.route.protocol,
        },
      };
      if (response.kind === 'json') {
        const decoded = session.codec.decode(response.response, context);
        await observeUsage(decoded.usage);
        for (let blockOrdinal = 0; blockOrdinal < decoded.blocks.length; blockOrdinal += 1) {
          const block = decoded.blocks[blockOrdinal];
          if (block === undefined) continue;
          await publishModelAttemptLifecycle(observer, {
            type: 'block-completed',
            attemptId,
            routeId: session.route.routeId,
            blockOrdinal,
            block: cloneDecodedBlock(block),
            occurredAt: this.clock.now(),
          });
        }
        return validateDecodedModelAttempt(decoded);
      }
      const guardedEvents = guardModelStream(
        response.events,
        timeouts,
        controller,
        sourceSignal,
      );
      let finished: DecodedModelAttempt | undefined;
      for await (const event of session.codec.decodeStream(guardedEvents, context)) {
        if (event.type === 'usage') {
          await observeUsage(event.usage);
        } else if (event.type === 'block-complete') {
          await publishModelAttemptLifecycle(observer, {
            type: 'block-completed',
            attemptId,
            routeId: session.route.routeId,
            blockOrdinal: event.blockOrdinal,
            block: cloneDecodedBlock(event.block),
            occurredAt: this.clock.now(),
          });
        } else if (event.type !== 'finish') {
          await publishModelAttemptLifecycle(observer, {
            type: 'decoded-delta',
            attemptId,
            routeId: session.route.routeId,
            event: structuredClone(event),
            occurredAt: this.clock.now(),
          });
        }
        trackTentativeBlocks(tentativeBlocks, event);
        if (event.type === 'finish') {
          await observeUsage(event.attempt.usage);
          if (finished !== undefined) {
            throw new ModelProtocolError(
              'INVALID_WIRE_RESPONSE',
              'Codec emitted more than one terminal model attempt.',
            );
          }
          finished = event.attempt;
        }
      }
      if (finished === undefined) {
        throw new ModelProtocolError(
          'INCOMPLETE_MODEL_ATTEMPT',
          'Codec stream ended without a terminal model attempt.',
        );
      }
      return validateDecodedModelAttempt(finished);
    };

    const runPromise = run();
    try {
      const attempt = await raceModelDeadline(
        runPromise,
        timeouts.totalMs,
        'total',
        controller,
        sourceSignal,
      );
      return attempt;
    } catch (error) {
      if (!controller.signal.aborted) controller.abort(error);
      await boundedAttemptSettlement(runPromise);
      throw error;
    } finally {
      sourceSignal?.removeEventListener('abort', abortFromSource);
    }
  }
}

function applySessionGeneration(
  request: CanonicalModelRequest,
  session: ModelSession,
): CanonicalModelRequest {
  return {
    model: session.route.modelId,
    messages: structuredClone(request.messages),
    ...(request.tools === undefined ? {} : { tools: structuredClone(request.tools) }),
    ...(session.generation.temperature === undefined
      ? {}
      : { temperature: session.generation.temperature }),
    ...(session.generation.topP === undefined ? {} : { topP: session.generation.topP }),
    ...(session.generation.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: session.generation.maxOutputTokens }),
    ...(session.generation.seed === undefined ? {} : { seed: session.generation.seed }),
    ...(session.generation.stop === undefined ? {} : { stop: [...session.generation.stop] }),
    ...(session.generation.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: session.generation.reasoningEffort }),
  };
}

export function modelGatewayToProviderError(error: unknown): LlmProviderError {
  const providerError = findProviderError(error);
  if (providerError !== undefined) {
    const parameter = unsupportedGenerationParameter(providerError.message);
    if (parameter !== undefined) {
      return new LlmProviderError(
        'LLM_PARAMETER_UNSUPPORTED',
        providerError.message,
        false,
        undefined,
        { parameter },
      );
    }
    const responseStarted = error instanceof ModelGatewayError &&
      error.cause instanceof ModelClientError && error.cause.responseStarted;
    return responseStarted ? markStreamResponseStarted(providerError) : providerError;
  }
  if (error instanceof ModelGatewayError) {
    const unsupportedParameter = unsupportedGenerationParameter(error.message);
    const code = unsupportedParameter !== undefined
      ? 'LLM_PARAMETER_UNSUPPORTED'
      : error.code === 'MODEL_CANCELLED'
      ? 'LLM_ABORTED'
      : error.code === 'MODEL_TIMEOUT'
        ? 'LLM_TIMEOUT'
        : error.statusCode === 401 || error.statusCode === 403
          ? 'LLM_AUTH_FAILED'
          : error.statusCode === 429
            ? 'LLM_RATE_LIMITED'
        : error.code === 'MODEL_PROTOCOL_FAILED'
          ? 'LLM_BAD_RESPONSE'
          : 'LLM_PROVIDER_ERROR';
    return new LlmProviderError(
      code,
      error.message,
      error.retryable,
      error.statusCode,
      {
        ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
        ...(error.cause instanceof ModelClientError && error.cause.responseStarted
          ? { responseStarted: true }
          : {}),
        ...(unsupportedParameter === undefined ? {} : { parameter: unsupportedParameter }),
        ...(error.code === 'MODEL_CANCELLED' || unsupportedParameter !== undefined
          ? {}
          : { modelGatewayCode: error.code }),
      },
    );
  }
  if (error instanceof Error) {
    const parameter = unsupportedGenerationParameter(error.message);
    if (parameter !== undefined) {
      return new LlmProviderError(
        'LLM_PARAMETER_UNSUPPORTED',
        error.message,
        false,
        undefined,
        { parameter },
      );
    }
  }
  return normalizeProviderError(error);
}

function unsupportedGenerationParameter(message: string): string | undefined {
  const match = /(?:does not support generation parameter|generation parameter) ([A-Za-z]+)|^([A-Za-z]+) is not supported/.exec(
    message,
  );
  return match?.[1] ?? match?.[2];
}

function withDiscardedModelAttempts(
  error: ModelGatewayError,
  attempts: readonly DiscardedModelAttempt[],
): ModelGatewayError {
  return new ModelGatewayError(error.code, error.message, error.retryable, {
    ...error.options,
    discardedAttempts: Object.freeze(attempts.map(freezeDiscardedAttempt)),
  });
}

function validObservedModelUsage(usage: ModelTokenUsage): ModelTokenUsage {
  const inputTokens = validObservedTokenCount(usage.inputTokens, 'inputTokens');
  const outputTokens = validObservedTokenCount(usage.outputTokens, 'outputTokens');
  const totalTokens = validObservedTokenCount(usage.totalTokens, 'totalTokens');
  if (usage.cachedInputTokens === undefined) {
    return Object.freeze({ inputTokens, outputTokens, totalTokens });
  }
  const cachedInputTokens = validObservedTokenCount(
    usage.cachedInputTokens,
    'cachedInputTokens',
  );
  if (cachedInputTokens > inputTokens) {
    throw new ModelProtocolError(
      'INVALID_WIRE_RESPONSE',
      'Model token usage cachedInputTokens cannot exceed inputTokens.',
    );
  }
  return Object.freeze({ inputTokens, outputTokens, totalTokens, cachedInputTokens });
}

function validObservedTokenCount(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ModelProtocolError(
      'INVALID_WIRE_RESPONSE',
      `Model token usage ${name} must be a non-negative safe integer.`,
    );
  }
  return value;
}

function sameModelTokenUsage(left: ModelTokenUsage, right: ModelTokenUsage): boolean {
  return left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens &&
    left.totalTokens === right.totalTokens &&
    left.cachedInputTokens === right.cachedInputTokens;
}

function validateDecodedModelAttempt(attempt: DecodedModelAttempt): ValidatedModelAttempt {
  if (!attempt.terminal) {
    throw new ModelProtocolError(
      'INCOMPLETE_MODEL_ATTEMPT',
      'Model attempt did not contain protocol-recognized terminal framing.',
    );
  }
  const validated = deepFreeze({
    ...attempt,
    origin: { ...attempt.origin },
    blocks: attempt.blocks.map(cloneDecodedBlock),
    opaqueBlockRefs: [...attempt.opaqueBlockRefs],
    ...(attempt.usage === undefined ? {} : { usage: { ...attempt.usage } }),
    terminal: true as const,
    validation: 'validated' as const,
  }) as unknown as ValidatedModelAttempt;
  return mintAuthenticValidatedModelAttempt(validated);
}

async function* guardModelStream(
  events: AsyncIterable<unknown>,
  timeouts: ModelAttemptTimeouts,
  controller: AbortController,
  sourceSignal?: AbortSignal,
): AsyncIterable<unknown> {
  const iterator = events[Symbol.asyncIterator]();
  let first = true;
  try {
    while (true) {
      const next = await raceModelDeadline(
        iterator.next(),
        first ? timeouts.firstEventMs : timeouts.idleMs,
        first ? 'first-event' : 'idle',
        controller,
        sourceSignal,
      );
      if (next.done) return;
      first = false;
      yield next.value;
    }
  } finally {
    await boundedIteratorCleanup(iterator);
  }
}

async function boundedIteratorCleanup(iterator: AsyncIterator<unknown>): Promise<void> {
  if (iterator.return === undefined) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      iterator.return().then(() => undefined, () => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 50);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function raceModelDeadline<T>(
  operation: Promise<T>,
  milliseconds: number,
  phase: ModelTimeoutPhase,
  controller: AbortController,
  sourceSignal?: AbortSignal,
): Promise<T> {
  if (controller.signal.aborted) {
    void operation.catch(() => undefined);
    return Promise.reject(modelAttemptAbortError(controller.signal.reason, sourceSignal));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      const error = new ModelGatewayError(
        'MODEL_TIMEOUT',
        `Model attempt timed out during ${phase}.`,
        true,
        { phase },
      );
      finish(() => reject(error));
      controller.abort(error);
    }, milliseconds);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', cancel);
      callback();
    };
    const cancel = () => finish(() => reject(
      modelAttemptAbortError(controller.signal.reason, sourceSignal),
    ));
    controller.signal.addEventListener('abort', cancel, { once: true });
    void operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) =>
        finish(() => reject(error instanceof Error ? error : new Error(String(error)))),
    );
  });
}

async function boundedAttemptSettlement(operation: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation.then(() => undefined, () => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 75);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function modelAttemptAbortError(
  reason: unknown,
  sourceSignal?: AbortSignal,
): Error {
  if (sourceSignal?.aborted) return modelCancelledError(sourceSignal.reason);
  return reason instanceof Error
    ? reason
    : new ModelGatewayError('MODEL_TRANSPORT_FAILED', 'Model attempt aborted.', true, { cause: reason });
}

function trackTentativeBlocks(
  blocks: DecodedModelContentBlock[],
  event: DecodedModelStreamEvent,
): void {
  if (event.type === 'block-complete') {
    blocks[event.blockOrdinal] = cloneDecodedBlock(event.block);
    return;
  }
  if (event.type === 'text-delta' || event.type === 'reasoning-summary-delta') {
    const expectedType = event.type === 'text-delta' ? 'text' : 'reasoning-summary';
    const current = blocks[event.blockOrdinal];
    if (current === undefined) {
      blocks[event.blockOrdinal] = { type: expectedType, text: event.text };
    } else if (current.type === expectedType) {
      current.text += event.text;
    }
  }
}

async function publishModelAttemptLifecycle(
  observer: ModelAttemptLifecycleObserver | undefined,
  event: ModelAttemptLifecycleEvent,
): Promise<void> {
  if (observer === undefined) return;
  const immutableEvent = deepFreeze(structuredClone(event));
  try {
    await observer.onEvent(immutableEvent);
  } catch (error) {
    throw new ModelGatewayError(
      'MODEL_OBSERVER_FAILED',
      `Model attempt lifecycle observer rejected ${event.type}.`,
      false,
      { cause: error },
    );
  }
}

function classifyModelAttemptError(
  error: unknown,
  sourceSignal?: AbortSignal,
  nowMs = Date.now(),
): ModelGatewayError {
  if (sourceSignal?.aborted) return modelCancelledError(sourceSignal.reason);
  if (error instanceof ModelGatewayError) return error;
  if (error instanceof ModelProtocolError) {
    return new ModelGatewayError('MODEL_PROTOCOL_FAILED', error.message, false, { cause: error });
  }
  if (error instanceof ModelClientError) {
    const retryAfterMs = error.retryAfterMs ?? retryAfterMilliseconds(error.retryAfter, nowMs);
    const retryableHttp = error.retryable && (
      error.statusCode === 429 ||
      error.statusCode === 502 ||
      error.statusCode === 503 ||
      error.statusCode === 504);
    const retryableTransport =
      error.statusCode === undefined &&
      (error.code === 'CONNECT_FAILED' || error.code === 'STREAM_DISCONNECTED') &&
      error.retryable;
    return new ModelGatewayError(
      'MODEL_TRANSPORT_FAILED',
      error.message,
      retryableHttp || retryableTransport,
      {
        ...(error.statusCode === undefined ? {} : { statusCode: error.statusCode }),
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        cause: error,
      },
    );
  }
  return new ModelGatewayError(
    'MODEL_TRANSPORT_FAILED',
    error instanceof Error ? error.message : String(error),
    false,
    { cause: error },
  );
}

function modelCancelledError(cause: unknown): ModelGatewayError {
  return new ModelGatewayError(
    'MODEL_CANCELLED',
    'Model attempt was cancelled by the user.',
    false,
    { cause },
  );
}

function discardReason(error: unknown, normalized: ModelGatewayError): string {
  if (error instanceof ModelClientError) {
    if (error.statusCode !== undefined) return `HTTP_${error.statusCode}`;
    return error.code;
  }
  if (error instanceof ModelProtocolError) return error.code;
  if (normalized.code === 'MODEL_TIMEOUT') return `TIMEOUT_${normalized.phase ?? 'unknown'}`;
  return normalized.code;
}

function isModelFallbackEligible(error: ModelGatewayError): boolean {
  return error.retryable ||
    (error.code === 'MODEL_TRANSPORT_FAILED' && error.statusCode === 404);
}

function modelRetryError(error: ModelGatewayError): LlmProviderError {
  return new LlmProviderError(
    'LLM_PROVIDER_ERROR',
    error.message,
    error.retryable,
    error.statusCode,
    error.retryAfterMs === undefined ? undefined : { retryAfterMs: error.retryAfterMs },
  );
}

function modelAttemptTimeouts(input: Partial<ModelAttemptTimeouts> = {}): ModelAttemptTimeouts {
  return {
    connectMs: positiveModelAttemptInteger(
      input.connectMs ?? DEFAULT_MODEL_ATTEMPT_TIMEOUTS.connectMs,
      'connectMs',
    ),
    firstEventMs: positiveModelAttemptInteger(
      input.firstEventMs ?? DEFAULT_MODEL_ATTEMPT_TIMEOUTS.firstEventMs,
      'firstEventMs',
    ),
    idleMs: positiveModelAttemptInteger(
      input.idleMs ?? DEFAULT_MODEL_ATTEMPT_TIMEOUTS.idleMs,
      'idleMs',
    ),
    totalMs: positiveModelAttemptInteger(
      input.totalMs ?? DEFAULT_MODEL_ATTEMPT_TIMEOUTS.totalMs,
      'totalMs',
    ),
  };
}

function modelAttemptRetry(input: Partial<ModelAttemptRetryPolicy> = {}): ModelAttemptRetryPolicy {
  const baseDelayMs = positiveModelAttemptInteger(
    input.baseDelayMs ?? DEFAULT_MODEL_ATTEMPT_RETRY.baseDelayMs,
    'baseDelayMs',
  );
  const maxDelayMs = positiveModelAttemptInteger(
    input.maxDelayMs ?? DEFAULT_MODEL_ATTEMPT_RETRY.maxDelayMs,
    'maxDelayMs',
  );
  const jitterRatio = input.jitterRatio ?? DEFAULT_MODEL_ATTEMPT_RETRY.jitterRatio;
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
    throw new Error('jitterRatio must be between 0 and 1.');
  }
  return { baseDelayMs, maxDelayMs, jitterRatio };
}

function positiveModelAttemptInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

function boundedModelAttemptInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function cloneDecodedBlock(block: DecodedModelContentBlock): DecodedModelContentBlock {
  return structuredClone(block);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function freezeDiscardedAttempt(attempt: DiscardedModelAttempt): DiscardedModelAttempt {
  return Object.freeze({
    ...attempt,
    blocks: Object.freeze(attempt.blocks.map(cloneDecodedBlock)),
  });
}

async function modelAttemptDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw modelCancelledError(signal.reason);
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const cancel = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      reject(modelCancelledError(signal?.reason));
    };
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

function normalizeProviderError(error: unknown): LlmProviderError {
  if (error instanceof LlmProviderError) return error;
  return new LlmProviderError(
    'LLM_PROVIDER_ERROR',
    error instanceof Error ? error.message : String(error),
    true,
  );
}

function markStreamResponseStarted(error: unknown): LlmProviderError {
  const normalized = normalizeProviderError(error);
  return new LlmProviderError(
    normalized.code,
    normalized.message,
    normalized.retryable,
    normalized.statusCode,
    { ...(normalized.detail ?? {}), responseStarted: true },
  );
}

function findProviderError(error: unknown): LlmProviderError | undefined {
  let current: unknown = error;
  const visited = new Set<unknown>();
  while (current instanceof Error && !visited.has(current)) {
    if (current instanceof LlmProviderError) return current;
    visited.add(current);
    current = current.cause;
  }
  return undefined;
}
