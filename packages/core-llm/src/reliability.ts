import { LlmProviderError } from './types.js';

export type LlmReliabilityConfig = {
  maxConcurrency: number;
  maxQueueSize: number;
  maxQueueWaitMs: number;
  requestsPerMinute?: number;
  tokensPerMinute?: number;
  failureThreshold: number;
  circuitResetMs: number;
};

export type LlmCircuitSnapshot = {
  state: 'closed' | 'open' | 'half-open';
  consecutiveFailures: number;
  active: number;
  queued: number;
  openedAt?: number;
};

type Waiter = {
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort?: () => void;
};

type ProviderState = {
  config: LlmReliabilityConfig;
  active: number;
  queue: Waiter[];
  consecutiveFailures: number;
  circuit: 'closed' | 'open' | 'half-open';
  openedAt?: number;
  halfOpenInFlight: boolean;
  requestTimes: number[];
  tokenEvents: Array<{ at: number; tokens: number }>;
};

const DEFAULT_CONFIG: LlmReliabilityConfig = {
  maxConcurrency: 10,
  maxQueueSize: 100,
  maxQueueWaitMs: 30_000,
  failureThreshold: 3,
  circuitResetMs: 30_000,
};

export class LlmReliabilityController {
  private readonly states = new Map<string, ProviderState>();

  constructor(private readonly now: () => number = Date.now) {}

  configure(providerId: string, config: Partial<LlmReliabilityConfig>): void {
    const current = this.state(providerId);
    current.config = normalizeConfig({ ...current.config, ...config });
  }

