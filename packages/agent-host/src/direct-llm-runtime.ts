import { randomUUID } from 'node:crypto';
import {
  LlmAsyncJobManager,
  ModelExecutionGateway,
  LlmProviderError,
  modelGatewayToProviderError,
  type LlmAsyncJob,
  type LlmChatResponse,
  type LlmChatStreamEvent,
  type LlmConnectionManager,
  type LlmEffectiveParameters,
  type LlmGenerationConfig,
  type LlmMetricsSnapshot,
  type LlmModelSelection,
  type ModelAttemptExecution,
  type ModelSessionBundle,
  type LlmUsage,
} from '@dbagent/core-llm';
import type { UsageTracker } from '@dbagent/core-usage';
import { AgentRuntimeError } from './errors.js';
import type {
  LlmRuntimeBatchItem,
  LlmRuntimeBatchOptions,
  LlmRuntimeCallOptions,
  LlmRuntimeChatRequest,
} from './types.js';
import {
  directRequestToCanonical,
  modelExecutionToDirectResponse,
  modelExecutionToDirectStream,
} from './direct-model-edge.js';

const MAX_IDENTIFIER_CHARS = 300;

export type DirectLlmCallOptions = LlmRuntimeCallOptions & {
  /** Optional Session layer between Project settings and request overrides. */
  sessionParameters?: LlmGenerationConfig;
};

export type DirectLlmRuntimeOptions = Readonly<{
  manager: LlmConnectionManager;
  usageTracker: UsageTracker;
  tenantId: string;
  ownerId?: string;
  now?: () => Date;
  createId?: () => string;
  modelGateway?: ModelExecutionGateway;
}>;

export type DirectLlmExecutionResult = Readonly<{
  response: LlmChatResponse;
  route: Readonly<{
    routeId: string;
    connectionId: string;
    providerId: string;
    modelId: string;
    protocol: string;
  }>;
  effectiveParameters: LlmEffectiveParameters;
  protocolAttempts: readonly string[];
  attempts: number;
  usage: LlmUsage;
}>;

type DirectBatchItem = Readonly<{
  request: LlmRuntimeChatRequest;
  options: DirectLlmCallOptions;
}>;

/**
 * Deterministic internal model calls. This runtime deliberately has no Agent Run,
 * Journal, Tool loop, mutable provider route, or ownership over its manager.
 */
export class DirectLlmRuntime {
  private readonly manager: LlmConnectionManager;
  private readonly usageTracker: UsageTracker;
  private readonly tenantId: string;
  private readonly ownerId: string;
  private readonly now: () => Date;
  private readonly modelGateway: ModelExecutionGateway;
  private readonly jobs: LlmAsyncJobManager<DirectBatchItem, DirectLlmExecutionResult>;
  private readonly activeOperations = new Set<Promise<unknown>>();
  private readonly activeControllers = new Set<AbortController>();
  private readonly activeStreamClosers = new Set<() => Promise<void>>();
  private readonly activeJobWaiters = new Set<Promise<void>>();
  private readonly metricState = new DirectLlmMetrics();
  private closing = false;
  private closed = false;
  private closeOperation: Promise<void> | undefined;

  constructor(options: DirectLlmRuntimeOptions) {
    this.manager = options.manager;
    this.usageTracker = options.usageTracker;
    this.tenantId = requireIdentifier(options.tenantId, 'tenantId');
    this.ownerId = requireIdentifier(options.ownerId ?? randomUUID(), 'ownerId');
    this.now = options.now ?? (() => new Date());
    this.modelGateway = options.modelGateway ?? new ModelExecutionGateway();
    this.jobs = new LlmAsyncJobManager<DirectBatchItem, DirectLlmExecutionResult>(
      async (item, signal) => await this.executeChat(item.request, item.options, signal),
      this.now,
      options.createId ?? randomUUID,
    );
  }

  async chat(
    request: LlmRuntimeChatRequest,
    options: DirectLlmCallOptions,
  ): Promise<LlmChatResponse> {
    this.assertRunning();
    return (await this.executeChat(request, options)).response;
  }

