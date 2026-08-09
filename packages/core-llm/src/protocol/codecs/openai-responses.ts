import { isDeepStrictEqual } from 'node:util';
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
import type { ModelFinishReason } from '../envelope.js';
import type { DecodedModelStreamEvent } from '../model-stream.js';

type ResponseStreamState =
  | {
      kind: 'text';
      ordinal: number;
      text: string;
      textDone: boolean;
      complete: boolean;
    }
  | {
      kind: 'reasoning-summary';
      ordinal: number;
      text: string;
      textDone: boolean;
      derivedFromOpaqueRef: string;
      complete: boolean;
    }
  | {
      kind: 'tool';
      ordinal: number;
      name: string;
      argumentsText: string;
      wireIdentity?: ModelWireIdentity;
      argumentsDone: boolean;
      complete: boolean;
    }
  | {
      kind: 'opaque';
      ordinal: number;
      opaqueRef: string;
      value: Record<string, unknown>;
      complete: boolean;
    }
  | {
      kind: 'refusal';
      ordinal: number;
      opaqueRef: string;
      refusal: string;
      refusalDone: boolean;
      complete: boolean;
    };

type ResponseItemLifecycle = {
  type: string;
  providerItemId?: string;
  callId?: string;
  opaqueRef: string;
  done: boolean;
};

type ResponsePartLifecycle = {
  type: string;
  done: boolean;
};

type ResponseStreamStateInput =
  | Omit<Extract<ResponseStreamState, { kind: 'text' }>, 'ordinal'>
  | Omit<Extract<ResponseStreamState, { kind: 'reasoning-summary' }>, 'ordinal'>
  | Omit<Extract<ResponseStreamState, { kind: 'tool' }>, 'ordinal'>
  | Omit<Extract<ResponseStreamState, { kind: 'opaque' }>, 'ordinal'>
  | Omit<Extract<ResponseStreamState, { kind: 'refusal' }>, 'ordinal'>;

export class OpenAIResponsesCodec implements ModelProtocolCodec {
  readonly protocol = 'openai-responses' as const;
  readonly revision = 'openai-responses@1' as const;


