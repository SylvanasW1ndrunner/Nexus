/* eslint-disable @typescript-eslint/require-await -- concise async contract doubles. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as core from '../src/index.js';
import {
  HttpJsonTransport,
  ModelExecutionGateway,
  OpenAIChatCodec,
  OpenAIResponsesCodec,
  SseTransport,
  createBuiltinLlmProviderPlugins,
  createModelSession,
  createModelSessionBundle,
  type CanonicalModelRequest,
  type ModelClient,
  type ModelClientRequest,
  type ModelClientResponse,
  type ModelProtocolEnvelope,
  type ModelRouteSnapshotInput,
  type LlmProviderPlugin,
} from '../src/index.js';

const cleanupDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanupDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('Task 2 independent review contracts', () => {
  it('binds multi-envelope same-connection replay and returns its committable protocol envelope', async () => {
    const client = new RecordingClient(chatResponse('done'));
    const envelopes = [
      envelope('old-a', 'call-a', 'wire-a'),
      envelope('old-b', 'call-b', 'wire-b'),
    ];
    const input = {
      route: route(),
      generation: {},
      codec: new OpenAIChatCodec(),
      client,
      replay: { mode: 'same-connection' as const, envelopes },
    };
    const session = createModelSession(input);
    const result = await new ModelExecutionGateway().executeAttempt(session, replayRequest());
    const wire = JSON.stringify(client.requests[0]?.wireRequest);

    expect(wire.match(/wire-a/g)).toHaveLength(2);
    expect(wire.match(/wire-b/g)).toHaveLength(2);
    expect(result.protocolEnvelope).toMatchObject({
      schemaVersion: 1,
      correlations: [
        expect.objectContaining({ callId: 'call-a', wireIdentity: { callId: 'wire-a' } }),
        expect.objectContaining({ callId: 'call-b', wireIdentity: { callId: 'wire-b' } }),
      ],
    });
  });

  it('projects opaque state only when a digest-bound compatible fallback is in the prepared bundle', async () => {
    const primary = createModelSession({
      route: route({
        routeId: 'responses',
        protocol: 'openai-responses',
        codecRevision: 'openai-responses@1',
        allowedFallbackRouteIds: ['chat'],
      }),
      generation: {},
      codec: new OpenAIResponsesCodec(),
      client: new RejectingClient(),
      replay: { mode: 'compatible-protocol', envelopes: [opaqueEnvelope()] },
    });
    const fallbackClient = new RecordingClient(chatResponse('fallback'));
    const fallback = createModelSession({
      route: route({ routeId: 'chat', protocol: 'openai-chat' }),
      generation: {},
      codec: new OpenAIChatCodec(),
      client: fallbackClient,
      replay: { mode: 'compatible-protocol', envelopes: [opaqueEnvelope()] },
    });
    const bundle = createModelSessionBundle({ primary, fallbacks: [fallback] });

    const result = await new ModelExecutionGateway().executeAttempt(
      bundle,
      opaqueReplayRequest(),
      { maxRetries: 0 },
    );

    expect(result.session.route.routeId).toBe('chat');
    expect(JSON.stringify(fallbackClient.requests[0]?.wireRequest)).toContain('Public summary');
    expect(JSON.stringify(fallbackClient.requests[0]?.wireRequest)).not.toContain('secret-native');
  });

  it('rejects a caller-forged fallback that is not a member of an authentic prepared bundle', async () => {
    const primary = session(new RejectingClient(), { allowedFallbackRouteIds: ['forged'] });
    const forged = session(new RecordingClient(chatResponse('forged')), { routeId: 'forged' });

    await expect(new ModelExecutionGateway().executeAttempt(primary, simpleRequest(), {
      maxRetries: 0,
      fallbacks: [forged],
    })).rejects.toMatchObject({ code: 'MODEL_FALLBACK_INCOMPATIBLE' });
  });

  it('rejects cross-model fallback by default but permits an explicitly frozen policy', () => {
    const primary = session(new RecordingClient(chatResponse('primary')), {
      allowedFallbackRouteIds: ['other-model-route'],
    });
    const otherModel = createModelSession({
      route: route({ routeId: 'other-model-route', modelId: 'model-2' }),
      generation: {},
      codec: new OpenAIChatCodec(),
      client: new RecordingClient(chatResponse('fallback')),
      replay: { mode: 'compatible-protocol', envelopes: [] },
    });
    expect(() => createModelSessionBundle({ primary, fallbacks: [otherModel] })).toThrow(/model/i);
    const bundle = createModelSessionBundle({
      primary,
      fallbacks: [otherModel],
      policy: { allowCrossModel: true, allowCrossConnection: false },
    });
    expect(bundle.policy).toEqual({ allowCrossModel: true, allowCrossConnection: false });
    expect(Object.isFrozen(bundle.policy)).toBe(true);
  });

  it('keeps credentials and private client handles out of serialized session descriptors', () => {
    const headers = { authorization: 'Bearer secret-token' };
    const transport = new HttpJsonTransport({
      url: 'https://example.test/chat',
      headers,
      fetch: async () => new Response('{}'),
    });
    const modelSession = session(transport);

    expect(JSON.stringify(modelSession)).not.toContain('secret-token');
    expect(JSON.stringify(transport)).not.toContain('secret-token');
  });

  it('clones transport headers so caller mutation cannot change credentials', async () => {
    const seen: Headers[] = [];
    const headers = { authorization: 'Bearer original' };
    const transport = new HttpJsonTransport({
      url: 'https://example.test/chat',
      headers,
      fetch: async (_input, init) => {
        seen.push(new Headers(init?.headers));
        return new Response(JSON.stringify({ choices: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    headers.authorization = 'Bearer mutated';
    await transport.execute(clientRequest());

    expect(seen[0]?.get('authorization')).toBe('Bearer original');
  });

  it('derives the digest from the complete route snapshot and validates codec revision', () => {
    const first = session(new RecordingClient(chatResponse('one')));
    const second = session(new RecordingClient(chatResponse('two')), {
      capabilities: { toolCalling: 'unsupported' },
    });
    expect(first.route.metadata.digest).not.toBe(second.route.metadata.digest);
    expect(() => session(new RecordingClient(chatResponse('bad')), {
      codecRevision: 'counterfeit@999',
    })).toThrow(/codec revision/i);
  });

  it('rejects unprojected generation fields and output limits at Session creation', () => {
    expect(() => createModelSession({
      route: route({ maxOutputTokens: 64 }),
      generation: { maxOutputTokens: 65 },
      codec: new OpenAIChatCodec(),
      client: new RecordingClient(chatResponse('bad')),
    })).toThrow(/maxOutputTokens/i);
    expect(() => createModelSession({
      route: route(),
      generation: { seed: 7 },
      codec: new OpenAIChatCodec(),
      client: new RecordingClient(chatResponse('bad')),
    })).toThrow(/seed/i);
    expect(() => createModelSession({
      route: route(),
      generation: { reasoningEffort: 'high' },
      codec: new OpenAIChatCodec(),
      client: new RecordingClient(chatResponse('bad')),
    })).toThrow(/reasoningEffort/i);
  });

  it('uses canonical protocol IDs in every builtin manifest', () => {
    expect(createBuiltinLlmProviderPlugins().map((plugin) => plugin.manifest.protocol)).toEqual([
      'ollama-chat',
      'anthropic-messages',
      'openai-responses',
      'openai-chat',
    ]);
  });

  it.each([429, 502, 503, 504])(
    'classifies plain-text HTTP %s before best-effort error parsing and preserves Retry-After',
    async (status) => {
      const transport = new HttpJsonTransport({
        url: 'https://example.test/chat',
        fetch: async () => new Response('<html>busy</html>', {
          status,
          headers: { 'content-type': 'text/html', 'retry-after': '3' },
        }),
      });
      await expect(transport.execute(clientRequest())).rejects.toMatchObject({
        code: 'HTTP_ERROR',
        statusCode: status,
        retryable: true,
        retryAfter: '3',
      });
    },
  );

  it('does not turn a permanent SSE frame limit failure into a retryable disconnect', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${'x'.repeat(128)}\n\n`));
        controller.close();
      },
    });
    const transport = new SseTransport({
      url: 'https://example.test/stream',
      streamLimits: { maxSseFrameBytes: 32 },
      fetch: async () => new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    });
    const response = await transport.execute(clientRequest());
    if (response.kind !== 'stream') throw new Error('Expected stream');

    await expect(collect(response.events)).rejects.toMatchObject({ retryable: false });
  });

  it('routes the legacy LlmGateway compatibility API through ModelExecutionGateway', async () => {
    const executeAttempt = vi.spyOn(ModelExecutionGateway.prototype, 'executeAttempt');
    const gateway = new core.LlmGateway();
    gateway.registerProvider({
      id: 'legacy',
      name: 'legacy',
      mode: 'byok',
      chat: async () => ({ text: 'ok', toolCalls: [] }),
      isAvailable: async () => ({ available: true }),
    }, [{ model: 'm' }]);

    await gateway.chat({
      providerId: 'legacy',
      request: { model: 'm', messages: [{ role: 'user', content: 'hello' }] },
      context: { tenantId: 't', taskType: 'compatibility' },
      maxRetries: 0,
      maxFallbacks: 0,
    });

    expect(executeAttempt).toHaveBeenCalledTimes(1);
    executeAttempt.mockRestore();
  });

  it('keeps ConnectionManager as preparation-only and bypasses legacy LlmGateway execution', async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), 'task2-single-spine-'));
    cleanupDirectories.push(cacheDirectory);
    const oldExecute = vi.spyOn(core.LlmGateway.prototype, 'execute');
    const executeAttempt = vi.spyOn(ModelExecutionGateway.prototype, 'executeAttempt');
    const manager = new core.LlmConnectionManager({
      cacheDirectory,
      plugins: [managerPlugin()],
      fetch: async () => new Response(JSON.stringify({
        choices: [{ message: { content: 'canonical' }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    const [connection] = manager.replaceConnections([{ endpoint: 'https://manager.test/v1' }]);

    const result = await manager.executeChat({
      selection: { connectionId: connection!.id, modelId: 'model-1' },
      request: { messages: [{ role: 'user', content: 'hello' }] },
      context: { tenantId: 't', taskType: 'single-spine' },
    });

    expect(result.response.text).toBe('canonical');
    expect(oldExecute).not.toHaveBeenCalled();
    expect(executeAttempt).toHaveBeenCalledTimes(1);
    oldExecute.mockRestore();
    executeAttempt.mockRestore();
  });

  it('waits for bounded iterator abort acknowledgement before completing a timeout', async () => {
    let acknowledged = false;
    const events: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<unknown>>(() => undefined),
          return: async () => {
            await new Promise((resolve) => setTimeout(resolve, 15));
            acknowledged = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const streamClient: ModelClient = {
      execute: async () => ({ kind: 'stream', events }),
    };

    await expect(new ModelExecutionGateway().executeAttempt(session(streamClient), simpleRequest(), {
      maxRetries: 0,
      timeouts: { connectMs: 50, firstEventMs: 5, idleMs: 50, totalMs: 100 },
    })).rejects.toMatchObject({ code: 'MODEL_TIMEOUT', phase: 'first-event' });
    expect(acknowledged).toBe(true);
  });
});

class RecordingClient implements ModelClient {
  readonly requests: ModelClientRequest[] = [];
  constructor(private readonly response: ModelClientResponse) {}
  execute(request: ModelClientRequest): Promise<ModelClientResponse> {
    this.requests.push(request);
    return Promise.resolve(this.response);
  }
}

class RejectingClient implements ModelClient {
  execute(): Promise<ModelClientResponse> {
    return Promise.reject(new core.ModelClientError('HTTP_ERROR', 'unavailable', {
      retryable: true,
      statusCode: 503,
    }));
  }
}

function session(client: ModelClient, overrides: Partial<ModelRouteSnapshotInput> = {}) {
  return createModelSession({
    route: route(overrides),
    generation: {},
    codec: new OpenAIChatCodec(),
    client,
  });
}

function route(overrides: Partial<ModelRouteSnapshotInput> = {}): ModelRouteSnapshotInput {
  return {
    routeId: 'primary',
    connectionId: 'connection-1',
    providerId: 'provider-1',
    modelId: 'model-1',
    protocol: 'openai-chat',
    codecRevision: 'openai-chat@1',
    capabilities: { toolCalling: 'supported', streaming: 'supported' },
    contextTokens: 8_192,
    maxInputTokens: 7_000,
    maxOutputTokens: 1_024,
    metadata: { source: 'fixture', revision: 'route-1', digest: 'caller-controlled' },
    allowedFallbackRouteIds: [],
    compatibility: { mode: 'compatible-protocol', family: 'family-1' },
    ...overrides,
  };
}

function envelope(attemptId: string, callId: string, wireId: string): ModelProtocolEnvelope {
  return {
    schemaVersion: 1,
    attemptId,
    origin: { connectionId: 'connection-1', model: 'model-1', protocol: 'openai-chat' },
    correlations: [{
      callId,
      draftCallKey: `${attemptId}:0`,
      wireIdentity: { callId: wireId },
      replay: 'same-connection-only',
    }],
    opaqueBlockRefs: [],
  };
}

function opaqueEnvelope(): ModelProtocolEnvelope {
  return {
    schemaVersion: 1,
    attemptId: 'opaque-attempt',
    origin: { connectionId: 'connection-1', model: 'model-1', protocol: 'openai-responses' },
    correlations: [],
    opaqueBlockRefs: ['opaque-attempt:opaque:0'],
  };
}

function replayRequest(): CanonicalModelRequest {
  return {
    model: 'model-1',
    messages: [
      { role: 'assistant', content: [{ type: 'tool-call', callId: 'call-a', name: 'a', arguments: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', callId: 'call-a', output: { ok: 1 }, isError: false }] },
      { role: 'assistant', content: [{ type: 'tool-call', callId: 'call-b', name: 'b', arguments: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', callId: 'call-b', output: { ok: 2 }, isError: false }] },
    ],
  };
}

function opaqueReplayRequest(): CanonicalModelRequest {
  return {
    model: 'model-1',
    messages: [{
      role: 'assistant',
      content: [
        { type: 'reasoning-summary', text: 'Public summary', derivedFromOpaqueRef: 'opaque-attempt:opaque:0' },
        {
          type: 'provider-opaque',
          opaqueRef: 'opaque-attempt:opaque:0',
          protocol: 'openai-responses',
          origin: { connectionId: 'connection-1', model: 'model-1' },
          replay: 'same-connection-only',
          value: { encrypted: 'secret-native' },
        },
      ],
    }],
  };
}

function simpleRequest(): CanonicalModelRequest {
  return { model: 'model-1', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] };
}

function chatResponse(text: string): ModelClientResponse {
  return {
    kind: 'json',
    response: { choices: [{ message: { content: text }, finish_reason: 'stop' }] },
  };
}

function clientRequest(): ModelClientRequest {
  return {
    attemptId: 'attempt-1',
    route: session(new RecordingClient(chatResponse('unused'))).route,
    wireRequest: { model: 'model-1', messages: [] },
    signal: new AbortController().signal,
  };
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const event of events) values.push(event);
  return values;
}

function managerPlugin(): LlmProviderPlugin {
  return {
    manifest: {
      id: 'manager-openai-chat',
      name: 'Manager OpenAI Chat',
      version: '1.0.0',
      protocol: 'openai-chat',
      priority: 100,
    },
    match: () => ({ score: 100, evidence: [] }),
    discover: () => Promise.resolve({ score: 100, models: ['model-1'], evidence: [] }),
    createProvider: ({ resolution }) => ({
      id: resolution.providerId,
      name: 'manager provider',
      mode: 'byok',
      listModels: () => Promise.resolve(['model-1']),
      getModelMetadata: () => Promise.resolve({
        model: 'model-1',
        source: 'provider-api',
        capabilities: { chat: 'supported', streaming: 'supported' },
        contextTokens: 8_192,
        maxInputTokens: 7_000,
        maxOutputTokens: 1_024,
      }),
      chat: () => Promise.resolve({ text: 'legacy', toolCalls: [] }),
      isAvailable: () => Promise.resolve({ available: true }),
    }),
  };
}
