import {
  LlmProviderError,
  type LlmChatRequest,
  type LlmChatResponse,
  type LlmChatStreamEvent,
  type LlmProvider,
  type LlmProviderAvailability,
  type LlmProviderMode,
  type LlmToolCall,
  type LlmUsage,
} from './types.js';

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

type StreamResponse = {
  body: ReadableStream<Uint8Array>;
  cleanup: () => void;
};

type OpenAICompatibleProviderConfig = {
  id: string;
  name: string;
  apiKey: string;
  baseUrl: string;
  mode?: LlmProviderMode;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayBaseMs?: number;
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
  delta?: {
    content?: string | null;
    tool_calls?: OpenAIStreamToolCallDelta[];
  };
  finish_reason?: string | null;
};

type OpenAIStreamToolCallDelta = {
  index?: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
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
  private readonly retryDelayBaseMs: number;
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
    this.retryDelayBaseMs = config.retryDelayBaseMs ?? 100;
    this.defaultHeaders = config.defaultHeaders ?? {};
    this.fetchImpl = config.fetch ?? fetch;
  }

  async chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    const payload = buildChatPayload(request);

    const response = await this.requestJson('/chat/completions', payload, request.signal);
    return parseChatResponse(response);
  }

  async *stream(request: LlmChatRequest): AsyncIterable<LlmChatStreamEvent> {
    const payload = { ...buildChatPayload(request), stream: true, stream_options: { include_usage: true } };
    const stream = await this.requestStream('/chat/completions', payload, request.signal);
    const state = createStreamState();

    try {
      for await (const event of readSseEvents(stream.body)) {
        if (event === '[DONE]') {
          const response = streamStateToResponse(state);
          yield finishEvent(response, state.finishReason);
          return;
        }

        const chunk = parseJson(event) as OpenAIChatResponse;
        if (!chunk || typeof chunk !== 'object') {
          throw new LlmProviderError('LLM_BAD_RESPONSE', 'LLM stream returned an invalid event.', true);
        }

        if (chunk.id) state.providerResponseId = chunk.id;
        if (chunk.model) state.model = chunk.model;
        const usage = parseUsage(chunk.usage);
        if (usage) {
          state.usage = usage;
          yield { type: 'usage', usage };
        }

        for (const choice of chunk.choices ?? []) {
          if (choice.finish_reason) state.finishReason = choice.finish_reason;
          const text = choice.delta?.content ?? '';
          if (text) {
            state.text += text;
            yield { type: 'text-delta', text };
          }

          for (const delta of choice.delta?.tool_calls ?? []) {
            const index = delta.index ?? 0;
            const current = state.toolCalls.get(index) ?? { arguments: '' };
            if (delta.id) current.id = delta.id;
            if (delta.function?.name) current.name = delta.function.name;
            if (delta.function?.arguments) current.arguments += delta.function.arguments;
            state.toolCalls.set(index, current);
            yield {
              type: 'tool-call-delta',
              index,
              ...(delta.id === undefined ? {} : { id: delta.id }),
              ...(delta.function?.name === undefined ? {} : { name: delta.function.name }),
              ...(delta.function?.arguments === undefined ? {} : { argumentsDelta: delta.function.arguments }),
            };
          }
        }
      }
    } finally {
      stream.cleanup();
    }

    const response = streamStateToResponse(state);
    yield finishEvent(response, state.finishReason);
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
        await sleep(this.retryDelayBaseMs * 2 ** attempt, signal);
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
        if (!timedOut && signal?.aborted) {
          throw new LlmProviderError('LLM_ABORTED', 'LLM request was aborted by the user.', false);
        }
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

  private async requestStream(
    path: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<StreamResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.requestStreamOnce(path, payload, signal);
      } catch (error) {
        lastError = error;
        if (!isRetryable(error) || attempt === this.maxRetries) throw error;
        await sleep(this.retryDelayBaseMs * 2 ** attempt, signal);
      }
    }
    throw lastError;
  }

  private async requestStreamOnce(
    path: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<StreamResponse> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    };

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

      if (!response.ok) {
        const text = await response.text();
        throw httpError(response.status, parseJson(text));
      }
      if (!response.body) {
        throw new LlmProviderError('LLM_BAD_RESPONSE', 'LLM provider returned an empty stream.', true);
      }
      return { body: response.body, cleanup };
    } catch (error) {
      cleanup();
      if (isAbortError(error)) {
        if (!timedOut && signal?.aborted) {
          throw new LlmProviderError('LLM_ABORTED', 'LLM stream request was aborted by the user.', false);
        }
        throw new LlmProviderError('LLM_TIMEOUT', `LLM request timed out after ${this.timeoutMs}ms.`, true);
      }
      if (error instanceof LlmProviderError) throw error;
      throw new LlmProviderError(
        'LLM_NETWORK_ERROR',
        error instanceof Error ? error.message : 'LLM stream request failed.',
        true,
      );
    }
  }
}

