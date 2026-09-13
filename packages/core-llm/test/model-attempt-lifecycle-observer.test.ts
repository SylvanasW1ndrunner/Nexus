import { describe, expect, it } from 'vitest';
import {
  ModelClientError,
  ModelExecutionGateway,
  createModelSession,
  createModelSessionBundle,
  type CanonicalModelRequest,
  type ModelAttemptLifecycleEvent,
  type ModelClient,
  type ModelClientRequest,
  type ModelClientResponse,
  type ModelRouteSnapshotInput,
} from '../src/index.js';
import { openAIChatCodec } from '../src/protocol/codecs/openai-chat.js';

describe('ModelExecutionGateway lifecycle observer', () => {
  it('awaits attempt-started before the external client and reports decoded stream order', async () => {
    const order: string[] = [];
    let releaseStarted!: () => void;
    const started = new Promise<void>((resolve) => { releaseStarted = resolve; });
    const client = new ScriptedClient([stream(async function* () {
      yield await Promise.resolve({ choices: [{ delta: { content: 'hello' } }] });
      yield await Promise.resolve({ choices: [{ delta: {}, finish_reason: 'stop' }] });
    })], () => order.push('client'));
    const pending = new ModelExecutionGateway({ createAttemptId: () => 'attempt-1' }).executeAttempt(
      modelSession(client),
      request(),
      {
        observer: {
          async onEvent(event) {
            order.push(event.type);
            if (event.type === 'attempt-started') await started;
          },
        },
      },
    );
    await Promise.resolve();
    expect(client.calls).toBe(0);
    releaseStarted();
    await pending;
    expect(order).toEqual([
      'attempt-started',
      'client',
      'decoded-delta',
      'block-completed',
    ]);
  });

  it('persists failed and discarded facts before starting a retry attempt', async () => {
    const events: ModelAttemptLifecycleEvent[] = [];
    const client = new ScriptedClient([
      stream(async function* () {
        yield await Promise.resolve({ choices: [{ delta: { content: 'partial' } }] });
        throw new ModelClientError('STREAM_DISCONNECTED', 'cut', { retryable: true });
      }),
      stream(async function* () {
        yield await Promise.resolve({
          choices: [{ delta: { content: 'final' }, finish_reason: 'stop' }],
        });
      }),
    ]);
    const ids = ['attempt-a', 'attempt-b'];
    await new ModelExecutionGateway({ createAttemptId: () => ids.shift()! }).executeAttempt(
      modelSession(client), request(), {
        maxRetries: 1,
        observer: { onEvent: (event) => { events.push(event); return Promise.resolve(); } },
      },
    );
    expect(events.map(({ type, attemptId }) => `${attemptId}:${type}`)).toEqual([
      'attempt-a:attempt-started',
      'attempt-a:decoded-delta',
      'attempt-a:attempt-failed',
      'attempt-a:attempt-discarded',
      'attempt-b:attempt-started',
      'attempt-b:decoded-delta',
      'attempt-b:block-completed',
    ]);
  });

  it('reports complete blocks for a non-stream response', async () => {
    const events: ModelAttemptLifecycleEvent[] = [];
    await new ModelExecutionGateway({ createAttemptId: () => 'json-attempt' }).executeAttempt(
      modelSession(new ScriptedClient([{
        kind: 'json',
        response: {
          id: 'response',
          choices: [{
            message: {
              content: 'answer',
              tool_calls: [{
                id: 'wire-1', type: 'function',
                function: { name: 'inspect', arguments: '{"id":1}' },
              }],
            },
            finish_reason: 'tool_calls',
          }],
        },
      }])),
      request(),
      { observer: { onEvent: (event) => { events.push(event); return Promise.resolve(); } } },
    );
    expect(events.map(({ type }) => type)).toEqual([
      'attempt-started', 'block-completed', 'block-completed',
    ]);
    const completed = events.filter((event) => event.type === 'block-completed');
    expect(completed).toHaveLength(2);
    const first = completed[0];
    const second = completed[1];
    if (first === undefined || second === undefined) throw new Error('Missing completed blocks.');
    expect(first.blockOrdinal).toBe(0);
    expect(first.block).toEqual({ type: 'text', text: 'answer' });
    expect(second.blockOrdinal).toBe(1);
    if (second.block.type !== 'tool-call-draft') throw new Error('Expected a Tool call draft.');
    expect(second.block.name).toBe('inspect');
  });

  it('reports JSON usage exactly once before completed blocks', async () => {
    const events: ModelAttemptLifecycleEvent[] = [];
    await new ModelExecutionGateway({ createAttemptId: () => 'json-usage' }).executeAttempt(
      modelSession(new ScriptedClient([{
        kind: 'json',
        response: {
          id: 'response-with-usage',
          choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        },
      }])),
      request(),
      {
        purpose: 'direct',
        observer: { onEvent: (event) => { events.push(event); return Promise.resolve(); } },
      },
    );

    expect(events.map(({ type }) => type)).toEqual([
      'attempt-started', 'usage-observed', 'block-completed',
    ]);
    const usage = events.find((event) => event.type === 'usage-observed');
    if (usage === undefined) throw new Error('Missing usage lifecycle event.');
    const { occurredAt, ...persistedUsage } = usage;
    expect(persistedUsage).toEqual({
      type: 'usage-observed',
      attemptId: 'json-usage',
      routeId: 'route',
      purpose: 'direct',
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
    });
    expect(typeof occurredAt).toBe('number');
  });

  it('persists usage from a disconnected stream and observes retry usage independently', async () => {
    const events: ModelAttemptLifecycleEvent[] = [];
    const client = new ScriptedClient([
      stream(async function* () {
        yield await Promise.resolve({
          choices: [],
          usage: { prompt_tokens: 11, completion_tokens: 1, total_tokens: 12 },
        });
        throw new ModelClientError('STREAM_DISCONNECTED', 'cut after usage', { retryable: true });
      }),
      stream(async function* () {
        yield await Promise.resolve({
          choices: [{ delta: { content: 'recovered' }, finish_reason: 'stop' }],
        });
        yield await Promise.resolve({
          choices: [],
          usage: { prompt_tokens: 13, completion_tokens: 2, total_tokens: 15 },
        });
      }),
    ]);
    const ids = ['usage-attempt-a', 'usage-attempt-b'];

    await new ModelExecutionGateway({ createAttemptId: () => ids.shift()! }).executeAttempt(
      modelSession(client), request(), {
        maxRetries: 1,
        purpose: 'context-compaction',
        observer: { onEvent: (event) => { events.push(event); return Promise.resolve(); } },
      },
    );

    const usageEvents = events.filter((event) => event.type === 'usage-observed');
    expect(usageEvents).toEqual([
      expect.objectContaining({
        attemptId: 'usage-attempt-a', purpose: 'context-compaction',
        usage: { inputTokens: 11, outputTokens: 1, totalTokens: 12 },
      }),
      expect.objectContaining({
        attemptId: 'usage-attempt-b', purpose: 'context-compaction',
        usage: { inputTokens: 13, outputTokens: 2, totalTokens: 15 },
      }),
    ]);
    expect(events.map(({ type, attemptId }) => `${attemptId}:${type}`)).toContain(
      'usage-attempt-a:attempt-discarded',
    );
  });

  it('observes usage independently across an authentic fallback boundary', async () => {
    const events: ModelAttemptLifecycleEvent[] = [];
    const primary = createModelSession({
      route: {
        ...route(),
        allowedFallbackRouteIds: ['fallback-route'],
        compatibility: { mode: 'compatible-protocol', family: 'openai-chat-v1' },
      },
      generation: {},
      codec: openAIChatCodec,
      client: new ScriptedClient([stream(async function* () {
        yield await Promise.resolve({
          choices: [],
          usage: { prompt_tokens: 17, completion_tokens: 1, total_tokens: 18 },
        });
        throw new ModelClientError('STREAM_DISCONNECTED', 'primary disconnected', {
          retryable: true,
        });
      })]),
    });
    const fallback = createModelSession({
      route: {
        ...route(),
        routeId: 'fallback-route',
        compatibility: { mode: 'compatible-protocol', family: 'openai-chat-v1' },
      },
      generation: {},
      codec: openAIChatCodec,
      client: new ScriptedClient([{
        kind: 'json',
        response: {
          choices: [{ message: { content: 'fallback' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 19, completion_tokens: 2, total_tokens: 21 },
        },
      }]),
      replay: { mode: 'compatible-protocol', envelopes: [] },
    });
    const ids = ['primary-attempt', 'fallback-attempt'];

    await new ModelExecutionGateway({ createAttemptId: () => ids.shift()! }).executeAttempt(
      createModelSessionBundle({ primary, fallbacks: [fallback] }),
      request(),
      {
        maxRetries: 0,
        observer: { onEvent: (event) => { events.push(event); return Promise.resolve(); } },
      },
    );

    expect(events.filter((event) => event.type === 'usage-observed')).toMatchObject([
      {
        attemptId: 'primary-attempt', routeId: 'route',
        usage: { inputTokens: 17, outputTokens: 1, totalTokens: 18 },
      },
      {
        attemptId: 'fallback-attempt', routeId: 'fallback-route',
        usage: { inputTokens: 19, outputTokens: 2, totalTokens: 21 },
      },
    ]);
  });

  it('accepts an exact usage replay without publishing it twice', async () => {
    const events: ModelAttemptLifecycleEvent[] = [];
    const repeatedUsage = { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 };
    await new ModelExecutionGateway({ createAttemptId: () => 'usage-replay' }).executeAttempt(
      modelSession(new ScriptedClient([stream(async function* () {
        yield await Promise.resolve({
          choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }],
        });
        yield await Promise.resolve({ choices: [], usage: repeatedUsage });
        yield await Promise.resolve({ choices: [], usage: repeatedUsage });
      })])),
      request(),
      { observer: { onEvent: (event) => { events.push(event); return Promise.resolve(); } } },
    );

    expect(events.filter((event) => event.type === 'usage-observed')).toHaveLength(1);
  });

  it('rejects conflicting or malformed usage without double counting', async () => {
    const conflictingEvents: ModelAttemptLifecycleEvent[] = [];
    await expect(new ModelExecutionGateway({ createAttemptId: () => 'usage-conflict' })
      .executeAttempt(
        modelSession(new ScriptedClient([stream(async function* () {
          yield await Promise.resolve({
            choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }],
          });
          yield await Promise.resolve({
            choices: [], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
          });
          yield await Promise.resolve({
            choices: [], usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
          });
        })])),
        request(),
        {
          maxRetries: 0,
          observer: {
            onEvent: (event) => { conflictingEvents.push(event); return Promise.resolve(); },
          },
        },
      )).rejects.toMatchObject({ code: 'MODEL_PROTOCOL_FAILED' });
    expect(conflictingEvents.filter((event) => event.type === 'usage-observed')).toHaveLength(1);

    const malformedEvents: ModelAttemptLifecycleEvent[] = [];
    await expect(new ModelExecutionGateway({ createAttemptId: () => 'usage-malformed' })
      .executeAttempt(
        modelSession(new ScriptedClient([{
          kind: 'json',
          response: {
            choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: -1, completion_tokens: 2, total_tokens: 1 },
          },
        }])),
        request(),
        {
          maxRetries: 0,
          observer: { onEvent: (event) => { malformedEvents.push(event); return Promise.resolve(); } },
        },
      )).rejects.toMatchObject({ code: 'MODEL_PROTOCOL_FAILED' });
    expect(malformedEvents.filter((event) => event.type === 'usage-observed')).toHaveLength(0);
  });

  it('does not call the model or retry when the started sink fails', async () => {
    const client = new ScriptedClient([json('must-not-run')]);
    await expect(new ModelExecutionGateway().executeAttempt(modelSession(client), request(), {
      maxRetries: 3,
      observer: {
        onEvent: () => Promise.reject(new Error('journal unavailable')),
      },
    })).rejects.toMatchObject({ code: 'MODEL_OBSERVER_FAILED', retryable: false });
    expect(client.calls).toBe(0);
  });

  it('does not invent an Attempt lifecycle when protocol encoding fails before start', async () => {
    const events: ModelAttemptLifecycleEvent[] = [];
    const client = new ScriptedClient([json('must-not-run')]);
    const replaySession = createModelSession({
      route: route(), generation: {}, codec: openAIChatCodec, client,
      replay: { mode: 'compatible-protocol', envelopes: [] },
    });
    const requestWithUnboundCall: CanonicalModelRequest = {
      model: 'model',
      messages: [{ role: 'assistant', content: [{
        type: 'tool-call', callId: 'call-without-envelope', name: 'inspect', arguments: {},
      }] }],
    };

    await expect(new ModelExecutionGateway().executeAttempt(
      replaySession,
      requestWithUnboundCall,
      {
        maxRetries: 3,
        observer: { onEvent: (event) => { events.push(event); return Promise.resolve(); } },
      },
    )).rejects.toMatchObject({ code: 'MODEL_PROTOCOL_FAILED', retryable: false });
    expect(events).toEqual([]);
    expect(client.calls).toBe(0);
  });

  it('aborts and never retries an external call after a delta sink failure', async () => {
    const client = new ScriptedClient([
      stream(async function* () {
        yield await Promise.resolve({
          choices: [{ delta: { content: 'external response began' } }],
        });
        yield await Promise.resolve({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      }),
      json('must-not-retry'),
    ]);
    await expect(new ModelExecutionGateway().executeAttempt(modelSession(client), request(), {
      maxRetries: 1,
      observer: {
        onEvent: (event) => {
          if (event.type === 'decoded-delta') {
            return Promise.reject(new Error('journal unavailable'));
          }
          return Promise.resolve();
        },
      },
    })).rejects.toMatchObject({ code: 'MODEL_OBSERVER_FAILED', retryable: false });
    expect(client.calls).toBe(1);
  });

  it('records cancellation failure/discard without starting another attempt', async () => {
    const controller = new AbortController();
    const events: ModelAttemptLifecycleEvent[] = [];
    const client = new ScriptedClient([
      (input) => new Promise<ModelClientResponse>((_, reject) => {
        input.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    ]);
    const pending = new ModelExecutionGateway({ createAttemptId: () => 'cancel-attempt' })
      .executeAttempt(modelSession(client), request(), {
        maxRetries: 3,
        signal: controller.signal,
        observer: { onEvent: (event) => { events.push(event); return Promise.resolve(); } },
      });
    await Promise.resolve();
    controller.abort(new Error('user cancelled'));
    await expect(pending).rejects.toMatchObject({ code: 'MODEL_CANCELLED' });
    expect(events.map(({ type }) => type)).toEqual([
      'attempt-started', 'attempt-failed', 'attempt-discarded',
    ]);
    expect(client.calls).toBe(0);
  });
});

class ScriptedClient implements ModelClient {
  calls = 0;
  constructor(
    private readonly scripts: Array<
      ModelClientResponse | ((input: ModelClientRequest) => Promise<ModelClientResponse>)
    >,
    private readonly onCall?: () => void,
  ) {}

  execute(input: ModelClientRequest): Promise<ModelClientResponse> {
    this.calls += 1;
    this.onCall?.();
    const script = this.scripts.shift();
    if (script === undefined) return Promise.reject(new Error('Unexpected model call.'));
    return typeof script === 'function' ? script(input) : Promise.resolve(script);
  }
}

function modelSession(client: ModelClient) {
  return createModelSession({
    route: route(),
    generation: {},
    codec: openAIChatCodec,
    client,
  });
}

function route(): ModelRouteSnapshotInput {
  return {
    routeId: 'route', connectionId: 'connection', providerId: 'provider',
    modelId: 'model', protocol: 'openai-chat', codecRevision: openAIChatCodec.revision,
    capabilities: { toolCalling: 'supported', streaming: 'supported' },
    contextTokens: 8_192, maxInputTokens: 7_168, maxOutputTokens: 1_024,
    metadata: { source: 'fixture', revision: '1', digest: 'sha256:fixture' },
    allowedFallbackRouteIds: [],
  };
}

function request(): CanonicalModelRequest {
  return { model: 'model', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };
}

function stream(factory: () => AsyncGenerator<unknown>): ModelClientResponse {
  return { kind: 'stream', events: factory() };
}

function json(text: string): ModelClientResponse {
  return {
    kind: 'json',
    response: { id: 'r', choices: [{ message: { content: text }, finish_reason: 'stop' }] },
  };
}
