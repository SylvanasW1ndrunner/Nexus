import {
  LlmProviderError,
  type LlmChatRequest,
  type LlmChatResponse,
  type LlmModelMetadata,
  type LlmGenerationParameterSupport,
  type LlmProvider,
  type LlmProviderAvailability,
  type LlmProviderCapabilities,
  type LlmProviderMode,
  type LlmProviderProtocolProfile,
  type LlmToolCall,
  type LlmUsage,
} from './types.js';
import { resolveLlmProviderProtocolProfile } from './provider-protocol-profile.js';
import { readLimitedResponseText, resolveLlmMaxResponseBytes } from './stream-safety.js';
import { assertNoTextualToolInvocation, coalesceSystemMessages } from './tool-protocol.js';

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type OllamaProviderConfig = {
  id?: string;
  name?: string;
  baseUrl?: string;
  mode?: LlmProviderMode;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetch?: FetchLike;
};

type OllamaToolCall = {
  function?: { name?: string; arguments?: unknown };
};

type OllamaChatResponse = {
  model?: string;
  created_at?: string;
  message?: {
    role?: string;
    content?: string;
    thinking?: string;
    tool_calls?: OllamaToolCall[];
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
};

type OllamaTagsResponse = {
  models?: Array<{ name?: string; model?: string }>;
};

type OllamaShowResponse = {
  capabilities?: string[];
  details?: {
    family?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
  model_info?: Record<string, unknown>;
};

export class OllamaProvider implements LlmProvider {
  readonly id: string;
  readonly name: string;
  readonly mode: LlmProviderMode;
  readonly protocol = 'ollama-chat';
  readonly capabilities: Partial<LlmProviderCapabilities> = {
    chat: 'supported',
    streaming: 'unknown',
    toolCalling: 'unknown',
    structuredOutput: 'unknown',
    reasoning: 'unknown',
    embeddings: 'unknown',
    rerank: 'unsupported',
  };
  readonly generationParameters: Partial<LlmGenerationParameterSupport> = {
    temperature: 'supported',
    topP: 'supported',
    maxOutputTokens: 'supported',
    seed: 'supported',
    stop: 'supported',
    reasoningEffort: 'unsupported',
  };
  readonly protocolProfile: LlmProviderProtocolProfile;

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetchImpl: FetchLike;
  private responseSequence = 0;

  constructor(config: OllamaProviderConfig = {}) {
    this.id = config.id ?? 'ollama';
    this.name = config.name ?? 'Ollama';
    this.mode = config.mode ?? 'private';
    this.baseUrl = normalizeOllamaBaseUrl(config.baseUrl ?? 'http://127.0.0.1:11434');
    this.timeoutMs = config.timeoutMs ?? 60_000;
    this.maxResponseBytes = resolveLlmMaxResponseBytes(config.maxResponseBytes);
    this.fetchImpl = config.fetch ?? fetch;
    this.protocolProfile = resolveLlmProviderProtocolProfile({
      protocol: this.protocol,
      source: config.baseUrl === undefined ? 'builtin' : 'provider-declaration',
      capabilities: { structuredToolResults: 'supported' },
    });
  }

  async chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    const sequence = ++this.responseSequence;
    const raw = await this.requestJson<OllamaChatResponse>(
      '/api/chat',
      buildOllamaPayload(request, false),
      request.signal,
    );
    const response = parseOllamaResponse(raw, sequence);
    assertNoTextualToolInvocation({
      text: response.text,
      toolCalls: response.toolCalls,
      toolsRequested: Boolean(request.tools?.length),
      protocol: 'Ollama native chat',
    });
    return response;
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const response = await this.requestGetJson<OllamaTagsResponse>('/api/tags', signal);
    return (response.models ?? [])
      .map((model) => model.model ?? model.name)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
  }

  async getModelMetadata(model: string, signal?: AbortSignal): Promise<LlmModelMetadata> {
    const response = await this.requestJson<OllamaShowResponse>('/api/show', { model }, signal);
    const advertised = Array.isArray(response.capabilities);
    const capabilities = new Set(response.capabilities ?? []);
    const contextTokens = Object.entries(response.model_info ?? {}).find(
      ([key, value]) =>
        key.endsWith('.context_length') && Number.isInteger(value) && Number(value) > 0,
    )?.[1];
    return {
      model,
      source: 'provider-api',
      capabilities: {
        ...this.capabilities,
        ...(advertised
          ? {
              chat: capabilities.has('completion') ? 'supported' : 'unsupported',
              toolCalling: capabilities.has('tools') ? 'supported' : 'unsupported',
              reasoning: capabilities.has('thinking') ? 'supported' : 'unsupported',
              embeddings: capabilities.has('embedding') ? 'supported' : 'unsupported',
            }
          : {}),
      },
      generationParameters: { ...this.generationParameters },
      ...(typeof contextTokens === 'number' ? { contextTokens } : {}),
      ...(response.details?.family ? { family: response.details.family } : {}),
      ...(response.details?.parameter_size
        ? { parameterSize: response.details.parameter_size }
        : {}),
      ...(response.details?.quantization_level
        ? { quantization: response.details.quantization_level }
        : {}),
    };
  }

  async isAvailable(model?: string, signal?: AbortSignal): Promise<LlmProviderAvailability> {
    const startedAt = performance.now();
    try {
      const models = await this.listModels(signal);
      const available = model === undefined || models.includes(model);
      return {
        available,
        latencyMs: performance.now() - startedAt,
        ...(available || model === undefined
          ? {}
          : { detail: `Model is not installed in Ollama: ${model}` }),
      };
    } catch (error) {
      return {
        available: false,
        latencyMs: performance.now() - startedAt,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async requestJson<T>(
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    return await this.fetchJson<T>(path, { method: 'POST', body: JSON.stringify(body) }, signal);
  }

  private async requestGetJson<T>(path: string, signal?: AbortSignal): Promise<T> {
    return await this.fetchJson<T>(path, { method: 'GET' }, signal);
  }

  private async fetchJson<T>(
    path: string,
    init: Pick<RequestInit, 'method' | 'body'>,
    signal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
      });
      const text = await readLimitedResponseText(response, this.maxResponseBytes);
      const parsed = safeJson(text) as T & { error?: string };
      if (!response.ok || parsed?.error) {
        throw new LlmProviderError(
          'LLM_PROVIDER_ERROR',
          parsed?.error ?? `Ollama returned HTTP ${response.status}.`,
          response.status >= 500,
          response.status,
        );
      }
      return parsed;
    } catch (error) {
      if (error instanceof LlmProviderError) throw error;
      if (isAbortError(error)) {
        if (!timedOut && signal?.aborted) {
          throw new LlmProviderError('LLM_ABORTED', 'LLM request was aborted by the user.', false);
        }
        throw new LlmProviderError(
          'LLM_TIMEOUT',
          `Ollama request timed out after ${this.timeoutMs}ms.`,
          true,
        );
      }
      throw new LlmProviderError(
        'LLM_NETWORK_ERROR',
        error instanceof Error ? error.message : 'Ollama request failed.',
        true,
      );
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }
}

function buildOllamaPayload(request: LlmChatRequest, stream: boolean): Record<string, unknown> {
  const options = {
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.topP === undefined ? {} : { top_p: request.topP }),
    ...(request.maxTokens === undefined ? {} : { num_predict: request.maxTokens }),
    ...(request.seed === undefined ? {} : { seed: request.seed }),
    ...(request.stop === undefined ? {} : { stop: request.stop }),
  };
  return {
    model: request.model,
    stream,
    messages: coalesceSystemMessages(request.messages).map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.role === 'tool' && message.name ? { tool_name: message.name } : {}),
      ...(message.toolCalls?.length
        ? {
            tool_calls: message.toolCalls.map((call) => ({
              function: { name: call.name, arguments: call.arguments },
            })),
          }
        : {}),
    })),
    ...(request.tools?.length
      ? {
          tools: request.tools.map((tool) => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            },
          })),
        }
      : {}),
    ...(Object.keys(options).length === 0 ? {} : { options }),
  };
}

