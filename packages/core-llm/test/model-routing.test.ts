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
