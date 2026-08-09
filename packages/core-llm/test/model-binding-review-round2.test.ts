import { describe, expect, it } from 'vitest';
import * as core from '../src/index.js';
import {
  MODEL_PROTOCOL_CODEC_REVISIONS,
  ModelExecutionGateway,
  createModelSession,
  describeModelSession,
  resolveModelProtocolCodec,
  type CanonicalModelRequest,
  type ModelClient,
  type ModelClientResponse,
  type ModelProtocolCodec,
  type ModelRouteSnapshotInput,
} from '../src/index.js';
import { legacyProviderCodec } from '../src/legacy-model-compatibility.js';
import {
  OpenAIChatCodec,
  openAIChatCodec,
} from '../src/protocol/codecs/openai-chat.js';

describe('Task 2 round-two binding and replay invariants', () => {
  it('does not publish request replay correlations as a current response Envelope', async () => {
    const client = new StaticClient({
      kind: 'json',
      response: {
        choices: [{
          message: {
            content: '',
            tool_calls: [{ id: 'new-wire', type: 'function', function: { name: 'next', arguments: '{}' } }],
          },
          finish_reason: 'tool_calls',
        }],
      },
    });
    const session = createModelSession({
      route: route(),
      generation: {},
      codec: openAIChatCodec,
      client,
      replay: {
        mode: 'same-connection',
        envelopes: [{
          schemaVersion: 1,
          attemptId: 'historical-attempt',
          origin: { connectionId: 'connection-1', model: 'model-1', protocol: 'openai-chat' },
          correlations: [{
            callId: 'historical-call',
            draftCallKey: 'historical-attempt:0',
            wireIdentity: { callId: 'historical-wire' },
            replay: 'same-connection-only',
          }],
          opaqueBlockRefs: ['historical-opaque'],
        }],
      },
    });
    const result = await new ModelExecutionGateway().executeAttempt(session, {
      model: 'model-1',
      messages: [
        { role: 'assistant', content: [{ type: 'tool-call', callId: 'historical-call', name: 'old', arguments: {} }] },
        { role: 'tool', content: [{ type: 'tool-result', callId: 'historical-call', output: {}, isError: false }] },
      ],
    });

    expect(result).not.toHaveProperty('protocolEnvelope');
    expect(result.attempt.blocks).toEqual([
      expect.objectContaining({
        type: 'tool-call-draft',
        wireIdentity: { callId: 'new-wire' },
      }),
    ]);
    expect(JSON.stringify(result.attempt)).not.toContain('historical-opaque');
  });

  it('publishes exact stable revisions on the four registered canonical codecs', () => {
    expect(openAIChatCodec.revision).toBe('openai-chat@1');
    expect(Object.keys(MODEL_PROTOCOL_CODEC_REVISIONS)).toHaveLength(4);
    expect(resolveModelProtocolCodec('openai-chat', 'openai-chat@1')).toBe(openAIChatCodec);
  });

  it('rejects a counterfeit codec object even when protocol and revision strings match', () => {
    const real = new OpenAIChatCodec();
    const counterfeit = {
      protocol: 'openai-chat' as const,
      revision: 'openai-chat@1',
      encode: real.encode.bind(real),
      decode: real.decode.bind(real),
      decodeStream: real.decodeStream.bind(real),
    } as ModelProtocolCodec;

    expect(() => createModelSession({
      route: route(),
      generation: {},
      codec: counterfeit,
      client: new StaticClient(chatResponse('unused')),
    })).toThrow(/exact registered singleton/i);
  });

  it('fails unknown protocols with a typed codec-unavailable error', () => {
    let caught: unknown;
    try {
      resolveModelProtocolCodec('mystery-protocol', 'mystery@1');
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'MODEL_CODEC_UNAVAILABLE' });
  });

  it('keeps the normalized legacy edge protocol out of replay and canonical fallback', () => {
    expect(() => createModelSession({
      route: route({ protocol: 'legacy-normalized', codecRevision: 'legacy-normalized@1' }),
      generation: {},
      codec: legacyProviderCodec,
      client: new StaticClient(chatResponse('unused')),
      replay: { mode: 'compatible-protocol', envelopes: [] },
    })).toThrow(/legacy-normalized|replay/i);
  });

  it('rejects canonical blocks the normalized legacy edge cannot preserve', async () => {
    const session = createModelSession({
      route: route({
        protocol: 'legacy-normalized',
        codecRevision: 'legacy-normalized@1',
      }),
      generation: {},
      codec: legacyProviderCodec,
      client: new StaticClient(chatResponse('should not execute')),
    });
    await expect(new ModelExecutionGateway().executeAttempt(session, {
      model: 'model-1',
      messages: [{
        role: 'user',
        content: [{ type: 'resource-ref', artifactId: 'artifact-1', mediaType: 'text/plain', purpose: 'input' }],
      }],
    })).rejects.toMatchObject({ code: 'MODEL_PROTOCOL_FAILED' });
  });

  it('does not cross provider or model boundaries unless the caller explicitly opts in', async () => {
    let fallbackCalls = 0;
    const gateway = new core.LlmGateway();
    gateway.registerProvider({
      id: 'primary', name: 'primary', mode: 'byok',
      chat: () => Promise.reject(new core.LlmProviderError('LLM_TIMEOUT', 'timeout', true)),
      isAvailable: () => Promise.resolve({ available: true }),
    }, [{ model: 'primary-model', quality: 'advanced' }]);
    gateway.registerProvider({
      id: 'fallback', name: 'fallback', mode: 'byok',
      chat: () => {
        fallbackCalls += 1;
        return Promise.resolve({ text: 'fallback', toolCalls: [] });
      },
      isAvailable: () => Promise.resolve({ available: true }),
    }, [{ model: 'fallback-model', quality: 'balanced' }]);

    await expect(gateway.execute({
      request: { messages: [{ role: 'user', content: 'hello' }] },
      context: { tenantId: 'tenant', taskType: 'review' },
      task: { preferences: { optimizeFor: 'quality' } },
      maxRetries: 0,
      maxFallbacks: 1,
    })).rejects.toBeDefined();
    expect(fallbackCalls).toBe(0);
  });

  it('does not persist a Session whose client was not bound by trusted connection preparation', () => {
    const original = session(new StaticClient(chatResponse('original')));
    expectErrorCode(
      () => describeModelSession(original),
      'MODEL_CLIENT_BINDING_REQUIRED',
    );
  });

  it('does not persist a bundle containing unbound private clients', () => {
    const primary = createModelSession({
      route: route({ allowedFallbackRouteIds: ['route-2'] }),
      generation: {},
      codec: openAIChatCodec,
      client: new StaticClient(chatResponse('primary')),
    });
    const fallback = createModelSession({
      route: route({ routeId: 'route-2' }),
      generation: {},
      codec: openAIChatCodec,
      client: new StaticClient(chatResponse('fallback')),
      replay: { mode: 'compatible-protocol', envelopes: [] },
    });
    const bundle = core.createModelSessionBundle({
      primary,
      fallbacks: [fallback],
      policy: { allowCrossConnection: false, allowCrossModel: false },
    });
    expectErrorCode(
      () => core.describeModelSessionBundle(bundle),
      'MODEL_CLIENT_BINDING_REQUIRED',
    );
  });

  it('rejects a structurally forged bare Session that was not factory-bound or rehydrated', async () => {
    const authentic = session(new StaticClient(chatResponse('authentic')));
    const forged = Object.freeze({
      route: authentic.route,
      generation: authentic.generation,
      replay: authentic.replay,
      bindingDigest: authentic.bindingDigest,
      codec: authentic.codec,
      client: authentic.client,
    });

    await expect(new ModelExecutionGateway().executeAttempt(
      forged,
      simpleRequest(),
      { maxRetries: 0 },
    )).rejects.toMatchObject({ code: 'MODEL_SESSION_INVALID' });
  });

  it('waits for total-timeout iterator cleanup before retrying the next attempt', async () => {
    let cleanupAcknowledged = false;
    let overlapObserved = false;
    let calls = 0;
    const client: ModelClient = {
      execute: () => {
        calls += 1;
        if (calls === 2) {
          overlapObserved = !cleanupAcknowledged;
          return Promise.resolve(chatResponse('second'));
        }
        const events: AsyncIterable<unknown> = {
          [Symbol.asyncIterator]() {
            return {
              next: () => new Promise<IteratorResult<unknown>>(() => undefined),
              return: async () => {
                await new Promise((resolve) => setTimeout(resolve, 15));
                cleanupAcknowledged = true;
                return { done: true, value: undefined };
              },
            };
          },
        };
        return Promise.resolve({ kind: 'stream' as const, events });
      },
    };
    const gateway = new ModelExecutionGateway({
      clock: { now: Date.now, sleep: () => Promise.resolve() },
      random: () => 0,
    });

    const result = await gateway.executeAttempt(session(client), simpleRequest(), {
      maxRetries: 1,
      timeouts: { connectMs: 100, firstEventMs: 100, idleMs: 100, totalMs: 5 },
    });
    expect(result.attempt.blocks).toEqual([{ type: 'text', text: 'second' }]);
    expect(cleanupAcknowledged).toBe(true);
    expect(overlapObserved).toBe(false);
  });

  it('also waits for cleanup when total timeout wins after the first stream event', async () => {
    let cleanupAcknowledged = false;
    let overlapObserved = false;
    let calls = 0;
    const client: ModelClient = {
      execute: () => {
        calls += 1;
        if (calls === 2) {
          overlapObserved = !cleanupAcknowledged;
          return Promise.resolve(chatResponse('second'));
        }
        let emitted = false;
        const events: AsyncIterable<unknown> = {
          [Symbol.asyncIterator]() {
            return {
              next: () => {
                if (!emitted) {
                  emitted = true;
                  return Promise.resolve({
                    done: false as const,
                    value: { choices: [{ delta: { content: 'partial' }, finish_reason: null }] },
                  });
                }
                return new Promise<IteratorResult<unknown>>(() => undefined);
              },
              return: async () => {
                await new Promise((resolve) => setTimeout(resolve, 15));
                cleanupAcknowledged = true;
                return { done: true as const, value: undefined };
              },
            };
          },
        };
        return Promise.resolve({ kind: 'stream' as const, events });
      },
    };
    const result = await new ModelExecutionGateway({
      clock: { now: Date.now, sleep: () => Promise.resolve() },
      random: () => 0,
    }).executeAttempt(session(client), simpleRequest(), {
      maxRetries: 1,
      timeouts: { connectMs: 100, firstEventMs: 100, idleMs: 100, totalMs: 5 },
    });

    expect(result.attempt.blocks).toEqual([{ type: 'text', text: 'second' }]);
    expect(result.discardedAttempts[0]?.blocks).toEqual([{ type: 'text', text: 'partial' }]);
    expect(cleanupAcknowledged).toBe(true);
    expect(overlapObserved).toBe(false);
  });
});

