/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-argument -- Provider doubles and Vitest asymmetric matchers are intentionally untyped. */
import { describe, expect, it } from 'vitest';
import {
  LlmModelRegistry,
  LlmProviderError,
  LlmTaskRouter,
  estimateModelCost,
  mergeLlmPolicies,
  type LlmProvider,
} from '../src/index.js';

describe('model registry and policy routing', () => {
  it('keeps platform and organization restrictions when user preferences are merged', () => {
    const registry = new LlmModelRegistry();
    registry.registerProvider(provider('cloud', 'byok'));
    registry.registerProvider(provider('private', 'private'));
    registry.registerModel({
      providerId: 'cloud',
      model: 'cloud-pro',
      quality: 'advanced',
      dataPolicy: { deployment: 'public-cloud', regions: ['us'], allowsSensitiveData: false },
      capabilities: { structuredOutput: 'supported' },
    });
    registry.registerModel({
      providerId: 'private',
      model: 'local-pro',
      quality: 'balanced',
      dataPolicy: {
        deployment: 'private',
        regions: ['cn'],
        allowsSensitiveData: true,
        retainsPrompts: false,
      },
      capabilities: { structuredOutput: 'supported' },
    });

    const route = new LlmTaskRouter(registry).route({
      task: {
        taskType: 'nl2sql',
        requirements: { capabilities: ['chat', 'structuredOutput'], sensitiveData: true },
        preferences: { preferredModelIds: ['cloud:cloud-pro'], optimizeFor: 'quality' },
      },
      policies: {
        organization: { allowPublicCloud: false, allowedRegions: ['cn'] },
        user: { allowPublicCloud: true, preferredModelIds: ['cloud:cloud-pro'] },
      },
    });

    expect(route.selected.model.id).toBe('private:local-pro');
    expect(route.excluded.find((item) => item.modelId === 'cloud:cloud-pro')?.reasons).toContain(
      'public cloud is forbidden',
    );
    expect(route.effectivePolicy.allowPublicCloud).toBe(false);
  });

  it('fails closed for unknown required capabilities and disjoint region policies', () => {
    const registry = new LlmModelRegistry();
    registry.registerProvider(provider('p', 'byok'));
    registry.registerModel({
      providerId: 'p',
      model: 'm',
      dataPolicy: { regions: ['cn'] },
    });
    const router = new LlmTaskRouter(registry);
    expect(() =>
      router.route({
        task: { taskType: 'agent', requirements: { capabilities: ['reasoning'] } },
      }),
    ).toThrowError(expect.objectContaining({ code: 'LLM_NO_ROUTE' }));

    const policy = mergeLlmPolicies({
      platform: { allowedRegions: ['cn'] },
      organization: { allowedRegions: ['us'] },
    });
    expect(policy.allowedRegions).toEqual([]);
    expect(() =>
      router.route({ task: { taskType: 'chat' }, policies: { platform: policy } }),
    ).toThrow(LlmProviderError);
  });

  it('calculates configured token prices without rounding drift', () => {
    const registry = new LlmModelRegistry();
    registry.registerProvider(provider('p', 'managed'));
    const model = registry.registerModel({
      providerId: 'p',
      model: 'priced',
      pricing: {
        currency: 'CNY',
        inputPerMillionTokens: 2,
        outputPerMillionTokens: 8,
      },
    });
    expect(estimateModelCost(model, 250_000, 125_000)).toBe(1.5);
  });

  it('stores declared model metadata without executing a model request', () => {
    const registry = new LlmModelRegistry();
    registry.registerProvider(provider('ollama', 'private'));
    const model = registry.registerModel({ providerId: 'ollama', model: 'qwen2.5-coder:14b' });

    const updated = registry.applyModelMetadata(model.id, {
      model: model.model,
      source: 'provider-api',
      capabilities: { toolCalling: 'supported', reasoning: 'unsupported' },
      contextTokens: 32_768,
      family: 'qwen2',
      parameterSize: '14.8B',
      quantization: 'Q4_K_M',
    });

    expect(updated).toMatchObject({
      capabilities: { toolCalling: 'supported', reasoning: 'unsupported' },
      limits: { contextTokens: 32_768 },
      discovery: {
        source: 'provider-api',
        family: 'qwen2',
        parameterSize: '14.8B',
        quantization: 'Q4_K_M',
      },
    });
  });

  it('does not preserve limits when a custom model id is rebound to another model identity', () => {
    const registry = new LlmModelRegistry();
    registry.registerProvider(provider('first', 'byok'));
    registry.registerProvider(provider('second', 'private'));
    registry.registerModel({
      id: 'reused-model-id',
      providerId: 'first',
      model: 'first-model',
      limits: {
        contextTokens: 1_000_000,
        maxOutputTokens: 384_000,
        effectiveContextTokens: 128_000,
        autoCompactTokenLimit: 100_000,
      },
    });

    const differentModel = registry.registerModel({
      id: 'reused-model-id',
      providerId: 'first',
      model: 'second-model',
    });
    expect(differentModel.limits).toEqual({
      contextTokens: 32_768,
      maxOutputTokens: 4_096,
    });

    registry.registerModel({
      id: 'reused-provider-id',
      providerId: 'first',
      model: 'shared-model',
      limits: { contextTokens: 1_000_000, maxOutputTokens: 384_000 },
    });
    const differentProvider = registry.registerModel({
      id: 'reused-provider-id',
      providerId: 'second',
      model: 'shared-model',
    });
    expect(differentProvider.limits).toEqual({
      contextTokens: 32_768,
      maxOutputTokens: 4_096,
    });
  });

  it('preserves operational context limits while applying provider metadata', () => {
    const registry = new LlmModelRegistry();
    registry.registerProvider(provider('deepseek', 'byok'));
    const model = registry.registerModel({
      providerId: 'deepseek',
      model: 'deepseek-v4-flash',
      limits: {
        effectiveContextTokens: 128_000,
        autoCompactTokenLimit: 100_000,
      },
    });

    const updated = registry.applyModelMetadata(model.id, {
      model: model.model,
      source: 'provider-declaration',
      capabilities: { toolCalling: 'supported' },
      contextTokens: 1_000_000,
    });

    expect(updated.limits).toMatchObject({
      contextTokens: 1_000_000,
      effectiveContextTokens: 128_000,
      autoCompactTokenLimit: 100_000,
    });
  });

  it('restores a threshold-only configuration when authoritative context arrives', () => {
    const registry = new LlmModelRegistry();
    registry.registerProvider(provider('custom', 'byok'));
    const model = registry.registerModel({
      providerId: 'custom',
      model: 'pending-context-model',
      limits: { autoCompactTokenLimit: 100_000 },
    });

    expect(model.limits).toMatchObject({
      contextTokens: 32_768,
      autoCompactTokenLimit: 32_768,
    });

    const updated = registry.applyModelMetadata(model.id, {
      model: model.model,
      source: 'provider-api',
      capabilities: {},
      contextTokens: 1_000_000,
    });

    expect(updated.limits).toMatchObject({
      contextTokens: 1_000_000,
      autoCompactTokenLimit: 100_000,
    });
  });

  it('restores configured operational limits after authoritative context expands', () => {
    const registry = new LlmModelRegistry();
    registry.registerProvider(provider('custom', 'byok'));
    const model = registry.registerModel({
      providerId: 'custom',
      model: 'expanding-context-model',
      limits: {
        contextTokens: 64_000,
        effectiveContextTokens: 128_000,
        autoCompactTokenLimit: 100_000,
      },
    });

    expect(model.limits).toMatchObject({
      contextTokens: 64_000,
      effectiveContextTokens: 64_000,
      autoCompactTokenLimit: 64_000,
    });

    const updated = registry.applyModelMetadata(model.id, {
      model: model.model,
      source: 'provider-api',
      capabilities: {},
      contextTokens: 1_000_000,
    });

    expect(updated.limits).toMatchObject({
      contextTokens: 1_000_000,
      effectiveContextTokens: 128_000,
      autoCompactTokenLimit: 100_000,
    });
  });

  it('clamps operational limits when discovered model capacity is smaller', () => {
    const registry = new LlmModelRegistry();
    registry.registerProvider(provider('custom', 'byok'));
    const model = registry.registerModel({
      providerId: 'custom',
      model: 'shrinking-context-model',
      limits: {
        contextTokens: 200_000,
        effectiveContextTokens: 150_000,
        autoCompactTokenLimit: 140_000,
      },
    });

    const updated = registry.applyModelMetadata(model.id, {
      model: model.model,
      source: 'provider-api',
      capabilities: {},
      contextTokens: 100_000,
    });

    expect(updated.limits).toMatchObject({
      contextTokens: 100_000,
      effectiveContextTokens: 100_000,
      autoCompactTokenLimit: 100_000,
    });
  });
});

function provider(id: string, mode: LlmProvider['mode']): LlmProvider {
  return {
    id,
    name: id,
    mode,
    capabilities: { chat: 'supported' },
    async chat() {
      return { text: 'ok', toolCalls: [] };
    },
    async isAvailable() {
      return { available: true };
    },
  };
}
