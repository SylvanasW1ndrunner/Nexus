/* eslint-disable @typescript-eslint/require-await -- Fetch doubles implement the Provider contract. */
import { describe, expect, it } from 'vitest';
import { OllamaProvider, OpenAIResponsesProvider } from '../src/index.js';

describe('native provider Tool Call protocols', () => {
  it('maps canonical history to OpenAI Responses function call items', async () => {
    let body: Record<string, unknown> | undefined;
    const provider = new OpenAIResponsesProvider({
      id: 'openai-responses',
      name: 'OpenAI Responses',
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'test-key',
      fetch: async (_input, init) => {
        body = JSON.parse(requireStringBody(init?.body)) as Record<string, unknown>;
        return jsonResponse({
          id: 'resp_1',
          model: 'model-a',
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'There are 12 orders.' }],
            },
          ],
          usage: { input_tokens: 15, output_tokens: 6, total_tokens: 21 },
        });
      },
    });

    await provider.chat({
      model: 'model-a',
      messages: [
        { role: 'user', content: 'count orders' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'call-1', name: 'query_database', arguments: { sql: 'select count(*)' } },
          ],
        },
        {
          role: 'tool',
          name: 'query_database',
          toolCallId: 'call-1',
          content: '{"count":12}',
        },
      ],
      tools: [
        {
          name: 'query_database',
          description: 'Run SQL',
          inputSchema: { type: 'object' },
        },
      ],
      temperature: 0.2,
      topP: 0.9,
      maxTokens: 800,
      reasoning: { effort: 'medium' },
    });

    expect(body).toMatchObject({
      model: 'model-a',
      input: [
        { role: 'user', content: 'count orders' },
        {
          type: 'function_call',
          call_id: 'call-1',
          name: 'query_database',
          arguments: '{"sql":"select count(*)"}',
        },
        { type: 'function_call_output', call_id: 'call-1', output: '{"count":12}' },
      ],
      tools: [
        {
          type: 'function',
          name: 'query_database',
          description: 'Run SQL',
          parameters: { type: 'object' },
        },
      ],
      temperature: 0.2,
      top_p: 0.9,
      max_output_tokens: 800,
      reasoning: { effort: 'medium' },
    });
  });

  it('parses OpenAI Responses function calls with the provider call id intact', async () => {
    const provider = new OpenAIResponsesProvider({
      id: 'openai-responses',
      name: 'OpenAI Responses',
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'test-key',
      fetch: async () =>
        jsonResponse({
          id: 'resp_2',
          model: 'model-a',
          status: 'completed',
          output: [
            {
              type: 'function_call',
              id: 'fc_1',
              call_id: 'call-9',
              name: 'query_database',
              arguments: '{"sql":"select 9"}',
            },
          ],
          usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 },
        }),
    });

    await expect(
      provider.chat({ model: 'model-a', messages: [{ role: 'user', content: 'run it' }] }),
    ).resolves.toMatchObject({
      text: '',
      toolCalls: [
        { id: 'call-9', name: 'query_database', arguments: { sql: 'select 9' } },
      ],
      usage: { totalTokens: 7 },
    });
  });

  it('maps canonical history and generation options to native Ollama chat', async () => {
    let body: Record<string, unknown> | undefined;
    const provider = new OllamaProvider({
      baseUrl: 'http://127.0.0.1:11434',
      fetch: async (_input, init) => {
        body = JSON.parse(requireStringBody(init?.body)) as Record<string, unknown>;
        return jsonResponse({
          model: 'qwen-test',
          created_at: '2026-08-06T00:00:00Z',
          message: { role: 'assistant', content: 'done' },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 11,
          eval_count: 4,
        });
      },
    });

    await provider.chat({
      model: 'qwen-test',
      messages: [
        { role: 'user', content: 'count orders' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'internal-1', name: 'query_database', arguments: { sql: 'select count(*)' } },
          ],
        },
        {
          role: 'tool',
          name: 'query_database',
          toolCallId: 'internal-1',
          content: '{"count":12}',
        },
      ],
      tools: [
        { name: 'query_database', description: 'Run SQL', inputSchema: { type: 'object' } },
      ],
      temperature: 0.1,
      topP: 0.85,
      maxTokens: 700,
      seed: 19,
      stop: ['END'],
    });

    expect(body).toMatchObject({
      model: 'qwen-test',
      stream: false,
      messages: [
        { role: 'user', content: 'count orders' },
        {
          role: 'assistant',
          tool_calls: [
            { function: { name: 'query_database', arguments: { sql: 'select count(*)' } } },
          ],
        },
        {
          role: 'tool',
          tool_name: 'query_database',
          content: '{"count":12}',
        },
      ],
      options: {
        temperature: 0.1,
        top_p: 0.85,
        num_predict: 700,
        seed: 19,
        stop: ['END'],
      },
    });
  });

  it('assigns unique adapter-local ids to native Ollama calls that do not carry ids', async () => {
    const provider = new OllamaProvider({
      fetch: async () =>
        jsonResponse({
          model: 'qwen-test',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { function: { name: 'query_database', arguments: { sql: 'select 1' } } },
              { function: { name: 'query_database', arguments: { sql: 'select 2' } } },
            ],
          },
          done: true,
        }),
    });

    const response = await provider.chat({
      model: 'qwen-test',
      messages: [{ role: 'user', content: 'run two queries' }],
    });
    expect(response.toolCalls).toHaveLength(2);
    expect(new Set(response.toolCalls.map((call) => call.id)).size).toBe(2);
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function requireStringBody(body: BodyInit | null | undefined): string {
  if (typeof body !== 'string') throw new Error('Expected a JSON string request body.');
  return body;
}
