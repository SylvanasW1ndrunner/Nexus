import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type AttemptDecodeContext,
  type DecodedModelStreamEvent,
  type ModelProtocolCodec,
} from '../../src/types.js';
import { anthropicMessagesCodec } from '../../src/protocol/codecs/anthropic-messages.js';
import { ollamaChatCodec } from '../../src/protocol/codecs/ollama-chat.js';
import { openAIChatCodec } from '../../src/protocol/codecs/openai-chat.js';
import { openAIResponsesCodec } from '../../src/protocol/codecs/openai-responses.js';

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}

const anthropicFixture = loadFixture('anthropic-messages.json');
const ollamaFixture = loadFixture('ollama-chat.json');
const openAiChatFixture = loadFixture('openai-chat-parallel.json');
const openAiResponsesFixture = loadFixture('openai-responses.json');

function context(protocol: AttemptDecodeContext['origin']['protocol']): AttemptDecodeContext {
  return {
    attemptId: 'attempt-golden',
    origin: { connectionId: 'conn-golden', model: 'm1', protocol },
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

describe('provider codec golden contract', () => {
  it.each([
    {
      name: 'OpenAI Chat',
      codec: openAIChatCodec,
      fixture: openAiChatFixture,
      types: ['text', 'tool-call-draft', 'tool-call-draft'],
      finishReason: 'tool-calls',
      usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18, cachedInputTokens: 3 },
    },
    {
      name: 'OpenAI Responses',
      codec: openAIResponsesCodec,
      fixture: openAiResponsesFixture,
      types: ['text', 'reasoning-summary', 'provider-opaque', 'tool-call-draft'],
      finishReason: 'stop',
      usage: { inputTokens: 13, outputTokens: 8, totalTokens: 21, cachedInputTokens: 4 },
    },
    {
      name: 'Anthropic Messages',
      codec: anthropicMessagesCodec,
      fixture: anthropicFixture,
      types: ['text', 'provider-opaque', 'tool-call-draft'],
      finishReason: 'tool-calls',
      usage: { inputTokens: 9, outputTokens: 4, totalTokens: 13, cachedInputTokens: 2 },
    },
    {
      name: 'Ollama Chat',
      codec: ollamaChatCodec,
      fixture: ollamaFixture,
      types: ['provider-opaque', 'text', 'tool-call-draft'],
      finishReason: 'stop',
      usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
    },
  ])('normalizes ordered blocks, finish, and usage for $name', ({ codec, fixture, types, finishReason, usage }) => {
    const attempt = (codec as ModelProtocolCodec).decode(fixture, context(codec.protocol));

    expect(attempt.blocks.map((block) => block.type)).toEqual(types);
    expect(attempt.finishReason).toBe(finishReason);
    expect(attempt.usage).toEqual(usage);
    expect(attempt.terminal).toBe(true);
  });

  it('retains provider-opaque values with replay restrictions and stable references', () => {
    const attempt = anthropicMessagesCodec.decode(
      anthropicFixture,
      context('anthropic-messages'),
    );

    expect(attempt.blocks[1]).toEqual({
      type: 'provider-opaque',
      opaqueRef: 'attempt-golden:opaque:1',
      protocol: 'anthropic-messages',
      origin: { connectionId: 'conn-golden', model: 'm1' },
      replay: 'same-connection-only',
      value: {
        type: 'thinking',
        thinking: 'private reasoning',
        signature: 'signed-token',
      },
    });
    expect(attempt.opaqueBlockRefs).toEqual(['attempt-golden:opaque:1']);
  });

  it('assembles fragmented OpenAI Chat JSON arguments in one draft block', async () => {
    const chunks = asAsyncIterable([
      { choices: [{ index: 0, delta: { content: 'Checking ' } }] },
      {
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-a', function: { name: 'inspect', arguments: '{"tab' } }] } }],
      },
      {
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-a', function: { arguments: 'le":"a"}' } }] }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      },
    ]);

    const events = await collect(openAIChatCodec.decodeStream(chunks, context('openai-chat')));
    const finish = events.at(-1) as Extract<DecodedModelStreamEvent, { type: 'finish' }>;

    expect(finish.type).toBe('finish');
    expect(finish.attempt.blocks).toEqual([
      { type: 'text', text: 'Checking ' },
      {
        type: 'tool-call-draft',
        draftCallKey: 'attempt-golden:1',
        wireIdentity: { callId: 'call-a' },
        name: 'inspect',
        arguments: { table: 'a' },
      },
    ]);
    expect(finish.attempt.usage).toEqual({ inputTokens: 2, outputTokens: 3, totalTokens: 5 });
  });

  it('encodes the same canonical request in each native protocol without tool-text fallbacks', () => {
    const request = {
      model: 'm1',
      messages: [
        { role: 'user' as const, content: [{ type: 'text' as const, text: 'Inspect.' }] },
        {
          role: 'assistant' as const,
          content: [
            { type: 'tool-call' as const, callId: 'internal-1', name: 'inspect', arguments: { table: 'a' } },
          ],
        },
        {
          role: 'tool' as const,
          content: [{ type: 'tool-result' as const, callId: 'internal-1', output: { rows: 1 }, isError: false }],
        },
      ],
      tools: [{ name: 'inspect', description: 'Inspect a table', inputSchema: { type: 'object' } }],
    };

    const encoded = [
      {
        value: openAIChatCodec.encode(request, freshEncodeContext('openai-chat')).wireRequest,
        transcriptKey: 'messages',
      },
      {
        value: openAIResponsesCodec.encode(request, freshEncodeContext('openai-responses')).wireRequest,
        transcriptKey: 'input',
      },
      {
        value: anthropicMessagesCodec.encode(request, freshEncodeContext('anthropic-messages')).wireRequest,
        transcriptKey: 'messages',
      },
      {
        value: ollamaChatCodec.encode(request, freshEncodeContext('ollama-chat')).wireRequest,
        transcriptKey: 'messages',
      },
    ];
    for (const item of encoded) {
      const value = item.value as Record<string, unknown>;
      expect(value.model).toBe('m1');
      expect(Array.isArray(value[item.transcriptKey])).toBe(true);
      expect(Array.isArray(value.tools)).toBe(true);
    }
  });
});

function asAsyncIterable<T>(values: readonly T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const value of values) yield await Promise.resolve(value);
    },
  };
}

function freshEncodeContext(protocol: AttemptDecodeContext['origin']['protocol']) {
  return {
    requestId: 'golden-request',
    target: { connectionId: 'conn-golden', model: 'm1', protocol },
    replay: { mode: 'new' as const },
  };
}
