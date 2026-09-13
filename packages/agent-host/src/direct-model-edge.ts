import type { PortableValue } from '@dbagent/shared';
import type {
  CanonicalModelRequest,
  DecodedModelContentBlock,
  LlmChatResponse,
  LlmChatStreamEvent,
  LlmMessage,
  LlmTool,
  ModelAttemptExecution,
  ModelMessage,
  ModelTokenUsage,
} from '@dbagent/core-llm';
import type { LlmRuntimeChatRequest } from './types.js';

/**
 * Internal direct-model calls retain a compact request shape, but the
 * adapter ends at the package edge. Execution and retry always use the
 * canonical Model Session/Gateway contract.
 */
export function directRequestToCanonical(
  request: Pick<LlmRuntimeChatRequest, 'messages' | 'tools'>,
  model: string,
): CanonicalModelRequest {
  return {
    model,
    messages: request.messages.flatMap(messageToCanonical),
    ...(request.tools === undefined
      ? {}
      : { tools: request.tools.map(toolToCanonical) }),
  };
}

export function modelExecutionToDirectResponse(
  execution: ModelAttemptExecution,
): LlmChatResponse {
  const { attempt } = execution;
  return {
    text: attempt.blocks
      .filter((block): block is Extract<DecodedModelContentBlock, { type: 'text' }> =>
        block.type === 'text')
      .map((block) => block.text)
      .join(''),
    toolCalls: attempt.blocks
      .filter((block): block is Extract<DecodedModelContentBlock, { type: 'tool-call-draft' }> =>
        block.type === 'tool-call-draft')
      .map((block) => ({
        id: block.wireIdentity?.callId ?? block.draftCallKey,
        name: block.name,
        arguments: block.arguments as Record<string, unknown>,
      })),
    ...(attempt.usage === undefined ? {} : { usage: usageToDirect(attempt.usage) }),
    ...(attempt.providerResponseId === undefined
      ? {}
      : { providerResponseId: attempt.providerResponseId }),
    ...(attempt.finishReason === undefined ? {} : { finishReason: attempt.finishReason }),
    model: execution.session.route.modelId,
  };
}

export function modelExecutionToDirectStream(
  execution: ModelAttemptExecution,
): readonly LlmChatStreamEvent[] {
  const response = modelExecutionToDirectResponse(execution);
  const events: LlmChatStreamEvent[] = [];
  if (response.text.length > 0) events.push({ type: 'text-delta', text: response.text });
  for (const toolCall of response.toolCalls) events.push({ type: 'tool-call', toolCall });
  if (response.usage !== undefined) events.push({ type: 'usage', usage: response.usage });
  events.push({
    type: 'finish',
    response,
    ...(response.finishReason === undefined ? {} : { reason: response.finishReason }),
  });
  return Object.freeze(events);
}

function messageToCanonical(message: LlmMessage): ModelMessage[] {
  if (message.role === 'tool') {
    if (message.toolCallId === undefined) {
      return [{ role: 'tool', content: [{ type: 'text', text: message.content }] }];
    }
    let output: PortableValue = message.content;
    try {
      output = JSON.parse(message.content) as PortableValue;
    } catch {
      // Plain text is already a portable Tool result.
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
  const content: ModelMessage['content'] = [];
  if (message.content.length > 0) content.push({ type: 'text', text: message.content });
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

function toolToCanonical(tool: LlmTool): NonNullable<CanonicalModelRequest['tools']>[number] {
  return {
    name: tool.name,
    ...(tool.description.length === 0 ? {} : { description: tool.description }),
    inputSchema: tool.inputSchema as PortableValue,
  };
}

function usageToDirect(usage: ModelTokenUsage) {
  return {
    promptTokens: usage.inputTokens,
    completionTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    ...(usage.cachedInputTokens === undefined
      ? {}
      : { cachedPromptTokens: usage.cachedInputTokens }),
  };
}
