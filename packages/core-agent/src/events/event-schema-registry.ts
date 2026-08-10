import { assertNoSecretMaterial, assertPortableValue } from '@dbagent/shared';
import type { AgentEventPayloadMap, AgentEventType } from './agent-event.js';

export type AgentEventAudience = 'internal' | 'model' | 'user' | 'audit';
export type AgentEventPersistence = 'durable' | 'diagnostic';

export type AgentEventSchemaDescriptor<T extends AgentEventType> = {
  readonly schemaVersion: number;
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
  schemaVersion?: number;
  audience?: readonly AgentEventAudience[];
  persistence?: AgentEventPersistence;
  maxPayloadBytes?: number;
  validate?: (payload: unknown) => void;
}): AgentEventSchemaDescriptor<T> {
  return Object.freeze({
    schemaVersion: options?.schemaVersion ?? 1,
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
      if (normalized === 'fencingtoken') {
        visit(item);
        continue;
      }
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

function requireArtifactId(value: unknown): void {
  if (typeof value !== 'string' || !/^artifact_[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError('Event payload artifactId has an invalid opaque format.');
  }
}

function requireArtifactChecksum(value: unknown): void {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError('Event payload checksum must be lowercase SHA-256.');
  }
}

function requireArtifactHandle(value: unknown, availability: unknown): void {
  const pattern = availability === 'legacy-unavailable'
    ? /^legacy-agent-artifact:[a-f0-9]{64}$/u
    : /^agent-artifact:[a-f0-9]{24}:[a-f0-9]{40}$/u;
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new TypeError('Event payload handle has an invalid artifact format.');
  }
}

function requireIsoTimestamp(value: unknown, key: string): void {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError(`Event payload ${key} must be an exact ISO timestamp.`);
  }
}

function validateArtifactLifecycle(payload: unknown): void {
  const record = requireRecord(payload);
  exactKeys(record, ['artifactId']);
  requireArtifactId(record.artifactId);
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
  exactKeys(record, ['clientRequestId', 'visibility']);
  requireString(record, 'clientRequestId');
  if (record.visibility !== undefined && record.visibility !== 'legacy-import-carrier') {
    throw new TypeError('Run visibility is invalid.');
  }
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
  const record = requireRecord(payload);
  validateShape(
    payload,
    [
      'summary', 'resultRefs', 'durableSummary', 'modelProjection', 'userProjection', 'error',
    ],
    ['summary'],
    ['resultRefs'],
  );
  if (record.error !== undefined) validateToolExecutionError(record.error);
}

function validateCanonicalToolId(value: unknown): void {
  const record = requireRecord(value);
  exactKeys(record, ['namespace', 'name']);
  requireString(record, 'name');
  optionalString(record, 'namespace');
}

function validateToolEffect(record: Record<string, unknown>, key = 'effect'): void {
  requireEnum(record, key, ['read', 'idempotent', 'transactional', 'non_idempotent']);
}

function validateSha256(record: Record<string, unknown>, key: string): void {
  const value = record[key];
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`Event payload ${key} must be lowercase SHA-256.`);
  }
}

function validateToolValidated(payload: unknown): void {
  const record = requireRecord(payload);
  if (record.validationError !== undefined) {
    exactKeys(record, ['invocationId', 'validationError']);
    requireString(record, 'invocationId');
    validateToolExecutionError(record.validationError);
    return;
  }
  exactKeys(record, [
    'invocationId', 'canonicalToolId', 'toolRevision', 'effect',
    'normalizedArgumentsDigest', 'proposedRevision', 'retryOf', 'retryPermitId',
  ]);
  ['invocationId', 'toolRevision'].forEach((key) => requireString(record, key));
  optionalString(record, 'retryOf');
  optionalString(record, 'retryPermitId');
  validateCanonicalToolId(record.canonicalToolId);
  validateToolEffect(record);
  validateSha256(record, 'normalizedArgumentsDigest');
  requireNonNegativeInteger(record, 'proposedRevision');
}

