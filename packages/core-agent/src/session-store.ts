import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AgentMode, AgentSession } from './types.js';

export type AgentSessionSummary = {
  id: string;
  title: string;
  mode: AgentMode;
  strategy: AgentSession['strategy'];
  archived: boolean;
  messageCount: number;
  toolMessageCount: number;
  tokenUsage: AgentSession['tokenUsage'];
  createdAt: string;
  updatedAt: string;
  lastMessageAt?: string;
};

export type AgentSessionListFilter = {
  archived?: boolean;
  query?: string;
  limit?: number;
  offset?: number;
};

export type AgentSessionExportFormat = 'json' | 'markdown';

export type SaveAgentSessionInput = {
  session: AgentSession;
  now?: string;
};

export type AgentSessionWriter = {
  save(input: SaveAgentSessionInput): Promise<AgentSessionSummary>;
};

type AgentSessionRecord = {
  session: AgentSession;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};

export class AgentSessionStore implements AgentSessionWriter {
  constructor(private readonly filePath: string) {}

  async save(input: SaveAgentSessionInput): Promise<AgentSessionSummary> {
    const now = input.now ?? new Date().toISOString();
    const records = await this.readAll();
    const existingIndex = records.findIndex((record) => record.session.id === input.session.id);
    const existing = existingIndex >= 0 ? records[existingIndex] : undefined;
    const record: AgentSessionRecord = {
      session: cloneJson(input.session),
      archived: existing?.archived ?? false,
      createdAt: existing?.createdAt ?? firstMessageAt(input.session) ?? now,
      updatedAt: now,
    };
    const next =
      existingIndex >= 0 ? records.map((item, index) => (index === existingIndex ? record : item)) : [...records, record];
    await writeJsonFileAtomic(this.filePath, next);
    return summarize(record);
  }

  async load(id: string): Promise<AgentSession | undefined> {
    const record = (await this.readAll()).find((item) => item.session.id === id);
    return record ? cloneJson(record.session) : undefined;
  }

  async list(filter: AgentSessionListFilter = {}): Promise<AgentSessionSummary[]> {
    const archived = filter.archived ?? false;
    const query = filter.query?.trim().toLowerCase();
    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? 100;
    if (!Number.isInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer.');
    if (!Number.isInteger(limit) || limit <= 0) throw new Error('limit must be a positive integer.');
    const records = (await this.readAll())
      .filter((record) => record.archived === archived)
      .filter((record) => {
        if (!query) return true;
        return [record.session.title, ...record.session.messages.map((message) => message.content)]
          .join('\n')
          .toLowerCase()
          .includes(query);
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return records.slice(offset, offset + limit).map(summarize);
  }

  async update(
    id: string,
    patch: Partial<Pick<AgentSession, 'title' | 'mode' | 'aborted'>>,
    now = new Date().toISOString(),
  ): Promise<AgentSessionSummary> {
    const records = await this.readAll();
    const index = records.findIndex((record) => record.session.id === id);
    if (index < 0) throw new Error(`Agent session not found: ${id}`);
    const current = records[index]!;
    const nextRecord: AgentSessionRecord = {
      ...current,
      session: { ...current.session, ...patch },
      updatedAt: now,
    };
    await writeJsonFileAtomic(
      this.filePath,
      records.map((record, recordIndex) => (recordIndex === index ? nextRecord : record)),
    );
    return summarize(nextRecord);
  }

  async archive(id: string, archived = true, now = new Date().toISOString()): Promise<AgentSessionSummary> {
    const records = await this.readAll();
    const index = records.findIndex((record) => record.session.id === id);
    if (index < 0) throw new Error(`Agent session not found: ${id}`);
    const nextRecord = { ...records[index]!, archived, updatedAt: now };
    await writeJsonFileAtomic(
      this.filePath,
      records.map((record, recordIndex) => (recordIndex === index ? nextRecord : record)),
    );
    return summarize(nextRecord);
  }

  async delete(id: string): Promise<boolean> {
    const records = await this.readAll();
    const next = records.filter((record) => record.session.id !== id);
    if (next.length === records.length) return false;
    await writeJsonFileAtomic(this.filePath, next);
    return true;
  }

  async fork(input: {
    id: string;
    fromMessageIndex: number;
    newId?: string;
    title?: string;
    now?: string;
  }): Promise<AgentSession> {
    const session = await this.load(input.id);
    if (!session) throw new Error(`Agent session not found: ${input.id}`);
    if (input.fromMessageIndex < 0 || input.fromMessageIndex >= session.messages.length) {
      throw new Error(`Invalid fork message index: ${input.fromMessageIndex}`);
    }
    const now = input.now ?? new Date().toISOString();
    const forked: AgentSession = {
      ...session,
      id: input.newId ?? randomUUID(),
      title: input.title ?? `${session.title} (fork)`,
      messages: cloneJson(session.messages.slice(0, input.fromMessageIndex + 1)),
      aborted: false,
    };
    await this.save({ session: forked, now });
    return forked;
  }

  async export(id: string, format: AgentSessionExportFormat): Promise<string> {
    const session = await this.load(id);
    if (!session) throw new Error(`Agent session not found: ${id}`);
    if (format === 'json') return `${JSON.stringify(session, null, 2)}\n`;
    return markdownSession(session);
  }

  private async readAll(): Promise<AgentSessionRecord[]> {
    return readJsonFile<AgentSessionRecord[]>(this.filePath, []);
  }
}

function summarize(record: AgentSessionRecord): AgentSessionSummary {
  const messages = record.session.messages;
  const lastMessageAt = messages.at(-1)?.createdAt;
  return {
    id: record.session.id,
    title: record.session.title,
    mode: record.session.mode,
    strategy: record.session.strategy,
    archived: record.archived,
    messageCount: messages.length,
    toolMessageCount: messages.filter((message) => message.role === 'tool').length,
    tokenUsage: record.session.tokenUsage,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(lastMessageAt === undefined ? {} : { lastMessageAt }),
  };
}

function firstMessageAt(session: AgentSession): string | undefined {
  return session.messages[0]?.createdAt;
}

function markdownSession(session: AgentSession): string {
  const lines = [`# ${session.title}`, '', `- Session ID: ${session.id}`, `- Mode: ${session.mode}`, ''];
  for (const message of session.messages) {
    lines.push(`## ${message.role} - ${message.createdAt}`);
    lines.push('');
    lines.push(message.content);
    lines.push('');
    if (message.role === 'assistant' && message.toolCalls?.length) {
      lines.push(`Tool calls: ${message.toolCalls.map((tool) => tool.name).join(', ')}`);
      lines.push('');
    }
    if (message.role === 'tool') {
      lines.push(`Tool: ${message.toolName}`);
      lines.push('');
    }
  }
  return `${lines.join('\n')}\n`;
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
