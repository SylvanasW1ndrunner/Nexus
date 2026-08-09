import { createHash, randomUUID } from 'node:crypto';
import type { RoundContext, UsageTracker } from '@dbagent/core-usage';
import { LlmAsyncJobManager, type LlmAsyncJob } from './async-jobs.js';
import {
  LlmBudgetController,
  type LlmBudgetLimits,
  type LlmBudgetScope,
  type LlmBudgetReservation,
} from './budget.js';
import {
  LlmModelRegistry,
  type RegisterModelInput,
  type RegisteredLlmModel,
} from './model-registry.js';
import { estimateMessagesTokens } from './prompt-runtime.js';
import {
  assertGenerationParametersSupported,
  generationConfigFromRequest,
  resolveLlmOutputReservation,
  validateLlmGenerationConfig,
} from './generation-config.js';
import { LlmReliabilityController, type LlmReliabilityConfig } from './reliability.js';
import { LlmResponseCache } from './response-cache.js';
import {
  ModelClientError,
  type ModelSession,
} from './model-client.js';
import {
  ModelProtocolError,
  type CanonicalModelRequest,
} from './protocol/codec.js';
import type {
  DecodedModelAttempt,
  ValidatedModelAttempt,
} from './protocol/envelope.js';
import type { DecodedModelContentBlock } from './protocol/content.js';
import type { DecodedModelStreamEvent } from './protocol/model-stream.js';
import { retryAfterMilliseconds, retryDelayFromError } from './retry-policy.js';
import {
  estimateModelCost,
  LlmTaskRouter,
  type LlmPolicyLayers,
  type LlmRouteDecision,
  type LlmTaskProfile,
} from './routing.js';
import { StructuredOutputValidator } from './structured-output.js';
import { assertNoTextualToolInvocation } from './tool-protocol.js';
import {
  CompositeLlmTelemetrySink,
  InMemoryLlmTelemetrySink,
  LlmMetricsCollector,
  type LlmMetricsSnapshot,
  type LlmTelemetryEvent,
  type LlmTelemetrySink,
} from './telemetry.js';
import {
  LlmProviderError,
  type LlmCapabilityName,
  type LlmChatRequest,
  type LlmChatResponse,
  type LlmChatStreamEvent,
  type LlmEmbeddingRequest,
  type LlmEmbeddingResponse,
  type LlmProvider,
  type LlmRerankRequest,
  type LlmRerankResponse,
  type LlmUsage,
} from './types.js';

