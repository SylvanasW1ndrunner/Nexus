import { Buffer } from 'node:buffer';
import {
  CURRENT_CONTRACT_VERSION,
  SUPPORTED_CONTRACT_VERSIONS,
  type ContractEnvelope,
  type ContractValidationIssue,
  type PortableValue,
} from './common.js';
import type {
  ConnectionProfile,
  DatabaseAccessError,
  QuerySubmission,
} from './database.js';
import type {
  ResourceChangeSet,
  ResourceDescriptor,
  ResourceEvent,
  ResourceObservation,
  ResourceRegistrySnapshot,
  ResourceRelation,
  ResourceSource,
} from './resource.js';

const DATABASE_ERROR_CATEGORIES = new Set([
  'validation',
  'authentication',
  'authorization',
  'network',
  'timeout',
  'rate-limit',
  'quota',
  'syntax',
  'transaction',
  'lock',
  'cancelled',
  'unsupported',
  'not-found',
  'conflict',
  'provider',
  'internal',
]);
const RESOURCE_EVENT_TYPES = new Set([
  'resource-created',
  'resource-updated',
  'resource-deleted',
  'resource-restored',
  'resource-bound',
  'relation-created',
  'relation-updated',
  'relation-deleted',
  'observation-recorded',
  'change-set-applied',
]);

export class ContractValidationError extends Error {
  readonly issues: ContractValidationIssue[];

  constructor(issues: ContractValidationIssue[]) {
    super(
      issues.length === 1
        ? `${issues[0]!.path}: ${issues[0]!.message}`
        : `Contract validation failed with ${issues.length} issues`,
    );
    this.name = 'ContractValidationError';
    this.issues = issues.map((issue) => ({ ...issue }));
  }
}

export function assertContractEnvelope(
  value: unknown,
  expectedContract?: string,
): asserts value is ContractEnvelope<unknown> {
  const record = requireRecord(value, '$');
  const contract = requireNonEmptyString(record.contract, '$.contract');
  const version = requireNonEmptyString(record.version, '$.version');
  if (!(SUPPORTED_CONTRACT_VERSIONS as readonly string[]).includes(version)) {
    fail('UNSUPPORTED_VERSION', '$.version', `Unsupported contract version ${version}`);
  }
  if (expectedContract !== undefined && contract !== expectedContract) {
    fail('INVALID_VALUE', '$.contract', `Expected contract ${expectedContract}`);
  }
  if (!Object.hasOwn(record, 'payload')) {
    fail('MISSING_FIELD', '$.payload', 'Contract payload is required');
  }
}

export function toPortableValue(value: unknown): PortableValue {
  return encodePortable(value, '$', new WeakSet<object>());
}

export function fromPortableValue(value: PortableValue): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => fromPortableValue(item));
  }
  if (isExactTag(value, 'bigint', ['$schemanautType', 'value'])) {
    if (!/^-?\d+$/u.test(value.value)) {
      fail('INVALID_VALUE', '$.value', 'Invalid bigint transport value');
    }
    return BigInt(value.value);
  }
  if (isExactTag(value, 'datetime', ['$schemanautType', 'value'])) {
    requireIsoTime(value.value, '$.value');
    return new Date(value.value);
  }
  if (
    isExactTag(value, 'binary', ['$schemanautType', 'encoding', 'value']) &&
    value.encoding === 'base64'
  ) {
    if (!isCanonicalBase64(value.value)) {
      fail('INVALID_VALUE', '$.value', 'Invalid base64 transport value');
    }
    return Uint8Array.from(Buffer.from(value.value, 'base64'));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, fromPortableValue(item)]),
  );
}

export function stringifyPublicJson(value: unknown, space?: number): string {
  return JSON.stringify(toPortableValue(value), undefined, space);
}

export function parsePublicJson(value: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    fail('INVALID_VALUE', '$', 'Invalid JSON');
  }
  return fromPortableValue(parsed as PortableValue);
}

export function assertPortableValue(value: unknown, path = '$'): asserts value is PortableValue {
  encodePortable(value, path, new WeakSet<object>());
}

