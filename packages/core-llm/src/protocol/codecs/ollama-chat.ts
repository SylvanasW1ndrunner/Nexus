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
  records,
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

type OllamaStreamBlock =
  | { kind: 'thinking'; ordinal: number; text: string }
  | { kind: 'text'; ordinal: number; text: string }
  | {
      kind: 'tool';
      ordinal: number;
      index: number;
      wireIdentity?: { callId: string } | undefined;
      name: string;
      argumentsValue: unknown;
      argumentsText: string;
      sawArguments: boolean;
    };

export class OllamaChatCodec implements ModelProtocolCodec {
  readonly protocol = 'ollama-chat' as const;
  readonly revision = 'ollama-chat@1' as const;

  constructor() {
    bindModelProtocolCodec(this);
  }

  encode(request: CanonicalModelRequest, context: ModelEncodeContext) {
    const session = createProtocolEncodeSession(context, this.protocol, request);
    return session.finish({
      model: request.model,
      stream: false,
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
      ...encodeOptions(request),
    });
  }

  decode(response: unknown, context: AttemptDecodeContext) {
    assertContextProtocol(context, this.protocol);
    const root = asRecord(response, 'Ollama Chat response');
    if (root.done !== undefined && typeof root.done !== 'boolean') {
      invalid('Ollama done must be a boolean');
    }
    const message = asRecord(root.message, 'Ollama message');
    const blocks: DecodedModelContentBlock[] = [];
    const thinking = stringValue(message.thinking);
    if (message.thinking !== undefined && thinking === undefined) {
      invalid('Ollama thinking must be a string');
    }
    if (thinking !== undefined && thinking.length > 0) {
      blocks.push(providerOpaqueBlock(
        context,
        { type: 'thinking', thinking },
        opaqueBlockRef(context, blocks.length),
      ));
    }
    const text = stringValue(message.content);
    if (message.content !== undefined && text === undefined) {
      invalid('Ollama content must be a string');
    }
    if (text !== undefined && text.length > 0) blocks.push({ type: 'text', text });
    for (const rawCall of records(message.tool_calls, 'Ollama tool_calls')) {
      const fn = asRecord(rawCall.function, 'Ollama function call');
      const wireCallId = stringValue(rawCall.id);
      blocks.push(
        draftToolCall(
          context,
          blocks.length,
          requiredString(fn.name, 'Ollama function name'),
          fn.arguments === undefined ? invalid('Ollama function arguments are required') : fn.arguments,
          wireCallId === undefined ? undefined : { callId: wireCallId },
        ),
      );
    }
    const finishReason = normalizeFinishReason(root.done_reason);
    return createDecodedAttempt(context, blocks, {
      terminal: root.done === true,
      ...(finishReason === undefined ? {} : { finishReason }),
      usage: normalizedUsage(root.prompt_eval_count, root.eval_count, undefined),
      ...(stringValue(root.created_at) === undefined
        ? {}
        : { providerResponseId: stringValue(root.created_at) }),
    });
  }

