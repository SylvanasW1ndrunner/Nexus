import { createHash } from 'node:crypto';
import type { PortableValue } from '@dbagent/shared';
import {
  EVIDENCE_REFERENCE_REVISION,
  MAX_AGENT_EVIDENCE_REFS,
  normalizeAgentEvidenceRefs,
  type EvidenceReferenceResolver,
  type RuntimeEvidenceReferenceRecord,
} from '../evidence-reference.js';
import type { ContentAccessScope } from '../artifacts/content-reference.js';
import type { AgentToolCompletionEvidence } from '../types.js';

export type DeliveryStatus = 'not-required' | 'verified' | 'unverified';

export type DeliveryEvidenceSelection =
  | 'explicit'
  | 'latest-delivery-ready'
  | 'latest-observation'
  | 'none';

export type DeliveryToolEvidenceSnapshot = Readonly<{
  evidenceRevision: number;
  observationId: string;
  invocationId: string;
  summary: string;
  evidenceRefs: readonly string[];
  completionEvidence?: AgentToolCompletionEvidence;
  modelProjection?: PortableValue;
}>;

export type DeliveryEvidenceSnapshot = Readonly<{
  schemaVersion: 2;
  revision: number;
  finalContentRef: string;
  /** Bounded semantic content resolved from finalContentRef, never a provider wire payload. */
  finalText: string;
  finalTextDigest: string;
  evidenceRefs: readonly string[];
  selection: DeliveryEvidenceSelection;
  /** Only the Tool evidence selected for this delivery, never the complete Run history. */
  toolEvidence: readonly DeliveryToolEvidenceSnapshot[];
}>;

export type DeliveryVerifierDecision =
  | Readonly<{ status: 'accepted' }>
  /** Bounded semantic feedback for the next Model turn. */
  | Readonly<{ status: 'revise'; observation: PortableValue }>
  | Readonly<{ status: 'indeterminate'; reason: string }>;

export type DeliveryVerifier = Readonly<{
  verifierId: string;
  revision: string;
  mode: 'optional' | 'required';
  verify(evidence: DeliveryEvidenceSnapshot): DeliveryVerifierDecision;
}>;

export type PersistedDeliveryDecision = Readonly<{
  verifierId: string;
  verifierRevision: string;
  evidenceRevision: number;
  decision: DeliveryVerifierDecision['status'];
}>;

export type DeliveryEvaluation =
  | Readonly<{
      action: 'complete';
      deliveryStatus: DeliveryStatus;
      evidenceRevision: number;
      verifier?: Readonly<{ verifierId: string; revision: string }>;
      decision?: DeliveryVerifierDecision;
    }>
  | Readonly<{
      action: 'revise';
      deliveryStatus: 'unverified';
      evidenceRevision: number;
      verifier: Readonly<{ verifierId: string; revision: string }>;
      decision: Extract<DeliveryVerifierDecision, { status: 'revise' }>;
      observation: PortableValue;
    }>
  | Readonly<{
      action: 'fail';
      code: 'DELIVERY_UNVERIFIED';
      deliveryStatus: 'unverified';
      evidenceRevision: number;
      verifier: Readonly<{ verifierId: string; revision: string }>;
      decision: Extract<DeliveryVerifierDecision, { status: 'indeterminate' }>;
    }>;

export type DeliveryVerificationErrorCode =
  | 'DELIVERY_UNVERIFIED'
  | 'EVIDENCE_SNAPSHOT_INVALID'
  | 'EVIDENCE_REFERENCE_INVALID'
  | 'VERIFIER_CONTRACT_INVALID'
  | 'VERIFIER_FAILED';

export class DeliveryVerificationError extends Error {
  constructor(
    readonly code: DeliveryVerificationErrorCode,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DeliveryVerificationError';
  }
}

export type EvaluateDeliveryInput = Readonly<{
  evidence: DeliveryEvidenceSnapshot;
  verifier?: DeliveryVerifier;
  priorDecisions?: readonly PersistedDeliveryDecision[];
}>;

export type ValidateDeliveryEvidenceReferencesInput = Readonly<{
  evidence: DeliveryEvidenceSnapshot;
  resolver: EvidenceReferenceResolver;
  access: ContentAccessScope;
  expectedRevision?: string;
  resolverContext?: Readonly<{ signal?: AbortSignal; deadline?: string; pinUntil?: string }>;
}>;

