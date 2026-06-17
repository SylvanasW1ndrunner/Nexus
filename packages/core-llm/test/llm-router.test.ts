import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UsageTracker } from '@dbagent/core-usage';
import { LlmRouter, type LlmProvider } from '../src/index.js';

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
