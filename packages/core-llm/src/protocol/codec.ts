import { assertPortableValue, type PortableValue } from '@dbagent/shared';
import type {
  DecodedModelContentBlock,
  ModelMessage,
  ModelOrigin,
  ModelProtocol,
  ModelWireIdentity,
} from './content.js';
import type {
  DecodedModelAttempt,
  ModelFinishReason,
  ModelProtocolEnvelope,
  ModelTokenUsage,
  ProtocolCorrelation,
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

export type ModelEncodeContext = {
  requestId: string;
  target: ModelOrigin;
  replay:
    | { mode: 'new' }
    | { mode: 'same-connection'; envelope: ModelProtocolEnvelope }
    | { mode: 'compatible-protocol'; envelope: ModelProtocolEnvelope };
};

export type ModelProtocolEncodeResult<TWireRequest> = {
  wireRequest: TWireRequest;
  correlations: ProtocolCorrelation[];
  opaqueBlockRefs: string[];
};

export interface ModelProtocolCodec<
  TWireRequest = unknown,
  TWireResponse = unknown,
  TWireEvent = unknown,
> {
  readonly protocol: ModelProtocol;
  encode(
    request: CanonicalModelRequest,
    context: ModelEncodeContext,
  ): ModelProtocolEncodeResult<TWireRequest>;
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
  | 'PROTOCOL_MISMATCH'
  | 'MISSING_PROTOCOL_CORRELATION'
  | 'UNREPRESENTABLE_CANONICAL_BLOCK'
  | 'OPAQUE_REPLAY_FORBIDDEN';

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

export function records(value: unknown, label = 'array'): Record<string, unknown>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ModelProtocolError('INVALID_WIRE_RESPONSE', `${label} must be an array`);
  }
  return value.map((item, index) => asRecord(item, `${label}[${index}]`));
}

