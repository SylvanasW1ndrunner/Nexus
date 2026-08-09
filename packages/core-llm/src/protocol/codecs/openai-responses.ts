import type { ModelMessage } from '../content.js';
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
  ModelProtocolError,
  type AttemptDecodeContext,
  type CanonicalModelRequest,
  type ModelProtocolCodec,
} from '../codec.js';
import type { DecodedModelContentBlock } from '../content.js';
import type { DecodedModelStreamEvent } from '../model-stream.js';

export class OpenAIResponsesCodec implements ModelProtocolCodec {
  readonly protocol = 'openai-responses' as const;

  encode(request: CanonicalModelRequest): unknown {
    return {
      model: request.model,
      input: request.messages.flatMap(encodeInputMessage),
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
    };
  }

  decode(response: unknown, context: AttemptDecodeContext) {
    assertContextProtocol(context, this.protocol);
    const root = asRecord(response, 'OpenAI Responses response');
    const blocks: DecodedModelContentBlock[] = [];
    const responseCallIds = new Map<string, string | undefined>();
    for (const item of records(root.output)) {
      const type = stringValue(item.type);
      if (type === 'message') {
        for (const part of records(item.content)) {
          if (part.type === 'output_text' && typeof part.text === 'string') {
            blocks.push({ type: 'text', text: part.text });
          } else {
            blocks.push(providerOpaqueBlock(context, part));
          }
        }
        continue;
      }
      if (type === 'reasoning') {
        for (const summary of records(item.summary)) {
          if (summary.type === 'summary_text' && typeof summary.text === 'string') {
            blocks.push({ type: 'reasoning-summary', text: summary.text });
          }
        }
        blocks.push(providerOpaqueBlock(context, item));
        continue;
      }
      if (type === 'function_call') {
        const wireCallId = stringValue(item.call_id);
        const itemId = stringValue(item.id);
        if (wireCallId !== undefined) {
          const previousItemId = responseCallIds.get(wireCallId);
          if (
            responseCallIds.has(wireCallId) &&
            (itemId === undefined || previousItemId === undefined || itemId === previousItemId)
          ) {
            throw new ModelProtocolError(
              'DUPLICATE_WIRE_CALL_ID',
              `Duplicate completed wire call ID: ${wireCallId}`,
            );
          }
          responseCallIds.set(wireCallId, itemId);
        }
        blocks.push(
          draftToolCall(
            context,
            blocks.length,
            stringValue(item.name) ?? '',
            item.arguments,
            wireCallId ?? itemId,
          ),
        );
        continue;
      }
      blocks.push(providerOpaqueBlock(context, item));
    }
    const usage = root.usage === undefined ? undefined : asRecord(root.usage, 'Responses usage');
    const details =
      usage?.input_tokens_details === undefined
        ? undefined
        : asRecord(usage.input_tokens_details, 'Responses input token details');
    const status = stringValue(root.status);
    const finishReason = normalizeFinishReason(
      status === 'completed' ? 'completed' : root.incomplete_details === undefined ? status : 'incomplete',
    );
    return createDecodedAttempt(context, blocks, {
      allowDuplicateWireCallIds: true,
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
    let completedResponse: unknown;
    const outputItems = new Map<number, Record<string, unknown>>();
    let responseId: string | undefined;
    let model = context.origin.model;
    let usage: Record<string, unknown> | undefined;
    let status = 'in_progress';

    for await (const eventValue of stream) {
      const event = asRecord(eventValue, 'OpenAI Responses stream event');
      const type = stringValue(event.type);
      if (type === 'response.completed' || type === 'response.failed' || type === 'response.incomplete') {
        completedResponse = event.response;
        status = type === 'response.completed' ? 'completed' : 'failed';
        continue;
      }
      const response =
        event.response === undefined ? undefined : asRecord(event.response, 'Responses stream response');
      responseId ??= stringValue(response?.id) ?? stringValue(event.response_id);
      model = stringValue(response?.model) ?? model;
      if (response?.usage !== undefined) usage = asRecord(response.usage);
      const outputIndex = typeof event.output_index === 'number' ? event.output_index : outputItems.size;
      if (type === 'response.output_item.added' || type === 'response.output_item.done') {
        outputItems.set(outputIndex, asRecord(event.item, 'Responses output item'));
      } else if (type === 'response.output_text.delta') {
        const item = outputItems.get(outputIndex) ?? {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '' }],
        };
        const content = records(item.content);
        const part = content[0] ?? { type: 'output_text', text: '' };
        const delta = stringValue(event.delta) ?? '';
        part.text = `${stringValue(part.text) ?? ''}${delta}`;
        item.content = content.length === 0 ? [part] : content;
        outputItems.set(outputIndex, item);
        yield { type: 'text-delta', blockOrdinal: outputIndex, text: delta };
      } else if (type === 'response.function_call_arguments.delta') {
        const item = outputItems.get(outputIndex) ?? { type: 'function_call' };
        const delta = stringValue(event.delta) ?? '';
        item.arguments = `${stringValue(item.arguments) ?? ''}${delta}`;
        outputItems.set(outputIndex, item);
        yield {
          type: 'tool-call-delta',
          blockOrdinal: outputIndex,
          draftCallKey: `${context.attemptId}:${outputIndex}`,
          ...(stringValue(item.call_id) === undefined
            ? {}
            : { wireCallId: stringValue(item.call_id) }),
          ...(stringValue(item.name) === undefined ? {} : { name: stringValue(item.name) }),
          argumentsDelta: delta,
        };
      }
    }

    const response =
      completedResponse ?? {
        id: responseId,
        model,
        status,
        output: [...outputItems.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, item]) => item),
        usage,
      };
    const attempt = this.decode(response, context);
    if (attempt.usage !== undefined) yield { type: 'usage', usage: attempt.usage };
    yield { type: 'finish', attempt };
  }
}

function encodeInputMessage(message: ModelMessage): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = [];
  for (const block of message.content) {
    if (block.type === 'tool-call') {
      output.push({
        type: 'function_call',
        call_id: block.callId,
        name: block.name,
        arguments: JSON.stringify(block.arguments),
      });
    } else if (block.type === 'tool-result') {
      output.push({
        type: 'function_call_output',
        call_id: block.callId,
        output: JSON.stringify(block.output),
      });
    }
  }
  const text = message.content
    .filter((block) => block.type === 'text' || block.type === 'reasoning-summary')
    .map((block) => block.text)
    .join('');
  if (text.length > 0 || output.length === 0) {
    output.unshift({
      role: message.role === 'tool' ? 'user' : message.role,
      content: text,
    });
  }
  return output;
}

export const openAIResponsesCodec = new OpenAIResponsesCodec();
