import type {
  DecodedModelContentBlock,
  ModelMessage,
  ModelWireIdentity,
} from '../content.js';
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
import type { DecodedModelStreamEvent } from '../model-stream.js';

type ResponseStreamState =
  | { kind: 'text'; ordinal: number; text: string; complete: boolean }
  | { kind: 'reasoning-summary'; ordinal: number; text: string; complete: boolean }
  | {
      kind: 'tool';
      ordinal: number;
      name: string;
      argumentsText: string;
      wireIdentity?: ModelWireIdentity;
      complete: boolean;
    }
  | { kind: 'opaque'; ordinal: number; value: Record<string, unknown>; complete: boolean };

type ResponseStreamStateInput =
  | Omit<Extract<ResponseStreamState, { kind: 'text' }>, 'ordinal'>
  | Omit<Extract<ResponseStreamState, { kind: 'reasoning-summary' }>, 'ordinal'>
  | Omit<Extract<ResponseStreamState, { kind: 'tool' }>, 'ordinal'>
  | Omit<Extract<ResponseStreamState, { kind: 'opaque' }>, 'ordinal'>;

export class OpenAIResponsesCodec implements ModelProtocolCodec {
  readonly protocol = 'openai-responses' as const;

  encode(request: CanonicalModelRequest, context: ModelEncodeContext) {
    const session = createProtocolEncodeSession(context, this.protocol);
    return session.finish({
      model: request.model,
      input: request.messages.flatMap((message) => encodeInputMessage(message, session)),
      ...(request.tools === undefined
        ? {}
        : {
            tools: request.tools.map((tool) => ({
              type: 'function',
              name: tool.name,
              ...(tool.description === undefined ? {} : { description: tool.description }),
              parameters: tool.inputSchema,
            })),
          }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.topP === undefined ? {} : { top_p: request.topP }),
      ...(request.maxOutputTokens === undefined
        ? {}
        : { max_output_tokens: request.maxOutputTokens }),
    });
  }

