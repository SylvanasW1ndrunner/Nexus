import { validatePreparedIntent, assertPreparedDigest } from '../tools/prepared-invocation.js';
import { validateToolQuestionBundle } from '../tools/tool-question.js';
import { TOOL_PROTOCOL_BOUNDS, type PreparedToolIntent } from '../tools/tool-protocol.js';
import { assertPortableValue } from '@dbagent/shared';
import {
  isAgentEvidenceRef,
  MAX_AGENT_EVIDENCE_REFS,
} from '../evidence-reference.js';
import type { AgentEventPayloadMap, AgentEventType } from './agent-event.js';

export type AgentEventAudience = 'internal' | 'model' | 'user' | 'audit';
export type AgentEventPersistence = 'durable' | 'diagnostic';

export type AgentEventSchemaDescriptor<T extends AgentEventType> = {
  readonly schemaVersion: number;
  readonly audience: readonly AgentEventAudience[];
  readonly persistence: AgentEventPersistence;
  validate(payload: unknown): void;
  snapshot(payload: AgentEventPayloadMap[T]): AgentEventPayloadMap[T];
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
      assertJournalPayloadSafety(payload, options?.maxPayloadBytes ?? 256 * 1024);
      options?.validate?.(payload);
    },
    snapshot(payload: AgentEventPayloadMap[T]): AgentEventPayloadMap[T] {
      return structuredClone(payload);
    },
  });
}

function assertJournalPayloadSafety(payload: unknown, maxPayloadBytes: number): void {
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > maxPayloadBytes) {
    throw new TypeError(`Event payload exceeds the ${maxPayloadBytes} byte journal limit.`);
  }
}

function requireRecord(payload: unknown): Record<string, unknown> {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('Event payload must be an object.');
  }
  return payload as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`Event payload ${key} must be a non-empty string.`);
  }
  return value;
}

function requireBoundedString(record: Record<string, unknown>, key: string, maximum = 4_096): void {
  if (requireString(record, key).length > maximum) {
    throw new TypeError(`Event payload ${key} exceeds ${maximum} characters.`);
  }
}

function requireProtocolIdentity(record: Record<string, unknown>, key = 'protocol'): void {
  requireBoundedString(record, key, 128);
  const value = record[key] as string;
  if (!/^[A-Za-z0-9][A-Za-z0-9._+:/-]*$/u.test(value)) {
    throw new TypeError(
      `Event payload ${key} must be a bounded opaque protocol identity.`,
    );
  }
}

function optionalString(record: Record<string, unknown>, key: string): void {
  if (Object.hasOwn(record, key)) requireString(record, key);
}

function optionalBoolean(record: Record<string, unknown>, key: string): void {
  if (Object.hasOwn(record, key) && typeof record[key] !== 'boolean') {
    throw new TypeError(`Event payload ${key} must be a boolean.`);
  }
}

const RESUMABLE_RUN_STATES = [
  'created', 'Preparing', 'Compacting', 'CallingModel', 'ReceivingModel', 'ResolvingActions',
  'ExecutingTools', 'ApplyingObservations', 'Finalizing',
] as const;

function requireResumeState(record: Record<string, unknown>): void {
  requireEnum(record, 'resumeState', RESUMABLE_RUN_STATES);
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

function requireStringArray(record: Record<string, unknown>, key: string, maxChars = 2_048, maxItems = 256): void {
  const value = record[key];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new TypeError(`Event payload ${key} must be a string array with at most 256 refs.`);
  }
  value.forEach((item, index) => {
    if (typeof item !== 'string' || item.length === 0 || item.length > maxChars) {
      throw new TypeError(`Event payload ${key}[${index}] must be a bounded non-empty string.`);
    }
  });
}

