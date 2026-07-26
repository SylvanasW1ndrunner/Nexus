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
import { LlmReliabilityController, type LlmReliabilityConfig } from './reliability.js';
import { LlmResponseCache } from './response-cache.js';
import {
  estimateModelCost,
  LlmTaskRouter,
  type LlmPolicyLayers,
  type LlmRouteDecision,
  type LlmTaskProfile,
} from './routing.js';
import { StructuredOutputValidator } from './structured-output.js';
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
            if (visibleOutput || isAborted(lastError)) throw lastError;
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
    if (input.providerId && input.request.model)
      this.ensureModel(input.providerId, input.request.model);
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
    const requestedOutputTokens = input.request.maxTokens ?? 4_096;
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
