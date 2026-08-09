/* eslint-disable @typescript-eslint/require-await -- Fetch test doubles implement async contracts. */
import { describe, expect, it } from 'vitest';
import {
  AnthropicProvider,
  OllamaProvider,
  OpenAICompatibleProvider,
  type LlmChatStreamEvent,
} from '../src/index.js';

describe('provider adapters beyond basic connectivity', () => {
  it('preserves OpenAI assistant tool calls and tool results in native message fields', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const provider = new OpenAICompatibleProvider({
      id: 'relay',
      name: 'Compatible relay',
      baseUrl: 'https://relay.example/v1',
      apiKey: 'test-key',
      fetch: async (_input, init) => {
        requestBody = JSON.parse(requireStringBody(init?.body)) as Record<string, unknown>;
        return jsonResponse({
          id: 'response-2',
          choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
        });
      },
    });

    await provider.chat({
      model: 'vendor/model',
      messages: [
        { role: 'user', content: 'count orders' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: 'call-17',
              name: 'query_database',
              arguments: { sql: 'select count(*) from orders' },
            },
          ],
        },
        {
          role: 'tool',
          name: 'query_database',
          toolCallId: 'call-17',
          content: '{"rows":[{"count":12}]}',
        },
      ],
      topP: 0.8,
    });

    expect(requestBody).toMatchObject({
      top_p: 0.8,
      messages: [
        { role: 'user', content: 'count orders' },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call-17',
              type: 'function',
              function: {
                name: 'query_database',
                arguments: '{"sql":"select count(*) from orders"}',
              },
            },
          ],
        },
        {
          role: 'tool',
          name: 'query_database',
          tool_call_id: 'call-17',
          content: '{"rows":[{"count":12}]}',
        },
      ],
    });
  });

  it('maps Anthropic tool_use and consecutive tool_result blocks without flattening them to text', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const provider = new AnthropicProvider({
      apiKey: 'anthropic-test-key',
      fetch: async (_input, init) => {
        requestBody = JSON.parse(requireStringBody(init?.body)) as Record<string, unknown>;
        return jsonResponse({
          id: 'msg_2',
          content: [{ type: 'text', text: 'done' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 2 },
        });
      },
    });

    await provider.chat({
      model: 'claude-test',
      messages: [
        { role: 'user', content: 'inspect both tables' },
        {
          role: 'assistant',
          content: 'I will inspect them.',
          toolCalls: [
            { id: 'tool-a', name: 'query', arguments: { sql: 'select 1' } },
            { id: 'tool-b', name: 'query', arguments: { sql: 'select 2' } },
          ],
        },
        { role: 'tool', toolCallId: 'tool-a', name: 'query', content: '{"value":1}' },
        {
          role: 'tool',
          toolCallId: 'tool-b',
          name: 'query',
          content: 'permission denied',
          toolResult: { isError: true },
        },
      ],
      topP: 0.7,
    });

    expect(requestBody).toMatchObject({
      top_p: 0.7,
      messages: [
        { role: 'user', content: 'inspect both tables' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will inspect them.' },
            { type: 'tool_use', id: 'tool-a', name: 'query', input: { sql: 'select 1' } },
            { type: 'tool_use', id: 'tool-b', name: 'query', input: { sql: 'select 2' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tool-a', content: '{"value":1}' },
            {
              type: 'tool_result',
              tool_use_id: 'tool-b',
              content: 'permission denied',
              is_error: true,
            },
          ],
        },
      ],
    });
  });

  it('rejects textual pseudo tool calls once instead of accepting them as a final answer', async () => {
    let fetchCount = 0;
    const provider = new OpenAICompatibleProvider({
      id: 'relay',
      name: 'Compatible relay',
      baseUrl: 'https://relay.example/v1',
      apiKey: 'test-key',
      fetch: async () => {
        fetchCount += 1;
        return jsonResponse({
          choices: [
            {
              message: {
                content:
                  '<tool_calls>[{"name":"query_database","arguments":{"sql":"select 1"}}]</tool_calls>',
              },
              finish_reason: 'stop',
            },
          ],
        });
      },
    });

    await expect(
      provider.chat({
        model: 'vendor/model',
        messages: [{ role: 'user', content: 'run select 1' }],
        tools: [
          {
            name: 'query_database',
            description: 'Run SQL',
            inputSchema: { type: 'object' },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'TOOL_PROTOCOL_MISMATCH', retryable: false });
    expect(fetchCount).toBe(1);
  });

  it('rejects a known requested tool serialized as plain JSON text', async () => {
    const provider = new OpenAICompatibleProvider({
      id: 'relay',
      name: 'Compatible relay',
      baseUrl: 'https://relay.example/v1',
      apiKey: 'test-key',
      fetch: async () =>
        jsonResponse({
          choices: [
            {
              message: {
                content: '{"name":"lookup_metric","arguments":{"name":"orders"}}',
              },
              finish_reason: 'stop',
            },
          ],
        }),
    });

    await expect(
      provider.chat({
        model: 'vendor/model',
        messages: [{ role: 'user', content: 'read the orders metric' }],
        tools: [
          {
            name: 'lookup_metric',
            description: 'Return one named metric.',
            inputSchema: { type: 'object' },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'TOOL_PROTOCOL_MISMATCH', retryable: false });
  });

  it('preserves ordinary JSON that does not name a requested tool', async () => {
    const content = '{"name":"report","arguments":{"format":"json"}}';
    const provider = new OpenAICompatibleProvider({
      id: 'relay',
      name: 'Compatible relay',
      baseUrl: 'https://relay.example/v1',
      apiKey: 'test-key',
      fetch: async () =>
        jsonResponse({ choices: [{ message: { content }, finish_reason: 'stop' }] }),
    });

    await expect(
      provider.chat({
        model: 'vendor/model',
        messages: [{ role: 'user', content: 'return a report descriptor' }],
        tools: [
          {
            name: 'lookup_metric',
            description: 'Return one named metric.',
            inputSchema: { type: 'object' },
          },
        ],
      }),
    ).resolves.toMatchObject({ text: content, toolCalls: [] });
  });

  it('maps structured chat, models, embedding and rerank on OpenAI-compatible endpoints', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const provider = new OpenAICompatibleProvider({
      id: 'local',
      name: 'Local vLLM',
      baseUrl: 'http://127.0.0.1:8000/v1',
      allowUnauthenticated: true,
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, ...(init === undefined ? {} : { init }) });
        if (url.endsWith('/models')) return jsonResponse({ data: [{ id: 'chat' }, { id: 'embed' }] });
        if (url.endsWith('/embeddings')) {
          return jsonResponse({
            model: 'embed',
            data: [
              { index: 1, embedding: [0, 1] },
              { index: 0, embedding: [1, 0] },
            ],
            usage: { prompt_tokens: 4, total_tokens: 4 },
          });
        }
        if (url.endsWith('/rerank')) {
          return jsonResponse({ model: 'rerank', results: [{ index: 1, relevance_score: 0.99 }] });
        }
        return jsonResponse({
          id: 'r1',
          model: 'chat',
          choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        });
      },
    });

    const chat = await provider.chat({
      model: 'chat',
      messages: [{ role: 'user', content: 'json' }],
      responseFormat: {
        type: 'json_schema',
        name: 'answer',
        schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      },
      reasoning: { effort: 'high' },
      seed: 7,
      stop: ['END'],
    });
    const models = await provider.listModels();
    const embedding = await provider.embed({ model: 'embed', input: ['a', 'b'] });
    const rerank = await provider.rerank({ model: 'rerank', query: 'b', documents: ['a', 'b'], topN: 1 });

    expect(chat).toMatchObject({ text: '{"ok":true}', finishReason: 'stop', usage: { totalTokens: 5 } });
    expect(models).toEqual(['chat', 'embed']);
    expect(embedding.embeddings).toEqual([[1, 0], [0, 1]]);
    expect(embedding.usage?.totalTokens).toBe(4);
    expect(rerank.results).toEqual([{ index: 1, score: 0.99 }]);
    const chatBody = JSON.parse(requireStringBody(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(chatBody).toMatchObject({ reasoning_effort: 'high', seed: 7, stop: ['END'] });
    expect(chatBody.response_format).toMatchObject({ type: 'json_schema' });
    expect(new Headers(calls[0]?.init?.headers).has('authorization')).toBe(false);
  });

  it('discovers Ollama model capabilities from metadata without generating a message', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const provider = new OllamaProvider({
      id: 'ollama-fixture',
      name: 'Ollama fixture',
      baseUrl: 'http://127.0.0.1:11434',
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, method: init?.method ?? 'GET' });
        if (url.endsWith('/api/tags')) {
          return jsonResponse({ models: [{ model: 'qwen2.5-coder:14b' }] });
        }
        if (url.endsWith('/api/show')) {
          return jsonResponse({
            capabilities: ['completion', 'tools', 'insert'],
            details: {
              family: 'qwen2',
              parameter_size: '14.8B',
              quantization_level: 'Q4_K_M',
            },
            model_info: {
              'qwen2.context_length': 32_768,
              'qwen2.embedding_length': 5_120,
            },
          });
        }
        throw new Error(`Unexpected metadata URL: ${url}`);
      },
    });

    await expect(provider.isAvailable('qwen2.5-coder:14b')).resolves.toMatchObject({ available: true });
    await expect(provider.getModelMetadata('qwen2.5-coder:14b')).resolves.toMatchObject({
      model: 'qwen2.5-coder:14b',
      source: 'provider-api',
      capabilities: {
        chat: 'supported',
        toolCalling: 'supported',
        reasoning: 'unsupported',
        embeddings: 'unsupported',
      },
      contextTokens: 32_768,
      family: 'qwen2',
      parameterSize: '14.8B',
      quantization: 'Q4_K_M',
    });
    expect(calls).toEqual([
      { url: 'http://127.0.0.1:11434/api/tags', method: 'GET' },
      { url: 'http://127.0.0.1:11434/api/show', method: 'POST' },
    ]);
    expect(calls.some((call) => call.url.includes('/chat/completions'))).toBe(false);
  });

  it('normalizes native Ollama NDJSON streaming text, tools, usage and finish', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const provider = new OllamaProvider({
      fetch: async (_input, init) => {
        requestBody = JSON.parse(requireStringBody(init?.body)) as Record<string, unknown>;
        return new Response(
          ndjsonStream([
            { model: 'qwen:14b', message: { role: 'assistant', content: 'hello ' }, done: false },
            {
              model: 'qwen:14b',
              message: {
                role: 'assistant',
                content: 'world',
                tool_calls: [{ function: { name: 'query', arguments: { sql: 'select 1' } } }],
              },
              done: false,
            },
            {
              model: 'qwen:14b',
              message: { role: 'assistant', content: '' },
              done: true,
              done_reason: 'stop',
              prompt_eval_count: 5,
              eval_count: 3,
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/x-ndjson' } },
        );
      },
    });

    const events: LlmChatStreamEvent[] = [];
    for await (const event of provider.stream({
      model: 'qwen:14b',
      messages: [{ role: 'user', content: 'query' }],
      tools: [
        {
          name: 'query',
          description: 'Run SQL',
          inputSchema: { type: 'object', properties: { sql: { type: 'string' } } },
        },
      ],
    })) {
      events.push(event);
    }

    expect(requestBody).toMatchObject({ stream: true, model: 'qwen:14b' });
    expect(events).toEqual(
      expect.arrayContaining([
        { type: 'text-delta', text: 'hello ' },
        { type: 'text-delta', text: 'world' },
        { type: 'usage', usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 } },
      ]),
    );
    const toolCallEvent = events.find((event) => event.type === 'tool-call');
    if (!toolCallEvent || toolCallEvent.type !== 'tool-call') {
      throw new Error('Expected an Ollama tool-call event.');
    }
    expect(toolCallEvent.toolCall).toMatchObject({
      name: 'query',
      arguments: { sql: 'select 1' },
    });
    const finishEvent = events.at(-1);
    if (!finishEvent || finishEvent.type !== 'finish') {
      throw new Error('Expected an Ollama finish event.');
    }
    expect(finishEvent.response.text).toBe('hello world');
    expect(finishEvent.response.toolCalls[0]?.name).toBe('query');
    expect(finishEvent.response.finishReason).toBe('stop');
  });

  it('discovers context and output limits from an OpenAI-compatible model catalog', async () => {
    const calls: string[] = [];
    const provider = new OpenAICompatibleProvider({
      id: 'relay',
      name: 'Compatible relay',
      baseUrl: 'https://relay.example/v1',
      apiKey: 'test-key',
      fetch: async (input) => {
        calls.push(String(input));
        return jsonResponse({
          data: [
            {
              id: 'vendor/model-large',
              context_length: 131_072,
              max_output_tokens: 8_192,
              capabilities: { tool_calling: true, reasoning: true },
              supported_parameters: ['temperature', 'top_p', 'max_tokens', 'stop'],
            },
          ],
        });
      },
    });

    await expect(provider.listModels()).resolves.toEqual(['vendor/model-large']);
    await expect(provider.getModelMetadata('vendor/model-large')).resolves.toMatchObject({
      model: 'vendor/model-large',
      source: 'provider-api',
      contextTokens: 131_072,
      maxOutputTokens: 8_192,
      capabilities: {
        toolCalling: 'supported',
        reasoning: 'supported',
      },
      generationParameters: {
        temperature: 'supported',
        topP: 'supported',
        maxOutputTokens: 'supported',
        seed: 'unsupported',
        stop: 'supported',
        reasoningEffort: 'unsupported',
      },
    });
    expect(calls).toEqual(['https://relay.example/v1/models']);
  });

  it('maps the native Anthropic message and tool protocol', async () => {
    let requestBody: Record<string, unknown> | undefined;
    let requestHeaders: Headers | undefined;
    const provider = new AnthropicProvider({
      apiKey: 'anthropic-test-key',
      fetch: async (_input, init) => {
        requestBody = JSON.parse(requireStringBody(init?.body)) as Record<string, unknown>;
        requestHeaders = new Headers(init?.headers);
        return jsonResponse({
          id: 'msg_1',
          model: 'claude-test',
          content: [
            { type: 'text', text: 'checking' },
            { type: 'tool_use', id: 'tool_1', name: 'query', input: { sql: 'select 1' } },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 9, output_tokens: 4 },
        });
      },
    });
    const response = await provider.chat({
      model: 'claude-test',
      messages: [
        { role: 'system', content: 'You are a DBA.' },
        { role: 'user', content: 'check' },
      ],
      tools: [
        {
          name: 'query',
          description: 'Run query',
          inputSchema: { type: 'object', properties: { sql: { type: 'string' } } },
        },
      ],
      maxTokens: 100,
    });
    expect(response).toMatchObject({
      text: 'checking',
      toolCalls: [{ id: 'tool_1', name: 'query', arguments: { sql: 'select 1' } }],
      usage: { promptTokens: 9, completionTokens: 4, totalTokens: 13 },
      finishReason: 'tool_use',
    });
    expect(requestBody).toMatchObject({ system: 'You are a DBA.', max_tokens: 100, stream: false });
    expect(requestHeaders?.get('x-api-key')).toBe('anthropic-test-key');
    expect(requestHeaders?.get('anthropic-version')).toBe('2023-06-01');
  });

  it('discovers Anthropic models through the model catalog without sending a message', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const provider = new AnthropicProvider({
      apiKey: 'anthropic-test-key',
      fetch: async (input, init) => {
        calls.push({ url: String(input), method: init?.method ?? 'GET' });
        return jsonResponse({ data: [{ id: 'claude-test' }] });
      },
    });

    await expect(provider.listModels()).resolves.toEqual(['claude-test']);
    await expect(provider.isAvailable('claude-test')).resolves.toMatchObject({ available: true });
    expect(calls).toEqual([
      { url: 'https://api.anthropic.com/v1/models', method: 'GET' },
      { url: 'https://api.anthropic.com/v1/models', method: 'GET' },
    ]);
    expect(calls.some((call) => call.url.endsWith('/messages'))).toBe(false);
  });

  it('normalizes native Anthropic streaming events and usage', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'test',
      fetch: async () =>
        new Response(
          sseStream([
            { type: 'message_start', message: { id: 'm', model: 'claude', usage: { input_tokens: 5 } } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
            { type: 'message_stop' },
          ]),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
    });
    const events = [];
    for await (const event of provider.stream({ model: 'claude', messages: [{ role: 'user', content: 'hi' }] })) {
      events.push(event);
    }
    expect(events).toEqual(
      expect.arrayContaining([
        { type: 'text-delta', text: 'hello' },
        { type: 'usage', usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } },
      ]),
    );
    expect(events.at(-1)).toMatchObject({ type: 'finish', response: { text: 'hello', finishReason: 'end_turn' } });
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function requireStringBody(body: BodyInit | null | undefined): string {
  if (typeof body !== 'string') throw new Error('Expected a JSON string request body.');
  return body;
}

function sseStream(events: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      controller.close();
    },
  });
}

function ndjsonStream(events: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  const split = Math.max(1, Math.floor(encoded.byteLength / 3));
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded.subarray(0, split));
      controller.enqueue(encoded.subarray(split, split * 2));
      controller.enqueue(encoded.subarray(split * 2));
      controller.close();
    },
  });
}