function requireEvidenceRefs(record: Record<string, unknown>, key = 'evidenceRefs'): void {
  const value = record[key];
  if (!Array.isArray(value) || value.length > MAX_AGENT_EVIDENCE_REFS) {
    throw new TypeError(
      `Event payload ${key} must contain at most ${MAX_AGENT_EVIDENCE_REFS} evidence refs.`,
    );
  }
  const seen = new Set<string>();
  value.forEach((item, index) => {
    if (!isAgentEvidenceRef(item)) {
      throw new TypeError(`Event payload ${key}[${index}] is not a valid evidence ref.`);
    }
    if (seen.has(item)) {
      throw new TypeError(`Event payload ${key}[${index}] duplicates an evidence ref.`);
    }
    seen.add(item);
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
  exactKeys(record, ['clientRequestId', 'configuration', 'visibility', 'parent']);
  requireString(record, 'clientRequestId');
  if (record.configuration !== undefined) {
    const configuration = requireRecord(record.configuration);
    exactKeys(configuration, [
      'schemaVersion', 'clientRequestDigest', 'mode', 'rolePrompt', 'capabilityInstructions',
      'allowedTools', 'sessionSkillRevision',
    ]);
    if (configuration.schemaVersion !== 1) {
      throw new TypeError('Run configuration schemaVersion is invalid.');
    }
    if (configuration.clientRequestDigest !== undefined) {
      requireBoundedString(configuration, 'clientRequestDigest', 128);
    }
    if (
      configuration.mode !== 'default' && configuration.mode !== 'auto' &&
      configuration.mode !== 'full-access'
    ) {
      throw new TypeError('Run configuration mode is invalid.');
    }
    if (configuration.rolePrompt !== undefined) {
      validateRolePromptConfiguration(configuration.rolePrompt);
    }
    requireStringArray(configuration, 'capabilityInstructions');
    if (configuration.allowedTools !== undefined) requireStringArray(configuration, 'allowedTools');
    requireNonNegativeInteger(configuration, 'sessionSkillRevision');
  }
  if (record.visibility !== undefined && record.visibility !== 'legacy-import-carrier') {
    throw new TypeError('Run visibility is invalid.');
  }
  if (record.parent !== undefined) {
    const parent = requireRecord(record.parent);
    exactKeys(parent, ['runId', 'turnId', 'invocationId']);
    requireString(parent, 'runId');
    requireString(parent, 'turnId');
    requireString(parent, 'invocationId');
  }
}

function validateRolePromptConfiguration(value: unknown): void {
  const prompt = requireRecord(value);
  exactKeys(prompt, ['default', 'run']);
  for (const layerName of ['default', 'run'] as const) {
    const layer = prompt[layerName];
    if (layer === undefined) continue;
    const record = requireRecord(layer);
    exactKeys(record, ['mode', 'content']);
    if (record.mode !== 'append' && record.mode !== 'replace') {
      throw new TypeError(`Run role prompt ${layerName} mode is invalid.`);
    }
    requireBoundedString(record, 'content', 100_000);
  }
}

function validateRunFailure(payload: unknown): void {
  const record = requireRecord(payload);
  exactKeys(record, ['code', 'detail']);
  requireString(record, 'code');
}

function validateRunInterrupted(payload: unknown): void {
  const record = requireRecord(payload);
  exactKeys(record, ['code', 'detail', 'resumeState']);
  requireString(record, 'code');
  requireResumeState(record);
}

function validateRunSteered(payload: unknown): void {
  const record = requireRecord(payload);
  exactKeys(record, ['clientRequestId', 'content']);
  requireString(record, 'clientRequestId');
  requirePresent(record, 'content');
}

function validateRunResumed(payload: unknown): void {
  const record = requireRecord(payload);
  exactKeys(record, ['resumeState', 'reason', 'clearTurn']);
  requireResumeState(record);
  optionalString(record, 'reason');
  optionalBoolean(record, 'clearTurn');
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
  exactKeys(record, ['limit', 'value', 'resumeState']);
  requireString(record, 'limit');
  optionalNonNegativeInteger(record, 'value');
  requireResumeState(record);
}

function validateTurnStarted(payload: unknown): void {
  const record = requireRecord(payload);
  exactKeys(record, ['turnSnapshotId', 'environmentBindingId', 'digest', 'snapshot']);
  optionalString(record, 'turnSnapshotId');
  optionalString(record, 'environmentBindingId');
  optionalString(record, 'digest');
  if (record.snapshot !== undefined) requirePresent(record, 'snapshot');
}

function validateEnvironmentBound(payload: unknown): void {
  const record = requireRecord(payload);
  exactKeys(record, ['environmentBindingId', 'digest', 'binding']);
  requireString(record, 'environmentBindingId');
  requireString(record, 'digest');
  if (record.binding !== undefined) requirePresent(record, 'binding');
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
  requireProtocolIdentity(origin);
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
  requireEnum(record, 'deliveryStatus', ['not-required', 'verified', 'unverified']);
  requireEvidenceRefs(record);
}

function validateDeliveryDecision(payload: unknown): void {
  const record = requireRecord(payload);
  exactKeys(record, [
    'evidenceRevision', 'status', 'outcome', 'verifierId', 'verifierRevision',
    'evidenceRefs', 'reason', 'observation',
  ]);
  requireNonNegativeInteger(record, 'evidenceRevision');
  requireEnum(record, 'status', ['not-required', 'verified', 'unverified']);
  requireEnum(record, 'outcome', ['accepted', 'revision-requested', 'failed']);
  optionalString(record, 'verifierId');
  optionalString(record, 'verifierRevision');
  requireEvidenceRefs(record);
  optionalString(record, 'reason');
  if (
    (record.verifierId === undefined) !== (record.verifierRevision === undefined)
  ) {
    throw new TypeError('Delivery verifier identity and revision must be supplied together.');
  }
  if (record.status === 'not-required' && record.verifierId !== undefined) {
    throw new TypeError('A not-required delivery cannot claim a verifier decision.');
  }
  if (record.status === 'verified' && record.verifierId === undefined) {
    throw new TypeError('A verified delivery requires a versioned verifier identity.');
  }
  if (
    (record.outcome === 'revision-requested' || record.outcome === 'failed') &&
    record.status !== 'unverified'
  ) {
    throw new TypeError('A non-accepted delivery decision must be unverified.');
  }
  if (record.outcome === 'revision-requested') {
    requirePresent(record, 'observation');
  } else if (Object.hasOwn(record, 'observation')) {
    throw new TypeError(
      'Event payload observation is only valid for a delivery revision request.',
    );
  }
}

function validatePlanFact(payload: unknown): void {
  const record = requireRecord(payload);
  exactKeys(record, ['planId', 'revision', 'plan']);
  requireString(record, 'planId');
  requireNonNegativeInteger(record, 'revision');
  requirePresent(record, 'plan');
}

const RUNTIME_COMMAND_KINDS = [
  'plan.create', 'plan.update', 'discovery.activate', 'skill.activate',
  'child.start', 'child.list', 'child.wait', 'child.steer', 'child.cancel',
] as const;

function validateRuntimeCommandApplied(payload: unknown): void {
  const record = requireRecord(payload);
  exactKeys(record, [
    'commandId', 'kind', 'origin', 'expectedRunRevision', 'fencingToken',
    'projectionRevision', 'effect',
  ]);
  requireString(record, 'commandId');
  requireEnum(record, 'kind', RUNTIME_COMMAND_KINDS);
  for (const key of ['expectedRunRevision', 'fencingToken', 'projectionRevision']) {
    requireNonNegativeInteger(record, key);
    if (Number(record[key]) < 1) {
      throw new TypeError(`Event payload ${key} must be positive.`);
    }
  }
  const origin = requireRecord(record.origin);
  exactKeys(origin, ['runId', 'turnId', 'invocationId']);
  ['runId', 'turnId', 'invocationId'].forEach((key) => requireString(origin, key));
  const effect = requireRecord(record.effect);
  switch (record.kind) {
    case 'plan.create':
    case 'plan.update':
      exactKeys(effect, ['planId', 'revision', 'plan']);
      requireString(effect, 'planId');
      requireNonNegativeInteger(effect, 'revision');
      if (Number(effect.revision) < 1) throw new TypeError('Plan revision must be positive.');
      requirePresent(effect, 'plan');
      break;
    case 'discovery.activate':
      exactKeys(effect, ['tools', 'targets', 'bindings']);
      validateToolActivations(effect.tools);
      validateCapabilityDiscoveryTargets(effect.targets);
      validateCapabilityActivationBindings(effect.bindings, effect.targets);
      if ((effect.tools as unknown[]).length === 0 && (effect.targets as unknown[]).length === 0) {
        throw new TypeError('Discovery activation effect must not be empty.');
      }
      break;
    case 'skill.activate':
      exactKeys(effect, ['activations']);
      validateSkillActivations(effect.activations);
      break;
    case 'child.start':
      exactKeys(effect, [
        'childRunId', 'childSessionId', 'parentRunId', 'parentInvocationId',
        'startCommandId', 'revision', 'task', 'context', 'status',
      ]);
      requireString(effect, 'childRunId');
      requireString(effect, 'childSessionId');
      requireString(effect, 'parentRunId');
      requireString(effect, 'parentInvocationId');
      requireString(effect, 'startCommandId');
      requireNonNegativeInteger(effect, 'revision');
      if (Number(effect.revision) !== 1) throw new TypeError('Child revision must begin at one.');
      requireString(effect, 'task');
      requirePresent(effect, 'context');
      requireLiteral(effect, 'status', 'running');
      break;
    case 'child.list':
      exactKeys(effect, ['children']);
      if (!Array.isArray(effect.children)) throw new TypeError('Runtime child list must be an array.');
      break;
    case 'child.wait':
      exactKeys(effect, ['childRunId', 'revision', 'status']);
      requireString(effect, 'childRunId');
      requireNonNegativeInteger(effect, 'revision');
      requireEnum(effect, 'status', [
        'running', 'completed', 'failed', 'cancelled', 'limit_reached', 'interrupted',
      ] as const);
      break;
    case 'child.steer':
      exactKeys(effect, ['childRunId', 'revision', 'input']);
      requireString(effect, 'childRunId');
      requireNonNegativeInteger(effect, 'revision');
      requirePresent(effect, 'input');
      break;
    case 'child.cancel':
      exactKeys(effect, ['childRunId', 'revision', 'reason']);
      requireString(effect, 'childRunId');
      requireNonNegativeInteger(effect, 'revision');
      requireString(effect, 'reason');
      break;
    default:
      throw new TypeError('Runtime Command kind is unsupported.');
  }
}

function validateCapabilityActivationBindings(value: unknown, targetsValue: unknown): void {
  if (!Array.isArray(value) || value.length > 256 || !Array.isArray(targetsValue)) {
    throw new TypeError('Capability activation bindings must be a bounded array.');
  }
  const allowedTargets = new Set(targetsValue.map((targetValue) => {
    const target = requireRecord(targetValue);
    return `${String(target.moduleId)}\0${String(target.instanceId)}`;
  }));
  const boundTargets = new Set<string>();
  for (const entryValue of value) {
    const entry = requireRecord(entryValue);
    exactKeys(entry, ['target', 'binding']);
    const target = requireRecord(entry.target);
    exactKeys(target, ['moduleId', 'instanceId']);
    const identity = `${requireString(target, 'moduleId')}\0${requireString(target, 'instanceId')}`;
    if (!allowedTargets.has(identity) || boundTargets.has(identity)) {
      throw new TypeError('Capability activation binding target is invalid or repeated.');
    }
    boundTargets.add(identity);
    const binding = requireRecord(entry.binding);
    exactKeys(binding, ['providerId', 'candidateId', 'fingerprint', 'capabilityGeneration']);
    for (const key of ['providerId', 'candidateId', 'fingerprint', 'capabilityGeneration']) {
      requireString(binding, key);
    }
  }
}

function validateToolActivations(value: unknown): void {
  if (!Array.isArray(value) || value.length > 256) {
    throw new TypeError('Tool activations must be a bounded array.');
  }
  const names = new Set<string>();
  for (const activationValue of value) {
    const activation = requireRecord(activationValue);
    exactKeys(activation, ['name', 'toolRevision', 'handlerRevision']);
    const name = requireString(activation, 'name');
    requireString(activation, 'toolRevision');
    requireString(activation, 'handlerRevision');
    if (names.has(name)) throw new TypeError('Tool activations repeat a name.');
    names.add(name);
  }
}

function validateCapabilityDiscoveryTargets(value: unknown): void {
  if (!Array.isArray(value) || value.length > 256) {
    throw new TypeError('Capability discovery targets must be a bounded array.');
  }
  const identities = new Set<string>();
  for (const targetValue of value) {
    const target = requireRecord(targetValue);
    exactKeys(target, ['moduleId', 'instanceId']);
    const moduleId = requireString(target, 'moduleId');
    const instanceId = requireString(target, 'instanceId');
    const identity = `${moduleId}\0${instanceId}`;
    if (identities.has(identity)) throw new TypeError('Capability discovery targets repeat.');
    identities.add(identity);
  }
}

function validateSkillActivations(value: unknown): void {
  if (!Array.isArray(value) || value.length > 256) throw new TypeError('Skill activations are invalid.');
  const ids = new Set<string>();
  for (const entry of value) {
    const activation = requireRecord(entry);
    if (!Object.hasOwn(activation, 'id') || !Object.hasOwn(activation, 'revision') ||
        Object.keys(activation).some((key) => !['id', 'revision', 'allowedTools'].includes(key))) {
      throw new TypeError('Skill activation shape is invalid.');
    }
    requireString(activation, 'id');
    if (ids.has(String(activation.id))) throw new TypeError('Skill activations must be unique.');
    ids.add(String(activation.id));
    const revision = requireRecord(activation.revision);
    exactKeys(revision, [
      'schemaVersion', 'revisionId', 'scope', 'sourceId', 'sourcePath', 'bundleRoot',
      'sourceOrder', 'name', 'contentDigest', 'bundleDigest',
    ]);
    if (revision.schemaVersion !== 1) throw new TypeError('Skill revision schemaVersion is invalid.');
    if (!['system', 'user', 'project', 'session'].includes(String(revision.scope))) {
      throw new TypeError('Skill revision scope is invalid.');
    }
    for (const key of ['revisionId', 'sourceId', 'sourcePath', 'bundleRoot', 'name', 'contentDigest', 'bundleDigest']) {
      requireString(revision, key);
    }
    requireNonNegativeInteger(revision, 'sourceOrder');
    if (activation.allowedTools !== undefined) requireStringArray(activation, 'allowedTools');
  }
}

function validateUsageRecorded(payload: unknown): void {
  const record = requireRecord(payload);
  exactKeys(record, [
    'scope', 'usageId', 'purpose', 'turnId', 'attemptId', 'invocationId',
    'billingMode', 'inputTokens', 'outputTokens', 'totalTokens',
  ]);
  requireEnum(record, 'scope', ['run', 'turn', 'attempt', 'tool']);
  requireString(record, 'usageId');
  requireEnum(record, 'purpose', ['agent-turn', 'context-compaction', 'tool']);
  requireEnum(record, 'billingMode', ['byok', 'managed']);
  optionalString(record, 'turnId');
  optionalString(record, 'attemptId');
  optionalString(record, 'invocationId');
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
  requireProtocolIdentity(origin);
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
      requireString(block, 'opaqueRef'); requireProtocolIdentity(block);
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
      'intentDigest', 'summary', 'resultRefs', 'evidenceRefs', 'durableSummary', 'modelProjection',
      'userProjection', 'auditEvidence', 'completionEvidence', 'error',
    ],
    ['summary'],
    ['resultRefs', 'evidenceRefs'],
  );
  requireEvidenceRefs(record);
  if (record.auditEvidence !== undefined) validateToolAuditEvidence(record.auditEvidence);
  if (record.completionEvidence !== undefined) {
    validateToolCompletionEvidence(record.completionEvidence);
  }
  if (record.error !== undefined) validateToolExecutionError(record.error);
}

