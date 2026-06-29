import { describe, expect, it } from 'vitest';
import { probeLlmProviderCapabilities, type LlmChatStreamEvent, type LlmProvider } from '../src/index.js';

describe('probeLlmProviderCapabilities', () => {
  it('verifies availability, chat, tool calling, and streaming support', async () => {
    const result = await probeLlmProviderCapabilities(healthyProvider(), {
      model: 'deepseek-ai/DeepSeek-V4-Pro',
      checkToolCalling: true,
      checkStreaming: true,
    });

    expect(result).toMatchObject({
      providerId: 'fake',
      model: 'deepseek-ai/DeepSeek-V4-Pro',
      ok: true,
      available: { ok: true },
      chat: { ok: true, text: 'READY' },
      toolCalling: { ok: true },
      streaming: { ok: true, textDeltaCount: 1 },
    });
  });

  it('returns structured failures without throwing so settings checks can show actionable diagnostics', async () => {
    const result = await probeLlmProviderCapabilities(partialFailureProvider(), {
      model: 'bad-model',
      checkToolCalling: true,
      checkStreaming: true,
    });

    expect(result.ok).toBe(false);
    expect(result.available).toMatchObject({ ok: false, detail: 'endpoint unavailable' });
    expect(result.chat).toMatchObject({ ok: false, detail: 'Provider returned an empty chat response.' });
    expect(result.toolCalling).toMatchObject({ ok: false, detail: 'Provider did not call dbagent_probe_echo.' });
    expect(result.streaming).toMatchObject({ ok: false, detail: 'Provider does not implement streaming.' });
  });
});

function healthyProvider(): LlmProvider {
  return {
    id: 'fake',
    name: 'Fake Provider',
    mode: 'byok',
    chat(request) {
      if (request.tools?.some((tool) => tool.name === 'dbagent_probe_echo')) {
        return Promise.resolve({
          text: '',
          toolCalls: [{ id: 'tool_probe', name: 'dbagent_probe_echo', arguments: { value: 'ok' } }],
        });
      }
      return Promise.resolve({ text: 'READY', toolCalls: [] });
    },
    async *stream(): AsyncIterable<LlmChatStreamEvent> {
      await Promise.resolve();
      yield { type: 'text-delta', text: 'STREAM_READY' };
      yield { type: 'finish', response: { text: 'STREAM_READY', toolCalls: [] } };
    },
    isAvailable() {
      return Promise.resolve({ available: true });
    },
  };
}

function partialFailureProvider(): LlmProvider {
  return {
    id: 'partial',
    name: 'Partial Provider',
    mode: 'byok',
    chat() {
      return Promise.resolve({ text: '', toolCalls: [] });
    },
    isAvailable() {
      return Promise.resolve({ available: false, detail: 'endpoint unavailable' });
    },
  };
}
