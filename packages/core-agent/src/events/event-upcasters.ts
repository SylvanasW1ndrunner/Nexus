import { createHash } from 'node:crypto';
import type { PortableValue } from '@dbagent/shared';
import type { AgentMode } from '../types.js';
import type { AgentEvent, AgentEventPayloadMap, AgentEventType } from './agent-event.js';
import {
  AGENT_EVENT_SCHEMA_REGISTRY,
  validateAndSnapshotEventPayload,
} from './event-schema-registry.js';

export type StoredAgentEvent<T extends AgentEventType = AgentEventType> = Omit<
  AgentEvent<T>,
  'payload' | 'schemaVersion'
> & { schemaVersion: number; payload: PortableValue };

export type AgentEventUpcaster<T extends AgentEventType> = (
  schemaVersion: number,
  payload: PortableValue,
) => AgentEventPayloadMap[T];

export type AgentEventUpcasterRegistry = {
  readonly [T in AgentEventType]: AgentEventUpcaster<T>;
};

function currentVersionUpcaster<T extends AgentEventType>(type: T): AgentEventUpcaster<T> {
  return (schemaVersion, payload) => {
    const current = AGENT_EVENT_SCHEMA_REGISTRY[type].schemaVersion;
    if (schemaVersion === 1 && type === 'run.created') {
      const legacy = legacyRecord(payload, 'run.created v1 payload');
      const configuration = legacy.configuration === undefined
        ? undefined
        : legacyRecord(legacy.configuration, 'run.created v1 configuration');
      const roleInstructions = configuration?.roleInstructions;
      if (roleInstructions !== undefined && typeof roleInstructions !== 'string') {
        throw new Error('run.created v1 roleInstructions must be a string.');
      }
      const withoutRoleInstructions = { ...(configuration ?? {}) };
      delete withoutRoleInstructions.roleInstructions;
      return validateAndSnapshotEventPayload(type, {
        ...legacy,
        ...(configuration === undefined
          ? {}
          : {
            configuration: {
              ...withoutRoleInstructions,
              ...(roleInstructions === undefined || withoutRoleInstructions.rolePrompt !== undefined
                ? {}
                : { rolePrompt: { run: { mode: 'replace', content: roleInstructions } } }),
            },
          }),
      });
    }
    if (schemaVersion === 1 && type === 'run.resumed') {
      const legacy = legacyRecord(payload, 'run.resumed v1 payload');
      legacyExactKeys(legacy, [], ['reason']);
      return validateAndSnapshotEventPayload(type, {
        resumeState: 'Preparing',
        ...(legacy.reason === undefined
          ? {}
          : { reason: legacyString(legacy.reason, 'reason') }),
      });
    }
    if (schemaVersion === 1 && type === 'run.limit_reached') {
      const legacy = legacyRecord(payload, 'run.limit_reached v1 payload');
      legacyExactKeys(legacy, ['limit'], ['value']);
      return validateAndSnapshotEventPayload(type, {
        limit: legacyString(legacy.limit, 'limit'),
        ...(legacy.value === undefined
          ? {}
          : { value: legacyNonNegativeInteger(legacy.value, 'value') }),
        resumeState: 'Preparing',
      });
    }
    if (schemaVersion === 1 && type === 'run.interrupted') {
      const legacy = legacyRecord(payload, 'run.interrupted v1 payload');
      legacyExactKeys(legacy, ['code'], ['detail']);
      return validateAndSnapshotEventPayload(type, {
        code: legacyString(legacy.code, 'code'),
        ...(legacy.detail === undefined ? {} : { detail: legacy.detail }),
        resumeState: 'Preparing',
      });
    }
    if (schemaVersion === 1 && type === 'context.compaction_started') {
      const legacy = legacyRecord(payload, 'context.compaction_started v1 payload');
      const checkpointId = legacyString(legacy.checkpointId, 'checkpointId');
      return validateAndSnapshotEventPayload(type, {
        checkpointId,
        decisionId: checkpointId,
        reason: 'automatic',
        coveredSequence: 0,
      });
    }
    if (schemaVersion === 1 && type === 'context.compacted') {
      const legacy = legacyRecord(payload, 'context.compacted v1 payload');
      const checkpointId = legacyString(legacy.checkpointId, 'checkpointId');
      const summaryRef = legacyString(legacy.summaryRef, 'summaryRef');
      return validateAndSnapshotEventPayload(type, {
        checkpointId,
        decisionId: checkpointId,
        summaryRef,
        summary: `Legacy context checkpoint: ${summaryRef}`,
        coveredSequence: legacyNonNegativeInteger(
          legacy.coveredSequence,
          'coveredSequence',
        ),
        attemptId: `legacy-context-${checkpointId}`,
      });
    }
    if (schemaVersion === 2 && type === 'context.compacted') {
      return validateAndSnapshotEventPayload(type, payload);
    }
    if (schemaVersion === 1 && type === 'context.compaction_failed') {
      const legacy = legacyRecord(payload, 'context.compaction_failed v1 payload');
      const checkpointId = legacyString(legacy.checkpointId, 'checkpointId');
      return validateAndSnapshotEventPayload(type, {
        checkpointId,
        decisionId: checkpointId,
        code: legacyString(legacy.code, 'code'),
      });
    }
    if (schemaVersion === 1 && type === 'usage.recorded') {
      const legacy = legacyRecord(payload, 'usage.recorded v1 payload');
      const encoded = JSON.stringify(legacy);
      return validateAndSnapshotEventPayload(type, {
        scope: legacyEnum(
          legacy.scope,
          ['run', 'turn', 'attempt', 'tool'] as const,
          'usage scope',
        ),
        usageId: `legacy-usage-${createHash('sha256').update(encoded).digest('hex')}`,
        purpose: legacy.scope === 'tool' ? 'tool' : 'agent-turn',
        billingMode: 'byok',
        inputTokens: legacyNonNegativeInteger(legacy.inputTokens, 'inputTokens'),
        outputTokens: legacyNonNegativeInteger(legacy.outputTokens, 'outputTokens'),
        totalTokens: legacyNonNegativeInteger(legacy.totalTokens, 'totalTokens'),
      });
    }
    if (schemaVersion === 2 && type === 'usage.recorded') {
      const legacy = legacyRecord(payload, 'usage.recorded v2 payload');
      return validateAndSnapshotEventPayload(type, { ...legacy, billingMode: 'byok' });
    }
    if (schemaVersion === 1 && type === 'runtime.command_applied') {
      const legacy = legacyRecord(payload, 'runtime.command_applied v1 payload');
      legacyExactKeys(legacy, [
        'commandId', 'kind', 'origin', 'expectedRunRevision', 'fencingToken',
        'projectionRevision', 'effect',
      ]);
      const kind = legacyEnum(legacy.kind, [
        'plan.create', 'plan.update', 'skill.activate',
        'child.start', 'child.list', 'child.wait', 'child.steer', 'child.cancel',
      ] as const, 'Runtime Command kind');
      const effect = legacyRecord(legacy.effect ?? null, 'Runtime Command effect');
      let upgradedEffect: PortableValue = effect;
      if (kind === 'child.start') {
        legacyExactKeys(effect, ['childRunId', 'task', 'context', 'status']);
        upgradedEffect = { ...effect, revision: 1 };
      } else if (kind === 'child.steer') {
        legacyExactKeys(effect, ['childRunId', 'input']);
        // Zero is a durable legacy sentinel: replay derives the next child revision.
        upgradedEffect = { ...effect, revision: 0 };
      } else if (kind === 'child.cancel') {
        legacyExactKeys(effect, ['childRunId', 'reason']);
        upgradedEffect = { ...effect, revision: 0 };
      } else if (kind === 'skill.activate') {
        legacyExactKeys(effect, ['ids']);
        const ids = legacyStringArray(effect.ids, 'Skill activation ids');
        upgradedEffect = { activations: ids.map(legacySkillActivation) };
      }
      return validateAndSnapshotEventPayload(type, {
        ...legacy,
        kind,
        effect: upgradedEffect,
      });
    }
    if (type === 'legacy.imported' && schemaVersion === 1) {
      return validateAndSnapshotEventPayload(type, upcastLegacyImportedV1(payload));
    }
    if (type === 'artifact.created' && schemaVersion === 1) {
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('CORRUPT_EVENT:artifact.created legacy payload is invalid.');
      }
      const legacy = payload as Record<string, unknown>;
      if (
        typeof legacy.artifactId !== 'string' ||
        typeof legacy.mediaType !== 'string' ||
        typeof legacy.summary !== 'string'
      ) {
        throw new Error('CORRUPT_EVENT:artifact.created legacy payload is incomplete.');
      }
      const legacyDigest = createHash('sha256')
        .update(`legacy-artifact\0${legacy.artifactId}`)
        .digest('hex');
      return validateAndSnapshotEventPayload(type, {
        artifactId: `artifact_${legacyDigest}`,
        handle: `legacy-agent-artifact:${legacyDigest}`,
        checksum: null,
        byteSize: null,
        mediaType: legacy.mediaType,
        availability: 'legacy-unavailable',
        summary: legacy.summary,
      });
    }
    if (type === 'run.completed' && schemaVersion === 1) {
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('CORRUPT_EVENT:run.completed v1 payload is invalid.');
      }
      const legacy = payload as Record<string, PortableValue>;
      const deliveryStatus = legacy.deliveryStatus;
      if (
        deliveryStatus !== 'delivered' &&
        deliveryStatus !== 'pending' &&
        deliveryStatus !== 'failed'
      ) {
        throw new Error('CORRUPT_EVENT:run.completed v1 delivery status is invalid.');
      }
      return validateAndSnapshotEventPayload(type, {
        finalContentRef: legacy.finalContentRef,
        deliveryStatus: deliveryStatus === 'delivered' ? 'not-required' : 'unverified',
        evidenceRefs: legacy.evidenceRefs,
      });
    }
    if (type === 'delivery.decided' && schemaVersion === 1) {
      const legacy = legacyRecord(payload, 'delivery.decided v1 payload');
      legacyExactKeys(legacy, [
        'evidenceRevision', 'status', 'outcome', 'evidenceRefs',
      ], ['verifierId', 'verifierRevision', 'reason']);
      const outcome = legacyEnum(
        legacy.outcome,
        ['accepted', 'revision-requested', 'failed'] as const,
        'delivery outcome',
      );
      const reason = legacy.reason === undefined
        ? undefined
        : legacyString(legacy.reason, 'delivery reason');
      return validateAndSnapshotEventPayload(type, {
        evidenceRevision: legacyNonNegativeInteger(
          legacy.evidenceRevision,
          'delivery evidenceRevision',
        ),
        status: legacyEnum(
          legacy.status,
          ['not-required', 'verified', 'unverified'] as const,
          'delivery status',
        ),
        outcome,
        ...(legacy.verifierId === undefined
          ? {}
          : { verifierId: legacyString(legacy.verifierId, 'delivery verifierId') }),
        ...(legacy.verifierRevision === undefined
          ? {}
          : {
              verifierRevision: legacyString(
                legacy.verifierRevision,
                'delivery verifierRevision',
              ),
            }),
        evidenceRefs: legacyStringArray(legacy.evidenceRefs, 'delivery evidenceRefs'),
        ...(reason === undefined ? {} : { reason }),
        ...(outcome === 'revision-requested'
          ? {
              observation: {
                code: 'DELIVERY_REVISION_REQUIRED_LEGACY',
                ...(reason === undefined ? {} : { detail: reason }),
              },
            }
          : {}),
      });
    }
    if (type === 'artifact.created' && schemaVersion === 2) {
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('CORRUPT_EVENT:artifact.created v2 payload is invalid.');
      }
      const prior = payload as Record<string, PortableValue>;
      if (prior.availability === 'legacy-unavailable' && typeof prior.artifactId === 'string') {
        const digest = prior.artifactId.startsWith('artifact_')
          ? prior.artifactId.slice('artifact_'.length)
          : createHash('sha256').update(`legacy-artifact\0${prior.artifactId}`).digest('hex');
        return validateAndSnapshotEventPayload(type, {
          ...prior,
          artifactId: `artifact_${digest}`,
          handle: `legacy-agent-artifact:${digest}`,
        });
      }
      return validateAndSnapshotEventPayload(type, prior);
    }
    if (schemaVersion !== current) {
      throw new Error(`UNSUPPORTED_EVENT_SCHEMA:${type}:${schemaVersion}`);
    }
    return validateAndSnapshotEventPayload(type, payload);
  };
}

