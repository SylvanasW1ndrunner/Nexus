export type McpServerStatus =
  | 'stopped'
  | 'starting'
  | 'healthy'
  | 'unhealthy'
  | 'restarting'
  | 'disabled';

export type McpResourceSample = {
  rssBytes?: number;
  cpuPercent?: number;
  sampledAt?: string;
};

export type McpServerHealthState = {
  serverId: string;
  status: McpServerStatus;
  healthy: boolean;
  restartCount: number;
  warnings: string[];
  lastStartedAt?: string | undefined;
  lastHealthyAt?: string | undefined;
  lastExitAt?: string | undefined;
  lastExitCode?: number | undefined;
  lastExitSignal?: string | undefined;
  lastError?: string | undefined;
  nextRestartAt?: string | undefined;
  resource?: McpResourceSample | undefined;
};

export type McpHealthManagerOptions = {
  maxRestarts?: number;
  baseRestartDelayMs?: number;
  maxRestartDelayMs?: number;
  memoryLimitBytes?: number;
  cpuLimitPercent?: number;
  cpuSustainMs?: number;
  now?: () => string;
};

/** Opaque lifecycle snapshot; includes non-public rate/threshold state. */
export type McpHealthTransactionSnapshot = Readonly<{
  state: McpServerHealthState | undefined;
  cpuOverLimitSince: string | undefined;
}>;

export type McpToolTimeoutOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

const DEFAULT_MAX_RESTARTS = 3;
const DEFAULT_BASE_RESTART_DELAY_MS = 1_000;
const DEFAULT_MAX_RESTART_DELAY_MS = 30_000;
const DEFAULT_MEMORY_LIMIT_BYTES = 512 * 1024 * 1024;
const DEFAULT_CPU_LIMIT_PERCENT = 100;
const DEFAULT_CPU_SUSTAIN_MS = 60_000;
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

export class McpToolTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`MCP tool call timed out after ${timeoutMs}ms.`);
    this.name = 'McpToolTimeoutError';
  }
}

export class McpToolAbortedError extends Error {
  constructor() {
    super('MCP tool call was aborted.');
    this.name = 'McpToolAbortedError';
  }
}

export class McpUnavailableError extends Error {
  constructor(readonly serverId: string) {
    super(`MCP server is unavailable: ${serverId}.`);
    this.name = 'McpUnavailableError';
  }
}

export class McpHealthManager {
  private readonly states = new Map<string, McpServerHealthState>();
  private readonly cpuOverLimitSince = new Map<string, string>();
  private readonly maxRestarts: number;
  private readonly baseRestartDelayMs: number;
  private readonly maxRestartDelayMs: number;
  private readonly memoryLimitBytes: number;
  private readonly cpuLimitPercent: number;
  private readonly cpuSustainMs: number;
  private readonly now: () => string;

