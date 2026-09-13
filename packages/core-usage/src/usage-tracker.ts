import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { UsageMode, UsageSnapshot } from '@dbagent/shared';

export type LlmUsageInput = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

/** An authoritative source is read as a total, never replayed as a delta. */
export type AbsoluteUsageProjection = Readonly<{
  sourceKey: string;
  getSnapshot: () => Promise<UsageSnapshot | readonly UsageSnapshot[]>;
}>;

export type UsageProjectionFailure = Readonly<{
  code: 'PROVIDER_FAILED' | 'INVALID_SNAPSHOT';
  message: string;
}>;

export type UsageProjectionStatus = Readonly<{
  sourceKey: string;
  status: 'healthy' | 'failed';
  failure?: UsageProjectionFailure;
}>;

export type UsageTrackerOptions = {
  now?: () => Date;
  historyLimit?: number;
};

type UsageState = {
  version: 2;
  directTotals: Partial<Record<UsageMode, UsageSnapshot>>;
  directHistory: UsageSnapshot[];
};

type ProjectionSource = {
  readers: Map<number, AbsoluteUsageProjection['getSnapshot']>;
  status: UsageProjectionStatus;
};

const DEFAULT_HISTORY_LIMIT = 100;
const persistentMutationQueues = new Map<string, Promise<void>>();

/** A malformed direct state is never silently replaced with a zero balance. */
export class UsageTrackerStateError extends Error {
  readonly code: 'INVALID_STATE' | 'PROJECTION_UNAVAILABLE';

  constructor(
    message: string,
    options?: ErrorOptions,
    code: 'INVALID_STATE' | 'PROJECTION_UNAVAILABLE' = 'INVALID_STATE',
  ) {
    super(message, options);
    this.name = 'UsageTrackerStateError';
    this.code = code;
  }
}

export class UsageTracker {
  private readonly now: () => Date;
  private readonly historyLimit: number;
  private readonly resolvedHistoryPath: string | undefined;
  private memoryState: UsageState = { version: 2, directTotals: {}, directHistory: [] };
  private memoryMutation: Promise<void> = Promise.resolve();
  private readonly projections = new Map<string, ProjectionSource>();
  private nextProjectionReaderId = 0;

  constructor(historyPath?: string, options: UsageTrackerOptions = {}) {
    this.resolvedHistoryPath = historyPath === undefined ? undefined : resolve(historyPath);
    this.now = options.now ?? (() => new Date());
    this.historyLimit = boundedHistoryLimit(options.historyLimit ?? DEFAULT_HISTORY_LIMIT);
  }

  /** Returns direct usage plus one absolute total for every attached authority. */
  async current(mode: UsageMode = 'byok'): Promise<UsageSnapshot> {
    const state = await this.loadState();
    const projections = await this.readProjections();
    return mergeSnapshots(
      [this.totalForMode(state.directTotals, mode), ...projections.filter((snapshot) => snapshot.mode === mode)],
      mode,
      this.now,
    );
  }

  /** Returns the complete current aggregate, separated by immutable billing route. */
  async currentAll(): Promise<readonly UsageSnapshot[]> {
    const state = await this.loadState();
    const projections = await this.readProjections();
    return (['byok', 'managed'] as const).map((mode) => mergeSnapshots(
      [this.totalForMode(state.directTotals, mode), ...projections.filter((snapshot) => snapshot.mode === mode)],
      mode,
      this.now,
    ));
  }

  /**
   * Direct-call history only. Projection sources intentionally have no
   * fabricated history because their authorities need not expose it.
   */
  async directHistory(limit = 30): Promise<UsageSnapshot[]> {
    const state = await this.loadState();
    return state.directHistory.slice(0, boundedHistoryLimit(limit));
  }

