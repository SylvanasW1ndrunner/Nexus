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
import type { DecodedModelContentBlock } from '../content.js';
import type { DecodedModelStreamEvent } from '../model-stream.js';

type AnthropicStreamBlock =
  | { kind: 'text'; ordinal: number; text: string }
  | { kind: 'opaque'; ordinal: number; value: Record<string, unknown> }
  | {
      kind: 'tool';
      ordinal: number;
      wireIdentity?: { callId?: string } | undefined;
      name: string;
      argumentsText: string;
      initialInput?: unknown;
    };

export class AnthropicMessagesCodec implements ModelProtocolCodec {
  readonly protocol = 'anthropic-messages' as const;

  encode(request: CanonicalModelRequest, context: ModelEncodeContext) {
    const session = createProtocolEncodeSession(context, this.protocol);
    const system: Array<{ type: 'text'; text: string }> = [];
    for (const message of request.messages) {
      if (message.role !== 'system' && message.role !== 'developer') continue;
      for (const block of message.content) {
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
        blocks.push(providerOpaqueBlock(context, item));
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

    for await (const eventValue of stream) {
      const event = asRecord(eventValue, 'Anthropic stream event');
      const type = stringValue(event.type);
      const index = typeof event.index === 'number' ? event.index : states.size;
      if (type === 'message_start') {
        const message = asRecord(event.message, 'Anthropic stream message');
        providerResponseId = stringValue(message.id);
        const usage = message.usage === undefined ? undefined : asRecord(message.usage);
        inputTokens = typeof usage?.input_tokens === 'number' ? usage.input_tokens : inputTokens;
        cachedInputTokens =
          typeof usage?.cache_read_input_tokens === 'number'
            ? usage.cache_read_input_tokens
            : cachedInputTokens;
      } else if (type === 'content_block_start') {
        const block = asRecord(event.content_block, 'Anthropic content block');
        const blockType = requiredString(block.type, 'Anthropic content block type');
        if (blockType === 'text') {
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
          });
        } else {
          states.set(index, { kind: 'opaque', ordinal: states.size, value: block });
        }
      } else if (type === 'content_block_delta') {
        const delta = asRecord(event.delta, 'Anthropic content block delta');
        const state = states.get(index);
        if (state === undefined) invalid('Anthropic delta references an unknown content block');
        if (state?.kind === 'text' && delta.type === 'text_delta') {
          const text = stringValue(delta.text) ?? '';
          state.text += text;
          yield { type: 'text-delta', blockOrdinal: state.ordinal, text };
        } else if (state.kind === 'tool' && delta.type === 'input_json_delta') {
          const argumentsDelta = stringValue(delta.partial_json) ?? '';
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
            state.value.thinking = `${stringValue(state.value.thinking) ?? ''}${stringValue(delta.thinking) ?? ''}`;
          } else if (delta.type === 'signature_delta') {
            state.value.signature = `${stringValue(state.value.signature) ?? ''}${stringValue(delta.signature) ?? ''}`;
          }
        }
      } else if (type === 'content_block_stop') {
        const state = states.get(index);
        if (state === undefined || stopped.has(index)) {
          invalid('Anthropic content_block_stop does not match one started block');
        }
        const block = anthropicStreamBlock(state, context);
        stopped.add(index);
        yield { type: 'block-complete', blockOrdinal: state.ordinal, block };
      } else if (type === 'message_delta') {
        const delta = asRecord(event.delta, 'Anthropic message delta');
        finishReason = normalizeFinishReason(delta.stop_reason) ?? finishReason;
        const usage = event.usage === undefined ? undefined : asRecord(event.usage);
        outputTokens = typeof usage?.output_tokens === 'number' ? usage.output_tokens : outputTokens;
      } else if (type === 'message_stop') {
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
  for (const [ordinal, block] of message.content.entries()) {
    if (block.type === 'text' || block.type === 'reasoning-summary') {
      content.push({ type: 'text', text: block.text });
    } else if (block.type === 'tool-call') {
      const identity = session.identityFor(block.callId, ordinal);
      content.push({
        type: 'tool_use',
        id: requiredIdentityCallId(identity),
        name: block.name,
        input: block.arguments,
      });
    } else if (block.type === 'tool-result') {
      const identity = session.identityFor(block.callId, ordinal);
      content.push({
        type: 'tool_result',
        tool_use_id: requiredIdentityCallId(identity),
        content: JSON.stringify(block.output),
        ...(block.isError ? { is_error: true } : {}),
      });
    } else if (block.type === 'provider-opaque') {
      content.push(asRecord(session.opaqueValue(block), 'Anthropic opaque block'));
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
  if (state.kind === 'opaque') return providerOpaqueBlock(context, state.value);
  return draftToolCall(
    context,
    state.ordinal,
    state.name,
    state.argumentsText.length > 0 ? state.argumentsText : state.initialInput,
    state.wireIdentity,
  );
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