export function assertResourceDescriptor(
  value: unknown,
): asserts value is ResourceDescriptor {
  const resource = requireRecord(value, '$');
  requireNonEmptyString(resource.id, '$.id');
  requireNonEmptyString(resource.kind, '$.kind');
  requireNonEmptyString(resource.nativeId, '$.nativeId');
  requireNonEmptyString(resource.canonicalName, '$.canonicalName');
  requirePositiveInteger(resource.version, '$.version');
  const firstSeenAt = requireIsoTime(resource.firstSeenAt, '$.firstSeenAt');
  const updatedAt = requireIsoTime(resource.updatedAt, '$.updatedAt');
  if (updatedAt < firstSeenAt) {
    fail('INVALID_TIME', '$.updatedAt', 'updatedAt cannot be earlier than firstSeenAt');
  }
  if (resource.deletedAt !== undefined) {
    const deletedAt = requireIsoTime(resource.deletedAt, '$.deletedAt');
    if (deletedAt < updatedAt) {
      fail('INVALID_TIME', '$.deletedAt', 'deletedAt cannot be earlier than updatedAt');
    }
  }
  const sources = requireArray(resource.sources, '$.sources');
  if (sources.length === 0) {
    fail('INVALID_VALUE', '$.sources', 'At least one resource source is required');
  }
  sources.forEach((source, index) => assertResourceSource(source, `$.sources[${index}]`));
  validateOptionalPortableRecord(resource.attributes, '$.attributes');
  if (resource.tags !== undefined) {
    const tags = requireRecord(resource.tags, '$.tags');
    for (const [key, item] of Object.entries(tags)) {
      requireNonEmptyString(key, '$.tags');
      requireString(item, `$.tags.${key}`);
    }
  }
  if (resource.scope !== undefined) {
    assertResourceScope(resource.scope, '$.scope');
  }
  if (resource.facts !== undefined) {
    const facts = requireRecord(resource.facts, '$.facts');
    for (const [key, candidates] of Object.entries(facts)) {
      requireNonEmptyString(key, '$.facts');
      const list = requireArray(candidates, `$.facts.${key}`);
      if (list.length === 0) {
        fail('INVALID_VALUE', `$.facts.${key}`, 'Fact candidate list cannot be empty');
      }
      list.forEach((candidate, index) => {
        const fact = requireRecord(candidate, `$.facts.${key}[${index}]`);
        assertPortableValue(fact.value, `$.facts.${key}[${index}].value`);
        assertResourceSource(fact.source, `$.facts.${key}[${index}].source`);
        if (
          fact.confidence !== undefined &&
          (typeof fact.confidence !== 'number' ||
            !Number.isFinite(fact.confidence) ||
            fact.confidence < 0 ||
            fact.confidence > 1)
        ) {
          fail(
            'INVALID_VALUE',
            `$.facts.${key}[${index}].confidence`,
            'Fact confidence must be between 0 and 1',
          );
        }
      });
    }
  }
}

export function assertResourceRelation(
  value: unknown,
): asserts value is ResourceRelation {
  const relation = requireRecord(value, '$');
  requireNonEmptyString(relation.id, '$.id');
  requireNonEmptyString(relation.kind, '$.kind');
  const from = requireNonEmptyString(relation.fromResourceId, '$.fromResourceId');
  const to = requireNonEmptyString(relation.toResourceId, '$.toResourceId');
  if (from === to) {
    fail('INVALID_VALUE', '$.toResourceId', 'Resource relation cannot point to itself');
  }
  requirePositiveInteger(relation.version, '$.version');
  const firstSeenAt = requireIsoTime(relation.firstSeenAt, '$.firstSeenAt');
  const updatedAt = requireIsoTime(relation.updatedAt, '$.updatedAt');
  if (updatedAt < firstSeenAt) {
    fail('INVALID_TIME', '$.updatedAt', 'updatedAt cannot be earlier than firstSeenAt');
  }
  if (relation.deletedAt !== undefined) {
    const deletedAt = requireIsoTime(relation.deletedAt, '$.deletedAt');
    if (deletedAt < updatedAt) {
      fail('INVALID_TIME', '$.deletedAt', 'deletedAt cannot be earlier than updatedAt');
    }
  }
  const sources = requireArray(relation.sources, '$.sources');
  if (sources.length === 0) {
    fail('INVALID_VALUE', '$.sources', 'At least one relation source is required');
  }
  sources.forEach((source, index) => assertResourceSource(source, `$.sources[${index}]`));
  validateOptionalPortableRecord(relation.attributes, '$.attributes');
}

