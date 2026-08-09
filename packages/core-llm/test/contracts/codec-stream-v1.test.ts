import { describe, expect, it } from 'vitest';
import {
  ModelProtocolError,
  type DecodedModelStreamEvent,
  type ModelProtocol,
} from '../../src/types.js';
import { anthropicMessagesCodec } from '../../src/protocol/codecs/anthropic-messages.js';
import { ollamaChatCodec } from '../../src/protocol/codecs/ollama-chat.js';
import { openAIChatCodec } from '../../src/protocol/codecs/openai-chat.js';
import { openAIResponsesCodec } from '../../src/protocol/codecs/openai-responses.js';

describe('version 1 canonical stream contract', () => {
  it('requires Anthropic message_stop and every started content block to stop', async () => {
    await expectIncomplete(
      anthropicMessagesCodec.decodeStream(
        streamOf(
          { type: 'message_start', message: {} },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        ),
        context('anthropic-messages'),
      ),
    );
    await expectIncomplete(
      anthropicMessagesCodec.decodeStream(
        streamOf(
          { type: 'message_start', message: {} },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'message_stop' },
        ),
        context('anthropic-messages'),
      ),
    );
  });

  it('emits Anthropic block-complete before a terminal finish', async () => {
    const events = await collect(
      anthropicMessagesCodec.decodeStream(
        streamOf(
          { type: 'message_start', message: {} },
          { type: 'content_block_start', index: 4, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 4, delta: { type: 'text_delta', text: 'done' } },
          { type: 'content_block_stop', index: 4 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
          { type: 'message_stop' },
        ),
        context('anthropic-messages'),
      ),
    );
    expect(events.map((event) => event.type)).toEqual(['text-delta', 'block-complete', 'finish']);
    expect((events.at(-1) as Extract<DecodedModelStreamEvent, { type: 'finish' }>).attempt.terminal).toBe(true);
  });

  it('maps Responses native indexes to dense canonical ordinals and completes function arguments', async () => {
    const events = await collect(
      openAIResponsesCodec.decodeStream(
        streamOf(
          {
            type: 'response.output_item.added',
            output_index: 7,
            item: { id: 'message-7', type: 'message', role: 'assistant', content: [] },
          },
          {
            type: 'response.content_part.added',
            output_index: 7,
            content_index: 3,
            part: { type: 'output_text', text: '' },
          },
          { type: 'response.output_text.delta', output_index: 7, content_index: 3, delta: 'hello' },
          { type: 'response.output_text.done', output_index: 7, content_index: 3, text: 'hello' },
          {
            type: 'response.content_part.done',
            output_index: 7,
            content_index: 3,
            part: { type: 'output_text', text: 'hello' },
          },
          {
            type: 'response.output_item.done',
            output_index: 7,
            item: {
              id: 'message-7',
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'hello' }],
            },
          },
          {
            type: 'response.output_item.added',
            output_index: 11,
            item: { id: 'item-11', type: 'function_call', call_id: 'call-11', name: 'inspect', arguments: '' },
          },
          { type: 'response.function_call_arguments.delta', output_index: 11, delta: '{"tab' },
          { type: 'response.function_call_arguments.done', output_index: 11, arguments: '{"table":"a"}' },
          {
            type: 'response.output_item.done',
            output_index: 11,
            item: { id: 'item-11', type: 'function_call', call_id: 'call-11', name: 'inspect', arguments: '{"table":"a"}' },
          },
          { type: 'response.completed', response: { id: 'resp-stream', status: 'completed' } },
        ),
        context('openai-responses'),
      ),
    );
    const deltas = events.filter(
      (event) => event.type === 'text-delta' || event.type === 'tool-call-delta',
    );
    expect(deltas.map((event) => event.blockOrdinal)).toEqual([0, 1]);
    const complete = events.filter((event) => event.type === 'block-complete');
    expect(complete.map((event) => event.blockOrdinal)).toEqual([0, 1]);
    const completedCall = complete[1]?.block;
    expect(completedCall?.type).toBe('tool-call-draft');
    if (completedCall?.type !== 'tool-call-draft') throw new Error('Expected completed call');
    expect(completedCall.wireIdentity).toEqual({ callId: 'call-11', providerItemId: 'item-11' });
    expect(completedCall.arguments).toEqual({ table: 'a' });
  });

  it('yields a Responses tentative delta before a truncated source reports incompleteness', async () => {
    const iterator = openAIResponsesCodec.decodeStream(
      streamOf(
        { type: 'response.output_item.added', output_index: 0, item: { id: 'message', type: 'message', content: [] } },
        { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } },
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'tentative' },
      ),
      context('openai-responses'),
    )[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'text-delta', blockOrdinal: 0, text: 'tentative' },
    });
    await expect(iterator.next()).rejects.toMatchObject({ code: 'INCOMPLETE_MODEL_ATTEMPT' });
  });

  it('does not read ahead or accumulate pending events across a long Responses delta stream', async () => {
    let deltaPulls = 0;
    const deltaCount = 128;
    const source: AsyncIterable<unknown> = {
      async *[Symbol.asyncIterator]() {
        yield await Promise.resolve({ type: 'response.output_item.added', output_index: 0, item: { id: 'message', type: 'message', content: [] } });
        yield { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } };
        for (let index = 0; index < deltaCount; index += 1) {
          deltaPulls += 1;
          yield { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'x' };
        }
        const text = 'x'.repeat(deltaCount);
        yield { type: 'response.output_text.done', output_index: 0, content_index: 0, text };
        yield { type: 'response.content_part.done', output_index: 0, content_index: 0, part: { type: 'output_text', text } };
        yield { type: 'response.output_item.done', output_index: 0, item: { id: 'message', type: 'message', content: [{ type: 'output_text', text }] } };
        yield { type: 'response.completed', response: { status: 'completed' } };
      },
    };
    const iterator = openAIResponsesCodec.decodeStream(
      source,
      context('openai-responses'),
    )[Symbol.asyncIterator]();

    for (let index = 0; index < deltaCount; index += 1) {
      const event = await iterator.next();
      expect(event).toEqual({
        done: false,
        value: { type: 'text-delta', blockOrdinal: 0, text: 'x' },
      });
      expect(deltaPulls).toBe(index + 1);
    }
    expect((await collectFromIterator(iterator)).at(-1)?.type).toBe('finish');
  });

  it('rejects Responses completion while an output item is still incomplete', async () => {
    await expectIncomplete(
      openAIResponsesCodec.decodeStream(
        streamOf(
          {
            type: 'response.output_item.added',
            output_index: 3,
            item: { id: 'item-partial', type: 'function_call', call_id: 'call-partial', name: 'inspect', arguments: '{"a"' },
          },
          { type: 'response.completed', response: { id: 'resp-partial', status: 'completed' } },
        ),
        context('openai-responses'),
      ),
    );
  });

  it('assembles Responses reasoning summary part events and preserves the opaque item', async () => {
    const reasoningItem = {
      id: 'reasoning-stream',
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'public' }],
      encrypted_content: 'encrypted-stream',
    };
    const events = await collect(
      openAIResponsesCodec.decodeStream(
        streamOf(
          { type: 'response.output_item.added', output_index: 5, item: { ...reasoningItem, summary: [] } },
          {
            type: 'response.reasoning_summary_part.added',
            output_index: 5,
            summary_index: 2,
            part: { type: 'summary_text', text: '' },
          },
          { type: 'response.reasoning_summary_text.delta', output_index: 5, summary_index: 2, delta: 'public' },
          { type: 'response.reasoning_summary_text.done', output_index: 5, summary_index: 2, text: 'public' },
          {
            type: 'response.reasoning_summary_part.done',
            output_index: 5,
            summary_index: 2,
            part: { type: 'summary_text', text: 'public' },
          },
          { type: 'response.output_item.done', output_index: 5, item: reasoningItem },
          { type: 'response.completed', response: { status: 'completed' } },
        ),
        context('openai-responses'),
      ),
    );
    expect(events.filter((event) => event.type === 'reasoning-summary-delta')).toEqual([
      { type: 'reasoning-summary-delta', blockOrdinal: 0, text: 'public' },
    ]);
    const completed = events.filter((event) => event.type === 'block-complete');
    expect(completed.map((event) => event.blockOrdinal)).toEqual([0, 1]);
    expect(completed.map((event) => event.block.type)).toEqual(['reasoning-summary', 'provider-opaque']);
  });

  it.each([
    {
      name: 'OpenAI Chat',
      iterable: openAIChatCodec.decodeStream(
        streamOf({ choices: [{ delta: { content: 'partial' } }] }),
        context('openai-chat'),
      ),
    },
    {
      name: 'OpenAI Responses',
      iterable: openAIResponsesCodec.decodeStream(
        streamOf(
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: { id: 'message-partial', type: 'message', content: [] },
          },
          {
            type: 'response.content_part.added',
            output_index: 0,
            content_index: 0,
            part: { type: 'output_text', text: '' },
          },
          { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'partial' },
        ),
        context('openai-responses'),
      ),
    },
    {
      name: 'Ollama Chat',
      iterable: ollamaChatCodec.decodeStream(
        streamOf({ message: { content: 'partial' }, done: false }),
        context('ollama-chat'),
      ),
    },
  ])('rejects truncated $name streams', async ({ iterable }) => {
    await expectIncomplete(iterable);
  });

  it('emits block-complete for terminal OpenAI Chat and Ollama blocks', async () => {
    const chat = await collect(
      openAIChatCodec.decodeStream(
        streamOf({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }),
        context('openai-chat'),
      ),
    );
    const ollama = await collect(
      ollamaChatCodec.decodeStream(
        streamOf({ message: { content: 'done' }, done: true, done_reason: 'stop' }),
        context('ollama-chat'),
      ),
    );
    expect(chat.map((event) => event.type)).toEqual(['text-delta', 'block-complete', 'finish']);
    expect(ollama.map((event) => event.type)).toEqual(['text-delta', 'block-complete', 'finish']);
  });
});

function context(protocol: ModelProtocol) {
  return {
    attemptId: `stream-${protocol}`,
    origin: { connectionId: 'conn-stream', model: 'm1', protocol },
  };
}

function streamOf<T>(...values: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const value of values) yield await Promise.resolve(value);
    },
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of iterable) result.push(event);
  return result;
}

async function collectFromIterator<T>(iterator: AsyncIterator<T>): Promise<T[]> {
  const result: T[] = [];
  while (true) {
    const event = await iterator.next();
    if (event.done) return result;
    result.push(event.value);
  }
}

async function expectIncomplete(iterable: AsyncIterable<unknown>): Promise<void> {
  let thrown: unknown;
  try {
    await collect(iterable);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ModelProtocolError);
  expect((thrown as ModelProtocolError).code).toBe('INCOMPLETE_MODEL_ATTEMPT');
}
