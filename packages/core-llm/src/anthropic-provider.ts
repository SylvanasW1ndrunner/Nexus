import {
  LlmProviderError,
  type LlmChatRequest,
  type LlmChatResponse,
  type LlmChatStreamEvent,
  type LlmModelMetadata,
  type LlmProvider,
  type LlmProviderAvailability,
  type LlmProviderCapabilities,
  type LlmProviderMode,
  type LlmProviderProtocolProfile,
  type LlmProviderProtocolProfileInput,
  type LlmToolCall,
  type LlmUsage,
} from './types.js';
import { resolveLlmProviderProtocolProfile } from './provider-protocol-profile.js';
import { redactKnownSecrets, sanitizeKnownSecretError } from './known-secret-sanitizer.js';
import {
  addStreamBytes,
  assertToolCallCapacity,
  readLimitedResponseText,
  readLimitedSseData,
  resolveLlmMaxResponseBytes,
  resolveLlmStreamLimits,
  type LlmStreamLimitOptions,
  type LlmStreamLimits,
} from './stream-safety.js';

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type AnthropicProviderConfig = {
  id?: string;
  name?: string;
  apiKey: string;
  baseUrl?: string;
  apiVersion?: string;
  mode?: LlmProviderMode;
  protocolProfile?: LlmProviderProtocolProfileInput;
  timeoutMs?: number;
  maxResponseBytes?: number;
  streamLimits?: LlmStreamLimitOptions;
  fetch?: FetchLike;
};

type AnthropicContent =
  | { type: 'text'; text?: string }
  | { type: 'tool_use'; id?: string; name?: string; input?: unknown };

type AnthropicMessageResponse = {
  id?: string;
  model?: string;
  content?: AnthropicContent[];
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
};

type AnthropicModelsResponse = {
  data?: Array<{ id?: string }>;
};

export class AnthropicProvider implements LlmProvider {
  readonly id: string;
  readonly name: string;
  readonly mode: LlmProviderMode;
  readonly protocol = 'anthropic-messages';
  readonly protocolProfile: LlmProviderProtocolProfile;
  readonly capabilities: Partial<LlmProviderCapabilities> = {
    chat: 'supported',
    streaming: 'supported',
    toolCalling: 'supported',
    structuredOutput: 'unsupported',
    reasoning: 'unknown',
    embeddings: 'unsupported',
    rerank: 'unsupported',
  };

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly streamLimits: LlmStreamLimits;
  private readonly fetchImpl: FetchLike;