export function assertResourceObservation(
  value: unknown,
): asserts value is ResourceObservation {
  const observation = requireRecord(value, '$');
  requireNonEmptyString(observation.id, '$.id');
  requireNonEmptyString(observation.resourceId, '$.resourceId');
  requireNonEmptyString(observation.category, '$.category');
  requireNonEmptyString(observation.status, '$.status');
  const observedAt = requireIsoTime(observation.observedAt, '$.observedAt');
  const expiresAt = requireIsoTime(observation.expiresAt, '$.expiresAt');
  if (expiresAt <= observedAt) {
    fail('INVALID_TIME', '$.expiresAt', 'expiresAt must be later than observedAt');
  }
  assertResourceSource(observation.source, '$.source');
  if (observation.metrics !== undefined) {
    const metrics = requireRecord(observation.metrics, '$.metrics');
    for (const [key, metric] of Object.entries(metrics)) {
      if (typeof metric !== 'number' || !Number.isFinite(metric)) {
        fail('INVALID_VALUE', `$.metrics.${key}`, 'Metric must be a finite number');
      }
    }
  }
  validateOptionalPortableRecord(observation.attributes, '$.attributes');
  if (observation.collectionError !== undefined) {
    const collectionError = requireRecord(observation.collectionError, '$.collectionError');
    requireNonEmptyString(collectionError.code, '$.collectionError.code');
    requireNonEmptyString(collectionError.message, '$.collectionError.message');
  }
}

export function assertResourceChangeSet(
  value: unknown,
): asserts value is ResourceChangeSet {
  const changeSet = requireRecord(value, '$');
  requireNonEmptyString(changeSet.sourceId, '$.sourceId');
  requireNonEmptyString(changeSet.version, '$.version');
  requireIsoTime(changeSet.observedAt, '$.observedAt');
  if (changeSet.sequence !== undefined) {
    requireNonNegativeInteger(changeSet.sequence, '$.sequence');
  }
  validateArray(changeSet.upsertResources, '$.upsertResources', assertResourceDescriptor);
  validateStringArray(changeSet.deleteResourceIds, '$.deleteResourceIds');
  validateStringArray(changeSet.restoreResourceIds, '$.restoreResourceIds');
  validateArray(changeSet.upsertRelations, '$.upsertRelations', assertResourceRelation);
  validateStringArray(changeSet.deleteRelationIds, '$.deleteRelationIds');
  validateArray(changeSet.observations, '$.observations', assertResourceObservation);
  assertUniqueIds(changeSet.upsertResources, '$.upsertResources');
  assertUniqueIds(changeSet.upsertRelations, '$.upsertRelations');
  assertUniqueStrings(changeSet.deleteResourceIds, '$.deleteResourceIds');
  assertUniqueStrings(changeSet.restoreResourceIds, '$.restoreResourceIds');
  assertUniqueStrings(changeSet.deleteRelationIds, '$.deleteRelationIds');
}

export function assertConnectionProfile(
  value: unknown,
): asserts value is ConnectionProfile {
  const profile = requireRecord(value, '$');
  requireNonEmptyString(profile.id, '$.id');
  requireNonEmptyString(profile.name, '$.name');
  requireNonEmptyString(profile.connectorId, '$.connectorId');
  requireNonEmptyString(profile.engine, '$.engine');
  const endpoints = requireArray(profile.endpoints, '$.endpoints');
  if (endpoints.length === 0) {
    fail('INVALID_VALUE', '$.endpoints', 'At least one endpoint is required');
  }
  endpoints.forEach((endpoint, index) => validateEndpoint(endpoint, `$.endpoints[${index}]`));
  requireNonEmptyString(profile.purpose, '$.purpose');
  if (typeof profile.readOnly !== 'boolean') {
    fail('INVALID_TYPE', '$.readOnly', 'readOnly must be a boolean');
  }
  if (profile.scope !== undefined) {
    assertResourceScope(profile.scope, '$.scope');
  }
  requireIsoTime(profile.createdAt, '$.createdAt');
  requireIsoTime(profile.updatedAt, '$.updatedAt');
  if (profile.credentialRef !== undefined) {
    const credentialRef = requireRecord(profile.credentialRef, '$.credentialRef');
    requireNonEmptyString(credentialRef.provider, '$.credentialRef.provider');
    requireNonEmptyString(credentialRef.reference, '$.credentialRef.reference');
    if (credentialRef.version !== undefined) {
      requireNonEmptyString(credentialRef.version, '$.credentialRef.version');
    }
    if (credentialRef.expiresAt !== undefined) {
      requireIsoTime(credentialRef.expiresAt, '$.credentialRef.expiresAt');
    }
  }
}

