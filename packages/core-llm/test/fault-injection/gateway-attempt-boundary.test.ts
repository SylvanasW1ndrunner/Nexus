/* eslint-disable @typescript-eslint/require-await, require-yield -- deterministic async transport scripts exercise real gateway scheduling. */
import { describe, expect, it } from 'vitest';
import {
  ModelClientError,
  ModelExecutionGateway,
  assertAuthenticValidatedModelAttempt,
  OpenAICompatibleProvider,
  createModelSession,
  createModelSessionBundle,
  type CanonicalModelRequest,
  type ModelClient,
  type ModelClientRequest,
  type ModelClientResponse,
  type ModelRouteSnapshotInput,
  type ModelSession,
} from '../../src/index.js';
import { openAIChatCodec } from '../../src/protocol/codecs/openai-chat.js';
import { openAIResponsesCodec } from '../../src/protocol/codecs/openai-responses.js';

describe('ModelExecutionGateway attempt boundary', () => {
  it('mints validated attempts that cannot be counterfeited structurally', async () => {
    const result = await gateway().executeAttempt(
      session(new ScriptedModelClient([staticChat('authentic')])),
      request(),
    );
    expect(() => assertAuthenticValidatedModelAttempt(result.attempt)).not.toThrow();
    expect(() => assertAuthenticValidatedModelAttempt(structuredClone(result.attempt)))
      .toThrow(/authentic/i);
  });

  it('recursively freezes every mutable nested attempt value before authenticity minting', async () => {
    const result = await gateway().executeAttempt(
      responsesSession(new ScriptedModelClient([{
        kind: 'json',
        response: {
          id: 'nested-authentic', status: 'completed', output: [
            { id: 'tool-nested', type: 'function_call', call_id: 'wire-nested',
              name: 'inspect', arguments: '{"nested":{"limit":3}}' },
            { id: 'reasoning-nested', type: 'reasoning', summary: [],
              encrypted_content: { nested: { token: 'opaque' } } },
          ],
        },
      }])),
      request(),
    );
    const tool = result.attempt.blocks[0];
    expect(tool?.type).toBe('tool-call-draft');
    if (tool?.type !== 'tool-call-draft') throw new Error('Expected tool draft');
    expect(Object.isFrozen(tool)).toBe(true);
    expect(Object.isFrozen(tool.arguments)).toBe(true);
    expect(Object.isFrozen((tool.arguments as { nested: object }).nested)).toBe(true);
    expect(Object.isFrozen(tool.wireIdentity)).toBe(true);
    const opaque = result.attempt.blocks.find((block) => block.type === 'provider-opaque');
    expect(opaque?.type).toBe('provider-opaque');
    if (opaque?.type !== 'provider-opaque') throw new Error('Expected provider opaque block');
    expect(Object.isFrozen(opaque.value)).toBe(true);
    expect(Reflect.set((tool.arguments as { nested: object }).nested, 'limit', 99)).toBe(false);
    expect(Reflect.set(tool.wireIdentity as object, 'callId', 'mutated-wire')).toBe(false);
    expect(Reflect.set(
      (opaque.value as { encrypted_content: { nested: object } }).encrypted_content.nested,
      'token',
      'mutated-opaque',
    )).toBe(false);
    expect(() => assertAuthenticValidatedModelAttempt(result.attempt)).not.toThrow();
  });
  it('discards a partial attempt before retrying and commits only one validated attempt', async () => {
    const client = new ScriptedModelClient([
      streamResponse(async function* () {
        yield chatDelta('partial');
        throw new ModelClientError('STREAM_DISCONNECTED', 'socket closed', {
          retryable: true,
        });
      }),
      streamResponse(async function* () {
        yield chatDelta('final', 'stop');
      }),
    ]);
    const result = await gateway().executeAttempt(session(client), request(), { maxRetries: 1 });

    expect(result.attempt.blocks).toEqual([{ type: 'text', text: 'final' }]);
    expect(result.attempt.validation).toBe('validated');
    expect(result.discardedAttempts).toHaveLength(1);
    expect(result.discardedAttempts[0]?.reason).toBe('STREAM_DISCONNECTED');
    expect(result.discardedAttempts[0]?.blocks).toEqual([{ type: 'text', text: 'partial' }]);
    expect(result.attempt.blocks).not.toContainEqual({ type: 'text', text: 'partial' });
  });

  it.each([429, 502, 503, 504])('retries classified transient HTTP %s exactly once', async (status) => {
    const client = new ScriptedModelClient([
      () => Promise.reject(new ModelClientError('HTTP_ERROR', `HTTP ${status}`, {
        retryable: true,
        statusCode: status,
      })),
      staticChat('recovered'),
    ]);

    const result = await gateway().executeAttempt(session(client), request(), { maxRetries: 1 });

    expect(result.attempt.blocks).toEqual([{ type: 'text', text: 'recovered' }]);
    expect(result.discardedAttempts.map((attempt) => attempt.reason)).toEqual([`HTTP_${status}`]);
    expect(client.calls).toBe(2);
  });

  it('respects Retry-After over injected exponential backoff and jitter', async () => {
    const sleeps: number[] = [];
    const client = new ScriptedModelClient([
      () => Promise.reject(new ModelClientError('HTTP_ERROR', 'limited', {
        retryable: true,
        statusCode: 429,
        retryAfterMs: 750,
      })),
      staticChat('ok'),
    ]);
    const executionGateway = gateway({
      random: () => 1,
      clock: {
        now: () => 1_000,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
      },
    });

    await executionGateway.executeAttempt(session(client), request(), {
      maxRetries: 1,
      retry: { baseDelayMs: 100, maxDelayMs: 2_000, jitterRatio: 0.25 },
    });

    expect(sleeps).toEqual([750]);
  });

  it('computes exponential retries from the injected random and clock', async () => {
    const sleeps: number[] = [];
    const client = new ScriptedModelClient([
      () => Promise.reject(new ModelClientError('HTTP_ERROR', 'busy-1', {
        retryable: true,
        statusCode: 503,
      })),
      () => Promise.reject(new ModelClientError('HTTP_ERROR', 'busy-2', {
        retryable: true,
        statusCode: 503,
      })),
      staticChat('ok'),
    ]);

    await gateway({
      random: () => 0,
      clock: { now: () => 5_000, sleep: async (milliseconds) => { sleeps.push(milliseconds); } },
    }).executeAttempt(session(client), request(), {
      maxRetries: 2,
      retry: { baseDelayMs: 100, maxDelayMs: 1_000, jitterRatio: 0.2 },
    });

    expect(sleeps).toEqual([80, 160]);
  });

  it('parses an HTTP-date Retry-After value against the injected clock', async () => {
    const sleeps: number[] = [];
    const client = new ScriptedModelClient([
      () => Promise.reject(new ModelClientError('HTTP_ERROR', 'limited', {
        retryable: true,
        statusCode: 429,
        retryAfter: 'Wed, 21 Oct 2015 07:28:00 GMT',
      })),
      staticChat('ok'),
    ]);

    await gateway({
      clock: {
        now: () => Date.parse('Wed, 21 Oct 2015 07:27:58 GMT'),
        sleep: async (milliseconds) => { sleeps.push(milliseconds); },
      },
    }).executeAttempt(session(client), request(), {
      maxRetries: 1,
      retry: { baseDelayMs: 100, maxDelayMs: 5_000, jitterRatio: 0 },
    });

    expect(sleeps).toEqual([2_000]);
  });

  it.each([
    ['connect', hangingConnectClient(), { connectMs: 15, firstEventMs: 100, idleMs: 100, totalMs: 100 }],
    ['first-event', streamClient(hangingStream()), { connectMs: 100, firstEventMs: 15, idleMs: 100, totalMs: 100 }],
    ['idle', streamClient(firstThenHang()), { connectMs: 100, firstEventMs: 100, idleMs: 15, totalMs: 100 }],
    ['total', streamClient(eventsWithoutFinish()), { connectMs: 100, firstEventMs: 100, idleMs: 100, totalMs: 15 }],
  ] as const)('classifies the %s timeout independently', async (phase, client, timeouts) => {
    await expect(gateway().executeAttempt(session(client), request(), {
      maxRetries: 0,
      timeouts,
    })).rejects.toMatchObject({ code: 'MODEL_TIMEOUT', phase, retryable: true });
  });

  it('cancels during the durable attempt-start boundary without calling the client', async () => {
    const controller = new AbortController();
    let releaseStarted!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseStarted = resolve; });
    const client = new ScriptedModelClient([staticChat('must not run')]);
    const pending = gateway().executeAttempt(session(client), request(), {
      maxRetries: 3,
      signal: controller.signal,
      timeouts: { connectMs: 1_000, firstEventMs: 1_000, idleMs: 1_000, totalMs: 1_000 },
      observer: {
        async onEvent(event) {
          if (event.type !== 'attempt-started') return;
          markStarted();
          await release;
        },
      },
    });

    await started;
    controller.abort(new Error('user cancelled'));
    releaseStarted();

    await expect(pending).rejects.toMatchObject({ code: 'MODEL_CANCELLED', retryable: false });
    expect(client.calls).toBe(0);
  });

  it('propagates cancellation after client execution begins and never retries it', async () => {
    const controller = new AbortController();
    let transportAborted = false;
    let markClientStarted!: () => void;
    const clientStarted = new Promise<void>((resolve) => { markClientStarted = resolve; });
    const client = new ScriptedModelClient([
      (input) => new Promise<ModelClientResponse>((_, reject) => {
        input.signal.addEventListener('abort', () => {
          transportAborted = true;
          reject(input.signal.reason instanceof Error
            ? input.signal.reason
            : new Error(String(input.signal.reason)));
        }, { once: true });
        markClientStarted();
      }),
    ]);
    const pending = gateway().executeAttempt(session(client), request(), {
      maxRetries: 3,
      signal: controller.signal,
      timeouts: { connectMs: 1_000, firstEventMs: 1_000, idleMs: 1_000, totalMs: 1_000 },
    });

    await clientStarted;
    controller.abort(new Error('user cancelled'));

    await expect(pending).rejects.toMatchObject({ code: 'MODEL_CANCELLED', retryable: false });
    expect(transportAborted).toBe(true);
    expect(client.calls).toBe(1);
  });

  it('normalizes cancellation during gateway-owned retry backoff', async () => {
    const controller = new AbortController();
    let markBackoffStarted!: () => void;
    const backoffStarted = new Promise<void>((resolve) => {
      markBackoffStarted = resolve;
    });
    const client = new ScriptedModelClient([
      () => Promise.reject(new ModelClientError('HTTP_ERROR', 'busy', {
        retryable: true,
        statusCode: 503,
      })),
      staticChat('must not run'),
    ]);
    const executionGateway = gateway({
      clock: {
        now: Date.now,
        sleep: (_milliseconds, signal) => new Promise<void>((_, reject) => {
          markBackoffStarted();
          signal?.addEventListener('abort', () => reject(new Error('backoff aborted')), {
            once: true,
          });
        }),
      },
    });
    const pending = executionGateway.executeAttempt(session(client), request(), {
      maxRetries: 1,
      signal: controller.signal,
    });
    await backoffStarted;

    controller.abort(new Error('user cancelled'));

    await expect(pending).rejects.toMatchObject({ code: 'MODEL_CANCELLED', retryable: false });
    expect(client.calls).toBe(1);
  });

  it('uses only an explicit route-compatible fallback after the primary is discarded', async () => {
    const primary = session(new ScriptedModelClient([
      () => Promise.reject(new ModelClientError('HTTP_ERROR', 'unavailable', {
        retryable: true,
        statusCode: 503,
      })),
    ]), { allowedFallbackRouteIds: ['responses-route'] });
    const fallbackClient = new ScriptedModelClient([
      {
        kind: 'json',
        response: {
          id: 'response-2',
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'fallback' }] }],
        },
      },
    ]);
    const fallback = createModelSession({
      route: {
        ...route({ routeId: 'responses-route', protocol: 'openai-responses' }),
        codecRevision: 'openai-responses@1',
        compatibility: { mode: 'compatible-protocol', family: 'openai-tools-v1' },
      },
      generation: {},
      codec: openAIResponsesCodec,
      client: fallbackClient,
      replay: { mode: 'compatible-protocol', envelopes: [] },
    });

    const bundle = createModelSessionBundle({ primary, fallbacks: [fallback] });
    const result = await gateway().executeAttempt(bundle, request(), { maxRetries: 0 });

    expect(result.session.route.routeId).toBe('responses-route');
    expect(result.attempt.blocks).toEqual([{ type: 'text', text: 'fallback' }]);
    expect(result.discardedAttempts.map((attempt) => attempt.reason)).toEqual(['HTTP_503']);
  });

  it('rejects an undeclared fallback before invoking its client', async () => {
    const primary = session(new ScriptedModelClient([
      () => Promise.reject(new ModelClientError('HTTP_ERROR', 'unavailable', {
        retryable: true,
        statusCode: 503,
      })),
    ]));
    const fallbackClient = new ScriptedModelClient([staticChat('must not run')]);
    const fallback = session(fallbackClient, { routeId: 'undeclared-route' });

    await expect(gateway().executeAttempt(primary, request(), {
      maxRetries: 0,
      fallbacks: [fallback],
    })).rejects.toMatchObject({ code: 'MODEL_FALLBACK_INCOMPATIBLE', retryable: false });
    expect(fallbackClient.calls).toBe(0);
  });

  it('does not retry a codec decode failure', async () => {
    const client = new ScriptedModelClient([
      { kind: 'json', response: { choices: 'invalid' } },
      staticChat('must not run'),
    ]);

    await expect(gateway().executeAttempt(session(client), request(), {
      maxRetries: 3,
    })).rejects.toMatchObject({ code: 'MODEL_PROTOCOL_FAILED', retryable: false });
    expect(client.calls).toBe(1);
  });

  it('keeps retry ownership out of legacy provider adapters', async () => {
    let fetchCalls = 0;
    const provider = new OpenAICompatibleProvider({
      id: 'single-call-provider',
      name: 'Single call provider',
      apiKey: 'test-key',
      baseUrl: 'https://provider.test/v1',
      maxRetries: 3,
      fetch: async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ error: { message: 'busy' } }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    await expect(provider.chat({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
    })).rejects.toMatchObject({ statusCode: 503, retryable: true });
    expect(fetchCalls).toBe(1);
  });
});

