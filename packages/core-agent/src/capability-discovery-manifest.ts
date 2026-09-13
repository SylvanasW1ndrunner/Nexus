import { assertPortableValue } from '@dbagent/shared';
import type {
  AgentCapabilityExternalContextRequirement,
  AgentCapabilityDiscoveryManifestEntry,
} from './capability-types.js';

const MAX_DISCOVERY_ENTRIES = 256;
const MAX_DISCOVERY_MANIFEST_BYTES = 1024 * 1024;

/** Canonical bounded snapshot of a complete model-searchable Capability manifest. */
export function snapshotCapabilityDiscoveryManifest(
  value: unknown,
): readonly AgentCapabilityDiscoveryManifestEntry[] {
  if (!Array.isArray(value) || value.length > MAX_DISCOVERY_ENTRIES) {
    throw new TypeError('Capability discovery manifest must be a bounded array.');
  }
  const identities = new Set<string>();
  const entries = value.map((entryValue) => {
    const entry = snapshotCapabilityDiscoveryManifestEntry(entryValue);
    const identity = `${entry.target.moduleId}\0${entry.target.instanceId}\0${entry.name}`;
    if (identities.has(identity)) {
      throw new TypeError('Capability discovery manifest contains a duplicate entry.');
    }
    identities.add(identity);
    return entry;
  });
  if (Buffer.byteLength(JSON.stringify(entries), 'utf8') > MAX_DISCOVERY_MANIFEST_BYTES) {
    throw new TypeError('Capability discovery manifest exceeds its byte limit.');
  }
  return Object.freeze(entries);
}

/** Canonical durable snapshot of one safe, model-searchable Capability entry. */
export function snapshotCapabilityDiscoveryManifestEntry(
  value: unknown,
): AgentCapabilityDiscoveryManifestEntry {
  const entry = record(value, 'Capability manifest entry');
  exact(entry, ['name', 'description', 'status', 'reason', 'target', 'activation'], ['reason', 'activation']);
  const target = record(entry.target, 'Capability target');
  exact(target, ['moduleId', 'instanceId']);
  const status = entry.status;
  if (!['unloaded', 'available', 'unavailable', 'degraded', 'disabled'].includes(status as string)) {
    throw new TypeError('Capability manifest status is invalid.');
  }
  const reason = entry.reason === undefined ? undefined : text(entry.reason, 'reason', 2_048);
  const activation = entry.activation === undefined
    ? undefined
    : snapshotChoiceRequirement(entry.activation);
  const captured = {
    name: text(entry.name, 'name', 4_096),
    description: text(entry.description, 'description', 16_384),
    status: status as AgentCapabilityDiscoveryManifestEntry['status'],
    ...(reason === undefined ? {} : { reason }),
    target: Object.freeze({
      moduleId: text(target.moduleId, 'target.moduleId', 4_096),
      instanceId: text(target.instanceId, 'target.instanceId', 4_096),
    }),
    ...(activation === undefined ? {} : { activation }),
  };
  assertPortableValue(captured);
  return deepFreeze(captured);
}

function snapshotChoiceRequirement(value: unknown): AgentCapabilityExternalContextRequirement {
  const requirement = record(value, 'Capability choice requirement');
  exact(requirement, ['kind', 'selection', 'providerId', 'probeRevision', 'candidates']);
  if (requirement.kind !== 'external_context') throw new TypeError('Capability activation kind is invalid.');
  if (requirement.selection !== 'automatic' && requirement.selection !== 'choice_required') {
    throw new TypeError('Capability activation selection is invalid.');
  }
  if (!Array.isArray(requirement.candidates) || requirement.candidates.length < 1 || requirement.candidates.length > 20) {
    throw new TypeError('Capability external context candidates must contain 1-20 entries.');
  }
  if (
    requirement.selection === 'automatic' && requirement.candidates.length !== 1 ||
    requirement.selection === 'choice_required' && requirement.candidates.length < 2
  ) {
    throw new TypeError('Capability activation selection does not match its candidate count.');
  }
  const ids = new Set<string>();
  const candidates = requirement.candidates.map((value) => {
    const candidate = record(value, 'Capability choice candidate');
    exact(
      candidate,
      ['candidateId', 'label', 'description', 'metadata', 'fingerprint', 'probeChoiceRef'],
      ['description', 'metadata', 'probeChoiceRef'],
    );
    const candidateId = text(candidate.candidateId, 'candidateId', 256);
    if (ids.has(candidateId)) throw new TypeError('Capability choice candidate ids repeat.');
    ids.add(candidateId);
    const metadata = candidate.metadata === undefined
      ? undefined
      : snapshotMetadata(candidate.metadata);
    return Object.freeze({
      candidateId,
      label: text(candidate.label, 'candidate label', 256),
      ...(candidate.description === undefined
        ? {}
        : { description: text(candidate.description, 'candidate description', 512) }),
      ...(metadata === undefined ? {} : { metadata }),
      fingerprint: text(candidate.fingerprint, 'candidate fingerprint', 512),
      ...(candidate.probeChoiceRef === undefined
        ? {}
        : { probeChoiceRef: text(candidate.probeChoiceRef, 'probeChoiceRef', 2_048) }),
    });
  });
  return Object.freeze({
    kind: 'external_context',
    selection: requirement.selection,
    providerId: text(requirement.providerId, 'providerId', 256),
    probeRevision: text(requirement.probeRevision, 'probeRevision', 256),
    candidates: Object.freeze(candidates),
  });
}

function snapshotMetadata(value: unknown): Readonly<Record<string, string | number | boolean | null>> {
  const metadata = record(value, 'Capability choice metadata');
  if (Object.keys(metadata).length > 16) throw new TypeError('Capability choice metadata is too large.');
  const captured: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(metadata)) {
    text(key, 'metadata key', 128);
    if (item !== null && typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
      throw new TypeError('Capability choice metadata values must be scalar.');
    }
    if (typeof item === 'string' && item.length > 512) throw new TypeError('Capability choice metadata value is too long.');
    captured[key] = item;
  }
  if (Buffer.byteLength(JSON.stringify(captured), 'utf8') > 8 * 1024) {
    throw new TypeError('Capability choice metadata exceeds its byte limit.');
  }
  return Object.freeze(captured);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, allowed: readonly string[], optional: readonly string[] = []): void {
  const required = allowed.filter((key) => !optional.includes(key));
  if (Object.keys(value).some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError('Capability manifest shape is invalid.');
  }
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) {
    throw new TypeError(`Capability manifest ${label} is invalid.`);
  }
  return value.trim();
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
