import { describe, expect, it } from 'vitest';
import {
  LlmModelsDevIndex,
  mergeLlmCatalogModel,
  type LlmModelMetadataCandidate,
  type ModelCatalogSnapshot,
} from '../src/index.js';

const catalog: ModelCatalogSnapshot = {
  schemaVersion: 1,
  source: {
    name: 'models.dev',
    url: 'https://models.dev/api.json',
    generatedAt: '2026-08-07T00:00:00.000Z',
  },
  models: {
    'vendor/base-only': {
      name: 'Base only',
      family: 'base',
      limits: { context: 204_800, output: 32_768 },
      capabilities: { toolCalling: true },
    },
  },
  providers: {
    openai: {
      models: {
        'gpt-vision': {
          name: 'GPT Vision',
          family: 'gpt-vision',
          limits: { context: 128_000, output: 16_384 },
          capabilities: { toolCalling: true, reasoning: false, structuredOutput: true },
          cost: { input: 1, output: 4 },
        },
        'text-embedding-3-small': {
          name: 'Embedding Small',
          family: 'text-embedding',
          limits: { context: 8_191, output: 1_536 },
          capabilities: { toolCalling: false, reasoning: false },
        },
      },
    },
    cohere: {
      models: {
        'rerank-v3.5': {
          name: 'Rerank 3.5',
          family: 'rerank',
          limits: { context: 4_096 },
        },
      },
    },
    relayA: { models: { duplicate: { name: 'Duplicate A' } } },
    relayB: {
      api: 'https://relay-b.example/v1',
      models: { duplicate: { name: 'Duplicate B', limits: { context: 96_000 } } },
    },
    relayMirror: {
      api: 'https://relay-b.example/v1/',
      models: { mirror: { name: 'Mirror' } },
    },
  },
};

describe('field-provenance model metadata', () => {
  it('merges every field independently by source priority', () => {
    const candidates: LlmModelMetadataCandidate[] = [
      {
        source: 'models-dev',
        displayName: 'Catalog name',
        contextTokens: 128_000,
        maxOutputTokens: 16_384,
        capabilities: { toolCalling: 'supported', reasoning: 'unsupported' },
      },
      {
        source: 'provider-plugin',
        generationParameters: { temperature: 'supported' },
        capabilities: { streaming: 'supported' },
      },
      {
        source: 'endpoint-cache',
        contextTokens: 96_000,
        family: 'cached-family',
      },
      {
        source: 'endpoint',
        contextTokens: 64_000,
        capabilities: { reasoning: 'supported' },
      },
    ];

    const model = mergeLlmCatalogModel({
      connectionId: 'connection-a',
      modelId: 'physical-model',
      candidates,
    });

    expect(model.contextTokens).toEqual({ value: 64_000, source: 'endpoint' });
    expect(model.maxOutputTokens).toEqual({ value: 16_384, source: 'models-dev' });
    expect(model.family).toEqual({ value: 'cached-family', source: 'endpoint-cache' });
    expect(model.capabilities.reasoning).toEqual({ value: 'supported', source: 'endpoint' });
    expect(model.capabilities.toolCalling).toEqual({ value: 'supported', source: 'models-dev' });
    expect(model.capabilities.streaming).toEqual({ value: 'supported', source: 'provider-plugin' });
    expect(model.generationParameters.temperature).toEqual({
      value: 'supported',
      source: 'provider-plugin',
    });
  });

  it('never lets null or unknown overwrite a known lower-priority value', () => {
    const model = mergeLlmCatalogModel({
      connectionId: 'connection-a',
      modelId: 'model',
      candidates: [
        {
          source: 'models-dev',
          contextTokens: 128_000,
          capabilities: { toolCalling: 'supported' },
        },
        {
          source: 'endpoint',
          contextTokens: null,
          capabilities: { toolCalling: 'unknown' },
        },
      ],
    });

    expect(model.contextTokens).toEqual({ value: 128_000, source: 'models-dev' });
    expect(model.capabilities.toolCalling).toEqual({ value: 'supported', source: 'models-dev' });
  });

  it('keeps renamed and ambiguous relay models unknown without fuzzy aliases', () => {
    const index = new LlmModelsDevIndex(catalog);

    expect(index.resolve('company-private-name')).toBeUndefined();
    expect(index.resolve('duplicate')).toBeUndefined();
  });

  it('supports exact provider hints and unique base-model mapping without fuzzy aliases', () => {
    const index = new LlmModelsDevIndex(catalog);

    expect(index.resolve('duplicate', 'relayA')).toMatchObject({ displayName: 'Duplicate A' });
    expect(index.resolve('vendor/text-embedding-3-small')).toMatchObject({
      displayName: 'Embedding Small',
    });
    expect(index.resolve('gpt-vis')).toBeUndefined();
    expect(index.resolve('relay/base-only')).toMatchObject({ contextTokens: 204_800 });
  });

  it('maps a normalized endpoint to one catalog provider only when the endpoint is unique', () => {
    const ambiguousIndex = new LlmModelsDevIndex(catalog);
    const uniqueCatalog: ModelCatalogSnapshot = {
      ...catalog,
      providers: {
        ...catalog.providers,
        relayMirror: {
          api: 'https://mirror.example/v1/',
          models: { mirror: { name: 'Mirror' } },
        },
      },
    };

    const index = new LlmModelsDevIndex(uniqueCatalog);

    expect(index.providerForEndpoint('https://mirror.example/v1')).toBe('relayMirror');
    expect(index.providerForEndpoint('https://relay-b.example/v1')).toBe('relayB');
    expect(ambiguousIndex.providerForEndpoint('https://relay-b.example/v1')).toBeUndefined();
    expect(index.providerForEndpoint('https://unknown.example/v1')).toBeUndefined();
  });

  it('classifies generation, embedding, rerank and vision roles as independent facts', () => {
    const index = new LlmModelsDevIndex(catalog);
    const vision = index.resolve('gpt-vision', 'openai')!;
    const embedding = index.resolve('text-embedding-3-small', 'openai')!;
    const rerank = index.resolve('rerank-v3.5', 'cohere')!;

    expect(vision.roles).toMatchObject({ generation: true, vision: true });
    expect(embedding.roles).toMatchObject({ generation: false, embedding: true });
    expect(rerank.roles).toMatchObject({ generation: false, rerank: true });
  });

  it('merges a 10,000-model catalog without losing typed metadata', () => {
    const candidate: LlmModelMetadataCandidate = {
      source: 'endpoint',
      contextTokens: 128_000,
      capabilities: { chat: 'supported', toolCalling: 'supported' },
      roles: { generation: true },
    };
    for (let index = 0; index < 100; index += 1) {
      mergeLlmCatalogModel({ connectionId: 'warm', modelId: String(index), candidates: [candidate] });
    }

    let merged;
    for (let index = 0; index < 10_000; index += 1) {
      merged = mergeLlmCatalogModel({
        connectionId: 'benchmark',
        modelId: `model-${index}`,
        candidates: [candidate],
      });
    }

    expect(merged).toMatchObject({
      connectionId: 'benchmark',
      modelId: 'model-9999',
      contextTokens: { value: 128_000, source: 'endpoint' },
      capabilities: { toolCalling: { value: 'supported', source: 'endpoint' } },
    });
  });
});
