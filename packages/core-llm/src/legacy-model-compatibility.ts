import {
  ModelClientError,
  type ModelClient,
  type ModelClientRequest,
  type ModelClientResponse,
} from './model-client.js';
import {
  createDecodedAttempt,
  normalizeFinishReason,
  type AttemptDecodeContext,
  type CanonicalModelRequest,
  type ModelEncodeContext,
  type ModelProtocolCodec,
  type ModelProtocolEncodeResult,
} from './protocol/codec.js';
import type { DecodedModelContentBlock, ModelProtocol } from './protocol/content.js';
import type { ModelMessage as CanonicalModelMessage } from './protocol/content.js';
import type { DecodedModelStreamEvent } from './protocol/model-stream.js';
import {
  LlmProviderError,
  type LlmChatRequest,
  type LlmChatResponse,
  type LlmChatStreamEvent,
  type LlmMessage,
  type LlmProvider,
  type LlmTool,
} from './types.js';

/** One-call adapter for callers still registered through the legacy normalized Provider API. */
export class LegacyProviderModelClient implements ModelClient {
  constructor(
    private readonly provider: LlmProvider,
    private readonly streaming: boolean,
  ) {}

  async execute(request: ModelClientRequest): Promise<ModelClientResponse> {
    const legacyRequest = request.wireRequest as LlmChatRequest;
    try {
      if (this.streaming && this.provider.stream !== undefined) {
        return {
          kind: 'stream',
          events: guardedLegacyEvents(this.provider.stream({
            ...legacyRequest,
            signal: request.signal,
          })),
        };
      }
      return {
        kind: 'json',
        response: await this.provider.chat({ ...legacyRequest, signal: request.signal }),
      };
    } catch (error) {
      throw legacyClientError(error, request.signal);
    }
  }
}

/** Codec for the normalized legacy Provider surface; execution still belongs to the canonical Gateway. */
export class LegacyProviderCodec implements ModelProtocolCodec<
  LlmChatRequest,
  LlmChatResponse,
  LlmChatStreamEvent
> {
  constructor(readonly protocol: ModelProtocol) {}

  encode(
    request: CanonicalModelRequest,
    context: ModelEncodeContext,
  ): ModelProtocolEncodeResult<LlmChatRequest> {
    void context;
    return {
      wireRequest: canonicalToLegacyRequest(request),
      correlations: [],
      opaqueBlockRefs: [],
    };
  }

  decode(response: LlmChatResponse, context: AttemptDecodeContext) {
    const blocks: DecodedModelContentBlock[] = [];
    if (response.text) blocks.push({ type: 'text', text: response.text });
    for (const [index, call] of response.toolCalls.entries()) {
      blocks.push({
        type: 'tool-call-draft',
        draftCallKey: `${context.attemptId}:${index}`,
        wireIdentity: { callId: call.id },
        name: call.name,
        arguments: call.arguments as PortableValue,
      });
    }
    return createDecodedAttempt(context, blocks, {
      terminal: true,
      finishReason: normalizeFinishReason(response.finishReason) ?? 'stop',
      ...(response.usage === undefined
        ? {}
        : {
            usage: {
              inputTokens: response.usage.promptTokens,
              outputTokens: response.usage.completionTokens,
              totalTokens: response.usage.totalTokens,
              ...(response.usage.cachedPromptTokens === undefined
                ? {}
                : { cachedInputTokens: response.usage.cachedPromptTokens }),
            },
          }),
      ...(response.providerResponseId === undefined
        ? {}
        : { providerResponseId: response.providerResponseId }),
    });
  }

  async *decodeStream(
    stream: AsyncIterable<LlmChatStreamEvent>,
    context: AttemptDecodeContext,
  ): AsyncIterable<DecodedModelStreamEvent> {
    for await (const event of stream) {
      if (event.type === 'text-delta') {
        yield { type: 'text-delta', blockOrdinal: 0, text: event.text };
      } else if (event.type === 'tool-call-delta') {
        yield {
          type: 'tool-call-delta',
          blockOrdinal: event.index + 1,
          draftCallKey: `${context.attemptId}:${event.index}`,
          ...(event.id === undefined ? {} : { wireIdentity: { callId: event.id } }),
          ...(event.name === undefined ? {} : { name: event.name }),
          ...(event.argumentsDelta === undefined
            ? {}
            : { argumentsDelta: event.argumentsDelta }),
        };
      } else if (event.type === 'tool-call') {
        yield {
          type: 'block-complete',
          blockOrdinal: 1,
          block: {
            type: 'tool-call-draft',
            draftCallKey: `${context.attemptId}:0`,
            wireIdentity: { callId: event.toolCall.id },
            name: event.toolCall.name,
            arguments: event.toolCall.arguments as PortableValue,
          },
        };
      } else if (event.type === 'usage') {
        yield {
          type: 'usage',
          usage: {
            inputTokens: event.usage.promptTokens,
            outputTokens: event.usage.completionTokens,
            totalTokens: event.usage.totalTokens,
            ...(event.usage.cachedPromptTokens === undefined
              ? {}
              : { cachedInputTokens: event.usage.cachedPromptTokens }),
          },
        };
      } else {
        yield { type: 'finish', attempt: this.decode(event.response, context) };
      }
    }
  }
}