function validateToolApprovalFact(value: unknown): void {
  const record = requireRecord(value);
  exactKeys(record, [
    'approvalId', 'projectId', 'sessionId', 'runId', 'turnId', 'invocationId',
    'canonicalToolId', 'toolRevision', 'effect', 'normalizedArgumentsDigest',
    'proposedRevision', 'status', 'decidedAt', 'decidedBy', 'reason',
  ]);
  [
    'approvalId', 'projectId', 'sessionId', 'runId', 'turnId', 'invocationId', 'toolRevision',
  ].forEach((key) => requireString(record, key));
  validateCanonicalToolId(record.canonicalToolId);
  validateToolEffect(record);
  validateSha256(record, 'normalizedArgumentsDigest');
  requireNonNegativeInteger(record, 'proposedRevision');
  requireEnum(record, 'status', ['pending', 'approved', 'denied']);
  if (record.decidedAt !== undefined) requireIsoTimestamp(record.decidedAt, 'decidedAt');
  optionalString(record, 'decidedBy');
  optionalString(record, 'reason');
}

function validateToolApprovalRequested(payload: unknown): void {
  const record = requireRecord(payload);
  exactKeys(record, ['approval', 'summary']);
  validateToolApprovalFact(record.approval);
  requireBoundedString(record, 'summary', 2_000);
}

function validateToolStarted(payload: unknown): void {
  const record = requireRecord(payload);
  exactKeys(record, ['invocationId', 'idempotencyKey', 'fencingToken', 'attempt']);
  ['invocationId', 'idempotencyKey'].forEach((key) => requireString(record, key));
  requireNonNegativeInteger(record, 'fencingToken');
  requireNonNegativeInteger(record, 'attempt');
}

function validateToolExecutionError(value: unknown): void {
  const record = requireRecord(value);
  exactKeys(record, ['code', 'category', 'retryable', 'outcome']);
  requireEnum(record, 'code', [
    'HANDLER_FAILED', 'TOOL_TIMEOUT', 'TOOL_CANCELLED', 'INVALID_TOOL_RESULT',
    'TOOL_NOT_FOUND', 'TOOL_REVISION_MISMATCH', 'TOOL_INPUT_INVALID',
    'OUTCOME_RESOLVED_FAILED',
  ]);
  requireEnum(record, 'category', [
    'internal', 'timeout', 'cancelled', 'contract', 'unavailable', 'conflict', 'validation',
    'resolution',
  ]);
  requireEnum(record, 'outcome', ['not_applied', 'unknown']);
  if (typeof record.retryable !== 'boolean') {
    throw new TypeError('Event payload retryable must be boolean.');
  }
}

function validateToolRetryAuthorized(payload: unknown): void {
  const record = requireRecord(payload);
  exactKeys(record, [
    'invocationId', 'permitId', 'toolRevision', 'effect',
    'normalizedArgumentsDigest', 'reason',
  ]);
  ['invocationId', 'permitId', 'toolRevision', 'reason'].forEach((key) => requireString(record, key));
  validateToolEffect(record);
  validateSha256(record, 'normalizedArgumentsDigest');
}

function validateToolOutcomeResolved(payload: unknown): void {
  const record = requireRecord(payload);
  validateShape(
    payload,
    [
      'resolutionId', 'decisionDigest', 'invocationId', 'outcome', 'canonicalToolId', 'toolRevision',
      'effect', 'normalizedArgumentsDigest', 'proposedRevision', 'summary', 'resultRefs',
      'durableSummary', 'modelProjection', 'userProjection', 'error',
    ],
    ['resolutionId', 'decisionDigest', 'invocationId', 'outcome', 'toolRevision', 'summary'],
    ['resultRefs'],
  );
  validateCanonicalToolId(record.canonicalToolId);
  validateSha256(record, 'decisionDigest');
  validateToolEffect(record);
  validateSha256(record, 'normalizedArgumentsDigest');
  requireNonNegativeInteger(record, 'proposedRevision');
  requireEnum(record, 'outcome', ['succeeded', 'failed']);
  if (record.error !== undefined) validateToolExecutionError(record.error);
}

function validateToolObserved(payload: unknown): void {
  const record = requireRecord(payload);
  exactKeys(record, [
    'observationId', 'invocationId', 'summary', 'evidenceRefs',
    'outcome', 'modelProjection', 'errorCode',
  ]);
  ['observationId', 'invocationId', 'summary'].forEach((key) => requireString(record, key));
  requireStringArray(record, 'evidenceRefs');
  requireEnum(record, 'outcome', [
    'succeeded', 'failed', 'cancelled', 'outcome_unknown', 'denied',
  ]);
  if (record.errorCode !== undefined) {
    requireEnum(record, 'errorCode', [
      'HANDLER_FAILED', 'TOOL_TIMEOUT', 'TOOL_CANCELLED', 'INVALID_TOOL_RESULT',
      'TOOL_NOT_FOUND', 'TOOL_REVISION_MISMATCH', 'TOOL_INPUT_INVALID',
      'OUTCOME_RESOLVED_FAILED',
    ]);
  }
}

