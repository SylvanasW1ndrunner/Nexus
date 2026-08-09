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
      options?.validate?.(payload);
    },
    redact(payload: AgentEventPayloadMap[T]): AgentEventPayloadMap[T] {
      return structuredClone(payload);
    },
  });
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

function validateRecord(payload: unknown): void {
  requireRecord(payload);
}

function validateInput(payload: unknown): void {
  const record = requireRecord(payload);
  requireString(record, 'clientRequestId');
  if (!Object.hasOwn(record, 'content')) throw new TypeError('Event payload content is required.');
}

function validateRunCreated(payload: unknown): void {
  const record = requireRecord(payload);
  requireString(record, 'clientRequestId');
}

function validateRunFailure(payload: unknown): void {
  const record = requireRecord(payload);
  requireString(record, 'code');
}

function validateCommittedAttempt(payload: unknown): void {
  const record = requireRecord(payload);
  requireString(record, 'attemptId');
  requireString(record, 'finishReason');
  requireString(record, 'protocolEnvelopeRef');
  if (!Array.isArray(record.blocks)) throw new TypeError('Committed blocks must be an array.');
}

function validateToolProposed(payload: unknown): void {
  const record = requireRecord(payload);
  requireString(record, 'invocationId');
  requireString(record, 'callId');
  requireString(record, 'name');
  if (!Number.isInteger(record.actionOrdinal) || Number(record.actionOrdinal) < 0) {
    throw new TypeError('Tool actionOrdinal must be a non-negative integer.');
  }
  if (!Object.hasOwn(record, 'arguments')) throw new TypeError('Tool arguments are required.');
}

export const AGENT_EVENT_SCHEMA_REGISTRY = Object.freeze({
  'input.received': descriptor({ audience: USER, validate: validateInput }),
  'run.created': descriptor({ validate: validateRunCreated }),
  'run.started': descriptor({ validate: validateRecord }),
  'run.resumed': descriptor({ validate: validateRecord }),
  'run.steered': descriptor({ audience: USER, validate: validateRecord }),
  'run.input_requested': descriptor({ audience: USER, validate: validateRecord }),
  'run.cancel_requested': descriptor({ validate: validateRecord }),
  'run.limit_reached': descriptor({ audience: USER, validate: validateRecord }),
  'run.completed': descriptor({ audience: USER, validate: validateRecord }),
  'run.failed': descriptor({ audience: USER, validate: validateRunFailure }),
  'run.cancelled': descriptor({ audience: USER, validate: validateRecord }),
  'run.interrupted': descriptor({ audience: USER, validate: validateRunFailure }),
  'turn.started': descriptor({ validate: validateRecord }),
  'turn.context_compiled': descriptor({ validate: validateRecord }),
  'turn.no_progress': descriptor({ audience: MODEL, validate: validateRecord }),
  model_attempt_started: descriptor({ validate: validateRecord }),
  model_delta_batch: descriptor({ persistence: 'diagnostic', validate: validateRecord }),
  model_block_completed: descriptor({ persistence: 'diagnostic', validate: validateRecord }),
  model_attempt_committed: descriptor({ audience: MODEL, validate: validateCommittedAttempt }),
  model_attempt_discarded: descriptor({ persistence: 'diagnostic', validate: validateRecord }),
  model_failed: descriptor({ persistence: 'diagnostic', validate: validateRecord }),
  'turn.closed': descriptor({ validate: validateRecord }),
  'tool.proposed': descriptor({ audience: MODEL, validate: validateToolProposed }),
  'tool.validated': descriptor({ validate: validateRecord }),
  'tool.approval_requested': descriptor({ audience: USER, validate: validateRecord }),
  'tool.authorized': descriptor({ validate: validateRecord }),
  'tool.denied': descriptor({ audience: MODEL, validate: validateRecord }),
  'tool.started': descriptor({ validate: validateRecord }),
  'tool.progress': descriptor({ audience: USER, persistence: 'diagnostic', validate: validateRecord }),
  'tool.succeeded': descriptor({ validate: validateRecord }),
  'tool.failed': descriptor({ validate: validateRecord }),
  'tool.cancelled': descriptor({ validate: validateRecord }),
  'tool.outcome_unknown': descriptor({ audience: MODEL, validate: validateRecord }),
  'tool.outcome_resolution_requested': descriptor({ audience: USER, validate: validateRecord }),
  'tool.outcome_resolved': descriptor({ audience: MODEL, validate: validateRecord }),
  'tool.retry_authorized': descriptor({ validate: validateRecord }),
  'tool.observed': descriptor({ audience: MODEL, validate: validateRecord }),
  'context.compaction_started': descriptor({ validate: validateRecord }),
  'context.compacted': descriptor({ validate: validateRecord }),
  'context.compaction_failed': descriptor({ validate: validateRecord }),
  'artifact.created': descriptor({ audience: USER, validate: validateRecord }),
  'artifact.expired': descriptor({ audience: USER, validate: validateRecord }),
  'artifact.deleted': descriptor({ audience: USER, validate: validateRecord }),
  'skill.activated': descriptor({ validate: validateRecord }),
  'capability.snapshot_captured': descriptor({ validate: validateRecord }),
  'subagent.started': descriptor({ audience: USER, validate: validateRecord }),
  'subagent.steered': descriptor({ audience: USER, validate: validateRecord }),
  'subagent.completed': descriptor({ audience: USER, validate: validateRecord }),
  'subagent.failed': descriptor({ audience: USER, validate: validateRecord }),
  'subagent.cancelled': descriptor({ audience: USER, validate: validateRecord }),
  'usage.recorded': descriptor({ validate: validateRecord }),
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