function validateToolAuditEvidence(value: unknown): void {
  const record = requireRecord(value);
  exactKeys(record, [
    'status', 'durationMs', 'resultType', 'argumentSummary', 'failureKind',
  ]);
  requireEnum(record, 'status', ['success', 'denied', 'failed']);
  optionalNonNegativeInteger(record, 'durationMs');
  if (record.resultType !== undefined) requireBoundedString(record, 'resultType', 128);
  if (record.argumentSummary !== undefined) requireBoundedString(record, 'argumentSummary');
  if (record.failureKind !== undefined) {
    requireEnum(record, 'failureKind', [
      'repairable', 'timeout', 'transient_dependency', 'permission',
      'tool_unavailable', 'validation', 'unknown',
    ]);
  }
  if (Buffer.byteLength(JSON.stringify(record), 'utf8') > 4 * 1024) {
    throw new TypeError('Tool auditEvidence exceeds 4096 bytes.');
  }
}

function validateToolCompletionEvidence(value: unknown): void {
  const record = requireRecord(value);
  exactKeys(record, [
    'kind', 'deliveryReady', 'outcome', 'provenance', 'executionId', 'summary',
    'metrics', 'details',
  ]);
  requireBoundedString(record, 'kind', 128);
  if (typeof record.deliveryReady !== 'boolean') {
    throw new TypeError('Tool completionEvidence deliveryReady must be boolean.');
  }
  if (record.outcome !== undefined) {
    requireEnum(record, 'outcome', ['pending', 'succeeded', 'failed', 'cancelled']);
  }
  const provenance = requireRecord(record.provenance);
  exactKeys(provenance, [
    'issuer', 'ownerId', 'toolName', 'toolRevision', 'handlerRevision',
    'intentRevision', 'toolSource', 'sourceId', 'generation',
  ]);
  requireLiteral(provenance, 'issuer', 'runtime');
  for (const key of [
    'ownerId', 'toolName', 'toolRevision', 'handlerRevision',
    'intentRevision', 'toolSource', 'generation',
  ] as const) requireBoundedString(provenance, key, 512);
  if (provenance.sourceId !== undefined) requireBoundedString(provenance, 'sourceId', 512);
  if (record.executionId !== undefined) requireBoundedString(record, 'executionId', 2_048);
  if (record.summary !== undefined) requireBoundedString(record, 'summary');
  if (record.metrics !== undefined) {
    const metrics = requireRecord(record.metrics);
    if (Object.keys(metrics).length > 64) {
      throw new TypeError('Tool completionEvidence metrics exceed 64 entries.');
    }
    for (const [key, metric] of Object.entries(metrics)) {
      if (!key || key.length > 128) throw new TypeError('Tool evidence metric key is invalid.');
      if (
        metric !== null && typeof metric !== 'string' && typeof metric !== 'number' &&
        typeof metric !== 'boolean'
      ) {
        throw new TypeError('Tool evidence metric value must be scalar.');
      }
    }
  }
  if (record.details !== undefined) requireRecord(record.details);
  if (Buffer.byteLength(JSON.stringify(record), 'utf8') > 8 * 1024) {
    throw new TypeError('Tool completionEvidence exceeds 8192 bytes.');
  }
}