export type LlmGatewayContext = {
  tenantId: string;
  taskType: string;
  userId?: string;
  requestId?: string;
  traceId?: string;
};

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
};

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
  | 'MODEL_FALLBACK_INCOMPATIBLE';

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
    session: ModelSession,
    request: CanonicalModelRequest,
    options: ModelAttemptOptions = {},
  ): Promise<ModelAttemptExecution> {
    if (request.model !== session.route.modelId) {
      throw new ModelGatewayError(
        'MODEL_PROTOCOL_FAILED',
        `Canonical request model ${request.model} does not match frozen route ${session.route.modelId}.`,
        false,
      );
    }
    const fallbacks = [...(options.fallbacks ?? [])];
    assertCompatibleFallbacks(session, fallbacks);
    const maxRetries = boundedModelAttemptInteger(options.maxRetries ?? 1, 0, 10, 'maxRetries');
    const timeouts = modelAttemptTimeouts(options.timeouts);
    const retry = modelAttemptRetry(options.retry);
    const discarded: DiscardedModelAttempt[] = [];
    let terminalError: ModelGatewayError | undefined;

    for (const candidate of [session, ...fallbacks]) {
      for (let retryIndex = 0; retryIndex <= maxRetries; retryIndex += 1) {
        const attemptId = this.createAttemptId();
        const tentativeBlocks: DecodedModelContentBlock[] = [];
        try {
          const attempt = await this.executeOne(
            candidate,
            request,
            attemptId,
            timeouts,
            options.signal,
            tentativeBlocks,
          );
          return Object.freeze({
            attempt,
            session: candidate,
            discardedAttempts: Object.freeze(discarded.map(freezeDiscardedAttempt)),
          });
        } catch (error) {
          terminalError = classifyModelAttemptError(error, options.signal, this.clock.now());
          if (terminalError.code === 'MODEL_CANCELLED') throw terminalError;
          discarded.push({
            attemptId,
            routeId: candidate.route.routeId,
            reason: discardReason(error, terminalError),
            blocks: tentativeBlocks.map(cloneDecodedBlock),
            discardedAt: this.clock.now(),
          });
          if (!terminalError.retryable) throw terminalError;
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
              throw classifyModelAttemptError(error, options.signal, this.clock.now());
            }
          }
        }
      }
    }
    throw terminalError ?? new ModelGatewayError(
      'MODEL_TRANSPORT_FAILED',
      'No model attempt was executed.',
      false,
    );
  }

  private async executeOne(
    session: ModelSession,
    request: CanonicalModelRequest,
    attemptId: string,
    timeouts: ModelAttemptTimeouts,
    sourceSignal: AbortSignal | undefined,
    tentativeBlocks: DecodedModelContentBlock[],
  ): Promise<ValidatedModelAttempt> {
    const controller = new AbortController();
    const abortFromSource = () => controller.abort(sourceSignal?.reason);
    sourceSignal?.addEventListener('abort', abortFromSource, { once: true });
    if (sourceSignal?.aborted) controller.abort(sourceSignal.reason);
    const canonicalRequest = applySessionGeneration(request, session);
    let encoded: ReturnType<ModelSession['codec']['encode']>;
    try {
      encoded = session.codec.encode(canonicalRequest, {
        requestId: attemptId,
        target: {
          connectionId: session.route.connectionId,
          model: session.route.modelId,
          protocol: session.route.protocol,
        },
        replay: { mode: 'new' },
      });
    } catch (error) {
      sourceSignal?.removeEventListener('abort', abortFromSource);
      throw error;
    }

    const run = async (): Promise<ValidatedModelAttempt> => {
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
        return validateDecodedModelAttempt(session.codec.decode(response.response, context));
      }
      const guardedEvents = guardModelStream(
        response.events,
        timeouts,
        controller,
        sourceSignal,
      );
      let finished: DecodedModelAttempt | undefined;
      for await (const event of session.codec.decodeStream(guardedEvents, context)) {
        trackTentativeBlocks(tentativeBlocks, event);
        if (event.type === 'finish') {
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

    try {
      return await raceModelDeadline(
        run(),
        timeouts.totalMs,
        'total',
        controller,
        sourceSignal,
      );
    } finally {
      sourceSignal?.removeEventListener('abort', abortFromSource);
    }
  }
}

export type LlmGatewayChatRequest = Omit<LlmChatRequest, 'model'> & { model?: string };

export type LlmGatewayChatInput = {
  request: LlmGatewayChatRequest;
  context: LlmGatewayContext;
  task?: Omit<LlmTaskProfile, 'taskType'>;
  policies?: LlmPolicyLayers;
  providerId?: string;
  modelId?: string;
  budget?: LlmBudgetLimits;
  round?: RoundContext;
  cache?: { enabled: boolean; ttlMs?: number; namespace?: string };
  timeoutMs?: number;
  maxRetries?: number;
  maxFallbacks?: number;
  maxStructuredCorrections?: number;
  /** Compatibility escape hatch for runtimes that apply their own tool permission checks. */
  validateToolCalls?: boolean;
};

export type LlmGatewayResult = {
  requestId: string;
  traceId: string;
  response: LlmChatResponse;
  route: LlmRouteDecision;
  providerId: string;
  modelId: string;
  attempts: number;
  cacheHit: boolean;
  usage: LlmUsage;
  cost?: number;
};

export type LlmGatewayOptions = {
  registry?: LlmModelRegistry;
  usageTracker?: UsageTracker;
  telemetry?: LlmTelemetrySink[];
  metrics?: LlmMetricsCollector;
  cache?: LlmResponseCache;
  budget?: LlmBudgetController;
  reliability?: LlmReliabilityController;
  now?: () => Date;
  createRequestId?: () => string;
};

type AttemptUsage = { model: RegisteredLlmModel; usage: LlmUsage };

export type LlmCompatibilityFallbackResult<TCandidate, TResult> = {
  candidate: TCandidate;
  result: TResult;
  attempts: readonly string[];
};

export type LlmCompatibilityFallbackInput<TCandidate, TResult> = {
  candidates: readonly TCandidate[];
  candidateId: (candidate: TCandidate) => string;
  execute: (candidate: TCandidate) => Promise<TResult>;
  classifyError: (candidate: TCandidate, error: unknown) => LlmProviderError;
  shouldFallback: (error: LlmProviderError) => boolean;
};

export type LlmCompatibilityStreamFallbackInput<TCandidate, TEvent> = Omit<
  LlmCompatibilityFallbackInput<TCandidate, never>,
  'execute'
> & {
  stream: (candidate: TCandidate) => AsyncIterable<TEvent>;
};

export class LlmGateway {
  readonly registry: LlmModelRegistry;
  readonly telemetry: InMemoryLlmTelemetrySink;
  readonly metrics: LlmMetricsCollector;
  readonly cache: LlmResponseCache;
  readonly budget: LlmBudgetController;
  readonly reliability: LlmReliabilityController;

  private readonly router: LlmTaskRouter;
  private readonly validator = new StructuredOutputValidator();
  private readonly telemetrySink: LlmTelemetrySink;
  private readonly usageTracker: UsageTracker | undefined;
  private readonly now: () => Date;
  private readonly createRequestId: () => string;
  private readonly jobs: LlmAsyncJobManager<LlmGatewayChatInput, LlmGatewayResult>;

  constructor(options: LlmGatewayOptions = {}) {
    this.registry = options.registry ?? new LlmModelRegistry();
    this.telemetry = new InMemoryLlmTelemetrySink();
    this.metrics = options.metrics ?? new LlmMetricsCollector();
    this.telemetrySink = new CompositeLlmTelemetrySink([
      this.telemetry,
      this.metrics,
      ...(options.telemetry ?? []),
    ]);
    this.cache = options.cache ?? new LlmResponseCache();
    this.budget = options.budget ?? new LlmBudgetController();
    this.reliability = options.reliability ?? new LlmReliabilityController();
    this.usageTracker = options.usageTracker;
    this.now = options.now ?? (() => new Date());
    this.createRequestId = options.createRequestId ?? randomUUID;
    this.router = new LlmTaskRouter(this.registry, this.now);
    this.jobs = new LlmAsyncJobManager(async (input, signal) => {
      const request = { ...input.request, signal };
      return await this.execute({ ...input, request });
    }, this.now);
  }

  registerProvider(
    provider: LlmProvider,
    models: Array<Omit<RegisterModelInput, 'providerId'>> = [],
  ): void {
    this.registry.registerProvider(provider);
    for (const model of models) this.registerModel({ ...model, providerId: provider.id });
  }

  registerModel(input: RegisterModelInput): RegisteredLlmModel {
    const model = this.registry.registerModel(input);
    const providerModels = this.registry
      .listModels()
      .filter((candidate) => candidate.providerId === model.providerId);
    const maxConcurrency = minimumDefined(
      providerModels.map((candidate) => candidate.limits.maxConcurrency),
    );
    const requestsPerMinute = minimumDefined(
      providerModels.map((candidate) => candidate.limits.requestsPerMinute),
    );
    const tokensPerMinute = minimumDefined(
      providerModels.map((candidate) => candidate.limits.tokensPerMinute),
    );
    this.reliability.configure(model.providerId, {
      ...(maxConcurrency === undefined ? {} : { maxConcurrency }),
      ...(requestsPerMinute === undefined ? {} : { requestsPerMinute }),
      ...(tokensPerMinute === undefined ? {} : { tokensPerMinute }),
    });
    return model;
  }

  configureReliability(providerId: string, config: Partial<LlmReliabilityConfig>): void {
    this.reliability.configure(providerId, config);
  }

  /**
   * Compatibility boundary for the legacy connection/provider API. Protocol fallback stays in
   * the Gateway while callers migrate to ModelExecutionGateway and immutable ModelSessions.
   */
  async executeCompatibilityFallback<TCandidate, TResult>(
    input: LlmCompatibilityFallbackInput<TCandidate, TResult>,
  ): Promise<LlmCompatibilityFallbackResult<TCandidate, TResult>> {
    const attempts: string[] = [];
    let lastError: LlmProviderError | undefined;
    for (let index = 0; index < input.candidates.length; index += 1) {
      const candidate = input.candidates[index]!;
      attempts.push(input.candidateId(candidate));
      try {
        return Object.freeze({
          candidate,
          result: await input.execute(candidate),
          attempts: Object.freeze([...attempts]),
        });
      } catch (error) {
        lastError = input.classifyError(candidate, error);
        if (index + 1 >= input.candidates.length || !input.shouldFallback(lastError)) {
          throw lastError;
        }
      }
    }
    throw lastError ?? new LlmProviderError('LLM_NO_ROUTE', 'No usable LLM route exists.', false);
  }

  /** Gateway-owned streaming counterpart to executeCompatibilityFallback. */
  async *streamCompatibilityFallback<TCandidate, TEvent>(
    input: LlmCompatibilityStreamFallbackInput<TCandidate, TEvent>,
  ): AsyncIterable<TEvent> {
    let lastError: LlmProviderError | undefined;
    for (let index = 0; index < input.candidates.length; index += 1) {
      const candidate = input.candidates[index]!;
      let responseStarted = false;
      try {
        for await (const event of input.stream(candidate)) {
          responseStarted = true;
          yield event;
        }
        return;
      } catch (error) {
        lastError = input.classifyError(candidate, error);
        if (
          responseStarted ||
          index + 1 >= input.candidates.length ||
          !input.shouldFallback(lastError)
        ) {
          throw lastError;
        }
      }
    }
    throw lastError ??
      new LlmProviderError('LLM_NO_ROUTE', 'No usable LLM streaming route exists.', false);
  }

  async chat(input: LlmGatewayChatInput): Promise<LlmChatResponse> {
    return (await this.execute(input)).response;
  }

  async execute(input: LlmGatewayChatInput): Promise<LlmGatewayResult> {
    const execution = this.prepareExecution(input, false);
    const startedAt = performance.now();
    await this.emit(
      execution.event('request.started', { estimatedTokens: execution.estimatedInputTokens }),
    );
    await this.emit(
      execution.event('route.decided', {
        providerId: execution.route.selected.model.providerId,
        modelId: execution.route.selected.model.id,
        latencyMs: execution.routeLatencyMs,
        attributes: { fallbackCount: execution.candidates.length - 1 },
      }),
    );

    const primaryCandidate = execution.candidates[0] as RegisteredLlmModel;
    const primaryCached = input.cache?.enabled
      ? this.cache.get(
          input.context.tenantId,
          primaryCandidate.providerId,
          withSelectedModel(input.request, primaryCandidate.model),
          input.cache.namespace,
        )
      : undefined;
    if (primaryCached) {
      await this.emit(execution.event('cache.hit'));
      await this.emit(
        execution.event('request.completed', {
          providerId: primaryCandidate.providerId,
          modelId: primaryCandidate.id,
          latencyMs: performance.now() - startedAt,
          attributes: { cacheHit: true },
        }),
      );
      return {
        requestId: execution.requestId,
        traceId: execution.traceId,
        response: primaryCached,
        route: execution.route,
        providerId: primaryCandidate.providerId,
        modelId: primaryCandidate.id,
        attempts: 0,
        cacheHit: true,
        usage: primaryCached.usage ?? zeroUsage(),
      };
    }
    if (input.cache?.enabled) await this.emit(execution.event('cache.miss'));

    let reservation: LlmBudgetReservation | undefined;
    try {
      reservation = this.reserveBudget(input, execution);
      if (reservation)
        await this.emit(
          execution.event('budget.reserved', { estimatedTokens: reservation.estimatedTokens }),
        );
    } catch (error) {
      const normalized = normalizeProviderError(error);
      await this.emit(
        execution.event('request.failed', {
          latencyMs: performance.now() - startedAt,
          errorCode: normalized.code,
          attributes: { attempts: 0 },
        }),
      );
      throw normalized;
    }
    const attemptUsages: AttemptUsage[] = [];
    let attempts = 0;
    let lastError: unknown;

    try {
      for (
        let candidateIndex = 0;
        candidateIndex < execution.candidates.length;
        candidateIndex += 1
      ) {
        const candidate = execution.candidates[candidateIndex] as RegisteredLlmModel;
        const provider = this.requireProvider(candidate.providerId);
        const candidateRequest = withSelectedModel(input.request, candidate.model);
        if (candidateIndex > 0) {
          await this.emit(
            execution.event('provider.fallback', {
              providerId: candidate.providerId,
              modelId: candidate.id,
              attributes: { candidateIndex },
            }),
          );
          const cached = input.cache?.enabled
            ? this.cache.get(
                input.context.tenantId,
                candidate.providerId,
                candidateRequest,
                input.cache.namespace,
              )
            : undefined;
          if (cached) {
            const attemptedUsage = sumUsage(attemptUsages.map((item) => item.usage));
            const attemptedCost = sumAttemptCost(attemptUsages);
            if (reservation) {
              if (attemptUsages.length > 0) {
                this.budget.commitActual(reservation.id, attemptedUsage.totalTokens, attemptedCost);
              } else {
                this.budget.release(reservation.id);
              }
            }
            if (attemptUsages.length > 0) {
              await this.recordAttemptUsage(input.round, attemptUsages);
            }
            await this.emit(execution.event('cache.hit'));
            await this.emit(
              execution.event('request.completed', {
                providerId: candidate.providerId,
                modelId: candidate.id,
                latencyMs: performance.now() - startedAt,
                attributes: { cacheHit: true, attempts },
              }),
            );
            return {
              requestId: execution.requestId,
              traceId: execution.traceId,
              response: cached,
              route: execution.route,
              providerId: candidate.providerId,
              modelId: candidate.id,
              attempts,
              cacheHit: true,
              usage: cached.usage ?? zeroUsage(),
            };
          }
        }
        try {
          assertGenerationParametersSupported(
            candidate.generationParameters,
            validateLlmGenerationConfig(generationConfigFromRequest(candidateRequest)),
          );
        } catch (error) {
          lastError = error;
          continue;
        }
        for (let retry = 0; retry <= execution.maxRetries; retry += 1) {
          attempts += 1;
          await this.emit(
            execution.event('provider.attempt', {
              providerId: candidate.providerId,
              modelId: candidate.id,
              attempt: attempts,
            }),
          );
          try {
            const response = await this.callWithStructuredCorrection(
              provider,
              candidate,
              input,
              execution.maxCorrections,
              attemptUsages,
              execution,
            );
            this.reliability.recordSuccess(candidate.providerId);
            const usage = sumUsage(attemptUsages.map((item) => item.usage));
            const resultResponse = { ...response, usage };
            const cost = sumAttemptCost(attemptUsages);
            if (reservation) this.budget.commitActual(reservation.id, usage.totalTokens, cost);
            await this.recordAttemptUsage(input.round, attemptUsages);
            if (input.cache?.enabled) {
              this.cache.set(
                input.context.tenantId,
                candidate.providerId,
                candidateRequest,
                resultResponse,
                {
                  ...(input.cache.namespace === undefined
                    ? {}
                    : { namespace: input.cache.namespace }),
                  ...(input.cache.ttlMs === undefined ? {} : { ttlMs: input.cache.ttlMs }),
                },
              );
            }
            await this.emit(
              execution.event('request.completed', {
                providerId: candidate.providerId,
                modelId: candidate.id,
                latencyMs: performance.now() - startedAt,
                promptTokens: usage.promptTokens,
                completionTokens: usage.completionTokens,
                cost,
                attributes: { cacheHit: false, attempts, usageEstimated: usage.estimated ?? false },
              }),
            );
            return {
              requestId: execution.requestId,
              traceId: execution.traceId,
              response: resultResponse,
              route: execution.route,
              providerId: candidate.providerId,
              modelId: candidate.id,
              attempts,
              cacheHit: false,
              usage,
              cost,
            };
          } catch (error) {
            lastError = normalizeTimeoutError(error);
            if (isAborted(lastError)) throw lastError;
            if (isRetryable(lastError)) {
              attemptUsages.push({
                model: candidate,
                usage: estimateFailedAttemptUsage(input.request, candidate.model),
              });
            }
            const opened =
              shouldAffectCircuit(lastError) &&
              this.reliability.recordFailure(candidate.providerId);
            if (opened) {
              await this.emit(
                execution.event('provider.circuit_opened', {
                  providerId: candidate.providerId,
                  modelId: candidate.id,
                }),
              );
            }
            if (!isRetryable(lastError) || retry === execution.maxRetries) break;
            await this.emit(
              execution.event('provider.retry', {
                providerId: candidate.providerId,
                modelId: candidate.id,
                attempt: attempts,
                errorCode: errorCode(lastError),
              }),
            );
            await cancellableDelay(Math.min(2_000, 100 * 2 ** retry), input.request.signal);
          }
        }
      }
      if (lastError !== undefined) throw normalizeProviderError(lastError);
      throw new LlmProviderError('LLM_NO_ROUTE', 'All routed LLM candidates failed.', true);
    } catch (error) {
      const normalized = normalizeProviderError(error);
      const usage = sumUsage(attemptUsages.map((item) => item.usage));
      const cost = sumAttemptCost(attemptUsages);
      if (reservation) {
        if (attemptUsages.length > 0)
          this.budget.commitActual(reservation.id, usage.totalTokens, cost);
        else this.budget.release(reservation.id);
      }
      if (attemptUsages.length > 0) await this.recordAttemptUsage(input.round, attemptUsages);
      await this.emit(
        execution.event(isAborted(normalized) ? 'request.cancelled' : 'request.failed', {
          latencyMs: performance.now() - startedAt,
          errorCode: normalized.code,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          cost,
          attributes: { attempts, usageEstimated: usage.estimated ?? false },
        }),
      );
      throw normalized;
    }
  }

  async *stream(input: LlmGatewayChatInput): AsyncIterable<LlmChatStreamEvent> {
    const execution = this.prepareExecution(input, true);
    const startedAt = performance.now();
    await this.emit(
      execution.event('request.started', { estimatedTokens: execution.estimatedInputTokens }),
    );
    await this.emit(
      execution.event('route.decided', {
        providerId: execution.route.selected.model.providerId,
        modelId: execution.route.selected.model.id,
        latencyMs: execution.routeLatencyMs,
      }),
    );
    let reservation: LlmBudgetReservation | undefined;
    try {
      reservation = this.reserveBudget(input, execution);
      if (reservation)
        await this.emit(
          execution.event('budget.reserved', { estimatedTokens: reservation.estimatedTokens }),
        );
    } catch (error) {
      const normalized = normalizeProviderError(error);
      await this.emit(
        execution.event('request.failed', {
          latencyMs: performance.now() - startedAt,
          errorCode: normalized.code,
          attributes: { attempts: 0, streaming: true },
        }),
      );
      throw normalized;
    }
    const attemptUsages: AttemptUsage[] = [];
    let attempts = 0;
    let lastError: unknown;
    let visibleOutput = false;
    let responseStarted = false;
    try {
      for (
        let candidateIndex = 0;
        candidateIndex < execution.candidates.length;
        candidateIndex += 1
      ) {
        const candidate = execution.candidates[candidateIndex] as RegisteredLlmModel;
        const provider = this.requireProvider(candidate.providerId);
        if (candidateIndex > 0)
          await this.emit(
            execution.event('provider.fallback', {
              providerId: candidate.providerId,
              modelId: candidate.id,
            }),
          );
        try {
          assertGenerationParametersSupported(
            candidate.generationParameters,
            validateLlmGenerationConfig(generationConfigFromRequest(input.request as LlmChatRequest)),
          );
        } catch (error) {
          lastError = error;
          continue;
        }
        for (let retry = 0; retry <= execution.maxRetries; retry += 1) {
          attempts += 1;
          await this.emit(
            execution.event('provider.attempt', {
              providerId: candidate.providerId,
              modelId: candidate.id,
              attempt: attempts,
            }),
          );
          const request = withSelectedModel(input.request, candidate.model);
          const deadline = deadlineSignal(request.signal, input.timeoutMs);
          const buffered: LlmChatStreamEvent[] = [];
          let finalResponse: LlmChatResponse | undefined;
          let release: (() => void) | undefined;
          try {
            release = await this.reliability.lease(
              candidate.providerId,
              deadline.signal,
              estimateMessagesTokens(request.messages) + (request.maxTokens ?? 4_096),
            );
            const iterable = provider.stream
              ? provider.stream({ ...request, signal: deadline.signal })
              : emulateStream(await provider.chat({ ...request, signal: deadline.signal }));
            for await (const event of iterable) {
              responseStarted = true;
              if (event.type === 'finish') finalResponse = event.response;
              const contentEvent =
                event.type === 'text-delta' ||
                event.type === 'tool-call-delta' ||
                event.type === 'tool-call';
              if (!visibleOutput && !contentEvent) {
                buffered.push(event);
                continue;
              }
              if (!visibleOutput) {
                visibleOutput = true;
                for (const pending of buffered) yield pending;
              }
              yield event;
            }
            if (!visibleOutput) {
              visibleOutput = true;
              for (const pending of buffered) yield pending;
            }
            const response = finalResponse ?? emptyResponse(candidate.model);
            this.validateResponse(response, request, input.validateToolCalls ?? true);
            const usage = response.usage ?? estimateResponseUsage(request, response);
            attemptUsages.push({ model: candidate, usage });
            const totalUsage = sumUsage(attemptUsages.map((item) => item.usage));
            const cost = sumAttemptCost(attemptUsages);
            if (reservation) this.budget.commitActual(reservation.id, totalUsage.totalTokens, cost);
            await this.recordAttemptUsage(input.round, attemptUsages);
            this.reliability.recordSuccess(candidate.providerId);
            await this.emit(
              execution.event('request.completed', {
                providerId: candidate.providerId,
                modelId: candidate.id,
                latencyMs: performance.now() - startedAt,
                promptTokens: totalUsage.promptTokens,
                completionTokens: totalUsage.completionTokens,
                cost,
                attributes: {
                  attempts,
                  streaming: true,
                  usageEstimated: totalUsage.estimated ?? false,
                },
              }),
            );
            return;
          } catch (error) {
            lastError = deadline.timedOut()
              ? timeoutError(input.timeoutMs)
              : normalizeProviderError(error);
            if (responseStarted || isAborted(lastError)) {
              throw responseStarted ? markStreamResponseStarted(lastError) : lastError;
            }
            if (isRetryable(lastError)) {
              attemptUsages.push({
                model: candidate,
                usage: estimateFailedAttemptUsage(input.request, candidate.model),
              });
            }
            const opened =
              shouldAffectCircuit(lastError) &&
              this.reliability.recordFailure(candidate.providerId);
            if (opened)
              await this.emit(
                execution.event('provider.circuit_opened', {
                  providerId: candidate.providerId,
                  modelId: candidate.id,
                }),
              );
            if (!isRetryable(lastError) || retry === execution.maxRetries) break;
            await this.emit(
              execution.event('provider.retry', {
                providerId: candidate.providerId,
                modelId: candidate.id,
                attempt: attempts,
                errorCode: errorCode(lastError),
              }),
            );
          } finally {
            deadline.cleanup();
            release?.();
          }
        }
      }
      if (lastError !== undefined) throw normalizeProviderError(lastError);
      throw new LlmProviderError('LLM_NO_ROUTE', 'All routed LLM stream candidates failed.', true);
    } catch (error) {
      const normalized = normalizeProviderError(error);
      const usage = sumUsage(attemptUsages.map((item) => item.usage));
      const cost = sumAttemptCost(attemptUsages);
      if (reservation) {
        if (attemptUsages.length > 0)
          this.budget.commitActual(reservation.id, usage.totalTokens, cost);
        else this.budget.release(reservation.id);
      }
      if (attemptUsages.length > 0) await this.recordAttemptUsage(input.round, attemptUsages);
      await this.emit(
        execution.event(isAborted(normalized) ? 'request.cancelled' : 'request.failed', {
          latencyMs: performance.now() - startedAt,
          errorCode: normalized.code,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          cost,
          attributes: { attempts, streaming: true, usageEstimated: usage.estimated ?? false },
        }),
      );
      throw normalized;
    }
  }

  submitBatch(
    inputs: LlmGatewayChatInput[],
    options: { concurrency?: number; ownerId?: string } = {},
  ): LlmAsyncJob<LlmGatewayResult> {
    if (inputs.length === 0) throw new Error('An async LLM job requires at least one item.');
    const tenantId = inputs[0]?.context?.tenantId;
    if (typeof tenantId !== 'string' || !tenantId.trim()) {
      throw new Error('tenantId is required for async LLM job isolation.');
    }
    if (inputs.some((input) => input.context?.tenantId !== tenantId)) {
      throw new Error('All items in an async LLM batch must belong to the same tenant.');
    }
    return this.jobs.submit(inputs, {
      ownerId: asyncJobOwnerKey(tenantId, options.ownerId),
      ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    });
  }

  getJob(
    id: string,
    tenantId: string,
    ownerId?: string,
  ): LlmAsyncJob<LlmGatewayResult> | undefined {
    return this.jobs.get(id, asyncJobOwnerKey(tenantId, ownerId));
  }

  cancelJob(
    id: string,
    tenantId: string,
    ownerId?: string,
  ): LlmAsyncJob<LlmGatewayResult> | undefined {
    return this.jobs.cancel(id, asyncJobOwnerKey(tenantId, ownerId));
  }

  listJobs(tenantId: string, ownerId?: string): Array<LlmAsyncJob<LlmGatewayResult>> {
    return this.jobs.list(asyncJobOwnerKey(tenantId, ownerId));
  }

  metricsSnapshot(): LlmMetricsSnapshot {
    return this.metrics.snapshot();
  }

  async embed(input: {
    request: LlmEmbeddingRequest;
    context: LlmGatewayContext;
    providerId?: string;
    modelId?: string;
    task?: Omit<LlmTaskProfile, 'taskType'>;
    policies?: LlmPolicyLayers;
  }): Promise<LlmEmbeddingResponse> {
    const model = this.routeCapability(input, 'embeddings', input.request.model);
    const provider = this.requireProvider(model.providerId);
    if (!provider.embed)
      throw new LlmProviderError(
        'LLM_CAPABILITY_UNSUPPORTED',
        `Provider does not implement embeddings: ${model.providerId}`,
        false,
      );
    const response = await this.reliability.execute(
      model.providerId,
      async () =>
        provider.embed?.({ ...input.request, model: model.model }) as Promise<LlmEmbeddingResponse>,
      input.request.signal,
      input.request.input.reduce(
        (total, value) => total + Math.max(1, Math.ceil(value.length / 3)),
        0,
      ),
    );
    this.reliability.recordSuccess(model.providerId);
    return response;
  }

  async rerank(input: {
    request: LlmRerankRequest;
    context: LlmGatewayContext;
    providerId?: string;
    modelId?: string;
    task?: Omit<LlmTaskProfile, 'taskType'>;
    policies?: LlmPolicyLayers;
  }): Promise<LlmRerankResponse> {
    const model = this.routeCapability(input, 'rerank', input.request.model);
    const provider = this.requireProvider(model.providerId);
    if (!provider.rerank)
      throw new LlmProviderError(
        'LLM_CAPABILITY_UNSUPPORTED',
        `Provider does not implement rerank: ${model.providerId}`,
        false,
      );
    const response = await this.reliability.execute(
      model.providerId,
      async () =>
        provider.rerank?.({ ...input.request, model: model.model }) as Promise<LlmRerankResponse>,
      input.request.signal,
      Math.max(
        1,
        Math.ceil((input.request.query.length + input.request.documents.join('').length) / 3),
      ),
    );
    this.reliability.recordSuccess(model.providerId);
    return response;
  }

  private prepareExecution(input: LlmGatewayChatInput, streaming: boolean) {
    validateGatewayInput(input);
    const exactModel =
      input.providerId && input.request.model
        ? this.ensureModel(input.providerId, input.request.model)
        : input.modelId
          ? this.registry.model(input.modelId)
          : undefined;
    const requiredModelIds = input.modelId
      ? [input.modelId]
      : input.providerId && input.request.model
        ? [`${input.providerId}:${input.request.model}`]
        : input.task?.requirements?.requiredModelIds;
    const capabilities = new Set<LlmCapabilityName>(input.task?.requirements?.capabilities ?? []);
    capabilities.add('chat');
    if (streaming) capabilities.add('streaming');
    if (input.request.tools?.length) capabilities.add('toolCalling');
    if (input.request.responseFormat && input.request.responseFormat.type !== 'text')
      capabilities.add('structuredOutput');
    const estimatedInputTokens = estimateMessagesTokens(input.request.messages);
    const requestedOutputTokens =
      input.request.maxTokens ??
      (exactModel === undefined
        ? 4_096
        : (resolveLlmOutputReservation(
            exactModel.limits.contextTokens,
            exactModel.limits.maxOutputTokens,
          ) ?? 4_096));
    const task: LlmTaskProfile = {
      taskType: input.context.taskType,
      ...(input.task?.preferences === undefined ? {} : { preferences: input.task.preferences }),
      requirements: {
        ...input.task?.requirements,
        capabilities: [...capabilities],
        minContextTokens: Math.max(
          input.task?.requirements?.minContextTokens ?? 0,
          estimatedInputTokens + requestedOutputTokens,
        ),
        minOutputTokens: Math.max(
          input.task?.requirements?.minOutputTokens ?? 0,
          requestedOutputTokens,
        ),
        ...(requiredModelIds === undefined ? {} : { requiredModelIds }),
      },
    };
    const routeStartedAt = performance.now();
    const route = this.router.route({
      task,
      ...(input.policies === undefined ? {} : { policies: input.policies }),
      estimatedInputTokens,
      requestedOutputTokens,
    });
    const maxFallbacks = boundedInteger(input.maxFallbacks ?? 2, 0, 10, 'maxFallbacks');
    const candidates = [
      route.selected.model,
      ...route.fallbacks.slice(0, maxFallbacks).map((item) => item.model),
    ];
    const requestId = input.context.requestId ?? this.createRequestId();
    const traceId = input.context.traceId ?? requestId;
    const baseEvent = {
      timestamp: this.now().toISOString(),
      requestId,
      traceId,
      tenantHash: hashTenant(input.context.tenantId),
      taskType: input.context.taskType,
    };
    return {
      requestId,
      traceId,
      route,
      routeLatencyMs: performance.now() - routeStartedAt,
      candidates,
      estimatedInputTokens,
      maxRetries: boundedInteger(input.maxRetries ?? 1, 0, 3, 'maxRetries'),
      maxCorrections: boundedInteger(
        input.maxStructuredCorrections ?? 1,
        0,
        2,
        'maxStructuredCorrections',
      ),
      event: (
        type: LlmTelemetryEvent['type'],
        fields: Partial<LlmTelemetryEvent> = {},
      ): LlmTelemetryEvent => ({
        ...baseEvent,
        ...fields,
        type,
        timestamp: this.now().toISOString(),
      }),
    };
  }

  private reserveBudget(
    input: LlmGatewayChatInput,
    execution: ReturnType<LlmGateway['prepareExecution']>,
  ): LlmBudgetReservation | undefined {
    if (!input.budget) return undefined;
    const callsPerCandidate = (execution.maxRetries + 1) * (execution.maxCorrections + 1);
    const worstCallCount = callsPerCandidate * execution.candidates.length;
    const maxOutput = (input.request.maxTokens ?? 4_096) * worstCallCount;
    const maxInput = execution.estimatedInputTokens * worstCallCount;
    const reservationModel = [...execution.candidates].sort((left, right) => {
      const leftCost = estimateModelCost(left, maxInput, maxOutput) ?? Number.POSITIVE_INFINITY;
      const rightCost = estimateModelCost(right, maxInput, maxOutput) ?? Number.POSITIVE_INFINITY;
      return rightCost - leftCost;
    })[0] as RegisteredLlmModel;
    return this.budget.reserve({
      scope: budgetScope(input.context),
      limits: input.budget,
      model: reservationModel,
      estimatedInputTokens: maxInput,
      maxOutputTokens: maxOutput,
    });
  }

  private async callWithStructuredCorrection(
    provider: LlmProvider,
    model: RegisteredLlmModel,
    input: LlmGatewayChatInput,
    maxCorrections: number,
    attemptUsages: AttemptUsage[],
    execution: ReturnType<LlmGateway['prepareExecution']>,
  ): Promise<LlmChatResponse> {
    let request = withSelectedModel(input.request, model.model);
    for (let correction = 0; correction <= maxCorrections; correction += 1) {
      const deadline = deadlineSignal(request.signal, input.timeoutMs);
      let response: LlmChatResponse;
      try {
        response = await this.reliability.execute(
          model.providerId,
          async () => provider.chat({ ...request, signal: deadline.signal }),
          deadline.signal,
          estimateMessagesTokens(request.messages) + (request.maxTokens ?? 4_096),
        );
      } catch (error) {
        throw deadline.timedOut() ? timeoutError(input.timeoutMs) : error;
      } finally {
        deadline.cleanup();
      }
      const usage = response.usage ?? estimateResponseUsage(request, response);
      attemptUsages.push({ model, usage });
      try {
        this.validateResponse(response, request, input.validateToolCalls ?? true);
        return response;
      } catch (error) {
        if (
          !(error instanceof LlmProviderError) ||
          error.code !== 'LLM_STRUCTURED_OUTPUT_INVALID' ||
          correction === maxCorrections
        )
          throw error;
        await this.emit(
          execution.event('provider.retry', {
            providerId: model.providerId,
            modelId: model.id,
            errorCode: error.code,
            attributes: { correction: true, correctionNumber: correction + 1 },
          }),
        );
        request = {
          ...request,
          messages: [
            ...request.messages,
            { role: 'assistant', content: response.text },
            { role: 'user', content: this.validator.correctionInstruction(error) },
          ],
        };
      }
    }
    throw new LlmProviderError(
      'LLM_STRUCTURED_OUTPUT_INVALID',
      'Structured output correction was exhausted.',
      false,
    );
  }

  private validateResponse(
    response: LlmChatResponse,
    request: LlmChatRequest,
    validateToolCalls: boolean,
  ): void {
    assertNoTextualToolInvocation({
      text: response.text,
      toolCalls: response.toolCalls,
      toolsRequested: Boolean(request.tools?.length),
      toolNames: request.tools?.map((tool) => tool.name) ?? [],
      protocol: 'the configured Provider protocol',
    });
    if (validateToolCalls && request.tools)
      this.validator.validateToolCalls(response.toolCalls, request.tools);
    if (request.responseFormat?.type === 'json_schema') {
      this.validator.parseAndValidate(response.text, request.responseFormat.schema);
    } else if (request.responseFormat?.type === 'json_object') {
      this.validator.parseAndValidate(response.text, { type: 'object' });
    }
  }

  private ensureModel(providerId: string, model: string): RegisteredLlmModel {
    return (
      this.registry.find(providerId, model) ?? this.registry.registerModel({ providerId, model })
    );
  }

  private requireProvider(providerId: string): LlmProvider {
    const provider = this.registry.provider(providerId);
    if (!provider)
      throw new LlmProviderError(
        'LLM_NO_ROUTE',
        `LLM provider is not registered: ${providerId}`,
        false,
      );
    return provider;
  }

  private async recordAttemptUsage(
    round: RoundContext | undefined,
    attempts: AttemptUsage[],
  ): Promise<void> {
    if (!this.usageTracker) return;
    if (round) {
      await this.usageTracker.recordLlmCall(
        round,
        sumUsage(attempts.map((attempt) => attempt.usage)),
      );
      return;
    }
    for (const attempt of attempts) {
      await this.usageTracker.recordTokens(
        attempt.model.mode === 'managed' ? 'managed' : 'byok',
        attempt.usage,
      );
    }
  }

  private async emit(event: LlmTelemetryEvent): Promise<void> {
    await this.telemetrySink.emit(event);
  }

  private routeCapability(
    input: {
      context: LlmGatewayContext;
      providerId?: string;
      modelId?: string;
      task?: Omit<LlmTaskProfile, 'taskType'>;
      policies?: LlmPolicyLayers;
    },
    capability: LlmCapabilityName,
    modelName: string,
  ): RegisteredLlmModel {
    if (input.providerId) this.ensureModel(input.providerId, modelName);
    const requiredModelIds = input.modelId
      ? [input.modelId]
      : input.providerId
        ? [`${input.providerId}:${modelName}`]
        : input.task?.requirements?.requiredModelIds;
    return this.router.route({
      task: {
        taskType: input.context.taskType,
        ...(input.task?.preferences === undefined ? {} : { preferences: input.task.preferences }),
        requirements: {
          ...input.task?.requirements,
          capabilities: [
            ...new Set([...(input.task?.requirements?.capabilities ?? []), capability]),
          ],
          ...(requiredModelIds === undefined ? {} : { requiredModelIds }),
        },
      },
      ...(input.policies === undefined ? {} : { policies: input.policies }),
    }).selected.model;
  }
}

function applySessionGeneration(
  request: CanonicalModelRequest,
  session: ModelSession,
): CanonicalModelRequest {
  return {
    ...request,
    model: session.route.modelId,
    ...(session.generation.temperature === undefined
      ? {}
      : { temperature: session.generation.temperature }),
    ...(session.generation.topP === undefined ? {} : { topP: session.generation.topP }),
    ...(session.generation.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: session.generation.maxOutputTokens }),
    ...(session.generation.stop === undefined ? {} : { stop: [...session.generation.stop] }),
  };
}

