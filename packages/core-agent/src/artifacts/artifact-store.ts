import type { RunLeaseReference } from '../events/agent-journal.js';

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
};

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
  | 'STORE_BUSY'
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

export interface AgentArtifactStore {
  stage(input: StageArtifactInput): Promise<StagedArtifact>;
  commit(input: CommitArtifactInput): Promise<ArtifactRef>;
  open(ref: ReadableArtifactRef): Promise<ReadableStream<Uint8Array>>;
  collectGarbage(now: Date): Promise<ArtifactGcReport>;
}