  constructor(config: AnthropicProviderConfig) {
    if (!config.apiKey.trim())
      throw new LlmProviderError('LLM_AUTH_FAILED', 'Anthropic API key is required.', false, 401);
    this.id = config.id ?? 'anthropic';
    this.name = config.name ?? 'Anthropic';
    this.mode = config.mode ?? 'byok';
    this.protocolProfile = resolveLlmProviderProtocolProfile(
      config.protocolProfile ?? {
        protocol: this.protocol,
        source: config.baseUrl === undefined ? 'builtin' : 'provider-declaration',
      },
    );
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? 'https://api.anthropic.com/v1').replace(/\/+$/, '');
    this.apiVersion = config.apiVersion ?? '2023-06-01';
    this.timeoutMs = config.timeoutMs ?? 60_000;
    this.maxResponseBytes = resolveLlmMaxResponseBytes(config.maxResponseBytes);
    this.streamLimits = resolveLlmStreamLimits(config.streamLimits);
    this.fetchImpl = config.fetch ?? fetch;
  }

  async chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    const response = await this.request(buildAnthropicPayload(request, false), request.signal);
    return parseAnthropicResponse(response);
  }

  async *stream(request: LlmChatRequest): AsyncIterable<LlmChatStreamEvent> {
    const { response, cleanup } = await this.requestStream(
      buildAnthropicPayload(request, true),
      request.signal,
    );
    let text = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let responseId: string | undefined;
    let responseModel: string | undefined;
    let finishReason: string | undefined;
    let textBytes = 0;
    let toolArgumentsBytes = 0;
    const toolStates = new Map<number, { id?: string; name?: string; arguments: string }>();
    try {
      for await (const raw of readLimitedSseData(
        response.body as ReadableStream<Uint8Array>,
        this.streamLimits.maxSseFrameBytes,
      )) {
        const event = parseJson(raw) as Record<string, unknown>;
        const type = typeof event.type === 'string' ? event.type : '';
        if (type === 'message_start') {
          const message = event.message as AnthropicMessageResponse | undefined;
          responseId = message?.id;
          responseModel = message?.model;
          inputTokens = message?.usage?.input_tokens ?? inputTokens;
        } else if (type === 'content_block_start') {
          const index = numberValue(event.index);
          const block = event.content_block as AnthropicContent | undefined;
          if (block?.type === 'tool_use') {
            if (!toolStates.has(index)) {
              assertToolCallCapacity(toolStates.size, this.streamLimits.maxToolCalls);
            }
            const initialArguments =
              block.input && typeof block.input === 'object' && Object.keys(block.input).length > 0
                ? JSON.stringify(block.input)
                : '';
            toolArgumentsBytes = addStreamBytes(
              toolArgumentsBytes,
              initialArguments,
              this.streamLimits.maxToolArgumentsBytes,
              'tool arguments',
            );
            toolStates.set(index, {
              ...(block.id === undefined ? {} : { id: block.id }),
              ...(block.name === undefined ? {} : { name: block.name }),
              arguments: initialArguments,
            });
          }
        } else if (type === 'content_block_delta') {
          const index = numberValue(event.index);
          const delta = event.delta as
            | { type?: string; text?: string; partial_json?: string }
            | undefined;
          if (delta?.type === 'text_delta' && delta.text) {
            textBytes = addStreamBytes(
              textBytes,
              delta.text,
              this.streamLimits.maxTextBytes,
              'text',
            );
            text += delta.text;
            yield { type: 'text-delta', text: delta.text };
          }
          if (delta?.type === 'input_json_delta' && delta.partial_json) {
            if (!toolStates.has(index)) {
              assertToolCallCapacity(toolStates.size, this.streamLimits.maxToolCalls);
            }
            toolArgumentsBytes = addStreamBytes(
              toolArgumentsBytes,
              delta.partial_json,
              this.streamLimits.maxToolArgumentsBytes,
              'tool arguments',
            );
            const state = toolStates.get(index) ?? { arguments: '' };
            state.arguments += delta.partial_json;
            toolStates.set(index, state);
            yield { type: 'tool-call-delta', index, argumentsDelta: delta.partial_json };
          }
        } else if (type === 'content_block_stop') {
          const index = numberValue(event.index);
          const state = toolStates.get(index);
          if (state) yield { type: 'tool-call', toolCall: toolStateToCall(state) };
        } else if (type === 'message_delta') {
          const delta = event.delta as { stop_reason?: string } | undefined;
          const usage = event.usage as { output_tokens?: number } | undefined;
          outputTokens = usage?.output_tokens ?? outputTokens;
          finishReason = delta?.stop_reason ?? finishReason;
        } else if (type === 'error') {
          const error = event.error as { message?: string } | undefined;
          throw new LlmProviderError(
            'LLM_PROVIDER_ERROR',
            redactKnownSecrets(error?.message ?? 'Anthropic stream returned an error.', [
              this.apiKey,
            ]),
            true,
          );
        }
      }
    } catch (error) {
      if (error instanceof LlmProviderError) throw sanitizeKnownSecretError(error, [this.apiKey]);
      throw new LlmProviderError(
        'LLM_NETWORK_ERROR',
        redactKnownSecrets(error instanceof Error ? error.message : 'Anthropic stream failed.', [
          this.apiKey,
        ]),
        true,
      );
    } finally {
      cleanup();
    }
    const usage = usageFromCounts(inputTokens, outputTokens);
    yield { type: 'usage', usage };
    const final: LlmChatResponse = {
      text,
      toolCalls: [...toolStates.values()].map(toolStateToCall),
      usage,
      ...(responseId === undefined ? {} : { providerResponseId: responseId }),
      ...(responseModel === undefined ? {} : { model: responseModel }),
      ...(finishReason === undefined ? {} : { finishReason }),
    };
    yield {
      type: 'finish',
      response: final,
      ...(finishReason === undefined ? {} : { reason: finishReason }),
    };
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const response = await this.requestModels(signal);
    return (response.data ?? [])
      .map((item) => item.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
  }

  getModelMetadata(model: string): Promise<LlmModelMetadata> {
    return Promise.resolve({
      model,
      source: 'provider-declaration',
      capabilities: { ...this.capabilities },
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
          : { detail: `Model is not advertised by Anthropic: ${model}` }),
      };
    } catch (error) {
      return {
        available: false,
        latencyMs: performance.now() - startedAt,
        detail: redactKnownSecrets(error instanceof Error ? error.message : String(error), [
          this.apiKey,
        ]),
      };
    }
  }

  private async request(
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<AnthropicMessageResponse> {
    const { response, cleanup } = await this.fetchResponse(payload, signal);
    try {
      const body = parseJson(
        await readLimitedResponseText(response, this.maxResponseBytes),
      ) as AnthropicMessageResponse;
      if (!response.ok) throw anthropicHttpError(response.status, body, this.apiKey);
      if (!body || typeof body !== 'object')
        throw new LlmProviderError(
          'LLM_BAD_RESPONSE',
          'Anthropic returned an empty response.',
          false,
        );
      return body;
    } finally {
      cleanup();
    }
  }

  private async requestModels(signal?: AbortSignal): Promise<AnthropicModelsResponse> {
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
      const response = await this.fetchImpl(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': this.apiVersion,
        },
        signal: controller.signal,
      });
      const body = parseJson(
        await readLimitedResponseText(response, this.maxResponseBytes),
      ) as AnthropicModelsResponse;
      if (!response.ok) throw anthropicHttpError(response.status, body, this.apiKey);
      if (!body || typeof body !== 'object') {
        throw new LlmProviderError(
          'LLM_BAD_RESPONSE',
          'Anthropic returned an empty model catalog.',
          false,
        );
      }
      return body;
    } catch (error) {
      if (isAbortError(error)) {
        if (!timedOut && signal?.aborted) {
          throw new LlmProviderError(
            'LLM_ABORTED',
            'Anthropic model discovery was aborted by the user.',
            false,
          );
        }
        throw new LlmProviderError(
          'LLM_TIMEOUT',
          `Anthropic model discovery timed out after ${this.timeoutMs}ms.`,
          true,
        );
      }
      if (error instanceof LlmProviderError) throw sanitizeKnownSecretError(error, [this.apiKey]);
      throw new LlmProviderError(
        'LLM_NETWORK_ERROR',
        redactKnownSecrets(
          error instanceof Error ? error.message : 'Anthropic model discovery failed.',
          [this.apiKey],
        ),
        true,
      );
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }

  private async requestStream(
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ response: Response; cleanup: () => void }> {
    const result = await this.fetchResponse(payload, signal);
    if (!result.response.ok) {
      try {
        throw anthropicHttpError(
          result.response.status,
          parseJson(await readLimitedResponseText(result.response, this.maxResponseBytes)),
          this.apiKey,
        );
      } finally {
        result.cleanup();
      }
    }
    if (!result.response.body) {
      result.cleanup();
      throw new LlmProviderError('LLM_BAD_RESPONSE', 'Anthropic returned an empty stream.', true);
    }
    return result;
  }

  private async fetchResponse(
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ response: Response; cleanup: () => void }> {
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
      const response = await this.fetchImpl(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': this.apiVersion,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      return { response, cleanup };
    } catch (error) {
      cleanup();
      if (isAbortError(error)) {
        if (!timedOut && signal?.aborted)
          throw new LlmProviderError('LLM_ABORTED', 'LLM request was aborted by the user.', false);
        throw new LlmProviderError(
          'LLM_TIMEOUT',
          `LLM request timed out after ${this.timeoutMs}ms.`,
          true,
        );
      }
      if (error instanceof LlmProviderError) throw sanitizeKnownSecretError(error, [this.apiKey]);
      throw new LlmProviderError(
        'LLM_NETWORK_ERROR',
        redactKnownSecrets(
          error instanceof Error ? error.message : 'Anthropic network request failed.',
          [this.apiKey],
        ),
        true,
      );
    }
  }
}

