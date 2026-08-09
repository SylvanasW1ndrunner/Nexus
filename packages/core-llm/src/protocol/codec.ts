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
    | { mode: 'same-connection'; envelopes: readonly ModelProtocolEnvelope[] }
    | { mode: 'compatible-protocol'; envelopes: readonly ModelProtocolEnvelope[] };
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
  opaqueRef: string,
): DecodedModelContentBlock {
  return {
    type: 'provider-opaque',
    opaqueRef,
    protocol: context.origin.protocol,
    origin: {
      connectionId: context.origin.connectionId,
      model: context.origin.model,
    },
    replay: 'same-connection-only',
    value: portableValue(value),
  };
}

export function opaqueBlockRef(context: AttemptDecodeContext, key: number | string): string {
  return `${context.attemptId}:opaque:${key}`;
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
    opaqueBlockRefs: blocks.flatMap((block) =>
      block.type === 'provider-opaque' ? [block.opaqueRef] : [],
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
  identityFor(callId: string): ModelWireIdentity;
  shouldProjectReasoningSummary(
    block: Extract<DecodedModelContentBlock, { type: 'reasoning-summary' }>,
  ): boolean;
  opaqueValue(
    block: Extract<DecodedModelContentBlock, { type: 'provider-opaque' }>,
  ): PortableValue | undefined;
  rejectResource(): never;
  finish<TWireRequest>(wireRequest: TWireRequest): ModelProtocolEncodeResult<TWireRequest>;
};

export function createProtocolEncodeSession(
  context: ModelEncodeContext,
  protocol: ModelProtocol,
  request: CanonicalModelRequest,
): ProtocolEncodeSession {
  if (context.target.protocol !== protocol) {
    throw new ModelProtocolError(
      'PROTOCOL_MISMATCH',
      `Expected ${protocol} encode target, received ${context.target.protocol}`,
    );
  }
  const sourceEnvelopes = context.replay.mode === 'new' ? [] : context.replay.envelopes;
  const correlationIndex = new Map<
    string,
    { correlation: ProtocolCorrelation; envelope: ModelProtocolEnvelope }
  >();
  const opaqueIndex = new Map<string, ModelProtocolEnvelope>();
  for (const envelope of sourceEnvelopes) {
    for (const correlation of envelope.correlations) {
      if (correlationIndex.has(correlation.callId)) {
        throw new ModelProtocolError(
          'MISSING_PROTOCOL_CORRELATION',
          `Multiple replay envelopes contain canonical call ${correlation.callId}`,
        );
      }
      correlationIndex.set(correlation.callId, { correlation, envelope });
    }
    for (const opaqueRef of envelope.opaqueBlockRefs) {
      if (opaqueIndex.has(opaqueRef)) {
        throw new ModelProtocolError(
          'OPAQUE_REPLAY_FORBIDDEN',
          `Multiple replay envelopes contain opaque ref ${opaqueRef}`,
        );
      }
      opaqueIndex.set(opaqueRef, envelope);
    }
  }
  const correlations: ProtocolCorrelation[] = [];
  const resolved = new Map<string, ModelWireIdentity>();
  const consumedOpaqueRefs: string[] = [];
  const projectedOpaqueRefs = new Set<string>();
  const requestedOpaqueBlocks = new Map<
    string,
    Extract<DecodedModelContentBlock, { type: 'provider-opaque' }>
  >();
  for (const message of request.messages) {
    for (const block of message.content) {
      if (block.type !== 'provider-opaque') continue;
      if (requestedOpaqueBlocks.has(block.opaqueRef)) {
        throw new ModelProtocolError(
          'OPAQUE_REPLAY_FORBIDDEN',
          `Canonical request repeats opaque ref ${block.opaqueRef}`,
        );
      }
      requestedOpaqueBlocks.set(block.opaqueRef, block);
    }
  }
  const envelopeOwnsOpaque = (
    block: Extract<DecodedModelContentBlock, { type: 'provider-opaque' }>,
    sourceEnvelope: ModelProtocolEnvelope,
  ): boolean =>
      sourceEnvelope.origin.connectionId === block.origin.connectionId &&
      sourceEnvelope.origin.model === block.origin.model &&
      sourceEnvelope.origin.protocol === block.protocol;
  const replayableOpaque = (
    block: Extract<DecodedModelContentBlock, { type: 'provider-opaque' }>,
    sourceEnvelope: ModelProtocolEnvelope,
  ): boolean => {
    if (!envelopeOwnsOpaque(block, sourceEnvelope)) return false;
    const exactOrigin =
      context.replay.mode === 'same-connection' &&
      block.protocol === protocol &&
      block.origin.connectionId === context.target.connectionId &&
      block.origin.model === context.target.model &&
      sourceEnvelope.origin.connectionId === context.target.connectionId &&
      sourceEnvelope.origin.protocol === protocol;
    const compatible =
      context.replay.mode === 'compatible-protocol' &&
      block.replay === 'compatible-protocol' &&
      block.protocol === protocol;
    return exactOrigin || compatible;
  };
  for (const message of request.messages) {
    for (const block of message.content) {
      if (block.type !== 'reasoning-summary' || block.derivedFromOpaqueRef === undefined) continue;
      const opaque = requestedOpaqueBlocks.get(block.derivedFromOpaqueRef);
      const sourceEnvelope = opaqueIndex.get(block.derivedFromOpaqueRef);
      if (
        opaque !== undefined &&
        sourceEnvelope !== undefined &&
        !replayableOpaque(opaque, sourceEnvelope)
      ) {
        projectedOpaqueRefs.add(block.derivedFromOpaqueRef);
      }
    }
  }
  return {
    identityFor(callId) {
      const cached = resolved.get(callId);
      if (cached !== undefined) return cached;
      const indexed = correlationIndex.get(callId);
      const source = indexed?.correlation;
      if (context.replay.mode !== 'new' && indexed === undefined) {
        throw new ModelProtocolError(
          'MISSING_PROTOCOL_CORRELATION',
          `No replay envelope contains canonical call ${callId}`,
        );
      }
      let wireIdentity: ModelWireIdentity;
      if (context.replay.mode === 'same-connection') {
        if (
          indexed?.envelope.origin.connectionId !== context.target.connectionId ||
          indexed.envelope.origin.protocol !== protocol
        ) {
          throw new ModelProtocolError(
            'PROTOCOL_MISMATCH',
            `Replay envelope for canonical call ${callId} does not match the encode target`,
          );
        }
        wireIdentity = source?.wireIdentity ?? generatedWireIdentity(
          protocol,
          context.requestId,
          correlations.length,
        );
      } else {
        wireIdentity = generatedWireIdentity(protocol, context.requestId, correlations.length);
      }
      resolved.set(callId, wireIdentity);
      correlations.push({
        callId,
        draftCallKey: source?.draftCallKey ?? `${context.requestId}:${correlations.length}`,
        wireIdentity,
        replay:
          context.replay.mode === 'same-connection'
            ? (source?.replay ?? 'same-connection-only')
            : 'compatible-protocol',
      });
      return wireIdentity;
    },
    shouldProjectReasoningSummary(block) {
      if (block.derivedFromOpaqueRef === undefined) return true;
      if (projectedOpaqueRefs.has(block.derivedFromOpaqueRef)) return true;
      const opaque = requestedOpaqueBlocks.get(block.derivedFromOpaqueRef);
      const sourceEnvelope = opaqueIndex.get(block.derivedFromOpaqueRef);
      if (
        opaque !== undefined &&
        sourceEnvelope !== undefined &&
        replayableOpaque(opaque, sourceEnvelope)
      ) {
        return false;
      }
      projectedOpaqueRefs.add(block.derivedFromOpaqueRef);
      return true;
    },
    opaqueValue(block) {
      const sourceEnvelope = opaqueIndex.get(block.opaqueRef);
      if (sourceEnvelope === undefined) {
        throw new ModelProtocolError(
          'OPAQUE_REPLAY_FORBIDDEN',
          `No replay envelope contains opaque ref ${block.opaqueRef}`,
        );
      }
      if (!envelopeOwnsOpaque(block, sourceEnvelope)) {
        throw new ModelProtocolError(
          'OPAQUE_REPLAY_FORBIDDEN',
          `Replay envelope origin does not own opaque ref ${block.opaqueRef}`,
        );
      }
      if (projectedOpaqueRefs.has(block.opaqueRef)) return undefined;
      if (!replayableOpaque(block, sourceEnvelope)) {
        throw new ModelProtocolError(
          'OPAQUE_REPLAY_FORBIDDEN',
          'Provider-opaque content cannot be replayed on the encode target',
        );
      }
      consumedOpaqueRefs.push(block.opaqueRef);
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
        opaqueBlockRefs: consumedOpaqueRefs,
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
