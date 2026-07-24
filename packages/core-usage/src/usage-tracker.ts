import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { UsageMode, UsageSnapshot } from '@dbagent/shared';

export type UsageRoundStatus = 'running' | 'success' | 'aborted' | 'failed';

export type RoundContext = {
  id: string;
  sessionId: string;
  mode: UsageMode;
  startedAt: string;
};

export type UsageRoundRecord = RoundContext & {
  status: UsageRoundStatus;
  endedAt?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  errorMessage?: string;
};

export type LlmUsageInput = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type UsageTrackerOptions = {
  now?: () => Date;
  createRoundId?: () => string;
  historyLimit?: number;
};

type UsageState = {
  version: 1;
  snapshots: UsageSnapshot[];
  rounds: UsageRoundRecord[];
};

const DEFAULT_HISTORY_LIMIT = 100;

export class UsageTracker {
  private readonly now: () => Date;
  private readonly createRoundId: () => string;
  private readonly historyLimit: number;
  private memoryState: UsageState = { version: 1, snapshots: [], rounds: [] };

  constructor(
    private readonly historyPath?: string,
    options: UsageTrackerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.createRoundId = options.createRoundId ?? (() => crypto.randomUUID());
    this.historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
  }

  async current(): Promise<UsageSnapshot> {
    const history = await this.history(1);
    return history[0] ?? this.zeroSnapshot('byok');
  }

  async history(limit = 30): Promise<UsageSnapshot[]> {
    const state = await this.loadState();
    return state.snapshots.slice(0, limit);
  }

  async roundHistory(limit = 30): Promise<UsageRoundRecord[]> {
    const state = await this.loadState();
    return state.rounds.slice(0, limit);
  }

  async startConversationRound(sessionId: string, mode: UsageMode): Promise<RoundContext> {
    const startedAt = this.now().toISOString();
    const round: UsageRoundRecord = {
      id: this.createRoundId(),
      sessionId,
      mode,
      startedAt,
      status: 'running',
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    const state = await this.loadState();
    await this.saveState({
      ...state,
      rounds: [round, ...state.rounds].slice(0, this.historyLimit),
    });
    return {
      id: round.id,
      sessionId,
      mode,
      startedAt,
    };
  }

  async recordLlmCall(round: RoundContext, usage: LlmUsageInput): Promise<UsageRoundRecord> {
    const state = await this.loadState();
    const index = state.rounds.findIndex((item) => item.id === round.id);
    if (index < 0) {
      throw new Error(`Usage round is not registered: ${round.id}`);
    }

    const current = state.rounds[index] as UsageRoundRecord;
    const next: UsageRoundRecord = {
      ...current,
      promptTokens: current.promptTokens + Math.max(0, Math.trunc(usage.promptTokens)),
      completionTokens: current.completionTokens + Math.max(0, Math.trunc(usage.completionTokens)),
      totalTokens: current.totalTokens + Math.max(0, Math.trunc(usage.totalTokens)),
    };
    const rounds = [...state.rounds];
    rounds[index] = next;
    await this.saveState({ ...state, rounds });
    return next;
  }

  async endConversationRound(
    round: RoundContext,
    status: Exclude<UsageRoundStatus, 'running'>,
    errorMessage?: string,
  ): Promise<UsageSnapshot> {
    const state = await this.loadState();
    const index = state.rounds.findIndex((item) => item.id === round.id);
    if (index < 0) {
      throw new Error(`Usage round is not registered: ${round.id}`);
    }

    const currentRound = state.rounds[index] as UsageRoundRecord;
    const endedRound: UsageRoundRecord = {
      ...currentRound,
      status,
      endedAt: this.now().toISOString(),
      ...(errorMessage === undefined ? {} : { errorMessage }),
    };
    const rounds = [...state.rounds];
    rounds[index] = endedRound;

    const countCompletedRound = status === 'success' || status === 'aborted';
    const nextSnapshot = this.snapshotAfterRound(state.snapshots, round.mode, countCompletedRound, {
      promptTokens: endedRound.promptTokens,
      completionTokens: endedRound.completionTokens,
      totalTokens: endedRound.totalTokens,
    });
    const snapshots = [nextSnapshot, ...state.snapshots].slice(0, this.historyLimit);
    await this.saveState({ ...state, rounds, snapshots });
    return nextSnapshot;
  }

  async recordLocalQuery(): Promise<UsageSnapshot> {
    const state = await this.loadState();
    const next = this.snapshotAfterRound(state.snapshots, 'byok', true, {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });
    const snapshots = [next, ...state.snapshots].slice(0, this.historyLimit);
    await this.saveState({ ...state, snapshots });
    return next;
  }

  async recordTokens(mode: UsageMode, usage: LlmUsageInput): Promise<UsageSnapshot> {
    const state = await this.loadState();
    const current = this.snapshotForMode(state.snapshots, mode);
    const next: UsageSnapshot = {
      ...current,
      mode,
      promptTokens: current.promptTokens + normalizeTokens(usage.promptTokens),
      completionTokens: current.completionTokens + normalizeTokens(usage.completionTokens),
      totalTokens: current.totalTokens + normalizeTokens(usage.totalTokens),
    };
    const snapshots = [next, ...state.snapshots].slice(0, this.historyLimit);
    await this.saveState({ ...state, snapshots });
    return next;
  }

  private snapshotAfterRound(
    snapshots: UsageSnapshot[],
    mode: UsageMode,
    countCompletedRound: boolean,
    usage: LlmUsageInput,
  ): UsageSnapshot {
    const current = this.snapshotForMode(snapshots, mode);
    return {
      ...current,
      mode,
      completedRounds: current.completedRounds + (countCompletedRound ? 1 : 0),
      promptTokens: current.promptTokens + normalizeTokens(usage.promptTokens),
      completionTokens: current.completionTokens + normalizeTokens(usage.completionTokens),
      totalTokens: current.totalTokens + normalizeTokens(usage.totalTokens),
    };
  }

  private snapshotForMode(snapshots: UsageSnapshot[], mode: UsageMode): UsageSnapshot {
    return snapshots.find((item) => item.mode === mode) ?? this.zeroSnapshot(mode);
  }

  private zeroSnapshot(mode: UsageMode): UsageSnapshot {
    return {
      mode,
      windowStartedAt: this.now().toISOString(),
      completedRounds: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
  }

  private async loadState(): Promise<UsageState> {
    if (!this.historyPath) return structuredClone(this.memoryState);
    try {
      const raw = await readFile(this.historyPath, 'utf8');
      const parsed = JSON.parse(raw) as UsageState | UsageSnapshot[];
      if (Array.isArray(parsed)) {
        return { version: 1, snapshots: parsed, rounds: [] };
      }
      return {
        version: 1,
        snapshots: Array.isArray(parsed.snapshots) ? parsed.snapshots : [],
        rounds: Array.isArray(parsed.rounds) ? parsed.rounds : [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, snapshots: [], rounds: [] };
      throw error;
    }
  }

  private async saveState(state: UsageState): Promise<void> {
    if (!this.historyPath) {
      this.memoryState = structuredClone(state);
      return;
    }
    await mkdir(dirname(this.historyPath), { recursive: true });
    await writeFile(this.historyPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }
}

function normalizeTokens(value: number): number {
  return Math.max(0, Math.trunc(value));
}