function validateCanonicalToolId(value: unknown): void {
  const record = requireRecord(value);
  exactKeys(record, ['namespace', 'name']);
  requireString(record, 'name');
  optionalString(record, 'namespace');
}

function validateToolRecoveryClass(record: Record<string, unknown>, key = 'recoveryClass'): void {
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
    exactKeys(record, ['invocationId', 'actionSummary', 'validationError']);
    requireString(record, 'invocationId');
    requireBoundedString(record, 'actionSummary');
    validateToolExecutionError(record.validationError);
    return;
  }
  exactKeys(record, [
    'invocationId', 'actionSummary', 'canonicalToolId', 'toolRevision', 'recoveryClass', 'intent', 'deadline', 'catalogRevision',
    'intentDigest', 'proposedRevision', 'permissionAudit', 'retryOf',
    'retryPermitId',
  ]);
  ['invocationId', 'toolRevision'].forEach((key) => requireString(record, key));
  requireBoundedString(record, 'actionSummary');
  optionalString(record, 'retryOf');
  optionalString(record, 'retryPermitId');
  validatePreparedIntent(record.intent as PreparedToolIntent, undefined, true);
  assertPreparedDigest(record.intent as PreparedToolIntent, String(record.intentDigest));
  requireString(record, 'catalogRevision');
  requireIsoTimestamp(record.deadline, 'deadline');
  validateCanonicalToolId(record.canonicalToolId);
  validateToolRecoveryClass(record);
  validateSha256(record, 'intentDigest');
  requireNonNegativeInteger(record, 'proposedRevision');
  if (record.permissionAudit !== undefined) validateToolPermissionAudit(record.permissionAudit);
}

