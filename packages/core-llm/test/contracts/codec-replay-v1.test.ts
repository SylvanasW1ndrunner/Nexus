import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ModelProtocolError,
  type AttemptDecodeContext,
  type CanonicalModelRequest,
  type CanonicalModelProtocol,
  type DecodedModelAttempt,
  type ModelContentBlock,
  type ModelEncodeContext,
  type ModelProtocol,
  type ModelProtocolCodec,
  type ModelProtocolEnvelope,
  type ModelWireIdentity,
} from '../../src/types.js';
import { anthropicMessagesCodec } from '../../src/protocol/codecs/anthropic-messages.js';
import { ollamaChatCodec } from '../../src/protocol/codecs/ollama-chat.js';
import { openAIChatCodec } from '../../src/protocol/codecs/openai-chat.js';
import { openAIResponsesCodec } from '../../src/protocol/codecs/openai-responses.js';

type CorpusCase = {
  protocol: CanonicalModelProtocol;
  response: unknown;
  expectedWireIdentity: ModelWireIdentity;
};

const corpus = JSON.parse(
  readFileSync(new URL('./fixtures/v1/codec-replay-corpus.json', import.meta.url), 'utf8'),
) as { schemaVersion: number; cases: CorpusCase[] };

const codecs: Record<CanonicalModelProtocol, ModelProtocolCodec> = {
  'openai-chat': openAIChatCodec,
  'openai-responses': openAIResponsesCodec,
  'anthropic-messages': anthropicMessagesCodec,
  'ollama-chat': ollamaChatCodec,
};