function validateDecodedModelAttempt(attempt: DecodedModelAttempt): ValidatedModelAttempt {
  if (!attempt.terminal) {
    throw new ModelProtocolError(
      'INCOMPLETE_MODEL_ATTEMPT',
      'Model attempt did not contain protocol-recognized terminal framing.',
    );
  }
  return Object.freeze({
    ...attempt,
    origin: Object.freeze({ ...attempt.origin }),
    blocks: Object.freeze(attempt.blocks.map(cloneDecodedBlock)),
    opaqueBlockRefs: Object.freeze([...attempt.opaqueBlockRefs]),
    ...(attempt.usage === undefined ? {} : { usage: Object.freeze({ ...attempt.usage }) }),
    terminal: true as const,
    validation: 'validated' as const,
  }) as unknown as ValidatedModelAttempt;
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
    // A transport iterator may be stalled inside next(). Abort is authoritative;
    // cleanup must not hide the phase timeout behind the outer total deadline.
    void iterator.return?.().catch(() => undefined);
  }
}

function raceModelDeadline<T>(
  operation: Promise<T>,
  milliseconds: number,
  phase: ModelTimeoutPhase,
  controller: AbortController,
  sourceSignal?: AbortSignal,
): Promise<T> {
  if (sourceSignal?.aborted) return Promise.reject(modelCancelledError(sourceSignal.reason));
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
      sourceSignal?.removeEventListener('abort', cancel);
      callback();
    };
    const cancel = () => finish(() => reject(modelCancelledError(sourceSignal?.reason)));
    sourceSignal?.addEventListener('abort', cancel, { once: true });
    void operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) =>
        finish(() => reject(error instanceof Error ? error : new Error(String(error)))),
    );
  });
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
    const retryableHttp =
      error.statusCode === 429 ||
      error.statusCode === 502 ||
      error.statusCode === 503 ||
      error.statusCode === 504;
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

