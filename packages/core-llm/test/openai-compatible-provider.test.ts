import { describe, expect, it, vi } from 'vitest';
import {
  createSiliconFlowProvider,
  LlmProviderError,
  OpenAICompatibleProvider,
} from '../src/index.js';

type TestFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

describe('OpenAICompatibleProvider', () => {
  it('sends OpenAI-compatible chat requests and parses text usage', async () => {
    const fetchMock = vi.fn<TestFetch>(() =>
      Promise.resolve(jsonResponse(200, {
        id: 'chatcmpl_test',
        model: 'deepseek-ai/DeepSeek-V4-Pro',
        choices: [{ message: { content: '查询结果说明' } }],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      })),
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
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://example.test/v1/chat/completions');
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer test-key',
      'content-type': 'application/json',
    });
    const body = parseFetchBody(fetchMock);
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
      fetch: () =>
        Promise.resolve(jsonResponse(200, {
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
        })),
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

  it('streams text deltas, usage, and final response from OpenAI-compatible SSE', async () => {
    const fetchMock = vi.fn<TestFetch>(() =>
      Promise.resolve(streamResponse([
        sse({ id: 'chatcmpl_stream', model: 'deepseek-ai/DeepSeek-V4-Pro', choices: [{ delta: { content: '查询' } }] }),
        sse({ id: 'chatcmpl_stream', model: 'deepseek-ai/DeepSeek-V4-Pro', choices: [{ delta: { content: '正常' } }] }),
        sse({
          id: 'chatcmpl_stream',
          model: 'deepseek-ai/DeepSeek-V4-Pro',
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }),
        'data: [DONE]\n\n',
      ])),
    );
    const provider = new OpenAICompatibleProvider({
      id: 'test',
      name: 'Test Provider',
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      fetch: fetchMock,
    });

    const events = await collect(
      provider.stream({
        model: 'deepseek-ai/DeepSeek-V4-Pro',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    );

    expect(events).toMatchObject([
      { type: 'text-delta', text: '查询' },
      { type: 'text-delta', text: '正常' },
      { type: 'usage', usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } },
      {
        type: 'finish',
        reason: 'stop',
        response: {
          text: '查询正常',
          usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
          providerResponseId: 'chatcmpl_stream',
          model: 'deepseek-ai/DeepSeek-V4-Pro',
        },
      },
    ]);
    const body = parseFetchBody(fetchMock);
    expect(body).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it('streams fragmented tool calls and reconstructs final JSON arguments', async () => {
    const provider = new OpenAICompatibleProvider({
      id: 'test',
      name: 'Test Provider',
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      fetch: () =>
        Promise.resolve(streamResponse([
          sse({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_stream',
                      type: 'function',
                      function: { name: 'query_database', arguments: '{"sql":"select ' },
                    },
                  ],
                },
              },
            ],
          }),
          sse({
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: 'count(*) from orders"}' } }],
                },
              },
            ],
          }),
          'data: [DONE]\n\n',
        ])),
    });

    const events = await collect(
      provider.stream({
        model: 'deepseek-ai/DeepSeek-V4-Pro',
        messages: [{ role: 'user', content: '查订单数' }],
        tools: [
          {
            name: 'query_database',
            description: 'Execute readonly SQL',
            inputSchema: { type: 'object' },
          },
        ],
      }),
    );

    expect(events).toMatchObject([
      {
        type: 'tool-call-delta',
        index: 0,
        id: 'call_stream',
        name: 'query_database',
        argumentsDelta: '{"sql":"select ',
      },
      {
        type: 'tool-call-delta',
        index: 0,
        argumentsDelta: 'count(*) from orders"}',
      },
      {
        type: 'finish',
        response: {
          text: '',
          toolCalls: [
            {
              id: 'call_stream',
              name: 'query_database',
              arguments: { sql: 'select count(*) from orders' },
            },
          ],
        },
      },
    ]);
  });

  it('classifies auth failures as non-retryable', async () => {
    const fetchMock = vi.fn<TestFetch>(() =>
      Promise.resolve(jsonResponse(401, { error: { message: 'invalid api key' } })),
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
      retryDelayBaseMs: 1,
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

  it('does not retry user-aborted chat requests or report them as timeouts', async () => {
    const abortController = new AbortController();
    abortController.abort();
    const fetchMock = vi.fn<TestFetch>((_input: string | URL, init?: RequestInit) => {
      if (init?.signal instanceof AbortSignal && init.signal.aborted) {
        return Promise.reject(new DOMException('aborted', 'AbortError'));
      }
      return Promise.resolve(jsonResponse(200, { choices: [{ message: { content: 'should not happen' } }] }));
    });
    const provider = new OpenAICompatibleProvider({
      id: 'test',
      name: 'Test Provider',
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      maxRetries: 2,
      retryDelayBaseMs: 1,
      fetch: fetchMock,
    });

    await expect(
      provider.chat({
        model: 'deepseek-ai/DeepSeek-V4-Pro',
        messages: [{ role: 'user', content: 'ping' }],
        signal: abortController.signal,
      }),
    ).rejects.toMatchObject({
      code: 'LLM_ABORTED',
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops retry backoff immediately when the user aborts', async () => {
    const abortController = new AbortController();
    const fetchMock = vi.fn<TestFetch>(() => Promise.resolve(jsonResponse(503, { error: { message: 'busy' } })));
    const provider = new OpenAICompatibleProvider({
      id: 'test',
      name: 'Test Provider',
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      maxRetries: 2,
      retryDelayBaseMs: 10_000,
      fetch: fetchMock,
    });

    const promise = provider.chat({
      model: 'deepseek-ai/DeepSeek-V4-Pro',
      messages: [{ role: 'user', content: 'ping' }],
      signal: abortController.signal,
    });
    setTimeout(() => abortController.abort(), 5);

    await expect(promise).rejects.toMatchObject({
      code: 'LLM_ABORTED',
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries initial stream connection failures before yielding events', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: { message: 'rate limit' } }))
      .mockResolvedValueOnce(
        streamResponse([sse({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }), 'data: [DONE]\n\n']),
      );
    const provider = new OpenAICompatibleProvider({
      id: 'test',
      name: 'Test Provider',
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      maxRetries: 1,
      retryDelayBaseMs: 1,
      fetch: fetchMock,
    });

    const events = await collect(
      provider.stream({
        model: 'deepseek-ai/DeepSeek-V4-Pro',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events).toMatchObject([
      { type: 'text-delta', text: 'ok' },
      { type: 'finish', reason: 'stop', response: { text: 'ok' } },
    ]);
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
  const apiKey = process.env.TEST_SILICONFLOW_API_KEY ?? process.env.DBAGENT_LLM_API_KEY;
  const model = process.env.TEST_SILICONFLOW_MODEL ?? 'deepseek-ai/DeepSeek-V4-Pro';

  it.skipIf(!runLive || !apiKey)(
    'calls DeepSeek-V4-Pro through the configured SiliconFlow API key',
    async () => {
      const provider = createSiliconFlowProvider({ apiKey: apiKey!, timeoutMs: 60_000 });

      const response = await provider.chat({
        model,
        messages: [{ role: 'user', content: '只回答四个字：连接正常' }],
        maxTokens: 16,
        temperature: 0,
      });

      expect(response.text.length).toBeGreaterThan(0);
      expect(response.usage?.totalTokens ?? 0).toBeGreaterThan(0);
    },
    90_000,
  );

  it.skipIf(!runLive || !apiKey)(
    'streams DeepSeek-V4-Pro through the configured SiliconFlow API key',
    async () => {
      const provider = createSiliconFlowProvider({ apiKey: apiKey!, timeoutMs: 60_000 });

      const events = await collect(
        provider.stream({
          model,
          messages: [{ role: 'user', content: '只回答四个字：流式正常' }],
          maxTokens: 16,
          temperature: 0,
        }),
      );

      expect(events.some((event) => event.type === 'text-delta')).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: 'finish' });
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

function streamResponse(chunks: string[]): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

function sse(body: unknown): string {
  return `data: ${JSON.stringify(body)}\n\n`;
}

function parseFetchBody(fetchMock: ReturnType<typeof vi.fn<TestFetch>>, callIndex = 0): Record<string, unknown> {
  const body = fetchMock.mock.calls[callIndex]?.[1]?.body;
  if (body === undefined) throw new Error(`Missing request body for fetch call ${callIndex}.`);
  if (typeof body !== 'string') throw new Error(`Expected string request body for fetch call ${callIndex}.`);
  const parsed: unknown = JSON.parse(body);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Expected JSON object request body for fetch call ${callIndex}.`);
  }
  return parsed as Record<string, unknown>;
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}