  constructor(options: McpHealthManagerOptions = {}) {
    this.maxRestarts = normalizePositiveInteger(options.maxRestarts, DEFAULT_MAX_RESTARTS);
    this.baseRestartDelayMs = normalizePositiveInteger(
      options.baseRestartDelayMs,
      DEFAULT_BASE_RESTART_DELAY_MS,
    );
    this.maxRestartDelayMs = normalizePositiveInteger(
      options.maxRestartDelayMs,
      DEFAULT_MAX_RESTART_DELAY_MS,
    );
    this.memoryLimitBytes = normalizePositiveInteger(
      options.memoryLimitBytes,
      DEFAULT_MEMORY_LIMIT_BYTES,
    );
    this.cpuLimitPercent = normalizePositiveInteger(
      options.cpuLimitPercent,
      DEFAULT_CPU_LIMIT_PERCENT,
    );
    this.cpuSustainMs = normalizePositiveInteger(options.cpuSustainMs, DEFAULT_CPU_SUSTAIN_MS);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  capture(serverId: string): McpHealthTransactionSnapshot {
    const state = this.states.get(serverId);
    return Object.freeze({
      state: state === undefined ? undefined : {
        ...state,
        warnings: [...state.warnings],
        ...(state.resource === undefined ? {} : { resource: { ...state.resource } }),
      },
      cpuOverLimitSince: this.cpuOverLimitSince.get(serverId),
    });
  }

  restore(serverId: string, snapshot: McpHealthTransactionSnapshot): void {
    if (snapshot.state === undefined) {
      this.states.delete(serverId);
    } else {
      this.states.set(serverId, {
        ...snapshot.state,
        warnings: [...snapshot.state.warnings],
        ...(snapshot.state.resource === undefined ? {} : { resource: { ...snapshot.state.resource } }),
      });
    }
    if (snapshot.cpuOverLimitSince === undefined) this.cpuOverLimitSince.delete(serverId);
    else this.cpuOverLimitSince.set(serverId, snapshot.cpuOverLimitSince);
  }

  markStarting(serverId: string): McpServerHealthState {
    return this.update(serverId, (state) => ({
      ...state,
      status: 'starting',
      healthy: false,
      lastStartedAt: this.now(),
      lastError: undefined,
    }));
  }

  markHealthy(serverId: string): McpServerHealthState {
    return this.update(serverId, (state) => ({
      ...state,
      status: 'healthy',
      healthy: true,
      lastHealthyAt: this.now(),
      lastError: undefined,
      nextRestartAt: undefined,
    }));
  }

  markStopped(serverId: string): McpServerHealthState {
    this.cpuOverLimitSince.delete(serverId);
    return this.update(serverId, (state) => ({
      ...state,
      status: 'stopped',
      healthy: false,
      lastError: undefined,
      nextRestartAt: undefined,
    }));
  }

  recordDiagnostic(serverId: string, message: string): McpServerHealthState {
    const bounded = message.trim().slice(0, 240);
    if (!bounded) return this.get(serverId);
    return this.update(serverId, (state) => ({
      ...state,
      lastError: bounded,
      warnings: [...state.warnings, bounded].slice(-8),
    }));
  }

  markUnhealthy(serverId: string, errorMessage: string): McpServerHealthState {
    return this.update(serverId, (state) => ({
      ...state,
      status: 'unhealthy',
      healthy: false,
      lastError: errorMessage,
      nextRestartAt: undefined,
    }));
  }

  disable(serverId: string, reason: string): McpServerHealthState {
    return this.update(serverId, (state) => ({
      ...state,
      status: 'disabled',
      healthy: false,
      lastError: reason,
      nextRestartAt: undefined,
    }));
  }

  recordExit(
    serverId: string,
    input: { code?: number; signal?: string; errorMessage?: string; at?: string } = {},
  ): McpServerHealthState {
    const at = input.at ?? this.now();
    return this.update(serverId, (state) => {
      if (state.status === 'disabled') {
        return {
          ...state,
          healthy: false,
          lastExitAt: at,
          ...(input.code === undefined ? {} : { lastExitCode: input.code }),
          ...(input.signal === undefined ? {} : { lastExitSignal: input.signal }),
          nextRestartAt: undefined,
        };
      }

      const restartCount = state.restartCount + 1;
      const canRestart = restartCount <= this.maxRestarts;
      const delayMs = restartDelayMs(restartCount, this.baseRestartDelayMs, this.maxRestartDelayMs);
      return {
        ...state,
        status: canRestart ? 'restarting' : 'unhealthy',
        healthy: false,
        restartCount,
        lastExitAt: at,
        ...(input.code === undefined ? {} : { lastExitCode: input.code }),
        ...(input.signal === undefined ? {} : { lastExitSignal: input.signal }),
        lastError:
          input.errorMessage ??
          (canRestart
            ? `Process exited; restart scheduled in ${delayMs}ms.`
            : 'Process exited; restart limit reached.'),
        nextRestartAt: canRestart ? addMilliseconds(at, delayMs) : undefined,
      };
    });
  }

  recordResourceSample(serverId: string, sample: McpResourceSample): McpServerHealthState {
    const sampledAt = sample.sampledAt ?? this.now();
    return this.update(serverId, (state) => {
      if (state.status === 'disabled') {
        return {
          ...state,
          resource: { ...sample, sampledAt },
        };
      }

      const warnings = [...state.warnings];
      let status = state.status;
      let healthy = state.healthy;
      let lastError = state.lastError;
      let nextRestartAt = state.nextRestartAt;

      if ((sample.rssBytes ?? 0) > this.memoryLimitBytes) {
        pushWarning(warnings, `Memory limit exceeded: ${sample.rssBytes} bytes.`);
        const restartCount = state.restartCount + 1;
        const canRestart = restartCount <= this.maxRestarts;
        const delayMs = restartDelayMs(
          restartCount,
          this.baseRestartDelayMs,
          this.maxRestartDelayMs,
        );
        status = canRestart ? 'restarting' : 'unhealthy';
        healthy = false;
        lastError = canRestart
          ? `Memory limit exceeded; restart scheduled in ${delayMs}ms.`
          : 'Memory limit exceeded; restart limit reached.';
        nextRestartAt = canRestart ? addMilliseconds(sampledAt, delayMs) : undefined;
        return {
          ...state,
          status,
          healthy,
          restartCount,
          warnings,
          lastError,
          nextRestartAt,
          resource: { ...sample, sampledAt },
        };
      }

      const cpuPercent = sample.cpuPercent ?? 0;
      if (cpuPercent >= this.cpuLimitPercent) {
        const overSince = this.cpuOverLimitSince.get(serverId) ?? sampledAt;
        this.cpuOverLimitSince.set(serverId, overSince);
        if (Date.parse(sampledAt) - Date.parse(overSince) >= this.cpuSustainMs) {
          pushWarning(
            warnings,
            `CPU stayed above ${this.cpuLimitPercent}% for at least ${this.cpuSustainMs}ms.`,
          );
        }
      } else {
        this.cpuOverLimitSince.delete(serverId);
      }

      return {
        ...state,
        warnings,
        resource: { ...sample, sampledAt },
      };
    });
  }

  get(serverId: string): McpServerHealthState {
    return cloneState(this.ensure(serverId));
  }

  list(): McpServerHealthState[] {
    return [...this.states.values()].map(cloneState);
  }

  assertAvailable(serverId: string): void {
    if (!this.ensure(serverId).healthy) throw new McpUnavailableError(serverId);
  }

  private update(
    serverId: string,
    updater: (state: McpServerHealthState) => McpServerHealthState,
  ): McpServerHealthState {
    const next = pruneUndefined(updater(this.ensure(serverId)));
    this.states.set(serverId, next);
    return cloneState(next);
  }

  private ensure(serverId: string): McpServerHealthState {
    const existing = this.states.get(serverId);
    if (existing) return existing;
    const initial: McpServerHealthState = {
      serverId,
      status: 'stopped',
      healthy: false,
      restartCount: 0,
      warnings: [],
    };
    this.states.set(serverId, initial);
    return initial;
  }
}

export async function invokeMcpToolWithTimeout<T>(
  invoke: (signal: AbortSignal) => Promise<T> | T,
  options: McpToolTimeoutOptions = {},
): Promise<T> {
  const timeoutMs = normalizePositiveInteger(options.timeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
  const controller = new AbortController();
  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;

  const invokePromise = Promise.resolve().then(() => invoke(controller.signal));
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      if (settled) return;
      controller.abort();
      reject(new McpToolTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  const abortPromise =
    options.signal === undefined
      ? undefined
      : new Promise<never>((_, reject) => {
          const abort = () => {
            if (settled) return;
            controller.abort();
            reject(new McpToolAbortedError());
          };

          if (options.signal?.aborted) {
            abort();
            return;
          }

          options.signal?.addEventListener('abort', abort, { once: true });
          removeAbortListener = () => options.signal?.removeEventListener('abort', abort);
        });

  try {
    const candidates: Array<Promise<T> | Promise<never>> = [invokePromise, timeoutPromise];
    if (abortPromise) candidates.push(abortPromise);
    return await Promise.race(candidates);
  } finally {
    settled = true;
    if (timeout) clearTimeout(timeout);
    removeAbortListener?.();
  }
}

function restartDelayMs(restartCount: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, restartCount - 1));
}

function addMilliseconds(isoTime: string, ms: number): string {
  const time = Date.parse(isoTime);
  if (!Number.isFinite(time)) return new Date(ms).toISOString();
  return new Date(time + ms).toISOString();
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function pushWarning(warnings: string[], warning: string): void {
  if (!warnings.includes(warning)) warnings.push(warning);
}

function cloneState(state: McpServerHealthState): McpServerHealthState {
  return JSON.parse(JSON.stringify(state)) as McpServerHealthState;
}

function pruneUndefined(state: McpServerHealthState): McpServerHealthState {
  return JSON.parse(JSON.stringify(state)) as McpServerHealthState;
}
