import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { redactPersistedAgentString, redactPersistedAgentValue } from './redaction.js';
import type {
  AgentContextCompressionReport,
  AgentPlanExecutionSnapshot,
  AgentPlanExecutionSnapshotStatus,
  AgentSession,
} from './types.js';

export type SaveAgentPlanExecutionSnapshotInput = {
  plan: AgentPlanExecutionSnapshot['plan'];
  status: AgentPlanExecutionSnapshotStatus;
  session?: AgentSession;
  finalText?: string;
  executedSteps?: number;
  totalIterations?: number;
  toolExecutions?: AgentPlanExecutionSnapshot['toolExecutions'];
  contextCompression?: AgentPlanExecutionSnapshot['contextCompression'];
  errorMessage?: string;
  now?: string;
};

export type AgentPlanExecutionWriter = {
  save(input: SaveAgentPlanExecutionSnapshotInput): Promise<AgentPlanExecutionSnapshot>;
};

export class AgentPlanExecutionStore implements AgentPlanExecutionWriter {
  constructor(private readonly filePath: string) {}

  async save(input: SaveAgentPlanExecutionSnapshotInput): Promise<AgentPlanExecutionSnapshot> {
    const now = input.now ?? new Date().toISOString();
    const snapshots = await this.readAll();
    const existingIndex = snapshots.findIndex((snapshot) => snapshot.planId === input.plan.id);
    const existing = existingIndex >= 0 ? snapshots[existingIndex] : undefined;
    const snapshot: AgentPlanExecutionSnapshot = {
      planId: input.plan.id,
      status: input.status,
      plan: redactPersistedAgentValue(input.plan) as AgentPlanExecutionSnapshot['plan'],
      finalText: redactPersistedAgentString(input.finalText ?? existing?.finalText ?? ''),
      executedSteps: input.executedSteps ?? existing?.executedSteps ?? 0,
      totalIterations: input.totalIterations ?? existing?.totalIterations ?? 0,
      toolExecutions: redactPersistedAgentValue(
        input.toolExecutions ?? existing?.toolExecutions ?? [],
      ) as AgentPlanExecutionSnapshot['toolExecutions'],
      createdAt: existing?.createdAt ?? input.plan.createdAt,
      updatedAt: now,
      ...(input.session === undefined
        ? existing?.session === undefined
          ? {}
          : { session: existing.session }
        : { session: redactPersistedAgentValue(input.session) as AgentSession }),
      ...(input.contextCompression === undefined
        ? existing?.contextCompression === undefined
          ? {}
          : { contextCompression: existing.contextCompression }
        : {
            contextCompression: redactPersistedAgentValue(
              input.contextCompression,
            ) as AgentContextCompressionReport[],
          }),
      ...(input.status === 'running' ? {} : { finishedAt: now }),
      ...(input.errorMessage === undefined
        ? existing?.errorMessage === undefined
          ? {}
          : { errorMessage: existing.errorMessage }
        : { errorMessage: redactPersistedAgentString(input.errorMessage) }),
    };

    const next =
      existingIndex >= 0
        ? snapshots.map((item, index) => (index === existingIndex ? snapshot : item))
        : [...snapshots, snapshot];
    await writeJsonFileAtomic(this.filePath, next);
    return snapshot;
  }

  async load(planId: string): Promise<AgentPlanExecutionSnapshot | undefined> {
    const snapshot = (await this.readAll()).find((item) => item.planId === planId);
    return snapshot ? cloneJson(snapshot) : undefined;
  }

  async listBySession(sessionId: string): Promise<AgentPlanExecutionSnapshot[]> {
    return (await this.readAll())
      .filter((snapshot) => snapshot.session?.id === sessionId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async listRecoverable(): Promise<AgentPlanExecutionSnapshot[]> {
    return (await this.readAll())
      .filter((snapshot) => snapshot.status === 'running')
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async markAbandoned(
    planId: string,
    reason = 'User abandoned recoverable Plan & Execute task.',
    now = new Date().toISOString(),
  ): Promise<boolean> {
    const snapshots = await this.readAll();
    let changed = false;
    const next = snapshots.map((snapshot) => {
      if (snapshot.planId !== planId || snapshot.status !== 'running') return snapshot;
      changed = true;
      return {
        ...snapshot,
        status: 'abandoned' as const,
        errorMessage: redactPersistedAgentString(reason),
        updatedAt: now,
        finishedAt: now,
      };
    });
    if (changed) await writeJsonFileAtomic(this.filePath, next);
    return changed;
  }

  private async readAll(): Promise<AgentPlanExecutionSnapshot[]> {
    return redactPersistedAgentValue(
      await readJsonFile<AgentPlanExecutionSnapshot[]>(this.filePath, []),
    ) as AgentPlanExecutionSnapshot[];
  }
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tempPath, filePath);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