/**
 * Resolves every opaque Runtime evidence reference before a verifier receives
 * the snapshot. URI shape alone is never accepted as proof of existence.
 */
export async function validateDeliveryEvidenceReferences(
  input: ValidateDeliveryEvidenceReferencesInput,
): Promise<readonly RuntimeEvidenceReferenceRecord[]> {
  const refs = normalizeAgentEvidenceRefs(input.evidence.evidenceRefs);
  const records: RuntimeEvidenceReferenceRecord[] = [];
  for (const evidenceRef of refs) {
    const resolution = await input.resolver.resolveEvidenceReference(
      evidenceRef,
      input.access,
      input.expectedRevision ?? EVIDENCE_REFERENCE_REVISION,
      input.resolverContext,
    );
    if (resolution.status !== 'valid') {
      throw new DeliveryVerificationError(
        'EVIDENCE_REFERENCE_INVALID',
        `Delivery evidence reference is ${resolution.status.replaceAll('_', ' ')}.`,
      );
    }
    if (
      resolution.record.evidenceRef !== evidenceRef ||
      resolution.record.revision !== (input.expectedRevision ?? EVIDENCE_REFERENCE_REVISION) ||
      resolution.record.owner.hostId !== input.access.hostId ||
      resolution.record.owner.sessionId !== input.access.sessionId ||
      resolution.record.owner.runId !== input.access.runId ||
      (resolution.record.owner.projectId !== undefined &&
        resolution.record.owner.projectId !== input.access.projectId)
    ) {
      throw new DeliveryVerificationError(
        'EVIDENCE_REFERENCE_INVALID',
        'Delivery evidence reference is not bound to this delivery owner and revision.',
      );
    }
    records.push(resolution.record);
  }
  return Object.freeze(records);
}

/**
 * Runs one versioned synchronous verifier against a deeply immutable evidence
 * snapshot. The function has no model, Tool, database, filesystem or network
 * dependency and therefore cannot open a hidden execution path.
 */
export function evaluateDelivery(input: EvaluateDeliveryInput): DeliveryEvaluation {
  const evidence = immutableEvidence(input.evidence);
  const verifier = input.verifier;
  if (verifier === undefined) {
    return Object.freeze({
      action: 'complete',
      deliveryStatus: 'not-required',
      evidenceRevision: evidence.revision,
    });
  }
  validateVerifier(verifier);
  let rawDecision: unknown;
  try {
    rawDecision = verifier.verify(evidence);
  } catch (error) {
    throw new DeliveryVerificationError(
      'VERIFIER_FAILED',
      `Delivery verifier ${verifier.verifierId}@${verifier.revision} failed.`,
      error,
    );
  }
  if (isPromiseLike(rawDecision)) {
    throw new DeliveryVerificationError(
      'VERIFIER_CONTRACT_INVALID',
      'Delivery verifiers must be synchronous pure functions.',
    );
  }
  const decision = immutableDecision(rawDecision);
  const verifierRef = Object.freeze({
    verifierId: verifier.verifierId,
    revision: verifier.revision,
  });

  if (decision.status === 'accepted') {
    return Object.freeze({
      action: 'complete',
      deliveryStatus: 'verified',
      evidenceRevision: evidence.revision,
      verifier: verifierRef,
      decision,
    });
  }
  if (decision.status === 'revise') {
    const alreadyRevised = (input.priorDecisions ?? []).some((prior) =>
      prior.verifierId === verifier.verifierId &&
      prior.verifierRevision === verifier.revision &&
      prior.evidenceRevision === evidence.revision &&
      prior.decision === 'revise');
    if (alreadyRevised) {
      throw new DeliveryVerificationError(
        'DELIVERY_UNVERIFIED',
        'The same verifier and evidence revision may request at most one revision.',
      );
    }
    return Object.freeze({
      action: 'revise',
      deliveryStatus: 'unverified',
      evidenceRevision: evidence.revision,
      verifier: verifierRef,
      decision,
      observation: decision.observation,
    });
  }
  if (verifier.mode === 'required') {
    return Object.freeze({
      action: 'fail',
      code: 'DELIVERY_UNVERIFIED',
      deliveryStatus: 'unverified',
      evidenceRevision: evidence.revision,
      verifier: verifierRef,
      decision,
    });
  }
  return Object.freeze({
    action: 'complete',
    deliveryStatus: 'unverified',
    evidenceRevision: evidence.revision,
    verifier: verifierRef,
    decision,
  });
}

