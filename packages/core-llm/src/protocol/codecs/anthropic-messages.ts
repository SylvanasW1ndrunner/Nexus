import type { ModelMessage } from '../content.js';
import {
  asRecord,
  assertContextProtocol,
  createDecodedAttempt,
  createProtocolEncodeSession,
  draftToolCall,
  ModelProtocolError,
  normalizedUsage,
  normalizeFinishReason,
  opaqueBlockRef,
  providerOpaqueBlock,
  requiredRecords,
  requiredString,
  stringValue,
  type AttemptDecodeContext,
  type CanonicalModelRequest,
  type ModelEncodeContext,
  type ModelProtocolCodec,
  type ProtocolEncodeSession,
} from '../codec.js';
import { bindModelProtocolCodec } from '../codec-authenticity.js';
import type { DecodedModelContentBlock } from '../content.js';
import type { DecodedModelStreamEvent } from '../model-stream.js';

type AnthropicStreamBlock =
  | { kind: 'text'; ordinal: number; text: string }
  | { kind: 'opaque'; ordinal: number; value: Record<string, unknown> }
  | {
      kind: 'tool';
      ordinal: number;
      wireIdentity?: { callId: string } | undefined;
      name: string;
      argumentsText: string;
      initialInput?: unknown;
      sawArguments: boolean;
    };

export class AnthropicMessagesCodec implements ModelProtocolCodec {
  readonly protocol = 'anthropic-messages' as const;
  readonly revision = 'anthropic-messages@1' as const;

  constructor() {
    bindModelProtocolCodec(this);
  }

  encode(request: CanonicalModelRequest, context: ModelEncodeContext) {
    const session = createProtocolEncodeSession(context, this.protocol, request);
    const system: Array<{ type: 'text'; text: string }> = [];
    for (const message of request.messages) {
      if (message.role !== 'system' && message.role !== 'developer') continue;
      for (const block of message.content) {
        if (block.type === 'reasoning-summary' && !session.shouldProjectReasoningSummary(block)) {
          continue;
        }
        if (block.type === 'text' || block.type === 'reasoning-summary') {
          system.push({ type: 'text', text: block.text });
        } else if (block.type === 'resource-ref') {
          session.rejectResource();
        } else {
          throw new ModelProtocolError(
            'UNREPRESENTABLE_CANONICAL_BLOCK',
            `Anthropic system content cannot represent ${block.type}`,
          );
        }
      }
    }
    return session.finish({
      model: request.model,
      max_tokens: request.maxOutputTokens ?? 4_096,
      ...(system.length === 0 ? {} : { system }),
      messages: request.messages
        .filter((message) => message.role !== 'system' && message.role !== 'developer')
        .map((message) => encodeMessage(message, session)),
      ...(request.tools === undefined
        ? {}
        : {
            tools: request.tools.map((tool) => ({
              name: tool.name,
              ...(tool.description === undefined ? {} : { description: tool.description }),
              input_schema: tool.inputSchema,
            })),
          }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.topP === undefined ? {} : { top_p: request.topP }),
      ...(request.stop === undefined ? {} : { stop_sequences: request.stop }),
    });
  }

  decode(response: unknown, context: AttemptDecodeContext) {
    assertContextProtocol(context, this.protocol);
    const root = asRecord(response, 'Anthropic Messages response');
    const blocks: DecodedModelContentBlock[] = [];
    for (const item of requiredRecords(root.content, 'Anthropic content')) {
      const type = requiredString(item.type, 'Anthropic content block type');
      if (type === 'text') {
        if (typeof item.text !== 'string') invalid('Anthropic text is required');
        blocks.push({ type: 'text', text: item.text });
      } else if (type === 'tool_use') {
        blocks.push(
          draftToolCall(
            context,
            blocks.length,
            requiredString(item.name, 'Anthropic tool name'),
            item.input === undefined ? invalid('Anthropic tool input is required') : item.input,
            { callId: requiredString(item.id, 'Anthropic tool id') },
          ),
        );
      } else {
        blocks.push(providerOpaqueBlock(context, item, opaqueBlockRef(context, blocks.length)));
      }
    }
    const usage = root.usage === undefined ? undefined : asRecord(root.usage, 'Anthropic usage');
    const finishReason = normalizeFinishReason(root.stop_reason);
    return createDecodedAttempt(context, blocks, {
      terminal: finishReason !== undefined,
      ...(finishReason === undefined ? {} : { finishReason }),
      ...(usage === undefined
        ? {}
        : {
            usage: normalizedUsage(
              usage.input_tokens,
              usage.output_tokens,
              undefined,
              usage.cache_read_input_tokens,
            ),
          }),
      ...(stringValue(root.id) === undefined ? {} : { providerResponseId: stringValue(root.id) }),
    });
  }

