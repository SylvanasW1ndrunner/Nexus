import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type AttemptDecodeContext,
  type CanonicalModelRequest,
  type DecodedModelAttempt,
  type ModelContentBlock,
  type ModelProtocol,
  type ModelProtocolCodec,
  type ModelProtocolEnvelope,
} from '../../src/types.js';
import { anthropicMessagesCodec } from '../../src/protocol/codecs/anthropic-messages.js';
import { ollamaChatCodec } from '../../src/protocol/codecs/ollama-chat.js';
import { openAIChatCodec } from '../../src/protocol/codecs/openai-chat.js';
import { openAIResponsesCodec } from '../../src/protocol/codecs/openai-responses.js';

const cases = [
  { protocol: 'openai-chat' as const, fixture: 'openai-chat-parallel.json', codec: openAIChatCodec },
  { protocol: 'openai-responses' as const, fixture: 'openai-responses.json', codec: openAIResponsesCodec },
  { protocol: 'anthropic-messages' as const, fixture: 'anthropic-messages.json', codec: anthropicMessagesCodec },
  { protocol: 'ollama-chat' as const, fixture: 'ollama-chat.json', codec: ollamaChatCodec },
];

describe('version 2 legal provider roundtrip corpus', () => {
  it.each(cases)('preserves the complete normalized $protocol attempt through legal native replay', ({ protocol, fixture, codec }) => {
    const first = (codec as ModelProtocolCodec).decode(loadFixture(fixture), context(protocol, 'first'));
    const committed = commitAttempt(first);
    const encoded = (codec as ModelProtocolCodec).encode(committed.request, {
      requestId: `roundtrip-${protocol}`,
      target: first.origin,
      replay: { mode: 'same-connection', envelopes: [committed.envelope] },
    });
    const replayResponse = legalReplayResponse(protocol, encoded.wireRequest);
    const second = (codec as ModelProtocolCodec).decode(replayResponse, context(protocol, 'second'));

    expect(second.blocks.map(normalizeBlock)).toEqual(first.blocks.map(normalizeBlock));
    expect(second.finishReason).toBe(first.finishReason);
    expect(second.usage).toEqual(first.usage);
    expect(second.blocks.filter((block) => block.type === 'provider-opaque')).toHaveLength(
      first.blocks.filter((block) => block.type === 'provider-opaque').length,
    );
    expect(encoded.opaqueBlockRefs).toEqual(first.opaqueBlockRefs);
    expectWireResults(protocol, encoded.wireRequest, committed.resultWireIds);
  });
});

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}

function context(protocol: ModelProtocol, suffix: string): AttemptDecodeContext {
  return {
    attemptId: `roundtrip-${protocol}-${suffix}`,
    origin: { connectionId: `conn-${protocol}`, model: 'm1', protocol },
  };
}

function commitAttempt(attempt: DecodedModelAttempt): {
  request: CanonicalModelRequest;
  envelope: ModelProtocolEnvelope;
  resultWireIds: string[];
} {
  const correlations: ModelProtocolEnvelope['correlations'] = [];
  const blocks: ModelContentBlock[] = attempt.blocks.map((block) => {
    if (block.type !== 'tool-call-draft') return block;
    const callId = `canonical-${correlations.length}`;
    correlations.push({
      callId,
      draftCallKey: block.draftCallKey,
      ...(block.wireIdentity === undefined ? {} : { wireIdentity: block.wireIdentity }),
      replay: 'same-connection-only',
    });
    return { type: 'tool-call', callId, name: block.name, arguments: block.arguments };
  });
  const results = correlations.map((correlation, index) => ({
    type: 'tool-result' as const,
    callId: correlation.callId,
    output: { result: index + 1 },
    isError: false,
  }));
  return {
    request: {
      model: attempt.origin.model,
      messages: [
        { role: 'assistant', content: blocks },
        { role: 'tool', content: results },
      ],
    },
    envelope: {
      schemaVersion: 1,
      attemptId: attempt.attemptId,
      origin: attempt.origin,
      correlations,
      opaqueBlockRefs: attempt.opaqueBlockRefs,
    },
    resultWireIds: correlations.map((entry) => entry.wireIdentity?.callId).filter((value): value is string => value !== undefined),
  };
}

