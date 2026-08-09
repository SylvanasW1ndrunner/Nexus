import type { ModelContentBlock, ModelMessage } from '../content.js';
import {
  asRecord,
  assertContextProtocol,
  createDecodedAttempt,
  draftToolCall,
  normalizedUsage,
  normalizeFinishReason,
  providerOpaqueBlock,
  records,
  stringValue,
  type AttemptDecodeContext,
  type CanonicalModelRequest,
  type ModelProtocolCodec,
} from '../codec.js';
import type { DecodedModelContentBlock } from '../content.js';
import type { DecodedModelStreamEvent } from '../model-stream.js';

type OllamaStreamBlock =
  | { kind: 'thinking'; ordinal: number; text: string }
  | { kind: 'text'; ordinal: number; text: string }
  | {
      kind: 'tool';
      ordinal: number;
      index: number;
      wireCallId?: string | undefined;
      name: string;
      argumentsValue: unknown;
      argumentsText: string;
    };

export class OllamaChatCodec implements ModelProtocolCodec {
  readonly protocol = 'ollama-chat' as const;

  encode(request: CanonicalModelRequest): unknown {
    return {
      model: request.model,
      stream: false,
      messages: request.messages.flatMap(encodeMessage),
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
    };
  }

  decode(response: unknown, context: AttemptDecodeContext) {
    assertContextProtocol(context, this.protocol);
    const root = asRecord(response, 'Ollama Chat response');
    const message = asRecord(root.message, 'Ollama message');
    const blocks: DecodedModelContentBlock[] = [];
    const thinking = stringValue(message.thinking);
    if (thinking !== undefined && thinking.length > 0) {
      blocks.push(providerOpaqueBlock(context, { type: 'thinking', thinking }));
    }
    const text = stringValue(message.content);
    if (text !== undefined && text.length > 0) blocks.push({ type: 'text', text });
    for (const rawCall of records(message.tool_calls)) {
      const fn = asRecord(rawCall.function, 'Ollama function call');
      blocks.push(
        draftToolCall(
          context,
          blocks.length,
          stringValue(fn.name) ?? '',
          fn.arguments,
          stringValue(rawCall.id),
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
      const message = chunk.message === undefined ? {} : asRecord(chunk.message, 'Ollama message');
      providerResponseId ??= stringValue(chunk.created_at);
      const thinking = stringValue(message.thinking);
      if (thinking !== undefined && thinking.length > 0) {
        if (thinkingState === undefined) {
          thinkingState = { kind: 'thinking', ordinal: states.length, text: '' };
          states.push(thinkingState);
        }
        thinkingState.text += thinking;
      }
      const text = stringValue(message.content);
      if (text !== undefined && text.length > 0) {
        if (textState === undefined) {
          textState = { kind: 'text', ordinal: states.length, text: '' };
          states.push(textState);
        }
        textState.text += text;
        yield { type: 'text-delta', blockOrdinal: textState.ordinal, text };
      }
      for (const [fallbackIndex, rawCall] of records(message.tool_calls).entries()) {
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
          };
          states.push(state);
          toolStates.set(index, state);
        }
        state.wireCallId ??= stringValue(rawCall.id);
        const fn = rawCall.function === undefined ? {} : asRecord(rawCall.function);
        state.name = stringValue(fn.name) ?? state.name;
        if (typeof fn.arguments === 'string') state.argumentsText += fn.arguments;
        else if (fn.arguments !== undefined) state.argumentsValue = fn.arguments;
        yield {
          type: 'tool-call-delta',
          blockOrdinal: state.ordinal,
          draftCallKey: `${context.attemptId}:${state.ordinal}`,
          ...(state.wireCallId === undefined ? {} : { wireCallId: state.wireCallId }),
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
        return providerOpaqueBlock(context, { type: 'thinking', thinking: state.text });
      }
      if (state.kind === 'text') return { type: 'text', text: state.text };
      return draftToolCall(
        context,
        state.ordinal,
        state.name,
        state.argumentsText.length > 0 ? state.argumentsText : state.argumentsValue,
        state.wireCallId,
      );
    });
    const attempt = createDecodedAttempt(context, blocks, {
      terminal: done,
      ...(finishReason === undefined ? {} : { finishReason }),
      ...(usage === undefined ? {} : { usage }),
      ...(providerResponseId === undefined ? {} : { providerResponseId }),
    });
    if (usage !== undefined) yield { type: 'usage', usage };
    yield { type: 'finish', attempt };
  }
}

function encodeMessage(message: ModelMessage): Record<string, unknown>[] {
  const results = message.content.filter(
    (block): block is Extract<ModelContentBlock, { type: 'tool-result' }> =>
      block.type === 'tool-result',
  );
  if (results.length > 0) {
    return results.map((result) => ({
      role: 'tool',
      content: JSON.stringify(result.output),
      tool_call_id: result.callId,
    }));
  }
  const calls = message.content.filter(
    (block): block is Extract<ModelContentBlock, { type: 'tool-call' }> => block.type === 'tool-call',
  );
  const text = message.content
    .filter((block) => block.type === 'text' || block.type === 'reasoning-summary')
    .map((block) => block.text)
    .join('');
  return [
    {
      role: message.role === 'developer' ? 'system' : message.role,
      content: text,
      ...(calls.length === 0
        ? {}
        : {
            tool_calls: calls.map((call) => ({
              function: { name: call.name, arguments: call.arguments },
            })),
          }),
    },
  ];
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
