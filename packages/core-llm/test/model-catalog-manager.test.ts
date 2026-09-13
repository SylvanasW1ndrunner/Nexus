import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LlmModelCatalogManager,
  LlmModelCatalogStore,
  createLlmConnection,
  type ModelCatalogSnapshot,
  type LlmConnectionResolution,
  type LlmModelMetadata,
  type LlmProvider,
} from '../src/index.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('LlmModelCatalogManager', () => {
  it('refreshes before model selection and filters models by connection and role', async () => {
    const manager = await createManager();
    const connection = createLlmConnection({ endpoint: 'https://relay.example/v1', apiKey: 'secret' });
    const provider = new CatalogProvider([
      'chat-model',
      'text-embedding-3-small',
      'bge-reranker-v2',
    ]);

    const snapshot = await manager.refresh({ connection, resolution: resolution(connection.id), provider });

    expect(snapshot.models).toHaveLength(3);
    expect(manager.models({ connectionId: connection.id, role: 'embedding' }).map((model) => model.modelId))
      .toEqual(['text-embedding-3-small']);
    expect(manager.models({ connectionId: connection.id, role: 'rerank' }).map((model) => model.modelId))
      .toEqual(['bge-reranker-v2']);
  });

  it('loads selected-model endpoint metadata without inspecting every model', async () => {
    const manager = await createManager();
    const connection = createLlmConnection({ endpoint: 'http://127.0.0.1:11434' });
    const provider = new CatalogProvider(['qwen:14b', 'embeddinggemma'], {
      'qwen:14b': {
        model: 'qwen:14b',
        source: 'provider-api',
        capabilities: { chat: 'supported', toolCalling: 'supported' },
        contextTokens: 65_536,
      },
    });

    await manager.refresh({
      connection,
      resolution: resolution(connection.id, 'ollama-native', ['qwen:14b', 'embeddinggemma']),
      provider,
      inspectModelIds: ['qwen:14b'],
    });

    expect(provider.metadataRequests).toEqual(['qwen:14b']);
    expect(manager.resolve(connection.id, 'qwen:14b')).toMatchObject({
      contextTokens: { value: 65_536, source: 'endpoint' },
      capabilities: { toolCalling: { value: 'supported', source: 'endpoint' } },
    });
  });

  it('preserves metadata for uninspected models while inspecting another model', async () => {
    const manager = await createManager();
    const connection = createLlmConnection({ endpoint: 'https://relay.example/v1' });
    const route = resolution(connection.id, 'openai-compatible', ['model-a', 'model-b']);
    const provider = new CatalogProvider(['model-a', 'model-b'], {
      'model-a': metadata('model-a', 4_096, 'unsupported'),
      'model-b': metadata('model-b', 8_192, 'supported'),
    });

    await manager.refresh({ connection, resolution: route, provider, inspectModelIds: ['model-a'] });
    await manager.refresh({ connection, resolution: route, provider, inspectModelIds: ['model-b'] });

    expect(manager.resolve(connection.id, 'model-a')).toMatchObject({
      contextTokens: { value: 4_096, source: 'endpoint' },
      generationParameters: { seed: { value: 'unsupported', source: 'endpoint' } },
    });
    expect(manager.resolve(connection.id, 'model-b')).toMatchObject({
      contextTokens: { value: 8_192, source: 'endpoint' },
    });
  });

  it('preserves inspected metadata through a manager restart and removes absent models', async () => {
    const directory = await tempDirectory();
    const store = new LlmModelCatalogStore(directory);
    const connection = createLlmConnection({ endpoint: 'https://relay.example/v1' });
    const both = resolution(connection.id, 'openai-compatible', ['model-a', 'model-b']);
    await new LlmModelCatalogManager({ store }).refresh({
      connection,
      resolution: both,
      provider: new CatalogProvider(['model-a', 'model-b'], {
        'model-a': metadata('model-a', 4_096, 'unsupported'),
      }),
      inspectModelIds: ['model-a'],
    });

    const restarted = new LlmModelCatalogManager({ store });
    await restarted.refresh({
      connection,
      resolution: resolution(connection.id, 'openai-compatible', ['model-a']),
      provider: new CatalogProvider(['model-a']),
    });

    expect(restarted.resolve(connection.id, 'model-a')).toMatchObject({
      contextTokens: { value: 4_096, source: 'endpoint' },
    });
    expect(restarted.resolve(connection.id, 'model-b')).toBeUndefined();
  });

  it('replaces explicitly refreshed metadata even when support is downgraded to unknown', async () => {
    const manager = await createManager();
    const connection = createLlmConnection({ endpoint: 'https://relay.example/v1' });
    const route = resolution(connection.id, 'openai-compatible', ['model-a']);
    await manager.refresh({
      connection,
      resolution: route,
      provider: new CatalogProvider(['model-a'], {
        'model-a': metadata('model-a', 4_096, 'unsupported'),
      }),
      inspectModelIds: ['model-a'],
    });
    await manager.refresh({
      connection,
      resolution: route,
      provider: new CatalogProvider(['model-a'], {
        'model-a': { model: 'model-a', source: 'provider-api', capabilities: {} },
      }),
      inspectModelIds: ['model-a'],
    });

    expect(manager.resolve(connection.id, 'model-a')).toMatchObject({
      contextTokens: { value: null },
      generationParameters: { seed: { value: null } },
    });
  });

  it('never carries cached metadata across connections', async () => {
    const directory = await tempDirectory();
    const store = new LlmModelCatalogStore(directory);
    const manager = new LlmModelCatalogManager({ store });
    const first = createLlmConnection({ endpoint: 'https://relay-a.example/v1' });
    const second = createLlmConnection({ endpoint: 'https://relay-b.example/v1' });
    await manager.refresh({
      connection: first,
      resolution: resolution(first.id, 'openai-compatible', ['shared']),
      provider: new CatalogProvider(['shared'], { shared: metadata('shared', 4_096, 'unsupported') }),
      inspectModelIds: ['shared'],
    });
    await manager.refresh({
      connection: second,
      resolution: resolution(second.id, 'openai-compatible', ['shared']),
      provider: new CatalogProvider(['shared']),
    });

    expect(manager.resolve(second.id, 'shared')).toMatchObject({
      contextTokens: { value: null },
      generationParameters: { seed: { value: null } },
    });
  });

  it('serializes concurrent partial inspection per connection without losing either update', async () => {
    const manager = await createManager();
    const connection = createLlmConnection({ endpoint: 'https://relay.example/v1' });
    const route = resolution(connection.id, 'openai-compatible', ['model-a', 'model-b']);
    const provider = new DelayedCatalogProvider(
      ['model-a', 'model-b'],
      {
        'model-a': metadata('model-a', 4_096, 'unsupported'),
        'model-b': metadata('model-b', 8_192, 'supported'),
      },
      { 'model-a': 20, 'model-b': 1 },
    );

    await Promise.all([
      manager.refresh({ connection, resolution: route, provider, inspectModelIds: ['model-a'] }),
      manager.refresh({ connection, resolution: route, provider, inspectModelIds: ['model-b'] }),
    ]);

    expect(manager.resolve(connection.id, 'model-a')?.contextTokens.value).toBe(4_096);
    expect(manager.resolve(connection.id, 'model-b')?.contextTokens.value).toBe(8_192);
  });

  it('falls back to an explicitly stale cache when online refresh fails', async () => {
    let now = Date.parse('2026-08-07T00:00:00.000Z');
    const directory = await tempDirectory();
    const store = new LlmModelCatalogStore(directory, { now: () => now });
    const manager = new LlmModelCatalogManager({ store, now: () => now });
    const connection = createLlmConnection({ endpoint: 'https://relay.example/v1', apiKey: 'secret' });
    const route = resolution(connection.id);
    await manager.refresh({ connection, resolution: route, provider: new CatalogProvider(['cached-model']), ttlMs: 1 });
    now += 10;

    const snapshot = await manager.refresh({
      connection,
      resolution: { ...route, models: [] },
      provider: new FailingCatalogProvider(),
    });

    expect(snapshot.stale).toBe(true);
    expect(snapshot.models.map((model) => model.modelId)).toEqual(['cached-model']);
    expect(snapshot.models[0]?.displayName.source).toBe('endpoint-cache');
  });

  it('uses the endpoint catalog namespace to resolve model metadata shared by several providers', async () => {
    const catalog: ModelCatalogSnapshot = {
      schemaVersion: 1,
      source: {
        name: 'models.dev',
        url: 'https://models.dev/api.json',
        generatedAt: '2026-08-07T00:00:00.000Z',
      },
      models: {},
      providers: {
        relayA: {
          api: 'https://relay-a.example/v1',
          models: { shared: { name: 'Shared A', limits: { context: 64_000 } } },
        },
        relayB: {
          api: 'https://relay-b.example/v1',
          models: { shared: { name: 'Shared B', limits: { context: 128_000 } } },
        },
      },
    };
    const manager = new LlmModelCatalogManager({
      store: new LlmModelCatalogStore(await tempDirectory()),
      catalog,
    });
    const connection = createLlmConnection({ endpoint: 'https://relay-b.example/v1' });

    await manager.refresh({
      connection,
      resolution: {
        ...resolution(connection.id, 'openai-compatible', ['shared']),
        providerBaseUrl: connection.endpoint,
      },
      provider: new CatalogProvider(['shared']),
    });

    expect(manager.resolve(connection.id, 'shared')).toMatchObject({
      contextTokens: { value: 128_000, source: 'models-dev' },
    });
  });
});

