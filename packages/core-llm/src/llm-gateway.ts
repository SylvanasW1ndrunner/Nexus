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
  generationConfigFromRequest,
  resolveLlmOutputReservation,
} from './generation-config.js';
import { LlmReliabilityController, type LlmReliabilityConfig } from './reliability.js';
import { LlmResponseCache } from './response-cache.js';
import {
  createModelSession,
  createModelSessionBundle,
  isAuthenticModelSessionBundle,
  MODEL_PROTOCOL_CODEC_REVISIONS,
  ModelClientError,
  type ModelClient,
  type ModelSessionBundle,
  type ModelSession,
} from './model-client.js';
import {
  LegacyProviderCodec,
  LegacyProviderModelClient,
  canonicalLegacyProtocol,
  legacyAttemptToResponse,
  legacyRequestToCanonical,
} from './legacy-model-compatibility.js';
import {
  ModelProtocolError,
  type CanonicalModelRequest,
} from './protocol/codec.js';
import type {
  DecodedModelAttempt,
  ModelProtocolEnvelope,
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
  protocolEnvelope: ModelProtocolEnvelope;
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
    if (request.model !== session.route.modelId) {
      throw new ModelGatewayError(
        'MODEL_PROTOCOL_FAILED',
        `Canonical request model ${request.model} does not match frozen route ${session.route.modelId}.`,
        false,
      );
    }
    const fallbacks = [...(bundle?.fallbacks ?? [])];
    const maxRetries = boundedModelAttemptInteger(options.maxRetries ?? 1, 0, 10, 'maxRetries');
    const timeouts = modelAttemptTimeouts(options.timeouts);
    const retry = modelAttemptRetry(options.retry);
    const discarded: DiscardedModelAttempt[] = [];
    let terminalError: ModelGatewayError | undefined;

    const candidates = [session, ...fallbacks];
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      const candidate = candidates[candidateIndex]!;
      for (let retryIndex = 0; retryIndex <= maxRetries; retryIndex += 1) {
        const attemptId = this.createAttemptId();
        const tentativeBlocks: DecodedModelContentBlock[] = [];
        try {
          const execution = await this.executeOne(
            candidate,
            request,
            attemptId,
            timeouts,
            options.signal,
            tentativeBlocks,
          );
          return Object.freeze({
            attempt: execution.attempt,
            protocolEnvelope: execution.protocolEnvelope,
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
  ): Promise<{ attempt: ValidatedModelAttempt; protocolEnvelope: ModelProtocolEnvelope }> {
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
        replay: session.replay,
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
      const attempt = await raceModelDeadline(
        run(),
        timeouts.totalMs,
        'total',
        controller,
        sourceSignal,
      );
      return {
        attempt,
        protocolEnvelope: freezeProtocolEnvelope({
          schemaVersion: 1,
          attemptId: attempt.attemptId,
          origin: attempt.origin,
          correlations: encoded.correlations,
          opaqueBlockRefs: encoded.opaqueBlockRefs,
        }),
      };
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
  private readonly legacyCacheHitClients = new WeakSet<ModelClient>();
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

  private async executeThroughModelGateway(
    input: LlmGatewayChatInput,
    streaming = false,
  ): Promise<LlmGatewayResult> {
    const execution = this.prepareExecution(input, streaming);
    const startedAt = performance.now();
    const primary = execution.candidates[0] as RegisteredLlmModel;
    await this.emit(
      execution.event('request.started', { estimatedTokens: execution.estimatedInputTokens }),
    );
    await this.emit(
      execution.event('route.decided', {
        providerId: primary.providerId,
        modelId: primary.id,
        latencyMs: execution.routeLatencyMs,
        attributes: { fallbackCount: execution.candidates.length - 1 },
      }),
    );
    const cached = input.cache?.enabled
      ? this.cache.get(
          input.context.tenantId,
          primary.providerId,
          withSelectedModel(input.request, primary.model),
          input.cache.namespace,
        )
      : undefined;
    if (cached !== undefined) {
      await this.emit(execution.event('cache.hit'));
      return {
        requestId: execution.requestId,
        traceId: execution.traceId,
        response: cached,
        route: execution.route,
        providerId: primary.providerId,
        modelId: primary.id,
        attempts: 0,
        cacheHit: true,
        usage: cached.usage ?? zeroUsage(),
      };
    }
    if (input.cache?.enabled) await this.emit(execution.event('cache.miss'));

    let reservation: LlmBudgetReservation | undefined;
    try {
      reservation = this.reserveBudget(input, execution);
      const bundle = this.legacyModelSessionBundle(execution, input, streaming);
      const gateway = new ModelExecutionGateway({
        createAttemptId: this.createRequestId,
      });
      let correctionRequest = input.request;
      let response!: LlmChatResponse;
      let selected = primary;
      let selectedSessionClient = bundle.primary.client;
      let attempts = 0;
      const attemptUsages: AttemptUsage[] = [];
      for (let correction = 0; ; correction += 1) {
        const result = await gateway.executeAttempt(
          bundle,
          legacyRequestToCanonical(correctionRequest, primary.model),
          {
            maxRetries: execution.maxRetries,
            ...(input.request.signal === undefined ? {} : { signal: input.request.signal }),
            ...(input.timeoutMs === undefined
              ? {}
              : {
                  timeouts: {
                    connectMs: input.timeoutMs,
                    firstEventMs: input.timeoutMs,
                    idleMs: input.timeoutMs,
                    totalMs: input.timeoutMs,
                  },
                }),
          },
        );
        response = legacyAttemptToResponse(
          result.attempt.blocks,
          result.attempt.usage,
          result.attempt.providerResponseId,
        );
        if (result.attempt.finishReason !== undefined) {
          response.finishReason = result.attempt.finishReason;
        }
        selected = execution.candidates.find(
          (candidate) => candidate.id === result.session.route.routeId,
        ) ?? primary;
        selectedSessionClient = result.session.client;
        for (const discarded of result.discardedAttempts) {
          const candidate = execution.candidates.find((item) => item.id === discarded.routeId) ?? primary;
          attemptUsages.push({
            model: candidate,
            usage: estimateFailedAttemptUsage(correctionRequest, candidate.model),
          });
          attempts += 1;
          await this.emit(execution.event('provider.attempt', {
            providerId: candidate.providerId,
            modelId: candidate.id,
            attempt: attempts,
          }));
        }
        const selectedUsage = response.usage ?? estimateResponseUsage(
          withSelectedModel(correctionRequest, selected.model),
          response,
        );
        attemptUsages.push({ model: selected, usage: selectedUsage });
        attempts += 1;
        await this.emit(execution.event('provider.attempt', {
          providerId: selected.providerId,
          modelId: selected.id,
          attempt: attempts,
        }));
        try {
          this.validateResponse(
            response,
            withSelectedModel(correctionRequest, result.session.route.modelId),
            input.validateToolCalls ?? true,
          );
          break;
        } catch (error) {
          if (
            !(error instanceof LlmProviderError) ||
            error.code !== 'LLM_STRUCTURED_OUTPUT_INVALID' ||
            correction >= execution.maxCorrections
          ) {
            throw error;
          }
          await this.emit(execution.event('provider.retry', {
            providerId: selected.providerId,
            modelId: selected.id,
            errorCode: error.code,
            attributes: { correction: true, correctionNumber: correction + 1 },
          }));
          correctionRequest = {
            ...correctionRequest,
            messages: [
              ...correctionRequest.messages,
              { role: 'assistant', content: response.text },
              { role: 'user', content: this.validator.correctionInstruction(error) },
            ],
          };
        }
      }
      const usage = sumUsage(attemptUsages.map((attempt) => attempt.usage));
      response.usage = usage;
      if (selected.id !== primary.id) {
        await this.emit(execution.event('provider.fallback', {
          providerId: selected.providerId,
          modelId: selected.id,
        }));
      }
      const cost = sumAttemptCost(attemptUsages);
      if (reservation) this.budget.commitActual(reservation.id, usage.totalTokens, cost);
      await this.recordAttemptUsage(input.round, attemptUsages);
      const cacheHit = this.legacyCacheHitClients.has(selectedSessionClient);
      const reportedAttempts = cacheHit ? Math.max(0, attempts - 1) : attempts;
      if (input.cache?.enabled && !cacheHit) {
        this.cache.set(
          input.context.tenantId,
          selected.providerId,
          withSelectedModel(input.request, selected.model),
          response,
          {
            ...(input.cache.namespace === undefined ? {} : { namespace: input.cache.namespace }),
            ...(input.cache.ttlMs === undefined ? {} : { ttlMs: input.cache.ttlMs }),
          },
        );
      }
      await this.emit(execution.event('request.completed', {
        providerId: selected.providerId,
        modelId: selected.id,
        latencyMs: performance.now() - startedAt,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        attributes: { attempts: reportedAttempts, cacheHit },
      }));
      return {
        requestId: execution.requestId,
        traceId: execution.traceId,
        response,
        route: execution.route,
        providerId: selected.providerId,
        modelId: selected.id,
        attempts: reportedAttempts,
        cacheHit,
        usage,
      };
    } catch (error) {
      const discarded = error instanceof ModelGatewayError
        ? error.options.discardedAttempts ?? []
        : [];
      const failedUsages: AttemptUsage[] = discarded.map((attempt) => {
        const candidate = execution.candidates.find((item) => item.id === attempt.routeId) ?? primary;
        return {
          model: candidate,
          usage: estimateFailedAttemptUsage(input.request, candidate.model),
        };
      });
      if (reservation) {
        if (failedUsages.length > 0) {
          const usage = sumUsage(failedUsages.map((attempt) => attempt.usage));
          this.budget.commitActual(reservation.id, usage.totalTokens, sumAttemptCost(failedUsages));
        } else {
          this.budget.release(reservation.id);
        }
      }
      if (failedUsages.length > 0) await this.recordAttemptUsage(input.round, failedUsages);
      const normalized = modelGatewayToLegacyError(error);
      await this.emit(execution.event(
        normalized.code === 'LLM_ABORTED' ? 'request.cancelled' : 'request.failed',
        {
          latencyMs: performance.now() - startedAt,
          errorCode: normalized.code,
        },
      ));
      throw normalized;
    }
  }

  private legacyModelSessionBundle(
    execution: ReturnType<LlmGateway['prepareExecution']>,
    input: LlmGatewayChatInput,
    streaming: boolean,
  ): ModelSessionBundle {
    const candidates = execution.candidates;
    const primary = candidates[0] as RegisteredLlmModel;
    const fallbackIds = candidates.slice(1).map((candidate) => candidate.id);
    const makeSession = (candidate: RegisteredLlmModel, fallback: boolean): ModelSession => {
      const provider = this.requireProvider(candidate.providerId);
      const protocol = canonicalLegacyProtocol(provider.protocol);
      const baseClient = new LegacyProviderModelClient(provider, streaming);
      const client: ModelClient = {
        execute: async (request) => {
          if (fallback && input.cache?.enabled) {
            const cached = this.cache.get(
              input.context.tenantId,
              candidate.providerId,
              withSelectedModel(input.request, candidate.model),
              input.cache.namespace,
            );
            if (cached !== undefined) {
              this.legacyCacheHitClients.add(client);
              return { kind: 'json' as const, response: cached };
            }
          }
          try {
            const response = await this.reliability.execute(
              candidate.providerId,
              () => baseClient.execute(request),
              request.signal,
              execution.estimatedInputTokens + (candidate.limits.maxOutputTokens ?? 4_096),
            );
            this.reliability.recordSuccess(candidate.providerId);
            return response;
          } catch (error) {
            if (shouldAffectModelClientCircuit(error)) {
              this.reliability.recordFailure(candidate.providerId);
            }
            throw error;
          }
        },
      };
      return createModelSession({
        route: {
          routeId: candidate.id,
          connectionId: `legacy:${candidate.providerId}`,
          providerId: candidate.providerId,
          modelId: candidate.model,
          protocol,
          codecRevision: MODEL_PROTOCOL_CODEC_REVISIONS[protocol],
          capabilities: { ...candidate.capabilities },
          generationParameters: { ...candidate.generationParameters },
          contextTokens: candidate.limits.contextTokens,
          maxInputTokens: candidate.limits.maxInputTokens,
          maxOutputTokens: candidate.limits.maxOutputTokens,
          metadata: {
            source: 'legacy-registry',
            revision: candidate.id,
            digest: 'computed-by-createModelSession',
          },
          allowedFallbackRouteIds: fallback ? [] : fallbackIds,
          compatibility: {
            mode: 'compatible-protocol',
            family: 'legacy-provider-normalized-v1',
          },
        },
        generation: generationConfigFromRequest(
          withSelectedModel(input.request, candidate.model),
        ),
        codec: new LegacyProviderCodec(protocol),
        client,
        replay: fallback
          ? { mode: 'compatible-protocol', envelopes: [] }
          : { mode: 'new' },
      });
    };
    return createModelSessionBundle({
      primary: makeSession(primary, false),
      fallbacks: candidates.slice(1).map((candidate) => makeSession(candidate, true)),
      policy: { allowCrossConnection: true, allowCrossModel: true },
    });
  }

  async chat(input: LlmGatewayChatInput): Promise<LlmChatResponse> {
    return (await this.execute(input)).response;
  }

  async execute(input: LlmGatewayChatInput): Promise<LlmGatewayResult> {
    return await this.executeThroughModelGateway(input);
  }

  async *stream(input: LlmGatewayChatInput): AsyncIterable<LlmChatStreamEvent> {
    const result = await this.executeThroughModelGateway(input, true);
    if (result.response.text) yield { type: 'text-delta', text: result.response.text };
    for (const toolCall of result.response.toolCalls) yield { type: 'tool-call', toolCall };
    if (result.response.usage) yield { type: 'usage', usage: result.response.usage };
    yield {
      type: 'finish',
      response: result.response,
      ...(result.response.finishReason === undefined
        ? {}
        : { reason: result.response.finishReason }),
    };
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
    ...(session.generation.stop === undefined ? {} : { stop: [...session.generation.stop] }),
  };
}

export function modelGatewayToLegacyError(error: unknown): LlmProviderError {
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

function freezeProtocolEnvelope(envelope: ModelProtocolEnvelope): ModelProtocolEnvelope {
  return Object.freeze({
    schemaVersion: 1 as const,
    attemptId: envelope.attemptId,
    origin: Object.freeze({ ...envelope.origin }),
    correlations: Object.freeze(envelope.correlations.map((correlation) => Object.freeze({
      ...correlation,
      ...(correlation.wireIdentity === undefined
        ? {}
        : { wireIdentity: Object.freeze({ ...correlation.wireIdentity }) }),
    }))),
    opaqueBlockRefs: Object.freeze([...envelope.opaqueBlockRefs]),
  }) as unknown as ModelProtocolEnvelope;
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
  if (sourceSignal?.aborted) {
    void operation.catch(() => undefined);
    return Promise.reject(modelCancelledError(sourceSignal.reason));
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

function shouldAffectCircuit(error: unknown): boolean {
  return error instanceof LlmProviderError && error.retryable && error.code !== 'LLM_RATE_LIMITED';
}

function shouldAffectModelClientCircuit(error: unknown): boolean {
  const providerError = findProviderError(error);
  if (providerError !== undefined) return shouldAffectCircuit(providerError);
  return error instanceof ModelClientError && error.retryable && error.statusCode !== 429;
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
