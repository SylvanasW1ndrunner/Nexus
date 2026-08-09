import { describe, expect, it } from 'vitest';
import {
  ModelProtocolError,
  type CanonicalModelRequest,
  type ModelProtocolEnvelope,
} from '../../src/types.js';
import { openAIChatCodec } from '../../src/protocol/codecs/openai-chat.js';

const origin = { connectionId: 'conn-history', model: 'm1', protocol: 'openai-chat' as const };

describe('version 2 replay indexing contract', () => {
  it('replays correlations from every committed turn envelope', () => {
    const request: CanonicalModelRequest = {
      model: 'm1',
      messages: [
        { role: 'assistant', content: [{ type: 'tool-call', callId: 'call-old', name: 'first', arguments: { n: 1 } }] },
        { role: 'tool', content: [{ type: 'tool-result', callId: 'call-old', output: { result: 1 }, isError: false }] },
        { role: 'assistant', content: [{ type: 'tool-call', callId: 'call-new', name: 'second', arguments: { n: 2 } }] },
        { role: 'tool', content: [{ type: 'tool-result', callId: 'call-new', output: { result: 2 }, isError: false }] },
      ],
    };
    const encoded = openAIChatCodec.encode(request, {
      requestId: 'history-request',
      target: origin,
      replay: {
        mode: 'same-connection',
        envelopes: [
          envelope('attempt-old', [{ callId: 'call-old', draftCallKey: 'attempt-old:0', wireIdentity: { callId: 'wire-old' }, replay: 'same-connection-only' }]),
          envelope('attempt-new', [{ callId: 'call-new', draftCallKey: 'attempt-new:0', wireIdentity: { callId: 'wire-new' }, replay: 'same-connection-only' }]),
        ],
      },
    });
    const messages = (encoded.wireRequest as { messages: Array<Record<string, unknown>> }).messages;
    const wire = JSON.stringify(messages);

    expect(wire.match(/wire-old/g)).toHaveLength(2);
    expect(wire.match(/wire-new/g)).toHaveLength(2);
    expect(encoded.correlations.map((entry) => entry.callId)).toEqual(['call-old', 'call-new']);
  });

  it('allocates one fresh wire identity for a same-connection call/result pair without a native ID', () => {
    const request: CanonicalModelRequest = {
      model: 'm1',
      messages: [
        { role: 'assistant', content: [{ type: 'tool-call', callId: 'canonical-no-wire', name: 'inspect', arguments: {} }] },
        { role: 'tool', content: [{ type: 'tool-result', callId: 'canonical-no-wire', output: { ok: true }, isError: false }] },
      ],
    };
    const encoded = openAIChatCodec.encode(request, {
      requestId: 'missing-native',
      target: origin,
      replay: {
        mode: 'same-connection',
        envelopes: [envelope('attempt-no-wire', [{
          callId: 'canonical-no-wire',
          draftCallKey: 'attempt-no-wire:0',
          replay: 'same-connection-only',
        }])],
      },
    });
    const wire = JSON.stringify(encoded.wireRequest);

    expect(wire.match(/missing-native:call:0/g)).toHaveLength(2);
    expect(wire).not.toContain('canonical-no-wire');
    expect(encoded.correlations).toEqual([expect.objectContaining({
      callId: 'canonical-no-wire',
      wireIdentity: { callId: 'missing-native:call:0' },
    })]);
  });

  it('uses request-global action ordinals across canonical messages', () => {
    const request: CanonicalModelRequest = {
      model: 'm1',
      messages: [
        { role: 'assistant', content: [{ type: 'tool-call', callId: 'call-a', name: 'a', arguments: {} }] },
        { role: 'assistant', content: [{ type: 'tool-call', callId: 'call-b', name: 'b', arguments: {} }] },
      ],
    };
    const encoded = openAIChatCodec.encode(request, {
      requestId: 'global-ordinal',
      target: origin,
      replay: { mode: 'new' },
    });

    expect(encoded.correlations.map((entry) => entry.draftCallKey)).toEqual([
      'global-ordinal:0',
      'global-ordinal:1',
    ]);
    expect(encoded.correlations.map((entry) => entry.wireIdentity)).toEqual([
      { callId: 'global-ordinal:call:0' },
      { callId: 'global-ordinal:call:1' },
    ]);
  });

  it('consumes only opaque refs that are both requested and envelope members', () => {
    const request: CanonicalModelRequest = {
      model: 'm1',
      messages: [{
        role: 'assistant',
        content: [{
          type: 'provider-opaque',
          opaqueRef: 'attempt-two:opaque:0',
          protocol: 'openai-chat',
          origin: { connectionId: 'conn-history', model: 'm1' },
          replay: 'same-connection-only',
          value: { type: 'future_part', value: 2 },
        }],
      }],
    };
    const encoded = openAIChatCodec.encode(request, {
      requestId: 'opaque-history',
      target: origin,
      replay: {
        mode: 'same-connection',
        envelopes: [
          envelope('attempt-one', [], ['attempt-one:opaque:0']),
          envelope('attempt-two', [], ['attempt-two:opaque:0', 'attempt-two:opaque:unused']),
        ],
      },
    });

    expect(encoded.opaqueBlockRefs).toEqual(['attempt-two:opaque:0']);
    expect(JSON.stringify(encoded.wireRequest)).toContain('future_part');
  });

  it('rejects an opaque ref that is not a member of any replay envelope', () => {
    const request: CanonicalModelRequest = {
      model: 'm1',
      messages: [{
        role: 'assistant',
        content: [{
          type: 'provider-opaque',
          opaqueRef: 'counterfeit:opaque:0',
          protocol: 'openai-chat',
          origin: { connectionId: 'conn-history', model: 'm1' },
          replay: 'same-connection-only',
          value: { type: 'future_part', value: 2 },
        }],
      }],
    };

    expectProtocolError(
      () => openAIChatCodec.encode(request, {
        requestId: 'opaque-counterfeit',
        target: origin,
        replay: {
          mode: 'same-connection',
          envelopes: [envelope('attempt-real', [], ['attempt-real:opaque:0'])],
        },
      }),
      'OPAQUE_REPLAY_FORBIDDEN',
    );
  });

  it('rejects an opaque ref whose owning envelope origin does not match the block origin', () => {
    const request: CanonicalModelRequest = {
      model: 'm1',
      messages: [{
        role: 'assistant',
        content: [{
          type: 'provider-opaque',
          opaqueRef: 'attempt-other-model:opaque:0',
          protocol: 'openai-chat',
          origin: { connectionId: 'conn-history', model: 'm1' },
          replay: 'same-connection-only',
          value: { type: 'future_part', value: 2 },
        }],
      }],
    };
    const mismatchedEnvelope: ModelProtocolEnvelope = {
      ...envelope('attempt-other-model', [], ['attempt-other-model:opaque:0']),
      origin: { ...origin, model: 'different-model' },
    };

    expectProtocolError(
      () => openAIChatCodec.encode(request, {
        requestId: 'opaque-origin-mismatch',
        target: origin,
        replay: { mode: 'same-connection', envelopes: [mismatchedEnvelope] },
      }),
      'OPAQUE_REPLAY_FORBIDDEN',
    );
  });
});

function envelope(
  attemptId: string,
  correlations: ModelProtocolEnvelope['correlations'],
  opaqueBlockRefs: string[] = [],
): ModelProtocolEnvelope {
  return { schemaVersion: 1, attemptId, origin, correlations, opaqueBlockRefs };
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