/** Validates the stable identity and synchronous contract of a verifier. */
export function assertDeliveryVerifier(verifier: DeliveryVerifier): void {
  validateVerifier(verifier);
}

function immutableEvidence(value: DeliveryEvidenceSnapshot): DeliveryEvidenceSnapshot {
  if (
    value === null || typeof value !== 'object' || value.schemaVersion !== 2 ||
    !Number.isSafeInteger(value.revision) || value.revision < 0 ||
    typeof value.finalContentRef !== 'string' || value.finalContentRef.trim() === '' ||
    value.finalContentRef.length > 4_096 ||
    typeof value.finalText !== 'string' || value.finalText.trim() === '' ||
    value.finalText.length > 65_536 ||
    value.finalTextDigest !== sha256Text(value.finalText) ||
    !isDeliveryEvidenceSelection(value.selection) ||
    !isArrayValue(value.toolEvidence) ||
    value.toolEvidence.length > MAX_AGENT_EVIDENCE_REFS
  ) {
    throw new DeliveryVerificationError(
      'EVIDENCE_SNAPSHOT_INVALID',
      'Delivery evidence snapshot is invalid or exceeds its bounded contract.',
    );
  }
  let evidenceRefs: string[];
  try {
    evidenceRefs = normalizeAgentEvidenceRefs(value.evidenceRefs);
  } catch (error) {
    throw new DeliveryVerificationError(
      'EVIDENCE_SNAPSHOT_INVALID',
      'Delivery evidence snapshot contains invalid references.',
      error,
    );
  }
  const toolEvidence = value.toolEvidence.map((item) => immutableToolEvidence(item, value.revision));
  if (
    (value.selection === 'none' && (toolEvidence.length > 0 || evidenceRefs.length > 0)) ||
    (value.selection !== 'none' && toolEvidence.length === 0) ||
    !sameReferenceSet(
      evidenceRefs,
      toolEvidence.flatMap((item) => item.evidenceRefs),
    )
  ) {
    throw new DeliveryVerificationError(
      'EVIDENCE_SNAPSHOT_INVALID',
      'Delivery evidence selection is not causally bound to its Tool evidence.',
    );
  }
  return Object.freeze({
    schemaVersion: 2,
    revision: value.revision,
    finalContentRef: value.finalContentRef,
    finalText: value.finalText,
    finalTextDigest: value.finalTextDigest,
    evidenceRefs: Object.freeze(evidenceRefs),
    selection: value.selection,
    toolEvidence: Object.freeze(toolEvidence),
  });
}

function immutableToolEvidence(
  value: DeliveryToolEvidenceSnapshot,
  snapshotRevision: number,
): DeliveryToolEvidenceSnapshot {
  if (
    value === null || typeof value !== 'object' ||
    !Number.isSafeInteger(value.evidenceRevision) || value.evidenceRevision < 0 ||
    value.evidenceRevision > snapshotRevision ||
    !boundedText(value.observationId, 512) || !boundedText(value.invocationId, 512) ||
    !boundedText(value.summary, 4_096)
  ) {
    throw new DeliveryVerificationError(
      'EVIDENCE_SNAPSHOT_INVALID',
      'Delivery Tool evidence is malformed or belongs to a future revision.',
    );
  }
  let evidenceRefs: string[];
  try {
    evidenceRefs = normalizeAgentEvidenceRefs(value.evidenceRefs);
    if (value.modelProjection !== undefined) {
      assertPortableBounded(value.modelProjection, 0, new Set<object>());
      if (Buffer.byteLength(JSON.stringify(value.modelProjection), 'utf8') > 65_536) {
        throw invalidVerifierDecision();
      }
    }
    if (value.completionEvidence !== undefined) {
      assertPortableBounded(value.completionEvidence, 0, new Set<object>());
      if (Buffer.byteLength(JSON.stringify(value.completionEvidence), 'utf8') > 8_192) {
        throw invalidVerifierDecision();
      }
    }
  } catch (error) {
    throw new DeliveryVerificationError(
      'EVIDENCE_SNAPSHOT_INVALID',
      'Delivery Tool evidence exceeds its bounded semantic contract.',
      error,
    );
  }
  return Object.freeze({
    evidenceRevision: value.evidenceRevision,
    observationId: value.observationId,
    invocationId: value.invocationId,
    summary: value.summary,
    evidenceRefs: Object.freeze(evidenceRefs),
    ...(value.completionEvidence === undefined
      ? {}
      : {
          completionEvidence: deepFreezePortable(
            structuredClone(value.completionEvidence) as PortableValue,
          ) as AgentToolCompletionEvidence,
        }),
    ...(value.modelProjection === undefined
      ? {}
      : { modelProjection: deepFreezePortable(structuredClone(value.modelProjection)) }),
  });
}