function validateToolPermissionAudit(value: unknown): void {
  const audit = requireRecord(value);
  exactKeys(audit, ['mode', 'decision', 'policyRevision', 'matchedRuleIds', 'facts']);
  requireEnum(audit, 'mode', ['default', 'auto', 'full-access']);
  requireEnum(audit, 'decision', ['allow', 'ask', 'deny']);
  requireString(audit, 'policyRevision');
  requireStringArray(audit, 'matchedRuleIds');
  const facts = requireRecord(audit.facts);
  exactKeys(facts, [
    'toolName', 'dangerLevel', 'readonly', 'recoveryClass', 'access', 'unknownRisk', 'resolvedAddresses', 'targets', 'actions', 'paths', 'hosts',
    'network', 'externalWrite', 'destructive', 'credentials', 'admin',
  ]);
  requireString(facts, 'toolName');
  requireEnum(facts, 'dangerLevel', ['safe', 'medium', 'high', 'critical']);
  validateToolRecoveryClass(facts);
  requireStringArray(facts, 'actions');
  for (const action of facts.actions as unknown[]) {
    if (![
      'read', 'write', 'execute', 'network', 'delete', 'database-query',
      'database-mutation', 'database-schema', 'credential', 'admin', 'unknown',
    ].includes(String(action))) {
      throw new TypeError('Tool permission audit action is invalid.');
    }
  }
  requireStringArray(facts, 'paths', TOOL_PROTOCOL_BOUNDS.factChars, TOOL_PROTOCOL_BOUNDS.facts);
  requireStringArray(facts, 'hosts', TOOL_PROTOCOL_BOUNDS.factChars, TOOL_PROTOCOL_BOUNDS.facts);
  requireStringArray(facts, 'resolvedAddresses', TOOL_PROTOCOL_BOUNDS.factChars, TOOL_PROTOCOL_BOUNDS.facts);
  for (const key of [
    'readonly', 'network', 'externalWrite', 'destructive', 'credentials', 'admin',
  ]) {
    if (typeof facts[key] !== 'boolean') {
      throw new TypeError(`Tool permission audit ${key} must be boolean.`);
    }
  }
}

function validateToolApprovalFact(value: unknown): void {
  const record = requireRecord(value);
  exactKeys(record, [
    'approvalId', 'projectId', 'sessionId', 'runId', 'turnId', 'invocationId',
    'canonicalToolId', 'toolRevision', 'recoveryClass', 'intentDigest',
    'proposedRevision', 'status', 'decidedAt', 'decidedBy', 'reason',
  ]);
  [
    'approvalId', 'projectId', 'sessionId', 'runId', 'turnId', 'invocationId', 'toolRevision',
  ].forEach((key) => requireString(record, key));
  validateCanonicalToolId(record.canonicalToolId);
  validateToolRecoveryClass(record);
  validateSha256(record, 'intentDigest');
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
  requireBoundedString(record, 'summary');
}

function validateToolAuthorizationDecision(
  payload: unknown,
  status: 'approved' | 'denied',
): void {
  const record = requireRecord(payload);
  exactKeys(record, status === 'approved'
    ? ['intentDigest', 'approvalId', 'invocationId', 'actionSummary', 'decision']
    : ['intentDigest', 'approvalId', 'invocationId', 'actionSummary', 'reason', 'decision']);
  requireString(record, 'approvalId');
  requireString(record, 'invocationId');
  validateSha256(record, 'intentDigest');
  if (record.actionSummary !== undefined) requireBoundedString(record, 'actionSummary');
  if (status === 'denied') requireString(record, 'reason');
  if (record.decision === undefined) return;
  const decision = requireRecord(record.decision);
  exactKeys(decision, ['status', 'decidedAt', 'decidedBy', 'reason']);
  requireLiteral(decision, 'status', status);
  requirePresent(decision, 'decidedAt');
  requireIsoTimestamp(decision.decidedAt, 'decidedAt');
  optionalString(decision, 'decidedBy');
  optionalString(decision, 'reason');
}

