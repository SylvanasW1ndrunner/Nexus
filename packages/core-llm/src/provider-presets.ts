import { OpenAICompatibleProvider, type OpenAICompatibleProviderConfig } from './openai-compatible-provider.js';
import type {
  LlmModelMetadata,
  LlmProviderCapabilities,
  LlmProviderMode,
} from './types.js';

export type LlmProviderPreset = {
  id: string;
  name: string;
  protocol: 'openai-compatible';
  baseUrl: string;
  mode: LlmProviderMode;
  requiresApiKey: boolean;
  metadataSource?: 'openai-compatible' | 'ollama';
  capabilities: Partial<LlmProviderCapabilities>;
  models?: readonly Omit<LlmModelMetadata, 'source'>[];
  documentationUrl?: string;
};

const CLOUD_CAPABILITIES: Partial<LlmProviderCapabilities> = {
  chat: 'supported',
  streaming: 'supported',
  toolCalling: 'supported',
  structuredOutput: 'unknown',
  reasoning: 'unknown',
  embeddings: 'unknown',
  rerank: 'unknown',
};

export const LLM_PROVIDER_PRESETS: readonly LlmProviderPreset[] = Object.freeze([
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.siliconflow.cn/v1',
    mode: 'byok',
    requiresApiKey: true,
    capabilities: { ...CLOUD_CAPABILITIES, embeddings: 'supported', rerank: 'supported' },
    documentationUrl: 'https://docs.siliconflow.cn/',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    mode: 'byok',
    requiresApiKey: true,
    capabilities: { ...CLOUD_CAPABILITIES, reasoning: 'supported' },
    models: [
      deepSeekV4Model('deepseek-v4-flash'),
      deepSeekV4Model('deepseek-v4-pro'),
    ],
    documentationUrl: 'https://api-docs.deepseek.com/',
  },
  {
    id: 'zhipu',
    name: 'Zhipu AI',
    protocol: 'openai-compatible',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    mode: 'byok',
    requiresApiKey: true,
    capabilities: { ...CLOUD_CAPABILITIES },
  },
  {
    id: 'moonshot',
    name: 'Moonshot AI',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.moonshot.cn/v1',
    mode: 'byok',
    requiresApiKey: true,
    capabilities: { ...CLOUD_CAPABILITIES },
  },
  {
    id: 'ollama',
    name: 'Ollama',
    protocol: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:11434/v1',
    mode: 'private',
    requiresApiKey: false,
    metadataSource: 'ollama',
    capabilities: {
      chat: 'supported',
      streaming: 'supported',
      toolCalling: 'unknown',
      structuredOutput: 'unknown',
      embeddings: 'supported',
    },
  },
  {
    id: 'vllm',
    name: 'vLLM',
    protocol: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:8000/v1',
    mode: 'private',
    requiresApiKey: false,
    capabilities: {
      chat: 'supported',
      streaming: 'supported',
      toolCalling: 'unknown',
      structuredOutput: 'unknown',
      embeddings: 'unknown',
    },
  },
]);

export function getLlmProviderPreset(id: string): LlmProviderPreset | undefined {
  const preset = LLM_PROVIDER_PRESETS.find((candidate) => candidate.id === id);
  return preset
    ? {
        ...preset,
        capabilities: { ...preset.capabilities },
        ...(preset.models === undefined
          ? {}
          : { models: preset.models.map((model) => structuredClone(model)) }),
      }
    : undefined;
}

export function createProviderFromPreset(
  presetId: string,
  options: {
    apiKey?: string;
    baseUrl?: string;
    id?: string;
    name?: string;
    mode?: LlmProviderMode;
    timeoutMs?: number;
    maxRetries?: number;
    fetch?: OpenAICompatibleProviderConfig['fetch'];
  } = {},
): OpenAICompatibleProvider {
  const preset = getLlmProviderPreset(presetId);
  if (!preset) throw new Error(`Unknown LLM provider preset: ${presetId}`);
  return new OpenAICompatibleProvider({
    id: options.id ?? preset.id,
    name: options.name ?? preset.name,
    baseUrl: options.baseUrl ?? preset.baseUrl,
    mode: options.mode ?? preset.mode,
    metadataSource: preset.metadataSource ?? 'openai-compatible',
    capabilities: preset.capabilities,
    ...(preset.models === undefined
      ? {}
      : {
          modelMetadata: preset.models.map((entry) => ({
            ...structuredClone(entry),
            source: 'provider-declaration' as const,
          })),
        }),
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(!preset.requiresApiKey && !options.apiKey ? { allowUnauthenticated: true } : {}),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}

function deepSeekV4Model(model: string): Omit<LlmModelMetadata, 'source'> {
  return {
    model,
    capabilities: {
      chat: 'supported',
      streaming: 'supported',
      toolCalling: 'supported',
      structuredOutput: 'supported',
      reasoning: 'supported',
    },
    contextTokens: 1_000_000,
    maxOutputTokens: 384_000,
    family: 'DeepSeek-V4',
  };
}