  stream(
    request: LlmRuntimeChatRequest,
    options: DirectLlmCallOptions,
  ): AsyncIterable<LlmChatStreamEvent> {
    this.assertRunning();
    const selection = normalizeModelSelection(options.model);
    const linked = createLinkedAbortController(request.signal);
    let startedAt: number | undefined;
    let source: AsyncIterator<LlmChatStreamEvent> | undefined;
    let recorded = false;
    let settled = false;
    let resolveOperation: (() => void) | undefined;
    const operation = new Promise<void>((resolve) => {
      resolveOperation = resolve;
    });

    const cleanup = () => {
      if (settled) return;
      settled = true;
      linked.dispose();
      this.activeControllers.delete(linked.controller);
      this.activeOperations.delete(operation);
      this.activeStreamClosers.delete(closeStream);
      resolveOperation?.();
    };

    const iterator = (async function* (runtime: DirectLlmRuntime) {
      const operationStartedAt = runtime.now().getTime();
      startedAt = operationStartedAt;
      runtime.metricState.started();
      try {
        const result = await runtime.executeCanonical(
          request,
          options,
          selection,
          linked.controller.signal,
          true,
        );
        source = modelExecutionToDirectStream(result.execution)[Symbol.iterator]() as unknown as
          AsyncIterator<LlmChatStreamEvent>;
        while (true) {
          const next = await Promise.resolve(source.next());
          if (next.done) {
            if (!recorded) {
              throw new LlmProviderError(
                'LLM_BAD_RESPONSE',
                'The model stream ended without a finish event.',
                false,
              );
            }
            return;
          }
          const event = next.value;
          if (event.type === 'finish' && !recorded) {
            await runtime.recordStreamSuccess(
              selection,
              event.response.usage ?? zeroUsage(),
              operationStartedAt,
              result.execution.session.route.providerId,
              result.mode,
            );
            recorded = true;
          }
          yield event;
        }
      } catch (error) {
        if (!recorded) {
          recorded = true;
          runtime.recordFailure(
            selection,
            error,
            linked.controller.signal,
            operationStartedAt,
          );
        }
        throw error;
      } finally {
        if (!recorded) {
          recorded = true;
          linked.controller.abort(new Error('The stream consumer closed before completion.'));
          runtime.metricState.cancelled(selection, runtime.elapsed(operationStartedAt));
        }
        try {
          await source?.return?.();
        } finally {
          cleanup();
        }
      }
    })(this);

    const closeStream = async () => {
      linked.controller.abort(new Error('Direct LLM runtime is closing.'));
      try {
        await iterator.return(undefined);
      } finally {
        if (!recorded && startedAt !== undefined) {
          recorded = true;
          this.metricState.cancelled(selection, this.elapsed(startedAt));
        }
        cleanup();
      }
    };

    this.activeControllers.add(linked.controller);
    this.activeOperations.add(operation);
    this.activeStreamClosers.add(closeStream);
    return iterator;
  }

  submitBatch(
    items: readonly LlmRuntimeBatchItem[],
    options: LlmRuntimeBatchOptions = {},
  ): LlmAsyncJob<DirectLlmExecutionResult> {
    this.assertRunning();
    const inputs = items.map((item): DirectBatchItem => {
      if (item.request.signal !== undefined) {
        throw new AgentRuntimeError(
          'INVALID_INPUT',
          'Batch items do not accept individual AbortSignals; cancel the submitted job instead.',
          false,
        );
      }
      return {
        request: structuredClone(item.request),
        options: {
          ...structuredClone(item.options),
          model: normalizeModelSelection(item.options.model),
        },
      };
    });
    const job = this.jobs.submit(inputs, {
      ownerId: this.ownerId,
      ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    });
    const waiter = waitForJobCompletion(this.jobs, job.id, this.ownerId);
    this.activeJobWaiters.add(waiter);
    void waiter.finally(() => this.activeJobWaiters.delete(waiter));
    return job;
  }

  getJob(id: string): LlmAsyncJob<DirectLlmExecutionResult> | undefined {
    return this.jobs.get(requireIdentifier(id, 'jobId'), this.ownerId);
  }

  listJobs(): Array<LlmAsyncJob<DirectLlmExecutionResult>> {
    return this.jobs.list(this.ownerId);
  }

  cancelJob(id: string): LlmAsyncJob<DirectLlmExecutionResult> | undefined {
    return this.jobs.cancel(requireIdentifier(id, 'jobId'), this.ownerId);
  }

  metrics(): LlmMetricsSnapshot {
    return this.metricState.snapshot();
  }

