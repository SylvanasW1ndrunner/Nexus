/* eslint-disable @typescript-eslint/require-await -- Provider test doubles implement async contracts. */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LlmChatStreamEvent, LlmProvider } from '@dbagent/core-llm';
import { DatabaseAgentRuntime } from '@dbagent/sdk';
import { startDatabaseAgentServer } from '../src/server.js';

const servers: Server[] = [];
const runtimes: DatabaseAgentRuntime[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe('LLM product entrypoints', () => {
  it('provides the same chat, stream and async behavior through the TypeScript SDK', async () => {
    const runtime = await createRuntime('sdk-tenant');
    const chat = await runtime.llmChat({ messages: [{ role: 'user', content: 'hello' }] });
    expect(chat).toMatchObject({ text: 'echo:hello', usage: { totalTokens: 3 } });

    const events = [];
    for await (const event of runtime.llmStream({
      messages: [{ role: 'user', content: 'stream' }],
    }))
      events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'finish', response: { text: 'streamed' } });

    const submitted = runtime.submitLlmBatch([
      { messages: [{ role: 'user', content: 'one' }] },
      { messages: [{ role: 'user', content: 'two' }] },
    ]);
    const job = await waitForJob(() => runtime.getLlmJob(submitted.id));
    expect(job).toMatchObject({ status: 'completed', completed: 2, failed: 0 });
    expect(runtime.llmModels()).toHaveLength(1);
    expect(runtime.llmMetrics().completed).toBeGreaterThanOrEqual(4);
  });

  it('exposes model catalog, metrics, chat, SSE stream and jobs through REST', async () => {
    const runtime = await createRuntime('rest-tenant');
    const started = await startDatabaseAgentServer({ runtime, port: 0 });
    servers.push(started.server);

    const models = await getJson(`${started.url}/v1/llm/models`);
    expect(models).toEqual([
      expect.objectContaining({ providerId: 'entrypoint', model: 'test-model' }),
    ]);

    const chat = await postJson(`${started.url}/v1/llm/chat`, {
      messages: [{ role: 'user', content: 'rest' }],
      taskType: 'api-contract',
    });
    expect(chat).toMatchObject({ text: 'echo:rest' });

    const streamResponse = await fetch(`${started.url}/v1/llm/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'stream' }] }),
    });
    const streamText = await streamResponse.text();
    expect(streamResponse.headers.get('content-type')).toContain('text/event-stream');
    expect(streamText).toContain('event: text-delta');
    expect(streamText).toContain('event: finish');

    const submitted = await postJson(`${started.url}/v1/llm/jobs`, {
      requests: [
        { messages: [{ role: 'user', content: 'one' }] },
        { messages: [{ role: 'user', content: 'two' }] },
      ],
      concurrency: 2,
    });
    const jobId = String((submitted as { id?: unknown }).id);
    const job = await waitForJob(async () => getJson(`${started.url}/v1/llm/jobs/${jobId}`));
    expect(job).toMatchObject({ status: 'completed', completed: 2 });

    const metrics = await getJson(`${started.url}/v1/llm/metrics`);
    if (!metrics || typeof metrics !== 'object')
      throw new Error('Metrics response must be an object.');
    expect(typeof (metrics as Record<string, unknown>).requests).toBe('number');
    expect(typeof (metrics as Record<string, unknown>).completed).toBe('number');
  });
});

async function createRuntime(tenantId: string): Promise<DatabaseAgentRuntime> {
  const directory = await mkdtemp(join(tmpdir(), 'schemanaut-llm-entrypoints-'));
  temporaryDirectories.push(directory);
  const runtime = new DatabaseAgentRuntime({
    provider: provider(),
    model: 'test-model',
    tenantId,
    sessionDatabasePath: join(directory, 'sessions.db'),
  });
  runtimes.push(runtime);
  return runtime;
}

function provider(): LlmProvider {
  return {
    id: 'entrypoint',
    name: 'entrypoint',
    mode: 'managed',
    capabilities: { chat: 'supported', streaming: 'supported', toolCalling: 'supported' },
    async chat(request) {
      const content = request.messages.at(-1)?.content ?? '';
      return {
        text: `echo:${content}`,
        toolCalls: [],
        usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
      };
    },
    async *stream(): AsyncIterable<LlmChatStreamEvent> {
      yield { type: 'text-delta', text: 'streamed' };
      const response = {
        text: 'streamed',
        toolCalls: [],
        usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
      };
      yield { type: 'usage', usage: response.usage };
      yield { type: 'finish', response };
    },
    async isAvailable() {
      return { available: true, latencyMs: 1 };
    },
  };
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.status).toBeLessThan(400);
  return await response.json();
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  expect(response.status).toBeLessThan(400);
  return await response.json();
}

async function waitForJob<T>(read: () => T | Promise<T>): Promise<T> {
  for (let index = 0; index < 100; index += 1) {
    const value = await read();
    if (value && typeof value === 'object' && 'status' in value) {
      const status = (value as { status?: unknown }).status;
      if (status === 'completed' || status === 'failed' || status === 'cancelled') return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('LLM job did not reach a terminal state.');
}
