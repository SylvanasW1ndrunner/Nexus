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
import { coalesceSystemMessages } from './protocol/system-message-coalescing.js';

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type OpenAIResponsesProviderConfig = {
  id: string;
  name: string;
  apiKey?: string;
  baseUrl: string;
  mode?: LlmProviderMode;
  allowUnauthenticated?: boolean;
  timeoutMs?: number;
  responsesPath?: string;
  modelsPath?: string;
  maxResponseBytes?: number;
  defaultHeaders?: Record<string, string>;
  fetch?: FetchLike;
};

type ResponsesOutputItem =
  | {
      type?: 'message';
      role?: string;
      content?: Array<{ type?: string; text?: string }>;
    }
  | {
      type?: 'function_call';
      id?: string;
      call_id?: string;
      name?: string;
      arguments?: string;
    };

type ResponsesApiResponse = {
  id?: string;
  model?: string;
  status?: string;
  output?: ResponsesOutputItem[];
  output_text?: string;
  incomplete_details?: { reason?: string };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string; code?: string };
};

type ModelsResponse = { data?: Array<{ id?: string }> };

export class OpenAIResponsesProvider implements LlmProvider {
  readonly id: string;
  readonly name: string;
  readonly mode: LlmProviderMode;
  readonly protocol = 'openai-responses';
  readonly capabilities: Partial<LlmProviderCapabilities> = {
    chat: 'supported',
    streaming: 'unknown',
    toolCalling: 'supported',
    structuredOutput: 'supported',
    reasoning: 'supported',
    embeddings: 'unsupported',
    rerank: 'unsupported',
  };
  readonly generationParameters: Partial<LlmGenerationParameterSupport> = {
    temperature: 'unknown',
    topP: 'unknown',
    maxOutputTokens: 'supported',
    seed: 'unsupported',
    stop: 'unsupported',
    reasoningEffort: 'supported',
  };
  readonly protocolProfile: LlmProviderProtocolProfile;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly responsesPath: string;
  private readonly modelsPath: string;
  private readonly maxResponseBytes: number;
  private readonly defaultHeaders: Record<string, string>;
  private readonly fetchImpl: FetchLike;

  constructor(config: OpenAIResponsesProviderConfig) {
    if (!config.apiKey?.trim() && !config.allowUnauthenticated) {
      throw new LlmProviderError('LLM_AUTH_FAILED', 'LLM API key is required.', false, 401);
    }
    this.id = config.id;
    this.name = config.name;
    this.mode = config.mode ?? 'byok';
    this.apiKey = config.apiKey?.trim() ?? '';
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.timeoutMs = config.timeoutMs ?? 60_000;
    this.responsesPath = normalizePath(config.responsesPath ?? '/responses');
    this.modelsPath = normalizePath(config.modelsPath ?? '/models');
    this.maxResponseBytes = resolveLlmMaxResponseBytes(config.maxResponseBytes);
    this.defaultHeaders = { ...(config.defaultHeaders ?? {}) };
    this.fetchImpl = config.fetch ?? fetch;
    this.protocolProfile = resolveLlmProviderProtocolProfile({
      protocol: this.protocol,
      source: 'provider-declaration',
      capabilities: {
        parallelToolCalls: 'supported',
        structuredToolResults: 'supported',
      },
    });
  }

  async chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    const raw = await this.requestJson<ResponsesApiResponse>(
      this.responsesPath,
      buildResponsesPayload(request),
      request.signal,
    );
    return parseResponsesResponse(raw);
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const response = await this.requestGetJson<ModelsResponse>(this.modelsPath, signal);
    return (response.data ?? [])
      .map((item) => item.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
  }