function modelRetryError(error: ModelGatewayError): LlmProviderError {
  return new LlmProviderError(
    'LLM_PROVIDER_ERROR',
    error.message,
    error.retryable,
    error.statusCode,
    error.retryAfterMs === undefined ? undefined : { retryAfterMs: error.retryAfterMs },
  );
}

function assertCompatibleFallbacks(
  primary: ModelSession,
  fallbacks: readonly ModelSession[],
): void {
  for (const fallback of fallbacks) {
    const declared = primary.route.allowedFallbackRouteIds.includes(fallback.route.routeId);
    const primaryCompatibility = primary.route.compatibility;
    const fallbackCompatibility = fallback.route.compatibility;
    const compatible =
      primaryCompatibility?.mode === 'compatible-protocol' &&
      fallbackCompatibility?.mode === 'compatible-protocol' &&
      primaryCompatibility.family === fallbackCompatibility.family;
    if (!declared || !compatible) {
      throw new ModelGatewayError(
        'MODEL_FALLBACK_INCOMPATIBLE',
        `Fallback route ${fallback.route.routeId} is not an explicit compatible-protocol candidate of ${primary.route.routeId}.`,
        false,
      );
    }
  }
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

function validateGatewayInput(input: LlmGatewayChatInput): void {
  if (!input.context.tenantId.trim())
    throw new LlmProviderError('LLM_POLICY_VIOLATION', 'tenantId is required.', false);
  if (!input.context.taskType.trim())
    throw new LlmProviderError('LLM_POLICY_VIOLATION', 'taskType is required.', false);
  if (input.request.messages.length === 0)
    throw new LlmProviderError('LLM_BAD_RESPONSE', 'At least one LLM message is required.', false);
  if (
    (input.providerId && !input.request.model) ||
    (!input.providerId && input.request.model && !input.modelId)
  ) {
    throw new LlmProviderError(
      'LLM_POLICY_VIOLATION',
      'providerId and request.model must be supplied together for a fixed route.',
      false,
    );
  }
}

function withSelectedModel(request: LlmGatewayChatRequest, model: string): LlmChatRequest {
  return { ...request, model };
}

function budgetScope(context: LlmGatewayContext): LlmBudgetScope {
  return {
    tenantId: context.tenantId,
    taskType: context.taskType,
    ...(context.userId === undefined ? {} : { userId: context.userId }),
  };
}

function deadlineSignal(source: AbortSignal | undefined, timeoutMs: number | undefined) {
  const controller = new AbortController();
  let timeoutReached = false;
  const abort = () => controller.abort();
  source?.addEventListener('abort', abort, { once: true });
  if (source?.aborted) controller.abort();
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(
          () => {
            timeoutReached = true;
            controller.abort();
          },
          boundedInteger(timeoutMs, 1, 600_000, 'timeoutMs'),
        );
  return {
    signal: controller.signal,
    timedOut: () => timeoutReached,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      source?.removeEventListener('abort', abort);
    },
  };
}