describe('version 1 provider replay corpus', () => {
  it('uses the supported corpus schema version', () => {
    expect(corpus.schemaVersion).toBe(1);
  });

  it.each(corpus.cases)('round-trips $protocol wire identity and opaque state without exposing callId', (testCase) => {
    const context = decodeContext(testCase.protocol);
    const firstAttempt = codecs[testCase.protocol].decode(testCase.response, context);
    const committed = commitForReplay(firstAttempt);
    const encoded = codecs[testCase.protocol].encode(committed.request, {
      requestId: 'same-request',
      target: context.origin,
      replay: { mode: 'same-connection', envelopes: [committed.envelope] },
    });

    expect(encoded.correlations[0]?.wireIdentity).toEqual(testCase.expectedWireIdentity);
    expect(JSON.stringify(encoded.wireRequest)).not.toContain('internal-call-0');
    const replayed = codecs[testCase.protocol].decode(
      responseFromEncoded(testCase.protocol, encoded.wireRequest),
      { ...context, attemptId: 'attempt-replayed' },
    );
    const replayedCall = replayed.blocks.find((block) => block.type === 'tool-call-draft');
    expect(replayedCall).toEqual(expect.objectContaining({ wireIdentity: testCase.expectedWireIdentity }));
    const opaqueValues = replayed.blocks
      .filter((block) => block.type === 'provider-opaque')
      .map((block) => JSON.stringify(block.value));
    for (const original of firstAttempt.blocks.filter((block) => block.type === 'provider-opaque')) {
      expect(opaqueValues).toContain(JSON.stringify(original.value));
    }
  });

  it('allocates paired target-protocol identities for compatible replay', () => {
    const first = openAIChatCodec.decode(corpus.cases[0]!.response, decodeContext('openai-chat'));
    const committed = commitForReplay(first);
    const encoded = anthropicMessagesCodec.encode(committed.request, {
      requestId: 'cross-request',
      target: { connectionId: 'conn-anthropic', model: 'claude', protocol: 'anthropic-messages' },
      replay: { mode: 'compatible-protocol', envelopes: [committed.envelope] },
    });

    expect(encoded.correlations[0]?.wireIdentity).toEqual({ callId: 'cross-request:call:0' });
    const wire = encoded.wireRequest as unknown as { messages: Array<{ content: unknown }> };
    expect(JSON.stringify(wire)).toContain('cross-request:call:0');
    expect(JSON.stringify(wire)).not.toContain('chat-wire-1');
    expect(JSON.stringify(wire)).not.toContain('internal-call-0');
  });

  it('preserves duplicate Responses call_id values when provider item IDs disambiguate them', () => {
    const decoded = openAIResponsesCodec.decode({
      status: 'completed',
      output: [
        { id: 'item-a', type: 'function_call', call_id: 'shared-call', name: 'inspect', arguments: '{"n":1}' },
        { id: 'item-b', type: 'function_call', call_id: 'shared-call', name: 'inspect', arguments: '{"n":2}' },
      ],
    }, decodeContext('openai-responses'));
    expect(decoded.blocks).toEqual([
      expect.objectContaining({ wireIdentity: { callId: 'shared-call', providerItemId: 'item-a' } }),
      expect.objectContaining({ wireIdentity: { callId: 'shared-call', providerItemId: 'item-b' } }),
    ]);
  });

  it('replays a Responses call_id when the provider omitted the optional item id', () => {
    const decoded = openAIResponsesCodec.decode({
      status: 'completed',
      output: [
        { type: 'function_call', call_id: 'call-only', name: 'inspect', arguments: '{"n":1}' },
      ],
    }, decodeContext('openai-responses'));
    const committed = commitForReplay(decoded);
    const encoded = openAIResponsesCodec.encode(committed.request, {
      requestId: 'same-request',
      target: decoded.origin,
      replay: { mode: 'same-connection', envelopes: [committed.envelope] },
    });
    const functionCall = (encoded.wireRequest as {
      input: Array<Record<string, unknown>>;
    }).input.find((item) => item.type === 'function_call');

    expect(functionCall).toEqual(expect.objectContaining({ call_id: 'call-only' }));
    expect(functionCall).not.toHaveProperty('id');
  });

  it('rejects Responses provider-item-only calls before they can enter replay state', () => {
    expectProtocolError(
      () => openAIResponsesCodec.decode({
        status: 'completed',
        output: [
          { id: 'item-shared', type: 'function_call', name: 'inspect', arguments: '{"n":1}' },
          { id: 'item-shared', type: 'function_call', name: 'inspect', arguments: '{"n":2}' },
        ],
      }, decodeContext('openai-responses')),
      'INVALID_WIRE_RESPONSE',
    );
  });

  it('preserves interleaved canonical block order in Responses wire items', () => {
    const request: CanonicalModelRequest = {
      model: 'm1',
      messages: [{
        role: 'assistant',
        content: [
          { type: 'text', text: 'before' },
          { type: 'tool-call', callId: 'internal-order', name: 'inspect', arguments: { table: 'a' } },
          { type: 'text', text: 'after' },
        ],
      }],
    };
    const encoded = openAIResponsesCodec.encode(request, freshContext('openai-responses'));
    const input = (encoded.wireRequest as {
      input: Array<{ type?: string; content?: Array<{ text?: string }> }>;
    }).input;
    expect(input.map((item) => item.type)).toEqual(['message', 'function_call', 'message']);
    expect(input[0]?.content?.[0]?.text).toBe('before');
    expect(input[2]?.content?.[0]?.text).toBe('after');
  });

  it('rejects resource references that cannot be represented on the selected wire protocol', () => {
    const request: CanonicalModelRequest = {
      model: 'm1',
      messages: [{
        role: 'user',
        content: [{ type: 'resource-ref', artifactId: 'artifact-1', mediaType: 'image/png', purpose: 'input' }],
      }],
    };
    expectProtocolError(
      () => openAIChatCodec.encode(request, freshContext('openai-chat')),
      'UNREPRESENTABLE_CANONICAL_BLOCK',
    );
  });

  it('rejects an unrepresentable Anthropic system resource instead of dropping it', () => {
    const request: CanonicalModelRequest = {
      model: 'm1',
      messages: [{
        role: 'system',
        content: [{ type: 'resource-ref', artifactId: 'artifact-system', mediaType: 'text/plain', purpose: 'input' }],
      }],
    };
    expectProtocolError(
      () => anthropicMessagesCodec.encode(request, freshContext('anthropic-messages')),
      'UNREPRESENTABLE_CANONICAL_BLOCK',
    );
  });

  it('drops incompatible opaque state on compatible fallback while preserving public projection and tool correlation', () => {
    const request: CanonicalModelRequest = {
      model: 'm1',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Public projection' },
            {
              type: 'provider-opaque',
              opaqueRef: 'opaque-source:opaque:0',
              protocol: 'openai-responses',
              origin: { connectionId: 'conn-source', model: 'reasoning-model' },
              replay: 'same-connection-only',
              value: { encrypted: 'private-native-state' },
            },
            { type: 'tool-call', callId: 'internal-call', name: 'inspect', arguments: { table: 'users' } },
          ],
        },
        {
          role: 'tool',
          content: [{ type: 'tool-result', callId: 'internal-call', output: { rows: 1 }, isError: false }],
        },
      ],
    };
    const encoded = anthropicMessagesCodec.encode(request, {
      requestId: 'opaque-cross',
      target: { connectionId: 'conn-other', model: 'claude', protocol: 'anthropic-messages' },
      replay: {
        mode: 'compatible-protocol',
        envelopes: [{
          schemaVersion: 1,
          attemptId: 'opaque-source',
          origin: { connectionId: 'conn-source', model: 'reasoning-model', protocol: 'openai-responses' },
          correlations: [{
            callId: 'internal-call',
            draftCallKey: 'opaque-source:call:0',
            wireIdentity: { callId: 'source-call', providerItemId: 'source-item' },
            replay: 'same-connection-only',
          }],
          opaqueBlockRefs: ['opaque-source:opaque:0'],
        }],
      },
    });
    const wire = JSON.stringify(encoded.wireRequest);

    expect(wire).toContain('Public projection');
    expect(wire).toContain('opaque-cross:call:0');
    expect(wire).not.toContain('private-native-state');
    expect(encoded.correlations).toEqual([
      expect.objectContaining({ callId: 'internal-call', wireIdentity: { callId: 'opaque-cross:call:0' } }),
    ]);
  });
});

