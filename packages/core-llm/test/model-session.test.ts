import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LlmConnectionManager,
  HttpJsonTransport,
  ModelExecutionGateway,
  createModelSession,
  estimateCanonicalRequestTokens,
  type CanonicalModelRequest,
  type ModelClient,
  type ModelClientRequest,
  type ModelClientResponse,
  type ModelRouteSnapshotInput,
  type LlmProvider,
  type LlmProviderPlugin,
} from '../src/index.js';
import { openAIChatCodec } from '../src/protocol/codecs/openai-chat.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('ModelSession', () => {
  it('freezes route metadata and validated generation settings for every attempt', async () => {
    const route = routeSnapshot({
      capabilities: { toolCalling: 'supported' },
      metadata: { source: 'endpoint', revision: 'catalog-7', digest: 'sha256:route-1' },
    });
    const generation = { temperature: 0.25, maxOutputTokens: 128, stop: ['END'] };
    const client = new RecordingClient({
      kind: 'json',
      response: {
        id: 'response-1',
        choices: [{ message: { content: 'stable' }, finish_reason: 'stop' }],
      },
    });
    const session = createModelSession({
      route,
      generation,
      codec: openAIChatCodec,
      client,
    });

    route.capabilities.toolCalling = 'unsupported';
    route.metadata.revision = 'catalog-8';
    generation.temperature = 1;
    generation.stop.push('MUTATED');

    const result = await new ModelExecutionGateway().executeAttempt(session, request());

    expect(result.attempt.blocks).toEqual([{ type: 'text', text: 'stable' }]);
    expect(session.route.capabilities.toolCalling).toBe('supported');
    expect(session.route.metadata.revision).toBe('catalog-7');
    expect(session.generation).toEqual({
      temperature: 0.25,
      maxOutputTokens: 128,
      stop: ['END'],
    });
    expect(Object.isFrozen(session)).toBe(true);
    expect(Object.isFrozen(session.route.capabilities)).toBe(true);
    expect(Object.isFrozen(session.generation.stop)).toBe(true);
    expect(client.requests[0]?.wireRequest).toMatchObject({
      model: 'test-model',
      temperature: 0.25,
      max_completion_tokens: 128,
      stop: ['END'],
    });
  });

  it('rejects a codec whose protocol does not match the frozen route', () => {
    expect(() =>
      createModelSession({
        route: routeSnapshot({ protocol: 'openai-responses' }),
        generation: {},
        codec: openAIChatCodec,
        client: new RecordingClient({ kind: 'json', response: {} }),
      }),
    ).toThrow(/protocol/i);
  });

  it('estimates canonical ordered content without treating tool JSON as executable text', () => {
    expect(estimateCanonicalRequestTokens({
      model: 'test-model',
      messages: [
        { role: 'user', content: [{ type: 'text', text: '123456' }] },
        {
          role: 'tool',
          content: [{ type: 'tool-result', callId: 'call-1', output: { rows: 2 }, isError: false }],
        },
      ],
    })).toBe(22);
  });

  it('prepares a frozen session from one resolved connection route without executing it', async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), 'schemanaut-model-session-'));
    temporaryDirectories.push(cacheDirectory);
    const manager = new LlmConnectionManager({
      cacheDirectory,
      plugins: [openAiChatPlugin()],
    });
    const [connection] = manager.replaceConnections([
      { endpoint: 'https://session.example/v1', apiKey: 'test-key' },
    ]);
    const prepared = await manager.prepareModelSession(
      { connectionId: connection!.id, modelId: 'test-model' },
      { generation: { temperature: 0.2 }, allowedFallbackRouteIds: [] },
    );

    expect(prepared.route).toMatchObject({
      connectionId: connection!.id,
      modelId: 'test-model',
      protocol: 'openai-chat',
      codecRevision: 'openai-chat@1',
      contextTokens: 8_192,
      maxOutputTokens: 1_024,
    });
    expect(prepared.generation).toEqual({ temperature: 0.2 });
    expect(Object.isFrozen(prepared.route.metadata)).toBe(true);
    expect(prepared.client).toBeInstanceOf(HttpJsonTransport);
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

function request(): CanonicalModelRequest {
  return {
    model: 'test-model',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  };
}

function routeSnapshot(
  overrides: Partial<ModelRouteSnapshotInput> = {},
): ModelRouteSnapshotInput {
  return {
    routeId: 'primary-route',
    connectionId: 'connection-1',
    providerId: 'provider-1',
    modelId: 'test-model',
    protocol: 'openai-chat',
    codecRevision: 'openai-chat@1',
    capabilities: { toolCalling: 'unknown', streaming: 'supported' },
    contextTokens: 16_384,
    maxInputTokens: 12_288,
    maxOutputTokens: 4_096,
    metadata: { source: 'endpoint', revision: 'catalog-1', digest: 'sha256:route-1' },
    allowedFallbackRouteIds: [],
    ...overrides,
  };
}

function openAiChatPlugin(): LlmProviderPlugin {
  const provider: LlmProvider = {
    id: 'placeholder',
    name: 'Session fixture',
    mode: 'byok',
    listModels: () => Promise.resolve(['test-model']),
    getModelMetadata: (model) => Promise.resolve({
      model,
      source: 'provider-api',
      capabilities: { chat: 'supported', streaming: 'supported', toolCalling: 'supported' },
      contextTokens: 8_192,
      maxInputTokens: 7_168,
      maxOutputTokens: 1_024,
    }),
    chat: () => Promise.reject(new Error('prepareModelSession must not execute the provider')),
    isAvailable: () => Promise.resolve({ available: true }),
  };
  return {
    manifest: {
      id: 'session-openai-chat',
      name: 'Session OpenAI Chat',
      version: '1.0.0',
      protocol: 'openai-chat',
      priority: 100,
    },
    match: () => ({ score: 100, evidence: [] }),
    discover: () => Promise.resolve({ score: 100, models: ['test-model'], evidence: [] }),
    createProvider: ({ resolution }) => Object.assign(provider, { id: resolution.providerId }),
  };
}
