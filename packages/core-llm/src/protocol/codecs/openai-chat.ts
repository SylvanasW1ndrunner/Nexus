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

type StreamBlockState =
  | { kind: 'text'; ordinal: number; text: string }
  | {
      kind: 'tool';
      ordinal: number;
      index: number;
      wireCallId?: string | undefined;
      name: string;
      argumentsText: string;
    };

export class OpenAIChatCodec implements ModelProtocolCodec {
  readonly protocol = 'openai-chat' as const;

  encode(request: CanonicalModelRequest): unknown {
    return {
      model: request.model,
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
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.topP === undefined ? {} : { top_p: request.topP }),
      ...(request.maxOutputTokens === undefined
        ? {}
        : { max_completion_tokens: request.maxOutputTokens }),
      ...(request.stop === undefined ? {} : { stop: request.stop }),
    };
  }

  decode(response: unknown, context: AttemptDecodeContext) {
    assertContextProtocol(context, this.protocol);
    const root = asRecord(response, 'OpenAI Chat response');
    const choice = records(root.choices)[0];
    if (choice === undefined) throw new Error('OpenAI Chat response has no choice');
    const message = asRecord(choice.message, 'OpenAI Chat message');
    const blocks: DecodedModelContentBlock[] = [];
    appendOpenAIContent(blocks, message.content, context);
    for (const callValue of records(message.tool_calls)) {
      const fn = asRecord(callValue.function, 'OpenAI function call');
      const ordinal = blocks.length;
      blocks.push(
        draftToolCall(
          context,
          ordinal,
          stringValue(fn.name) ?? '',
          fn.arguments,
          stringValue(callValue.id),
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
      for (const choice of records(event.choices)) {
        const delta = choice.delta === undefined ? {} : asRecord(choice.delta, 'OpenAI delta');
        const text = stringValue(delta.content);
        if (text !== undefined && text.length > 0) {
          if (textState === undefined) {
            textState = { kind: 'text', ordinal: states.length, text: '' };
            states.push(textState);
          }
          textState.text += text;
          yield { type: 'text-delta', blockOrdinal: textState.ordinal, text };
        }
        for (const rawCall of records(delta.tool_calls)) {
          const index = typeof rawCall.index === 'number' ? rawCall.index : toolStates.size;
          let state = toolStates.get(index);
          if (state === undefined) {
            state = {
              kind: 'tool',
              ordinal: states.length,
              index,
              name: '',
              argumentsText: '',
            };
            toolStates.set(index, state);
            states.push(state);
          }
          state.wireCallId ??= stringValue(rawCall.id);
          const fn = rawCall.function === undefined ? {} : asRecord(rawCall.function);
          state.name += stringValue(fn.name) ?? '';
          const argumentsDelta = stringValue(fn.arguments);
          state.argumentsText += argumentsDelta ?? '';
          yield {
            type: 'tool-call-delta',
            blockOrdinal: state.ordinal,
            draftCallKey: `${context.attemptId}:${state.ordinal}`,
            ...(state.wireCallId === undefined ? {} : { wireCallId: state.wireCallId }),
            ...(stringValue(fn.name) === undefined ? {} : { name: stringValue(fn.name) }),
            ...(argumentsDelta === undefined ? {} : { argumentsDelta }),
          };
        }
        finishReason = normalizeFinishReason(choice.finish_reason) ?? finishReason;
      }
    }

    const blocks = states.map((state): DecodedModelContentBlock => {
      if (state.kind === 'text') return { type: 'text', text: state.text };
      return draftToolCall(
        context,
        state.ordinal,
        state.name,
        state.argumentsText,
        state.wireCallId,
      );
    });
    const attempt = createDecodedAttempt(context, blocks, {
      terminal: finishReason !== undefined,
      ...(finishReason === undefined ? {} : { finishReason }),
      ...(usage === undefined ? {} : { usage }),
      ...(providerResponseId === undefined ? {} : { providerResponseId }),
    });
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
  for (const part of records(content)) {
    const type = stringValue(part.type);
    if ((type === 'text' || type === 'output_text') && typeof part.text === 'string') {
      blocks.push({ type: 'text', text: part.text });
    } else {
      blocks.push(providerOpaqueBlock(context, part));
    }
  }
}

function encodeMessage(message: ModelMessage): Record<string, unknown>[] {
  const toolResults = message.content.filter(
    (block): block is Extract<ModelContentBlock, { type: 'tool-result' }> =>
      block.type === 'tool-result',
  );
  if (toolResults.length > 0) {
    return toolResults.map((result) => ({
      role: 'tool',
      tool_call_id: result.callId,
      content: JSON.stringify(result.output),
    }));
  }
  const toolCalls = message.content.filter(
    (block): block is Extract<ModelContentBlock, { type: 'tool-call' }> => block.type === 'tool-call',
  );
  const text = message.content
    .filter((block) => block.type === 'text' || block.type === 'reasoning-summary')
    .map((block) => block.text)
    .join('');
  return [
    {
      role: message.role === 'developer' ? 'developer' : message.role,
      content: text,
      ...(toolCalls.length === 0
        ? {}
        : {
            tool_calls: toolCalls.map((call) => ({
              id: call.callId,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            })),
          }),
    },
  ];
}

export const openAIChatCodec = new OpenAIChatCodec();
