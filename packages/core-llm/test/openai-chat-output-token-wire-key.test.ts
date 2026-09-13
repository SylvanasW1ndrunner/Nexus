import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LlmModelCatalogManager,
  LlmModelCatalogStore,
  LlmConnectionManager,
  ModelExecutionGateway,
  ModelClientBindingError,
  OpenAICompatibleProvider,
  createLlmConnection,
  createModelSession,
  describeModelSession,
  rehydrateModelSession,
  type LlmModelMetadata,
  type LlmProvider,
  type LlmProviderPlugin,
  type ModelClient,
  type ModelClientRequest,
  type ModelClientResponse,
  type ModelRouteSnapshotInput,
  type PersistedModelSessionDescriptor,
} from '../src/index.js';
import { bindTrustedModelSessionClient } from '../src/model-client-binding.js';
import { anthropicMessagesCodec } from '../src/protocol/codecs/anthropic-messages.js';
import { openAIChatCodec } from '../src/protocol/codecs/openai-chat.js';

const directories: string[] = [];
const tokenKeys = [
  'max_tokens',
  'max_completion_tokens',
  'max_output_tokens',
  'max_new_tokens',
] as const;

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('OpenAI Chat output-token wire key', () => {
  it.each(tokenKeys)('preserves the advertised %s alias from OpenAI-compatible model metadata', async (key) => {
    const provider = new OpenAICompatibleProvider({
      id: 'relay',
      name: 'Relay',
      apiKey: 'test-key',
      baseUrl: 'https://relay.example/v1',
      fetch: () => Promise.resolve(Response.json({ data: [{ id: 'model-a', supported_parameters: [key] }] })),
    });

    await provider.listModels();

    await expect(provider.getModelMetadata('model-a')).resolves.toMatchObject({
      openAIChatMaxOutputTokensWireKey: key,
    });
  });

  it.each(tokenKeys)('sends only the frozen %s key in the final OpenAI Chat body', async (key) => {
    const client = new RecordingClient();
    const session = createModelSession({
      route: route({
        encoding: { openAIChatMaxOutputTokensWireKey: key },
      }),
      generation: { maxOutputTokens: 77 },
      codec: openAIChatCodec,
      client,
    });

    await new ModelExecutionGateway().executeAttempt(session, request());

    expect(client.requests[0]?.wireRequest).toEqual({
      model: 'model-a',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      [key]: 77,
    });
  });

  it('uses max_tokens as the OpenAI-compatible default when no alias was advertised', async () => {
    const client = new RecordingClient();
    const session = createModelSession({
      route: route(),
      generation: { maxOutputTokens: 77 },
      codec: openAIChatCodec,
      client,
    });

    await new ModelExecutionGateway().executeAttempt(session, request());

    expect(client.requests[0]?.wireRequest).toEqual({
      model: 'model-a',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      max_tokens: 77,
    });
  });

  it('rehydrates and executes an independently authored pre-encoding descriptor unchanged', async () => {
    const client = new RecordingClient();
    const legacyRoute = route();
    const legacyRouteDigest = preEncodingRouteDigest();
    const legacySessionDigest = preEncodingSessionDigest(legacyRouteDigest);
    const bindingSession = createModelSession({
      route: legacyRoute,
      generation: { maxOutputTokens: 77 },
      codec: openAIChatCodec,
      client,
    });
    const descriptor: PersistedModelSessionDescriptor = {
      route: {
        ...legacyRoute,
        metadata: { ...legacyRoute.metadata, digest: legacyRouteDigest },
      },
      generation: { maxOutputTokens: 77 },
      replay: { mode: 'new' },
      clientBinding: bindingMetadata(),
      bindingDigest: legacySessionDigest,
    };

    expect(bindingSession.route.metadata.digest).toBe(legacyRouteDigest);
    expect(bindingSession.bindingDigest).toBe(legacySessionDigest);
    bindTrustedModelSessionClient(bindingSession, bindingMetadata());

    const rehydrated = rehydrateModelSession({
      descriptor,
      expectedRouteDigest: legacyRouteDigest,
      expectedSessionDigest: legacySessionDigest,
      expectedCodecRevision: 'openai-chat@1',
      bindingSession,
    });
    await new ModelExecutionGateway().executeAttempt(rehydrated, request());

    expect(rehydrated.route).not.toHaveProperty('encoding');
    expect(client.requests[0]?.wireRequest).toMatchObject({ max_tokens: 77 });
  });

  it('carries the catalog key through ConnectionManager into the final codec body', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'schemanaut-wire-key-manager-'));
    directories.push(directory);
    const client = new RecordingClient();
    const provider = new MetadataProvider({
      model: 'model-a',
      source: 'provider-api',
      capabilities: { chat: 'supported' },
      openAIChatMaxOutputTokensWireKey: 'max_new_tokens',
    });
    const manager = new LlmConnectionManager({
      cacheDirectory: directory,
      plugins: [metadataPlugin(provider)],
      trustedModelClientFactory: ({ connection, resolution }) => ({
        client,
        bindingEvidence: {
          connectionResolutionRevision: resolution.revision,
          connectionConfigurationRevision: connection.connectionConfigurationRevision,
          credentialRevision: connection.credentialRevision,
        },
      }),
    });
    const [connection] = manager.replaceConnections([
      { endpoint: 'https://relay.example/v1', apiKey: 'test-key' },
    ]);
    await manager.discover(connection!.id, { inspectModelIds: ['model-a'] });

    const session = await manager.prepareModelSession(
      { connectionId: connection!.id, modelId: 'model-a' },
      { generation: { maxOutputTokens: 77 } },
    );
    await new ModelExecutionGateway().executeAttempt(session, request());

    expect(session.route.encoding).toEqual({ openAIChatMaxOutputTokensWireKey: 'max_new_tokens' });
    expect(client.requests[0]?.wireRequest).toMatchObject({ max_new_tokens: 77 });
    expect(client.requests[0]?.wireRequest).not.toHaveProperty('max_tokens');
    expect(client.requests[0]?.wireRequest).not.toHaveProperty('max_completion_tokens');
    expect(client.requests[0]?.wireRequest).not.toHaveProperty('max_output_tokens');
  });

  it('persists, rehydrates, freezes, and digest-binds the selected output-token wire key', () => {
    const withLegacyKey = createModelSession({
      route: route({
        encoding: { openAIChatMaxOutputTokensWireKey: 'max_tokens' },
      } as unknown as Partial<ModelRouteSnapshotInput>),
      generation: {},
      codec: openAIChatCodec,
      client: new RecordingClient(),
    });
    const withCompletionKey = createModelSession({
      route: route({
        encoding: { openAIChatMaxOutputTokensWireKey: 'max_completion_tokens' },
      } as unknown as Partial<ModelRouteSnapshotInput>),
      generation: {},
      codec: openAIChatCodec,
      client: new RecordingClient(),
    });
    bindTrustedModelSessionClient(withLegacyKey, bindingMetadata());

    const descriptor = describeModelSession(withLegacyKey);
    const encoding = (withLegacyKey.route as unknown as {
      encoding?: { openAIChatMaxOutputTokensWireKey?: string };
    }).encoding;
    const persistedEncoding = (descriptor.route as unknown as {
      encoding?: { openAIChatMaxOutputTokensWireKey?: string };
    }).encoding;

    expect(encoding).toEqual({ openAIChatMaxOutputTokensWireKey: 'max_tokens' });
    expect(Object.isFrozen(encoding!)).toBe(true);
    expect(Reflect.set(encoding!, 'openAIChatMaxOutputTokensWireKey', 'max_new_tokens')).toBe(false);
    expect(encoding).toEqual({ openAIChatMaxOutputTokensWireKey: 'max_tokens' });
    expect(persistedEncoding).toEqual({ openAIChatMaxOutputTokensWireKey: 'max_tokens' });
    expect(withLegacyKey.route.metadata.digest).not.toBe(withCompletionKey.route.metadata.digest);
    expect(rehydrateModelSession({
      descriptor,
      expectedRouteDigest: withLegacyKey.route.metadata.digest,
      expectedSessionDigest: withLegacyKey.bindingDigest,
      expectedCodecRevision: withLegacyKey.route.codecRevision,
      bindingSession: withLegacyKey,
    }).route).toMatchObject({
      encoding: { openAIChatMaxOutputTokensWireKey: 'max_tokens' },
    });
  });

  it.each([
    ['an unknown wire key', 'openai-chat', { openAIChatMaxOutputTokensWireKey: 'max_everything' }],
    ['an unknown encoding member', 'openai-chat', { openAIChatMaxOutputTokensWireKey: 'max_tokens', unexpected: true }],
    ['an OpenAI Chat wire key on a mismatched protocol', 'anthropic-messages', { openAIChatMaxOutputTokensWireKey: 'max_tokens' }],
  ] as const)('rejects %s before a network client can execute', (_label, protocol, encoding) => {
    const client = new RecordingClient();

    expect(() => createModelSession({
      route: route({
        protocol,
        codecRevision: protocol === 'openai-chat' ? 'openai-chat@1' : 'anthropic-messages@1',
        encoding,
      } as unknown as Partial<ModelRouteSnapshotInput>),
      generation: {},
      codec: protocol === 'openai-chat' ? openAIChatCodec : anthropicMessagesCodec,
      client,
    })).toThrowError(ModelClientBindingError);
    expect(client.requests).toHaveLength(0);
  });

  it('retains the endpoint-advertised key through catalog cache reload', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'schemanaut-wire-key-'));
    directories.push(directory);
    const store = new LlmModelCatalogStore(directory);
    const connection = createLlmConnection({ endpoint: 'https://relay.example/v1', apiKey: 'test-key' });
    const resolution = {
      connectionId: connection.id,
      providerId: 'relay',
      pluginId: 'openai-compatible',
      pluginVersion: '1',
      protocol: 'openai-chat',
      providerBaseUrl: connection.endpoint,
      models: ['model-a'],
      revision: 'revision-1',
      evidence: [],
    } as const;
    const advertised = new MetadataProvider({
      model: 'model-a',
      source: 'provider-api',
      capabilities: { chat: 'supported' },
      openAIChatMaxOutputTokensWireKey: 'max_new_tokens',
    } as unknown as LlmModelMetadata);

    await new LlmModelCatalogManager({ store }).refresh({
      connection,
      resolution,
      provider: advertised,
      inspectModelIds: ['model-a'],
    });
    const reloaded = new LlmModelCatalogManager({ store });
    await reloaded.refresh({ connection, resolution, provider: new MetadataProvider() });

    expect(reloaded.resolve(connection.id, 'model-a')).toMatchObject({
      openAIChatMaxOutputTokensWireKey: { value: 'max_new_tokens', source: 'endpoint' },
    });
  });

  it('ignores malformed output-token metadata recovered from a cache entry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'schemanaut-wire-key-malformed-cache-'));
    directories.push(directory);
    const store = new LlmModelCatalogStore(directory);
    const connection = createLlmConnection({ endpoint: 'https://relay.example/v1', apiKey: 'test-key' });
    const resolution = {
      connectionId: connection.id,
      providerId: 'relay',
      pluginId: 'openai-compatible',
      pluginVersion: '1',
      protocol: 'openai-chat',
      providerBaseUrl: connection.endpoint,
      models: ['model-a'],
      revision: 'revision-1',
      evidence: [],
    } as const;
    await store.write({
      connectionId: connection.id,
      credentialRevision: connection.credentialRevision,
      pluginId: resolution.pluginId,
      pluginVersion: resolution.pluginVersion,
    }, {
      fetchedAt: '2026-09-04T00:00:00.000Z',
      ttlMs: 60_000,
      models: [{
        modelId: 'model-a',
        metadata: { openAIChatMaxOutputTokensWireKey: 'send_everything' } as unknown as LlmModelMetadata,
      }],
    });

    const manager = new LlmModelCatalogManager({ store });
    await manager.refresh({ connection, resolution, provider: new MetadataProvider() });

    expect(manager.resolve(connection.id, 'model-a')).toMatchObject({
      openAIChatMaxOutputTokensWireKey: { value: null, source: 'unknown' },
    });
  });
});

