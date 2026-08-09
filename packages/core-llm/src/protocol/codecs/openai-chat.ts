import type { ModelMessage } from '../content.js';
import {
  asRecord,
  assertContextProtocol,
  createProtocolEncodeSession,
  createDecodedAttempt,
  draftToolCall,
  ModelProtocolError,
  normalizedUsage,
  normalizeFinishReason,
  opaqueBlockRef,
  providerOpaqueBlock,
  records,
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

type StreamBlockState =
  | { kind: 'text'; ordinal: number; text: string }
  | {
      kind: 'tool';
      ordinal: number;
      index: number;
      wireIdentity?: { callId: string } | undefined;
      name: string;
      argumentsText: string;
      sawArguments: boolean;
    };

export class OpenAIChatCodec implements ModelProtocolCodec {
  readonly protocol = 'openai-chat' as const;
  readonly revision = 'openai-chat@1' as const;

  constructor() {
    bindModelProtocolCodec(this);
  }

  encode(request: CanonicalModelRequest, context: ModelEncodeContext) {
    const session = createProtocolEncodeSession(context, this.protocol, request);
    return session.finish({
      model: request.model,
      messages: request.messages.flatMap((message) => encodeMessage(message, session)),
      ...(request.tools === undefined
        ? {}
        : {
            tools: request.tools.map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                ...(tool.description === undefined ? {} : { description: tool.description }),
                parameters: tool.inputSchema,
              },
            })),
          }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.topP === undefined ? {} : { top_p: request.topP }),
      ...(request.maxOutputTokens === undefined
        ? {}
        : { max_completion_tokens: request.maxOutputTokens }),
      ...(request.stop === undefined ? {} : { stop: request.stop }),
    });
  }

  decode(response: unknown, context: AttemptDecodeContext) {
    assertContextProtocol(context, this.protocol);
    const root = asRecord(response, 'OpenAI Chat response');
    const choice = requiredRecords(root.choices, 'OpenAI Chat choices')[0];
    if (choice === undefined) {
      throw new ModelProtocolError('INVALID_WIRE_RESPONSE', 'OpenAI Chat response has no choice');
    }
    const message = asRecord(choice.message, 'OpenAI Chat message');
    const blocks: DecodedModelContentBlock[] = [];
    appendOpenAIContent(blocks, message.content, context);
    for (const callValue of records(message.tool_calls, 'OpenAI Chat tool_calls')) {
      if (callValue.type !== 'function') invalid('OpenAI Chat tool call type must be function');
      const fn = asRecord(callValue.function, 'OpenAI function call');
      if (typeof fn.arguments !== 'string') {
        invalid('OpenAI Chat function arguments must be a string');
      }
      const ordinal = blocks.length;
      const wireCallId = stringValue(callValue.id);
      blocks.push(
        draftToolCall(
          context,
          ordinal,
          requiredString(fn.name, 'OpenAI function name'),
          fn.arguments,
          wireCallId === undefined ? undefined : { callId: wireCallId },
        ),
      );
    }
    const usage = root.usage === undefined ? undefined : asRecord(root.usage, 'OpenAI usage');
    const details =
      usage?.prompt_tokens_details === undefined
        ? undefined
        : asRecord(usage.prompt_tokens_details, 'OpenAI prompt token details');
    const finishReason = normalizeFinishReason(choice.finish_reason);
    return createDecodedAttempt(context, blocks, {
      terminal: finishReason !== undefined,
      ...(finishReason === undefined ? {} : { finishReason }),
      ...(usage === undefined
        ? {}
        : {
            usage: normalizedUsage(
              usage.prompt_tokens,
              usage.completion_tokens,
              usage.total_tokens,
              details?.cached_tokens,
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
    const states: StreamBlockState[] = [];
    const toolStates = new Map<number, Extract<StreamBlockState, { kind: 'tool' }>>();
    let textState: Extract<StreamBlockState, { kind: 'text' }> | undefined;
    let finishReason: ReturnType<typeof normalizeFinishReason>;
    let usage: ReturnType<typeof normalizedUsage>;
    let providerResponseId: string | undefined;
    let finished = false;

    for await (const eventValue of stream) {
      const event = asRecord(eventValue, 'OpenAI Chat stream event');
      providerResponseId ??= stringValue(event.id);
      const rawUsage =
        event.usage === undefined ? undefined : asRecord(event.usage, 'OpenAI stream usage');
      if (rawUsage !== undefined) {
        const details =
          rawUsage.prompt_tokens_details === undefined
            ? undefined
            : asRecord(rawUsage.prompt_tokens_details);
        usage = normalizedUsage(
          rawUsage.prompt_tokens,
          rawUsage.completion_tokens,
          rawUsage.total_tokens,
          details?.cached_tokens,
        );
        if (usage !== undefined) yield { type: 'usage', usage };
      }
      const choices = records(event.choices, 'OpenAI stream choices');
      if (finished) {
        if (rawUsage === undefined || choices.length > 0) {
          invalid('OpenAI Chat stream only permits usage-only chunks after finish');
        }
        continue;
      }
      for (const choice of choices) {
        const delta = choice.delta === undefined ? {} : asRecord(choice.delta, 'OpenAI delta');
        if (
          delta.content !== undefined &&
          delta.content !== null &&
          typeof delta.content !== 'string'
        ) {
          invalid('OpenAI Chat delta content must be a string or null');
        }
        const text = stringValue(delta.content);
        if (text !== undefined && text.length > 0) {
          if (textState === undefined) {
            textState = { kind: 'text', ordinal: states.length, text: '' };
            states.push(textState);
          }
          textState.text += text;
          yield { type: 'text-delta', blockOrdinal: textState.ordinal, text };
        }
        for (const rawCall of records(delta.tool_calls, 'OpenAI delta tool_calls')) {
          const index = typeof rawCall.index === 'number' ? rawCall.index : toolStates.size;
          let state = toolStates.get(index);
          if (state === undefined) {
            state = {
              kind: 'tool',
              ordinal: states.length,
              index,
              name: '',
              argumentsText: '',
              sawArguments: false,
            };
            toolStates.set(index, state);
            states.push(state);
          }
          if (!Number.isInteger(rawCall.index) || (rawCall.index as number) < 0) {
            invalid('OpenAI Chat tool-call index must be a non-negative integer');
          }
          if (rawCall.type !== undefined && rawCall.type !== 'function') {
            invalid('OpenAI Chat stream tool-call type must be function');
          }
          if (rawCall.id !== undefined && typeof rawCall.id !== 'string') {
            invalid('OpenAI Chat stream tool-call id must be a string');
          }
          const rawCallId = stringValue(rawCall.id);
          if (
            rawCallId !== undefined &&
            state.wireIdentity !== undefined &&
            state.wireIdentity.callId !== rawCallId
          ) {
            invalid('OpenAI Chat stream tool-call id changed for one index');
          }
          if (rawCallId !== undefined) {
            state.wireIdentity ??= { callId: rawCallId };
          }
          const fn = asRecord(rawCall.function, 'OpenAI stream function call');
          if (fn.name !== undefined && typeof fn.name !== 'string') {
            invalid('OpenAI Chat stream function name must be a string');
          }
          if (fn.arguments !== undefined && typeof fn.arguments !== 'string') {
            invalid('OpenAI Chat stream function arguments must be a string');
          }
          const nameDelta = stringValue(fn.name);
          state.name += nameDelta ?? '';
          const argumentsDelta = stringValue(fn.arguments);
          if (argumentsDelta !== undefined) {
            state.sawArguments = true;
            state.argumentsText += argumentsDelta;
          }
          yield {
            type: 'tool-call-delta',
            blockOrdinal: state.ordinal,
            draftCallKey: `${context.attemptId}:${state.ordinal}`,
            ...(state.wireIdentity === undefined ? {} : { wireIdentity: state.wireIdentity }),
            ...(stringValue(fn.name) === undefined ? {} : { name: stringValue(fn.name) }),
            ...(argumentsDelta === undefined ? {} : { argumentsDelta }),
          };
        }
        const choiceFinishReason = normalizeFinishReason(choice.finish_reason);
        finishReason = choiceFinishReason ?? finishReason;
        finished ||= choiceFinishReason !== undefined;
      }
    }

    const blocks = states.map((state): DecodedModelContentBlock => {
      if (state.kind === 'text') return { type: 'text', text: state.text };
      if (!state.sawArguments) invalid('OpenAI Chat stream function arguments are required');
      return draftToolCall(
        context,
        state.ordinal,
        state.name,
        state.argumentsText,
        state.wireIdentity,
      );
    });
    if (finishReason === undefined) {
      throw new ModelProtocolError(
        'INCOMPLETE_MODEL_ATTEMPT',
        'OpenAI Chat stream ended without a terminal finish reason',
      );
    }
    const attempt = createDecodedAttempt(context, blocks, {
      terminal: true,
      finishReason,
      ...(usage === undefined ? {} : { usage }),
      ...(providerResponseId === undefined ? {} : { providerResponseId }),
    });
    for (const [blockOrdinal, block] of blocks.entries()) {
      yield { type: 'block-complete', blockOrdinal, block };
    }
    yield { type: 'finish', attempt };
  }
}

function appendOpenAIContent(
  blocks: DecodedModelContentBlock[],
  content: unknown,
  context: AttemptDecodeContext,
): void {
  if (typeof content === 'string') {
    if (content.length > 0) blocks.push({ type: 'text', text: content });
    return;
  }
  if (content === null || content === undefined) return;
  for (const part of records(content, 'OpenAI Chat content')) {
    const type = stringValue(part.type);
    if (type === 'text' || type === 'output_text') {
      if (typeof part.text !== 'string') {
        throw new ModelProtocolError('INVALID_WIRE_RESPONSE', 'OpenAI text content is required');
      }
      blocks.push({ type: 'text', text: part.text });
    } else if (type !== undefined) {
      blocks.push(providerOpaqueBlock(context, part, opaqueBlockRef(context, blocks.length)));
    } else {
      throw new ModelProtocolError('INVALID_WIRE_RESPONSE', 'OpenAI content part type is required');
    }
  }
}

function encodeMessage(
  message: ModelMessage,
  session: ProtocolEncodeSession,
): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = [];
  let content: unknown[] = [];
  let toolCalls: Record<string, unknown>[] = [];
  const role = message.role === 'developer' ? 'developer' : message.role;
  const flush = () => {
    if (content.length === 0 && toolCalls.length === 0) return;
    output.push({
      role,
      content,
      ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
    });
    content = [];
    toolCalls = [];
  };
  for (const block of message.content) {
    if (block.type === 'reasoning-summary' && !session.shouldProjectReasoningSummary(block)) continue;
    if (block.type === 'text' || block.type === 'reasoning-summary') {
      if (toolCalls.length > 0) flush();
      content.push({ type: 'text', text: block.text });
    } else if (block.type === 'tool-call') {
      const identity = session.identityFor(block.callId);
      const wireCallId = requiredIdentityCallId(identity);
      toolCalls.push({
        id: wireCallId,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.arguments) },
      });
    } else if (block.type === 'tool-result') {
      flush();
      const identity = session.identityFor(block.callId);
      output.push({
        role: 'tool',
        tool_call_id: requiredIdentityCallId(identity),
        content: JSON.stringify(block.output),
      });
    } else if (block.type === 'provider-opaque') {
      if (toolCalls.length > 0) flush();
      const opaque = session.opaqueValue(block);
      if (opaque !== undefined) content.push(asRecord(opaque, 'OpenAI opaque content'));
    } else {
      session.rejectResource();
    }
  }
  flush();
  if (output.length === 0) output.push({ role, content: [] });
  return output;
}

function requiredIdentityCallId(identity: { callId?: string }): string {
  if (identity.callId === undefined) {
    throw new ModelProtocolError(
      'MISSING_PROTOCOL_CORRELATION',
      'OpenAI Chat requires a wire call ID',
    );
  }
  return identity.callId;
}

function invalid(message: string): never {
  throw new ModelProtocolError('INVALID_WIRE_RESPONSE', message);
}

export const openAIChatCodec = new OpenAIChatCodec();