  async execute<T>(
    providerId: string,
    operation: () => Promise<T>,
    signal?: AbortSignal,
    estimatedTokens = 0,
  ): Promise<T> {
    const release = await this.lease(providerId, signal, estimatedTokens);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async lease(providerId: string, signal?: AbortSignal, estimatedTokens = 0): Promise<() => void> {
    const state = this.state(providerId);
    this.assertCircuitAllows(providerId, state);
    let release: (() => void) | undefined;
    try {
      release = await this.acquire(providerId, state, signal);
      await this.enforceRateLimit(providerId, state, signal, estimatedTokens);
      return release;
    } catch (error) {
      release?.();
      if (state.circuit === 'half-open') state.halfOpenInFlight = false;
      throw error;
    }
  }

  recordSuccess(providerId: string): void {
    const state = this.state(providerId);
    state.consecutiveFailures = 0;
    state.circuit = 'closed';
    delete state.openedAt;
    state.halfOpenInFlight = false;
  }

  recordFailure(providerId: string): boolean {
    const state = this.state(providerId);
    state.consecutiveFailures += 1;
    state.halfOpenInFlight = false;
    if (state.circuit === 'half-open' || state.consecutiveFailures >= state.config.failureThreshold) {
      state.circuit = 'open';
      state.openedAt = this.now();
      return true;
    }
    return false;
  }

  snapshot(providerId: string): LlmCircuitSnapshot {
    const state = this.state(providerId);
    this.refreshCircuit(state);
    return {
      state: state.circuit,
      consecutiveFailures: state.consecutiveFailures,
      active: state.active,
      queued: state.queue.length,
      ...(state.openedAt === undefined ? {} : { openedAt: state.openedAt }),
    };
  }

  private state(providerId: string): ProviderState {
    let state = this.states.get(providerId);
    if (!state) {
      state = {
        config: { ...DEFAULT_CONFIG },
        active: 0,
        queue: [],
        consecutiveFailures: 0,
        circuit: 'closed',
        halfOpenInFlight: false,
        requestTimes: [],
        tokenEvents: [],
      };
      this.states.set(providerId, state);
    }
    return state;
  }

  private assertCircuitAllows(providerId: string, state: ProviderState): void {
    this.refreshCircuit(state);
    if (state.circuit === 'open' || (state.circuit === 'half-open' && state.halfOpenInFlight)) {
      throw new LlmProviderError('LLM_CIRCUIT_OPEN', `LLM provider circuit is open: ${providerId}`, true);
    }
    if (state.circuit === 'half-open') state.halfOpenInFlight = true;
  }

  private refreshCircuit(state: ProviderState): void {
    if (state.circuit !== 'open' || state.openedAt === undefined) return;
    if (this.now() - state.openedAt >= state.config.circuitResetMs) {
      state.circuit = 'half-open';
      state.halfOpenInFlight = false;
    }
  }

  private async acquire(providerId: string, state: ProviderState, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw abortedError();
    if (state.active < state.config.maxConcurrency) {
      state.active += 1;
      return () => this.release(state);
    }
    if (state.queue.length >= state.config.maxQueueSize) {
      throw new LlmProviderError('LLM_QUEUE_FULL', `LLM provider queue is full: ${providerId}`, true);
    }
    return await new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.removeWaiter(state, waiter);
          reject(new LlmProviderError('LLM_QUEUE_FULL', `LLM provider queue wait timed out: ${providerId}`, true));
        }, state.config.maxQueueWaitMs),
        ...(signal === undefined ? {} : { signal }),
      };
      if (signal) {
        waiter.abort = () => {
          this.removeWaiter(state, waiter);
          reject(abortedError());
        };
        signal.addEventListener('abort', waiter.abort, { once: true });
      }
      state.queue.push(waiter);
    });
  }

  private release(state: ProviderState): void {
    state.active = Math.max(0, state.active - 1);
    while (state.queue.length > 0) {
      const waiter = state.queue.shift() as Waiter;
      clearTimeout(waiter.timer);
      if (waiter.abort && waiter.signal) waiter.signal.removeEventListener('abort', waiter.abort);
      if (waiter.signal?.aborted) {
        waiter.reject(abortedError());
        continue;
      }
      state.active += 1;
      waiter.resolve(() => this.release(state));
      break;
    }
  }

  private removeWaiter(state: ProviderState, waiter: Waiter): void {
    const index = state.queue.indexOf(waiter);
    if (index >= 0) state.queue.splice(index, 1);
    clearTimeout(waiter.timer);
    if (waiter.abort && waiter.signal) waiter.signal.removeEventListener('abort', waiter.abort);
  }

  private async enforceRateLimit(
    providerId: string,
    state: ProviderState,
    signal?: AbortSignal,
    estimatedTokens = 0,
  ): Promise<void> {
    const limit = state.config.requestsPerMinute;
    const waitDeadline = this.now() + state.config.maxQueueWaitMs;
    while (limit) {
      const now = this.now();
      state.requestTimes = state.requestTimes.filter((value) => value > now - 60_000);
      if (state.requestTimes.length < limit) break;
      const waitMs = Math.max(1, (state.requestTimes[0] ?? now) + 60_000 - now);
      if (waitMs > waitDeadline - now) {
        throw new LlmProviderError('LLM_RATE_LIMITED', `Local rate limit reached: ${providerId}`, true, 429);
      }
      await cancellableDelay(waitMs, signal);
    }
    const tokenLimit = state.config.tokensPerMinute;
    const tokens = Math.max(0, Math.trunc(estimatedTokens));
    if (tokenLimit && tokens > tokenLimit) {
      throw new LlmProviderError('LLM_RATE_LIMITED', `Estimated tokens exceed the provider token rate limit: ${providerId}`, true, 429);
    }
    while (tokenLimit) {
      const now = this.now();
      state.tokenEvents = state.tokenEvents.filter((event) => event.at > now - 60_000);
      const usedTokens = state.tokenEvents.reduce((total, event) => total + event.tokens, 0);
      if (usedTokens + tokens <= tokenLimit) break;
      const waitMs = Math.max(1, (state.tokenEvents[0]?.at ?? now) + 60_000 - now);
      if (waitMs > waitDeadline - now) {
        throw new LlmProviderError('LLM_RATE_LIMITED', `Local token rate limit reached: ${providerId}`, true, 429);
      }
      await cancellableDelay(waitMs, signal);
    }
    state.requestTimes.push(this.now());
    if (tokens > 0) state.tokenEvents.push({ at: this.now(), tokens });
  }
}

function normalizeConfig(config: LlmReliabilityConfig): LlmReliabilityConfig {
  for (const key of ['maxConcurrency', 'maxQueueSize', 'maxQueueWaitMs', 'failureThreshold', 'circuitResetMs'] as const) {
    if (!Number.isInteger(config[key]) || config[key] <= 0) throw new Error(`${key} must be a positive integer.`);
  }
  if (config.requestsPerMinute !== undefined && (!Number.isInteger(config.requestsPerMinute) || config.requestsPerMinute <= 0)) {
    throw new Error('requestsPerMinute must be a positive integer.');
  }
  if (config.tokensPerMinute !== undefined && (!Number.isInteger(config.tokensPerMinute) || config.tokensPerMinute <= 0)) {
    throw new Error('tokensPerMinute must be a positive integer.');
  }
  return { ...config };
}

function abortedError(): LlmProviderError {
  return new LlmProviderError('LLM_ABORTED', 'LLM request was aborted by the user.', false);
}

async function cancellableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortedError();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(abortedError());
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal) {
      void Promise.resolve().then(() => {
        if (!signal.aborted) return;
        abort();
      });
    }
  });
}
