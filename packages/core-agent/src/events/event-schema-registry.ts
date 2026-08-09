import { assertNoSecretMaterial, assertPortableValue } from '@dbagent/shared';
import type { AgentEventPayloadMap, AgentEventType } from './agent-event.js';

export type AgentEventAudience = 'internal' | 'model' | 'user' | 'audit';
export type AgentEventPersistence = 'durable' | 'diagnostic';

export type AgentEventSchemaDescriptor<T extends AgentEventType> = {
  readonly schemaVersion: 1;
  readonly audience: readonly AgentEventAudience[];
  readonly persistence: AgentEventPersistence;
  validate(payload: unknown): void;
  redact(payload: AgentEventPayloadMap[T]): AgentEventPayloadMap[T];
};

type AgentEventSchemaRegistry = {
  readonly [T in AgentEventType]: AgentEventSchemaDescriptor<T>;
};

const INTERNAL = ['internal', 'audit'] as const;
const MODEL = ['internal', 'model', 'audit'] as const;
const USER = ['internal', 'user', 'audit'] as const;

function descriptor<T extends AgentEventType>(options?: {
  audience?: readonly AgentEventAudience[];
  persistence?: AgentEventPersistence;
  maxPayloadBytes?: number;
  validate?: (payload: unknown) => void;
}): AgentEventSchemaDescriptor<T> {
  return Object.freeze({
    schemaVersion: 1,
    audience: Object.freeze([...(options?.audience ?? INTERNAL)]),
    persistence: options?.persistence ?? 'durable',
    validate(payload: unknown): void {
      assertPortableValue(payload);
      assertNoSecretMaterial(payload);
      assertJournalPayloadSafety(payload, options?.maxPayloadBytes ?? 256 * 1024);
      options?.validate?.(payload);
    },
    redact(payload: AgentEventPayloadMap[T]): AgentEventPayloadMap[T] {
      return structuredClone(payload);
    },
  });
}

function assertJournalPayloadSafety(payload: unknown, maxPayloadBytes: number): void {
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > maxPayloadBytes) {
    throw new TypeError(`Event payload exceeds the ${maxPayloadBytes} byte journal limit.`);
  }
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      const normalized = key.replaceAll(/[-_]/gu, '').toLowerCase();
      if (
        normalized.endsWith('password') || normalized.endsWith('authorization') ||
        normalized.endsWith('credential') || normalized.endsWith('apikey') ||
        normalized.endsWith('token') || normalized.endsWith('secret') ||
        normalized.endsWith('privatekey')
      ) {
        throw new TypeError(`Credential-bearing journal field ${key} is forbidden.`);
      }
      visit(item);
    }
  };
  visit(payload);
}

function requireRecord(payload: unknown): Record<string, unknown> {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('Event payload must be an object.');
  }
  return payload as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string): void {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`Event payload ${key} must be a non-empty string.`);
  }
}

function requireBoundedString(record: Record<string, unknown>, key: string, maximum = 4_096): void {
  requireString(record, key);
  if ((record[key] as string).length > maximum) {
    throw new TypeError(`Event payload ${key} exceeds ${maximum} characters.`);
  }
}

function optionalString(record: Record<string, unknown>, key: string): void {
  if (Object.hasOwn(record, key)) requireString(record, key);
}

function optionalNonNegativeInteger(record: Record<string, unknown>, key: string): void {
  if (Object.hasOwn(record, key)) requireNonNegativeInteger(record, key);
}

function requirePresent(record: Record<string, unknown>, key: string): void {
  if (!Object.hasOwn(record, key)) throw new TypeError(`Event payload ${key} is required.`);
}

function requireLiteral(record: Record<string, unknown>, key: string, value: unknown): void {
  if (record[key] !== value) throw new TypeError(`Event payload ${key} must be ${String(value)}.`);
}

function requireEnum(record: Record<string, unknown>, key: string, values: readonly string[]): void {
  if (typeof record[key] !== 'string' || !values.includes(record[key])) {
    throw new TypeError(`Event payload ${key} must be one of ${values.join(', ')}.`);
  }
}

function requireNonNegativeInteger(record: Record<string, unknown>, key: string): void {
  if (!Number.isSafeInteger(record[key]) || Number(record[key]) < 0) {
    throw new TypeError(`Event payload ${key} must be a non-negative integer.`);
  }
}

function requireStringArray(record: Record<string, unknown>, key: string): void {
  const value = record[key];
  if (!Array.isArray(value) || value.length > 256) {
    throw new TypeError(`Event payload ${key} must be a string array with at most 256 refs.`);
  }
  value.forEach((item, index) => {
    if (typeof item !== 'string' || item.length === 0 || item.length > 2_048) {
      throw new TypeError(`Event payload ${key}[${index}] must be a bounded non-empty string.`);
    }
  });
}