  async *decodeStream(
    stream: AsyncIterable<unknown>,
    context: AttemptDecodeContext,
  ): AsyncIterable<DecodedModelStreamEvent> {
    assertContextProtocol(context, this.protocol);
    const states = new Map<number, AnthropicStreamBlock>();
    const stopped = new Set<number>();
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let cachedInputTokens: number | undefined;
    let providerResponseId: string | undefined;
    let finishReason: ReturnType<typeof normalizeFinishReason>;
    let terminal = false;
    let messageStarted = false;

    for await (const eventValue of stream) {
      const event = asRecord(eventValue, 'Anthropic stream event');
      const type = requiredString(event.type, 'Anthropic stream event type');
      if (terminal) invalid('Anthropic stream emitted an event after message_stop');
      const indexedEvent =
        type === 'content_block_start' ||
        type === 'content_block_delta' ||
        type === 'content_block_stop';
      const index = indexedEvent ? requiredIndex(event.index, 'Anthropic content block index') : -1;
      if (type === 'message_start') {
        if (messageStarted) invalid('Anthropic stream repeated message_start');
        messageStarted = true;
        const message = asRecord(event.message, 'Anthropic stream message');
        providerResponseId = stringValue(message.id);
        const usage = message.usage === undefined ? undefined : asRecord(message.usage);
        inputTokens = typeof usage?.input_tokens === 'number' ? usage.input_tokens : inputTokens;
        cachedInputTokens =
          typeof usage?.cache_read_input_tokens === 'number'
            ? usage.cache_read_input_tokens
            : cachedInputTokens;
      } else if (type === 'content_block_start') {
        if (!messageStarted) invalid('Anthropic content block started before message_start');
        if (states.has(index)) invalid('Anthropic content block index started more than once');
        const block = asRecord(event.content_block, 'Anthropic content block');
        const blockType = requiredString(block.type, 'Anthropic content block type');
        if (blockType === 'text') {
          if (block.text !== undefined && typeof block.text !== 'string') {
            invalid('Anthropic text block text must be a string');
          }
          states.set(index, {
            kind: 'text',
            ordinal: states.size,
            text: stringValue(block.text) ?? '',
          });
        } else if (blockType === 'tool_use') {
          const wireCallId = requiredString(block.id, 'Anthropic tool id');
          states.set(index, {
            kind: 'tool',
            ordinal: states.size,
            wireIdentity: { callId: wireCallId },
            name: requiredString(block.name, 'Anthropic tool name'),
            argumentsText: '',
            ...(block.input === undefined ? {} : { initialInput: block.input }),
            sawArguments: block.input !== undefined,
          });
        } else {
          states.set(index, { kind: 'opaque', ordinal: states.size, value: block });
        }
      } else if (type === 'content_block_delta') {
        if (!messageStarted) invalid('Anthropic content block delta preceded message_start');
        const delta = asRecord(event.delta, 'Anthropic content block delta');
        const state = states.get(index);
        if (state === undefined) invalid('Anthropic delta references an unknown content block');
        if (stopped.has(index)) invalid('Anthropic delta references a stopped content block');
        if (state?.kind === 'text' && delta.type === 'text_delta') {
          if (typeof delta.text !== 'string') invalid('Anthropic text delta must be a string');
          const text = delta.text;
          state.text += text;
          yield { type: 'text-delta', blockOrdinal: state.ordinal, text };
        } else if (state.kind === 'tool' && delta.type === 'input_json_delta') {
          if (typeof delta.partial_json !== 'string') {
            invalid('Anthropic tool arguments delta must be a string');
          }
          const argumentsDelta = delta.partial_json;
          state.sawArguments = true;
          state.argumentsText += argumentsDelta;
          yield {
            type: 'tool-call-delta',
            blockOrdinal: state.ordinal,
            draftCallKey: `${context.attemptId}:${state.ordinal}`,
            ...(state.wireIdentity === undefined ? {} : { wireIdentity: state.wireIdentity }),
            argumentsDelta,
          };
        } else if (state.kind === 'opaque') {
          if (delta.type === 'thinking_delta') {
            if (typeof delta.thinking !== 'string') invalid('Anthropic thinking delta must be a string');
            state.value.thinking = `${stringValue(state.value.thinking) ?? ''}${delta.thinking}`;
          } else if (delta.type === 'signature_delta') {
            if (typeof delta.signature !== 'string') invalid('Anthropic signature delta must be a string');
            state.value.signature = `${stringValue(state.value.signature) ?? ''}${delta.signature}`;
          } else invalid('Anthropic opaque block received an unsupported delta type');
        } else invalid('Anthropic delta type does not match its content block');
      } else if (type === 'content_block_stop') {
        if (!messageStarted) invalid('Anthropic content block stop preceded message_start');
        const state = states.get(index);
        if (state === undefined || stopped.has(index)) {
          invalid('Anthropic content_block_stop does not match one started block');
        }
        if (state.kind === 'tool' && !state.sawArguments) {
          invalid('Anthropic tool block arguments are required');
        }
        const block = anthropicStreamBlock(state, context);
        stopped.add(index);
        yield { type: 'block-complete', blockOrdinal: state.ordinal, block };
      } else if (type === 'message_delta') {
        if (!messageStarted) invalid('Anthropic message_delta preceded message_start');
        const delta = asRecord(event.delta, 'Anthropic message delta');
        finishReason = normalizeFinishReason(delta.stop_reason) ?? finishReason;
        const usage = event.usage === undefined ? undefined : asRecord(event.usage);
        outputTokens = typeof usage?.output_tokens === 'number' ? usage.output_tokens : outputTokens;
      } else if (type === 'message_stop') {
        if (!messageStarted) invalid('Anthropic message_stop preceded message_start');
        terminal = true;
      } else if (type !== 'ping') {
        invalid(`Unsupported Anthropic stream event: ${String(type)}`);
      }
    }

    if (!terminal || stopped.size !== states.size) {
      throw new ModelProtocolError(
        'INCOMPLETE_MODEL_ATTEMPT',
        'Anthropic stream ended before message_stop or content_block_stop',
      );
    }

    const blocks = [...states.values()]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((state): DecodedModelContentBlock => {
        return anthropicStreamBlock(state, context);
      });
    const usage = normalizedUsage(inputTokens, outputTokens, undefined, cachedInputTokens);
    const attempt = createDecodedAttempt(context, blocks, {
      terminal: true,
      finishReason: finishReason ?? 'unknown',
      ...(usage === undefined ? {} : { usage }),
      ...(providerResponseId === undefined ? {} : { providerResponseId }),
    });
    if (usage !== undefined) yield { type: 'usage', usage };
    yield { type: 'finish', attempt };
  }
}

