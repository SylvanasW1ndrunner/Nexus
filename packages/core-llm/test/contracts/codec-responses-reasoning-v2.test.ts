import { describe, expect, it } from 'vitest';
import {
  ModelProtocolError,
  openAIChatCodec,
  openAIResponsesCodec,
  type CanonicalModelRequest,
  type ModelContentBlock,
  type ModelProtocolEnvelope,
} from '../../src/types.js';

const reasoningItem = {
  id: 'reasoning-native',
  type: 'reasoning',
  summary: [{ type: 'summary_text', text: 'Inspect the table first.' }],
  encrypted_content: 'encrypted-native',
};
const origin = {
  connectionId: 'conn-responses',
  model: 'gpt-test',
  protocol: 'openai-responses' as const,
};

describe('Responses derived reasoning projection', () => {
  it('links every public reasoning summary to its native opaque item', () => {
    const decoded = decodeReasoning();
    const summary = decoded.blocks[0];
    const opaque = decoded.blocks[1];

    expect(summary).toEqual(expect.objectContaining({
      type: 'reasoning-summary',
      text: 'Inspect the table first.',
      derivedFromOpaqueRef: 'reasoning-attempt:opaque:1',
    }));
    expect(opaque).toEqual(expect.objectContaining({
      type: 'provider-opaque',
      opaqueRef: 'reasoning-attempt:opaque:1',
      value: reasoningItem,
    }));
  });

  it('same-connection replay sends only the original native reasoning item', () => {
    const committed = committedReasoning();
    const encoded = openAIResponsesCodec.encode(committed.request, {
      requestId: 'reasoning-same',
      target: origin,
      replay: { mode: 'same-connection', envelopes: [committed.envelope] },
    });
    const input = (encoded.wireRequest as { input: unknown[] }).input;

    expect(input).toEqual([reasoningItem]);
    expect(encoded.opaqueBlockRefs).toEqual(['reasoning-attempt:opaque:1']);
  });

  it('compatible-protocol replay projects one public summary and omits native opaque state', () => {
    const committed = committedReasoning();
    const encoded = openAIChatCodec.encode(committed.request, {
      requestId: 'reasoning-cross',
      target: { connectionId: 'conn-chat', model: 'chat-model', protocol: 'openai-chat' },
      replay: { mode: 'compatible-protocol', envelopes: [committed.envelope] },
    });
    const wire = encoded.wireRequest as unknown as {
      messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
    };

    expect(wire.messages).toEqual([{
      role: 'assistant',
      content: [{ type: 'text', text: 'Inspect the table first.' }],
    }]);
    expect(encoded.opaqueBlockRefs).toEqual([]);
    expect(JSON.stringify(wire)).not.toContain('encrypted-native');
  });

  it('projects a derived summary independent of canonical block order', () => {
    const committed = committedReasoning();
    const content = committed.request.messages[0]?.content;
    if (content === undefined) throw new Error('Expected committed reasoning content');
    committed.request.messages[0]!.content = [...content].reverse();

    const encoded = openAIChatCodec.encode(committed.request, {
      requestId: 'reasoning-cross-reordered',
      target: { connectionId: 'conn-chat', model: 'chat-model', protocol: 'openai-chat' },
      replay: { mode: 'compatible-protocol', envelopes: [committed.envelope] },
    });

    expect(JSON.stringify(encoded.wireRequest)).toContain('Inspect the table first.');
    expect(JSON.stringify(encoded.wireRequest)).not.toContain('encrypted-native');
    expect(encoded.opaqueBlockRefs).toEqual([]);
  });

  it('does not project away a derived opaque block with a counterfeit envelope origin', () => {
    const committed = committedReasoning();
    committed.envelope = {
      ...committed.envelope,
      origin: { ...committed.envelope.origin, model: 'different-model' },
    };

    expectProtocolError(() => openAIChatCodec.encode(committed.request, {
        requestId: 'reasoning-counterfeit-origin',
        target: { connectionId: 'conn-chat', model: 'chat-model', protocol: 'openai-chat' },
        replay: { mode: 'compatible-protocol', envelopes: [committed.envelope] },
      }),
      'OPAQUE_REPLAY_FORBIDDEN',
    );
  });
});

function decodeReasoning() {
  return openAIResponsesCodec.decode(
    { status: 'completed', output: [reasoningItem] },
    { attemptId: 'reasoning-attempt', origin },
  );
}

function committedReasoning(): {
  request: CanonicalModelRequest;
  envelope: ModelProtocolEnvelope;
} {
  const decoded = decodeReasoning();
  return {
    request: {
      model: origin.model,
      messages: [{ role: 'assistant', content: decoded.blocks as ModelContentBlock[] }],
    },
    envelope: {
      schemaVersion: 1,
      attemptId: decoded.attemptId,
      origin,
      correlations: [],
      opaqueBlockRefs: decoded.opaqueBlockRefs,
    },
  };
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
