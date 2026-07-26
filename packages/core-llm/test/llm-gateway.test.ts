/* eslint-disable @typescript-eslint/require-await -- Provider test doubles implement async contracts. */
import { describe, expect, it } from 'vitest';
import {
  LlmGateway,
  LlmProviderError,
  sanitizeTelemetryEvent,
  type LlmChatRequest,
  type LlmChatStreamEvent,
  type LlmProvider,
} from '../src/index.js';

describe('LlmGateway', () => {
  it('falls back, estimates missing usage, accounts budget and emits a complete event trail', async () => {
    const gateway = new LlmGateway();
    gateway.registerProvider(failingProvider('primary'), [model('primary-model', 'advanced')]);
    gateway.registerProvider(successProvider('backup', undefined), [
      model('backup-model', 'balanced'),
    ]);

    const result = await gateway.execute({
      request: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 16 },
      context: { tenantId: 'tenant-a', userId: 'u1', taskType: 'diagnosis' },
      budget: { maxScopeTokens: 10_000, maxRequestTokens: 1_000 },
      maxRetries: 0,
      maxFallbacks: 1,
      maxStructuredCorrections: 0,
    });

    expect(result.providerId).toBe('backup');
    expect(result.attempts).toBe(2);
    expect(result.usage.totalTokens).toBeGreaterThan(0);
    expect(
      gateway.budget.snapshot({ tenantId: 'tenant-a', userId: 'u1', taskType: 'diagnosis' })
        .committedTokens,
    ).toBe(result.usage.totalTokens);
    const events = gateway.telemetry.list({ requestId: result.requestId });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'request.started',
        'route.decided',
        'provider.attempt',
        'provider.fallback',
        'request.completed',
      ]),
    );
    expect(events.at(0)?.type).toBe('request.started');
    expect(events.at(-1)?.type).toBe('request.completed');
  });

  it('corrects schema-invalid output within the configured bound and counts every token', async () => {
    let calls = 0;
    const provider: LlmProvider = {
      id: 'structured',
      name: 'structured',
      mode: 'managed',
      capabilities: { chat: 'supported', structuredOutput: 'supported' },
      async chat() {
        calls += 1;
        return {
          text: calls === 1 ? '{"sql":1}' : '{"sql":"select 1"}',
          toolCalls: [],
          usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
        };
      },
      async isAvailable() {
        return { available: true };
      },
    };
    const gateway = new LlmGateway();
    gateway.registerProvider(provider, [model('m', 'balanced', { structuredOutput: 'supported' })]);
    const result = await gateway.execute({
      providerId: 'structured',
      request: {
        model: 'm',
        messages: [{ role: 'user', content: 'sql' }],
        responseFormat: {
          type: 'json_schema',
          name: 'sql',
          schema: {
            type: 'object',
            properties: { sql: { type: 'string' } },
            required: ['sql'],
            additionalProperties: false,
          },
        },
      },
      context: { tenantId: 't', taskType: 'nl2sql' },
      maxRetries: 0,
      maxFallbacks: 0,
      maxStructuredCorrections: 1,
    });
    expect(calls).toBe(2);
    expect(result.usage).toEqual({
      promptTokens: 20,
      completionTokens: 4,
      totalTokens: 24,
      cachedPromptTokens: 0,
    });
    expect(
      gateway.telemetry.list({ requestId: result.requestId, type: 'provider.retry' }),
    ).toHaveLength(1);
  });

  it('isolates deterministic cache entries by tenant', async () => {
    let calls = 0;
    const provider = successProvider(
      'cache',
      { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      () => {
        calls += 1;
      },
    );
    const gateway = new LlmGateway();
    gateway.registerProvider(provider, [model('m', 'balanced')]);
    const base = {
      providerId: 'cache',
      request: {
        model: 'm',
        messages: [{ role: 'user' as const, content: 'same' }],
        temperature: 0,
      },
      maxRetries: 0,
      maxFallbacks: 0,
      cache: { enabled: true },
    };
    const first = await gateway.execute({ ...base, context: { tenantId: 'a', taskType: 'chat' } });
    const second = await gateway.execute({ ...base, context: { tenantId: 'a', taskType: 'chat' } });
    const third = await gateway.execute({ ...base, context: { tenantId: 'b', taskType: 'chat' } });
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(third.cacheHit).toBe(false);
    expect(calls).toBe(2);
  });

  it('isolates deterministic cache entries by provider', async () => {
    const gateway = new LlmGateway();
    gateway.registerProvider(textProvider('cache-a', 'from a'), [
      model('shared-model', 'balanced'),
    ]);
    gateway.registerProvider(textProvider('cache-b', 'from b'), [
      model('shared-model', 'balanced'),
    ]);
    const base = {
      request: {
        model: 'shared-model',
        messages: [{ role: 'user' as const, content: 'same' }],
        temperature: 0,
      },
      context: { tenantId: 'same-tenant', taskType: 'chat' },
      maxRetries: 0,
      maxFallbacks: 0,
      cache: { enabled: true },
    };

    const fromA = await gateway.execute({ ...base, providerId: 'cache-a' });
    const fromB = await gateway.execute({ ...base, providerId: 'cache-b' });

    expect(fromA.response.text).toBe('from a');
    expect(fromB.response.text).toBe('from b');
    expect(fromB.cacheHit).toBe(false);
  });

  it('reads a fallback cache entry only after the primary attempt fails', async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const primary = failingProvider('cache-primary');
    const originalPrimaryChat = primary.chat.bind(primary);
    primary.chat = async (request) => {
      primaryCalls += 1;
      return await originalPrimaryChat(request);
    };
    const fallback = textProvider('cache-fallback', 'fallback response', () => {
      fallbackCalls += 1;
    });
    const gateway = new LlmGateway();
    gateway.registerProvider(primary, [model('primary-model', 'advanced')]);
    gateway.registerProvider(fallback, [model('fallback-model', 'balanced')]);
    const input = {
      request: {
        messages: [{ role: 'user' as const, content: 'same fallback request' }],
        temperature: 0,
      },
      context: { tenantId: 'tenant-fallback', taskType: 'chat' },
      budget: { maxScopeTokens: 100_000, maxRequestTokens: 100_000 },
      maxRetries: 0,
      maxFallbacks: 1,
      cache: { enabled: true },
    };

    const first = await gateway.execute(input);
    const second = await gateway.execute(input);

    expect(first.providerId).toBe('cache-fallback');
    expect(first.modelId).toBe('cache-fallback:fallback-model');
    expect(second.cacheHit).toBe(true);
    expect(second.providerId).toBe('cache-fallback');
    expect(second.modelId).toBe('cache-fallback:fallback-model');
    expect(second.response.text).toBe('fallback response');
    expect(second.attempts).toBe(1);
    expect(primaryCalls).toBe(2);
    expect(fallbackCalls).toBe(1);
    expect(
      gateway.budget.snapshot({ tenantId: 'tenant-fallback', taskType: 'chat' }),
    ).toMatchObject({
      reservedTokens: 0,
      reservedCost: 0,
    });
  });

  it('does not let a fallback cache entry bypass a recovered primary provider', async () => {
    let primaryCalls = 0;
    let primaryHealthy = false;
    let fallbackCalls = 0;
    const primary: LlmProvider = {
      id: 'recovering-primary',
      name: 'recovering-primary',
      mode: 'managed',
      async chat() {
        primaryCalls += 1;
        if (!primaryHealthy) throw new LlmProviderError('LLM_TIMEOUT', 'timeout', true);
        return { text: 'primary recovered', toolCalls: [] };
      },
      async isAvailable() {
        return { available: true };
      },
    };
    const fallback = textProvider('recovering-fallback', 'cached fallback', () => {
      fallbackCalls += 1;
    });
    const gateway = new LlmGateway();
    gateway.registerProvider(primary, [model('primary-model', 'advanced')]);
    gateway.registerProvider(fallback, [model('fallback-model', 'balanced')]);
    const input = {
      request: {
        messages: [{ role: 'user' as const, content: 'retry primary first' }],
        temperature: 0,
      },
      context: { tenantId: 'tenant-recovery', taskType: 'chat' },
      maxRetries: 0,
      maxFallbacks: 1,
      cache: { enabled: true },
    };

    const first = await gateway.execute(input);
    primaryHealthy = true;
    const second = await gateway.execute(input);

    expect(first.providerId).toBe('recovering-fallback');
    expect(second.providerId).toBe('recovering-primary');
    expect(second.response.text).toBe('primary recovered');
    expect(second.cacheHit).toBe(false);
    expect(primaryCalls).toBe(2);
    expect(fallbackCalls).toBe(1);
  });

  it('never splices a fallback stream after visible output', async () => {
    let backupCalls = 0;
    const primary: LlmProvider = {
      id: 'stream-primary',
      name: 'stream-primary',
      mode: 'byok',
      capabilities: { chat: 'supported', streaming: 'supported' },
      async chat() {
        throw new Error('not used');
      },
      async *stream(): AsyncIterable<LlmChatStreamEvent> {
        yield { type: 'text-delta', text: 'partial' };
        throw new LlmProviderError('LLM_NETWORK_ERROR', 'stream broke', true);
      },
      async isAvailable() {
        return { available: true };
      },
    };
    const backup = successProvider('stream-backup', undefined, () => {
      backupCalls += 1;
    });
    const gateway = new LlmGateway();
    gateway.registerProvider(primary, [model('m1', 'advanced', { streaming: 'supported' })]);
    gateway.registerProvider(backup, [model('m2', 'balanced', { streaming: 'supported' })]);
    const received: string[] = [];
    await expect(
      (async () => {
        for await (const event of gateway.stream({
          request: { messages: [{ role: 'user', content: 'go' }] },
          context: { tenantId: 't', taskType: 'stream' },
          maxRetries: 0,
          maxFallbacks: 1,
        })) {
          if (event.type === 'text-delta') received.push(event.text);
        }
      })(),
    ).rejects.toMatchObject({ code: 'LLM_NETWORK_ERROR' });
    expect(received).toEqual(['partial']);
    expect(backupCalls).toBe(0);
  });

  it('propagates cancellation and records it as a terminal event', async () => {
    const provider: LlmProvider = {
      id: 'slow',
      name: 'slow',
      mode: 'byok',
      async chat(request: LlmChatRequest) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 5_000);
          request.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new LlmProviderError('LLM_ABORTED', 'cancelled', false));
            },
            { once: true },
          );
        });
        return { text: 'late', toolCalls: [] };
      },
      async isAvailable() {
        return { available: true };
      },
    };
    const gateway = new LlmGateway();
    gateway.registerProvider(provider, [model('m', 'balanced')]);
    const controller = new AbortController();
    const promise = gateway.execute({
      providerId: 'slow',
      request: {
        model: 'm',
        messages: [{ role: 'user', content: 'stop' }],
        signal: controller.signal,
      },
      context: { tenantId: 't', taskType: 'cancel' },
      maxRetries: 0,
      maxFallbacks: 0,
    });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: 'LLM_ABORTED' });
    expect(gateway.telemetry.list({ type: 'request.cancelled' })).toHaveLength(1);
  });

  it('redacts credentials from telemetry attributes', () => {
    const event = sanitizeTelemetryEvent({
      type: 'request.failed',
      timestamp: new Date(0).toISOString(),
      requestId: 'r',
      traceId: 'r',
      tenantHash: 'h',
      taskType: 'test',
      attributes: { apiKey: 'sk-secretsecret', detail: 'Authorization: Bearer abc.def.ghi' },
    });
    expect(event.attributes).not.toHaveProperty('apiKey');
    expect(event.attributes?.detail).not.toContain('abc.def.ghi');
  });

  it('runs and reports asynchronous batch jobs', async () => {
    const gateway = new LlmGateway();
    gateway.registerProvider(
      successProvider('batch', { promptTokens: 1, completionTokens: 1, totalTokens: 2 }),
      [model('m', 'balanced')],
    );
    const inputs = [1, 2, 3].map((value) => ({
      providerId: 'batch',
      request: { model: 'm', messages: [{ role: 'user' as const, content: String(value) }] },
      context: { tenantId: 't', taskType: 'batch' },
      maxRetries: 0,
      maxFallbacks: 0,
    }));
    const submitted = gateway.submitBatch(inputs, { concurrency: 2 });
    expect(submitted.status).toBe('queued');
    expect(gateway.getJob(submitted.id, 'other-tenant')).toBeUndefined();
    expect(gateway.cancelJob(submitted.id, 'other-tenant')).toBeUndefined();
    expect(gateway.listJobs('other-tenant')).toEqual([]);
    const finished = await waitForJob(gateway, submitted.id, 't');
    expect(finished.status).toBe('completed');
    expect(finished.completed).toBe(3);
    expect(gateway.listJobs('t')).toHaveLength(1);
  });

  it('rejects an asynchronous batch that mixes tenant ownership', () => {
    const gateway = new LlmGateway();
    gateway.registerProvider(
      successProvider('batch', { promptTokens: 1, completionTokens: 1, totalTokens: 2 }),
      [model('m', 'balanced')],
    );
    const input = (tenantId: string) => ({
      providerId: 'batch',
      request: { model: 'm', messages: [{ role: 'user' as const, content: tenantId }] },
      context: { tenantId, taskType: 'batch' },
      maxRetries: 0,
      maxFallbacks: 0,
    });

    expect(() => gateway.submitBatch([input('tenant-a'), input('tenant-b')])).toThrow(
      /same tenant/i,
    );
  });
});

