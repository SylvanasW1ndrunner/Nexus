import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AgentSession, AgentToolExecutionRecord } from './types.js';

export type AgentCheckpointStatus = 'running' | 'done' | 'aborted' | 'failed';

export type AgentIterationCheckpoint = {
  id: string;
  sessionId: string;
  iteration: number;
  status: AgentCheckpointStatus;
  session: AgentSession;
  toolExecutions: AgentToolExecutionRecord[];
  finalText: string;
  errorMessage?: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
};

export type SaveAgentCheckpointInput = {
  session: AgentSession;
  iteration: number;
  status: AgentCheckpointStatus;
  toolExecutions: AgentToolExecutionRecord[];
  finalText?: string;
  errorMessage?: string;
  now?: string;
};

export type AgentCheckpointWriter = {
  save(input: SaveAgentCheckpointInput): Promise<AgentIterationCheckpoint>;
};

export class AgentCheckpointStore implements AgentCheckpointWriter {
  constructor(private readonly filePath: string) {}

  async save(input: SaveAgentCheckpointInput): Promise<AgentIterationCheckpoint> {
    const now = input.now ?? new Date().toISOString();
    const checkpoints = await this.readAll();
    const existingIndex = checkpoints.findIndex(
      (item) => item.sessionId === input.session.id && item.iteration === input.iteration,
    );
    const existing = existingIndex >= 0 ? checkpoints[existingIndex] : undefined;
    const checkpoint: AgentIterationCheckpoint = {
      id: existing?.id ?? randomUUID(),
      sessionId: input.session.id,
      iteration: input.iteration,
      status: input.status,
      session: cloneJson(input.session),
      toolExecutions: cloneJson(input.toolExecutions),
      finalText: input.finalText ?? '',
      startedAt: existing?.startedAt ?? now,
      updatedAt: now,
      ...(input.status === 'running' ? {} : { finishedAt: now }),
      ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
    };

    const next =
      existingIndex >= 0
        ? checkpoints.map((item, index) => (index === existingIndex ? checkpoint : item))
        : [...checkpoints, checkpoint];
    await writeJsonFileAtomic(this.filePath, next);
    return checkpoint;
  }

  async listBySession(sessionId: string): Promise<AgentIterationCheckpoint[]> {
    return (await this.readAll()).filter((item) => item.sessionId === sessionId).sort(bySessionIteration);
  }

  async listRecoverable(): Promise<AgentIterationCheckpoint[]> {
    const latestBySession = new Map<string, AgentIterationCheckpoint>();
    for (const checkpoint of await this.readAll()) {
      const current = latestBySession.get(checkpoint.sessionId);
      if (!current || compareCheckpointRecency(checkpoint, current) > 0) {
        latestBySession.set(checkpoint.sessionId, checkpoint);
      }
    }
    return [...latestBySession.values()].filter((item) => item.status === 'running').sort(byUpdatedAtDesc);
  }

  async markInterrupted(sessionId: string, errorMessage: string, now = new Date().toISOString()): Promise<number> {
    const checkpoints = await this.readAll();
    let changed = 0;
    const next = checkpoints.map((checkpoint) => {
      if (checkpoint.sessionId !== sessionId || checkpoint.status !== 'running') return checkpoint;
      changed += 1;
      return {
        ...checkpoint,
        status: 'failed' as const,
        errorMessage,
        updatedAt: now,
        finishedAt: now,
      };
    });
    if (changed > 0) await writeJsonFileAtomic(this.filePath, next);
    return changed;
  }

  private async readAll(): Promise<AgentIterationCheckpoint[]> {
    return readJsonFile<AgentIterationCheckpoint[]>(this.filePath, []);
  }
}

function bySessionIteration(left: AgentIterationCheckpoint, right: AgentIterationCheckpoint): number {
  return left.iteration - right.iteration || left.updatedAt.localeCompare(right.updatedAt);
}

function byUpdatedAtDesc(left: AgentIterationCheckpoint, right: AgentIterationCheckpoint): number {
  return compareCheckpointRecency(right, left);
}

function compareCheckpointRecency(left: AgentIterationCheckpoint, right: AgentIterationCheckpoint): number {
  return left.updatedAt.localeCompare(right.updatedAt) || left.iteration - right.iteration;
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
