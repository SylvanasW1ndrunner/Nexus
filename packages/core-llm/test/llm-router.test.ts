import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UsageTracker } from '@dbagent/core-usage';
import { LlmRouter, type LlmChatStreamEvent, type LlmProvider } from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('LlmRouter', () => {
  it('keeps BYOK mode login-free', async () => {
    const router = new LlmRouter(new UsageTracker(await usagePath()));

    await expect(router.decide('byok')).resolves.toEqual({
      mode: 'byok',
      endpointDescription: 'User configured OpenAI-compatible endpoint',
      requiresLogin: false,
    });
  });

  it('routes subscription mode through the gateway contract', async () => {
    const router = new LlmRouter(new UsageTracker(await usagePath()));

    await expect(router.decide('subscription')).resolves.toEqual({
      mode: 'subscription',
      endpointDescription: 'DBAgent Gateway',
      requiresLogin: true,
    });
  });

  it('calls a registered provider and records BYOK token usage', async () => {
    const tracker = new UsageTracker(await usagePath());
    const router = new LlmRouter(tracker, [fakeProvider(37)]);

    const response = await router.chat('fake', {
      model: 'fake-model',
      messages: [{ role: 'user', content: '生成一个订单分析 SQL' }],
    });

    expect(response.text).toBe('ok');
    await expect(tracker.current()).resolves.toMatchObject({
      mode: 'byok',
      byokTokenEstimate: 37,
    });
  });

  it('attributes provider token usage to an active Agent round when provided', async () => {
    const tracker = new UsageTracker(await usagePath(), {
      now: () => new Date('2026-06-17T00:00:00.000Z'),
      createRoundId: () => 'round_router',
    });
    const round = await tracker.startConversationRound('session_router', 'byok');
    const router = new LlmRouter(tracker, [fakeProvider(37)]);

    await router.chat(
      'fake',
      {
        model: 'fake-model',
        messages: [{ role: 'user', content: '生成一个订单分析 SQL' }],
      },
      { round },
    );
    await tracker.endConversationRound(round, 'success');

    await expect(tracker.current()).resolves.toMatchObject({
      usedRounds: 1,
      byokTokenEstimate: 37,
    });
    await expect(tracker.roundHistory()).resolves.toMatchObject([
      {
        id: 'round_router',
        sessionId: 'session_router',
        totalTokens: 37,
        status: 'success',
      },
    ]);
  });

  it('does not count a provider failure as a completed Agent round', async () => {
    const tracker = new UsageTracker(await usagePath(), {
      now: () => new Date('2026-06-17T00:00:00.000Z'),
      createRoundId: () => 'round_failed_router',
    });
    const round = await tracker.startConversationRound('session_failed_router', 'byok');
    const router = new LlmRouter(tracker, [failingProvider()]);

    await expect(
      router.chat(
        'failing',
        {
          model: 'fake-model',
          messages: [{ role: 'user', content: 'ping' }],
        },
        { round },
      ),
    ).rejects.toThrow('provider timeout');
    await tracker.endConversationRound(round, 'failed', 'provider timeout');

    await expect(tracker.current()).resolves.toMatchObject({
      usedRounds: 0,
      byokTokenEstimate: 0,
    });
  });

  it('streams through providers and records final usage on the active Agent round', async () => {
    const tracker = new UsageTracker(await usagePath(), {
      now: () => new Date('2026-06-17T00:00:00.000Z'),
      createRoundId: () => 'round_stream_router',
    });
    const round = await tracker.startConversationRound('session_stream_router', 'byok');
    const router = new LlmRouter(tracker, [streamingProvider()]);

    const events = await collect(
      router.stream(
        'streaming',
        {
          model: 'fake-model',
          messages: [{ role: 'user', content: 'ping' }],
        },
        { round },
      ),
    );
    await tracker.endConversationRound(round, 'success');

    expect(events).toMatchObject([
      { type: 'text-delta', text: 'hello' },
      { type: 'usage', usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 } },
      { type: 'finish', response: { text: 'hello' } },
    ]);
    await expect(tracker.current()).resolves.toMatchObject({
      usedRounds: 1,
      byokTokenEstimate: 6,
    });
  });

  it('falls back to non-streaming chat when a provider has no stream implementation', async () => {
    const tracker = new UsageTracker(await usagePath());
    const router = new LlmRouter(tracker, [fakeProvider(9)]);

    const events = await collect(
      router.stream('fake', {
        model: 'fake-model',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    );

    expect(events).toMatchObject([
      { type: 'text-delta', text: 'ok' },
      { type: 'usage', usage: { totalTokens: 9 } },
      { type: 'finish', response: { text: 'ok' } },
    ]);
    await expect(tracker.current()).resolves.toMatchObject({ byokTokenEstimate: 9 });
  });

  it('fails clearly when provider is missing', async () => {
    const router = new LlmRouter(new UsageTracker(await usagePath()));

    await expect(
      router.chat('missing', {
        model: 'fake-model',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    ).rejects.toThrow('LLM provider is not registered: missing');
  });
});

async function usagePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-llm-router-'));
  tempDirs.push(dir);
  return join(dir, 'usage-history.json');
}

function fakeProvider(totalTokens: number): LlmProvider {
  return {
    id: 'fake',
    name: 'Fake Provider',
    mode: 'byok',
    async chat() {
      return {
        text: 'ok',
        toolCalls: [],
        usage: { promptTokens: totalTokens - 1, completionTokens: 1, totalTokens },
      };
    },
    async isAvailable() {
      return { available: true };
    },
  };
}

function failingProvider(): LlmProvider {
  return {
    id: 'failing',
    name: 'Failing Provider',
    mode: 'byok',
    async chat() {
      throw new Error('provider timeout');
    },
    async isAvailable() {
      return { available: true };
    },
  };
}

function streamingProvider(): LlmProvider {
  return {
    id: 'streaming',
    name: 'Streaming Provider',
    mode: 'byok',
    async chat() {
      throw new Error('chat fallback should not be used');
    },
    async *stream(): AsyncIterable<LlmChatStreamEvent> {
      yield { type: 'text-delta', text: 'hello' };
      yield { type: 'usage', usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 } };
      yield {
        type: 'finish',
        response: {
          text: 'hello',
          toolCalls: [],
          usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 },
        },
      };
    },
    async isAvailable() {
      return { available: true };
    },
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}
