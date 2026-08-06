import { AnthropicProvider } from './anthropic-provider.js';
import { OllamaProvider } from './ollama-provider.js';
import { OpenAICompatibleProvider } from './openai-compatible-provider.js';
import { OpenAIResponsesProvider } from './openai-responses-provider.js';
import type { LlmProvider, LlmProviderCapabilities, LlmProviderMode } from './types.js';

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type LlmEndpointProtocol =
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic'
  | 'ollama'
  | 'vllm';

export type CreateLlmProviderOptions = {
  protocol: LlmEndpointProtocol;
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  mode?: LlmProviderMode;
  allowUnauthenticated?: boolean;
  apiVersion?: string;
  timeoutMs?: number;
  maxRetries?: number;
  capabilities?: Partial<LlmProviderCapabilities>;
  fetch?: FetchLike;
};

/** Maps a configured endpoint protocol to its native wire adapter. */
export function createLlmProvider(options: CreateLlmProviderOptions): LlmProvider {
  switch (options.protocol) {
    case 'openai-chat':
    case 'vllm':
      return new OpenAICompatibleProvider({
        id: options.id,
        name: options.name,
        baseUrl: options.baseUrl,
        ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        ...(options.mode === undefined
          ? options.protocol === 'vllm'
            ? { mode: 'private' as const }
            : {}
          : { mode: options.mode }),
        ...((options.allowUnauthenticated ?? options.protocol === 'vllm')
          ? { allowUnauthenticated: true }
          : {}),
        metadataSource: 'openai-compatible',
        ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
    case 'openai-responses':
      return new OpenAIResponsesProvider({
        id: options.id,
        name: options.name,
        baseUrl: options.baseUrl,
        ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        ...(options.mode === undefined ? {} : { mode: options.mode }),
        ...(options.allowUnauthenticated ? { allowUnauthenticated: true } : {}),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
    case 'anthropic':
      if (!options.apiKey?.trim()) throw new Error('Anthropic protocol requires an API key.');
      return new AnthropicProvider({
        id: options.id,
        name: options.name,
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
        ...(options.mode === undefined ? {} : { mode: options.mode }),
        ...(options.apiVersion === undefined ? {} : { apiVersion: options.apiVersion }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
    case 'ollama':
      return new OllamaProvider({
        id: options.id,
        name: options.name,
        baseUrl: options.baseUrl,
        ...(options.mode === undefined ? {} : { mode: options.mode }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
  }
}