  close(): Promise<void> {
    if (this.closeOperation) return this.closeOperation;
    if (this.closed) return Promise.resolve();
    this.closing = true;
    this.closeOperation = this.closeInternal();
    return this.closeOperation;
  }

  private executeChat(
    request: LlmRuntimeChatRequest,
    options: DirectLlmCallOptions,
    operationSignal?: AbortSignal,
  ): Promise<DirectLlmExecutionResult> {
    this.assertRunning();
    const selection = normalizeModelSelection(options.model);
    const linked = createLinkedAbortController(request.signal, operationSignal);
    const startedAt = this.now().getTime();
    this.activeControllers.add(linked.controller);
    this.metricState.started();
    const operation = this.executeChatLifecycle(
      request,
      options,
      selection,
      linked,
      startedAt,
    );
    this.activeOperations.add(operation);
    void operation.then(
      () => this.activeOperations.delete(operation),
      () => this.activeOperations.delete(operation),
    );
    return operation;
  }

  private async executeChatLifecycle(
    request: LlmRuntimeChatRequest,
    options: DirectLlmCallOptions,
    selection: LlmModelSelection,
    linked: ReturnType<typeof createLinkedAbortController>,
    startedAt: number,
  ): Promise<DirectLlmExecutionResult> {
    try {
      const prepared = await this.executeCanonical(
        request,
        options,
        selection,
        linked.controller.signal,
        false,
      );
      const result = this.directExecutionResult(prepared);
      await this.recordSuccess(result, selection, startedAt);
      return result;
    } catch (error) {
      this.recordFailure(selection, error, linked.controller.signal, startedAt);
      throw error;
    } finally {
      linked.dispose();
      this.activeControllers.delete(linked.controller);
    }
  }

  private async executeCanonical(
    request: LlmRuntimeChatRequest,
    options: DirectLlmCallOptions,
    selection: LlmModelSelection,
    signal: AbortSignal,
    streaming: boolean,
  ): Promise<{
    execution: ModelAttemptExecution;
    bundle: ModelSessionBundle;
    effectiveParameters: LlmEffectiveParameters;
    mode: 'byok' | 'managed';
  }> {
    // Discovery/catalog population is part of binding preparation. Parameter
    // validation must observe that prepared catalog rather than an empty cache.
    await this.manager.prepare(selection, { signal });
    const effectiveParameters = this.manager.effectiveParameters(selection, {
      ...(options.sessionParameters === undefined
        ? {}
        : { session: options.sessionParameters }),
      request: generationFromManagedRequest(request),
    });
    const bundle = await this.manager.prepareModelSessionBundle(selection, {
      generation: effectiveParameters.values,
      signal,
      streaming,
    });
    try {
      const execution = await this.modelGateway.executeAttempt(
        bundle,
        directRequestToCanonical(withoutManagedGeneration(request), selection.modelId),
        {
          purpose: 'direct',
          toolsEnabled: true,
          maxRetries: options.maxRetries ?? 0,
          signal,
          ...(options.timeoutMs === undefined
            ? {}
            : {
                timeouts: {
                  connectMs: options.timeoutMs,
                  firstEventMs: options.timeoutMs,
                  idleMs: options.timeoutMs,
                  totalMs: options.timeoutMs,
                },
              }),
        },
      );
      return {
        execution,
        bundle,
        effectiveParameters,
        mode: this.manager.modelMode(selection) === 'managed' ? 'managed' : 'byok',
      };
    } catch (error) {
      throw modelGatewayToProviderError(error);
    }
  }

  private directExecutionResult(input: {
    execution: ModelAttemptExecution;
    bundle: ModelSessionBundle;
    effectiveParameters: LlmEffectiveParameters;
  }): DirectLlmExecutionResult {
    const response = modelExecutionToDirectResponse(input.execution);
    const usage = response.usage ?? zeroUsage();
    response.usage = usage;
    const sessions = [input.bundle.primary, ...input.bundle.fallbacks];
    const protocolAttempts = [
      ...input.execution.discardedAttempts.map((discarded) =>
        sessions.find((session) => session.route.routeId === discarded.routeId)?.route.protocol ??
        'unknown'),
      input.execution.session.route.protocol,
    ];
    return Object.freeze({
      response,
      route: Object.freeze({
        routeId: input.execution.session.route.routeId,
        connectionId: input.execution.session.route.connectionId,
        providerId: input.execution.session.route.providerId,
        modelId: input.execution.session.route.modelId,
        protocol: input.execution.session.route.protocol,
      }),
      effectiveParameters: input.effectiveParameters,
      protocolAttempts: Object.freeze(protocolAttempts),
      attempts: input.execution.discardedAttempts.length + 1,
      usage,
    });
  }