  async *decodeStream(
    stream: AsyncIterable<unknown>,
    context: AttemptDecodeContext,
  ): AsyncIterable<DecodedModelStreamEvent> {
    assertContextProtocol(context, this.protocol);
    const states: OllamaStreamBlock[] = [];
    const toolStates = new Map<number, Extract<OllamaStreamBlock, { kind: 'tool' }>>();
    let thinkingState: Extract<OllamaStreamBlock, { kind: 'thinking' }> | undefined;
    let textState: Extract<OllamaStreamBlock, { kind: 'text' }> | undefined;
    let done = false;
    let finishReason: ReturnType<typeof normalizeFinishReason>;
    let usage: ReturnType<typeof normalizedUsage>;
    let providerResponseId: string | undefined;

    for await (const chunkValue of stream) {
      const chunk = asRecord(chunkValue, 'Ollama stream chunk');
      if (done) invalid('Ollama stream emitted a chunk after done=true');
      if (chunk.done !== undefined && typeof chunk.done !== 'boolean') {
        invalid('Ollama done must be a boolean');
      }
      const message = chunk.message === undefined ? {} : asRecord(chunk.message, 'Ollama message');
      providerResponseId ??= stringValue(chunk.created_at);
      const thinking = stringValue(message.thinking);
      if (message.thinking !== undefined && thinking === undefined) {
        invalid('Ollama stream thinking must be a string');
      }
      if (thinking !== undefined && thinking.length > 0) {
        if (thinkingState === undefined) {
          thinkingState = { kind: 'thinking', ordinal: states.length, text: '' };
          states.push(thinkingState);
        }
        thinkingState.text += thinking;
      }
      const text = stringValue(message.content);
      if (message.content !== undefined && text === undefined) {
        invalid('Ollama stream content must be a string');
      }
      if (text !== undefined && text.length > 0) {
        if (textState === undefined) {
          textState = { kind: 'text', ordinal: states.length, text: '' };
          states.push(textState);
        }
        textState.text += text;
        yield { type: 'text-delta', blockOrdinal: textState.ordinal, text };
      }
      for (const [fallbackIndex, rawCall] of records(message.tool_calls, 'Ollama stream tool_calls').entries()) {
        if (
          rawCall.index !== undefined &&
          (!Number.isInteger(rawCall.index) || (rawCall.index as number) < 0)
        ) {
          invalid('Ollama tool-call index must be a non-negative integer');
        }
        const index = typeof rawCall.index === 'number' ? rawCall.index : fallbackIndex;
        let state = toolStates.get(index);
        if (state === undefined) {
          state = {
            kind: 'tool',
            ordinal: states.length,
            index,
            name: '',
            argumentsValue: undefined,
            argumentsText: '',
            sawArguments: false,
          };
          states.push(state);
          toolStates.set(index, state);
        }
        if (rawCall.id !== undefined && typeof rawCall.id !== 'string') {
          invalid('Ollama stream tool-call id must be a string');
        }
        const rawCallId = stringValue(rawCall.id);
        if (
          rawCallId !== undefined &&
          state.wireIdentity !== undefined &&
          state.wireIdentity.callId !== rawCallId
        ) {
          invalid('Ollama stream tool-call id changed for one index');
        }
        if (rawCallId !== undefined) state.wireIdentity ??= { callId: rawCallId };
        const fn = asRecord(rawCall.function, 'Ollama stream function call');
        if (fn.name !== undefined && typeof fn.name !== 'string') {
          invalid('Ollama stream function name must be a string');
        }
        const name = stringValue(fn.name);
        if (name !== undefined && state.name.length > 0 && state.name !== name) {
          invalid('Ollama stream function name changed for one index');
        }
        state.name = name ?? state.name;
        if (fn.arguments !== undefined) {
          state.sawArguments = true;
          if (typeof fn.arguments === 'string') {
            if (state.argumentsValue !== undefined) {
              invalid('Ollama stream mixed structured and string tool arguments');
            }
            state.argumentsText += fn.arguments;
          } else {
            if (state.argumentsText.length > 0 || state.argumentsValue !== undefined) {
              invalid('Ollama stream repeated structured tool arguments');
            }
            state.argumentsValue = fn.arguments;
          }
        }
        yield {
          type: 'tool-call-delta',
          blockOrdinal: state.ordinal,
          draftCallKey: `${context.attemptId}:${state.ordinal}`,
          ...(state.wireIdentity === undefined ? {} : { wireIdentity: state.wireIdentity }),
          ...(stringValue(fn.name) === undefined ? {} : { name: stringValue(fn.name) }),
          ...(typeof fn.arguments === 'string' ? { argumentsDelta: fn.arguments } : {}),
        };
      }
      done ||= chunk.done === true;
      finishReason = normalizeFinishReason(chunk.done_reason) ?? finishReason;
      usage =
        normalizedUsage(chunk.prompt_eval_count, chunk.eval_count, undefined) ?? usage;
    }

    const blocks = states.map((state): DecodedModelContentBlock => {
      if (state.kind === 'thinking') {
        return providerOpaqueBlock(
          context,
          { type: 'thinking', thinking: state.text },
          opaqueBlockRef(context, state.ordinal),
        );
      }
      if (state.kind === 'text') return { type: 'text', text: state.text };
      if (!state.sawArguments) invalid('Ollama stream function arguments are required');
      return draftToolCall(
        context,
        state.ordinal,
        state.name,
        state.argumentsText.length > 0 ? state.argumentsText : state.argumentsValue,
        state.wireIdentity,
      );
    });
    if (!done) {
      throw new ModelProtocolError(
        'INCOMPLETE_MODEL_ATTEMPT',
        'Ollama stream ended without done=true',
      );
    }
    const attempt = createDecodedAttempt(context, blocks, {
      terminal: true,
      ...(finishReason === undefined ? {} : { finishReason }),
      ...(usage === undefined ? {} : { usage }),
      ...(providerResponseId === undefined ? {} : { providerResponseId }),
    });
    for (const [blockOrdinal, block] of blocks.entries()) {
      yield { type: 'block-complete', blockOrdinal, block };
    }
    if (usage !== undefined) yield { type: 'usage', usage };
    yield { type: 'finish', attempt };
  }
}

