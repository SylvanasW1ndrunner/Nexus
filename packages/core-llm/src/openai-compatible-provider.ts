import {
  LlmProviderError,
  type LlmChatRequest,
  type LlmChatResponse,
  type LlmProvider,
  type LlmProviderAvailability,
  type LlmProviderMode,
  type LlmToolCall,
  type LlmUsage,
} from './types.js';

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

type OpenAICompatibleProviderConfig = {
  id: string;
  name: string;
  apiKey: string;
  baseUrl: string;
  mode?: LlmProviderMode;
  timeoutMs?: number;
  maxRetries?: number;
  defaultHeaders?: Record<string, string>;
  fetch?: FetchLike;
};

type OpenAIChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_call_id?: string;
};

type OpenAIChatTool = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

type OpenAIToolCall = {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

type OpenAIChatChoice = {
  message?: {
    content?: string | null;
    tool_calls?: OpenAIToolCall[];
  };
};

type OpenAIUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

type OpenAIChatResponse = {
  id?: string;
  model?: string;
  choices?: OpenAIChatChoice[];
  usage?: OpenAIUsage;
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
};

export class OpenAICompatibleProvider implements LlmProvider {
  readonly id: string;
  readonly name: string;
  readonly mode: LlmProviderMode;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly defaultHeaders: Record<string, string>;
  private readonly fetchImpl: FetchLike;

  constructor(config: OpenAICompatibleProviderConfig) {
    if (!config.apiKey.trim()) {
      throw new LlmProviderError('LLM_AUTH_FAILED', 'LLM API key is required.', false, 401);
    }
    this.id = config.id;
    this.name = config.name;
    this.mode = config.mode ?? 'byok';
    this.apiKey = config.apiKey;
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.timeoutMs = config.timeoutMs ?? 60_000;
    this.maxRetries = config.maxRetries ?? 2;
    this.defaultHeaders = config.defaultHeaders ?? {};
    this.fetchImpl = config.fetch ?? fetch;
  }

  async chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    const payload = {
      model: request.model,
      messages: request.messages.map<OpenAIChatMessage>((message) => ({
        role: message.role,
        content: message.content,
        ...(message.name ? { name: message.name } : {}),
        ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
      })),
      ...(request.tools?.length
        ? {
            tools: request.tools.map<OpenAIChatTool>((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              },
            })),
          }
        : {}),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
    };

    const response = await this.requestJson('/chat/completions', payload, request.signal);
    return parseChatResponse(response);
  }

  async isAvailable(): Promise<LlmProviderAvailability> {
    try {
      await this.requestJson(
        '/chat/completions',
        {
          model: 'availability-check',
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        },
        undefined,
        { maxRetries: 0 },
      );
      return { available: true };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { available: false, detail };
    }
  }

  private async requestJson(
    path: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
    options?: { maxRetries?: number },
  ): Promise<OpenAIChatResponse> {
    const maxRetries = options?.maxRetries ?? this.maxRetries;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        return await this.requestOnce(path, payload, signal);
      } catch (error) {
        lastError = error;
        if (!isRetryable(error) || attempt === maxRetries) throw error;
        await sleep(100 * 2 ** attempt);
      }
    }

    throw lastError;
  }

  private async requestOnce(
    path: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<OpenAIChatResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
          ...this.defaultHeaders,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const text = await response.text();
      const json = parseJson(text);

      if (!response.ok) {
        throw httpError(response.status, json);
      }
      if (!json || typeof json !== 'object') {
        throw new LlmProviderError('LLM_BAD_RESPONSE', 'LLM provider returned an empty response.', false);
      }
      return json as OpenAIChatResponse;
    } catch (error) {
      if (isAbortError(error)) {
        throw new LlmProviderError('LLM_TIMEOUT', `LLM request timed out after ${this.timeoutMs}ms.`, true);
      }
      if (error instanceof LlmProviderError) throw error;
      throw new LlmProviderError(
        'LLM_NETWORK_ERROR',
        error instanceof Error ? error.message : 'LLM network request failed.',
        true,
      );
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }
}

export function createSiliconFlowProvider(config: {
  apiKey: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetch?: FetchLike;
}): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    id: 'siliconflow',
    name: 'SiliconFlow',
    apiKey: config.apiKey,
    baseUrl: 'https://api.siliconflow.cn/v1',
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    ...(config.maxRetries === undefined ? {} : { maxRetries: config.maxRetries }),
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
  });
}

function parseChatResponse(response: OpenAIChatResponse): LlmChatResponse {
  const choice = response.choices?.[0];
  const message = choice?.message;
  if (!message) {
    throw new LlmProviderError('LLM_BAD_RESPONSE', 'LLM provider response did not include a message.', false);
  }

  const parsed: LlmChatResponse = {
    text: message.content ?? '',
    toolCalls: (message.tool_calls ?? []).map(parseToolCall),
  };
  const usage = parseUsage(response.usage);
  if (usage) parsed.usage = usage;
  if (response.id) parsed.providerResponseId = response.id;
  if (response.model) parsed.model = response.model;
  return parsed;
}

function parseToolCall(call: OpenAIToolCall): LlmToolCall {
  const rawArguments = call.function?.arguments ?? '{}';
  return {
    id: call.id ?? crypto.randomUUID(),
    name: call.function?.name ?? 'unknown_tool',
    arguments: parseToolArguments(rawArguments),
  };
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { raw };
  }
}

function parseUsage(usage?: OpenAIUsage): LlmUsage | undefined {
  if (!usage) return undefined;
  return {
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    totalTokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
  };
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function parseJson(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new LlmProviderError('LLM_BAD_RESPONSE', 'LLM provider returned invalid JSON.', true);
  }
}

function httpError(status: number, body: unknown): LlmProviderError {
  const message = extractErrorMessage(body) ?? `LLM provider returned HTTP ${status}.`;
  if (status === 401 || status === 403) return new LlmProviderError('LLM_AUTH_FAILED', message, false, status);
  if (status === 408 || status === 429) return new LlmProviderError('LLM_RATE_LIMITED', message, true, status);
  if (status >= 500) return new LlmProviderError('LLM_PROVIDER_ERROR', message, true, status);
  return new LlmProviderError('LLM_PROVIDER_ERROR', message, false, status);
}

function extractErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const error = (body as { error?: { message?: unknown } }).error;
  return typeof error?.message === 'string' ? error.message : undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isRetryable(error: unknown): boolean {
  return error instanceof LlmProviderError && error.retryable;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
