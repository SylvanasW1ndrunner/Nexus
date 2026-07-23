/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-argument -- Async controller callbacks and Vitest asymmetric matchers are intentional. */
import { describe, expect, it } from 'vitest';
import {
  LlmBudgetController,
  LlmModelRegistry,
  LlmReliabilityController,
  type LlmProvider,
} from '../src/index.js';

describe('reliability and budget controls', () => {
  it('enforces concurrency, queue bounds and releases queued work in order', async () => {
    const controller = new LlmReliabilityController();
    controller.configure('p', {
      maxConcurrency: 1,
      maxQueueSize: 1,
      maxQueueWaitMs: 1_000,
    });
    let releaseFirst!: () => void;
    const first = controller.execute('p', async () => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      return 1;
    });
    await Promise.resolve();
    const second = controller.execute('p', async () => 2);
    await Promise.resolve();
    await expect(controller.execute('p', async () => 3)).rejects.toMatchObject({ code: 'LLM_QUEUE_FULL' });
    expect(controller.snapshot('p')).toMatchObject({ active: 1, queued: 1 });
    releaseFirst();
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(controller.snapshot('p')).toMatchObject({ active: 0, queued: 0 });
  });

  it('opens, half-opens and recovers a provider circuit deterministically', async () => {
    let now = 1_000;
    const controller = new LlmReliabilityController(() => now);
    controller.configure('p', { failureThreshold: 2, circuitResetMs: 100 });
    expect(controller.recordFailure('p')).toBe(false);
    expect(controller.recordFailure('p')).toBe(true);
    expect(controller.snapshot('p').state).toBe('open');
    await expect(controller.lease('p')).rejects.toMatchObject({ code: 'LLM_CIRCUIT_OPEN' });
    now += 101;
    await expect(controller.lease('p', AbortSignal.abort())).rejects.toMatchObject({ code: 'LLM_ABORTED' });
    const release = await controller.lease('p');
    expect(controller.snapshot('p').state).toBe('half-open');
    release();
    controller.recordSuccess('p');
    expect(controller.snapshot('p')).toMatchObject({ state: 'closed', consecutiveFailures: 0 });
  });

  it('enforces local token-rate limits before provider execution', async () => {
    const controller = new LlmReliabilityController();
    controller.configure('p', { tokensPerMinute: 100, maxQueueWaitMs: 10 });
    await expect(controller.execute('p', async () => 'should-not-run', undefined, 101)).rejects.toMatchObject({
      code: 'LLM_RATE_LIMITED',
    });
  });

  it('does not execute a provider after the local request-rate limit is exhausted', async () => {
    const controller = new LlmReliabilityController();
    controller.configure('p', { requestsPerMinute: 1, maxQueueWaitMs: 10 });
    let calls = 0;
    await controller.execute('p', async () => ++calls);
    await expect(controller.execute('p', async () => ++calls)).rejects.toMatchObject({
      code: 'LLM_RATE_LIMITED',
    });
    expect(calls).toBe(1);
  });

  it('rejects known budget overruns before a provider call and commits exact configured cost', () => {
    const registry = new LlmModelRegistry();
    registry.registerProvider(provider());
    const model = registry.registerModel({
      providerId: 'p',
      model: 'm',
      pricing: { currency: 'CNY', inputPerMillionTokens: 2, outputPerMillionTokens: 10 },
    });
    const budget = new LlmBudgetController();
    expect(() =>
      budget.reserve({
        scope: { tenantId: 't' },
        limits: { maxRequestTokens: 100 },
        model,
        estimatedInputTokens: 80,
        maxOutputTokens: 30,
      }),
    ).toThrowError(expect.objectContaining({ code: 'LLM_BUDGET_EXCEEDED' }));
    const reservation = budget.reserve({
      scope: { tenantId: 't' },
      limits: { maxRequestCost: 1 },
      model,
      estimatedInputTokens: 1_000,
      maxOutputTokens: 100,
    });
    const snapshot = budget.commit(reservation.id, model, {
      promptTokens: 1_000,
      completionTokens: 100,
      totalTokens: 1_100,
    });
    expect(snapshot.committedCost).toBe(0.003);
    expect(snapshot.reservedCost).toBe(0);
  });
});

function provider(): LlmProvider {
  return {
    id: 'p',
    name: 'p',
    mode: 'managed',
    async chat() {
      return { text: 'ok', toolCalls: [] };
    },
    async isAvailable() {
      return { available: true };
    },
  };
}
