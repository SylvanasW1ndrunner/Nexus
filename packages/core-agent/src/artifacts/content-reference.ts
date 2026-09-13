import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const CONTENT_REFERENCE_REVISION = 'content-reference.v1';
export const CONTENT_CURSOR_REVISION = 'content-cursor.v2';
export type ContentCursorAuthority = Readonly<{ key: string; owner: ContentOwnerScope; generation: string }>;

export type ContentOwnerScope = Readonly<{
  hostId: string;
  sessionId: string;
  runId: string;
  invocationId: string;
  projectId?: string;
}>;

export type ContentAccessScope = Readonly<{
  hostId: string;
  sessionId: string;
  runId: string;
  projectId?: string;
}>;

export type ContentReadMode = 'text' | 'line' | 'record' | 'byte';

/** One structure contract for Store pages and the result_read Tool descriptor. */
export const RESULT_READ_STRUCTURE_BUDGET = Object.freeze({
  maxDepth: 16,
  maxRecords: 2_000,
  wrapperRecords: 16,
  maxLineItems: 2_000 - 16 - 1,
  maxRecordItems: 1_000,
  defaultItems: 200,
});

function structureVisitor(initialRecords: number): (value: unknown, depth: number) => void {
  let records = initialRecords;
  const visit = (value: unknown, depth: number): void => {
    if (depth >= RESULT_READ_STRUCTURE_BUDGET.maxDepth) {
      throw new ContentReferenceError('limit', 'The content page exceeds the result_read depth budget.');
    }
    if (value === null || typeof value !== 'object') return;
    const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
    records += children.length;
    if (records >= RESULT_READ_STRUCTURE_BUDGET.maxRecords) {
      throw new ContentReferenceError('limit', 'The content page exceeds the result_read aggregate record budget.');
    }
    for (const child of children) visit(child, depth + 1);
  };
  return visit;
}

/** Incremental admission includes the data array slot and reserved output fields. */
export function createContentPageBudget(): Readonly<{ admit(value: unknown): void }> {
  const visit = structureVisitor(RESULT_READ_STRUCTURE_BUDGET.wrapperRecords);
  return Object.freeze({ admit(value: unknown): void { visit([value], 1); } });
}

/** Check the actual whole handler payload, including wrapper fields, before return. */
export function assertResultReadOutputBudget(value: unknown): void {
  structureVisitor(0)(value, 0);
}

export type ContentReferenceRecord = Readonly<{
  schemaVersion: 1;
  contentRef: string;
  artifactId: string;
  revision: string;
  owner: ContentOwnerScope;
  createdAt: string;
  expiresAt?: string;
  pinnedUntil?: string;
}>;

export type ContentReadRequest = Readonly<{
  contentRef: string;
  access: ContentAccessScope;
  mode: ContentReadMode;
  cursor?: string;
  offset?: number;
  limit: number;
  signal?: AbortSignal;
  deadline?: string;
}>;

/** Opens the complete owner-scoped content as a verified byte stream. */
export type ContentOpenRequest = Readonly<{
  contentRef: string;
  access: ContentAccessScope;
  signal?: AbortSignal;
  deadline?: string;
}>;

export type OpenedContent = Readonly<{
  stream: ReadableStream<Uint8Array>;
  contentRef: string;
  contentType: string;
  byteSize: number;
  checksum: string;
}>;

export type ContentReadResult = Readonly<{
  contentRef: string;
  mode: ContentReadMode;
  contentType: string;
  totalBytes: number;
  offset: number;
  preview: string;
  data: string | readonly unknown[];
  encoding?: 'utf-8' | 'base64';
  nextCursor?: string;
  eof: boolean;
}>;

export type ContentReferenceErrorCode =
  | 'invalid_reference'
  | 'invalid_cursor'
  | 'type_mismatch'
  | 'forbidden'
  | 'expired'
  | 'not_found'
  | 'limit';

export class ContentReferenceError extends Error {
  constructor(readonly code: ContentReferenceErrorCode, message: string) {
    super(message);
    this.name = 'ContentReferenceError';
  }
}

const CONTENT_REF = /^schemanaut-content:v1:(artifact_[a-f0-9]{64}):([a-f0-9]{64})$/u;
const CONTENT_CURSOR = /^schemanaut-cursor:v2:(text|line|record|byte):(\d+):([a-f0-9]{64})$/u;

export function mintContentReference(input: Readonly<{
  artifactId: string;
  owner: ContentOwnerScope;
  revision: string;
  nonce: string;
}>): string {
  const artifactId = requireArtifactId(input.artifactId);
  const owner = normalizeContentOwner(input.owner);
  const revision = requireToken(input.revision, 'revision');
  const nonce = requireToken(input.nonce, 'nonce');
  const digest = sha256(JSON.stringify({ artifactId, owner, revision, nonce }));
  return `schemanaut-content:v1:${artifactId}:${digest}`;
}

export function parseContentReference(value: unknown): Readonly<{
  contentRef: string;
  artifactId: string;
}> {
  if (typeof value !== 'string' || value.length > 256) throw invalidReference();
  const match = CONTENT_REF.exec(value);
  if (match === null) throw invalidReference();
  return Object.freeze({ contentRef: value, artifactId: match[1]! });
}