function encodeMessage(
  message: ModelMessage,
  session: ProtocolEncodeSession,
): Record<string, unknown> {
  const content: Record<string, unknown>[] = [];
  for (const block of message.content) {
    if (block.type === 'reasoning-summary' && !session.shouldProjectReasoningSummary(block)) continue;
    if (block.type === 'text' || block.type === 'reasoning-summary') {
      content.push({ type: 'text', text: block.text });
    } else if (block.type === 'tool-call') {
      const identity = session.identityFor(block.callId);
      content.push({
        type: 'tool_use',
        id: requiredIdentityCallId(identity),
        name: block.name,
        input: block.arguments,
      });
    } else if (block.type === 'tool-result') {
      const identity = session.identityFor(block.callId);
      content.push({
        type: 'tool_result',
        tool_use_id: requiredIdentityCallId(identity),
        content: JSON.stringify(block.output),
        ...(block.isError ? { is_error: true } : {}),
      });
    } else if (block.type === 'provider-opaque') {
      const opaque = session.opaqueValue(block);
      if (opaque !== undefined) content.push(asRecord(opaque, 'Anthropic opaque block'));
    } else {
      session.rejectResource();
    }
  }
  return {
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content,
  };
}

function anthropicStreamBlock(
  state: AnthropicStreamBlock,
  context: AttemptDecodeContext,
): DecodedModelContentBlock {
  if (state.kind === 'text') return { type: 'text', text: state.text };
  if (state.kind === 'opaque') {
    return providerOpaqueBlock(context, state.value, opaqueBlockRef(context, state.ordinal));
  }
  return draftToolCall(
    context,
    state.ordinal,
    state.name,
    state.argumentsText.length > 0 ? state.argumentsText : state.initialInput,
    state.wireIdentity,
  );
}

function requiredIndex(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    invalid(`${label} must be a non-negative integer`);
  }
  return value as number;
}

function requiredIdentityCallId(identity: { callId?: string }): string {
  if (identity.callId === undefined) {
    throw new ModelProtocolError(
      'MISSING_PROTOCOL_CORRELATION',
      'Anthropic Messages requires a wire tool-use ID',
    );
  }
  return identity.callId;
}

function invalid(message: string): never {
  throw new ModelProtocolError('INVALID_WIRE_RESPONSE', message);
}

export const anthropicMessagesCodec = new AnthropicMessagesCodec();