function validateShape(
  payload: unknown,
  keys: readonly string[],
  requiredStrings: readonly string[] = [],
  requiredArrays: readonly string[] = [],
  requiredNumbers: readonly string[] = [],
): void {
  const record = requireRecord(payload);
  exactKeys(record, keys);
  requiredStrings.forEach((key) => requireString(record, key));
  requiredArrays.forEach((key) => requireStringArray(record, key));
  requiredNumbers.forEach((key) => requireNonNegativeInteger(record, key));
  if (Object.hasOwn(record, 'summary')) requireBoundedString(record, 'summary');
}

function validateInput(payload: unknown): void {
  const record = requireRecord(payload);
  exactKeys(record, ['clientRequestId', 'content', 'steeringTarget']);
  requireString(record, 'clientRequestId');
  if (!Object.hasOwn(record, 'content')) throw new TypeError('Event payload content is required.');
  if (record.steeringTarget !== undefined) {
    const target = requireRecord(record.steeringTarget);
    exactKeys(target, ['runId']);
    requireString(target, 'runId');
  }
}

function validateRunCreated(payload: unknown): void {
  const record = requireRecord(payload);
  exactKeys(record, ['clientRequestId']);
  requireString(record, 'clientRequestId');
}

function validateRunFailure(payload: unknown): void {
  const record = requireRecord(payload);
  exactKeys(record, ['code', 'detail']);
  requireString(record, 'code');
}

function validateRunSteered(payload: unknown): void {
  const record = requireRecord(payload);
  exactKeys(record, ['clientRequestId', 'content']);
  requireString(record, 'clientRequestId');
  requirePresent(record, 'content');
}

function validateRunResumed(payload: unknown): void {
  const record = requireRecord(payload);
  exactKeys(record, ['reason']);
  optionalString(record, 'reason');
}

function validateRunInputRequested(payload: unknown): void {
  const record = requireRecord(payload);
  exactKeys(record, ['reason', 'connectionId']);
  requireString(record, 'reason');
  optionalString(record, 'connectionId');
}

function validateOptionalReason(payload: unknown): void {
  const record = requireRecord(payload);
  exactKeys(record, ['reason']);
  optionalString(record, 'reason');
}

function validateRunLimitReached(payload: unknown): void {
  const record = requireRecord(payload);
  exactKeys(record, ['limit', 'value']);
  requireString(record, 'limit');
  optionalNonNegativeInteger(record, 'value');
}

function validateTurnStarted(payload: unknown): void {
  const record = requireRecord(payload);
  exactKeys(record, ['turnSnapshotId']);
  optionalString(record, 'turnSnapshotId');
}

function validateTurnContextCompiled(payload: unknown): void {
  const record = requireRecord(payload);
  exactKeys(record, ['contextRef', 'tokenEstimate']);
  optionalString(record, 'contextRef');
  optionalNonNegativeInteger(record, 'tokenEstimate');
}

function validateOriginPayload(payload: unknown): void {
  const record = requireRecord(payload);
  exactKeys(record, ['origin']);
  const origin = requireRecord(record.origin);
  exactKeys(origin, ['connectionId', 'model', 'protocol']);
  requireString(origin, 'connectionId');
  requireString(origin, 'model');
  requireEnum(origin, 'protocol', [
    'openai-chat', 'openai-responses', 'anthropic-messages', 'ollama-chat', 'legacy-normalized',
  ]);
}

function validateModelDeltaBatch(payload: unknown): void {
  const record = requireRecord(payload);
  exactKeys(record, ['blocks']);
  if (!Array.isArray(record.blocks)) throw new TypeError('Model delta blocks must be an array.');
  record.blocks.forEach((block) => assertPortableValue(block));
}

function validateModelBlockCompleted(payload: unknown): void {
  const record = requireRecord(payload);
  exactKeys(record, ['draftCallKey', 'block']);
  optionalString(record, 'draftCallKey');
  if (!Object.hasOwn(record, 'block')) throw new TypeError('Completed model block is required.');
}

function validateModelFailure(payload: unknown): void {
  const record = requireRecord(payload);
  exactKeys(record, ['code', 'retryable', 'detail']);
  requireString(record, 'code');
  if (typeof record.retryable !== 'boolean') {
    throw new TypeError('Event payload retryable must be a boolean.');
  }
}

