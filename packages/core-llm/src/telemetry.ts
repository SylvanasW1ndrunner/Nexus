export type LlmTelemetryEventType =
  | 'request.started'
  | 'route.decided'
  | 'cache.hit'
  | 'cache.miss'
  | 'budget.reserved'
  | 'provider.attempt'
  | 'provider.retry'
  | 'provider.fallback'
  | 'provider.circuit_opened'
  | 'request.completed'
  | 'request.failed'
  | 'request.cancelled';

export type LlmTelemetryValue = string | number | boolean | null;

export type LlmTelemetryEvent = {
  type: LlmTelemetryEventType;
  timestamp: string;
  requestId: string;
  traceId: string;
  tenantHash: string;
  taskType: string;
  providerId?: string;
  modelId?: string;
  attempt?: number;
  latencyMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  estimatedTokens?: number;
  cost?: number;
  errorCode?: string;
  attributes?: Record<string, LlmTelemetryValue>;
};

export interface LlmTelemetrySink {
  emit(event: LlmTelemetryEvent): void | Promise<void>;
}

export class InMemoryLlmTelemetrySink implements LlmTelemetrySink {
  private readonly events: LlmTelemetryEvent[] = [];

  constructor(private readonly maxEvents = 10_000) {}

  emit(event: LlmTelemetryEvent): void {
    this.events.push(cloneEvent(event));
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
  }

  list(options: { requestId?: string; type?: LlmTelemetryEventType } = {}): LlmTelemetryEvent[] {
    return this.events
      .filter((event) => !options.requestId || event.requestId === options.requestId)
      .filter((event) => !options.type || event.type === options.type)
      .map(cloneEvent);
  }

  clear(): void {
    this.events.length = 0;
  }
}

export type LlmMetricsSnapshot = {
  requests: number;
  completed: number;
  failed: number;
  cancelled: number;
  cacheHits: number;
  retries: number;
  fallbacks: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCost: number;
  latencyMs: { p50: number; p95: number; p99: number; max: number };
  byModel: Record<string, { attempts: number; completed: number; failed: number }>;
};

export class LlmMetricsCollector implements LlmTelemetrySink {
  private readonly latencies: number[] = [];
  private readonly counters = {
    requests: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    cacheHits: 0,
    retries: 0,
    fallbacks: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalCost: 0,
  };
  private readonly byModel = new Map<string, { attempts: number; completed: number; failed: number }>();

  emit(event: LlmTelemetryEvent): void {
    if (event.type === 'request.started') this.counters.requests += 1;
    if (event.type === 'request.completed') {
      this.counters.completed += 1;
      this.counters.totalPromptTokens += event.promptTokens ?? 0;
      this.counters.totalCompletionTokens += event.completionTokens ?? 0;
      this.counters.totalCost += event.cost ?? 0;
      if (event.latencyMs !== undefined) this.latencies.push(event.latencyMs);
      this.updateModel(event, 'completed');
    }
    if (event.type === 'request.failed') {
      this.counters.failed += 1;
      this.counters.totalPromptTokens += event.promptTokens ?? 0;
      this.counters.totalCompletionTokens += event.completionTokens ?? 0;
      this.counters.totalCost += event.cost ?? 0;
      if (event.latencyMs !== undefined) this.latencies.push(event.latencyMs);
      this.updateModel(event, 'failed');
    }
    if (event.type === 'request.cancelled') {
      this.counters.cancelled += 1;
      this.counters.totalPromptTokens += event.promptTokens ?? 0;
      this.counters.totalCompletionTokens += event.completionTokens ?? 0;
      this.counters.totalCost += event.cost ?? 0;
      if (event.latencyMs !== undefined) this.latencies.push(event.latencyMs);
    }
    if (event.type === 'cache.hit') this.counters.cacheHits += 1;
    if (event.type === 'provider.retry') this.counters.retries += 1;
    if (event.type === 'provider.fallback') this.counters.fallbacks += 1;
    if (event.type === 'provider.attempt') this.updateModel(event, 'attempts');
    if (this.latencies.length > 20_000) this.latencies.splice(0, this.latencies.length - 20_000);
  }

  snapshot(): LlmMetricsSnapshot {
    const values = [...this.latencies].sort((left, right) => left - right);
    return {
      ...this.counters,
      latencyMs: {
        p50: percentile(values, 0.5),
        p95: percentile(values, 0.95),
        p99: percentile(values, 0.99),
        max: values.at(-1) ?? 0,
      },
      byModel: Object.fromEntries([...this.byModel].map(([key, value]) => [key, { ...value }])),
    };
  }

  private updateModel(event: LlmTelemetryEvent, field: 'attempts' | 'completed' | 'failed'): void {
    if (!event.providerId || !event.modelId) return;
    const key = event.modelId.startsWith(`${event.providerId}:`)
      ? event.modelId
      : `${event.providerId}:${event.modelId}`;
    const current = this.byModel.get(key) ?? { attempts: 0, completed: 0, failed: 0 };
    current[field] += 1;
    this.byModel.set(key, current);
  }
}

export class CompositeLlmTelemetrySink implements LlmTelemetrySink {
  constructor(private readonly sinks: LlmTelemetrySink[]) {}

  async emit(event: LlmTelemetryEvent): Promise<void> {
    await Promise.all(this.sinks.map(async (sink) => sink.emit(cloneEvent(event))));
  }
}


function cloneEvent(event: LlmTelemetryEvent): LlmTelemetryEvent {
  return {
    ...event,
    ...(event.attributes === undefined ? {} : { attributes: { ...event.attributes } }),
  };
}

function percentile(sorted: number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index] ?? 0;
}
