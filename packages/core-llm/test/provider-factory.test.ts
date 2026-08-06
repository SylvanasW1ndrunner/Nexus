import { describe, expect, it } from 'vitest';
import {
  AnthropicProvider,
  OllamaProvider,
  OpenAICompatibleProvider,
  OpenAIResponsesProvider,
  createLlmProvider,
} from '../src/index.js';

describe('createLlmProvider', () => {
  it('selects native adapters instead of treating every endpoint as OpenAI Chat', () => {
    expect(
      createLlmProvider({
        protocol: 'openai-chat',
        id: 'chat',
        name: 'Chat',
        baseUrl: 'https://example.test/v1',
        apiKey: 'secret',
      }),
    ).toBeInstanceOf(OpenAICompatibleProvider);
    expect(
      createLlmProvider({
        protocol: 'openai-responses',
        id: 'responses',
        name: 'Responses',
        baseUrl: 'https://example.test/v1',
        apiKey: 'secret',
      }),
    ).toBeInstanceOf(OpenAIResponsesProvider);
    expect(
      createLlmProvider({
        protocol: 'anthropic',
        id: 'anthropic',
        name: 'Anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'secret',
      }),
    ).toBeInstanceOf(AnthropicProvider);
    expect(
      createLlmProvider({
        protocol: 'ollama',
        id: 'ollama',
        name: 'Ollama',
        baseUrl: 'http://127.0.0.1:11434',
      }),
    ).toBeInstanceOf(OllamaProvider);
    expect(
      createLlmProvider({
        protocol: 'vllm',
        id: 'vllm',
        name: 'vLLM',
        baseUrl: 'http://127.0.0.1:8000/v1',
      }),
    ).toBeInstanceOf(OpenAICompatibleProvider);
  });
});
