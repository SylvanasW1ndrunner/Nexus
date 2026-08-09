import { describe, expect, it } from 'vitest';
import {
  ModelProtocolError,
  type ModelProtocol,
} from '../../src/types.js';
import { anthropicMessagesCodec } from '../../src/protocol/codecs/anthropic-messages.js';
import { ollamaChatCodec } from '../../src/protocol/codecs/ollama-chat.js';
import { openAIChatCodec } from '../../src/protocol/codecs/openai-chat.js';
import { openAIResponsesCodec } from '../../src/protocol/codecs/openai-responses.js';

describe('version 1 malformed provider corpus', () => {
  it.each([
    {
      name: 'OpenAI Chat malformed choices',
      protocol: 'openai-chat' as const,
      decode: () => openAIChatCodec.decode({ choices: {} }, context('openai-chat')),
    },
    {
      name: 'OpenAI Chat incomplete known call',
      protocol: 'openai-chat' as const,
      decode: () => openAIChatCodec.decode({
        choices: [{ message: { content: '', tool_calls: [{ type: 'function', function: { arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
      }, context('openai-chat')),
    },
    {
      name: 'OpenAI Chat incomplete known text part',
      protocol: 'openai-chat' as const,
      decode: () => openAIChatCodec.decode({
        choices: [{ message: { content: [{ type: 'text' }] }, finish_reason: 'stop' }],
      }, context('openai-chat')),
    },
    {
      name: 'OpenAI Responses malformed output',
      protocol: 'openai-responses' as const,
      decode: () => openAIResponsesCodec.decode({ status: 'completed', output: [null] }, context('openai-responses')),
    },
    {
      name: 'OpenAI Responses incomplete known item',
      protocol: 'openai-responses' as const,
      decode: () => openAIResponsesCodec.decode({ status: 'completed', output: [{ type: 'function_call', arguments: '{}' }] }, context('openai-responses')),
    },
    {
      name: 'Anthropic malformed content',
      protocol: 'anthropic-messages' as const,
      decode: () => anthropicMessagesCodec.decode({ content: 'bad', stop_reason: 'end_turn' }, context('anthropic-messages')),
    },
    {
      name: 'Anthropic incomplete known block',
      protocol: 'anthropic-messages' as const,
      decode: () => anthropicMessagesCodec.decode({ content: [{ type: 'tool_use', input: {} }], stop_reason: 'tool_use' }, context('anthropic-messages')),
    },
    {
      name: 'Anthropic incomplete known text block',
      protocol: 'anthropic-messages' as const,
      decode: () => anthropicMessagesCodec.decode({ content: [{ type: 'text' }], stop_reason: 'end_turn' }, context('anthropic-messages')),
    },
    {
      name: 'Ollama malformed calls',
      protocol: 'ollama-chat' as const,
      decode: () => ollamaChatCodec.decode({ message: { content: '', tool_calls: {} }, done: true }, context('ollama-chat')),
    },
    {
      name: 'Ollama incomplete known call',
      protocol: 'ollama-chat' as const,
      decode: () => ollamaChatCodec.decode({ message: { tool_calls: [{ function: { arguments: {} } }] }, done: true }, context('ollama-chat')),
    },
    {
      name: 'Ollama invalid known content',
      protocol: 'ollama-chat' as const,
      decode: () => ollamaChatCodec.decode({ message: { content: 42 }, done: true }, context('ollama-chat')),
    },
  ])('rejects $name instead of filtering it', ({ decode }) => {
    let thrown: unknown;
    try {
      decode();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ModelProtocolError);
    expect((thrown as ModelProtocolError).code).toBe('INVALID_WIRE_RESPONSE');
  });

  it('uses ModelProtocolError when OpenAI Chat has no choice', () => {
    let thrown: unknown;
    try {
      openAIChatCodec.decode({ choices: [] }, context('openai-chat'));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ModelProtocolError);
    expect((thrown as ModelProtocolError).code).toBe('INVALID_WIRE_RESPONSE');
  });

  it('preserves a complete unknown provider block as opaque', () => {
    const decoded = anthropicMessagesCodec.decode(
      { content: [{ type: 'future_block', value: 42 }], stop_reason: 'end_turn' },
      context('anthropic-messages'),
    );
    expect(decoded.blocks[0]).toEqual(expect.objectContaining({ type: 'provider-opaque' }));
  });
});

function context(protocol: ModelProtocol) {
  return {
    attemptId: `malformed-${protocol}`,
    origin: { connectionId: 'conn-malformed', model: 'm1', protocol },
  };
}
