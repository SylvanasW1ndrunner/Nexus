import { createHash } from 'node:crypto';
import type { PortableValue } from '@dbagent/shared';
import type { AgentToolDescriptor } from '../types.js';
import { assertInvocationLimits, PREPARED_TOOL_INTENT_REVISION, TOOL_PROTOCOL_BOUNDS, type PreparedToolIntent } from './tool-protocol.js';

/** Validates durable data without consulting mutable environment or permissions. */
export function validatePreparedIntent(value: PreparedToolIntent, descriptor?: AgentToolDescriptor, allowUnsupportedRevision = false): PreparedToolIntent {
  assertPortable(value, 0);
  if (Buffer.byteLength(JSON.stringify(value)) > TOOL_PROTOCOL_BOUNDS.intentBytes) throw new TypeError('Prepared intent exceeds byte limit.');
  assertInvocationLimits(value.limits);
  if (value.runPolicy && (!['default', 'auto', 'full-access'].includes(value.runPolicy.mode) || typeof value.runPolicy.revision !== 'string' || !value.runPolicy.revision.trim() || value.runPolicy.revision.length > TOOL_PROTOCOL_BOUNDS.revisionChars)) throw new TypeError('Prepared Run policy is invalid.');
  assertPortable(value.input, 0, value.limits.maxDepth, value.limits.maxRecords);
  for (const text of [value.toolRevision, value.handlerRevision, value.intentRevision, value.generation]) {
    if (typeof text !== 'string' || !text.trim() || text.length > TOOL_PROTOCOL_BOUNDS.revisionChars) throw new TypeError('Prepared revision is invalid.');
  }
  if (!allowUnsupportedRevision && value.intentRevision !== PREPARED_TOOL_INTENT_REVISION) throw new TypeError('Unsupported intent revision.');
  if (!value.action || typeof value.action.summary !== 'string' || !value.action.summary.trim() || value.action.summary.length > TOOL_PROTOCOL_BOUNDS.actionChars) throw new TypeError('Prepared action is invalid.');
  if (!['read', 'write', 'external', 'destructive'].includes(value.access) || !['read', 'write', 'exclusive'].includes(value.concurrency) || !['read', 'idempotent', 'transactional', 'non_idempotent'].includes(value.recoveryClass)) throw new TypeError('Prepared classification is invalid.');
  if (value.concurrency === 'read' && value.access !== 'read') throw new TypeError('Prepared classification conflicts.');
  if (!Array.isArray(value.resourceKeys) || value.resourceKeys.length > TOOL_PROTOCOL_BOUNDS.resourceKeys || new Set(value.resourceKeys).size !== value.resourceKeys.length || value.resourceKeys.some(key => typeof key !== 'string' || !key.trim() || key.length > TOOL_PROTOCOL_BOUNDS.resourceKeyChars)) throw new TypeError('Prepared resource keys are invalid.');
  if (value.resourceKeys.length === 0 && value.concurrency !== 'exclusive') throw new TypeError('Unkeyed actions require exclusive scheduling.');
  const facts = value.permission;
  if (!facts || facts.access !== value.access || facts.recoveryClass !== value.recoveryClass ||
    value.access === 'read' && !facts.readonly ||
    (value.access === 'write' || value.access === 'destructive') && facts.readonly ||
    value.recoveryClass === 'read' && !facts.readonly) throw new TypeError('Prepared permission classification conflicts.');
  if (typeof facts.toolName !== 'string' || !facts.toolName.trim() || !['safe','medium','high','critical'].includes(facts.dangerLevel)) throw new TypeError('Prepared permission identity is invalid.');
  for (const key of ['readonly','network','externalWrite','destructive','credentials','admin','unknownRisk'] as const) if (typeof facts[key] !== 'boolean') throw new TypeError('Prepared permission flag is missing.');
  for (const items of [facts.actions, facts.paths, facts.hosts, facts.resolvedAddresses]) if (!Array.isArray(items) || items.length > TOOL_PROTOCOL_BOUNDS.facts || items.some(item => typeof item !== 'string' || !item.trim() || item.length > TOOL_PROTOCOL_BOUNDS.factChars)) throw new TypeError('Prepared permission targets are invalid.');
  if (!Array.isArray(facts.targets) || facts.targets.length > TOOL_PROTOCOL_BOUNDS.facts) throw new TypeError('Prepared target facts are invalid.');
  if (facts.actions.some(action => !['read','write','execute','network','delete','database-query','database-mutation','database-schema','credential','admin','unknown'].includes(action))) throw new TypeError('Prepared permission action is invalid.');
  if ((value.access === 'destructive' || facts.actions.includes('delete')) && !facts.destructive ||
    facts.actions.includes('network') && !facts.network ||
    facts.actions.includes('credential') && !facts.credentials ||
    facts.actions.includes('admin') && !facts.admin ||
    facts.actions.includes('unknown') && !facts.unknownRisk ||
    (facts.hosts.length > 0 || facts.resolvedAddresses.length > 0) && !facts.network) {
    throw new TypeError('Prepared actions, targets and risk flags contradict each other.');
  }
  if (facts.readonly && (facts.externalWrite || facts.destructive || facts.actions.some(action => ['write','delete','database-mutation','database-schema'].includes(action)))) throw new TypeError('Prepared readonly facts conflict.');
  if (value.input === null || typeof value.input !== 'object' || Array.isArray(value.input) || Buffer.byteLength(JSON.stringify(value.input)) > value.limits.maxInputBytes) throw new TypeError('Prepared input is invalid.');
  if (descriptor) {
    if (value.toolRevision !== descriptor.toolRevision || value.handlerRevision !== descriptor.handlerRevision || value.intentRevision !== descriptor.intentRevision || facts.toolName !== descriptor.flatName) throw new TypeError('Prepared revision binding conflicts.');
    for (const key of Object.keys(value.limits) as Array<keyof typeof value.limits>) if (value.limits[key] > descriptor.limits[key]) throw new TypeError('Prepared limits exceed registered limits.');
  }
  return freeze(structuredClone(value));
}