function validateLegacyImported(payload: unknown): void {
  const record = requireRecord(payload);
  requireString(record, 'entityType');
  requireBoundedString(record, 'legacyId', 512);
  requireEnum(record, 'entityType', [
    'session', 'message', 'run', 'preference', 'checkpoint', 'subagent', 'diagnostic', 'archive',
  ]);
  switch (record.entityType) {
    case 'session': {
      exactKeys(record, [
        'entityType', 'legacyId', 'projectKey', 'projectRoot', 'record',
      ]);
      requireString(record, 'projectKey');
      requireString(record, 'projectRoot');
      const imported = requireRecord(record.record);
      exactKeys(imported, ['session', 'archived', 'createdAt', 'updatedAt', 'lastMessageAt']);
      if (typeof imported.archived !== 'boolean') {
        throw new TypeError('Legacy Session archived must be boolean.');
      }
      requireIsoTimestamp(imported.createdAt, 'createdAt');
      requireIsoTimestamp(imported.updatedAt, 'updatedAt');
      if (imported.lastMessageAt !== null) requireIsoTimestamp(imported.lastMessageAt, 'lastMessageAt');
      const session = requireRecord(imported.session);
      ['id', 'title', 'mode'].forEach((key) => requireString(session, key));
      if (session.id !== record.legacyId) throw new TypeError('Legacy Session identity disagrees.');
      if (!Array.isArray(session.messages)) throw new TypeError('Legacy Session messages must be an array.');
      if (typeof session.aborted !== 'boolean') throw new TypeError('Legacy Session aborted must be boolean.');
      requireRecord(session.tokenUsage);
      return;
    }
    case 'message': {
      exactKeys(record, [
        'entityType', 'legacyId', 'messageIndex', 'sourceRunId', 'record',
      ]);
      requireNonNegativeInteger(record, 'messageIndex');
      requireString(record, 'sourceRunId');
      const message = requireRecord(record.record);
      requireEnum(message, 'role', ['user', 'assistant', 'tool', 'system']);
      requireString(message, 'content');
      requireIsoTimestamp(message.createdAt, 'createdAt');
      return;
    }
    case 'run': {
      exactKeys(record, ['entityType', 'legacyId', 'record', 'sourceStatus', 'legacyPlan']);
      requireString(record, 'sourceStatus');
      const run = requireRecord(record.record);
      ['runId', 'sessionId', 'status', 'phase'].forEach((key) => requireString(run, key));
      if (typeof run.finalText !== 'string') throw new TypeError('Legacy Run finalText must be a string.');
      if (run.runId !== record.legacyId) throw new TypeError('Legacy Run identity disagrees.');
      requireNonNegativeInteger(run, 'iteration');
      requireIsoTimestamp(run.createdAt, 'createdAt');
      requireIsoTimestamp(run.updatedAt, 'updatedAt');
      if (!Array.isArray(run.toolExecutions)) {
        throw new TypeError('Legacy Run toolExecutions must be an array.');
      }
      return;
    }
    case 'preference': {
      exactKeys(record, ['entityType', 'legacyId', 'record']);
      const preference = requireRecord(record.record);
      ['id', 'userId', 'key', 'value'].forEach((key) => requireString(preference, key));
      if (preference.id !== record.legacyId) throw new TypeError('Legacy preference identity disagrees.');
      requireIsoTimestamp(preference.createdAt, 'createdAt');
      requireIsoTimestamp(preference.updatedAt, 'updatedAt');
      return;
    }
    case 'checkpoint': {
      exactKeys(record, ['entityType', 'legacyId', 'sessionId', 'record']);
      requireString(record, 'sessionId');
      const checkpoint = requireRecord(record.record);
      requireLiteral(checkpoint, 'version', 1);
      requireNonNegativeInteger(checkpoint, 'sequence');
      requireIsoTimestamp(checkpoint.createdAt, 'createdAt');
      return;
    }
    case 'subagent': {
      exactKeys(record, ['entityType', 'legacyId', 'record']);
      const subagent = requireRecord(record.record);
      ['id', 'parentSessionId', 'task', 'contextStrategy', 'status'].forEach((key) =>
        requireString(subagent, key));
      if (subagent.id !== record.legacyId) throw new TypeError('Legacy subagent identity disagrees.');
      requireNonNegativeInteger(subagent, 'depth');
      requireIsoTimestamp(subagent.createdAt, 'createdAt');
      requireIsoTimestamp(subagent.updatedAt, 'updatedAt');
      return;
    }
    case 'diagnostic':
      exactKeys(record, ['entityType', 'legacyId', 'code', 'evidence']);
      requireString(record, 'code');
      requireString(record, 'evidence');
      return;
    case 'archive':
      exactKeys(record, ['entityType', 'legacyId', 'relativePath', 'archiveHandle', 'checksum', 'byteSize']);
      ['relativePath', 'archiveHandle'].forEach((key) => requireString(record, key));
      requireArtifactChecksum(record.checksum);
      requireNonNegativeInteger(record, 'byteSize');
      if (!/^legacy-archive:[a-f0-9]{64}$/u.test(String(record.archiveHandle))) {
        throw new TypeError('Legacy archive handle has an invalid format.');
      }
      return;
  }
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
  'tool.validated': descriptor({ validate: validateToolValidated }),
  'tool.approval_requested': descriptor({ audience: USER, validate: validateToolApprovalRequested }),
  'tool.authorized': descriptor({ validate: (p) => validateShape(p, ['approvalId', 'invocationId'], ['approvalId', 'invocationId']) }),
  'tool.denied': descriptor({ audience: MODEL, validate: (p) => validateShape(p, ['approvalId', 'invocationId', 'reason'], ['approvalId', 'invocationId', 'reason']) }),
  'tool.started': descriptor({ validate: validateToolStarted }),
  'tool.progress': descriptor({ audience: USER, persistence: 'diagnostic', validate: (p) => validateShape(p, ['invocationId', 'summary'], ['invocationId', 'summary']) }),
  'tool.succeeded': descriptor({ validate: validateToolTerminal }),
  'tool.failed': descriptor({ validate: validateToolTerminal }),
  'tool.cancelled': descriptor({ validate: validateToolTerminal }),
  'tool.outcome_unknown': descriptor({ audience: MODEL, validate: validateToolTerminal }),
  'tool.outcome_resolution_requested': descriptor({ audience: USER, validate: (p) => validateShape(p, ['invocationId', 'summary'], ['invocationId', 'summary']) }),
  'tool.outcome_resolved': descriptor({ audience: MODEL, validate: validateToolOutcomeResolved }),
  'tool.retry_authorized': descriptor({ validate: validateToolRetryAuthorized }),
  'tool.observed': descriptor({ audience: MODEL, validate: validateToolObserved }),
  'context.compaction_started': descriptor({ validate: (p) => validateShape(p, ['checkpointId'], ['checkpointId']) }),
  'context.compacted': descriptor({ validate: (p) => validateShape(p, ['checkpointId', 'summaryRef', 'coveredSequence'], ['checkpointId', 'summaryRef'], [], ['coveredSequence']) }),
  'context.compaction_failed': descriptor({ validate: (p) => validateShape(p, ['checkpointId', 'code'], ['checkpointId', 'code']) }),
  'artifact.created': descriptor({
    schemaVersion: 3,
    audience: USER,
    validate: (payload) => {
      const record = requireRecord(payload);
      validateShape(
        payload,
        ['artifactId', 'handle', 'checksum', 'byteSize', 'mediaType', 'availability', 'summary', 'expiresAt'],
        ['artifactId', 'handle', 'mediaType', 'availability', 'summary'],
      );
      requireEnum(record, 'availability', ['available', 'legacy-unavailable']);
      requireArtifactId(record.artifactId);
      requireArtifactHandle(record.handle, record.availability);
      if (Object.hasOwn(record, 'expiresAt')) requireIsoTimestamp(record.expiresAt, 'expiresAt');
      if (record.availability === 'available') {
        requireString(record, 'checksum');
        requireArtifactChecksum(record.checksum);
        requireNonNegativeInteger(record, 'byteSize');
      } else if (record.checksum !== null || record.byteSize !== null) {
        throw new TypeError('Legacy unavailable artifacts cannot claim checksum or size.');
      }
    },
  }),
  'artifact.expired': descriptor({ audience: USER, validate: validateArtifactLifecycle }),
  'artifact.deleted': descriptor({ audience: USER, validate: validateArtifactLifecycle }),
  'legacy.imported': descriptor({
    schemaVersion: 2,
    validate: validateLegacyImported,
    maxPayloadBytes: 16 * 1024 * 1024,
  }),
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