export function normalizeContentOwner(value: ContentOwnerScope): ContentOwnerScope {
  if (value === null || typeof value !== 'object') throw invalidReference();
  return Object.freeze({
    hostId: requireIdentity(value.hostId, 'hostId'),
    sessionId: requireIdentity(value.sessionId, 'sessionId'),
    runId: requireIdentity(value.runId, 'runId'),
    invocationId: requireIdentity(value.invocationId, 'invocationId'),
    ...(value.projectId === undefined
      ? {}
      : { projectId: requireIdentity(value.projectId, 'projectId') }),
  });
}

export function normalizeContentAccess(value: ContentAccessScope): ContentAccessScope {
  if (value === null || typeof value !== 'object') throw invalidReference();
  return Object.freeze({
    hostId: requireIdentity(value.hostId, 'hostId'),
    sessionId: requireIdentity(value.sessionId, 'sessionId'),
    runId: requireIdentity(value.runId, 'runId'),
    ...(value.projectId === undefined
      ? {}
      : { projectId: requireIdentity(value.projectId, 'projectId') }),
  });
}

export function assertContentAccess(owner: ContentOwnerScope, access: ContentAccessScope): void {
  const normalizedOwner = normalizeContentOwner(owner);
  const normalizedAccess = normalizeContentAccess(access);
  if (
    normalizedOwner.hostId !== normalizedAccess.hostId ||
    normalizedOwner.sessionId !== normalizedAccess.sessionId ||
    normalizedOwner.runId !== normalizedAccess.runId ||
    (normalizedOwner.projectId !== undefined &&
      normalizedOwner.projectId !== normalizedAccess.projectId)
  ) {
    throw new ContentReferenceError('forbidden', 'The content reference belongs to another owner scope.');
  }
}

export function mintContentCursor(
  contentRef: string,
  mode: ContentReadMode,
  offset: number,
  authority: ContentCursorAuthority,
): string {
  parseContentReference(contentRef);
  assertReadMode(mode);
  assertOffset(offset, 'offset');
  const binding = cursorAuthentication(contentRef, mode, offset, authority);
  return `schemanaut-cursor:v2:${mode}:${offset}:${binding}`;
}

export function resolveContentOffset(input: Readonly<{
  contentRef: string;
  mode: ContentReadMode;
  cursor?: string;
  offset?: number;
}>, authority?: ContentCursorAuthority): number {
  parseContentReference(input.contentRef);
  assertReadMode(input.mode);
  if (input.cursor !== undefined && input.offset !== undefined) {
    throw new ContentReferenceError('invalid_cursor', 'Use either cursor or offset, not both.');
  }
  if (input.cursor === undefined) {
    const offset = input.offset ?? 0;
    assertOffset(offset, 'offset');
    if (input.mode === 'record' && offset !== 0) {
      throw new ContentReferenceError(
        'invalid_cursor',
        'Non-zero record reads require a Runtime-issued record cursor.',
      );
    }
    return offset;
  }
  if (typeof input.cursor !== 'string' || input.cursor.length > 256) throw invalidCursor();
  const match = CONTENT_CURSOR.exec(input.cursor);
  if (match === null || match[1] !== input.mode) throw invalidCursor();
  const offset = Number(match[2]);
  assertOffset(offset, 'cursor offset');
  // Without authority this only validates syntax during prepare. The Store must
  // authenticate again after owner and persisted generation resolution.
  if (authority !== undefined && !timingSafeEqual(
    Buffer.from(match[3]!, 'hex'),
    Buffer.from(cursorAuthentication(input.contentRef, input.mode, offset, authority), 'hex'),
  )) {
    throw invalidCursor();
  }
  return offset;
}

function cursorAuthentication(ref: string, mode: ContentReadMode, offset: number, authority: ContentCursorAuthority): string {
  if (!/^[a-f0-9]{64}$/u.test(authority.key)) throw invalidCursor();
  return createHmac('sha256', Buffer.from(authority.key, 'hex'))
    .update(JSON.stringify([ref, mode, offset, normalizeContentOwner(authority.owner), authority.generation]))
    .digest('hex');
}

export function assertReadMode(value: unknown): asserts value is ContentReadMode {
  if (value !== 'text' && value !== 'line' && value !== 'record' && value !== 'byte') {
    throw new ContentReferenceError('type_mismatch', 'The requested content read mode is unsupported.');
  }
}

export function assertContentLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_048_576) {
    throw new ContentReferenceError('limit', 'The content read limit must be between 1 and 1048576.');
  }
}

function assertOffset(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ContentReferenceError('invalid_cursor', `${label} must be a non-negative safe integer.`);
  }
}

function requireArtifactId(value: unknown): string {
  if (typeof value !== 'string' || !/^artifact_[a-f0-9]{64}$/u.test(value)) throw invalidReference();
  return value;
}

function requireIdentity(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 512) {
    throw new ContentReferenceError('invalid_reference', `${label} is invalid.`);
  }
  return value;
}

function requireToken(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512) {
    throw new ContentReferenceError('invalid_reference', `${label} is invalid.`);
  }
  return value;
}

function invalidReference(): ContentReferenceError {
  return new ContentReferenceError('invalid_reference', 'The content reference is malformed.');
}

function invalidCursor(): ContentReferenceError {
  return new ContentReferenceError('invalid_cursor', 'The cursor is malformed or belongs to another content reference.');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