export function createSiliconFlowProvider(config: {
  apiKey: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayBaseMs?: number;
  fetch?: FetchLike;
}): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    id: 'siliconflow',
    name: 'SiliconFlow',
    apiKey: config.apiKey,
    baseUrl: 'https://api.siliconflow.cn/v1',
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    ...(config.maxRetries === undefined ? {} : { maxRetries: config.maxRetries }),
    ...(config.retryDelayBaseMs === undefined ? {} : { retryDelayBaseMs: config.retryDelayBaseMs }),
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

function buildChatPayload(request: LlmChatRequest): Record<string, unknown> {
  return {
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
}

type StreamToolCallState = {
  id?: string;
  name?: string;
  arguments: string;
};

type StreamState = {
  text: string;
  toolCalls: Map<number, StreamToolCallState>;
  usage?: LlmUsage;
  providerResponseId?: string;
  model?: string;
  finishReason?: string;
};

function createStreamState(): StreamState {
  return {
    text: '',
    toolCalls: new Map(),
  };
}

function streamStateToResponse(state: StreamState): LlmChatResponse {
  const response: LlmChatResponse = {
    text: state.text,
    toolCalls: [...state.toolCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => ({
        id: call.id ?? crypto.randomUUID(),
        name: call.name ?? 'unknown_tool',
        arguments: parseToolArguments(call.arguments || '{}'),
      })),
  };
  if (state.usage) response.usage = state.usage;
  if (state.providerResponseId) response.providerResponseId = state.providerResponseId;
  if (state.model) response.model = state.model;
  return response;
}

function finishEvent(response: LlmChatResponse, reason?: string): LlmChatStreamEvent {
  return {
    type: 'finish',
    response,
    ...(reason === undefined ? {} : { reason }),
  };
}

async function* readSseEvents(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      yield* drainSseBuffer(buffer, (next) => {
        buffer = next;
      });
    }
    buffer += decoder.decode();
    yield* drainSseBuffer(`${buffer}\n\n`, (next) => {
      buffer = next;
    });
  } finally {
    reader.releaseLock();
  }
}

function* drainSseBuffer(buffer: string, setBuffer: (next: string) => void): Iterable<string> {
  let rest = buffer;
  while (true) {
    const normalized = rest.replace(/\r\n/g, '\n');
    const boundary = normalized.indexOf('\n\n');
    if (boundary < 0) {
      setBuffer(rest);
      return;
    }
    const rawEvent = normalized.slice(0, boundary);
    rest = normalized.slice(boundary + 2);
    const dataLines = rawEvent
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart());
    if (dataLines.length > 0) yield dataLines.join('\n');
  }
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

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new LlmProviderError('LLM_ABORTED', 'LLM retry wait was aborted by the user.', false);
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(new LlmProviderError('LLM_ABORTED', 'LLM retry wait was aborted by the user.', false));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
