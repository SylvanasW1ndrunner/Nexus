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
      session: redactCheckpointValue(input.session) as AgentSession,
      toolExecutions: redactCheckpointValue(input.toolExecutions) as AgentToolExecutionRecord[],
      finalText: redactCheckpointString(input.finalText ?? ''),
      startedAt: existing?.startedAt ?? now,
      updatedAt: now,
      ...(input.status === 'running' ? {} : { finishedAt: now }),
      ...(input.errorMessage === undefined ? {} : { errorMessage: redactCheckpointString(input.errorMessage) }),
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
        errorMessage: redactCheckpointString(errorMessage),
        updatedAt: now,
        finishedAt: now,
      };
    });
    if (changed > 0) await writeJsonFileAtomic(this.filePath, next);
    return changed;
  }

  private async readAll(): Promise<AgentIterationCheckpoint[]> {
    const checkpoints = await readJsonFile<AgentIterationCheckpoint[]>(this.filePath, []);
    return redactCheckpointValue(checkpoints) as AgentIterationCheckpoint[];
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

const REDACTED = '[REDACTED]';
const SENSITIVE_KEY_PATTERN =
  /^(?:access[_-]?token|api[_-]?key|authorization|bearer|connection[_-]?string|credential|credentials|database[_-]?url|db[_-]?url|dsn|password|passwd|pwd|refresh[_-]?token|secret|session[_-]?token|token)$/i;

type StringReplacement = string | ((match: string, ...groups: string[]) => string);

const STRING_REDACTIONS: Array<[RegExp, StringReplacement]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`],
  [/\bsk-[A-Za-z0-9_-]{8,}/gi, `sk-${REDACTED}`],
  [
    /\b(postgres(?:ql)?|mysql|mariadb):\/\/([^:\s/@]+):([^@\s]+)@/gi,
    (_match, protocol: string, user: string) => `${protocol}://${user}:${REDACTED}@`,
  ],
  [
    /(["']?(?:api[_-]?key|authorization|connection[_-]?string|credential|database[_-]?url|db[_-]?url|dsn|password|passwd|pwd|secret|session[_-]?token|token)["']?\s*[:=]\s*["'])([^"',}\s]+)(["']?)/gi,
    `$1${REDACTED}$3`,
  ],
];

function redactCheckpointValue(value: unknown): unknown {
  if (typeof value === 'string') return redactCheckpointString(value);
  if (Array.isArray(value)) return value.map((item) => redactCheckpointValue(item));
  if (!value || typeof value !== 'object') return value;

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactCheckpointValue(child);
  }
  return output;
}

function redactCheckpointString(value: string): string {
  return STRING_REDACTIONS.reduce((text, [pattern, replacement]) => {
    return typeof replacement === 'string' ? text.replace(pattern, replacement) : text.replace(pattern, replacement);
  }, value);
}