function buildAnthropicPayload(request: LlmChatRequest, stream: boolean): Record<string, unknown> {
  const system = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const messages = request.messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content:
        message.role === 'tool'
          ? `Tool result (${message.name ?? message.toolCallId ?? 'tool'}): ${message.content}`
          : message.content,
    }));
  return {
    model: request.model,
    max_tokens: request.maxTokens ?? 4_096,
    messages,
    stream,
    ...(system ? { system } : {}),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.stop === undefined ? {} : { stop_sequences: request.stop }),
    ...(request.tools?.length
      ? {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
          })),
        }
      : {}),
  };
}

function parseAnthropicResponse(response: AnthropicMessageResponse): LlmChatResponse {
  const content = response.content ?? [];
  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;
  return {
    text: content
      .filter((item) => item.type === 'text')
      .map((item) => item.text ?? '')
      .join(''),
    toolCalls: content
      .filter((item) => item.type === 'tool_use')
      .map((item) => ({
        id: item.id ?? crypto.randomUUID(),
        name: item.name ?? 'unknown_tool',
        arguments: asRecord(item.input),
      })),
    usage: usageFromCounts(inputTokens, outputTokens),
    ...(response.id === undefined ? {} : { providerResponseId: response.id }),
    ...(response.model === undefined ? {} : { model: response.model }),
    ...(response.stop_reason === undefined || response.stop_reason === null
      ? {}
      : { finishReason: response.stop_reason }),
  };
}

function toolStateToCall(state: { id?: string; name?: string; arguments: string }): LlmToolCall {
  return {
    id: state.id ?? crypto.randomUUID(),
    name: state.name ?? 'unknown_tool',
    arguments: asRecord(state.arguments ? parseJson(state.arguments) : {}),
  };
}

function usageFromCounts(inputTokens: number, outputTokens: number): LlmUsage {
  return {
    promptTokens: inputTokens,
    completionTokens: outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new LlmProviderError('LLM_BAD_RESPONSE', 'Anthropic returned invalid JSON.', true);
  }
}

function anthropicHttpError(status: number, body: unknown, secret: string): LlmProviderError {
  const rawMessage =
    body && typeof body === 'object' && 'error' in body
      ? ((body as { error?: { message?: string } }).error?.message ??
        `Anthropic returned HTTP ${status}.`)
      : `Anthropic returned HTTP ${status}.`;
  const message = redactKnownSecrets(rawMessage, [secret]);
  if (status === 401 || status === 403)
    return new LlmProviderError('LLM_AUTH_FAILED', message, false, status);
  if (status === 408 || status === 429)
    return new LlmProviderError('LLM_RATE_LIMITED', message, true, status);
  return new LlmProviderError('LLM_PROVIDER_ERROR', message, status >= 500, status);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : 0;
}