function assertResourceScope(value: unknown, path: string): void {
  const scope = requireRecord(value, path);
  for (const [key, item] of Object.entries(scope)) {
    if (!['tenantId', 'organizationId', 'projectId', 'environment', 'region'].includes(key)) {
      fail('INVALID_VALUE', `${path}.${key}`, 'Unknown resource scope field');
    }
    requireNonEmptyString(item, `${path}.${key}`);
  }
}

export function assertQuerySubmission(
  value: unknown,
): asserts value is QuerySubmission {
  const submission = requireRecord(value, '$');
  requireNonEmptyString(submission.profileId, '$.profileId');
  requireNonEmptyString(submission.sql, '$.sql');
  for (const [key, item] of [
    ['timeoutMs', submission.timeoutMs],
    ['rowLimit', submission.rowLimit],
    ['batchSize', submission.batchSize],
  ] as const) {
    if (item !== undefined) requirePositiveInteger(item, `$.${key}`);
  }
  if (submission.priority !== undefined) {
    requireNonNegativeInteger(submission.priority, '$.priority');
  }
  for (const [key, item] of [
    ['maximumBytesScanned', submission.maximumBytesScanned],
    ['maximumCost', submission.maximumCost],
  ] as const) {
    if (item !== undefined && (typeof item !== 'number' || !Number.isFinite(item) || item < 0)) {
      fail('INVALID_VALUE', `$.${key}`, `${key} must be a non-negative finite number`);
    }
  }
  if (submission.params !== undefined) {
    const params = requireArray(submission.params, '$.params');
    params.forEach((item, index) => {
      encodePortable(item, `$.params[${index}]`, new WeakSet<object>());
    });
  }
  if (submission.labels !== undefined) {
    const labels = requireRecord(submission.labels, '$.labels');
    for (const [key, item] of Object.entries(labels)) {
      requireString(item, `$.labels.${key}`);
    }
  }
  if (submission.authorization !== undefined) {
    const authorization = requireRecord(submission.authorization, '$.authorization');
    if (authorization.authorizedClass !== undefined) {
      const authorizedClass = requireString(
        authorization.authorizedClass,
        '$.authorization.authorizedClass',
      );
      if (!['query', 'mutation', 'schema-admin'].includes(authorizedClass)) {
        fail(
          'INVALID_VALUE',
          '$.authorization.authorizedClass',
          'authorizedClass must be a database SQL operation class',
        );
      }
    }
  }
}

export function assertDatabaseAccessError(
  value: unknown,
): asserts value is DatabaseAccessError {
  const error = requireRecord(value, '$');
  requireNonEmptyString(error.code, '$.code');
  const category = requireNonEmptyString(error.category, '$.category');
  if (!DATABASE_ERROR_CATEGORIES.has(category)) {
    fail('INVALID_VALUE', '$.category', `Unknown database error category ${category}`);
  }
  requireNonEmptyString(error.message, '$.message');
  if (typeof error.retryable !== 'boolean') {
    fail('INVALID_TYPE', '$.retryable', 'retryable must be a boolean');
  }
  if (!['unchanged', 'changed', 'unknown'].includes(String(error.outcome))) {
    fail('INVALID_VALUE', '$.outcome', 'Invalid operation outcome');
  }
}

export function assertResourceRegistrySnapshot(
  value: unknown,
): asserts value is ResourceRegistrySnapshot {
  const snapshot = requireRecord(value, '$');
  if (snapshot.contractVersion !== CURRENT_CONTRACT_VERSION) {
    fail(
      'UNSUPPORTED_VERSION',
      '$.contractVersion',
      `Unsupported resource snapshot version ${String(snapshot.contractVersion)}`,
    );
  }
  requireIsoTime(snapshot.createdAt, '$.createdAt');
  validateArray(snapshot.resources, '$.resources', assertResourceDescriptor);
  validateArray(snapshot.relations, '$.relations', assertResourceRelation);
  validateArray(snapshot.observations, '$.observations', assertResourceObservation);
  const events = requireArray(snapshot.events, '$.events');
  let previousSequence = 0;
  events.forEach((event, index) => {
    assertResourceEvent(event, `$.events[${index}]`);
    const sequence = event.sequence;
    if (sequence <= previousSequence) {
      fail(
        'INVALID_VALUE',
        `$.events[${index}].sequence`,
        'Event sequences must be strictly increasing',
      );
    }
    previousSequence = sequence;
  });
  const lastEventSequence = requireNonNegativeInteger(
    snapshot.lastEventSequence,
    '$.lastEventSequence',
  );
  if (lastEventSequence < previousSequence) {
    fail(
      'INVALID_VALUE',
      '$.lastEventSequence',
      'lastEventSequence cannot be lower than the latest event',
    );
  }
  const sourceVersions = requireRecord(snapshot.sourceVersions, '$.sourceVersions');
  for (const [sourceId, rawVersion] of Object.entries(sourceVersions)) {
    requireNonEmptyString(sourceId, '$.sourceVersions');
    const version = requireRecord(rawVersion, `$.sourceVersions.${sourceId}`);
    requireNonEmptyString(version.version, `$.sourceVersions.${sourceId}.version`);
    if (version.sequence !== undefined) {
      requireNonNegativeInteger(version.sequence, `$.sourceVersions.${sourceId}.sequence`);
    }
  }
}