  getModelMetadata(model: string): Promise<LlmModelMetadata> {
    return Promise.resolve({
      model,
      source: 'provider-declaration',
      capabilities: { ...this.capabilities },
      generationParameters: { ...this.generationParameters },
    });
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
          : { detail: `Model is not advertised by the endpoint: ${model}` }),
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
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
          ...this.defaultHeaders,
        },
        signal: controller.signal,
      });
      const text = await readLimitedResponseText(response, this.maxResponseBytes);
      const parsed = safeJson(text) as T & { error?: { message?: string } };
      if (!response.ok) {
        const message = parsed?.error?.message ?? `Responses endpoint returned HTTP ${response.status}.`;
        throw httpError(response.status, message);
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
          `LLM request timed out after ${this.timeoutMs}ms.`,
          true,
        );
      }
      throw new LlmProviderError(
        'LLM_NETWORK_ERROR',
        error instanceof Error ? error.message : 'LLM request failed.',
        true,
      );
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }
}

function buildResponsesPayload(request: LlmChatRequest): Record<string, unknown> {
  const input: Array<Record<string, unknown>> = [];
  for (const message of coalesceSystemMessages(request.messages)) {
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.toolCallId ?? message.name ?? 'unknown_tool_call',
        output: message.content,
      });
      continue;
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      if (message.content) input.push({ role: 'assistant', content: message.content });
      input.push(
        ...message.toolCalls.map((call) => ({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        })),
      );
      continue;
    }
    input.push({ role: message.role, content: message.content });
  }
  return {
    model: request.model,
    input,
    ...(request.tools?.length
      ? {
          tools: request.tools.map((tool) => ({
            type: 'function',
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          })),
        }
      : {}),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.topP === undefined ? {} : { top_p: request.topP }),
    ...(request.maxTokens === undefined ? {} : { max_output_tokens: request.maxTokens }),
    ...(request.reasoning?.effort === undefined
      ? {}
      : { reasoning: { effort: request.reasoning.effort } }),
  };
}

function parseResponsesResponse(response: ResponsesApiResponse): LlmChatResponse {
  const output = response.output ?? [];
  const text =
    response.output_text ??
    output
      .filter((item) => item.type === 'message')
      .flatMap((item) => ('content' in item ? (item.content ?? []) : []))
      .filter((block) => block.type === 'output_text')
      .map((block) => block.text ?? '')
      .join('');
  const toolCalls: LlmToolCall[] = output
    .filter((item) => item.type === 'function_call')
    .map((item, index) => {
      const call = item as Extract<ResponsesOutputItem, { type?: 'function_call' }>;
      return {
        id: call.call_id ?? call.id ?? `${response.id ?? 'response'}-call-${index}`,
        name: call.name ?? 'unknown_tool',
        arguments: parseArguments(call.arguments ?? '{}'),
      };
    });
  const usage = parseUsage(response.usage);
  return {
    text,
    toolCalls,
    ...(usage === undefined ? {} : { usage }),
    ...(response.id === undefined ? {} : { providerResponseId: response.id }),
    ...(response.model === undefined ? {} : { model: response.model }),
    ...(response.status === undefined
      ? {}
      : {
          finishReason:
            response.status === 'incomplete'
              ? (response.incomplete_details?.reason ?? response.status)
              : response.status,
        }),
  };
}

function parseArguments(raw: string): Record<string, unknown> {
  const value = safeJson(raw);
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value };
}

function parseUsage(usage: ResponsesApiResponse['usage']): LlmUsage | undefined {
  if (!usage) return undefined;
  const promptTokens = usage.input_tokens ?? 0;
  const completionTokens = usage.output_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: usage.total_tokens ?? promptTokens + completionTokens,
  };
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new LlmProviderError('LLM_BAD_RESPONSE', 'Provider returned invalid JSON.', false);
  }
}

function httpError(status: number, message: string): LlmProviderError {
  if (status === 401 || status === 403)
    return new LlmProviderError('LLM_AUTH_FAILED', message, false, status);
  if (status === 408 || status === 429)
    return new LlmProviderError('LLM_RATE_LIMITED', message, true, status);
  return new LlmProviderError('LLM_PROVIDER_ERROR', message, status >= 500, status);
}

function normalizeBaseUrl(value: string): string {
  if (!value.trim()) throw new Error('LLM baseUrl is required.');
  return value.replace(/\/+$/, '');
}

function normalizePath(value: string): string {
  return value.startsWith('/') ? value : `/${value}`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