function validateToolStarted(payload: unknown): void {
  const record = requireRecord(payload);
  exactKeys(record, [
    'intentDigest', 'access', 'concurrency', 'resourceKeys', 'invocationId', 'idempotencyKey', 'fencingToken', 'attempt', 'runRevision',
    'permissionAudit',
  ]);
  ['invocationId', 'idempotencyKey'].forEach((key) => requireString(record, key));
  requireNonNegativeInteger(record, 'fencingToken');
  requireNonNegativeInteger(record, 'attempt');
  requireNonNegativeInteger(record, 'runRevision');
  validateSha256(record, 'intentDigest');
  requireEnum(record, 'access', ['read', 'write', 'external', 'destructive']);
  requireEnum(record, 'concurrency', ['read', 'write', 'exclusive']);
  requireStringArray(record, 'resourceKeys', TOOL_PROTOCOL_BOUNDS.resourceKeyChars, TOOL_PROTOCOL_BOUNDS.resourceKeys);
  validateToolPermissionAudit(record.permissionAudit);
}

function validateToolHookFact(payload: unknown): void {
  const record = requireRecord(payload);
  exactKeys(record, ['invocationId', 'hookId', 'hookRevision', 'summary']);
  ['invocationId', 'hookId', 'hookRevision', 'summary'].forEach((key) =>
    requireString(record, key));
}

function validateToolExecutionError(value: unknown): void {
  const record = requireRecord(value);
  exactKeys(record, ['code', 'category', 'retryable', 'outcome']);
  requireEnum(record, 'code', [
    'HANDLER_FAILED', 'TOOL_TIMEOUT', 'TOOL_CANCELLED', 'INVALID_TOOL_RESULT',
    'TOOL_NOT_FOUND', 'TOOL_REVISION_MISMATCH', 'TOOL_INPUT_INVALID', 'invalid_cursor',
    'target_changed', 'conflict', 'target_changed', 'conflict', 'TOOL_RESOURCE_NOT_FOUND', 'TOOL_CONFLICT', 'TOOL_PRECONDITION_FAILED',
    'TOOL_EXTERNAL_FAILED', 'TOOL_LIMIT_EXCEEDED', 'TOOL_PERMISSION_DENIED',
    'OUTCOME_RESOLVED_FAILED',
  ]);
  requireEnum(record, 'category', [
    'internal', 'timeout', 'cancelled', 'contract', 'unavailable', 'conflict', 'validation',
    'authorization', 'external', 'precondition', 'limit', 'resolution',
  ]);
  requireEnum(record, 'outcome', ['not_applied', 'unknown']);
  if (typeof record.retryable !== 'boolean') {
    throw new TypeError('Event payload retryable must be boolean.');
  }
}

function validateToolRetryAuthorized(payload: unknown): void {
  const record = requireRecord(payload);
  exactKeys(record, [
    'invocationId', 'permitId', 'toolRevision', 'recoveryClass',
    'intentDigest', 'reason',
  ]);
  ['invocationId', 'permitId', 'toolRevision', 'reason'].forEach((key) => requireString(record, key));
  validateToolRecoveryClass(record);
  validateSha256(record, 'intentDigest');
}

function validateToolOutcomeResolved(payload: unknown): void {
  const record = requireRecord(payload);
  validateShape(
    payload,
    [
      'resolutionId', 'decisionDigest', 'invocationId', 'outcome', 'canonicalToolId', 'toolRevision',
      'recoveryClass', 'intentDigest', 'proposedRevision', 'summary', 'resultRefs',
      'evidenceRefs', 'durableSummary', 'modelProjection', 'userProjection',
      'auditEvidence', 'completionEvidence', 'error',
    ],
    ['resolutionId', 'decisionDigest', 'invocationId', 'outcome', 'toolRevision', 'summary'],
    ['resultRefs', 'evidenceRefs'],
  );
  requireEvidenceRefs(record);
  validateCanonicalToolId(record.canonicalToolId);
  validateSha256(record, 'decisionDigest');
  validateToolRecoveryClass(record);
  validateSha256(record, 'intentDigest');
  requireNonNegativeInteger(record, 'proposedRevision');
  requireEnum(record, 'outcome', ['succeeded', 'failed']);
  if (record.auditEvidence !== undefined) validateToolAuditEvidence(record.auditEvidence);
  if (record.completionEvidence !== undefined) {
    validateToolCompletionEvidence(record.completionEvidence);
  }
  if (record.error !== undefined) validateToolExecutionError(record.error);
}

function validateToolObserved(payload: unknown): void {
  const record = requireRecord(payload);
  exactKeys(record, [
    'observationId', 'invocationId', 'summary', 'evidenceRefs',
    'outcome', 'modelProjection', 'auditEvidence', 'completionEvidence', 'errorCode',
  ]);
  ['observationId', 'invocationId', 'summary'].forEach((key) => requireString(record, key));
  requireEvidenceRefs(record);
  requireEnum(record, 'outcome', [
    'succeeded', 'failed', 'cancelled', 'unknown', 'denied', 'timed_out', 'unsupported_revision',
  ]);
  if (record.auditEvidence !== undefined) validateToolAuditEvidence(record.auditEvidence);
  if (record.completionEvidence !== undefined) {
    validateToolCompletionEvidence(record.completionEvidence);
  }
  if (record.errorCode !== undefined) {
    requireEnum(record, 'errorCode', [
      'HANDLER_FAILED', 'TOOL_TIMEOUT', 'TOOL_CANCELLED', 'INVALID_TOOL_RESULT',
      'TOOL_NOT_FOUND', 'TOOL_REVISION_MISMATCH', 'TOOL_INPUT_INVALID', 'invalid_cursor',
      'target_changed', 'conflict', 'TOOL_RESOURCE_NOT_FOUND', 'TOOL_CONFLICT', 'TOOL_PRECONDITION_FAILED',
      'TOOL_EXTERNAL_FAILED', 'TOOL_LIMIT_EXCEEDED', 'TOOL_PERMISSION_DENIED',
      'OUTCOME_RESOLVED_FAILED',
    ]);
  }
}