function validateVerifier(verifier: DeliveryVerifier): void {
  if (
    typeof verifier.verifierId !== 'string' || verifier.verifierId.trim() === '' ||
    verifier.verifierId.length > 256 ||
    typeof verifier.revision !== 'string' || verifier.revision.trim() === '' ||
    verifier.revision.length > 256 ||
    (verifier.mode !== 'optional' && verifier.mode !== 'required') ||
    typeof verifier.verify !== 'function'
  ) {
    throw new DeliveryVerificationError(
      'VERIFIER_CONTRACT_INVALID',
      'Delivery verifier identity, mode or function is invalid.',
    );
  }
}

function immutableDecision(value: unknown): DeliveryVerifierDecision {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidVerifierDecision();
  }
  const record = value as Record<string, unknown>;
  if (record.status === 'accepted' && exactKeys(record, ['status'])) {
    return Object.freeze({ status: 'accepted' });
  }
  if (
    record.status === 'indeterminate' && exactKeys(record, ['status', 'reason']) &&
    typeof record.reason === 'string' && record.reason.trim() !== '' && record.reason.length <= 4_096
  ) {
    return Object.freeze({ status: 'indeterminate', reason: record.reason });
  }
  if (
    record.status === 'revise' && exactKeys(record, ['status', 'observation']) &&
    record.observation !== undefined
  ) {
    assertPortableBounded(record.observation, 0, new Set<object>());
    if (Buffer.byteLength(JSON.stringify(record.observation), 'utf8') > 64 * 1024) {
      throw invalidVerifierDecision();
    }
    return Object.freeze({
      status: 'revise',
      observation: deepFreezePortable(structuredClone(record.observation as PortableValue)),
    });
  }
  throw invalidVerifierDecision();
}

function assertPortableBounded(value: unknown, depth: number, seen: Set<object>): void {
  if (depth > 32) throw invalidVerifierDecision();
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (value.length > 32_768) throw invalidVerifierDecision();
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalidVerifierDecision();
    return;
  }
  if (typeof value !== 'object' || seen.has(value)) throw invalidVerifierDecision();
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > 1_000) throw invalidVerifierDecision();
    for (const item of value) assertPortableBounded(item, depth + 1, seen);
  } else {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw invalidVerifierDecision();
    const entries = Object.entries(value);
    if (entries.length > 1_000) throw invalidVerifierDecision();
    for (const [key, item] of entries) {
      if (key.length > 512) throw invalidVerifierDecision();
      assertPortableBounded(item, depth + 1, seen);
    }
  }
  seen.delete(value);
}

function deepFreezePortable(value: PortableValue): PortableValue {
  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value)) {
      for (const item of value) deepFreezePortable(item);
    } else {
      for (const item of Object.values(value)) deepFreezePortable(item);
    }
    Object.freeze(value);
  }
  return value;
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isArrayValue(value: unknown): boolean {
  return Array.isArray(value);
}

function isDeliveryEvidenceSelection(value: unknown): value is DeliveryEvidenceSelection {
  return value === 'explicit' || value === 'latest-delivery-ready' ||
    value === 'latest-observation' || value === 'none';
}

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= maxLength;
}

function sameReferenceSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((item) => rightSet.has(item));
}

function sha256Text(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return value !== null && typeof value === 'object' &&
    typeof (value as { then?: unknown }).then === 'function';
}

function invalidVerifierDecision(): DeliveryVerificationError {
  return new DeliveryVerificationError(
    'VERIFIER_CONTRACT_INVALID',
    'Delivery verifier returned a malformed or unbounded decision.',
  );
}
