import type { RunLeaseReference } from '../events/agent-journal.js';
import type {
  ContentAccessScope,
  ContentOpenRequest,
  ContentOwnerScope,
  ContentReadRequest,
  ContentReadResult,
  OpenedContent,
} from './content-reference.js';
import type {
  EvidenceReferenceResolver,
  RuntimeEvidenceReferenceRecord,
} from '../evidence-reference.js';

export type ArtifactAvailability =
  | 'staged'
  | 'available'
  | 'legacy-unavailable'
  | 'expired'
  | 'deleted';

export type ArtifactChecksum = string;

export type StagedArtifact = {
  schemaVersion: 1;
  artifactId: string;
  handle: string;
  projectId: string;
  checksum: ArtifactChecksum;
  byteSize: number;
  mediaType: string;
  availability: 'staged';
  stagedAt: string;
  expiresAt?: string;
  contentRef?: string;
  owner?: ContentOwnerScope;
  evidence?: RuntimeEvidenceReferenceRecord;
  pinnedUntil?: string;
};

export type ArtifactIoContext = Readonly<{
  signal?: AbortSignal;
  deadline?: string;
  startOffset?: number;
}>;

export type ArtifactRef = Omit<StagedArtifact, 'availability' | 'stagedAt'> & {
  availability: 'available';
  createdAt: string;
};

export type LegacyUnavailableArtifactRef = Omit<
  ArtifactRef,
  'availability' | 'checksum' | 'byteSize' | 'createdAt'
> & {
  availability: 'legacy-unavailable';
  checksum: null;
  byteSize: null;
};

export type ReadableArtifactRef = ArtifactRef | LegacyUnavailableArtifactRef;

export type StageArtifactInput = {
  mediaType: string;
  source: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;
  expectedChecksum?: ArtifactChecksum;
  expectedByteSize?: number;
  expiresAt?: string;
  /** Required for Runtime-readable content; legacy/manual artifacts may omit it. */
  owner?: ContentOwnerScope;
  /** Pins content through this instant, independently from its ordinary expiry. */
  pinnedUntil?: string;
  signal?: AbortSignal;
  deadline?: string;
};

export type ArtifactJournalContext = {
  sessionId: string;
  runId: string;
  commandId: string;
  lease: RunLeaseReference;
  expectedRunRevision: number;
};

export type CommitArtifactInput = {
  staged: StagedArtifact;
  journal: ArtifactJournalContext;
  summary: string;
};

export type ArtifactGcReport = {
  stagedObjectsDeleted: number;
  committedObjectsDeleted: number;
  orphanTemporaryFilesDeleted: number;
  bytesDeleted: number;
};

export type ArtifactStoreErrorCode =
  | 'INVALID_ARGUMENT'
  | 'STAGE_FAILED'
  | 'PROJECT_MISMATCH'
  | 'CHECKSUM_MISMATCH'
  | 'SIZE_MISMATCH'
  | 'METADATA_CONFLICT'
  | 'JOURNAL_REFERENCE_CONFLICT'
  | 'NOT_COMMITTED'
  | 'NOT_FOUND'
  | 'CORRUPT'
  | 'EXPIRED'
  | 'DELETED'
  | 'LEGACY_UNAVAILABLE'
  | 'STATE_MIGRATION_ACTIVE'
  | 'STORE_BUSY'
  | 'LIMIT_EXCEEDED'
  | 'INJECTED_CRASH';

export class ArtifactStoreError extends Error {
  constructor(
    readonly code: ArtifactStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ArtifactStoreError';
  }
}

/** The bounded call ended; its physical operations are still owned by cleanup. */
export class ArtifactIoInterruption extends ArtifactStoreError {
  readonly cleanup: Promise<void>;
  constructor(error: Error, cleanup: Promise<void>) {
    super('STAGE_FAILED', error.message);
    this.name = error.name;
    // A cleanup may itself cross the foreground deadline. Follow its physical
    // cleanup authority instead of treating that bounded return as completion.
    this.cleanup = cleanup.catch((failure: unknown) => {
      if (failure instanceof ArtifactIoInterruption) return failure.cleanup;
      throw failure;
    });
    void this.cleanup.catch(() => undefined); // Observe without changing rejection.
  }
}

export interface AgentArtifactStore extends EvidenceReferenceResolver {
  /** Wait for physical late I/O; reject if any cleanup could not be confirmed. */
  drain?(): Promise<void>;
  stage(input: StageArtifactInput): Promise<StagedArtifact>;
  commit(input: CommitArtifactInput): Promise<ArtifactRef>;
  open(ref: ReadableArtifactRef, context?: ArtifactIoContext): Promise<ReadableStream<Uint8Array>>;
  openContent(input: ContentOpenRequest): Promise<OpenedContent>;
  readContent(input: ContentReadRequest): Promise<ContentReadResult>;
  pinContent(input: Readonly<{
    contentRef: string;
    access: ContentAccessScope;
    pinnedUntil: string;
  }>): Promise<void>;
  collectGarbage(now: Date): Promise<ArtifactGcReport>;
}
