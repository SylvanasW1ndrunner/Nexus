/* eslint-disable @typescript-eslint/require-await -- Provider test doubles implement async contracts. */
import { describe, expect, it } from 'vitest';
import { LlmGateway, LlmProviderError, type LlmProvider } from '../../src/index.js';

describe('LLM fault injection', () => {
  it('uses a healthy fallback after timeout without exceeding retry bounds', async () => {
    let primaryCalls = 0;
    let backupCalls = 0;
    const gateway = new LlmGateway();
    gateway.registerProvider(failing('primary', () => (primaryCalls += 1)), [
      { model: 'primary', quality: 'advanced' },
    ]);
    gateway.registerProvider(healthy('backup', () => (backupCalls += 1)), [
      { model: 'backup', quality: 'balanced' },
    ]);
    const result = await gateway.execute({
      request: { messages: [{ role: 'user', content: 'diagnose' }], maxTokens: 8 },
      context: { tenantId: 'fault', taskType: 'fault-injection' },
      maxRetries: 1,
      maxFallbacks: 1,
      allowCrossProviderFallbacks: true,
    });
    expect(result.providerId).toBe('backup');
    expect(primaryCalls).toBe(2);
    expect(backupCalls).toBe(1);
    expect(result.attempts).toBe(3);
  });

  it('opens the circuit and removes a repeatedly failing provider from live attempts', async () => {
    let calls = 0;
    const gateway = new LlmGateway();
    gateway.registerProvider(failing('primary', () => (calls += 1)), [{ model: 'm' }]);
    gateway.configureReliability('primary', { failureThreshold: 2, circuitResetMs: 60_000 });
    const input = {
      providerId: 'primary',
      request: { model: 'm', messages: [{ role: 'user' as const, content: 'x' }] },
      context: { tenantId: 'fault', taskType: 'circuit' },
      maxRetries: 0,
      maxFallbacks: 0,
    };
    await expect(gateway.execute(input)).rejects.toBeInstanceOf(LlmProviderError);
    await expect(gateway.execute(input)).rejects.toBeInstanceOf(LlmProviderError);
    expect(gateway.reliability.snapshot('primary').state).toBe('open');
    await expect(gateway.execute(input)).rejects.toMatchObject({ code: 'LLM_CIRCUIT_OPEN' });
    expect(calls).toBe(2);
  });
});

function failing(id: string, called: () => void): LlmProvider {
  return {
    id,
    name: id,
    mode: 'managed',
    async chat() {
      called();
      throw new LlmProviderError('LLM_TIMEOUT', 'injected timeout', true);
    },
    async isAvailable() {
      return { available: true };
    },
  };
}

function healthy(id: string, called: () => void): LlmProvider {
  return {
    id,
    name: id,
    mode: 'managed',
    async chat() {
      called();
      return { text: 'recovered', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    },
    async isAvailable() {
      return { available: true };
    },
  };
}