/** Old id-only activations cannot be made exact; preserve an explicit durable
 * placeholder so recovery produces an integrity error instead of omitting a
 * promised Skill body. New facts always carry the complete cache reference. */
function legacySkillActivation(id: string): PortableValue {
  const match = /^skill:(system|user|project|session):([^:]+):([a-f0-9]{64})$/u.exec(id);
  const scope = match?.[1] ?? 'system';
  const name = match?.[2] ?? 'legacy-skill';
  const revisionId = match?.[3] ?? createHash('sha256').update(id).digest('hex');
  return {
    id,
    revision: {
      schemaVersion: 1,
      revisionId,
      scope,
      sourceId: 'legacy-id-only-activation',
      sourcePath: 'legacy-id-only-activation',
      bundleRoot: 'legacy-id-only-activation',
      sourceOrder: 0,
      name,
      contentDigest: revisionId,
      bundleDigest: revisionId,
    },
  };
}

const LEGACY_EPOCH = '1970-01-01T00:00:00.000Z';

function upcastLegacyImportedV1(payload: PortableValue): AgentEventPayloadMap['legacy.imported'] {
  const record = legacyRecord(payload, 'legacy.imported v1 payload');
  const entityType = legacyEnum(record.entityType, [
    'session', 'message', 'run', 'preference', 'checkpoint', 'subagent', 'diagnostic', 'archive',
  ] as const, 'legacy entityType');
  const legacyId = legacyString(record.legacyId, 'legacyId');
  switch (entityType) {
    case 'session': {
      legacyExactKeys(record, [
        'entityType', 'legacyId', 'projectKey', 'projectRoot', 'title', 'userId', 'mode',
      ]);
      const userId = legacyNullableString(record.userId, 'session userId');
      return {
        entityType, legacyId,
        projectKey: legacyString(record.projectKey, 'session projectKey'),
        projectRoot: legacyString(record.projectRoot, 'session projectRoot'),
        record: {
          session: {
            id: legacyId,
            title: legacyString(record.title, 'session title'),
            ...(userId === null ? {} : { userId }),
            mode: legacyMode(record.mode),
            messages: [],
            tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            aborted: false,
          },
          archived: false,
          createdAt: LEGACY_EPOCH,
          updatedAt: LEGACY_EPOCH,
          lastMessageAt: null,
        },
      };
    }
    case 'message': {
      const role = legacyEnum(
        record.role, ['user', 'assistant', 'tool', 'system'] as const, 'message role',
      );
      const base = {
        entityType, legacyId,
        messageIndex: legacyNonNegativeInteger(record.messageIndex, 'messageIndex'),
        sourceRunId: `legacy-session:${legacyMessageSessionId(legacyId)}`,
      };
      const content = legacyString(record.content, 'message content');
      const createdAt = legacyString(record.createdAt, 'message createdAt');
      switch (role) {
        case 'assistant':
          legacyExactKeys(record, [
            'entityType', 'legacyId', 'messageIndex', 'role', 'content', 'createdAt',
          ], ['toolCalls']);
          return {
            ...base,
            record: {
              role, content, createdAt,
              ...(record.toolCalls === undefined ? {} : { toolCalls: legacyToolCalls(record.toolCalls) }),
            },
          };
        case 'tool':
          legacyExactKeys(record, [
            'entityType', 'legacyId', 'messageIndex', 'role', 'content', 'createdAt',
            'toolCallId', 'toolName',
          ]);
          return {
            ...base,
            record: {
              role, content, createdAt,
              toolCallId: legacyString(record.toolCallId, 'message toolCallId'),
              toolName: legacyString(record.toolName, 'message toolName'),
            },
          };
        case 'user':
        case 'system':
          legacyExactKeys(record, [
            'entityType', 'legacyId', 'messageIndex', 'role', 'content', 'createdAt',
          ]);
          return { ...base, record: { role, content, createdAt } };
        default:
          return legacyAssertNever(role);
      }
    }
    case 'run': {
      legacyExactKeys(record, [
        'entityType', 'legacyId', 'sessionId', 'status', 'plan', 'createdAt', 'updatedAt',
      ]);
      const historicalStatus = legacyEnum(
        record.status, ['completed', 'interrupted_legacy'] as const, 'run status',
      );
      const status = historicalStatus === 'completed' ? 'done' : 'interrupted';
      const createdAt = legacyString(record.createdAt, 'run createdAt');
      const updatedAt = legacyString(record.updatedAt, 'run updatedAt');
      return {
        entityType, legacyId, sourceStatus: status,
        legacyPlan: record.plan ?? null,
        record: {
          runId: legacyId,
          sessionId: legacyString(record.sessionId, 'run sessionId'),
          status,
          phase: historicalStatus === 'completed' ? 'done' : 'act',
          iteration: 0,
          finalText: '',
          toolExecutions: [],
          createdAt,
          updatedAt,
        },
      };
    }
    case 'preference': {
      legacyExactKeys(record, [
        'entityType', 'legacyId', 'userId', 'key', 'value', 'confidence', 'sourceSessionId',
      ]);
      const sourceSessionId = legacyNullableString(record.sourceSessionId, 'preference sourceSessionId');
      return {
        entityType, legacyId,
        record: {
          id: legacyId,
          userId: legacyString(record.userId, 'preference userId'),
          key: legacyString(record.key, 'preference key'),
          value: legacyString(record.value, 'preference value'),
          confidence: legacyFiniteNumber(record.confidence, 'preference confidence'),
          ...(sourceSessionId === null ? {} : { sourceSessionId }),
          createdAt: LEGACY_EPOCH,
          updatedAt: LEGACY_EPOCH,
        },
      };
    }
    case 'checkpoint':
      legacyExactKeys(record, [
        'entityType', 'legacyId', 'sessionId', 'sequence', 'summary', 'createdAt',
      ]);
      return {
        entityType, legacyId,
        sessionId: legacyString(record.sessionId, 'checkpoint sessionId'),
        record: {
          version: 1,
          sequence: legacyPositiveInteger(record.sequence, 'checkpoint sequence'),
          trigger: 'auto',
          method: 'deterministic-fallback',
          summary: legacyString(record.summary, 'checkpoint summary'),
          coveredConversationMessageCount: 0,
          sourceTokenEstimate: 0,
          summaryTokenEstimate: 0,
          modelContextTokens: null,
          createdAt: legacyString(record.createdAt, 'checkpoint createdAt'),
        },
      };
    case 'subagent': {
      legacyExactKeys(record, [
        'entityType', 'legacyId', 'parentSessionId', 'childSessionId', 'status', 'depth',
      ]);
      const childSessionId = legacyNullableString(record.childSessionId, 'subagent childSessionId');
      return {
        entityType, legacyId,
        record: {
          id: legacyId,
          parentSessionId: legacyString(record.parentSessionId, 'subagent parentSessionId'),
          ...(childSessionId === null ? {} : { childSessionId }),
          task: 'Legacy subagent task unavailable',
          contextStrategy: 'fresh',
          status: legacySubagentStatus(record.status),
          depth: legacyPositiveInteger(record.depth, 'subagent depth'),
          createdAt: LEGACY_EPOCH,
          updatedAt: LEGACY_EPOCH,
        },
      };
    }
    case 'diagnostic':
      legacyExactKeys(record, ['entityType', 'legacyId', 'code', 'evidence']);
      return {
        entityType, legacyId,
        code: legacyString(record.code, 'diagnostic code'),
        evidence: legacyString(record.evidence, 'diagnostic evidence'),
      };
    case 'archive':
      legacyExactKeys(record, [
        'entityType', 'legacyId', 'relativePath', 'archiveHandle', 'checksum', 'byteSize',
      ]);
      return {
        entityType, legacyId,
        relativePath: legacyString(record.relativePath, 'archive relativePath'),
        archiveHandle: legacyString(record.archiveHandle, 'archive handle'),
        checksum: legacyString(record.checksum, 'archive checksum'),
        byteSize: legacyNonNegativeInteger(record.byteSize, 'archive byteSize'),
      };
    default:
      return legacyAssertNever(entityType);
  }
}