function assertResourceEvent(value: unknown, path: string): asserts value is ResourceEvent {
  const event = requireRecord(value, path);
  requireNonEmptyString(event.id, `${path}.id`);
  requirePositiveInteger(event.sequence, `${path}.sequence`);
  const type = requireNonEmptyString(event.type, `${path}.type`);
  if (!RESOURCE_EVENT_TYPES.has(type)) {
    fail('INVALID_VALUE', `${path}.type`, `Unknown resource event type ${type}`);
  }
  requireIsoTime(event.occurredAt, `${path}.occurredAt`);
  assertResourceSource(event.source, `${path}.source`);
  if (!event.resourceId && !event.relationId && type !== 'change-set-applied') {
    fail(
      'MISSING_FIELD',
      path,
      'Resource event must reference a resource or relation',
    );
  }
  validateOptionalPortableRecord(event.attributes, `${path}.attributes`);
}

function assertResourceSource(value: unknown, path: string): asserts value is ResourceSource {
  const source = requireRecord(value, path);
  requireNonEmptyString(source.sourceId, `${path}.sourceId`);
  requireNonEmptyString(source.sourceType, `${path}.sourceType`);
  const observedAt = requireIsoTime(source.observedAt, `${path}.observedAt`);
  if (source.expiresAt !== undefined) {
    const expiresAt = requireIsoTime(source.expiresAt, `${path}.expiresAt`);
    if (expiresAt <= observedAt) {
      fail('INVALID_TIME', `${path}.expiresAt`, 'Source expiresAt must be later than observedAt');
    }
  }
  if (
    source.priority !== undefined &&
    (typeof source.priority !== 'number' || !Number.isFinite(source.priority))
  ) {
    fail('INVALID_VALUE', `${path}.priority`, 'Source priority must be a finite number');
  }
}

function validateEndpoint(value: unknown, path: string): void {
  const endpoint = requireRecord(value, path);
  const transport = requireNonEmptyString(endpoint.transport, `${path}.transport`);
  switch (transport) {
    case 'tcp':
      requireNonEmptyString(endpoint.host, `${path}.host`);
      requirePositiveInteger(endpoint.port, `${path}.port`);
      break;
    case 'jdbc':
      requireNonEmptyString(endpoint.url, `${path}.url`);
      break;
    case 'http':
      requireNonEmptyString(endpoint.baseUrl, `${path}.baseUrl`);
      if (endpoint.headers !== undefined) {
        const headers = requireRecord(endpoint.headers, `${path}.headers`);
        for (const [key, headerValue] of Object.entries(headers)) {
          requireString(headerValue, `${path}.headers.${key}`);
        }
      }
      break;
    case 'sdk':
      requireNonEmptyString(endpoint.provider, `${path}.provider`);
      break;
    case 'custom':
      requireNonEmptyString(endpoint.scheme, `${path}.scheme`);
      validateOptionalPortableRecord(endpoint.options, `${path}.options`, true);
      break;
    default:
      fail('INVALID_VALUE', `${path}.transport`, `Unsupported endpoint transport ${transport}`);
  }
}