function validateToolScheduleDecision(value: unknown): void {
  const record = requireRecord(value);
  if (record.state === 'AwaitingUser') {
    exactKeys(record, ['state', 'reason', 'invocationIds']);
    requireEnum(record, 'reason', ['approval', 'tool_input']);
  } else {
    exactKeys(record, ['state', 'invocationIds']);
    requireEnum(record, 'state', [
      'ResolvingActions', 'ExecutingTools', 'ApplyingObservations', 'TurnReadyToClose',
    ]);
  }
  if (!Array.isArray(record.invocationIds) || record.invocationIds.length > 1_000) {
    throw new TypeError('Tool schedule invocationIds must be a bounded array.');
  }
  for (const invocationId of record.invocationIds) {
    if (typeof invocationId !== 'string' || invocationId.trim() === '') {
      throw new TypeError('Tool schedule invocationId must be non-empty text.');
    }
  }
  if (record.state === 'TurnReadyToClose' && record.invocationIds.length !== 0) {
    throw new TypeError('TurnReadyToClose cannot carry Invocation identities.');
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
  'run.created': descriptor({ schemaVersion: 2, validate: validateRunCreated }),
  'run.environment_bound': descriptor({
    maxPayloadBytes: 1024 * 1024,
    validate: validateEnvironmentBound,
  }),
  'run.started': descriptor({ validate: (p) => validateShape(p, []) }),
  'run.resumed': descriptor({ schemaVersion: 2, validate: validateRunResumed }),
  'run.steered': descriptor({ audience: USER, validate: validateRunSteered }),
  'run.input_requested': descriptor({ audience: USER, validate: validateRunInputRequested }),
  'run.cancel_requested': descriptor({ validate: validateOptionalReason }),
  'run.limit_reached': descriptor({
    schemaVersion: 2, audience: USER, validate: validateRunLimitReached,
  }),
  'run.completed': descriptor({ schemaVersion: 2, audience: USER, validate: validateRunCompleted }),
  'run.failed': descriptor({ audience: USER, validate: validateRunFailure }),
  'run.cancelled': descriptor({ audience: USER, validate: validateOptionalReason }),
  'run.interrupted': descriptor({
    schemaVersion: 2, audience: USER, validate: validateRunInterrupted,
  }),
  'turn.started': descriptor({ maxPayloadBytes: 4 * 1024 * 1024, validate: validateTurnStarted }),
  'turn.context_compiled': descriptor({ validate: validateTurnContextCompiled }),
  'turn.no_progress': descriptor({
    validate: (p) => validateShape(p, ['fingerprint'], ['fingerprint']),
  }),
  model_attempt_started: descriptor({ validate: validateOriginPayload }),
  model_delta_batch: descriptor({ persistence: 'diagnostic', validate: validateModelDeltaBatch }),
  model_block_completed: descriptor({ persistence: 'diagnostic', validate: validateModelBlockCompleted }),
  model_attempt_committed: descriptor({
    audience: MODEL,
    maxPayloadBytes: 16 * 1024 * 1024,
    validate: validateCommittedAttempt,
  }),
  model_attempt_discarded: descriptor({ validate: (p) => validateShape(p, ['reason'], ['reason']) }),
  model_failed: descriptor({ validate: validateModelFailure }),
  'turn.closed': descriptor({ validate: (p) => validateShape(p, ['reason'], ['reason']) }),
  'delivery.decided': descriptor({
    schemaVersion: 2,
    maxPayloadBytes: 72 * 1024,
    validate: validateDeliveryDecision,
  }),
  'plan.created': descriptor({ validate: validatePlanFact }),
  'plan.updated': descriptor({ validate: validatePlanFact }),
  'tool.activated': descriptor({ validate: (payload) => {
    const record = requireRecord(payload);
    exactKeys(record, ['tools']);
    validateToolActivations(record.tools);
  } }),
  'tool.proposed': descriptor({ audience: MODEL, validate: validateToolProposed }),
  'tool.permission_evaluated': descriptor({ maxPayloadBytes: TOOL_PROTOCOL_BOUNDS.journalEventBytes, validate: (payload) => {
    const record = requireRecord(payload);
    exactKeys(record, ['invocationId', 'intentDigest', 'permissionAudit', 'retryOf', 'retryPermitId']);
    requireString(record, 'invocationId'); validateSha256(record, 'intentDigest');
    validateToolPermissionAudit(record.permissionAudit); optionalString(record, 'retryOf'); optionalString(record, 'retryPermitId');
  } }),
  'tool.prepared': descriptor({ schemaVersion: 3, maxPayloadBytes: TOOL_PROTOCOL_BOUNDS.journalEventBytes, validate: validateToolValidated }),
  'tool.approval_requested': descriptor({ audience: USER, validate: validateToolApprovalRequested }),
  'tool.authorized': descriptor({
    validate: (payload) => validateToolAuthorizationDecision(payload, 'approved'),
  }),
  'tool.denied': descriptor({
    audience: MODEL,
    validate: (payload) => validateToolAuthorizationDecision(payload, 'denied'),
  }),
  'tool.timed_out': descriptor({ audience: MODEL, validate: validateToolTerminal }),
  'tool.unsupported_revision': descriptor({ audience: MODEL, validate: validateToolTerminal }),
  'tool.waiting_for_user': descriptor({ audience: USER, validate: (payload) => {
    const record = requireRecord(payload);
    exactKeys(record, ['invocationId', 'intentDigest', 'questionId', 'questionRevision', 'bundle']);
    requireString(record, 'invocationId'); requireString(record, 'questionId');
    validateSha256(record, 'intentDigest'); requireNonNegativeInteger(record, 'questionRevision');
    validateToolQuestionBundle(record.bundle);
    if (record.questionId !== record.bundle.questionId || record.questionRevision !== record.bundle.questionRevision) throw new TypeError('Question event identity mismatch.');
  } }),
  'tool.started': descriptor({ schemaVersion: 3, maxPayloadBytes: TOOL_PROTOCOL_BOUNDS.journalEventBytes, validate: validateToolStarted }),
  'tool.progress': descriptor({
    audience: USER,
    persistence: 'diagnostic',
    maxPayloadBytes: 8 * 1024,
    validate: (payload) => {
      const record = requireRecord(payload);
      exactKeys(record, ['invocationId', 'summary']);
      requireBoundedString(record, 'invocationId', 512);
      requireBoundedString(record, 'summary', 4_096);
    },
  }),
  'tool.hook_rejected': descriptor({ audience: USER, validate: validateToolHookFact }),
  'tool.hook_warning': descriptor({ audience: USER, validate: validateToolHookFact }),
  'tool.succeeded': descriptor({ schemaVersion: 2, validate: validateToolTerminal }),
  'tool.failed': descriptor({ schemaVersion: 2, validate: validateToolTerminal }),
  'tool.cancelled': descriptor({ schemaVersion: 2, validate: validateToolTerminal }),
  'tool.unknown': descriptor({
    schemaVersion: 2, audience: MODEL, validate: validateToolTerminal,
  }),
  'tool.outcome_resolution_requested': descriptor({ audience: USER, validate: (p) => validateShape(p, ['invocationId', 'summary'], ['invocationId', 'summary']) }),
  'tool.outcome_resolved': descriptor({
    schemaVersion: 2, audience: MODEL, validate: validateToolOutcomeResolved,
  }),
  'tool.retry_authorized': descriptor({ validate: validateToolRetryAuthorized }),
  'tool.observed': descriptor({ schemaVersion: 2, audience: MODEL, validate: validateToolObserved }),
  'tool.transition_committed': descriptor({
    validate: (payload) => {
      const record = requireRecord(payload);
      exactKeys(record, ['action', 'schedule']);
      requireEnum(record, 'action', [
        'prepare', 'wait-for-user', 'settle-question', 'validate', 'reject-validation', 'decide-approval', 'start', 'finish',
        'observe', 'authorize-retry', 'resolve-outcome',
      ]);
      validateToolScheduleDecision(record.schedule);
    },
  }),
  'context.compaction_requested': descriptor({
    validate: (payload) => validateShape(payload, ['decisionId'], ['decisionId']),
  }),
  'context.compaction_started': descriptor({
    schemaVersion: 2,
    validate: (payload) => {
      const record = requireRecord(payload);
      exactKeys(record, ['checkpointId', 'decisionId', 'reason', 'coveredSequence']);
      requireString(record, 'checkpointId');
      requireString(record, 'decisionId');
      requireEnum(record, 'reason', ['automatic', 'manual']);
      requireNonNegativeInteger(record, 'coveredSequence');
    },
  }),
  'context.compacted': descriptor({
    schemaVersion: 3,
    maxPayloadBytes: 512 * 1024,
    validate: (payload) => {
      const record = requireRecord(payload);
      exactKeys(record, [
        'checkpointId', 'decisionId', 'summaryRef', 'summary', 'coveredSequence', 'attemptId',
        'usage',
      ]);
      requireString(record, 'checkpointId');
      requireString(record, 'decisionId');
      requireString(record, 'summaryRef');
      requireString(record, 'summary');
      requireNonNegativeInteger(record, 'coveredSequence');
      requireString(record, 'attemptId');
      if (record.usage !== undefined) validateUsage(record.usage);
    },
  }),
  'context.compaction_failed': descriptor({
    schemaVersion: 2,
    validate: (payload) => validateShape(
      payload,
      ['checkpointId', 'decisionId', 'code'],
      ['checkpointId', 'decisionId', 'code'],
    ),
  }),
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
  'capability.discovered': descriptor({ validate: (p) => {
    const record = requireRecord(p);
    exactKeys(record, ['targets']);
    validateCapabilityDiscoveryTargets(record.targets);
  } }),
  'capability.snapshot_captured': descriptor({ validate: (p) => validateShape(p, ['snapshotId', 'revision'], ['snapshotId', 'revision']) }),
  'subagent.started': descriptor({ audience: USER, validate: (p) => validateShape(p, ['subagentId', 'summary'], ['subagentId', 'summary']) }),
  'subagent.steered': descriptor({ audience: USER, validate: (p) => validateShape(p, ['subagentId', 'summary'], ['subagentId', 'summary']) }),
  'subagent.completed': descriptor({ audience: USER, validate: (p) => validateShape(p, ['subagentId', 'summary', 'refs'], ['subagentId', 'summary'], ['refs']) }),
  'subagent.failed': descriptor({ audience: USER, validate: (p) => validateShape(p, ['subagentId', 'code', 'summary'], ['subagentId', 'code', 'summary']) }),
  'subagent.cancelled': descriptor({ audience: USER, validate: (p) => validateShape(p, ['subagentId', 'reason'], ['subagentId', 'reason']) }),
  'runtime.command_applied': descriptor({ schemaVersion: 2, validate: validateRuntimeCommandApplied }),
  'usage.recorded': descriptor({ schemaVersion: 3, validate: validateUsageRecorded }),
} satisfies AgentEventSchemaRegistry);

export function isAgentEventType(value: string): value is AgentEventType {
  return Object.hasOwn(AGENT_EVENT_SCHEMA_REGISTRY, value);
}

export function validateAndSnapshotEventPayload<T extends AgentEventType>(
  type: T,
  payload: unknown,
): AgentEventPayloadMap[T] {
  const schema: AgentEventSchemaDescriptor<T> = AGENT_EVENT_SCHEMA_REGISTRY[
    type
  ] as AgentEventSchemaDescriptor<T>;
  schema.validate(payload);
  return schema.snapshot(payload as AgentEventPayloadMap[T]);
}