  private async recordSuccess(
    result: DirectLlmExecutionResult,
    selection: LlmModelSelection,
    startedAt: number,
  ): Promise<void> {
    const usage = result.usage;
    const mode = this.manager.modelMode(selection) === 'managed' ? 'managed' : 'byok';
    await this.usageTracker.recordTokens(mode, usage);
    this.metricState.completed(
      result.route.providerId,
      selection.modelId,
      usage,
      this.elapsed(startedAt),
      result.attempts,
      false,
      result.protocolAttempts,
    );
  }

  private async recordStreamSuccess(
    selection: LlmModelSelection,
    usage: LlmUsage,
    startedAt: number,
    providerId: string,
    mode: 'byok' | 'managed',
  ): Promise<void> {
    await this.usageTracker.recordTokens(mode, usage);
    // LlmConnectionManager.stream currently proves the selected route and
    // terminal usage, but intentionally does not expose retry/fallback counts.
    this.metricState.completed(
      providerId,
      selection.modelId,
      usage,
      this.elapsed(startedAt),
    );
  }

  private recordFailure(
    selection: LlmModelSelection,
    error: unknown,
    signal: AbortSignal,
    startedAt: number,
  ): void {
    if (signal.aborted || isAbortError(error)) {
      this.metricState.cancelled(selection, this.elapsed(startedAt));
    } else {
      this.metricState.failed(selection, this.elapsed(startedAt));
    }
  }

  private elapsed(startedAt: number): number {
    return Math.max(0, this.now().getTime() - startedAt);
  }

  private async closeInternal(): Promise<void> {
    for (const controller of this.activeControllers) {
      controller.abort(new Error('Direct LLM runtime is closing.'));
    }
    for (const job of this.jobs.list(this.ownerId)) {
      if (job.status === 'queued' || job.status === 'running') this.jobs.cancel(job.id, this.ownerId);
    }
    await Promise.allSettled([...this.activeStreamClosers].map(async (close) => await close()));
    await Promise.allSettled([...this.activeOperations, ...this.activeJobWaiters]);
    this.closed = true;
    this.closing = false;
  }

  private assertRunning(): void {
    if (this.closing || this.closed) {
      throw new AgentRuntimeError('ABORTED', 'Direct LLM runtime is closing.', false);
    }
  }
}

class DirectLlmMetrics {
  private readonly latencies: number[] = [];
  private readonly byModel = new Map<
    string,
    { attempts: number; completed: number; failed: number }
  >();
  private requests = 0;
  private completedCount = 0;
  private failedCount = 0;
  private cancelledCount = 0;
  private cacheHits = 0;
  private retries = 0;
  private fallbacks = 0;
  private totalPromptTokens = 0;
  private totalCompletionTokens = 0;

  started(): void {
    this.requests += 1;
  }

  completed(
    providerId: string,
    modelId: string,
    usage: LlmUsage,
    latencyMs: number,
    attempts?: number,
    cacheHit = false,
    protocolAttempts: readonly string[] = [],
  ): void {
    this.completedCount += 1;
    this.totalPromptTokens += usage.promptTokens;
    this.totalCompletionTokens += usage.completionTokens;
    if (cacheHit) this.cacheHits += 1;
    if (attempts !== undefined) this.retries += Math.max(0, attempts - 1);
    if (attempts !== undefined && new Set(protocolAttempts).size > 1) this.fallbacks += 1;
    this.latency(latencyMs);
    if (attempts !== undefined) {
      const key = `${providerId}:${modelId}`;
      const current = this.byModel.get(key) ?? { attempts: 0, completed: 0, failed: 0 };
      current.attempts += Math.max(1, attempts);
      current.completed += 1;
      this.byModel.set(key, current);
    }
  }

  failed(selection: LlmModelSelection, latencyMs: number): void {
    this.failedCount += 1;
    this.latency(latencyMs);
    const key = `${selection.connectionId}:${selection.modelId}`;
    const current = this.byModel.get(key) ?? { attempts: 0, completed: 0, failed: 0 };
    current.attempts += 1;
    current.failed += 1;
    this.byModel.set(key, current);
  }