class StaticClient implements ModelClient {
  constructor(private readonly response: ModelClientResponse) {}
  execute(): Promise<ModelClientResponse> {
    return Promise.resolve(this.response);
  }
}

function expectErrorCode(operation: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error & { readonly code?: unknown }).code).toBe(code);
}

function session(client: ModelClient) {
  return createModelSession({
    route: route(),
    generation: {},
    codec: openAIChatCodec,
    client,
  });
}

function route(overrides: Partial<ModelRouteSnapshotInput> = {}): ModelRouteSnapshotInput {
  return {
    routeId: 'route-1',
    connectionId: 'connection-1',
    providerId: 'provider-1',
    modelId: 'model-1',
    protocol: 'openai-chat',
    codecRevision: 'openai-chat@1',
    capabilities: { chat: 'supported', toolCalling: 'supported', streaming: 'supported' },
    generationParameters: {},
    contextTokens: 8_192,
    maxInputTokens: 4_096,
    maxOutputTokens: 1_024,
    metadata: { source: 'fixture', revision: 'route-v1', digest: 'ignored' },
    compatibility: { mode: 'compatible-protocol', family: 'fixture-v1' },
    ...overrides,
  };
}

function simpleRequest(): CanonicalModelRequest {
  return {
    model: 'model-1',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  };
}

function chatResponse(text: string): ModelClientResponse {
  return {
    kind: 'json',
    response: {
      choices: [{ message: { content: text }, finish_reason: 'stop' }],
    },
  };
}
