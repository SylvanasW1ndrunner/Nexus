import { assertPortableValue, type PortableValue } from '@dbagent/shared';
import type {
  DecodedModelContentBlock,
  ModelMessage,
  ModelOrigin,
  ModelProtocol,
} from './content.js';
import type {
  DecodedModelAttempt,
  ModelFinishReason,
  ModelTokenUsage,
} from './envelope.js';
import type { DecodedModelStreamEvent } from './model-stream.js';

export type CanonicalModelTool = {
  name: string;
  description?: string;
  inputSchema: PortableValue;
};

export type CanonicalModelRequest = {
  model: string;
  messages: ModelMessage[];
  tools?: CanonicalModelTool[];
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  stop?: string[];
};

export type AttemptDecodeContext = {
  attemptId: string;
  origin: ModelOrigin;
};

export interface ModelProtocolCodec<
  TWireRequest = unknown,
  TWireResponse = unknown,
  TWireEvent = unknown,
> {
  readonly protocol: ModelProtocol;
  encode(request: CanonicalModelRequest): TWireRequest;
  decode(response: TWireResponse, context: AttemptDecodeContext): DecodedModelAttempt;
  decodeStream(
    stream: AsyncIterable<TWireEvent>,
    context: AttemptDecodeContext,
  ): AsyncIterable<DecodedModelStreamEvent>;
}

export type ModelProtocolErrorCode =
  | 'INVALID_WIRE_RESPONSE'
  | 'INVALID_TOOL_ARGUMENTS'
  | 'DUPLICATE_WIRE_CALL_ID'
  | 'INCOMPLETE_MODEL_ATTEMPT'
  | 'PROTOCOL_MISMATCH';

export class ModelProtocolError extends Error {
  constructor(
    readonly code: ModelProtocolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ModelProtocolError';
  }
}

export function assertContextProtocol(
  context: AttemptDecodeContext,
  protocol: ModelProtocol,
): void {
  if (context.origin.protocol !== protocol) {
    throw new ModelProtocolError(
      'PROTOCOL_MISMATCH',
      `Expected ${protocol} decode context, received ${context.origin.protocol}`,
    );
  }
}

export function asRecord(value: unknown, label = 'value'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ModelProtocolError('INVALID_WIRE_RESPONSE', `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Record<string, unknown> =>
      typeof item === 'object' && item !== null && !Array.isArray(item),
  );
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function parseToolArguments(value: unknown, label = 'tool arguments'): PortableValue {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new ModelProtocolError('INVALID_TOOL_ARGUMENTS', `${label} contain invalid JSON`);
    }
  }
  if (parsed === undefined) parsed = {};
  try {
    assertPortableValue(parsed);
  } catch {
    throw new ModelProtocolError('INVALID_TOOL_ARGUMENTS', `${label} are not portable JSON`);
  }
  return parsed;
}

export function portableValue(value: unknown, label = 'provider value'): PortableValue {
  try {
    assertPortableValue(value);
  } catch {
    throw new ModelProtocolError('INVALID_WIRE_RESPONSE', `${label} is not portable JSON`);
  }
  return value;
}

export function draftToolCall(
  context: AttemptDecodeContext,
  ordinal: number,
  name: string,
  argumentsValue: unknown,
  wireCallId?: string,
): DecodedModelContentBlock {
  if (name.length === 0) {
    throw new ModelProtocolError('INVALID_WIRE_RESPONSE', 'Tool call name is required');
  }
  return {
    type: 'tool-call-draft',
    draftCallKey: `${context.attemptId}:${ordinal}`,
    ...(wireCallId === undefined ? {} : { wireCallId }),
    name,
    arguments: parseToolArguments(argumentsValue),
  };
}

export function providerOpaqueBlock(
  context: AttemptDecodeContext,
  value: unknown,
): DecodedModelContentBlock {
  return {
    type: 'provider-opaque',
    protocol: context.origin.protocol,
    origin: {
      connectionId: context.origin.connectionId,
      model: context.origin.model,
    },
    replay: 'same-connection-only',
    value: portableValue(value),
  };
}

export function createDecodedAttempt(
  context: AttemptDecodeContext,
  blocks: DecodedModelContentBlock[],
  options: {
    terminal: boolean;
    finishReason?: ModelFinishReason | undefined;
    usage?: ModelTokenUsage | undefined;
    providerResponseId?: string | undefined;
    allowDuplicateWireCallIds?: boolean | undefined;
  },
): DecodedModelAttempt {
  if (options.allowDuplicateWireCallIds !== true) rejectDuplicateWireCallIds(blocks);
  return {
    attemptId: context.attemptId,
    origin: context.origin,
    blocks,
    terminal: options.terminal,
    ...(options.finishReason === undefined ? {} : { finishReason: options.finishReason }),
    ...(options.usage === undefined ? {} : { usage: options.usage }),
    ...(options.providerResponseId === undefined
      ? {}
      : { providerResponseId: options.providerResponseId }),
    opaqueBlockRefs: blocks.flatMap((block, ordinal) =>
      block.type === 'provider-opaque' ? [`${context.attemptId}:opaque:${ordinal}`] : [],
    ),
  };
}

export function rejectDuplicateWireCallIds(blocks: readonly DecodedModelContentBlock[]): void {
  const seen = new Set<string>();
  for (const block of blocks) {
    if (block.type !== 'tool-call-draft' || block.wireCallId === undefined) continue;
    if (seen.has(block.wireCallId)) {
      throw new ModelProtocolError(
        'DUPLICATE_WIRE_CALL_ID',
        `Duplicate completed wire call ID: ${block.wireCallId}`,
      );
    }
    seen.add(block.wireCallId);
  }
}

export function normalizeFinishReason(value: unknown): ModelFinishReason | undefined {
  const reason = stringValue(value);
  if (reason === undefined) return undefined;
  if (['tool_calls', 'function_call', 'tool_use'].includes(reason)) return 'tool-calls';
  if (['stop', 'end_turn', 'stop_sequence', 'completed'].includes(reason)) return 'stop';
  if (['length', 'max_tokens', 'max_output_tokens'].includes(reason)) return 'length';
  if (['content_filter', 'safety'].includes(reason)) return 'content-filter';
  if (['error', 'failed', 'cancelled', 'incomplete'].includes(reason)) return 'error';
  return 'unknown';
}

export function normalizedUsage(
  inputTokens: unknown,
  outputTokens: unknown,
  totalTokens: unknown,
  cachedInputTokens?: unknown,
): ModelTokenUsage | undefined {
  const input = numberValue(inputTokens);
  const output = numberValue(outputTokens);
  if (input === undefined && output === undefined && numberValue(totalTokens) === undefined) {
    return undefined;
  }
  const normalizedInput = input ?? 0;
  const normalizedOutput = output ?? 0;
  const cached = numberValue(cachedInputTokens);
  return {
    inputTokens: normalizedInput,
    outputTokens: normalizedOutput,
    totalTokens: numberValue(totalTokens) ?? normalizedInput + normalizedOutput,
    ...(cached === undefined ? {} : { cachedInputTokens: cached }),
  };
}

export function textFromMessage(message: ModelMessage): string {
  return message.content
    .filter((block) => block.type === 'text' || block.type === 'reasoning-summary')
    .map((block) => block.text)
    .join('');
}
