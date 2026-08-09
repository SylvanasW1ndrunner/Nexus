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
  validate?: (payload: unknown) => void;
}): AgentEventSchemaDescriptor<T> {
  return Object.freeze({
    schemaVersion: 1,
    audience: Object.freeze([...(options?.audience ?? INTERNAL)]),
    persistence: options?.persistence ?? 'durable',
    validate(payload: unknown): void {
      assertPortableValue(payload);
      assertNoSecretMaterial(payload);
      assertJournalPayloadSafety(payload);
      options?.validate?.(payload);
    },
    redact(payload: AgentEventPayloadMap[T]): AgentEventPayloadMap[T] {
      return structuredClone(payload);
    },
  });
}

function assertJournalPayloadSafety(payload: unknown): void {
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 256 * 1024) {
    throw new TypeError('Event payload exceeds the 256 KiB journal limit.');
  }
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      const normalized = key.replaceAll(/[-_]/gu, '').toLowerCase();
      if (['authorization', 'proxyauthorization', 'xapikey', 'credential'].includes(normalized)) {
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
  for (const key of requiredArrays) {
    if (!Array.isArray(record[key])) throw new TypeError(`Event payload ${key} must be an array.`);
  }
  for (const key of requiredNumbers) {
    if (typeof record[key] !== 'number' || !Number.isFinite(record[key])) {
      throw new TypeError(`Event payload ${key} must be a finite number.`);
    }
  }
}

function validateInput(payload: unknown): void {
  const record = requireRecord(payload);
  exactKeys(record, ['clientRequestId', 'content', 'steeringTarget']);
  requireString(record, 'clientRequestId');
  if (!Object.hasOwn(record, 'content')) throw new TypeError('Event payload content is required.');
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

function validateCommittedAttempt(payload: unknown): void {
  const record = requireRecord(payload);
  exactKeys(record, [
    'attemptId', 'blocks', 'finishReason', 'usage', 'protocolEnvelopeRef',
    'validatedAttempt', 'turn', 'protocolEnvelope',
  ]);
  requireString(record, 'attemptId');
  requireString(record, 'finishReason');
  requireString(record, 'protocolEnvelopeRef');
  if (!Array.isArray(record.blocks)) throw new TypeError('Committed blocks must be an array.');
  requireRecord(record.validatedAttempt);
  requireRecord(record.turn);
  requireRecord(record.protocolEnvelope);
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
    ['invocationId', 'summary', 'resultRefs', 'errorCode'],
    ['invocationId', 'summary'],
    ['resultRefs'],
  );
}

export const AGENT_EVENT_SCHEMA_REGISTRY = Object.freeze({
  'input.received': descriptor({ audience: USER, validate: validateInput }),
  'run.created': descriptor({ validate: validateRunCreated }),
  'run.started': descriptor({ validate: (p) => validateShape(p, []) }),
  'run.resumed': descriptor({ validate: (p) => validateShape(p, ['reason']) }),
  'run.steered': descriptor({ audience: USER, validate: (p) => validateShape(p, ['clientRequestId', 'content'], ['clientRequestId']) }),
  'run.input_requested': descriptor({ audience: USER, validate: (p) => validateShape(p, ['reason', 'connectionId'], ['reason']) }),
  'run.cancel_requested': descriptor({ validate: (p) => validateShape(p, ['reason']) }),
  'run.limit_reached': descriptor({ audience: USER, validate: (p) => validateShape(p, ['limit', 'value'], ['limit']) }),
  'run.completed': descriptor({ audience: USER, validate: (p) => validateShape(p, ['finalContentRef', 'deliveryStatus', 'evidenceRefs'], ['finalContentRef', 'deliveryStatus'], ['evidenceRefs']) }),
  'run.failed': descriptor({ audience: USER, validate: validateRunFailure }),
  'run.cancelled': descriptor({ audience: USER, validate: (p) => validateShape(p, ['reason']) }),
  'run.interrupted': descriptor({ audience: USER, validate: validateRunFailure }),
  'turn.started': descriptor({ validate: (p) => validateShape(p, ['turnSnapshotId']) }),
  'turn.context_compiled': descriptor({ validate: (p) => validateShape(p, ['contextRef', 'tokenEstimate']) }),
  'turn.no_progress': descriptor({ audience: MODEL, validate: (p) => validateShape(p, ['fingerprint'], ['fingerprint']) }),
  model_attempt_started: descriptor({ validate: (p) => validateShape(p, ['origin']) }),
  model_delta_batch: descriptor({ persistence: 'diagnostic', validate: (p) => validateShape(p, ['blocks'], [], ['blocks']) }),
  model_block_completed: descriptor({ persistence: 'diagnostic', validate: (p) => validateShape(p, ['draftCallKey', 'block']) }),
  model_attempt_committed: descriptor({ audience: MODEL, validate: validateCommittedAttempt }),
  model_attempt_discarded: descriptor({ persistence: 'diagnostic', validate: (p) => validateShape(p, ['reason'], ['reason']) }),
  model_failed: descriptor({ persistence: 'diagnostic', validate: (p) => validateShape(p, ['code', 'retryable', 'detail'], ['code']) }),
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
  'usage.recorded': descriptor({ validate: (p) => validateShape(p, ['scope', 'inputTokens', 'outputTokens', 'totalTokens'], ['scope'], [], ['inputTokens', 'outputTokens', 'totalTokens']) }),
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