class RecordingClient implements ModelClient {
  readonly requests: ModelClientRequest[] = [];

  execute(request: ModelClientRequest): Promise<ModelClientResponse> {
    this.requests.push(request);
    return Promise.resolve({
      kind: 'json',
      response: { choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] },
    });
  }
}

class MetadataProvider implements LlmProvider {
  readonly id = 'provider';
  readonly name = 'Provider';
  readonly mode = 'byok' as const;

  constructor(private readonly metadata?: LlmModelMetadata) {}

  listModels(): Promise<string[]> {
    return Promise.resolve(['model-a']);
  }

  getModelMetadata(model: string): Promise<LlmModelMetadata> {
    return Promise.resolve(this.metadata ?? { model, source: 'provider-api', capabilities: {} });
  }

  chat() {
    return Promise.resolve({ text: 'done', toolCalls: [] });
  }

  isAvailable() {
    return Promise.resolve({ available: true });
  }
}

function metadataPlugin(provider: LlmProvider): LlmProviderPlugin {
  return {
    manifest: {
      id: 'metadata-test', name: 'metadata test', version: '1', protocol: 'openai-chat', priority: 100,
    },
    match: () => ({ score: 100, evidence: [] }),
    discover: () => Promise.resolve({ score: 100, models: ['model-a'], evidence: [] }),
    createProvider: ({ resolution }) => Object.assign(provider, { id: resolution.providerId }),
  };
}

