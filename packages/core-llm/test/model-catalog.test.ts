import { describe, expect, it } from 'vitest';
import {
  LlmModelRegistry,
  type LlmProvider,
} from '../src/index.js';

const catalog = {
  schemaVersion: 1,
  source: {
    name: 'models.dev',
    url: 'https://models.dev/api.json',
    generatedAt: '2026-08-06T00:00:00.000Z',
  },
  providers: {
    deepseek: {
      models: {
        'deepseek-chat': {
          name: 'DeepSeek Chat',
          family: 'deepseek',
          limits: { context: 128_000, input: 64_000, output: 8_192 },
          capabilities: {
            toolCalling: true,
            reasoning: false,
            structuredOutput: true,
            temperature: true,
          },
          cost: { input: 0.28, output: 0.42 },
        },
      },
    },
  },
} as const;

describe('model metadata catalog', () => {
  it('keeps unknown physical limits unknown instead of inventing a 32K window', () => {
    const registry = new LlmModelRegistry();
    registry.registerProvider(provider('proxy'));

    const model = registry.registerModel({ providerId: 'proxy', model: 'private-model' });

    expect(model.limits).toEqual({
      contextTokens: null,
      maxInputTokens: null,
      maxOutputTokens: null,
    });
  });

  it('uses a canonical model for snapshot metadata while preserving the endpoint model id', () => {
    const registry = new LlmModelRegistry({ catalog });
    registry.registerProvider(provider('proxy'));

    const model = registry.registerModel({
      providerId: 'proxy',
      model: 'company-ds',
      canonicalModel: 'deepseek/deepseek-chat',
    });

    expect(model.model).toBe('company-ds');
    expect(model).toMatchObject({
      canonicalModel: 'deepseek/deepseek-chat',
      limits: {
        contextTokens: 128_000,
        maxInputTokens: 64_000,
        maxOutputTokens: 8_192,
      },
      capabilities: {
        toolCalling: 'supported',
        reasoning: 'unsupported',
        structuredOutput: 'supported',
      },
      generationParameters: { temperature: 'supported' },
      discovery: { source: 'models-dev', sources: ['models-dev'] },
    });
  });

  it('resolves an exact model id through the catalog when a custom endpoint has one unique match', () => {
    const registry = new LlmModelRegistry({ catalog });
    registry.registerProvider(provider('third-party-relay'));

    const model = registry.registerModel({
      providerId: 'third-party-relay',
      model: 'deepseek-chat',
    });

    expect(model).toMatchObject({
      canonicalModel: 'deepseek/deepseek-chat',
      limits: { contextTokens: 128_000, maxInputTokens: 64_000, maxOutputTokens: 8_192 },
      discovery: { source: 'models-dev' },
    });
  });

  it('lets endpoint metadata override only the fields it actually reports', () => {
    const registry = new LlmModelRegistry({ catalog });
    registry.registerProvider(provider('proxy'));
    const model = registry.registerModel({
      providerId: 'proxy',
      model: 'company-ds',
      canonicalModel: 'deepseek/deepseek-chat',
    });

    const updated = registry.applyModelMetadata(model.id, {
      model: 'company-ds',
      source: 'provider-api',
      capabilities: { reasoning: 'supported' },
      contextTokens: 96_000,
      generationParameters: { temperature: 'unsupported' },
    });

    expect(updated.limits).toEqual({
      contextTokens: 96_000,
      maxInputTokens: 64_000,
      maxOutputTokens: 8_192,
    });
    expect(updated.capabilities.reasoning).toBe('supported');
    expect(updated.generationParameters.temperature).toBe('unsupported');
    expect(updated.discovery).toMatchObject({
      source: 'provider-api',
      sources: ['models-dev', 'provider-api'],
    });
  });
});

function provider(id: string): LlmProvider {
  return {
    id,
    name: id,
    mode: 'byok',
    capabilities: { chat: 'supported' },
    chat() {
      return Promise.resolve({ text: 'ok', toolCalls: [] });
    },
    isAvailable() {
      return Promise.resolve({ available: true });
    },
  };
}