function encodePortable(
  value: unknown,
  path: string,
  ancestors: WeakSet<object>,
): PortableValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      fail('NON_PORTABLE_VALUE', path, 'Number must be finite');
    }
    return value;
  }
  if (typeof value === 'bigint') {
    return { $schemanautType: 'bigint', value: value.toString(10) };
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      fail('NON_PORTABLE_VALUE', path, 'Date must be valid');
    }
    return { $schemanautType: 'datetime', value: value.toISOString() };
  }
  if (value instanceof Uint8Array) {
    return {
      $schemanautType: 'binary',
      encoding: 'base64',
      value: Buffer.from(value).toString('base64'),
    };
  }
  if (typeof value !== 'object') {
    fail('NON_PORTABLE_VALUE', path, `Unsupported ${typeof value} value`);
  }
  const object = value;
  if (ancestors.has(object)) {
    fail('NON_PORTABLE_VALUE', path, 'Circular values are not portable');
  }
  ancestors.add(object);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) =>
        encodePortable(item, `${path}[${index}]`, ancestors),
      );
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      fail('NON_PORTABLE_VALUE', path, 'Only plain objects are portable');
    }
    const output: Record<string, PortableValue> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = encodePortable(item, `${path}.${key}`, ancestors);
    }
    return output;
  } finally {
    ancestors.delete(object);
  }
}

function validateOptionalPortableRecord(
  value: unknown,
  path: string,
  required = false,
): void {
  if (value === undefined && !required) return;
  const record = requireRecord(value, path);
  for (const [key, item] of Object.entries(record)) {
    assertPortableValue(item, `${path}.${key}`);
  }
}

function validateArray<T>(
  value: unknown,
  path: string,
  assertion: (item: unknown) => asserts item is T,
): void {
  if (value === undefined) return;
  const list = requireArray(value, path);
  list.forEach((item, index) => {
    try {
      assertion(item);
    } catch (error) {
      rethrowAtPath(error, `${path}[${index}]`);
    }
  });
}

function validateStringArray(value: unknown, path: string): void {
  if (value === undefined) return;
  requireArray(value, path).forEach((item, index) => {
    requireNonEmptyString(item, `${path}[${index}]`);
  });
}

function assertUniqueIds(value: unknown, path: string): void {
  if (!Array.isArray(value)) return;
  const ids = value.map((item, index) =>
    requireNonEmptyString(requireRecord(item, `${path}[${index}]`).id, `${path}[${index}].id`),
  );
  assertUniqueStrings(ids, path);
}

function assertUniqueStrings(value: unknown, path: string): void {
  if (!Array.isArray(value)) return;
  const seen = new Set<string>();
  value.forEach((item, index) => {
    const text = requireNonEmptyString(item, `${path}[${index}]`);
    if (seen.has(text)) {
      fail('INVALID_VALUE', `${path}[${index}]`, `Duplicate value ${text}`);
    }
    seen.add(text);
  });
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    fail('INVALID_TYPE', path, 'Expected an object');
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    fail('INVALID_TYPE', path, 'Expected an array');
  }
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    fail('INVALID_TYPE', path, 'Expected a string');
  }
  return value;
}

function requireNonEmptyString(value: unknown, path: string): string {
  const text = requireString(value, path);
  if (!text.trim()) {
    fail('INVALID_VALUE', path, 'String cannot be empty');
  }
  return text;
}

function requirePositiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail('INVALID_VALUE', path, 'Expected a positive safe integer');
  }
  return value as number;
}

function requireNonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail('INVALID_VALUE', path, 'Expected a non-negative safe integer');
  }
  return value as number;
}

function requireIsoTime(value: unknown, path: string): number {
  const text = requireNonEmptyString(value, path);
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== text) {
    fail('INVALID_TIME', path, 'Expected a canonical ISO 8601 timestamp');
  }
  return timestamp;
}

function isExactTag(
  value: Record<string, PortableValue>,
  type: string,
  keys: string[],
): value is Record<string, PortableValue> & {
  $schemanautType: string;
  value: string;
  encoding?: string;
} {
  return (
    value.$schemanautType === type &&
    typeof value.value === 'string' &&
    Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
  );
}

function isCanonicalBase64(value: string): boolean {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    return false;
  }
  return Buffer.from(value, 'base64').toString('base64') === value;
}

function rethrowAtPath(error: unknown, prefix: string): never {
  if (error instanceof ContractValidationError) {
    throw new ContractValidationError(
      error.issues.map((issue) => ({
        ...issue,
        path: issue.path === '$' ? prefix : `${prefix}${issue.path.slice(1)}`,
      })),
    );
  }
  throw error;
}

function fail(
  code: ContractValidationIssue['code'],
  path: string,
  message: string,
): never {
  throw new ContractValidationError([{ code, path, message }]);
}