  decode(response: unknown, context: AttemptDecodeContext) {
    assertContextProtocol(context, this.protocol);
    const root = asRecord(response, 'OpenAI Responses response');
    const blocks: DecodedModelContentBlock[] = [];
    for (const item of requiredRecords(root.output, 'OpenAI Responses output')) {
      appendResponseItem(blocks, item, context);
    }
    const usage = root.usage === undefined ? undefined : asRecord(root.usage, 'Responses usage');
    const details =
      usage?.input_tokens_details === undefined
        ? undefined
        : asRecord(usage.input_tokens_details, 'Responses input token details');
    const status = requiredString(root.status, 'OpenAI Responses status');
    const finishReason = normalizeFinishReason(
      status === 'completed' ? 'completed' : root.incomplete_details === undefined ? status : 'incomplete',
    );
    return createDecodedAttempt(context, blocks, {
      terminal: status === 'completed' || status === 'failed' || status === 'cancelled',
      ...(finishReason === undefined ? {} : { finishReason }),
      ...(usage === undefined
        ? {}
        : {
            usage: normalizedUsage(
              usage.input_tokens,
              usage.output_tokens,
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
    const states: ResponseStreamState[] = [];
    const itemStates = new Map<number, ResponseStreamState>();
    const contentStates = new Map<string, ResponseStreamState>();
    let providerResponseId: string | undefined;
    let usage: ReturnType<typeof normalizedUsage>;
    let terminal = false;
    let finishReason: ReturnType<typeof normalizeFinishReason>;

    const allocate = (state: ResponseStreamStateInput): ResponseStreamState => {
      const value = { ...state, ordinal: states.length };
      states.push(value);
      return value;
    };
    const textState = (outputIndex: number, contentIndex: number): Extract<ResponseStreamState, { kind: 'text' }> => {
      const key = `${outputIndex}:${contentIndex}`;
      const existing = contentStates.get(key);
      if (existing !== undefined) {
        if (existing.kind !== 'text') invalid('Responses content index changed block type');
        return existing;
      }
      const created = allocate({ kind: 'text', text: '', complete: false });
      if (created.kind !== 'text') throw new Error('unreachable');
      contentStates.set(key, created);
      return created;
    };
    const summaryState = (outputIndex: number, summaryIndex: number): Extract<ResponseStreamState, { kind: 'reasoning-summary' }> => {
      const key = `summary:${outputIndex}:${summaryIndex}`;
      const existing = contentStates.get(key);
      if (existing !== undefined) {
        if (existing.kind !== 'reasoning-summary') invalid('Responses summary index changed block type');
        return existing;
      }
      const created = allocate({ kind: 'reasoning-summary', text: '', complete: false });
      if (created.kind !== 'reasoning-summary') throw new Error('unreachable');
      contentStates.set(key, created);
      return created;
    };
    const toolState = (outputIndex: number): Extract<ResponseStreamState, { kind: 'tool' }> => {
      const existing = itemStates.get(outputIndex);
      if (existing !== undefined) {
        if (existing.kind !== 'tool') invalid('Responses output index changed item type');
        return existing;
      }
      const created = allocate({ kind: 'tool', name: '', argumentsText: '', complete: false });
      if (created.kind !== 'tool') throw new Error('unreachable');
      itemStates.set(outputIndex, created);
      return created;
    };

    for await (const eventValue of stream) {
      const event = asRecord(eventValue, 'OpenAI Responses stream event');
      const type = requiredString(event.type, 'Responses event type');
      const outputIndex = integerValue(event.output_index, 0);
      const contentIndex = integerValue(event.content_index, 0);
      if (type === 'response.created' || type === 'response.in_progress') {
        const response = asRecord(event.response, 'Responses stream response');
        providerResponseId ??= stringValue(response.id);
        continue;
      }
      if (type === 'response.output_item.added') {
        const item = asRecord(event.item, 'Responses output item');
        if (item.type === 'function_call') hydrateTool(toolState(outputIndex), item);
        continue;
      }
      if (type === 'response.content_part.added') {
        const part = asRecord(event.part, 'Responses content part');
        if (part.type === 'output_text') textState(outputIndex, contentIndex).text = stringValue(part.text) ?? '';
        else if (part.type !== undefined) {
          const state = allocate({ kind: 'opaque', value: part, complete: false });
          contentStates.set(`${outputIndex}:${contentIndex}`, state);
        } else invalid('Responses content part type is required');
        continue;
      }
      if (type === 'response.output_text.delta') {
        const state = textState(outputIndex, contentIndex);
        const delta = requiredStringAllowEmpty(event.delta, 'Responses output text delta');
        state.text += delta;
        yield { type: 'text-delta', blockOrdinal: state.ordinal, text: delta };
        continue;
      }
      if (type === 'response.output_text.done' || type === 'response.content_part.done') {
        const state = contentStates.get(`${outputIndex}:${contentIndex}`) ?? textState(outputIndex, contentIndex);
        if (state.kind === 'text' && stringValue(event.text) !== undefined) state.text = stringValue(event.text) ?? '';
        const block = streamBlock(state, context);
        state.complete = true;
        yield { type: 'block-complete', blockOrdinal: state.ordinal, block };
        continue;
      }
      if (type === 'response.reasoning_summary_part.added') {
        const part = asRecord(event.part, 'Responses reasoning summary part');
        if (part.type !== 'summary_text') invalid('Known Responses reasoning summary part type is invalid');
        const state = summaryState(outputIndex, integerValue(event.summary_index, contentIndex));
        state.text = requiredStringAllowEmpty(part.text, 'Responses reasoning summary text');
        continue;
      }
      if (type === 'response.reasoning_summary_text.delta') {
        const state = summaryState(outputIndex, integerValue(event.summary_index, contentIndex));
        const delta = requiredStringAllowEmpty(event.delta, 'Responses reasoning summary delta');
        state.text += delta;
        yield { type: 'reasoning-summary-delta', blockOrdinal: state.ordinal, text: delta };
        continue;
      }
      if (type === 'response.reasoning_summary_text.done') {
        const state = summaryState(outputIndex, integerValue(event.summary_index, contentIndex));
        if (stringValue(event.text) !== undefined) state.text = stringValue(event.text) ?? '';
        state.complete = true;
        yield {
          type: 'block-complete',
          blockOrdinal: state.ordinal,
          block: { type: 'reasoning-summary', text: state.text },
        };
        continue;
      }
      if (type === 'response.reasoning_summary_part.done') {
        const part = asRecord(event.part, 'Responses reasoning summary part');
        if (part.type !== 'summary_text') invalid('Known Responses reasoning summary part type is invalid');
        const state = summaryState(outputIndex, integerValue(event.summary_index, contentIndex));
        state.text = requiredStringAllowEmpty(part.text, 'Responses reasoning summary text');
        if (!state.complete) {
          state.complete = true;
          yield {
            type: 'block-complete',
            blockOrdinal: state.ordinal,
            block: { type: 'reasoning-summary', text: state.text },
          };
        }
        continue;
      }
      if (type === 'response.function_call_arguments.delta') {
        const state = toolState(outputIndex);
        const delta = requiredStringAllowEmpty(event.delta, 'Responses function arguments delta');
        state.argumentsText += delta;
        yield {
          type: 'tool-call-delta',
          blockOrdinal: state.ordinal,
          draftCallKey: `${context.attemptId}:${state.ordinal}`,
          ...(state.wireIdentity === undefined ? {} : { wireIdentity: state.wireIdentity }),
          ...(state.name.length === 0 ? {} : { name: state.name }),
          argumentsDelta: delta,
        };
        continue;
      }
      if (type === 'response.function_call_arguments.done') {
        const state = toolState(outputIndex);
        state.argumentsText = requiredStringAllowEmpty(event.arguments, 'Responses function arguments');
        continue;
      }
      if (type === 'response.output_item.done') {
        const item = asRecord(event.item, 'Responses completed output item');
        if (item.type === 'function_call') {
          const state = toolState(outputIndex);
          hydrateTool(state, item);
          const block = streamBlock(state, context);
          state.complete = true;
          yield { type: 'block-complete', blockOrdinal: state.ordinal, block };
        } else if (item.type === 'message') {
          for (const [index, part] of requiredRecords(item.content, 'Responses message content').entries()) {
            const state = textState(outputIndex, index);
            if (part.type !== 'output_text') invalid('Known Responses message content type is invalid');
            state.text = requiredStringAllowEmpty(part.text, 'Responses output text');
            if (!state.complete) {
              state.complete = true;
              yield {
                type: 'block-complete',
                blockOrdinal: state.ordinal,
                block: { type: 'text', text: state.text },
              };
            }
          }
        } else if (item.type === 'reasoning') {
          const streamedSummaries = [...contentStates.entries()]
            .filter(([key, state]) =>
              key.startsWith(`summary:${outputIndex}:`) && state.kind === 'reasoning-summary',
            )
            .map(([, state]) => state);
          for (const [index, summary] of records(item.summary, 'Responses reasoning summary').entries()) {
            if (summary.type !== 'summary_text') invalid('Known Responses reasoning summary type is invalid');
            const state = streamedSummaries[index] ?? summaryState(outputIndex, index);
            if (state.kind !== 'reasoning-summary') throw new Error('unreachable');
            state.text = requiredStringAllowEmpty(summary.text, 'Responses reasoning summary text');
            if (!state.complete) {
              state.complete = true;
              yield {
                type: 'block-complete',
                blockOrdinal: state.ordinal,
                block: { type: 'reasoning-summary', text: state.text },
              };
            }
          }
          const opaque = allocate({ kind: 'opaque', value: item, complete: true });
          yield {
            type: 'block-complete',
            blockOrdinal: opaque.ordinal,
            block: providerOpaqueBlock(context, item),
          };
        } else if (item.type !== undefined) {
          const opaque = allocate({ kind: 'opaque', value: item, complete: true });
          yield {
            type: 'block-complete',
            blockOrdinal: opaque.ordinal,
            block: providerOpaqueBlock(context, item),
          };
        } else invalid('Responses output item type is required');
        continue;
      }
      if (type === 'response.completed' || type === 'response.failed' || type === 'response.incomplete') {
        const response = asRecord(event.response, 'Responses terminal response');
        providerResponseId ??= stringValue(response.id);
        terminal = true;
        finishReason = normalizeFinishReason(type === 'response.completed' ? 'completed' : 'incomplete');
        if (response.usage !== undefined) {
          const rawUsage = asRecord(response.usage, 'Responses terminal usage');
          const details = rawUsage.input_tokens_details === undefined ? undefined : asRecord(rawUsage.input_tokens_details);
          usage = normalizedUsage(
            rawUsage.input_tokens,
            rawUsage.output_tokens,
            rawUsage.total_tokens,
            details?.cached_tokens,
          );
        }
        continue;
      }
      invalid(`Unsupported Responses stream event: ${type}`);
    }

    if (!terminal || finishReason === undefined) {
      throw new ModelProtocolError(
        'INCOMPLETE_MODEL_ATTEMPT',
        'OpenAI Responses stream ended without a terminal response event',
      );
    }
    if (states.some((state) => !state.complete)) {
      throw new ModelProtocolError(
        'INCOMPLETE_MODEL_ATTEMPT',
        'OpenAI Responses stream ended before every content block completed',
      );
    }
    const blocks = states.map((state) => streamBlock(state, context));
    const attempt = createDecodedAttempt(context, blocks, {
      terminal: true,
      finishReason,
      ...(usage === undefined ? {} : { usage }),
      ...(providerResponseId === undefined ? {} : { providerResponseId }),
    });
    if (usage !== undefined) yield { type: 'usage', usage };
    yield { type: 'finish', attempt };
  }
}

function appendResponseItem(
  blocks: DecodedModelContentBlock[],
  item: Record<string, unknown>,
  context: AttemptDecodeContext,
): void {
  const type = requiredString(item.type, 'Responses output item type');
  if (type === 'message') {
    for (const part of requiredRecords(item.content, 'Responses message content')) {
      if (part.type === 'output_text') {
        blocks.push({ type: 'text', text: requiredStringAllowEmpty(part.text, 'Responses output text') });
      } else if (part.type !== undefined) blocks.push(providerOpaqueBlock(context, part));
      else invalid('Responses content part type is required');
    }
    return;
  }
  if (type === 'reasoning') {
    for (const summary of records(item.summary, 'Responses reasoning summary')) {
      if (summary.type !== 'summary_text') invalid('Known Responses reasoning summary type is invalid');
      blocks.push({
        type: 'reasoning-summary',
        text: requiredStringAllowEmpty(summary.text, 'Responses reasoning summary text'),
      });
    }
    blocks.push(providerOpaqueBlock(context, item));
    return;
  }
  if (type === 'function_call') {
    const callId = stringValue(item.call_id);
    const providerItemId = stringValue(item.id);
    if (callId === undefined && providerItemId === undefined) {
      invalid('Responses function call requires call_id or item id');
    }
    blocks.push(
      draftToolCall(
        context,
        blocks.length,
        requiredString(item.name, 'Responses function name'),
        item.arguments === undefined
          ? invalid('Responses function arguments are required')
          : item.arguments,
        {
          ...(callId === undefined ? {} : { callId }),
          ...(providerItemId === undefined ? {} : { providerItemId }),
        },
      ),
    );
    return;
  }
  blocks.push(providerOpaqueBlock(context, item));
}

function encodeInputMessage(
  message: ModelMessage,
  session: ProtocolEncodeSession,
): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = [];
  for (const [ordinal, block] of message.content.entries()) {
    if (block.type === 'text' || block.type === 'reasoning-summary') {
      output.push({
        type: 'message',
        role: message.role === 'tool' ? 'user' : message.role,
        content: [{
          type: message.role === 'assistant' ? 'output_text' : 'input_text',
          text: block.text,
        }],
      });
    } else if (block.type === 'tool-call') {
      const identity = session.identityFor(block.callId, ordinal);
      output.push({
        type: 'function_call',
        ...(identity.providerItemId === undefined ? {} : { id: identity.providerItemId }),
        call_id: requiredIdentityCallId(identity),
        name: block.name,
        arguments: JSON.stringify(block.arguments),
      });
    } else if (block.type === 'tool-result') {
      const identity = session.identityFor(block.callId, ordinal);
      output.push({
        type: 'function_call_output',
        call_id: requiredIdentityCallId(identity),
        output: JSON.stringify(block.output),
      });
    } else if (block.type === 'provider-opaque') {
      output.push(asRecord(session.opaqueValue(block), 'Responses opaque item'));
    } else {
      session.rejectResource();
    }
  }
  if (output.length === 0) {
    output.push({ type: 'message', role: message.role, content: [] });
  }
  return output;
}

function hydrateTool(
  state: Extract<ResponseStreamState, { kind: 'tool' }>,
  item: Record<string, unknown>,
): void {
  if (item.type !== 'function_call') invalid('Responses output index changed item type');
  const callId = stringValue(item.call_id);
  const providerItemId = stringValue(item.id);
  if (callId === undefined && providerItemId === undefined) {
    invalid('Responses function call requires call_id or item id');
  }
  state.wireIdentity = {
    ...(callId === undefined ? {} : { callId }),
    ...(providerItemId === undefined ? {} : { providerItemId }),
  };
  state.name = requiredString(item.name, 'Responses function name');
  if (item.arguments !== undefined) {
    state.argumentsText = requiredStringAllowEmpty(item.arguments, 'Responses function arguments');
  }
}

function streamBlock(
  state: ResponseStreamState,
  context: AttemptDecodeContext,
): DecodedModelContentBlock {
  if (state.kind === 'text') return { type: 'text', text: state.text };
  if (state.kind === 'reasoning-summary') return { type: 'reasoning-summary', text: state.text };
  if (state.kind === 'opaque') return providerOpaqueBlock(context, state.value);
  return draftToolCall(
    context,
    state.ordinal,
    state.name,
    state.argumentsText,
    state.wireIdentity,
  );
}

function requiredIdentityCallId(identity: ModelWireIdentity): string {
  if (identity.callId === undefined) {
    throw new ModelProtocolError('MISSING_PROTOCOL_CORRELATION', 'Responses requires call_id');
  }
  return identity.callId;
}

function requiredStringAllowEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string') invalid(`${label} must be a string`);
  return value;
}

function integerValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function invalid(message: string): never {
  throw new ModelProtocolError('INVALID_WIRE_RESPONSE', message);
}

export const openAIResponsesCodec = new OpenAIResponsesCodec();
