import { describe, expect, it } from 'vitest';
import { LlmProviderError, type LlmProvider } from '../../src/index.js';
import { runProviderContractSuite } from './provider-contract-suite.js';

describe('provider contract suite', () => {
  it('accepts a provider only when generation, usage and cancellation share the public contract', async () => {
    const report = await runProviderContractSuite(provider(true), {
      model: 'contract-model',
      requireUsage: true,
    });
    expect(report).toMatchObject({
      ok: true,
      usage: { ok: true },
      cancellation: { ok: true },
      generation: { ok: true },
    });
  });

  it('fails a provider that silently omits required token usage', async () => {
    const report = await runProviderContractSuite(provider(false), {
      model: 'contract-model',
      requireUsage: true,
    });
    expect(report.ok).toBe(false);
    expect(report.usage).toMatchObject({ ok: false });
  });
});

function provider(withUsage: boolean): LlmProvider {
  return {
    id: 'contract-provider',
    name: 'Contract provider',
    mode: 'private',
    capabilities: { chat: 'supported' },
    chat(request) {
      if (request.signal?.aborted) {
        return Promise.reject(new LlmProviderError('LLM_ABORTED', 'cancelled', false));
      }
      return Promise.resolve({
        text: 'READY',
        toolCalls: [],
        ...(withUsage
          ? { usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 } }
          : {}),
      });
    },
    isAvailable() {
      return Promise.resolve({ available: true, latencyMs: 1 });
    },
  };
}
