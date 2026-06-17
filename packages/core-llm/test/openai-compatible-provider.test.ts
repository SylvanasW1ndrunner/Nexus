import { describe, expect, it, vi } from 'vitest';
import {
  createSiliconFlowProvider,
  LlmProviderError,
  OpenAICompatibleProvider,
} from '../src/index.js';

describe('OpenAICompatibleProvider', () => {
  it('sends OpenAI-compatible chat requests and parses text usage', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        id: 'chatcmpl_test',
        model: 'deepseek-ai/DeepSeek-V4-Pro',
        choices: [{ message: { content: '查询结果说明' } }],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      }),
    );
    const provider = new OpenAICompatibleProvider({
      id: 'test',
      name: 'Test Provider',
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1/',
      fetch: fetchMock,
    });

    const response = await provider.chat({
      model: 'deepseek-ai/DeepSeek-V4-Pro',
      messages: [{ role: 'user', content: '解释订单表' }],
      temperature: 0.1,
      maxTokens: 128,
    });

    expect(response).toEqual({
      text: '查询结果说明',
      toolCalls: [],
      usage: { promptTokens: 12, completionTokens: 8, totalTokens: 20 },
      providerResponseId: 'chatcmpl_test',
      model: 'deepseek-ai/DeepSeek-V4-Pro',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.test/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer test-key',
          'content-type': 'application/json',
        }),
      }),
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      model: 'deepseek-ai/DeepSeek-V4-Pro',
      messages: [{ role: 'user', content: '解释订单表' }],
      temperature: 0.1,
      max_tokens: 128,
    });
  });

  it('parses function tool calls with JSON arguments', async () => {
    const provider = new OpenAICompatibleProvider({
      id: 'test',
      name: 'Test Provider',
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      fetch: async () =>
        jsonResponse(200, {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: {
                      name: 'query_database',
                      arguments: '{"sql":"select * from orders limit 10"}',
                    },
                  },
                ],
              },
            },
          ],
        }),
    });

    await expect(
      provider.chat({
        model: 'deepseek-ai/DeepSeek-V4-Pro',
        messages: [{ role: 'user', content: '查订单' }],
        tools: [
          {
            name: 'query_database',
            description: 'Execute readonly SQL',
            inputSchema: { type: 'object', properties: { sql: { type: 'string' } } },
          },
        ],
      }),
    ).resolves.toMatchObject({
      text: '',
      toolCalls: [
        {
          id: 'call_1',
          name: 'query_database',
          arguments: { sql: 'select * from orders limit 10' },
        },
      ],
    });
  });

  it('classifies auth failures as non-retryable', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(401, { error: { message: 'invalid api key' } }),
    );
    const provider = new OpenAICompatibleProvider({
      id: 'test',
      name: 'Test Provider',
      apiKey: 'bad-key',
      baseUrl: 'https://example.test/v1',
      maxRetries: 2,
      fetch: fetchMock,
    });

    await expect(
      provider.chat({
        model: 'deepseek-ai/DeepSeek-V4-Pro',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    ).rejects.toMatchObject({
      code: 'LLM_AUTH_FAILED',
      retryable: false,
      statusCode: 401,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries retryable provider failures', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { error: { message: 'busy' } }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          choices: [{ message: { content: 'ok' } }],
        }),
      );
    const provider = new OpenAICompatibleProvider({
      id: 'test',
      name: 'Test Provider',
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      maxRetries: 1,
      fetch: fetchMock,
    });

    await expect(
      provider.chat({
        model: 'deepseek-ai/DeepSeek-V4-Pro',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    ).resolves.toMatchObject({ text: 'ok' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('exposes a SiliconFlow OpenAI-compatible provider preset', () => {
    const provider = createSiliconFlowProvider({ apiKey: 'test-key' });

    expect(provider.id).toBe('siliconflow');
    expect(provider.name).toBe('SiliconFlow');
    expect(provider.mode).toBe('byok');
  });

  it('rejects an empty api key before making network calls', () => {
    expect(
      () =>
        new OpenAICompatibleProvider({
          id: 'test',
          name: 'Test Provider',
          apiKey: ' ',
          baseUrl: 'https://example.test/v1',
        }),
    ).toThrow(LlmProviderError);
  });
});

describe('SiliconFlow live integration', () => {
  const runLive = process.env.DBAGENT_RUN_LLM_INTEGRATION === '1';
  const apiKey = process.env.DBAGENT_LLM_API_KEY;

  it.skipIf(!runLive || !apiKey)(
    'calls DeepSeek-V4-Pro through the configured SiliconFlow API key',
    async () => {
      const provider = createSiliconFlowProvider({ apiKey: apiKey!, timeoutMs: 60_000 });

      const response = await provider.chat({
        model: 'deepseek-ai/DeepSeek-V4-Pro',
        messages: [{ role: 'user', content: '只回答四个字：连接正常' }],
        maxTokens: 16,
        temperature: 0,
      });

      expect(response.text.length).toBeGreaterThan(0);
      expect(response.usage?.totalTokens ?? 0).toBeGreaterThan(0);
    },
    90_000,
  );
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