  encode(request: CanonicalModelRequest, context: ModelEncodeContext) {
    const session = createProtocolEncodeSession(context, this.protocol, request);
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
    const terminal = ['completed', 'incomplete', 'failed', 'cancelled'].includes(status);
    if (!terminal) {
      throw new ModelProtocolError(
        'INCOMPLETE_MODEL_ATTEMPT',
        `OpenAI Responses static response is not terminal: ${status}`,
      );
    }
    const finishReason = responsesFinishReason(status, root.incomplete_details);
    return createDecodedAttempt(context, blocks, {
      terminal,
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
    const itemLifecycles = new Map<number, ResponseItemLifecycle>();
    const contentLifecycles = new Map<string, ResponsePartLifecycle>();
    const summaryLifecycles = new Map<string, ResponsePartLifecycle>();
    const lastContentIndices = new Map<number, number>();
    const lastSummaryIndices = new Map<number, number>();
    let lastOutputIndex: number | undefined;
    let providerResponseId: string | undefined;
    let usage: ReturnType<typeof normalizedUsage>;
    let terminal = false;
    let finishReason: ModelFinishReason | undefined;

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
      const created = allocate({
        kind: 'text',
        text: '',
        textDone: false,
        complete: false,
      });
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
      const lifecycle = requireItemLifecycle(itemLifecycles, outputIndex, 'reasoning');
      const created = allocate({
        kind: 'reasoning-summary',
        text: '',
        textDone: false,
        derivedFromOpaqueRef: lifecycle.opaqueRef,
        complete: false,
      });
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
      const created = allocate({
        kind: 'tool',
        name: '',
        argumentsText: '',
        argumentsDone: false,
        complete: false,
      });
      if (created.kind !== 'tool') throw new Error('unreachable');
      itemStates.set(outputIndex, created);
      return created;
    };
    const currentItemLifecycle = (
      outputIndex: number,
      expectedType: string,
    ): ResponseItemLifecycle => {
      if (lastOutputIndex !== undefined && outputIndex < lastOutputIndex) {
        invalid('Responses event output_index moved backwards');
      }
      return requireItemLifecycle(itemLifecycles, outputIndex, expectedType);
    };

    for await (const eventValue of stream) {
      const event = asRecord(eventValue, 'OpenAI Responses stream event');
      const type = requiredString(event.type, 'Responses event type');
      if (terminal) invalid('Responses stream emitted an event after its terminal response');
      if (
        type === 'response.created' ||
        type === 'response.queued' ||
        type === 'response.in_progress'
      ) {
        const response = asRecord(event.response, 'Responses stream response');
        providerResponseId ??= stringValue(response.id);
        continue;
      }
      if (type === 'response.output_item.added') {
        const outputIndex = requiredIndex(event.output_index, 'Responses output_index');
        if (lastOutputIndex !== undefined) {
          if (outputIndex <= lastOutputIndex) {
            invalid('Responses output item indexes must be strictly increasing');
          }
          if (!itemLifecycles.get(lastOutputIndex)?.done) {
            invalid('Responses output item started before the previous item was done');
          }
        }
        if (itemLifecycles.has(outputIndex)) {
          invalid('Responses output item index started more than once');
        }
        lastOutputIndex = outputIndex;
        const item = asRecord(event.item, 'Responses output item');
        const itemType = requiredString(item.type, 'Responses output item type');
        const providerItemId = optionalString(item.id, 'Responses output item id');
        const callId = optionalString(item.call_id, 'Responses function call_id');
        if (itemType === 'function_call' && callId === undefined) {
          invalid('Responses function call requires call_id');
        }
        const lifecycle: ResponseItemLifecycle = {
          type: itemType,
          ...(providerItemId === undefined ? {} : { providerItemId }),
          ...(callId === undefined ? {} : { callId }),
          opaqueRef: opaqueBlockRef(context, `output:${outputIndex}`),
          done: false,
        };
        itemLifecycles.set(outputIndex, lifecycle);
        if (itemType === 'function_call') hydrateTool(toolState(outputIndex), item, false);
        else if (itemType === 'message') requiredRecords(item.content, 'Responses message content');
        else if (itemType === 'reasoning') records(item.summary, 'Responses reasoning summary');
        continue;
      }
      if (type === 'response.content_part.added') {
        const outputIndex = requiredIndex(event.output_index, 'Responses output_index');
        const contentIndex = requiredIndex(event.content_index, 'Responses content_index');
        currentItemLifecycle(outputIndex, 'message');
        const previousContentIndex = lastContentIndices.get(outputIndex);
        if (previousContentIndex !== undefined && contentIndex <= previousContentIndex) {
          invalid('Responses message content indexes must be strictly increasing');
        }
        lastContentIndices.set(outputIndex, contentIndex);
        const key = `${outputIndex}:${contentIndex}`;
        if (contentLifecycles.has(key)) invalid('Responses content part index started more than once');
        const part = asRecord(event.part, 'Responses content part');
        const partType = requiredString(part.type, 'Responses content part type');
        contentLifecycles.set(key, { type: partType, done: false });
        if (partType === 'output_text') {
          textState(outputIndex, contentIndex).text = requiredStringAllowEmpty(
            part.text,
            'Responses output text',
          );
        } else if (partType === 'refusal') {
          const state = allocate({
            kind: 'refusal',
            opaqueRef: opaqueBlockRef(context, `content:${outputIndex}:${contentIndex}`),
            refusal: requiredStringAllowEmpty(part.refusal, 'Responses refusal'),
            refusalDone: false,
            complete: false,
          });
          contentStates.set(key, state);
        } else {
          const state = allocate({
            kind: 'opaque',
            opaqueRef: opaqueBlockRef(context, `content:${outputIndex}:${contentIndex}`),
            value: part,
            complete: false,
          });
          contentStates.set(key, state);
        }
        continue;
      }
      if (type === 'response.output_text.delta') {
        const outputIndex = requiredIndex(event.output_index, 'Responses output_index');
        const contentIndex = requiredIndex(event.content_index, 'Responses content_index');
        currentItemLifecycle(outputIndex, 'message');
        requirePartLifecycle(contentLifecycles, `${outputIndex}:${contentIndex}`, 'output_text');
        const state = textState(outputIndex, contentIndex);
        if (state.textDone || state.complete) {
          invalid('Responses output text delta followed leaf completion');
        }
        const delta = requiredStringAllowEmpty(event.delta, 'Responses output text delta');
        state.text += delta;
        yield { type: 'text-delta', blockOrdinal: state.ordinal, text: delta };
        continue;
      }
      if (type === 'response.output_text.done') {
        const outputIndex = requiredIndex(event.output_index, 'Responses output_index');
        const contentIndex = requiredIndex(event.content_index, 'Responses content_index');
        currentItemLifecycle(outputIndex, 'message');
        requirePartLifecycle(contentLifecycles, `${outputIndex}:${contentIndex}`, 'output_text');
        const state = textState(outputIndex, contentIndex);
        if (state.textDone || state.complete) invalid('Responses output text completed more than once');
        state.text = requiredStringAllowEmpty(event.text, 'Responses output text');
        state.textDone = true;
        continue;
      }
      if (type === 'response.content_part.done') {
        const outputIndex = requiredIndex(event.output_index, 'Responses output_index');
        const contentIndex = requiredIndex(event.content_index, 'Responses content_index');
        currentItemLifecycle(outputIndex, 'message');
        const key = `${outputIndex}:${contentIndex}`;
        const part = asRecord(event.part, 'Responses completed content part');
        const partType = requiredString(part.type, 'Responses completed content part type');
        const lifecycle = requirePartLifecycle(contentLifecycles, key, partType);
        if (lifecycle.done) invalid('Responses content part completed more than once');
        const state = contentStates.get(key);
        if (state === undefined) invalid('Responses content part completion has no canonical state');
        if (state.kind === 'text') {
          if (!state.textDone) invalid('Responses content part completed before output_text.done');
          const finalText = requiredStringAllowEmpty(part.text, 'Responses output text');
          if (state.text !== finalText) {
            invalid('Responses content part text conflicts with output_text.done');
          }
        } else if (state.kind === 'refusal') {
          if (!state.refusalDone) invalid('Responses refusal part completed before refusal.done');
          const finalRefusal = requiredStringAllowEmpty(part.refusal, 'Responses refusal');
          if (state.refusal !== finalRefusal) {
            invalid('Responses content part refusal conflicts with refusal.done');
          }
        } else if (state.kind === 'opaque') state.value = part;
        else invalid('Responses content part changed canonical block type');
        lifecycle.done = true;
        yield completeState(state, context);
        continue;
      }
      if (type === 'response.refusal.delta') {
        const outputIndex = requiredIndex(event.output_index, 'Responses output_index');
        const contentIndex = requiredIndex(event.content_index, 'Responses content_index');
        currentItemLifecycle(outputIndex, 'message');
        requirePartLifecycle(contentLifecycles, `${outputIndex}:${contentIndex}`, 'refusal');
        const state = contentStates.get(`${outputIndex}:${contentIndex}`);
        if (state?.kind !== 'refusal') invalid('Responses refusal index changed block type');
        if (state.refusalDone || state.complete) {
          invalid('Responses refusal delta followed leaf completion');
        }
        const delta = requiredStringAllowEmpty(event.delta, 'Responses refusal delta');
        state.refusal += delta;
        yield {
          type: 'provider-opaque-delta',
          blockOrdinal: state.ordinal,
          opaqueRef: state.opaqueRef,
          protocol: this.protocol,
          fragment: { type: 'refusal', refusal: delta },
        };
        continue;
      }
      if (type === 'response.refusal.done') {
        const outputIndex = requiredIndex(event.output_index, 'Responses output_index');
        const contentIndex = requiredIndex(event.content_index, 'Responses content_index');
        currentItemLifecycle(outputIndex, 'message');
        requirePartLifecycle(contentLifecycles, `${outputIndex}:${contentIndex}`, 'refusal');
        const state = contentStates.get(`${outputIndex}:${contentIndex}`);
        if (state?.kind !== 'refusal') invalid('Responses refusal index changed block type');
        if (state.refusalDone || state.complete) {
          invalid('Responses refusal completed more than once');
        }
        state.refusal = requiredStringAllowEmpty(event.refusal, 'Responses refusal');
        state.refusalDone = true;
        continue;
      }
      if (type === 'response.reasoning_summary_part.added') {
        const outputIndex = requiredIndex(event.output_index, 'Responses output_index');
        const summaryIndex = requiredIndex(event.summary_index, 'Responses summary_index');
        currentItemLifecycle(outputIndex, 'reasoning');
        const previousSummaryIndex = lastSummaryIndices.get(outputIndex);
        if (previousSummaryIndex !== undefined && summaryIndex <= previousSummaryIndex) {
          invalid('Responses reasoning summary indexes must be strictly increasing');
        }
        lastSummaryIndices.set(outputIndex, summaryIndex);
        const key = `summary:${outputIndex}:${summaryIndex}`;
        if (summaryLifecycles.has(key)) invalid('Responses reasoning summary part started more than once');
        const part = asRecord(event.part, 'Responses reasoning summary part');
        if (part.type !== 'summary_text') invalid('Known Responses reasoning summary part type is invalid');
        summaryLifecycles.set(key, { type: 'summary_text', done: false });
        const state = summaryState(outputIndex, summaryIndex);
        state.text = requiredStringAllowEmpty(part.text, 'Responses reasoning summary text');
        continue;
      }
      if (type === 'response.reasoning_summary_text.delta') {
        const outputIndex = requiredIndex(event.output_index, 'Responses output_index');
        const summaryIndex = requiredIndex(event.summary_index, 'Responses summary_index');
        currentItemLifecycle(outputIndex, 'reasoning');
        requirePartLifecycle(
          summaryLifecycles,
          `summary:${outputIndex}:${summaryIndex}`,
          'summary_text',
        );
        const state = summaryState(outputIndex, summaryIndex);
        if (state.textDone || state.complete) {
          invalid('Responses reasoning summary delta followed leaf completion');
        }
        const delta = requiredStringAllowEmpty(event.delta, 'Responses reasoning summary delta');
        state.text += delta;
        yield {
          type: 'reasoning-summary-delta',
          blockOrdinal: state.ordinal,
          text: delta,
        };
        continue;
      }
      if (type === 'response.reasoning_summary_text.done') {
        const outputIndex = requiredIndex(event.output_index, 'Responses output_index');
        const summaryIndex = requiredIndex(event.summary_index, 'Responses summary_index');
        currentItemLifecycle(outputIndex, 'reasoning');
        requirePartLifecycle(
          summaryLifecycles,
          `summary:${outputIndex}:${summaryIndex}`,
          'summary_text',
        );
        const state = summaryState(outputIndex, summaryIndex);
        if (state.textDone || state.complete) {
          invalid('Responses reasoning summary completed more than once');
        }
        state.text = requiredStringAllowEmpty(event.text, 'Responses reasoning summary text');
        state.textDone = true;
        continue;
      }
      if (type === 'response.reasoning_summary_part.done') {
        const outputIndex = requiredIndex(event.output_index, 'Responses output_index');
        const summaryIndex = requiredIndex(event.summary_index, 'Responses summary_index');
        currentItemLifecycle(outputIndex, 'reasoning');
        const key = `summary:${outputIndex}:${summaryIndex}`;
        const part = asRecord(event.part, 'Responses reasoning summary part');
        if (part.type !== 'summary_text') invalid('Known Responses reasoning summary part type is invalid');
        const lifecycle = requirePartLifecycle(summaryLifecycles, key, 'summary_text');
        if (lifecycle.done) invalid('Responses reasoning summary part completed more than once');
        const state = summaryState(outputIndex, summaryIndex);
        if (!state.textDone) {
          invalid('Responses reasoning summary part completed before reasoning_summary_text.done');
        }
        const finalText = requiredStringAllowEmpty(part.text, 'Responses reasoning summary text');
        if (state.text !== finalText) {
          invalid('Responses summary part text conflicts with reasoning_summary_text.done');
        }
        lifecycle.done = true;
        yield completeState(state, context);
        continue;
      }
      if (type === 'response.function_call_arguments.delta') {
        const outputIndex = requiredIndex(event.output_index, 'Responses output_index');
        currentItemLifecycle(outputIndex, 'function_call');
        const state = toolState(outputIndex);
        if (state.argumentsDone || state.complete) {
          invalid('Responses function arguments delta followed completion');
        }
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
        const outputIndex = requiredIndex(event.output_index, 'Responses output_index');
        currentItemLifecycle(outputIndex, 'function_call');
        const state = toolState(outputIndex);
        if (state.argumentsDone || state.complete) {
          invalid('Responses function arguments completed more than once');
        }
        state.argumentsText = requiredStringAllowEmpty(event.arguments, 'Responses function arguments');
        state.argumentsDone = true;
        continue;
      }
      if (type === 'response.output_item.done') {
        const outputIndex = requiredIndex(event.output_index, 'Responses output_index');
        const item = asRecord(event.item, 'Responses completed output item');
        const itemType = requiredString(item.type, 'Responses completed output item type');
        const lifecycle = currentItemLifecycle(outputIndex, itemType);
        if (lifecycle.done) invalid('Responses output item completed more than once');
        validateCompletedItem(lifecycle, item);
        if (itemType === 'function_call') {
          const state = toolState(outputIndex);
          if (!state.argumentsDone) {
            invalid('Responses function item completed before function_call_arguments.done');
          }
          hydrateTool(state, item, true);
          yield completeState(state, context);
        } else if (itemType === 'message') {
          const parts = requiredRecords(item.content, 'Responses message content');
          const lifecycles = [...contentLifecycles.entries()]
            .filter(([key]) => key.startsWith(`${outputIndex}:`))
            .sort((left, right) => contentIndexFromKey(left[0]) - contentIndexFromKey(right[0]));
          if (parts.length !== lifecycles.length) {
            invalid('Responses completed message content does not match started parts');
          }
          for (const [index, part] of parts.entries()) {
            const entry = lifecycles[index];
            if (entry === undefined || !entry[1].done) {
              invalid('Responses output item completed before its content part');
            }
            const partType = requiredString(part.type, 'Responses completed message content type');
            if (entry[1].type !== partType) {
              invalid('Responses completed message content type conflicts with its part lifecycle');
            }
            const state = contentStates.get(entry[0]);
            if (partType === 'output_text') {
              if (state?.kind !== 'text' || !state.textDone || !state.complete) {
                invalid('Responses completed message content lacks one completed text state');
              }
              const finalText = requiredStringAllowEmpty(part.text, 'Responses output text');
              if (state.text !== finalText) invalid('Responses completed message text conflicts with its part');
            } else if (partType === 'refusal') {
              if (state?.kind !== 'refusal' || !state.refusalDone || !state.complete) {
                invalid('Responses completed message content lacks one completed refusal state');
              }
              const finalRefusal = requiredStringAllowEmpty(part.refusal, 'Responses refusal');
              if (state.refusal !== finalRefusal) {
                invalid('Responses completed message refusal conflicts with its part');
              }
            } else {
              if (state?.kind !== 'opaque' || !state.complete) {
                invalid('Responses completed message content lacks one completed opaque state');
              }
              if (!isDeepStrictEqual(state.value, part)) {
                invalid('Responses completed message opaque content conflicts with completed content part');
              }
            }
          }
        } else if (itemType === 'reasoning') {
          const streamedSummaries = [...contentStates.entries()]
            .filter(([key, state]) =>
              key.startsWith(`summary:${outputIndex}:`) && state.kind === 'reasoning-summary',
            )
            .map(([, state]) => state);
          const summaries = records(item.summary, 'Responses reasoning summary');
          if (summaries.length !== streamedSummaries.length) {
            invalid('Responses completed reasoning summary does not match started parts');
          }
          for (const [index, summary] of summaries.entries()) {
            if (summary.type !== 'summary_text') invalid('Known Responses reasoning summary type is invalid');
            const state = streamedSummaries[index];
            if (state?.kind !== 'reasoning-summary' || !state.complete) {
              invalid('Responses output item completed before its reasoning summary part');
            }
            const finalText = requiredStringAllowEmpty(summary.text, 'Responses reasoning summary text');
            if (state.text !== finalText) invalid('Responses completed reasoning summary conflicts with its part');
          }
          const opaque = allocate({
            kind: 'opaque',
            opaqueRef: lifecycle.opaqueRef,
            value: item,
            complete: false,
          });
          yield completeState(opaque, context);
        } else {
          const opaque = allocate({
            kind: 'opaque',
            opaqueRef: lifecycle.opaqueRef,
            value: item,
            complete: false,
          });
          yield completeState(opaque, context);
        }
        lifecycle.done = true;
        continue;
      }
      if (type === 'response.completed' || type === 'response.failed' || type === 'response.incomplete') {
        const response = asRecord(event.response, 'Responses terminal response');
        providerResponseId ??= stringValue(response.id);
        terminal = true;
        finishReason = type === 'response.completed'
          ? 'stop'
          : type === 'response.incomplete'
            ? responsesFinishReason('incomplete', response.incomplete_details)
            : 'error';
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
    if (
      [...itemLifecycles.values()].some((item) => !item.done) ||
      [...contentLifecycles.values()].some((part) => !part.done) ||
      [...summaryLifecycles.values()].some((part) => !part.done) ||
      states.some((state) => !state.complete)
    ) {
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
      } else if (part.type !== undefined) {
        blocks.push(providerOpaqueBlock(context, part, opaqueBlockRef(context, blocks.length)));
      }
      else invalid('Responses content part type is required');
    }
    return;
  }
  if (type === 'reasoning') {
    const summaries = records(item.summary, 'Responses reasoning summary');
    const opaqueRef = opaqueBlockRef(context, blocks.length + summaries.length);
    for (const summary of summaries) {
      if (summary.type !== 'summary_text') invalid('Known Responses reasoning summary type is invalid');
      blocks.push({
        type: 'reasoning-summary',
        text: requiredStringAllowEmpty(summary.text, 'Responses reasoning summary text'),
        derivedFromOpaqueRef: opaqueRef,
      });
    }
    blocks.push(providerOpaqueBlock(context, item, opaqueRef));
    return;
  }
  if (type === 'function_call') {
    const callId = requiredString(item.call_id, 'Responses function call_id');
    const providerItemId = stringValue(item.id);
    blocks.push(
      draftToolCall(
        context,
        blocks.length,
        requiredString(item.name, 'Responses function name'),
        item.arguments === undefined
          ? invalid('Responses function arguments are required')
          : item.arguments,
        {
          callId,
          ...(providerItemId === undefined ? {} : { providerItemId }),
        },
      ),
    );
    return;
  }
  blocks.push(providerOpaqueBlock(context, item, opaqueBlockRef(context, blocks.length)));
}

function encodeInputMessage(
  message: ModelMessage,
  session: ProtocolEncodeSession,
): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = [];
  for (const block of message.content) {
    if (block.type === 'reasoning-summary' && !session.shouldProjectReasoningSummary(block)) continue;
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
      const identity = session.identityFor(block.callId);
      output.push({
        type: 'function_call',
        ...(identity.providerItemId === undefined ? {} : { id: identity.providerItemId }),
        call_id: requiredIdentityCallId(identity),
        name: block.name,
        arguments: JSON.stringify(block.arguments),
      });
    } else if (block.type === 'tool-result') {
      const identity = session.identityFor(block.callId);
      output.push({
        type: 'function_call_output',
        call_id: requiredIdentityCallId(identity),
        output: JSON.stringify(block.output),
      });
    } else if (block.type === 'provider-opaque') {
      const opaque = session.opaqueValue(block);
      if (opaque !== undefined) output.push(asRecord(opaque, 'Responses opaque item'));
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
  requireArguments: boolean,
): void {
  if (item.type !== 'function_call') invalid('Responses output index changed item type');
  const callId = requiredString(item.call_id, 'Responses function call_id');
  const providerItemId = optionalString(item.id, 'Responses function item id');
  const identity: ModelWireIdentity = {
    callId,
    ...(providerItemId === undefined ? {} : { providerItemId }),
  };
  if (state.wireIdentity !== undefined && !sameWireIdentity(state.wireIdentity, identity)) {
    invalid('Responses function identity changed for one output index');
  }
  state.wireIdentity = identity;
  const name = requiredString(item.name, 'Responses function name');
  if (state.name.length > 0 && state.name !== name) {
    invalid('Responses function name changed for one output index');
  }
  state.name = name;
  if (requireArguments && typeof item.arguments !== 'string') {
    invalid('Responses completed function arguments must be a string');
  }
  if (item.arguments !== undefined) {
    const argumentsText = requiredStringAllowEmpty(item.arguments, 'Responses function arguments');
    if (state.argumentsDone && state.argumentsText !== argumentsText) {
      invalid('Responses completed function arguments conflict with arguments.done');
    }
    state.argumentsText = argumentsText;
  }
}

function streamBlock(
  state: ResponseStreamState,
  context: AttemptDecodeContext,
): DecodedModelContentBlock {
  if (state.kind === 'text') return { type: 'text', text: state.text };
  if (state.kind === 'reasoning-summary') {
    return {
      type: 'reasoning-summary',
      text: state.text,
      derivedFromOpaqueRef: state.derivedFromOpaqueRef,
    };
  }
  if (state.kind === 'opaque') {
    return providerOpaqueBlock(context, state.value, state.opaqueRef);
  }
  if (state.kind === 'refusal') {
    return providerOpaqueBlock(
      context,
      { type: 'refusal', refusal: state.refusal },
      state.opaqueRef,
    );
  }
  return draftToolCall(
    context,
    state.ordinal,
    state.name,
    state.argumentsText,
    state.wireIdentity,
  );
}

function completeState(
  state: ResponseStreamState,
  context: AttemptDecodeContext,
): Extract<DecodedModelStreamEvent, { type: 'block-complete' }> {
  if (state.complete) invalid('Responses canonical block completed more than once');
  state.complete = true;
  return {
    type: 'block-complete',
    blockOrdinal: state.ordinal,
    block: streamBlock(state, context),
  };
}

function responsesFinishReason(status: string, incompleteDetails: unknown): ModelFinishReason {
  if (status === 'completed') return 'stop';
  if (status !== 'incomplete') return 'error';
  if (incompleteDetails === undefined || incompleteDetails === null) return 'error';
  const details = asRecord(incompleteDetails, 'Responses incomplete details');
  const reason = optionalString(details.reason, 'Responses incomplete reason');
  if (reason === 'max_output_tokens') return 'length';
  if (reason === 'content_filter') return 'content-filter';
  return 'error';
}

function contentIndexFromKey(key: string): number {
  const separator = key.lastIndexOf(':');
  return Number(key.slice(separator + 1));
}

function requireItemLifecycle(
  lifecycles: ReadonlyMap<number, ResponseItemLifecycle>,
  outputIndex: number,
  expectedType: string,
): ResponseItemLifecycle {
  const lifecycle = lifecycles.get(outputIndex);
  if (lifecycle === undefined) invalid('Responses event references an output item that was not added');
  if (lifecycle.type !== expectedType) invalid('Responses output item index changed type');
  if (lifecycle.done) invalid('Responses event references an output item that is already done');
  return lifecycle;
}

function requirePartLifecycle(
  lifecycles: ReadonlyMap<string, ResponsePartLifecycle>,
  key: string,
  expectedType: string,
): ResponsePartLifecycle {
  const lifecycle = lifecycles.get(key);
  if (lifecycle === undefined) invalid('Responses event references a part that was not added');
  if (lifecycle.type !== expectedType) invalid('Responses part index changed type');
  return lifecycle;
}

function validateCompletedItem(
  lifecycle: ResponseItemLifecycle,
  item: Record<string, unknown>,
): void {
  const providerItemId = optionalString(item.id, 'Responses completed output item id');
  const callId = optionalString(item.call_id, 'Responses completed function call_id');
  if (providerItemId !== lifecycle.providerItemId || callId !== lifecycle.callId) {
    invalid('Responses completed output item identity does not match its added event');
  }
}

function sameWireIdentity(left: ModelWireIdentity, right: ModelWireIdentity): boolean {
  return left.callId === right.callId && left.providerItemId === right.providerItemId;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label);
}

function requiredIndex(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    invalid(`${label} must be a non-negative integer`);
  }
  return value as number;
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

function invalid(message: string): never {
  throw new ModelProtocolError('INVALID_WIRE_RESPONSE', message);
}

export const openAIResponsesCodec = Object.freeze(new OpenAIResponsesCodec());
Object.freeze(OpenAIResponsesCodec.prototype);