function legalReplayResponse(protocol: ModelProtocol, wireRequest: unknown): unknown {
  const wire = wireRequest as Record<string, unknown>;
  if (protocol === 'openai-chat') {
    const assistant = (wire.messages as Array<Record<string, unknown>>)
      .filter((message) => message.role === 'assistant');
    return {
      id: 'replayed-chat',
      choices: [{
        message: {
          role: 'assistant',
          content: assistant.flatMap((message) => message.content as unknown[]),
          tool_calls: assistant.flatMap((message) => (message.tool_calls ?? []) as unknown[]),
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, prompt_tokens_details: { cached_tokens: 3 } },
    };
  }
  if (protocol === 'openai-responses') {
    const input = wire.input as Array<Record<string, unknown>>;
    return {
      id: 'replayed-responses',
      status: 'completed',
      output: input.filter((item) => item.type !== 'function_call_output'),
      usage: { input_tokens: 13, output_tokens: 8, total_tokens: 21, input_tokens_details: { cached_tokens: 4 } },
    };
  }
  if (protocol === 'anthropic-messages') {
    const assistant = (wire.messages as Array<Record<string, unknown>>)
      .find((message) => message.role === 'assistant');
    return {
      id: 'replayed-anthropic',
      content: assistant?.content,
      stop_reason: 'tool_use',
      usage: { input_tokens: 9, output_tokens: 4, cache_read_input_tokens: 2 },
    };
  }
  const assistant = (wire.messages as Array<Record<string, unknown>>)
    .filter((message) => message.role === 'assistant');
  return {
    created_at: 'replayed-ollama',
    message: {
      role: 'assistant',
      thinking: assistant.find((message) => typeof message.thinking === 'string')?.thinking,
      content: assistant.map((message) => message.content).filter((value): value is string => typeof value === 'string').join(''),
      tool_calls: assistant.flatMap((message) => (message.tool_calls ?? []) as unknown[]),
    },
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 5,
    eval_count: 3,
  };
}

function normalizeBlock(block: DecodedModelAttempt['blocks'][number]): unknown {
  if (block.type === 'text') return { type: block.type, text: block.text };
  if (block.type === 'reasoning-summary') {
    return { type: block.type, text: block.text, derived: block.derivedFromOpaqueRef !== undefined };
  }
  if (block.type === 'provider-opaque') {
    return { type: block.type, protocol: block.protocol, replay: block.replay, value: block.value };
  }
  if (block.type === 'resource-ref') {
    return {
      type: block.type,
      artifactId: block.artifactId,
      mediaType: block.mediaType,
      purpose: block.purpose,
    };
  }
  return {
    type: block.type,
    name: block.name,
    arguments: block.arguments,
    wireIdentity: block.wireIdentity,
  };
}

function expectWireResults(protocol: ModelProtocol, wireRequest: unknown, wireIds: string[]): void {
  const wire = wireRequest as Record<string, unknown>;
  let results: Array<{ wireId: unknown; output: unknown }>;
  if (protocol === 'openai-responses') {
    results = (wire.input as Array<Record<string, unknown>>)
      .filter((item) => item.type === 'function_call_output')
      .map((item) => ({ wireId: item.call_id, output: parseJson(item.output) }));
  } else if (protocol === 'anthropic-messages') {
    results = (wire.messages as Array<Record<string, unknown>>)
      .flatMap((message) => message.content as Array<Record<string, unknown>>)
      .filter((block) => block.type === 'tool_result')
      .map((block) => ({ wireId: block.tool_use_id, output: parseJson(block.content) }));
  } else {
    results = (wire.messages as Array<Record<string, unknown>>)
      .filter((message) => message.role === 'tool')
      .map((message) => ({ wireId: message.tool_call_id, output: parseJson(message.content) }));
  }
  expect(results).toEqual(wireIds.map((wireId, index) => ({
    wireId,
    output: { result: index + 1 },
  })));
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') throw new Error('Expected a JSON string tool result');
  return JSON.parse(value);
}