function parseOllamaResponse(response: OllamaChatResponse, sequence: number): LlmChatResponse {
  const toolCalls: LlmToolCall[] = (response.message?.tool_calls ?? []).map((call, index) => ({
    id: `ollama-${sequence}-${index}`,
    name: call.function?.name ?? 'unknown_tool',
    arguments: asRecord(call.function?.arguments),
  }));
  const usage = usageFromCounts(response.prompt_eval_count, response.eval_count);
  return {
    text: response.message?.content ?? '',
    toolCalls,
    ...(usage === undefined ? {} : { usage }),
    ...(response.model === undefined ? {} : { model: response.model }),
    ...(response.done_reason === undefined ? {} : { finishReason: response.done_reason }),
  };
}

function usageFromCounts(input?: number, output?: number): LlmUsage | undefined {
  if (input === undefined && output === undefined) return undefined;
  const promptTokens = input ?? 0;
  const completionTokens = output ?? 0;
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : { value: parsed };
    } catch {
      return { raw: value };
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value };
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new LlmProviderError('LLM_BAD_RESPONSE', 'Ollama returned invalid JSON.', false);
  }
}

function normalizeOllamaBaseUrl(value: string): string {
  if (!value.trim()) throw new Error('Ollama baseUrl is required.');
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/v1\/?$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