function decodeContext(protocol: ModelProtocol): AttemptDecodeContext {
  return {
    attemptId: `attempt-${protocol}`,
    origin: { connectionId: `conn-${protocol}`, model: 'm1', protocol },
  };
}

function freshContext(protocol: ModelProtocol): ModelEncodeContext {
  return {
    requestId: `request-${protocol}`,
    target: { connectionId: `conn-${protocol}`, model: 'm1', protocol },
    replay: { mode: 'new' },
  };
}

function commitForReplay(attempt: DecodedModelAttempt): {
  request: CanonicalModelRequest;
  envelope: ModelProtocolEnvelope;
} {
  const correlations: ModelProtocolEnvelope['correlations'] = [];
  let actionOrdinal = 0;
  const blocks: ModelContentBlock[] = attempt.blocks.map((block) => {
    if (block.type !== 'tool-call-draft') return block;
    const callId = `internal-call-${actionOrdinal}`;
    correlations.push({
      callId,
      draftCallKey: block.draftCallKey,
      ...(block.wireIdentity === undefined ? {} : { wireIdentity: block.wireIdentity }),
      replay: 'same-connection-only',
    });
    actionOrdinal += 1;
    return { type: 'tool-call', callId, name: block.name, arguments: block.arguments };
  });
  const toolResults = correlations.map((correlation) => ({
    type: 'tool-result' as const,
    callId: correlation.callId,
    output: { ok: true },
    isError: false,
  }));
  return {
    request: {
      model: attempt.origin.model,
      messages: [
        { role: 'assistant', content: blocks },
        { role: 'tool', content: toolResults },
      ],
    },
    envelope: {
      schemaVersion: 1,
      attemptId: attempt.attemptId,
      origin: attempt.origin,
      correlations,
      opaqueBlockRefs: attempt.opaqueBlockRefs,
    },
  };
}

function responseFromEncoded(protocol: ModelProtocol, wireRequest: unknown): unknown {
  const wire = wireRequest as Record<string, unknown>;
  if (protocol === 'openai-chat') {
    const messages = wire.messages as Array<Record<string, unknown>>;
    const message = messages.find((candidate) => candidate.role === 'assistant');
    return { choices: [{ message, finish_reason: 'tool_calls' }] };
  }
  if (protocol === 'openai-responses') {
    return { status: 'completed', output: wire.input };
  }
  if (protocol === 'anthropic-messages') {
    const messages = wire.messages as Array<Record<string, unknown>>;
    const assistant = messages.find((candidate) => candidate.role === 'assistant');
    return { content: assistant?.content, stop_reason: 'tool_use' };
  }
  const messages = wire.messages as Array<Record<string, unknown>>;
  const assistant = messages.find((candidate) => candidate.role === 'assistant');
  return { message: assistant, done: true, done_reason: 'stop' };
}

function expectProtocolError(operation: () => unknown, code: ModelProtocolError['code']): void {
  let thrown: unknown;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ModelProtocolError);
  expect((thrown as ModelProtocolError).code).toBe(code);
}