  /** Registers a reader for one authority. Calling the returned release twice is safe. */
  attachAbsoluteProjection(projection: AbsoluteUsageProjection): () => void {
    const sourceKey = requireSourceKey(projection.sourceKey);
    if (typeof projection.getSnapshot !== 'function') {
      throw new TypeError('Absolute usage projection must provide getSnapshot().');
    }
    const readerId = ++this.nextProjectionReaderId;
    const source = this.projections.get(sourceKey) ?? {
      readers: new Map(),
      status: { sourceKey, status: 'healthy' as const },
    };
    source.readers.set(readerId, projection.getSnapshot);
    this.projections.set(sourceKey, source);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const registered = this.projections.get(sourceKey);
      if (registered === undefined) return;
      registered.readers.delete(readerId);
      if (registered.readers.size === 0) this.projections.delete(sourceKey);
    };
  }

  /** Last projection read result; failed sources remain queryable and isolated. */
  projectionStatus(): Promise<readonly UsageProjectionStatus[]> {
    return Promise.resolve([...this.projections.values()].map(({ status }) => ({ ...status })));
  }

  /** Records only a direct, non-Agent model call. */
  async recordTokens(mode: UsageMode, usage: LlmUsageInput): Promise<UsageSnapshot> {
    assertUsageMode(mode);
    const validatedUsage = validateUsageInput(usage);
    return this.mutateState((state) => {
      const current = this.totalForMode(state.directTotals, mode);
      const next: UsageSnapshot = {
        ...current,
        mode,
        promptTokens: current.promptTokens + validatedUsage.promptTokens,
        completionTokens: current.completionTokens + validatedUsage.completionTokens,
        totalTokens: current.totalTokens + validatedUsage.totalTokens,
      };
      return {
        state: {
          version: 2,
          directTotals: { ...state.directTotals, [mode]: next },
          directHistory: [next, ...state.directHistory].slice(0, this.historyLimit),
        },
        value: next,
      };
    });
  }

  private async readProjections(): Promise<UsageSnapshot[]> {
    const snapshots: UsageSnapshot[] = [];
    const failedSources: string[] = [];
    for (const [sourceKey, source] of this.projections) {
      let failure: UsageProjectionFailure | undefined;
      for (const getSnapshot of source.readers.values()) {
        try {
          const candidate = await getSnapshot();
          const values = Array.isArray(candidate) ? candidate : [candidate];
          const normalized = values.map(normalizeProjectionSnapshot);
          if (new Set(normalized.map(({ mode }) => mode)).size !== normalized.length) {
            throw new UsageTrackerStateError('Projection source supplied more than one total for a usage mode.');
          }
          snapshots.push(...normalized);
          source.status = { sourceKey, status: 'healthy' };
          failure = undefined;
          break;
        } catch (error) {
          failure = projectionFailure(error);
        }
      }
      if (failure !== undefined) {
        source.status = { sourceKey, status: 'failed', failure };
        failedSources.push(sourceKey);
      }
    }
    if (failedSources.length > 0) {
      throw new UsageTrackerStateError(
        `Authoritative usage projection is unavailable: ${failedSources.join(', ')}.`,
        undefined,
        'PROJECTION_UNAVAILABLE',
      );
    }
    return snapshots;
  }

  private async mutateState<T>(mutation: (state: UsageState) => { state: UsageState; value: T }): Promise<T> {
    if (this.resolvedHistoryPath === undefined) return this.serializeMemoryMutation(mutation);
    return withPersistentMutation(this.resolvedHistoryPath, async () => {
      const current = await this.loadState();
      const next = mutation(current);
      await this.saveState(next.state);
      return next.value;
    });
  }

  private async serializeMemoryMutation<T>(mutation: (state: UsageState) => { state: UsageState; value: T }): Promise<T> {
    const previous = this.memoryMutation;
    let release!: () => void;
    this.memoryMutation = new Promise<void>((resolveMutation) => { release = resolveMutation; });
    await previous;
    try {
      const next = mutation(structuredClone(this.memoryState));
      this.memoryState = structuredClone(next.state);
      return next.value;
    } finally {
      release();
    }
  }

  private totalForMode(totals: UsageState['directTotals'], mode: UsageMode): UsageSnapshot {
    return totals[mode] ?? zeroSnapshot(mode, this.now);
  }

  private async loadState(): Promise<UsageState> {
    if (this.resolvedHistoryPath === undefined) return structuredClone(this.memoryState);
    try {
      const raw = await readFile(this.resolvedHistoryPath, 'utf8');
      return parseState(raw, this.historyLimit);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 2, directTotals: {}, directHistory: [] };
      }
      if (error instanceof UsageTrackerStateError) throw error;
      throw new UsageTrackerStateError('Cannot read persisted usage state.', { cause: error });
    }
  }

  private async saveState(state: UsageState): Promise<void> {
    if (this.resolvedHistoryPath === undefined) {
      this.memoryState = structuredClone(state);
      return;
    }
    await mkdir(dirname(this.resolvedHistoryPath), { recursive: true });
    const temporaryPath = `${this.resolvedHistoryPath}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, 'utf8');
      await rename(temporaryPath, this.resolvedHistoryPath);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

async function withPersistentMutation<T>(path: string, work: () => Promise<T>): Promise<T> {
  const previous = persistentMutationQueues.get(path) ?? Promise.resolve();
  let release!: () => void;
  const queued = new Promise<void>((resolveQueue) => { release = resolveQueue; });
  persistentMutationQueues.set(path, queued);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (persistentMutationQueues.get(path) === queued) persistentMutationQueues.delete(path);
  }
}

function parseState(raw: string, historyLimit: number): UsageState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new UsageTrackerStateError('Persisted usage state is not valid JSON.', { cause: error });
  }
  if (Array.isArray(parsed)) return migrateLegacySnapshots(parsed, historyLimit);
  if (!isRecord(parsed)) throw new UsageTrackerStateError('Persisted usage state must be an object.');
  if (parsed.version === 2) return parseVersion2State(parsed, historyLimit);
  if (parsed.version === 1 && Array.isArray(parsed.snapshots)) {
    return migrateLegacySnapshots(parsed.snapshots, historyLimit);
  }
  throw new UsageTrackerStateError('Persisted usage state has an unsupported version.');
}

function parseVersion2State(value: Record<string, unknown>, historyLimit: number): UsageState {
  assertExactKeys(value, ['version', 'directTotals', 'directHistory'], 'Persisted usage state');
  if (!isRecord(value.directTotals) || !Array.isArray(value.directHistory)) {
    throw new UsageTrackerStateError('Persisted usage state is missing direct totals or history.');
  }
  assertExactKeys(value.directTotals, ['byok', 'managed'], 'Persisted usage direct totals');
  const directTotals: UsageState['directTotals'] = {};
  for (const mode of ['byok', 'managed'] as const) {
    const snapshot = value.directTotals[mode];
    if (snapshot !== undefined) directTotals[mode] = parseSnapshot(snapshot, mode);
  }
  return {
    version: 2,
    directTotals,
    directHistory: value.directHistory.map((snapshot) => parseSnapshot(snapshot)).slice(0, historyLimit),
  };
}

/** Version 0 arrays and version 1 snapshot objects stored cumulative per-mode rows. */
function migrateLegacySnapshots(snapshots: readonly unknown[], historyLimit: number): UsageState {
  const directHistory = snapshots.map((snapshot) => parseLegacySnapshot(snapshot)).slice(0, historyLimit);
  const directTotals: UsageState['directTotals'] = {};
  for (const snapshot of snapshots.map((value) => parseLegacySnapshot(value))) {
    if (directTotals[snapshot.mode] === undefined) directTotals[snapshot.mode] = snapshot;
  }
  return { version: 2, directTotals, directHistory };
}

function mergeSnapshots(snapshots: readonly UsageSnapshot[], mode: UsageMode, now: () => Date): UsageSnapshot {
  return {
    mode,
    windowStartedAt: snapshots.map(({ windowStartedAt }) => windowStartedAt).sort()[0] ?? now().toISOString(),
    promptTokens: snapshots.reduce((total, snapshot) => total + snapshot.promptTokens, 0),
    completionTokens: snapshots.reduce((total, snapshot) => total + snapshot.completionTokens, 0),
    totalTokens: snapshots.reduce((total, snapshot) => total + snapshot.totalTokens, 0),
  };
}

function zeroSnapshot(mode: UsageMode, now: () => Date): UsageSnapshot {
  return { mode, windowStartedAt: now().toISOString(), promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function parseLegacySnapshot(value: unknown): UsageSnapshot {
  if (!isRecord(value) || !isNonNegativeInteger(value.completedRounds)) {
    throw new UsageTrackerStateError('Legacy usage snapshot is invalid.');
  }
  return parseSnapshot(value);
}

function parseSnapshot(value: unknown, expectedMode?: UsageMode): UsageSnapshot {
  if (!isRecord(value) || (value.mode !== 'byok' && value.mode !== 'managed')) {
    throw new UsageTrackerStateError('Usage snapshot has an invalid mode.');
  }
  if (expectedMode !== undefined && value.mode !== expectedMode) {
    throw new UsageTrackerStateError('Usage total is stored under the wrong billing mode.');
  }
  if (
    typeof value.windowStartedAt !== 'string' || Number.isNaN(Date.parse(value.windowStartedAt)) ||
    !isNonNegativeInteger(value.promptTokens) || !isNonNegativeInteger(value.completionTokens) ||
    !isNonNegativeInteger(value.totalTokens)
  ) {
    throw new UsageTrackerStateError('Usage snapshot has invalid usage totals.');
  }
  if (value.windowEndsAt !== undefined && (
    typeof value.windowEndsAt !== 'string' || Number.isNaN(Date.parse(value.windowEndsAt))
  )) {
    throw new UsageTrackerStateError('Usage snapshot has an invalid window end.');
  }
  return {
    mode: value.mode,
    windowStartedAt: value.windowStartedAt,
    ...(value.windowEndsAt === undefined ? {} : { windowEndsAt: value.windowEndsAt }),
    promptTokens: value.promptTokens,
    completionTokens: value.completionTokens,
    totalTokens: value.totalTokens,
  };
}

function normalizeProjectionSnapshot(value: unknown): UsageSnapshot {
  return parseSnapshot(value);
}

function projectionFailure(error: unknown): UsageProjectionFailure {
  if (error instanceof UsageTrackerStateError) {
    return { code: 'INVALID_SNAPSHOT', message: error.message };
  }
  return { code: 'PROVIDER_FAILED', message: error instanceof Error ? error.message : String(error) };
}

function validateUsageInput(value: LlmUsageInput): LlmUsageInput {
  if (!isRecord(value)) throw new UsageTrackerStateError('Usage input must be an object.');
  return {
    promptTokens: requireTokenCount(value.promptTokens, 'promptTokens'),
    completionTokens: requireTokenCount(value.completionTokens, 'completionTokens'),
    totalTokens: requireTokenCount(value.totalTokens, 'totalTokens'),
  };
}

function requireTokenCount(value: unknown, field: string): number {
  if (!isNonNegativeInteger(value)) {
    throw new UsageTrackerStateError(`Usage input ${field} must be a non-negative safe integer.`);
  }
  return value;
}

function assertUsageMode(value: unknown): asserts value is UsageMode {
  if (value !== 'byok' && value !== 'managed') {
    throw new UsageTrackerStateError('Usage mode must be byok or managed.');
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function boundedHistoryLimit(value: number): number {
  return Math.max(0, Math.min(DEFAULT_HISTORY_LIMIT, Math.trunc(Number.isFinite(value) ? value : DEFAULT_HISTORY_LIMIT)));
}

function requireSourceKey(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new TypeError('Absolute usage projection sourceKey must be a non-empty canonical string.');
  }
  return value;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  if (Object.keys(value).some((key) => !expected.includes(key))) {
    throw new UsageTrackerStateError(`${label} contains unknown fields.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
