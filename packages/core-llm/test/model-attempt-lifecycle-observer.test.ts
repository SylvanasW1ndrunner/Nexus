/* eslint-disable @typescript-eslint/require-await -- scripted model boundary fixtures. */
import { describe, expect, it } from 'vitest';
import {
  ModelClientError,
  ModelExecutionGateway,
  createModelSession,
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
      yield { choices: [{ delta: { content: 'hello' } }] };
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
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
        yield { choices: [{ delta: { content: 'partial' } }] };
        throw new ModelClientError('STREAM_DISCONNECTED', 'cut', { retryable: true });
      }),
      stream(async function* () {
        yield { choices: [{ delta: { content: 'final' }, finish_reason: 'stop' }] };
      }),
    ]);
    const ids = ['attempt-a', 'attempt-b'];
    await new ModelExecutionGateway({ createAttemptId: () => ids.shift()! }).executeAttempt(
      modelSession(client), request(), {
        maxRetries: 1,
        observer: { onEvent: async (event) => { events.push(event); } },
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
      { observer: { onEvent: async (event) => { events.push(event); } } },
    );
    expect(events.map(({ type }) => type)).toEqual([
      'attempt-started', 'block-completed', 'block-completed',
    ]);
    expect(events.filter((event) => event.type === 'block-completed')).toEqual([
      expect.objectContaining({ blockOrdinal: 0, block: { type: 'text', text: 'answer' } }),
      expect.objectContaining({
        blockOrdinal: 1,
        block: expect.objectContaining({ type: 'tool-call-draft', name: 'inspect' }),
      }),
    ]);
  });

  it('does not call the model or retry when the started sink fails', async () => {
    const client = new ScriptedClient([json('must-not-run')]);
    await expect(new ModelExecutionGateway().executeAttempt(modelSession(client), request(), {
      maxRetries: 3,
      observer: {
        onEvent: async () => { throw new Error('journal unavailable'); },
      },
    })).rejects.toMatchObject({ code: 'MODEL_OBSERVER_FAILED', retryable: false });
    expect(client.calls).toBe(0);
  });

  it('aborts and never retries an external call after a delta sink failure', async () => {
    const client = new ScriptedClient([
      stream(async function* () {
        yield { choices: [{ delta: { content: 'external response began' } }] };
        yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
      }),
      json('must-not-retry'),
    ]);
    await expect(new ModelExecutionGateway().executeAttempt(modelSession(client), request(), {
      maxRetries: 1,
      observer: {
        onEvent: async (event) => {
          if (event.type === 'decoded-delta') throw new Error('journal unavailable');
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
        observer: { onEvent: async (event) => { events.push(event); } },
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