function estimateResponseUsage(request: LlmChatRequest, response: LlmChatResponse): LlmUsage {
  const promptTokens = estimateMessagesTokens(request.messages);
  const completionTokens = Math.max(
    1,
    Math.ceil((response.text.length + JSON.stringify(response.toolCalls).length) / 3),
  );
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimated: true,
  };
}

function estimateFailedAttemptUsage(request: LlmGatewayChatRequest, model: string): LlmUsage {
  const normalized = withSelectedModel(request, model);
  const promptTokens = estimateMessagesTokens(normalized.messages);
  const completionTokens = Math.max(1, Math.min(normalized.maxTokens ?? 4_096, 32));
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimated: true,
  };
}

function sumUsage(usages: LlmUsage[]): LlmUsage {
  return usages.reduce<LlmUsage>(
    (total, usage) => ({
      promptTokens: total.promptTokens + usage.promptTokens,
      completionTokens: total.completionTokens + usage.completionTokens,
      totalTokens: total.totalTokens + usage.totalTokens,
      cachedPromptTokens: (total.cachedPromptTokens ?? 0) + (usage.cachedPromptTokens ?? 0),
      ...((total.estimated ?? false) || (usage.estimated ?? false) ? { estimated: true } : {}),
    }),
    zeroUsage(),
  );
}