function model(
  modelName: string,
  quality: 'economy' | 'balanced' | 'advanced',
  capabilities: Record<string, 'supported'> = {},
) {
  return {
    model: modelName,
    quality,
    capabilities,
    pricing: { currency: 'CNY' as const, inputPerMillionTokens: 1, outputPerMillionTokens: 2 },
  };
}

function failingProvider(id: string): LlmProvider {
  return {
    id,
    name: id,
    mode: 'managed',
    async chat() {
      throw new LlmProviderError('LLM_TIMEOUT', 'timeout', true);
    },
    async isAvailable() {
      return { available: true };
    },
  };
}

function successProvider(
  id: string,
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number },
  called?: () => void,
): LlmProvider {
  return {
    id,
    name: id,
    mode: 'managed',
    async chat() {
      called?.();
      return { text: 'ok', toolCalls: [], ...(usage === undefined ? {} : { usage }) };
    },
    async isAvailable() {
      return { available: true };
    },
  };
}

function textProvider(id: string, text: string, called?: () => void): LlmProvider {
  return {
    id,
    name: id,
    mode: 'managed',
    async chat() {
      called?.();
      return { text, toolCalls: [] };
    },
    async isAvailable() {
      return { available: true };
    },
  };
}

async function waitForJob(gateway: LlmGateway, id: string, tenantId: string) {
  for (let index = 0; index < 100; index += 1) {
    const job = gateway.getJob(id, tenantId);
    if (job && ['completed', 'failed', 'cancelled'].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('job did not finish');
}
