import type { OllamaProvider } from './ollama-provider.js';
import type { OpenAICompatibleProvider } from './openai-compatible-provider.js';
import type { OpenAIResponsesProvider } from './openai-responses-provider.js';
import type { AnthropicProvider } from './anthropic-provider.js';
import {
  createLlmProvider,
  type CreateLlmProviderOptions,
  type LlmEndpointProtocol,
} from './provider-factory.js';
import type { LlmProvider, LlmProviderCapabilities, LlmProviderMode } from './types.js';

export type LlmProviderPreset = {
  id: string;
  name: string;
  protocol: LlmEndpointProtocol;
  baseUrl: string;
  mode: LlmProviderMode;
  requiresApiKey: boolean;
  capabilities: Partial<LlmProviderCapabilities>;
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
    id: 'openai',
    name: 'OpenAI Chat Completions',
    protocol: 'openai-chat',
    baseUrl: 'https://api.openai.com/v1',
    mode: 'byok',
    requiresApiKey: true,
    capabilities: { ...CLOUD_CAPABILITIES },
    documentationUrl: 'https://platform.openai.com/docs/',
  },
  {
    id: 'openai-responses',
    name: 'OpenAI Responses',
    protocol: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    mode: 'byok',
    requiresApiKey: true,
    capabilities: { ...CLOUD_CAPABILITIES, reasoning: 'supported' },
    documentationUrl: 'https://platform.openai.com/docs/api-reference/responses',
  },
  {
    id: 'anthropic',
    name: 'Anthropic Messages',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    mode: 'byok',
    requiresApiKey: true,
    capabilities: { ...CLOUD_CAPABILITIES },
    documentationUrl: 'https://docs.anthropic.com/en/api/messages',
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    protocol: 'openai-chat',
    baseUrl: 'https://api.siliconflow.cn/v1',
    mode: 'byok',
    requiresApiKey: true,
    capabilities: { ...CLOUD_CAPABILITIES, embeddings: 'supported', rerank: 'supported' },
    documentationUrl: 'https://docs.siliconflow.cn/',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    protocol: 'openai-chat',
    baseUrl: 'https://api.deepseek.com',
    mode: 'byok',
    requiresApiKey: true,
    capabilities: { ...CLOUD_CAPABILITIES, reasoning: 'supported' },
    documentationUrl: 'https://api-docs.deepseek.com/',
  },
  {
    id: 'zhipu',
    name: 'Zhipu AI',
    protocol: 'openai-chat',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    mode: 'byok',
    requiresApiKey: true,
    capabilities: { ...CLOUD_CAPABILITIES },
  },
  {
    id: 'moonshot',
    name: 'Moonshot AI',
    protocol: 'openai-chat',
    baseUrl: 'https://api.moonshot.cn/v1',
    mode: 'byok',
    requiresApiKey: true,
    capabilities: { ...CLOUD_CAPABILITIES },
  },
  {
    id: 'ollama',
    name: 'Ollama',
    protocol: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    mode: 'private',
    requiresApiKey: false,
    capabilities: {
      chat: 'supported',
      streaming: 'unknown',
      toolCalling: 'unknown',
      structuredOutput: 'unknown',
      embeddings: 'unknown',
    },
  },
  {
    id: 'vllm',
    name: 'vLLM',
    protocol: 'vllm',
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
    ? { ...preset, capabilities: { ...preset.capabilities } }
    : undefined;
}

type PresetFactoryOptions = {
  apiKey?: string;
  baseUrl?: string;
  id?: string;
  name?: string;
  mode?: LlmProviderMode;
  timeoutMs?: number;
  maxRetries?: number;
  apiVersion?: string;
  fetch?: CreateLlmProviderOptions['fetch'];
};

export function createProviderFromPreset(
  presetId: 'ollama',
  options?: PresetFactoryOptions,
): OllamaProvider;
export function createProviderFromPreset(
  presetId: 'openai-responses',
  options?: PresetFactoryOptions,
): OpenAIResponsesProvider;
export function createProviderFromPreset(
  presetId: 'anthropic',
  options?: PresetFactoryOptions,
): AnthropicProvider;
export function createProviderFromPreset(
  presetId: 'openai' | 'siliconflow' | 'deepseek' | 'zhipu' | 'moonshot' | 'vllm',
  options?: PresetFactoryOptions,
): OpenAICompatibleProvider;
export function createProviderFromPreset(
  presetId: string,
  options?: PresetFactoryOptions,
): LlmProvider;
export function createProviderFromPreset(
  presetId: string,
  options: PresetFactoryOptions = {},
): LlmProvider {
  const preset = getLlmProviderPreset(presetId);
  if (!preset) throw new Error(`Unknown LLM provider preset: ${presetId}`);
  return createLlmProvider({
    protocol: preset.protocol,
    id: options.id ?? preset.id,
    name: options.name ?? preset.name,
    baseUrl: options.baseUrl ?? preset.baseUrl,
    mode: options.mode ?? preset.mode,
    capabilities: preset.capabilities,
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(!preset.requiresApiKey ? { allowUnauthenticated: true } : {}),
    ...(options.apiVersion === undefined ? {} : { apiVersion: options.apiVersion }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}
