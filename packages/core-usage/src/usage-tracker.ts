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

export type QuotaStatus = {
  mode: UsageMode;
  windowStartedAt: string;
  windowEndsAt?: string;
  roundsUsed: number;
  roundLimit?: number;
  remainingRounds?: number;
  exceeded: boolean;
  byokTokenEstimate: number;
};

export type UsageTrackerOptions = {
  now?: () => Date;
  createRoundId?: () => string;
  subscriptionRoundLimit?: number;
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
  private readonly subscriptionRoundLimit: number | undefined;
  private readonly historyLimit: number;

  constructor(
    private readonly historyPath: string,
    options: UsageTrackerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.createRoundId = options.createRoundId ?? (() => crypto.randomUUID());
    this.subscriptionRoundLimit = options.subscriptionRoundLimit;
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

  async getCurrentQuota(mode: UsageMode = 'byok'): Promise<QuotaStatus> {
    const current = await this.currentForMode(mode);
    const roundLimit = mode === 'subscription' ? this.subscriptionRoundLimit : undefined;
    const remainingRounds = roundLimit === undefined ? undefined : Math.max(0, roundLimit - current.usedRounds);
    return {
      mode,
      windowStartedAt: current.windowStartedAt,
      ...(current.windowEndsAt === undefined ? {} : { windowEndsAt: current.windowEndsAt }),
      roundsUsed: current.usedRounds,
      ...(roundLimit === undefined ? {} : { roundLimit }),
      ...(remainingRounds === undefined ? {} : { remainingRounds }),
      exceeded: roundLimit !== undefined && current.usedRounds >= roundLimit,
      byokTokenEstimate: current.byokTokenEstimate,
    };
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

    const billable = status === 'success' || status === 'aborted';
    const nextSnapshot = this.snapshotAfterRound(state.snapshots, round.mode, billable, endedRound.totalTokens);
    const snapshots = [nextSnapshot, ...state.snapshots].slice(0, this.historyLimit);
    await this.saveState({ ...state, rounds, snapshots });
    return nextSnapshot;
  }

  async recordLocalQuery(): Promise<UsageSnapshot> {
    const state = await this.loadState();
    const next = this.snapshotAfterRound(state.snapshots, 'byok', true, 0);
    const snapshots = [next, ...state.snapshots].slice(0, this.historyLimit);
    await this.saveState({ ...state, snapshots });
    return next;
  }

  async recordByokTokens(tokenEstimate: number): Promise<UsageSnapshot> {
    const state = await this.loadState();
    const current = this.snapshotForMode(state.snapshots, 'byok');
    const next: UsageSnapshot = {
      ...current,
      mode: 'byok',
      byokTokenEstimate: current.byokTokenEstimate + Math.max(0, Math.trunc(tokenEstimate)),
    };
    const snapshots = [next, ...state.snapshots].slice(0, this.historyLimit);
    await this.saveState({ ...state, snapshots });
    return next;
  }

  private async currentForMode(mode: UsageMode): Promise<UsageSnapshot> {
    const state = await this.loadState();
    return this.snapshotForMode(state.snapshots, mode);
  }

  private snapshotAfterRound(
    snapshots: UsageSnapshot[],
    mode: UsageMode,
    billable: boolean,
    tokenEstimate: number,
  ): UsageSnapshot {
    const current = this.snapshotForMode(snapshots, mode);
    const roundLimit = mode === 'subscription' ? this.subscriptionRoundLimit : current.roundLimit;
    return {
      ...current,
      mode,
      usedRounds: current.usedRounds + (billable ? 1 : 0),
      byokTokenEstimate:
        mode === 'byok'
          ? current.byokTokenEstimate + Math.max(0, Math.trunc(tokenEstimate))
          : current.byokTokenEstimate,
      ...(roundLimit === undefined ? {} : { roundLimit }),
    };
  }

  private snapshotForMode(snapshots: UsageSnapshot[], mode: UsageMode): UsageSnapshot {
    return snapshots.find((item) => item.mode === mode) ?? this.zeroSnapshot(mode);
  }

  private zeroSnapshot(mode: UsageMode): UsageSnapshot {
    const roundLimit = mode === 'subscription' ? this.subscriptionRoundLimit : undefined;
    return {
      mode,
      windowStartedAt: this.now().toISOString(),
      usedRounds: 0,
      ...(roundLimit === undefined ? {} : { roundLimit }),
      byokTokenEstimate: 0,
    };
  }

  private async loadState(): Promise<UsageState> {
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
    await mkdir(dirname(this.historyPath), { recursive: true });
    await writeFile(this.historyPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }
}