  cancelled(selection: LlmModelSelection, latencyMs: number): void {
    this.cancelledCount += 1;
    this.latency(latencyMs);
    const key = `${selection.connectionId}:${selection.modelId}`;
    const current = this.byModel.get(key) ?? { attempts: 0, completed: 0, failed: 0 };
    current.attempts += 1;
    this.byModel.set(key, current);
  }

  snapshot(): LlmMetricsSnapshot {
    const values = [...this.latencies].sort((left, right) => left - right);
    return {
      requests: this.requests,
      completed: this.completedCount,
      failed: this.failedCount,
      cancelled: this.cancelledCount,
      cacheHits: this.cacheHits,
      retries: this.retries,
      fallbacks: this.fallbacks,
      totalPromptTokens: this.totalPromptTokens,
      totalCompletionTokens: this.totalCompletionTokens,
      totalCost: 0,
      latencyMs: {
        p50: percentile(values, 0.5),
        p95: percentile(values, 0.95),
        p99: percentile(values, 0.99),
        max: values.at(-1) ?? 0,
      },
      byModel: Object.fromEntries(
        [...this.byModel].map(([key, value]) => [key, { ...value }]),
      ),
    };
  }

  private latency(value: number): void {
    this.latencies.push(value);
    if (this.latencies.length > 20_000) {
      this.latencies.splice(0, this.latencies.length - 20_000);
    }
  }
}

function normalizeModelSelection(selection: LlmModelSelection): LlmModelSelection {
  return {
    connectionId: requireIdentifier(selection.connectionId, 'connectionId'),
    modelId: requireIdentifier(selection.modelId, 'modelId'),
    ...(selection.routeRevision?.trim()
      ? { routeRevision: requireIdentifier(selection.routeRevision, 'routeRevision') }
      : {}),
  };
}

function requireIdentifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AgentRuntimeError('INVALID_INPUT', `${name} must not be blank.`, false);
  }
  const normalized = value.trim();
  if (normalized.length > MAX_IDENTIFIER_CHARS) {
    throw new AgentRuntimeError(
      'INVALID_INPUT',
      `${name} must not exceed ${MAX_IDENTIFIER_CHARS} characters.`,
      false,
    );
  }
  return normalized;
}

function withoutManagedGeneration(
  request: LlmRuntimeChatRequest,
): Pick<LlmRuntimeChatRequest, 'messages' | 'tools'> {
  return {
    messages: request.messages,
    ...(request.tools === undefined ? {} : { tools: request.tools }),
  };
}

function generationFromManagedRequest(request: LlmRuntimeChatRequest): LlmGenerationConfig {
  return {
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.topP === undefined ? {} : { topP: request.topP }),
    ...(request.maxTokens === undefined ? {} : { maxOutputTokens: request.maxTokens }),
    ...(request.seed === undefined ? {} : { seed: request.seed }),
    ...(request.stop === undefined ? {} : { stop: [...request.stop] }),
    ...(request.reasoning?.effort === undefined
      ? {}
      : { reasoningEffort: request.reasoning.effort }),
  };
}

function createLinkedAbortController(...signals: Array<AbortSignal | undefined>): {
  controller: AbortController;
  dispose: () => void;
} {
  const controller = new AbortController();
  const listeners = signals.flatMap((signal) => {
    if (signal === undefined) return [];
    const forwardAbort = () => controller.abort(signal.reason);
    if (signal.aborted) forwardAbort();
    else signal.addEventListener('abort', forwardAbort, { once: true });
    return [{ signal, forwardAbort }];
  });
  return {
    controller,
    dispose: () => {
      for (const listener of listeners) {
        listener.signal.removeEventListener('abort', listener.forwardAbort);
      }
    },
  };
}

async function waitForJobCompletion<TInput, TOutput>(
  jobs: LlmAsyncJobManager<TInput, TOutput>,
  id: string,
  ownerId: string,
): Promise<void> {
  while (true) {
    const job = jobs.get(id, ownerId);
    if (!job || ['completed', 'failed', 'cancelled'].includes(job.status)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof LlmProviderError && error.code === 'LLM_ABORTED') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * quantile) - 1),
  );
  return sorted[index] ?? 0;
}

function zeroUsage(): LlmUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimated: true };
}