function legacyRecord(value: PortableValue, label: string): { [key: string]: PortableValue } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`CORRUPT_EVENT:${label} must be an object.`);
  }
  return value;
}

function legacyExactKeys(
  record: { [key: string]: PortableValue },
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const actual = Object.keys(record).sort();
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(record, key)) ||
    actual.some((key) => !allowed.has(key))) {
    throw new Error(`CORRUPT_EVENT:legacy.imported v1 keys are invalid: ${actual.join(',')}.`);
  }
}

function legacyString(value: PortableValue | undefined, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`CORRUPT_EVENT:${label} must be a non-empty string.`);
  }
  return value;
}

function legacyNullableString(value: PortableValue | undefined, label: string): string | null {
  if (value === null) return null;
  return legacyString(value, label);
}

function legacyStringArray(value: PortableValue | undefined, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`CORRUPT_EVENT:${label} must be an array.`);
  return value.map((item, index) => legacyString(item, `${label}[${index}]`));
}

function legacyEnum<const T extends readonly string[]>(
  value: PortableValue | undefined,
  allowed: T,
  label: string,
): T[number] {
  const parsed = legacyString(value, label);
  const matched = allowed.find((candidate) => candidate === parsed);
  if (matched === undefined) throw new Error(`CORRUPT_EVENT:${label} is invalid.`);
  return matched;
}