function route(overrides: Partial<ModelRouteSnapshotInput> = {}): ModelRouteSnapshotInput {
  return {
    routeId: 'route-a',
    connectionId: 'connection-a',
    providerId: 'provider-a',
    modelId: 'model-a',
    protocol: 'openai-chat',
    codecRevision: 'openai-chat@1',
    capabilities: { chat: 'supported', streaming: 'supported' },
    contextTokens: 8_192,
    maxInputTokens: 7_000,
    maxOutputTokens: 1_024,
    metadata: {
      source: 'test',
      revision: '1',
      connectionConfigurationRevision: 'connection-revision',
      credentialRevision: 'credential-revision',
      digest: 'caller-digest',
    },
    ...overrides,
  };
}

function bindingMetadata() {
  return {
    connectionResolutionRevision: '1',
    connectionConfigurationRevision: 'connection-revision',
    credentialRevision: 'credential-revision',
  };
}

function preEncodingRouteDigest(): string {
  return `sha256:${createHash('sha256').update(JSON.stringify({
    routeId: 'route-a',
    connectionId: 'connection-a',
    providerId: 'provider-a',
    modelId: 'model-a',
    protocol: 'openai-chat',
    codecRevision: 'openai-chat@1',
    capabilities: { chat: 'supported', streaming: 'supported' },
    generationParameters: {},
    contextTokens: 8_192,
    maxInputTokens: 7_000,
    maxOutputTokens: 1_024,
    metadata: {
      source: 'test',
      revision: '1',
      connectionConfigurationRevision: 'connection-revision',
      credentialRevision: 'credential-revision',
    },
    allowedFallbackRouteIds: [],
  })).digest('hex')}`;
}

function preEncodingSessionDigest(routeDigest: string): string {
  return `sha256:${createHash('sha256').update(JSON.stringify({
    routeDigest,
    codecRevision: 'openai-chat@1',
    generation: { maxOutputTokens: 77 },
    replay: { mode: 'new' },
  })).digest('hex')}`;
}

function request() {
  return {
    model: 'model-a',
    messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] }],
  };
}