export function requiredRecords(value: unknown, label: string): Record<string, unknown>[] {
  if (value === undefined) {
    throw new ModelProtocolError('INVALID_WIRE_RESPONSE', `${label} is required`);
  }
  return records(value, label);
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function requiredString(value: unknown, label: string): string {
  const result = stringValue(value);
  if (result === undefined || result.length === 0) {
    throw new ModelProtocolError('INVALID_WIRE_RESPONSE', `${label} must be a non-empty string`);
  }
  return result;
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
  wireIdentity?: ModelWireIdentity,
): DecodedModelContentBlock {
  if (name.length === 0) {
    throw new ModelProtocolError('INVALID_WIRE_RESPONSE', 'Tool call name is required');
  }
  return {
    type: 'tool-call-draft',
    draftCallKey: `${context.attemptId}:${ordinal}`,
    ...(wireIdentity === undefined ? {} : { wireIdentity }),
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
  },
): DecodedModelAttempt {
  rejectDuplicateWireIdentities(blocks);
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

export function rejectDuplicateWireIdentities(blocks: readonly DecodedModelContentBlock[]): void {
  const calls = new Map<string, string | undefined>();
  const items = new Set<string>();
  for (const block of blocks) {
    if (block.type !== 'tool-call-draft' || block.wireIdentity === undefined) continue;
    const { callId, providerItemId } = block.wireIdentity;
    if (providerItemId !== undefined && items.has(providerItemId)) {
      throw new ModelProtocolError(
        'DUPLICATE_WIRE_CALL_ID',
        `Duplicate completed provider item ID: ${providerItemId}`,
      );
    }
    if (callId !== undefined && calls.has(callId)) {
      const previousItemId = calls.get(callId);
      if (
        previousItemId === undefined ||
        providerItemId === undefined ||
        previousItemId === providerItemId
      ) {
        throw new ModelProtocolError(
          'DUPLICATE_WIRE_CALL_ID',
          `Duplicate completed wire call ID: ${callId}`,
        );
      }
    }
    if (providerItemId !== undefined) items.add(providerItemId);
    if (callId !== undefined) calls.set(callId, providerItemId);
  }
}

export type ProtocolEncodeSession = {
  identityFor(callId: string, ordinal: number): ModelWireIdentity;
  opaqueValue(block: Extract<DecodedModelContentBlock, { type: 'provider-opaque' }>): PortableValue;
  rejectResource(): never;
  finish<TWireRequest>(wireRequest: TWireRequest): ModelProtocolEncodeResult<TWireRequest>;
};

export function createProtocolEncodeSession(
  context: ModelEncodeContext,
  protocol: ModelProtocol,
): ProtocolEncodeSession {
  if (context.target.protocol !== protocol) {
    throw new ModelProtocolError(
      'PROTOCOL_MISMATCH',
      `Expected ${protocol} encode target, received ${context.target.protocol}`,
    );
  }
  const sourceEnvelope = context.replay.mode === 'new' ? undefined : context.replay.envelope;
  if (
    context.replay.mode === 'same-connection' &&
    (sourceEnvelope?.origin.connectionId !== context.target.connectionId ||
      sourceEnvelope.origin.protocol !== protocol)
  ) {
    throw new ModelProtocolError(
      'PROTOCOL_MISMATCH',
      'Same-connection replay target does not match the protocol envelope origin',
    );
  }
  const correlations: ProtocolCorrelation[] = [];
  const resolved = new Map<string, ModelWireIdentity>();
  return {
    identityFor(callId, ordinal) {
      const cached = resolved.get(callId);
      if (cached !== undefined) return cached;
      const source = sourceEnvelope?.correlations.find(
        (correlation) => correlation.callId === callId,
      );
      let wireIdentity: ModelWireIdentity;
      if (context.replay.mode === 'same-connection') {
        if (source?.wireIdentity === undefined) {
          throw new ModelProtocolError(
            'MISSING_PROTOCOL_CORRELATION',
            `No replayable wire identity exists for canonical call ${callId}`,
          );
        }
        wireIdentity = source.wireIdentity;
      } else {
        wireIdentity = generatedWireIdentity(protocol, context.requestId, correlations.length);
      }
      resolved.set(callId, wireIdentity);
      correlations.push({
        callId,
        draftCallKey: source?.draftCallKey ?? `${context.requestId}:${ordinal}`,
        wireIdentity,
        replay:
          context.replay.mode === 'same-connection'
            ? (source?.replay ?? 'same-connection-only')
            : 'compatible-protocol',
      });
      return wireIdentity;
    },
    opaqueValue(block) {
      const exactOrigin =
        block.protocol === protocol &&
        block.origin.connectionId === context.target.connectionId &&
        block.origin.model === context.target.model;
      const compatible =
        context.replay.mode === 'compatible-protocol' &&
        block.replay === 'compatible-protocol' &&
        block.protocol === protocol;
      if (context.replay.mode !== 'same-connection' && !compatible) {
        throw new ModelProtocolError(
          'OPAQUE_REPLAY_FORBIDDEN',
          'Provider-opaque content cannot be replayed outside its declared scope',
        );
      }
      if (!exactOrigin && !compatible) {
        throw new ModelProtocolError(
          'OPAQUE_REPLAY_FORBIDDEN',
          'Provider-opaque content origin does not match the encode target',
        );
      }
      return block.value;
    },
    rejectResource() {
      throw new ModelProtocolError(
        'UNREPRESENTABLE_CANONICAL_BLOCK',
        'resource-ref requires an explicit artifact-to-wire projection',
      );
    },
    finish(wireRequest) {
      return {
        wireRequest,
        correlations,
        opaqueBlockRefs: sourceEnvelope?.opaqueBlockRefs ?? [],
      };
    },
  };
}

function generatedWireIdentity(
  protocol: ModelProtocol,
  requestId: string,
  ordinal: number,
): ModelWireIdentity {
  return protocol === 'openai-responses'
    ? {
        callId: `${requestId}:call:${ordinal}`,
        providerItemId: `${requestId}:item:${ordinal}`,
      }
    : { callId: `${requestId}:call:${ordinal}` };
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