function zeroUsage(): LlmUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function sumAttemptCost(attempts: AttemptUsage[]): number {
  return attempts.reduce(
    (total, attempt) =>
      total +
      (estimateModelCost(
        attempt.model,
        attempt.usage.promptTokens,
        attempt.usage.completionTokens,
      ) ?? 0),
    0,
  );
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

function normalizeTimeoutError(error: unknown): LlmProviderError {
  return normalizeProviderError(error);
}

function timeoutError(timeoutMs: number | undefined): LlmProviderError {
  return new LlmProviderError(
    'LLM_TIMEOUT',
    `LLM request timed out after ${timeoutMs ?? 0}ms.`,
    true,
  );
}

function isRetryable(error: unknown): boolean {
  return error instanceof LlmProviderError && error.retryable;
}

function isAborted(error: unknown): boolean {
  return error instanceof LlmProviderError && error.code === 'LLM_ABORTED';
}

function shouldAffectCircuit(error: unknown): boolean {
  return error instanceof LlmProviderError && error.retryable && error.code !== 'LLM_RATE_LIMITED';
}

function errorCode(error: unknown): string {
  return error instanceof LlmProviderError ? error.code : 'LLM_PROVIDER_ERROR';
}

function emptyResponse(model: string): LlmChatResponse {
  return { text: '', toolCalls: [], model };
}

function* emulateStream(response: LlmChatResponse): Iterable<LlmChatStreamEvent> {
  if (response.text) yield { type: 'text-delta', text: response.text };
  for (const toolCall of response.toolCalls) yield { type: 'tool-call', toolCall };
  if (response.usage) yield { type: 'usage', usage: response.usage };
  yield { type: 'finish', response };
}

function hashTenant(tenantId: string): string {
  return createHash('sha256').update(tenantId).digest('hex').slice(0, 24);
}

function asyncJobOwnerKey(tenantId: string, ownerId?: string): string {
  if (typeof tenantId !== 'string' || !tenantId.trim()) {
    throw new Error('tenantId is required for async LLM job isolation.');
  }
  const scopeId = ownerId ?? tenantId;
  if (typeof scopeId !== 'string' || !scopeId.trim()) {
    throw new Error('ownerId is required for async LLM job isolation.');
  }
  return JSON.stringify([tenantId, scopeId]);
}

function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`${name} must be between ${min} and ${max}.`);
  return value;
}

function minimumDefined(values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined);
  return defined.length === 0 ? undefined : Math.min(...defined);
}

async function cancellableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted)
    throw new LlmProviderError('LLM_ABORTED', 'LLM request was aborted by the user.', false);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timeout);
      reject(new LlmProviderError('LLM_ABORTED', 'LLM request was aborted by the user.', false));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