function encodeMessage(
  message: ModelMessage,
  session: ProtocolEncodeSession,
): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = [];
  const role = message.role === 'developer' ? 'system' : message.role;
  let thinking: string | undefined;
  let content = '';
  let calls: Record<string, unknown>[] = [];
  const flush = () => {
    if (thinking === undefined && content.length === 0 && calls.length === 0) return;
    output.push({
      role,
      content,
      ...(thinking === undefined ? {} : { thinking }),
      ...(calls.length === 0 ? {} : { tool_calls: calls }),
    });
    thinking = undefined;
    content = '';
    calls = [];
  };
  for (const block of message.content) {
    if (block.type === 'reasoning-summary' && !session.shouldProjectReasoningSummary(block)) continue;
    if (block.type === 'text' || block.type === 'reasoning-summary') {
      if (calls.length > 0) flush();
      content += block.text;
    } else if (block.type === 'tool-call') {
      const identity = session.identityFor(block.callId);
      calls.push({
        id: requiredIdentityCallId(identity),
        function: { name: block.name, arguments: block.arguments },
      });
    } else if (block.type === 'tool-result') {
      flush();
      const identity = session.identityFor(block.callId);
      output.push({
        role: 'tool',
        content: JSON.stringify(block.output),
        tool_call_id: requiredIdentityCallId(identity),
      });
    } else if (block.type === 'provider-opaque') {
      if (content.length > 0 || calls.length > 0 || thinking !== undefined) flush();
      const opaqueValue = session.opaqueValue(block);
      if (opaqueValue === undefined) continue;
      const opaque = asRecord(opaqueValue, 'Ollama opaque block');
      if (opaque.type !== 'thinking' || typeof opaque.thinking !== 'string') {
        throw new ModelProtocolError(
          'UNREPRESENTABLE_CANONICAL_BLOCK',
          'Ollama can only replay its native thinking opaque block',
        );
      }
      thinking = opaque.thinking;
    } else {
      session.rejectResource();
    }
  }
  flush();
  if (output.length === 0) output.push({ role, content: '' });
  return output;
}

function requiredIdentityCallId(identity: { callId?: string }): string {
  if (identity.callId === undefined) {
    throw new ModelProtocolError(
      'MISSING_PROTOCOL_CORRELATION',
      'Ollama Chat requires a wire call ID',
    );
  }
  return identity.callId;
}

function invalid(message: string): never {
  throw new ModelProtocolError('INVALID_WIRE_RESPONSE', message);
}

function encodeOptions(request: CanonicalModelRequest): Record<string, unknown> {
  const options = {
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.topP === undefined ? {} : { top_p: request.topP }),
    ...(request.maxOutputTokens === undefined ? {} : { num_predict: request.maxOutputTokens }),
    ...(request.stop === undefined ? {} : { stop: request.stop }),
  };
  return Object.keys(options).length === 0 ? {} : { options };
}

export const ollamaChatCodec = new OllamaChatCodec();
