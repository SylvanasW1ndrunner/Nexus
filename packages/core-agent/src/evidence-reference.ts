import { createHash } from 'node:crypto';
import {
  assertContentAccess,
  normalizeContentOwner,
  parseContentReference,
  type ContentAccessScope,
  type ContentOwnerScope,
} from './artifacts/content-reference.js';

export const MAX_AGENT_EVIDENCE_REFS = 32;
export const MAX_AGENT_EVIDENCE_REF_LENGTH = 256;
export const EVIDENCE_REFERENCE_REVISION = 'evidence-reference.v1';

export type RuntimeEvidenceReferenceRecord = Readonly<{
  schemaVersion: 1;
  evidenceRef: string;
  contentRef: string;
  artifactId: string;
  owner: ContentOwnerScope;
  revision: string;
  issuedAt: string;
  expiresAt?: string;
}>;

export type EvidenceReferenceResolution =
  | Readonly<{ status: 'valid'; record: RuntimeEvidenceReferenceRecord }>
  | Readonly<{ status: 'not_found' | 'expired' | 'forbidden' | 'revision_mismatch' | 'corrupt' }>;

export interface EvidenceReferenceResolver {
  resolveEvidenceReference(
    evidenceRef: string,
    access: ContentAccessScope,
    expectedRevision?: string,
    context?: Readonly<{ signal?: AbortSignal; deadline?: string; pinUntil?: string }>,
  ): Promise<EvidenceReferenceResolution>;
}

const EVIDENCE_REF = /^schemanaut-evidence:v1:(artifact_[a-f0-9]{64}):([a-f0-9]{64})$/u;

export function mintRuntimeEvidenceReference(input: Readonly<{
  artifactId: string;
  contentRef: string;
  owner: ContentOwnerScope;
  revision: string;
  issuedAt: string;
  expiresAt?: string;
  nonce: string;
}>): RuntimeEvidenceReferenceRecord {
  const parsed = parseContentReference(input.contentRef);
  if (parsed.artifactId !== input.artifactId) {
    throw new TypeError('Evidence content and artifact identities do not match.');
  }
  const owner = normalizeContentOwner(input.owner);
  const revision = requireText(input.revision, 'revision');
  const issuedAt = requireIso(input.issuedAt, 'issuedAt');
  const expiresAt = input.expiresAt === undefined ? undefined : requireIso(input.expiresAt, 'expiresAt');
  const nonce = requireText(input.nonce, 'nonce');
  const digest = sha256(JSON.stringify({
    artifactId: input.artifactId,
    contentRef: input.contentRef,
    owner,
    revision,
    issuedAt,
    expiresAt: expiresAt ?? null,
    nonce,
  }));
  return Object.freeze({
    schemaVersion: 1,
    evidenceRef: `schemanaut-evidence:v1:${input.artifactId}:${digest}`,
    contentRef: input.contentRef,
    artifactId: input.artifactId,
    owner,
    revision,
    issuedAt,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  });
}

export function parseRuntimeEvidenceReference(value: unknown): Readonly<{
  evidenceRef: string;
  artifactId: string;
}> {
  if (typeof value !== 'string' || value.length > MAX_AGENT_EVIDENCE_REF_LENGTH) {
    throw new TypeError('Evidence reference is malformed.');
  }
  const match = EVIDENCE_REF.exec(value);
  if (match === null) throw new TypeError('Evidence reference is malformed.');
  return Object.freeze({ evidenceRef: value, artifactId: match[1]! });
}

export function isAgentEvidenceRef(value: unknown): value is string {
  try {
    parseRuntimeEvidenceReference(value);
    return true;
  } catch {
    return false;
  }
}

export function normalizeAgentEvidenceRefs(value: readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_AGENT_EVIDENCE_REFS) {
    throw new TypeError('Tool evidenceRefs exceed the supported reference count.');
  }
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value as readonly unknown[]) {
    const reference = parseRuntimeEvidenceReference(candidate).evidenceRef;
    if (seen.has(reference)) continue;
    seen.add(reference);
    unique.push(reference);
  }
  return unique;
}

export function assertEvidenceReferenceAccess(
  record: RuntimeEvidenceReferenceRecord,
  access: ContentAccessScope,
  expectedRevision?: string,
  now = new Date(),
): void {
  parseRuntimeEvidenceReference(record.evidenceRef);
  assertContentAccess(record.owner, access);
  if (expectedRevision !== undefined && record.revision !== expectedRevision) {
    throw new TypeError('Evidence reference revision does not match the required revision.');
  }
  if (record.expiresAt !== undefined && Date.parse(record.expiresAt) <= now.getTime()) {
    throw new TypeError('Evidence reference has expired.');
  }
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 512) {
    throw new TypeError(`Evidence ${label} is invalid.`);
  }
  return value;
}

function requireIso(value: unknown, label: string): string {
  if (
    typeof value !== 'string' || !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError(`Evidence ${label} must be an exact ISO timestamp.`);
  }
  return value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