export function canonicalLegacyProtocol(protocol: string | undefined): ModelProtocol {
  if (protocol === 'openai-responses') return 'openai-responses';
  if (protocol === 'anthropic' || protocol === 'anthropic-messages') return 'anthropic-messages';
  if (protocol === 'ollama' || protocol === 'ollama-chat') return 'ollama-chat';
  return 'openai-chat';
}

export function legacyRequestToCanonical(
  request: Omit<LlmChatRequest, 'model'> & { model?: string },
  model: string,
): CanonicalModelRequest {
  return {
    model,
    messages: request.messages.flatMap((message) => legacyMessageToCanonical(message)),
    ...(request.tools === undefined
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema as PortableValue,
          })),
        }),
  };
}

export function legacyAttemptToResponse(
  blocks: readonly DecodedModelContentBlock[],
  usage: { inputTokens: number; outputTokens: number; totalTokens: number; cachedInputTokens?: number } | undefined,
  providerResponseId?: string,
): LlmChatResponse {
  return {
    text: blocks
      .filter((block): block is Extract<DecodedModelContentBlock, { type: 'text' }> =>
        block.type === 'text')
      .map((block) => block.text)
      .join(''),
    toolCalls: blocks
      .filter((block): block is Extract<DecodedModelContentBlock, { type: 'tool-call-draft' }> =>
        block.type === 'tool-call-draft')
      .map((block) => ({
        id: block.wireIdentity?.callId ?? block.draftCallKey,
        name: block.name,
        arguments: block.arguments as Record<string, unknown>,
      })),
    ...(usage === undefined
      ? {}
      : {
          usage: {
            promptTokens: usage.inputTokens,
            completionTokens: usage.outputTokens,
            totalTokens: usage.totalTokens,
            ...(usage.cachedInputTokens === undefined
              ? {}
              : { cachedPromptTokens: usage.cachedInputTokens }),
          },
        }),
    ...(providerResponseId === undefined ? {} : { providerResponseId }),
  };
}