function validateRunCompleted(payload: unknown): void {
  const record = requireRecord(payload);
  exactKeys(record, ['finalContentRef', 'deliveryStatus', 'evidenceRefs']);
  requireString(record, 'finalContentRef');
  requireEnum(record, 'deliveryStatus', ['delivered', 'pending', 'failed']);
  requireStringArray(record, 'evidenceRefs');
}

function validateUsageRecorded(payload: unknown): void {
  const record = requireRecord(payload);
  exactKeys(record, ['scope', 'inputTokens', 'outputTokens', 'totalTokens']);
  requireEnum(record, 'scope', ['run', 'turn', 'attempt', 'tool']);
  ['inputTokens', 'outputTokens', 'totalTokens'].forEach((key) =>
    requireNonNegativeInteger(record, key));
}

function validateCommittedAttempt(payload: unknown): void {
  const record = requireRecord(payload);
  exactKeys(record, ['validatedAttempt', 'turn', 'protocolEnvelope']);
  validatePersistedAttempt(record.validatedAttempt);
  const turn = requireRecord(record.turn);
  exactKeys(turn, ['protocolEnvelopeRef']);
  requireString(turn, 'protocolEnvelopeRef');
  const envelope = requireRecord(record.protocolEnvelope);
  exactKeys(envelope, ['schemaVersion', 'correlations']);
  requireLiteral(envelope, 'schemaVersion', 1);
  if (!Array.isArray(envelope.correlations)) {
    throw new TypeError('Protocol Envelope correlations must be an array.');
  }
  envelope.correlations.forEach(validateCorrelation);
}

export function validatePersistedAttempt(value: unknown): void {
  const attempt = requireRecord(value);
  exactKeys(attempt, [
    'attemptId', 'origin', 'blocks', 'terminal', 'validation', 'finishReason', 'usage',
    'providerResponseId', 'opaqueBlockRefs',
  ]);
  requireString(attempt, 'attemptId');
  requireLiteral(attempt, 'terminal', true);
  requireLiteral(attempt, 'validation', 'validated');
  optionalString(attempt, 'providerResponseId');
  const origin = requireRecord(attempt.origin);
  exactKeys(origin, ['connectionId', 'model', 'protocol']);
  requireString(origin, 'connectionId');
  requireString(origin, 'model');
  requireEnum(origin, 'protocol', [
    'openai-chat', 'openai-responses', 'anthropic-messages', 'ollama-chat', 'legacy-normalized',
  ]);
  if (!Array.isArray(attempt.blocks)) throw new TypeError('Validated attempt blocks must be an array.');
  attempt.blocks.forEach(validateDecodedBlock);
  requireStringArray(attempt, 'opaqueBlockRefs');
  if (attempt.finishReason !== undefined) {
    requireEnum(attempt, 'finishReason', [
      'stop', 'tool-calls', 'length', 'content-filter', 'error', 'unknown',
    ]);
  }
  if (attempt.usage !== undefined) validateUsage(attempt.usage);
}

