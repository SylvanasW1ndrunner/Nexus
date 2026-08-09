import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ModelProtocolError,
  type AttemptDecodeContext,
} from '../../src/types.js';
import { openAIChatCodec } from '../../src/protocol/codecs/openai-chat.js';

type OpenAIChatFixture = {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
      tool_calls: Array<{
        id?: string;
        type: string;
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage: Record<string, unknown>;
};

const openAiParallelToolFixture = JSON.parse(
  readFileSync(new URL('./fixtures/openai-chat-parallel.json', import.meta.url), 'utf8'),
) as OpenAIChatFixture;

const context: AttemptDecodeContext = {
  attemptId: 'attempt-1',
  origin: { connectionId: 'conn-1', model: 'm1', protocol: 'openai-chat' },
};

describe('canonical model protocol identity', () => {
  it('keeps provider blocks ordered and withholds internal callId before commit', () => {
    const attempt = openAIChatCodec.decode(openAiParallelToolFixture, context);

    expect(attempt.blocks.map((block) => block.type)).toEqual([
      'text',
      'tool-call-draft',
      'tool-call-draft',
    ]);
    expect(attempt.blocks.filter((block) => block.type === 'tool-call-draft')).toEqual([
      expect.objectContaining({ draftCallKey: 'attempt-1:1', wireIdentity: { callId: 'call-a' } }),
      expect.objectContaining({ draftCallKey: 'attempt-1:2', wireIdentity: { callId: 'call-b' } }),
    ]);
    expect(attempt.blocks.some((block) => 'callId' in block)).toBe(false);
  });

  it('keeps missing wire identities distinct without inventing provider or internal IDs', () => {
    const fixture = structuredClone(openAiParallelToolFixture);
    delete fixture.choices[0]?.message.tool_calls[0]?.id;
    delete fixture.choices[0]?.message.tool_calls[1]?.id;

    const attempt = openAIChatCodec.decode(fixture, context);
    const calls = attempt.blocks.filter((block) => block.type === 'tool-call-draft');

    expect(calls).toEqual([
      { type: 'tool-call-draft', draftCallKey: 'attempt-1:1', name: 'inspect', arguments: { table: 'a' } },
      { type: 'tool-call-draft', draftCallKey: 'attempt-1:2', name: 'inspect', arguments: { table: 'b' } },
    ]);
  });

  it('rejects duplicate completed wire IDs for one attempt', () => {
    const fixture = structuredClone(openAiParallelToolFixture);
    fixture.choices[0]!.message.tool_calls[1]!.id = 'call-a';

    let thrown: unknown;
    try {
      openAIChatCodec.decode(fixture, context);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ModelProtocolError);
    expect((thrown as ModelProtocolError).code).toBe('DUPLICATE_WIRE_CALL_ID');
  });

  it('does not infer tool calls from generic tagged text', () => {
    const fixture = structuredClone(openAiParallelToolFixture);
    fixture.choices[0]!.message.content =
      '<tool_calls>[{"name":"inspect","arguments":{"table":"secret"}}]</tool_calls>';
    fixture.choices[0]!.message.tool_calls = [];

    expect(openAIChatCodec.decode(fixture, context).blocks).toEqual([
      {
        type: 'text',
        text: '<tool_calls>[{"name":"inspect","arguments":{"table":"secret"}}]</tool_calls>',
      },
    ]);
  });
});
