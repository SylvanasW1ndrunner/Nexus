import type { PortableValue } from '@dbagent/shared';

export type DeliveryStatus = 'not-required' | 'verified' | 'unverified';

export type DeliveryEvidenceSnapshot = Readonly<{
  schemaVersion: 1;
  revision: number;
  finalContentRef: string;
  evidenceRefs: readonly string[];
}>;

export type DeliveryVerifierDecision =
  | Readonly<{ status: 'accepted' }>
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

function immutableEvidence(value: DeliveryEvidenceSnapshot): DeliveryEvidenceSnapshot {
  if (
    value === null || typeof value !== 'object' || value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.revision) || value.revision < 0 ||
    typeof value.finalContentRef !== 'string' || value.finalContentRef.trim() === '' ||
    value.finalContentRef.length > 4_096 || !Array.isArray(value.evidenceRefs) ||
    value.evidenceRefs.length > 1_000 || value.evidenceRefs.some((ref) =>
      typeof ref !== 'string' || ref.trim() === '' || ref.length > 4_096)
  ) {
    throw new DeliveryVerificationError(
      'EVIDENCE_SNAPSHOT_INVALID',
      'Delivery evidence snapshot is invalid or exceeds its bounded contract.',
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    revision: value.revision,
    finalContentRef: value.finalContentRef,
    evidenceRefs: Object.freeze([...value.evidenceRefs]),
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
    const prototype = Object.getPrototypeOf(value);
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