function validateUsage(value: unknown): void {
  const usage = requireRecord(value);
  exactKeys(usage, ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens']);
  ['inputTokens', 'outputTokens', 'totalTokens'].forEach((key) =>
    requireNonNegativeInteger(usage, key));
  if (usage.cachedInputTokens !== undefined) requireNonNegativeInteger(usage, 'cachedInputTokens');
}

function validateDecodedBlock(value: unknown): void {
  const block = requireRecord(value);
  requireString(block, 'type');
  switch (block.type) {
    case 'text':
      exactKeys(block, ['type', 'text']); requireString(block, 'text'); return;
    case 'resource-ref':
      exactKeys(block, ['type', 'artifactId', 'mediaType', 'purpose']);
      requireString(block, 'artifactId'); requireString(block, 'mediaType');
      requireEnum(block, 'purpose', ['input', 'output']); return;
    case 'reasoning-summary':
      exactKeys(block, ['type', 'text', 'derivedFromOpaqueRef']);
      requireString(block, 'text'); optionalString(block, 'derivedFromOpaqueRef'); return;
    case 'provider-opaque': {
      exactKeys(block, ['type', 'opaqueRef', 'protocol', 'origin', 'replay', 'value']);
      requireString(block, 'opaqueRef'); requireString(block, 'protocol');
      requireEnum(block, 'replay', ['same-connection-only', 'compatible-protocol']);
      const origin = requireRecord(block.origin);
      exactKeys(origin, ['connectionId', 'model']);
      requireString(origin, 'connectionId'); requireString(origin, 'model');
      if (!Object.hasOwn(block, 'value')) throw new TypeError('Provider opaque value is required.');
      return;
    }
    case 'tool-call-draft':
      exactKeys(block, ['type', 'draftCallKey', 'wireIdentity', 'name', 'arguments']);
      requireString(block, 'draftCallKey'); requireString(block, 'name');
      if (!Object.hasOwn(block, 'arguments')) throw new TypeError('Tool arguments are required.');
      if (block.wireIdentity !== undefined) validateWireIdentity(block.wireIdentity);
      return;
    default:
      throw new TypeError(`Unknown validated attempt block type: ${String(block.type)}.`);
  }
}

function validateWireIdentity(value: unknown): void {
  const identity = requireRecord(value);
  exactKeys(identity, ['callId', 'providerItemId']);
  optionalString(identity, 'callId'); optionalString(identity, 'providerItemId');
  if (identity.callId === undefined && identity.providerItemId === undefined) {
    throw new TypeError('wireIdentity requires callId or providerItemId.');
  }
}

function validateCorrelation(value: unknown): void {
  const correlation = requireRecord(value);
  exactKeys(correlation, ['callId', 'draftCallKey', 'wireIdentity', 'replay']);
  requireString(correlation, 'callId'); requireString(correlation, 'draftCallKey');
  requireEnum(correlation, 'replay', ['same-connection-only', 'compatible-protocol']);
  if (correlation.wireIdentity !== undefined) validateWireIdentity(correlation.wireIdentity);
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new TypeError(`Unknown event payload keys: ${unknown.sort().join(', ')}.`);
}

function validateToolProposed(payload: unknown): void {
  const record = requireRecord(payload);
  exactKeys(record, ['invocationId', 'callId', 'actionOrdinal', 'name', 'arguments']);
  requireString(record, 'invocationId');
  requireString(record, 'callId');
  requireString(record, 'name');
  if (!Number.isInteger(record.actionOrdinal) || Number(record.actionOrdinal) < 0) {
    throw new TypeError('Tool actionOrdinal must be a non-negative integer.');
  }
  if (!Object.hasOwn(record, 'arguments')) throw new TypeError('Tool arguments are required.');
}

function validateToolTerminal(payload: unknown): void {
  validateShape(
    payload,
    ['summary', 'resultRefs'],
    ['summary'],
    ['resultRefs'],
  );
}

export const AGENT_EVENT_SCHEMA_REGISTRY = Object.freeze({
  'input.received': descriptor({ audience: USER, validate: validateInput }),
  'run.created': descriptor({ validate: validateRunCreated }),
  'run.started': descriptor({ validate: (p) => validateShape(p, []) }),
  'run.resumed': descriptor({ validate: validateRunResumed }),
  'run.steered': descriptor({ audience: USER, validate: validateRunSteered }),
  'run.input_requested': descriptor({ audience: USER, validate: validateRunInputRequested }),
  'run.cancel_requested': descriptor({ validate: validateOptionalReason }),
  'run.limit_reached': descriptor({ audience: USER, validate: validateRunLimitReached }),
  'run.completed': descriptor({ audience: USER, validate: validateRunCompleted }),
  'run.failed': descriptor({ audience: USER, validate: validateRunFailure }),
  'run.cancelled': descriptor({ audience: USER, validate: validateOptionalReason }),
  'run.interrupted': descriptor({ audience: USER, validate: validateRunFailure }),
  'turn.started': descriptor({ validate: validateTurnStarted }),
  'turn.context_compiled': descriptor({ validate: validateTurnContextCompiled }),
  'turn.no_progress': descriptor({ audience: MODEL, validate: (p) => validateShape(p, ['fingerprint'], ['fingerprint']) }),
  model_attempt_started: descriptor({ validate: validateOriginPayload }),
  model_delta_batch: descriptor({ persistence: 'diagnostic', validate: validateModelDeltaBatch }),
  model_block_completed: descriptor({ persistence: 'diagnostic', validate: validateModelBlockCompleted }),
  model_attempt_committed: descriptor({
    audience: MODEL,
    maxPayloadBytes: 16 * 1024 * 1024,
    validate: validateCommittedAttempt,
  }),
  model_attempt_discarded: descriptor({ persistence: 'diagnostic', validate: (p) => validateShape(p, ['reason'], ['reason']) }),
  model_failed: descriptor({ persistence: 'diagnostic', validate: validateModelFailure }),
  'turn.closed': descriptor({ validate: (p) => validateShape(p, ['reason'], ['reason']) }),
  'tool.proposed': descriptor({ audience: MODEL, validate: validateToolProposed }),
  'tool.validated': descriptor({ validate: (p) => validateShape(p, ['toolRevision', 'normalizedArgumentsDigest'], ['toolRevision', 'normalizedArgumentsDigest']) }),
  'tool.approval_requested': descriptor({ audience: USER, validate: (p) => validateShape(p, ['approvalId', 'invocationId', 'summary'], ['approvalId', 'invocationId', 'summary']) }),
  'tool.authorized': descriptor({ validate: (p) => validateShape(p, ['approvalId', 'invocationId'], ['approvalId', 'invocationId']) }),
  'tool.denied': descriptor({ audience: MODEL, validate: (p) => validateShape(p, ['approvalId', 'invocationId', 'reason'], ['approvalId', 'invocationId', 'reason']) }),
  'tool.started': descriptor({ validate: (p) => validateShape(p, ['invocationId'], ['invocationId']) }),
  'tool.progress': descriptor({ audience: USER, persistence: 'diagnostic', validate: (p) => validateShape(p, ['invocationId', 'summary'], ['invocationId', 'summary']) }),
  'tool.succeeded': descriptor({ validate: validateToolTerminal }),
  'tool.failed': descriptor({ validate: validateToolTerminal }),
  'tool.cancelled': descriptor({ validate: validateToolTerminal }),
  'tool.outcome_unknown': descriptor({ audience: MODEL, validate: validateToolTerminal }),
  'tool.outcome_resolution_requested': descriptor({ audience: USER, validate: (p) => validateShape(p, ['invocationId', 'summary'], ['invocationId', 'summary']) }),
  'tool.outcome_resolved': descriptor({ audience: MODEL, validate: validateToolTerminal }),
  'tool.retry_authorized': descriptor({ validate: (p) => validateShape(p, ['invocationId', 'reason'], ['invocationId', 'reason']) }),
  'tool.observed': descriptor({ audience: MODEL, validate: (p) => validateShape(p, ['observationId', 'invocationId', 'summary', 'evidenceRefs'], ['observationId', 'invocationId', 'summary'], ['evidenceRefs']) }),
  'context.compaction_started': descriptor({ validate: (p) => validateShape(p, ['checkpointId'], ['checkpointId']) }),
  'context.compacted': descriptor({ validate: (p) => validateShape(p, ['checkpointId', 'summaryRef', 'coveredSequence'], ['checkpointId', 'summaryRef'], [], ['coveredSequence']) }),
  'context.compaction_failed': descriptor({ validate: (p) => validateShape(p, ['checkpointId', 'code'], ['checkpointId', 'code']) }),
  'artifact.created': descriptor({ audience: USER, validate: (p) => validateShape(p, ['artifactId', 'mediaType', 'summary'], ['artifactId', 'mediaType', 'summary']) }),
  'artifact.expired': descriptor({ audience: USER, validate: (p) => validateShape(p, ['artifactId'], ['artifactId']) }),
  'artifact.deleted': descriptor({ audience: USER, validate: (p) => validateShape(p, ['artifactId'], ['artifactId']) }),
  'skill.activated': descriptor({ validate: (p) => validateShape(p, ['skillId', 'revision'], ['skillId', 'revision']) }),
  'capability.snapshot_captured': descriptor({ validate: (p) => validateShape(p, ['snapshotId', 'revision'], ['snapshotId', 'revision']) }),
  'subagent.started': descriptor({ audience: USER, validate: (p) => validateShape(p, ['subagentId', 'summary'], ['subagentId', 'summary']) }),
  'subagent.steered': descriptor({ audience: USER, validate: (p) => validateShape(p, ['subagentId', 'summary'], ['subagentId', 'summary']) }),
  'subagent.completed': descriptor({ audience: USER, validate: (p) => validateShape(p, ['subagentId', 'summary', 'refs'], ['subagentId', 'summary'], ['refs']) }),
  'subagent.failed': descriptor({ audience: USER, validate: (p) => validateShape(p, ['subagentId', 'code', 'summary'], ['subagentId', 'code', 'summary']) }),
  'subagent.cancelled': descriptor({ audience: USER, validate: (p) => validateShape(p, ['subagentId', 'reason'], ['subagentId', 'reason']) }),
  'usage.recorded': descriptor({ validate: validateUsageRecorded }),
} satisfies AgentEventSchemaRegistry);

export function isAgentEventType(value: string): value is AgentEventType {
  return Object.hasOwn(AGENT_EVENT_SCHEMA_REGISTRY, value);
}

export function validateAndRedactEventPayload<T extends AgentEventType>(
  type: T,
  payload: unknown,
): AgentEventPayloadMap[T] {
  const schema: AgentEventSchemaDescriptor<T> = AGENT_EVENT_SCHEMA_REGISTRY[
    type
  ] as AgentEventSchemaDescriptor<T>;
  schema.validate(payload);
  return schema.redact(payload as AgentEventPayloadMap[T]);
}