type Script = ModelClientResponse | ((request: ModelClientRequest) => Promise<ModelClientResponse>);

class ScriptedModelClient implements ModelClient {
  calls = 0;

  constructor(private readonly scripts: Script[]) {}

  async execute(request: ModelClientRequest): Promise<ModelClientResponse> {
    const script = this.scripts[this.calls++];
    if (script === undefined) throw new Error('Unexpected model client call');
    return typeof script === 'function' ? await script(request) : script;
  }
}

function gateway(overrides: ConstructorParameters<typeof ModelExecutionGateway>[0] = {}) {
  let attempt = 0;
  return new ModelExecutionGateway({
    createAttemptId: () => `attempt-${++attempt}`,
    clock: { now: Date.now, sleep: async () => undefined },
    random: () => 0.5,
    ...overrides,
  });
}

function session(
  client: ModelClient,
  overrides: Partial<ModelRouteSnapshotInput> = {},
): ModelSession {
  return createModelSession({
    route: route(overrides),
    generation: {},
    codec: openAIChatCodec,
    client,
  });
}

function responsesSession(client: ModelClient): ModelSession {
  return createModelSession({
    route: route({ protocol: 'openai-responses', codecRevision: 'openai-responses@1' }),
    generation: {},
    codec: openAIResponsesCodec,
    client,
  });
}