export function preparedIntentDigest(value: PreparedToolIntent): string {
  return createHash('sha256').update(canonical(value as unknown as PortableValue)).digest('hex');
}

export function assertPreparedDigest(value: PreparedToolIntent, digest: string): void {
  if (preparedIntentDigest(value) !== digest) throw new TypeError('Persisted prepared intent digest mismatch.');
}

function canonical(value: PortableValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, PortableValue>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key]!)}`).join(',')}}`;
}

/** maxRecords counts all object properties and array entries in the entire input. */
export function validateInvocationInput(value: unknown, limits: Readonly<{ maxDepth: number; maxRecords: number; maxInputBytes: number }>): asserts value is Readonly<Record<string, PortableValue>> {
  assertPortable(value, 0, limits.maxDepth, limits.maxRecords);
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > limits.maxInputBytes) throw new TypeError('Tool input exceeds its bounded object contract.');
}

function assertPortable(value: unknown, depth: number, maxDepth: number = TOOL_PROTOCOL_BOUNDS.depth, maxEntries: number = TOOL_PROTOCOL_BOUNDS.containerEntries, budget = { entries: 0 }): void {
  if (depth > maxDepth) throw new TypeError('Prepared intent exceeds depth limit.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || !Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError('Prepared intent must be portable data.');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length > maxEntries + (Array.isArray(value) ? 1 : 0)) throw new TypeError('Prepared intent exceeds entry limit.');
  for (const [key, property] of Object.entries(descriptors)) {
    if (Array.isArray(value) && key === 'length') continue;
    budget.entries += 1;
    if (budget.entries > maxEntries) throw new TypeError('Prepared input exceeds aggregate entry limit.');
    if (!('value' in property)) throw new TypeError('Prepared intent cannot contain accessors.');
    assertPortable(property.value, depth + 1, maxDepth, maxEntries, budget);
  }
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { for (const entry of Object.values(value)) freeze(entry); Object.freeze(value); }
  return value;
}