class CatalogProvider implements LlmProvider {
  readonly id = 'provider';
  readonly name = 'Provider';
  readonly mode = 'byok' as const;
  readonly capabilities = { chat: 'supported' as const };
  readonly metadataRequests: string[] = [];

  constructor(
    private readonly catalog: string[],
    private readonly metadata: Record<string, LlmModelMetadata> = {},
  ) {}

  listModels(): Promise<string[]> {
    return Promise.resolve([...this.catalog]);
  }

  getModelMetadata(model: string): Promise<LlmModelMetadata> {
    this.metadataRequests.push(model);
    return Promise.resolve(this.metadata[model] ?? {
      model,
      source: 'provider-api',
      capabilities: {},
    });
  }

  chat() {
    return Promise.resolve({ text: 'ok', toolCalls: [] });
  }

  isAvailable() {
    return Promise.resolve({ available: true });
  }
}

class FailingCatalogProvider extends CatalogProvider {
  constructor() {
    super([]);
  }

  override listModels(): Promise<string[]> {
    return Promise.reject(new Error('endpoint unavailable'));
  }
}

class DelayedCatalogProvider extends CatalogProvider {
  constructor(
    catalog: string[],
    metadataByModel: Record<string, LlmModelMetadata>,
    private readonly delays: Readonly<Record<string, number>>,
  ) {
    super(catalog, metadataByModel);
  }

  override async getModelMetadata(model: string): Promise<LlmModelMetadata> {
    await new Promise((resolve) => setTimeout(resolve, this.delays[model] ?? 0));
    return await super.getModelMetadata(model);
  }
}

async function createManager(): Promise<LlmModelCatalogManager> {
  return new LlmModelCatalogManager({ store: new LlmModelCatalogStore(await tempDirectory()) });
}

async function tempDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'schemanaut-model-manager-'));
  directories.push(path);
  return path;
}

function resolution(
  connectionId: string,
  pluginId = 'openai-compatible',
  models: readonly string[] = [],
): LlmConnectionResolution {
  return {
    connectionId,
    providerId: `${connectionId}:${pluginId}`,
    pluginId,
    pluginVersion: '1.0.0',
    protocol: pluginId === 'ollama-native' ? 'ollama' : 'openai-chat',
    providerBaseUrl: 'https://relay.example/v1',
    models,
    revision: 'route-revision',
    evidence: [],
  };
}

function metadata(
  model: string,
  contextTokens: number,
  seed: 'supported' | 'unsupported',
): LlmModelMetadata {
  return {
    model,
    source: 'provider-api',
    capabilities: { chat: 'supported' },
    contextTokens,
    generationParameters: { seed },
  };
}