function route(overrides: Partial<ModelRouteSnapshotInput> = {}): ModelRouteSnapshotInput {
  return {
    routeId: 'primary-route',
    connectionId: 'connection-1',
    providerId: 'provider-1',
    modelId: 'test-model',
    protocol: 'openai-chat' as const,
    codecRevision: 'openai-chat@1',
    capabilities: { toolCalling: 'supported' as const, streaming: 'supported' as const },
    contextTokens: 16_384,
    maxInputTokens: 12_288,
    maxOutputTokens: 4_096,
    metadata: { source: 'endpoint', revision: 'catalog-1', digest: 'sha256:route-1' },
    allowedFallbackRouteIds: [] as string[],
    compatibility: { mode: 'compatible-protocol' as const, family: 'openai-tools-v1' },
    ...overrides,
  };
}

function request(): CanonicalModelRequest {
  return {
    model: 'test-model',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  };
}

function staticChat(text: string): ModelClientResponse {
  return {
    kind: 'json',
    response: {
      id: `response-${text}`,
      choices: [{ message: { content: text }, finish_reason: 'stop' }],
    },
  };
}

function streamResponse(factory: () => AsyncIterable<unknown>): ModelClientResponse {
  return { kind: 'stream', events: factory() };
}

function streamClient(events: AsyncIterable<unknown>): ModelClient {
  return new ScriptedModelClient([{ kind: 'stream', events }]);
}

function hangingConnectClient(): ModelClient {
  return new ScriptedModelClient([() => new Promise<ModelClientResponse>(() => undefined)]);
}

async function* hangingStream(): AsyncIterable<unknown> {
  await new Promise<void>(() => undefined);
}

async function* firstThenHang(): AsyncIterable<unknown> {
  yield chatDelta('first');
  await new Promise<void>(() => undefined);
}

async function* eventsWithoutFinish(): AsyncIterable<unknown> {
  let index = 0;
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    yield { id: 'stream', choices: [{ delta: { content: String(index++) }, finish_reason: null }] };
  }
}

function chatDelta(text: string, finishReason: string | null = null): unknown {
  return {
    id: 'stream-response',
    choices: [{ delta: { content: text }, finish_reason: finishReason }],
  };
}