function canonicalToLegacyRequest(request: CanonicalModelRequest): LlmChatRequest {
  const messages: LlmMessage[] = [];
  for (const message of request.messages) {
    const text = message.content
      .filter((block) => block.type === 'text' || block.type === 'reasoning-summary')
      .map((block) => block.text)
      .join('');
    const toolCalls = message.content
      .filter((block) => block.type === 'tool-call')
      .map((block) => ({ id: block.callId, name: block.name, arguments: block.arguments as Record<string, unknown> }));
    const toolResults = message.content.filter((block) => block.type === 'tool-result');
    if (toolResults.length > 0) {
      for (const result of toolResults) {
        messages.push({
          role: 'tool',
          content: JSON.stringify(result.output),
          toolCallId: result.callId,
          toolResult: { isError: result.isError },
        });
      }
      continue;
    }
    messages.push({
      role: message.role === 'developer' ? 'system' : message.role,
      content: text,
      ...(toolCalls.length === 0 ? {} : { toolCalls }),
    });
  }
  return {
    model: request.model,
    messages,
    ...(request.tools === undefined
      ? {}
      : { tools: request.tools.map(canonicalToolToLegacy) }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.topP === undefined ? {} : { topP: request.topP }),
    ...(request.maxOutputTokens === undefined ? {} : { maxTokens: request.maxOutputTokens }),
    ...(request.stop === undefined ? {} : { stop: [...request.stop] }),
  };
}

function legacyMessageToCanonical(message: LlmMessage): CanonicalModelMessage[] {
  if (message.role === 'tool') {
    if (message.toolCallId === undefined) {
      return [{ role: 'tool', content: [{
        type: 'text',
        text: message.content,
      }] }];
    }
    let output: PortableValue = message.content;
    try {
      output = JSON.parse(message.content) as PortableValue;
    } catch {
      // Plain text tool output remains portable.
    }
    return [{
      role: 'tool',
      content: [{
        type: 'tool-result',
        callId: message.toolCallId,
        output,
        isError: message.toolResult?.isError ?? false,
      }],
    }];
  }
  const content: CanonicalModelMessage['content'] = [];
  if (message.content) content.push({ type: 'text', text: message.content });
  for (const call of message.toolCalls ?? []) {
    content.push({
      type: 'tool-call',
      callId: call.id,
      name: call.name,
      arguments: call.arguments as PortableValue,
    });
  }
  return [{ role: message.role, content }];
}

function canonicalToolToLegacy(tool: NonNullable<CanonicalModelRequest['tools']>[number]): LlmTool {
  return {
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema as Record<string, unknown>,
  };
}

async function* guardedLegacyEvents(
  events: AsyncIterable<LlmChatStreamEvent>,
): AsyncIterable<LlmChatStreamEvent> {
  let started = false;
  try {
    for await (const event of events) {
      started = true;
      yield event;
    }
  } catch (error) {
    const classified = legacyClientError(error);
    throw new ModelClientError('STREAM_DISCONNECTED', classified.message, {
      retryable: started ? false : classified.retryable,
      responseStarted: started,
      cause: classified,
      ...(classified.statusCode === undefined ? {} : { statusCode: classified.statusCode }),
      ...(classified.retryAfterMs === undefined ? {} : { retryAfterMs: classified.retryAfterMs }),
    });
  }
}

function legacyClientError(error: unknown, signal?: AbortSignal): ModelClientError {
  if (signal?.aborted) return new ModelClientError('TRANSPORT_ERROR', 'Model request cancelled.');
  if (error instanceof ModelClientError) return error;
  if (error instanceof LlmProviderError) {
    return new ModelClientError(
      error.statusCode === undefined && error.retryable ? 'CONNECT_FAILED' :
        error.statusCode === undefined ? 'TRANSPORT_ERROR' : 'HTTP_ERROR',
      error.message,
      {
        retryable: error.retryable,
        cause: error,
        ...(error.statusCode === undefined ? {} : { statusCode: error.statusCode }),
        ...(typeof error.detail?.retryAfterMs === 'number'
          ? { retryAfterMs: error.detail.retryAfterMs }
          : {}),
      },
    );
  }
  return new ModelClientError(
    'TRANSPORT_ERROR',
    error instanceof Error ? error.message : String(error),
    { cause: error },
  );
}
import type { PortableValue } from '@dbagent/shared';
