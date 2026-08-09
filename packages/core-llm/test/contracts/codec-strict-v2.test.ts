import { describe, expect, it } from 'vitest';
import {
  anthropicMessagesCodec,
  ModelProtocolError,
  ollamaChatCodec,
  openAIChatCodec,
  openAIResponsesCodec,
  type DecodedModelStreamEvent,
  type ModelProtocol,
} from '../../src/types.js';

describe('version 2 strict native protocol contract', () => {
  it.each([
    {
      name: 'wrong OpenAI Chat tool-call type',
      call: { id: 'call-a', type: 'computer', function: { name: 'inspect', arguments: '{}' } },
    },
    {
      name: 'missing OpenAI Chat arguments',
      call: { id: 'call-a', type: 'function', function: { name: 'inspect' } },
    },
    {
      name: 'non-string OpenAI Chat arguments',
      call: { id: 'call-a', type: 'function', function: { name: 'inspect', arguments: {} } },
    },
  ])('rejects $name', ({ call }) => {
    expectSyncError(
      () => openAIChatCodec.decode({
        choices: [{ message: { content: null, tool_calls: [call] }, finish_reason: 'tool_calls' }],
      }, context('openai-chat')),
      'INVALID_WIRE_RESPONSE',
    );
  });

  it.each([
    {
      name: 'missing output_index',
      events: [{ type: 'response.output_item.added', item: { id: 'msg', type: 'message', content: [] } }],
    },
    {
      name: 'negative output_index',
      events: [{ type: 'response.output_item.added', output_index: -1, item: { id: 'msg', type: 'message', content: [] } }],
    },
    {
      name: 'non-integer content_index',
      events: [{ type: 'response.content_part.added', output_index: 0, content_index: 1.5, part: { type: 'output_text', text: '' } }],
    },
  ])('rejects Responses $name', async ({ events }) => {
    await expectStreamError(
      openAIResponsesCodec.decodeStream(streamOf(...events), context('openai-responses')),
      'INVALID_WIRE_RESPONSE',
    );
  });

  it.each([
    {
      name: 'duplicate output item start',
      events: [
        { type: 'response.output_item.added', output_index: 0, item: { id: 'msg', type: 'message', content: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { id: 'msg', type: 'message', content: [] } },
      ],
    },
    {
      name: 'output item done without start',
      events: [
        { type: 'response.output_item.done', output_index: 0, item: { id: 'msg', type: 'message', content: [] } },
      ],
    },
    {
      name: 'conflicting output item identity',
      events: [
        { type: 'response.output_item.added', output_index: 0, item: { id: 'msg-a', type: 'message', content: [] } },
        { type: 'response.output_item.done', output_index: 0, item: { id: 'msg-b', type: 'message', content: [] } },
      ],
    },
    {
      name: 'conflicting function call identity',
      events: [
        { type: 'response.output_item.added', output_index: 0, item: { id: 'item-a', type: 'function_call', call_id: 'call-a', name: 'inspect', arguments: '{}' } },
        { type: 'response.output_item.done', output_index: 0, item: { id: 'item-a', type: 'function_call', call_id: 'call-b', name: 'inspect', arguments: '{}' } },
      ],
    },
    {
      name: 'duplicate output item done',
      events: [
        { type: 'response.output_item.added', output_index: 0, item: { id: 'msg', type: 'message', content: [] } },
        { type: 'response.output_item.done', output_index: 0, item: { id: 'msg', type: 'message', content: [] } },
        { type: 'response.output_item.done', output_index: 0, item: { id: 'msg', type: 'message', content: [] } },
      ],
    },
    {
      name: 'function completion without arguments',
      events: [
        { type: 'response.output_item.added', output_index: 0, item: { id: 'item-a', type: 'function_call', call_id: 'call-a', name: 'inspect', arguments: '{}' } },
        { type: 'response.output_item.done', output_index: 0, item: { id: 'item-a', type: 'function_call', call_id: 'call-a', name: 'inspect' } },
      ],
    },
    {
      name: 'function done arguments conflicting with arguments.done',
      events: [
        { type: 'response.output_item.added', output_index: 0, item: { id: 'item-a', type: 'function_call', call_id: 'call-a', name: 'inspect', arguments: '' } },
        { type: 'response.function_call_arguments.done', output_index: 0, arguments: '{}' },
        { type: 'response.output_item.done', output_index: 0, item: { id: 'item-a', type: 'function_call', call_id: 'call-a', name: 'inspect', arguments: '{"changed":true}' } },
      ],
    },
  ])('rejects Responses $name', async ({ events }) => {
    await expectStreamError(
      openAIResponsesCodec.decodeStream(streamOf(...events), context('openai-responses')),
      'INVALID_WIRE_RESPONSE',
    );
  });

  it('emits exactly one completion for a Responses content part with both native done events', async () => {
    const events = await collect(openAIResponsesCodec.decodeStream(
      streamOf(
        { type: 'response.output_item.added', output_index: 0, item: { id: 'msg', type: 'message', content: [] } },
        { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } },
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'done' },
        { type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'done' },
        { type: 'response.content_part.done', output_index: 0, content_index: 0, part: { type: 'output_text', text: 'done' } },
        { type: 'response.output_item.done', output_index: 0, item: { id: 'msg', type: 'message', content: [{ type: 'output_text', text: 'done' }] } },
        { type: 'response.completed', response: { status: 'completed' } },
      ),
      context('openai-responses'),
    ));

    expect(events.filter((event) => event.type === 'block-complete')).toEqual([
      { type: 'block-complete', blockOrdinal: 0, block: { type: 'text', text: 'done' } },
    ]);
  });

  it('rejects a duplicate Responses content-part done event', async () => {
    await expectStreamError(openAIResponsesCodec.decodeStream(
      streamOf(
        { type: 'response.output_item.added', output_index: 0, item: { id: 'msg', type: 'message', content: [] } },
        { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } },
        { type: 'response.content_part.done', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } },
        { type: 'response.content_part.done', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } },
      ),
      context('openai-responses'),
    ), 'INVALID_WIRE_RESPONSE');
  });

  it.each([
    {
      name: 'wrong OpenAI Chat stream tool-call type',
      protocol: 'openai-chat' as const,
      iterable: openAIChatCodec.decodeStream(streamOf({ choices: [{
        delta: { tool_calls: [{ index: 0, id: 'call-a', type: 'computer', function: { name: 'inspect', arguments: '{}' } }] },
        finish_reason: 'tool_calls',
      }] }), context('openai-chat')),
    },
    {
      name: 'conflicting OpenAI Chat stream call IDs',
      protocol: 'openai-chat' as const,
      iterable: openAIChatCodec.decodeStream(streamOf(
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-a', type: 'function', function: { name: 'inspect', arguments: '{' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-b', type: 'function', function: { arguments: '}' } }] }, finish_reason: 'tool_calls' }] },
      ), context('openai-chat')),
    },
    {
      name: 'OpenAI Chat stream call missing arguments',
      protocol: 'openai-chat' as const,
      iterable: openAIChatCodec.decodeStream(streamOf({ choices: [{
        delta: { tool_calls: [{ index: 0, id: 'call-a', type: 'function', function: { name: 'inspect' } }] },
        finish_reason: 'tool_calls',
      }] }), context('openai-chat')),
    },
    {
      name: 'invalid OpenAI Chat stream call index',
      protocol: 'openai-chat' as const,
      iterable: openAIChatCodec.decodeStream(streamOf({ choices: [{
        delta: { tool_calls: [{ index: -1, id: 'call-a', type: 'function', function: { name: 'inspect', arguments: '{}' } }] },
        finish_reason: 'tool_calls',
      }] }), context('openai-chat')),
    },
    {
      name: 'duplicate Anthropic content start',
      protocol: 'anthropic-messages' as const,
      iterable: anthropicMessagesCodec.decodeStream(streamOf(
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      ), context('anthropic-messages')),
    },
    {
      name: 'Anthropic tool block missing arguments',
      protocol: 'anthropic-messages' as const,
      iterable: anthropicMessagesCodec.decodeStream(streamOf(
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool-a', name: 'inspect' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_stop' },
      ), context('anthropic-messages')),
    },
    {
      name: 'Anthropic delta type conflicting with its block',
      protocol: 'anthropic-messages' as const,
      iterable: anthropicMessagesCodec.decodeStream(streamOf(
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
      ), context('anthropic-messages')),
    },
    {
      name: 'conflicting Ollama stream call IDs',
      protocol: 'ollama-chat' as const,
      iterable: ollamaChatCodec.decodeStream(streamOf(
        { message: { tool_calls: [{ index: 0, id: 'call-a', function: { name: 'inspect', arguments: '{' } }] } },
        { message: { tool_calls: [{ index: 0, id: 'call-b', function: { arguments: '}' } }] }, done: true },
      ), context('ollama-chat')),
    },
    {
      name: 'duplicate Ollama done chunk',
      protocol: 'ollama-chat' as const,
      iterable: ollamaChatCodec.decodeStream(streamOf(
        { message: { content: 'done' }, done: true },
        { message: {}, done: true },
      ), context('ollama-chat')),
    },
    {
      name: 'Ollama stream call missing arguments',
      protocol: 'ollama-chat' as const,
      iterable: ollamaChatCodec.decodeStream(streamOf({
        message: { tool_calls: [{ index: 0, id: 'call-a', function: { name: 'inspect' } }] },
        done: true,
      }), context('ollama-chat')),
    },
    {
      name: 'invalid Ollama stream content type',
      protocol: 'ollama-chat' as const,
      iterable: ollamaChatCodec.decodeStream(streamOf({ message: { content: 42 }, done: true }), context('ollama-chat')),
    },
  ])('rejects $name as invalid native wire data', async ({ iterable }) => {
    await expectStreamError(iterable, 'INVALID_WIRE_RESPONSE');
  });
});

function context(protocol: ModelProtocol) {
  return {
    attemptId: `strict-${protocol}`,
    origin: { connectionId: 'conn-strict', model: 'm1', protocol },
  };
}

function streamOf<T>(...events: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield await Promise.resolve(event);
    },
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

async function expectStreamError(
  iterable: AsyncIterable<DecodedModelStreamEvent>,
  code: ModelProtocolError['code'],
): Promise<void> {
  let thrown: unknown;
  try {
    await collect(iterable);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ModelProtocolError);
  expect((thrown as ModelProtocolError).code).toBe(code);
}

function expectSyncError(operation: () => unknown, code: ModelProtocolError['code']): void {
  let thrown: unknown;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ModelProtocolError);
  expect((thrown as ModelProtocolError).code).toBe(code);
}
