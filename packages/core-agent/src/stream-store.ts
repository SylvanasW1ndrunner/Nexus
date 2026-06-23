import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { LlmChatResponse, LlmChatStreamEvent, LlmToolCall, LlmUsage } from '@dbagent/core-llm';
import { redactPersistedAgentString, redactPersistedAgentValue } from './redaction.js';

export type AgentStreamStatus = 'streaming' | 'complete' | 'incomplete' | 'failed' | 'aborted';

export type AgentStreamChunk = {
  sequence: number;
  event: LlmChatStreamEvent;
  createdAt: string;
};

export type AgentStreamRecord = {
  id: string;
  sessionId: string;
  roundId?: string;
  providerId: string;
  model: string;
  status: AgentStreamStatus;
  text: string;
  toolCalls: LlmToolCall[];
  usage?: LlmUsage;
  finalResponse?: LlmChatResponse;
  errorMessage?: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  chunks: AgentStreamChunk[];
};

export type StartAgentStreamInput = {
  id?: string;
  sessionId: string;
  roundId?: string;
  providerId: string;
  model: string;
  now?: string;
};

export class AgentStreamStore {
  constructor(private readonly filePath: string) {}

  async start(input: StartAgentStreamInput): Promise<AgentStreamRecord> {
    const now = input.now ?? new Date().toISOString();
    const records = await this.readAll();
    const record: AgentStreamRecord = {
      id: input.id ?? randomUUID(),
      sessionId: input.sessionId,
      providerId: input.providerId,
      model: input.model,
      status: 'streaming',
      text: '',
      toolCalls: [],
      startedAt: now,
      updatedAt: now,
      chunks: [],
      ...(input.roundId === undefined ? {} : { roundId: input.roundId }),
    };
    await writeJsonFileAtomic(this.filePath, [...records.filter((item) => item.id !== record.id), record]);
    return record;
  }

  async appendEvent(streamId: string, event: LlmChatStreamEvent, now = new Date().toISOString()): Promise<AgentStreamRecord> {
    const records = await this.readAll();
    const index = records.findIndex((item) => item.id === streamId);
    if (index < 0) throw new Error(`Agent stream does not exist: ${streamId}`);

    const current = records[index]!;
    const redactedEvent = redactPersistedAgentValue(event) as LlmChatStreamEvent;
    const next = applyEvent(current, redactedEvent, now);
    await writeJsonFileAtomic(this.filePath, records.map((item, itemIndex) => (itemIndex === index ? next : item)));
    return next;
  }

  async markIncomplete(streamId: string, errorMessage: string, now = new Date().toISOString()): Promise<AgentStreamRecord> {
    return this.mark(streamId, 'incomplete', errorMessage, now);
  }

  async markFailed(streamId: string, errorMessage: string, now = new Date().toISOString()): Promise<AgentStreamRecord> {
    return this.mark(streamId, 'failed', errorMessage, now);
  }

  async markAborted(streamId: string, errorMessage = '用户中止 Agent 流式响应', now = new Date().toISOString()): Promise<AgentStreamRecord> {
    return this.mark(streamId, 'aborted', errorMessage, now);
  }

  async load(streamId: string): Promise<AgentStreamRecord | undefined> {
    return (await this.readAll()).find((item) => item.id === streamId);
  }

  async listBySession(sessionId: string): Promise<AgentStreamRecord[]> {
    return (await this.readAll())
      .filter((item) => item.sessionId === sessionId)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id));
  }

  async listRecoverable(): Promise<AgentStreamRecord[]> {
    return (await this.readAll())
      .filter((item) => item.status === 'streaming' || item.status === 'incomplete')
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private async mark(
    streamId: string,
    status: Exclude<AgentStreamStatus, 'streaming' | 'complete'>,
    errorMessage: string,
    now: string,
  ): Promise<AgentStreamRecord> {
    const records = await this.readAll();
    const index = records.findIndex((item) => item.id === streamId);
    if (index < 0) throw new Error(`Agent stream does not exist: ${streamId}`);
    const next: AgentStreamRecord = {
      ...records[index]!,
      status,
      errorMessage: redactPersistedAgentString(errorMessage),
      updatedAt: now,
      finishedAt: now,
    };
    await writeJsonFileAtomic(this.filePath, records.map((item, itemIndex) => (itemIndex === index ? next : item)));
    return next;
  }

  private async readAll(): Promise<AgentStreamRecord[]> {
    const records = await readJsonFile<AgentStreamRecord[]>(this.filePath, []);
    return redactPersistedAgentValue(records) as AgentStreamRecord[];
  }
}

export async function* persistAgentStreamEvents(
  store: AgentStreamStore,
  streamId: string,
  events: AsyncIterable<LlmChatStreamEvent>,
  now: () => string = () => new Date().toISOString(),
): AsyncIterable<LlmChatStreamEvent> {
  try {
    for await (const event of events) {
      await store.appendEvent(streamId, event, now());
      yield event;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isUserAbort(error)) {
      await store.markAborted(streamId, message, now());
    } else {
      await store.markIncomplete(streamId, message, now());
    }
    throw error;
  }
}

function applyEvent(record: AgentStreamRecord, event: LlmChatStreamEvent, now: string): AgentStreamRecord {
  const chunk: AgentStreamChunk = {
    sequence: record.chunks.length + 1,
    event,
    createdAt: now,
  };
  const base = {
    ...record,
    updatedAt: now,
    chunks: [...record.chunks, chunk],
  };

  if (event.type === 'text-delta') {
    return { ...base, text: `${record.text}${event.text}` };
  }
  if (event.type === 'tool-call') {
    return { ...base, toolCalls: [...record.toolCalls, event.toolCall] };
  }
  if (event.type === 'usage') {
    return { ...base, usage: event.usage };
  }
  if (event.type === 'finish') {
    return {
      ...base,
      status: 'complete',
      text: event.response.text,
      toolCalls: event.response.toolCalls,
      ...(event.response.usage === undefined ? {} : { usage: event.response.usage }),
      finalResponse: event.response,
      finishedAt: now,
    };
  }
  return base;
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

function isUserAbort(error: unknown): boolean {
  if (typeof error === 'object' && error && 'code' in error && String(error.code) === 'LLM_ABORTED') return true;
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  return error instanceof Error && error.name === 'AbortError';
}