function legacyNonNegativeInteger(value: PortableValue | undefined, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`CORRUPT_EVENT:${label} must be a non-negative integer.`);
  }
  return value;
}

function legacyPositiveInteger(value: PortableValue | undefined, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`CORRUPT_EVENT:${label} must be a positive integer.`);
  }
  return value;
}

function legacyFiniteNumber(value: PortableValue | undefined, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`CORRUPT_EVENT:${label} must be finite.`);
  }
  return value;
}

function legacyMode(value: PortableValue | undefined): AgentMode {
  if (value === 'default' || value === 'auto' || value === 'full-access') return value;
  const legacy = legacyEnum(value, ['read', 'edit', 'full'] as const, 'session mode');
  return legacy === 'full' ? 'full-access' : 'default';
}

function legacySubagentStatus(
  value: PortableValue | undefined,
): 'running' | 'completed' | 'failed' | 'cancelled' {
  return legacyEnum(
    value, ['running', 'completed', 'failed', 'cancelled'] as const, 'subagent status',
  );
}

function legacyMessageSessionId(legacyId: string): string {
  const delimiter = legacyId.lastIndexOf(':');
  return delimiter > 0 ? legacyId.slice(0, delimiter) : legacyId;
}

function legacyToolCalls(value: PortableValue): Array<{
  id: string; name: string; arguments: Record<string, PortableValue>;
}> {
  if (!Array.isArray(value)) throw new Error('CORRUPT_EVENT:message toolCalls must be an array.');
  return value.map((item) => {
    const call = legacyRecord(item, 'message ToolCall');
    legacyExactKeys(call, ['id', 'name', 'arguments']);
    return {
      id: legacyString(call.id, 'ToolCall id'),
      name: legacyString(call.name, 'ToolCall name'),
      arguments: legacyRecord(call.arguments ?? null, 'ToolCall arguments'),
    };
  });
}

function legacyAssertNever(value: never): never {
  throw new Error(`CORRUPT_EVENT:unsupported legacy discriminant ${String(value)}.`);
}

export const AGENT_EVENT_UPCASTERS = Object.freeze(
  Object.fromEntries(
    Object.keys(AGENT_EVENT_SCHEMA_REGISTRY).map((type) => [
      type,
      currentVersionUpcaster(type as AgentEventType),
    ]),
  ),
) as AgentEventUpcasterRegistry;

export function upcastAgentEvent<T extends AgentEventType>(event: StoredAgentEvent<T>): AgentEvent<T> {
  const payload = AGENT_EVENT_UPCASTERS[event.type](event.schemaVersion, event.payload);
  return {
    ...structuredClone(event),
    schemaVersion: AGENT_EVENT_SCHEMA_REGISTRY[event.type].schemaVersion,
    payload,
  } as AgentEvent<T>;
}
