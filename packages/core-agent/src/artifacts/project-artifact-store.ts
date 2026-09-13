import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { AgentEvent } from '../events/agent-event.js';
import type { AgentJournal } from '../events/agent-journal.js';
import {
  ArtifactStoreError,
  ArtifactIoInterruption,
  type AgentArtifactStore,
  type ArtifactGcReport,
  type ArtifactJournalContext,
  type ArtifactIoContext,
  type ArtifactRef,
  type ReadableArtifactRef,
  type CommitArtifactInput,
  type StageArtifactInput,
  type StagedArtifact,
} from './artifact-store.js';
import {
  ContentReferenceError,
  RESULT_READ_STRUCTURE_BUDGET,
  assertResultReadOutputBudget,
  createContentPageBudget,
  assertContentAccess,
  assertContentLimit,
  assertReadMode,
  mintContentCursor,
  mintContentReference,
  normalizeContentAccess,
  normalizeContentOwner,
  parseContentReference,
  resolveContentOffset,
  type ContentAccessScope,
  type ContentOpenRequest,
  type ContentOwnerScope,
  type ContentReadRequest,
  type ContentReadResult,
  type OpenedContent,
} from './content-reference.js';
import {
  EVIDENCE_REFERENCE_REVISION,
  assertEvidenceReferenceAccess,
  mintRuntimeEvidenceReference,
  parseRuntimeEvidenceReference,
  type EvidenceReferenceResolution,
  type RuntimeEvidenceReferenceRecord,
} from '../evidence-reference.js';
import {
  acquireArtifactMutationGate,
  ArtifactMutationGateTimeoutError,
} from './artifact-mutation-gate.js';
import {
  acquireSharedStateWriterGate,
  legacyProjectDirForArtifactRoot,
  StateWriterGateError,
} from '../session/state-writer-gate.js';
import {
  bindToolArtifactCommitter,
  inspectPreparedToolArtifact,
  mintPreparedToolArtifact,
  type PrepareToolArtifactInput,
  type PreparedToolArtifactCommit,
} from '../internal/prepared-tool-artifact-authority.js';

export * from './artifact-store.js';

export type ArtifactCrashPoint = 'after-journal-before-promotion';

export type ProjectArtifactStoreOptions = {
  projectId: string;
  rootDir: string;
  journal: AgentJournal;
  now?: () => string;
  createId?: () => string;
  writeChunk?: (file: FileHandle, chunk: Uint8Array, offset: number) => Promise<number>;
  afterOpenVerified?: (objectPath: string) => Promise<void>;
  beforeOpenPrehash?: () => Promise<void>;
  afterCommitBytesVerified?: () => Promise<void>;
  mutationGateTimeoutMs?: number;
  stagedOrphanRetentionMs?: number;
  contentRetentionGraceMs?: number;
  maxArtifactBytes?: number;
  maxRunBytes?: number;
  maxSessionBytes?: number;
  maxProjectBytes?: number;
  crashAt?: ArtifactCrashPoint;
};

type StagedMetadata = StagedArtifact & {
  storageVersion: 1;
  blobName: string;
  cursorKey: string | null;
};

type CommittedMetadata = ArtifactRef & {
  storageVersion: 1;
  objectName: string;
  expiresAt?: string;
  cursorKey: string | null;
};

type OwnedCommittedMetadata = CommittedMetadata & {
  contentRef: string;
  owner: ContentOwnerScope;
};

type CreatedArtifactFact = Extract<AgentEvent, { type: 'artifact.created' }>;
type FileGeneration = Readonly<{
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;
type ArtifactFactState = {
  fact: CreatedArtifactFact;
  explicitLifecycle?: 'expired' | 'deleted';
};

const ORPHAN_STAGE_TEMP_MAX_AGE_MS = 60_000;
const DEFAULT_STAGED_ORPHAN_RETENTION_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_CONTENT_RETENTION_GRACE_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAX_RUN_BYTES = 4 * DEFAULT_MAX_ARTIFACT_BYTES;
const DEFAULT_MAX_SESSION_BYTES = 16 * DEFAULT_MAX_ARTIFACT_BYTES;
const DEFAULT_MAX_PROJECT_BYTES = 64 * DEFAULT_MAX_ARTIFACT_BYTES;
const MAX_VERIFIED_OBJECT_GENERATIONS = 512;

export class ProjectArtifactStore implements AgentArtifactStore {
  readonly #projectId: string;
  readonly #rootDir: string;
  readonly #journal: AgentJournal;
  readonly #now: () => string;
  readonly #createId: () => string;
  readonly #writeChunk: (file: FileHandle, chunk: Uint8Array, offset: number) => Promise<number>;
  readonly #afterOpenVerified: ((objectPath: string) => Promise<void>) | undefined;
  readonly #beforeOpenPrehash: (() => Promise<void>) | undefined;
  readonly #afterCommitBytesVerified: (() => Promise<void>) | undefined;
  readonly #mutationGateTimeoutMs: number;
  readonly #stagedOrphanRetentionMs: number;
  readonly #contentRetentionGraceMs: number;
  readonly #maxArtifactBytes: number;
  readonly #maxRunBytes: number;
  readonly #maxSessionBytes: number;
  readonly #maxProjectBytes: number;
  readonly #preparedArtifactOwner = Object.freeze(Object.create(null)) as object;
  readonly #verifiedObjectGenerations = new Map<string, FileGeneration>();
  readonly #artifactStateIndex = new Map<string, ArtifactFactState>();
  #artifactStateCursor = 0;
  readonly #pendingCleanup = new Set<Promise<void>>();
  readonly #activeOperations = new Set<Promise<unknown>>();
  readonly #cleanupFailures: unknown[] = [];
  #crashAt: ArtifactCrashPoint | undefined;

  constructor(options: ProjectArtifactStoreOptions) {
    this.#projectId = requireText(options.projectId, 'projectId');
    this.#rootDir = resolve(requireText(options.rootDir, 'rootDir'));
    this.#journal = options.journal;
    this.#now = options.now ?? (() => new Date().toISOString());
    const createId = options.createId ?? randomUUID;
    this.#createId = () => requireOpaqueId(createId());
    this.#writeChunk = options.writeChunk ?? (async (file, chunk, offset) =>
      (await file.write(chunk, offset, chunk.byteLength - offset, null)).bytesWritten);
    this.#afterOpenVerified = options.afterOpenVerified;
    this.#beforeOpenPrehash = options.beforeOpenPrehash;
    this.#afterCommitBytesVerified = options.afterCommitBytesVerified;
    this.#mutationGateTimeoutMs = options.mutationGateTimeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.#mutationGateTimeoutMs) ||
      this.#mutationGateTimeoutMs < 100 || this.#mutationGateTimeoutMs > 60_000) {
      throw new ArtifactStoreError(
        'INVALID_ARGUMENT',
        'mutationGateTimeoutMs must be between 100 and 60000.',
      );
    }
    this.#stagedOrphanRetentionMs = options.stagedOrphanRetentionMs ??
      DEFAULT_STAGED_ORPHAN_RETENTION_MS;
    if (!Number.isSafeInteger(this.#stagedOrphanRetentionMs) ||
      this.#stagedOrphanRetentionMs < 0) {
      throw new ArtifactStoreError(
        'INVALID_ARGUMENT', 'stagedOrphanRetentionMs must be a non-negative safe integer.',
      );
    }
    this.#contentRetentionGraceMs = options.contentRetentionGraceMs ??
      DEFAULT_CONTENT_RETENTION_GRACE_MS;
    if (!Number.isSafeInteger(this.#contentRetentionGraceMs) || this.#contentRetentionGraceMs < 0) {
      throw new ArtifactStoreError(
        'INVALID_ARGUMENT', 'contentRetentionGraceMs must be a non-negative safe integer.',
      );
    }
    this.#maxArtifactBytes = quota(options.maxArtifactBytes, DEFAULT_MAX_ARTIFACT_BYTES, 'maxArtifactBytes');
    this.#maxRunBytes = quota(options.maxRunBytes, DEFAULT_MAX_RUN_BYTES, 'maxRunBytes');
    this.#maxSessionBytes = quota(options.maxSessionBytes, DEFAULT_MAX_SESSION_BYTES, 'maxSessionBytes');
    this.#maxProjectBytes = quota(options.maxProjectBytes, DEFAULT_MAX_PROJECT_BYTES, 'maxProjectBytes');
    if (
      this.#maxArtifactBytes > this.#maxRunBytes || this.#maxRunBytes > this.#maxSessionBytes ||
      this.#maxSessionBytes > this.#maxProjectBytes
    ) {
      throw new ArtifactStoreError(
        'INVALID_ARGUMENT',
        'Artifact quotas must increase from artifact to Run, Session, and Project.',
      );
    }
    this.#crashAt = options.crashAt;
    bindToolArtifactCommitter(this, {
      journalOwner: this.#journal,
      prepare: async (input) => await this.#own(this.#prepareToolCommit(input)),
      complete: async (prepared) => await this.#own(this.#completeToolCommit(prepared)),
      release: (prepared) => this.#releaseToolCommit(prepared),
    });
  }

  async stage(input: StageArtifactInput): Promise<StagedArtifact> {
    return this.#own(this.#stage(input));
  }

  #trackCleanup(cleanup: Promise<void>): void {
    if (this.#pendingCleanup.has(cleanup)) return;
    this.#pendingCleanup.add(cleanup);
    void cleanup.then(() => this.#pendingCleanup.delete(cleanup), (error: unknown) => {
      this.#pendingCleanup.delete(cleanup);
      if (this.#cleanupFailures.length < 32) this.#cleanupFailures.push(error);
    });
  }

  async #own<T>(operation: Promise<T>): Promise<T> {
    this.#activeOperations.add(operation);
    try { return await operation; }
    catch (error) {
      if (error instanceof ArtifactIoInterruption) this.#trackCleanup(error.cleanup);
      throw error;
    } finally {
      this.#activeOperations.delete(operation);
    }
  }

  async drain(): Promise<void> {
    while (this.#pendingCleanup.size > 0 || this.#activeOperations.size > 0) {
      await Promise.allSettled([...this.#pendingCleanup, ...this.#activeOperations]);
    }
    if (this.#cleanupFailures.length > 0) throw new AggregateError(this.#cleanupFailures, 'Artifact cleanup could not be confirmed.');
  }

  async #stage(input: StageArtifactInput): Promise<StagedArtifact> {
    validateStageInput(input);
    const gates = await awaitIoOrAbort(this.#acquireLifecycleGates(), input, (lateGates) => {
      lateGates.close();
    });
    let releaseGate = true;
    try {
      return await this.#stageWithStateGate(input);
    } catch (error) {
      if (error instanceof ArtifactIoInterruption) {
        releaseGate = false;
        void error.cleanup.then(() => gates.close(), () => undefined);
      }
      throw error;
    } finally {
      if (releaseGate) gates.close();
    }
  }

  async #stageWithStateGate(input: StageArtifactInput): Promise<StagedArtifact> {
    assertIoActive(input);
    const mediaType = requireMediaType(input.mediaType);
    const expectedByteSize = input.expectedByteSize;
    if (
      expectedByteSize !== undefined &&
      (!Number.isSafeInteger(expectedByteSize) || expectedByteSize < 0)
    ) {
      throw new ArtifactStoreError('INVALID_ARGUMENT', 'expectedByteSize must be non-negative.');
    }
    if (input.expiresAt !== undefined) requireExactIso(input.expiresAt, 'expiresAt');
    if (input.pinnedUntil !== undefined) requireExactIso(input.pinnedUntil, 'pinnedUntil');
    const owner = input.owner === undefined ? undefined : normalizeContentOwner(input.owner);
    if (owner?.projectId !== undefined && owner.projectId !== this.#projectId) {
      throw new ArtifactStoreError('PROJECT_MISMATCH', 'Content owner belongs to another Project.');
    }
    let temporaryPath: string | undefined;
    let file: FileHandle | undefined;
    let createdBlobPath: string | undefined;
    let createdMetadataPath: string | undefined;
    try {
      await this.#ensureDirectories(input);
      temporaryPath = join(this.#stagedDir(), `.stage-${this.#createId()}.tmp`);
      file = await awaitIoOrAbort(open(temporaryPath, 'wx', 0o600), input, async (lateFile) => {
        await lateFile.close();
      });
      const hash = createHash('sha256');
      let byteSize = 0;
      for await (const chunk of asAsyncIterable(input.source, input)) {
        assertIoActive(input);
        if (!(chunk instanceof Uint8Array)) {
          throw new ArtifactStoreError('INVALID_ARGUMENT', 'Artifact chunks must be Uint8Array.');
        }
        byteSize += chunk.byteLength;
        if (!Number.isSafeInteger(byteSize) || byteSize > this.#maxArtifactBytes) {
          throw new ArtifactStoreError('LIMIT_EXCEEDED', 'Artifact exceeds the per-artifact storage limit.');
        }
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.byteLength) {
          const bytesWritten = await awaitIoOrAbort(this.#writeChunk(file, chunk, offset), input);
          assertIoActive(input);
          if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 ||
            bytesWritten > chunk.byteLength - offset) {
            throw new ArtifactStoreError('STAGE_FAILED', 'Artifact write made invalid progress.');
          }
          offset += bytesWritten;
        }
      }
      await awaitIoOrAbort(file.sync(), input);
      assertIoActive(input);
      const completedFile = file;
      file = undefined;
      await awaitIoOrAbort(completedFile.close(), input);

      const checksum = hash.digest('hex');
      await this.#assertContentQuota(owner, byteSize, input);
      await verifyFile(temporaryPath, checksum, byteSize, input);
      if (input.expectedChecksum !== undefined && input.expectedChecksum !== checksum) {
        throw new ArtifactStoreError('CHECKSUM_MISMATCH', 'Staged bytes did not match checksum.');
      }
      if (expectedByteSize !== undefined && expectedByteSize !== byteSize) {
        throw new ArtifactStoreError('SIZE_MISMATCH', 'Staged bytes did not match exact byte size.');
      }
      const referenceNonce = this.#createId();
      const artifactId = `artifact_${sha256(`${this.#projectId}\0${checksum}\0${referenceNonce}`)}`;
      const handle = `agent-artifact:${sha256(this.#projectId).slice(0, 24)}:${artifactId.slice(-40)}`;
      const blobName = `${artifactId}.blob`;
      const stagedAt = requireExactIso(this.#now(), 'stagedAt');
      const contentRef = owner === undefined ? undefined : mintContentReference({
        artifactId,
        owner,
        revision: `sha256:${checksum}`,
        nonce: referenceNonce,
      });
      const evidence = owner === undefined || contentRef === undefined
        ? undefined
        : mintRuntimeEvidenceReference({
            artifactId,
            contentRef,
            owner,
            revision: EVIDENCE_REFERENCE_REVISION,
            issuedAt: stagedAt,
            nonce: referenceNonce,
          });
      const staged: StagedMetadata = {
        storageVersion: 1,
        schemaVersion: 1,
        artifactId,
        handle,
        projectId: this.#projectId,
        checksum,
        byteSize,
        mediaType,
        availability: 'staged',
        stagedAt,
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        ...(input.pinnedUntil === undefined ? {} : { pinnedUntil: input.pinnedUntil }),
        ...(contentRef === undefined ? {} : { contentRef }),
        cursorKey: contentRef === undefined ? null : randomBytes(32).toString('hex'),
        ...(owner === undefined ? {} : { owner }),
        ...(evidence === undefined ? {} : { evidence }),
        blobName,
      };
      const blobPath = containedPath(this.#stagedDir(), blobName);
      try {
        await awaitIoOrAbort(rename(temporaryPath, blobPath), input, () => {
          temporaryPath = undefined;
          createdBlobPath = blobPath;
        });
        temporaryPath = undefined;
        createdBlobPath = blobPath;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        await awaitIoOrAbort(rm(temporaryPath!, { force: true }), input);
        temporaryPath = undefined;
        await verifyFile(blobPath, checksum, byteSize, input);
      }
      await verifyFile(blobPath, checksum, byteSize, input);
      await fsyncDirectory(this.#stagedDir(), input);
      const stagedMetadataPath = this.#stagedMetadataPath(artifactId);
      await writeAtomicJson(stagedMetadataPath, staged, this.#createId, input, () => {
        createdMetadataPath = stagedMetadataPath;
      });
      assertIoActive(input);
      createdBlobPath = undefined;
      createdMetadataPath = undefined;
      return publicStaged(staged);
    } catch (error) {
      const inheritedCleanup = error instanceof ArtifactIoInterruption
        ? error.cleanup
        : Promise.resolve();
      const localCleanup = (async () => {
        await afterCleanup(inheritedCleanup, async () => {
          await file?.close();
          await settleAll([
            temporaryPath === undefined ? Promise.resolve() : rm(temporaryPath, { force: true }),
            createdBlobPath === undefined ? Promise.resolve() : rm(createdBlobPath, { force: true }),
            createdMetadataPath === undefined ? Promise.resolve() : rm(createdMetadataPath, { force: true }),
          ]);
        });
      })();
      if (isIoInterruption(error)) {
        throw new ArtifactIoInterruption(error, localCleanup);
      }
      await awaitIoOrAbort(localCleanup, input);
      if (error instanceof ArtifactStoreError) throw error;
      throw new ArtifactStoreError(
        'STAGE_FAILED',
        `Artifact staging failed${errorCode(error) === undefined ? '' : ` (${errorCode(error)})`}.`,
      );
    }
  }

  async commit(input: CommitArtifactInput): Promise<ArtifactRef> {
    const gates = await this.#acquireLifecycleGates();
    try {
      return await this.#commitWithGate(input);
    } finally {
      gates.close();
    }
  }

  async #commitWithGate(input: CommitArtifactInput): Promise<ArtifactRef> {
    assertStagedArtifact(input.staged, this.#projectId);
    this.#assertProject(input.staged.projectId);
    const summary = requireText(input.summary, 'summary');
    const candidate = await this.#verifyCommitCandidate(input.staged);

    let fact = await this.#findCreatedFact(input.staged.artifactId);
    if (fact !== undefined) assertMatchingFact(fact, input.staged, input.journal.runId, summary);
    if (fact === undefined) {
      try {
        await this.#journal.commit({
          projectId: this.#projectId,
          sessionId: input.journal.sessionId,
          runId: input.journal.runId,
          commandId: input.journal.commandId,
          lease: input.journal.lease,
          expectedRunRevision: input.journal.expectedRunRevision,
          events: [
            {
              type: 'artifact.created',
              payload: {
                artifactId: input.staged.artifactId,
                handle: input.staged.handle,
                checksum: input.staged.checksum,
                byteSize: input.staged.byteSize,
                mediaType: input.staged.mediaType,
                availability: 'available',
                summary,
                ...(candidate.expiresAt === undefined ? {} : { expiresAt: candidate.expiresAt }),
              },
            },
          ],
        });
      } catch (error) {
        fact = await this.#findCreatedFact(input.staged.artifactId);
        if (fact === undefined) throw error;
      }
      fact = await this.#findCreatedFact(input.staged.artifactId);
    }
    if (fact === undefined) {
      throw new ArtifactStoreError(
        'NOT_COMMITTED',
        'Journal did not expose the committed artifact reference.',
      );
    }
    assertMatchingFact(fact, input.staged, input.journal.runId, summary);
    if (this.#crashAt === 'after-journal-before-promotion') {
      this.#crashAt = undefined;
      throw new ArtifactStoreError('INJECTED_CRASH', 'Injected artifact promotion crash.');
    }
    return await this.#promote(input.staged, fact.occurredAt);
  }

  /**
   * Verifies staged bytes and mints an in-process authority that only the
   * sealed Tool lifecycle committer can turn into an `artifact.created` fact.
   * No Journal mutation occurs here: the fact is committed atomically with
   * the Tool terminal transition.
   */
  async #prepareToolCommit(
    input: PrepareToolArtifactInput,
  ): Promise<PreparedToolArtifactCommit> {
    const gates = await awaitIoOrAbort(this.#acquireLifecycleGates(), input, (late) => late.close());
    try {
      assertStagedArtifact(input.staged, this.#projectId);
      this.#assertProject(input.staged.projectId);
      const sessionId = requireText(input.sessionId, 'sessionId');
      const runId = requireText(input.runId, 'runId');
      const turnId = requireText(input.turnId, 'turnId');
      const invocationId = requireText(input.invocationId, 'invocationId');
      const idempotencyKey = requireText(input.idempotencyKey, 'idempotencyKey');
      if (!Number.isSafeInteger(input.startedAttempt) || input.startedAttempt < 1) {
        throw new ArtifactStoreError(
          'INVALID_ARGUMENT', 'startedAttempt must be a positive safe integer.',
        );
      }
      if (!Number.isSafeInteger(input.fencingToken) || input.fencingToken < 1) {
        throw new ArtifactStoreError(
          'INVALID_ARGUMENT', 'fencingToken must be a positive safe integer.',
        );
      }
      const summary = requireText(input.summary, 'summary');
      const candidate = await this.#verifyCommitCandidate(input.staged, input);
      if (
        candidate.expiresAt !== undefined &&
        Date.parse(candidate.expiresAt) <= Date.parse(this.#now())
      ) {
        throw new ArtifactStoreError('EXPIRED', 'Expired Artifact bytes cannot be prepared.');
      }
      const existing = await this.#findCreatedFact(input.staged.artifactId, input);
      if (existing !== undefined) assertMatchingFact(existing, input.staged, runId, summary);
      return mintPreparedToolArtifact({
        owner: this.#preparedArtifactOwner,
        journalOwner: this.#journal,
        projectId: this.#projectId,
        sessionId,
        runId,
        turnId,
        invocationId,
        startedAttempt: input.startedAttempt,
        idempotencyKey,
        fencingToken: input.fencingToken,
        staged: input.staged,
        context: ioContext(input, 0),
        payload: {
          artifactId: input.staged.artifactId,
          handle: input.staged.handle,
          checksum: input.staged.checksum,
          byteSize: input.staged.byteSize,
          mediaType: input.staged.mediaType,
          availability: 'available',
          summary,
          ...(candidate.expiresAt === undefined ? {} : { expiresAt: candidate.expiresAt }),
        },
        lifecycle: {
          released: false,
          release: () => gates.close(),
        },
      });
    } catch (error) {
      if (error instanceof ArtifactIoInterruption) {
        void error.cleanup.then(() => gates.close(), () => undefined);
      } else gates.close();
      throw error;
    }
  }

  /** Promotes bytes after the Tool terminal and Artifact fact commit succeeds. */
  async #completeToolCommit(prepared: PreparedToolArtifactCommit): Promise<ArtifactRef> {
    const record = this.#requirePreparedToolArtifact(prepared);
    try {
      const fact = await this.#findCreatedFact(record.staged.artifactId, record.context);
      if (fact === undefined) {
        throw new ArtifactStoreError(
          'NOT_COMMITTED', 'Prepared Tool Artifact has no atomic Journal fact.',
        );
      }
      assertMatchingFact(fact, record.staged, record.runId, record.payload.summary);
      if (this.#crashAt === 'after-journal-before-promotion') {
        this.#crashAt = undefined;
        throw new ArtifactStoreError('INJECTED_CRASH', 'Injected artifact promotion crash.');
      }
      return await this.#promote(record.staged, fact.occurredAt, record.context);
    } catch (error) {
      if (error instanceof ArtifactIoInterruption) {
        record.lifecycle.draining = true;
        void error.cleanup.then(() => {
          record.lifecycle.draining = false;
          this.#releaseToolCommit(prepared);
        }, () => undefined);
      }
      throw error;
    } finally {
      this.#releaseToolCommit(prepared);
    }
  }

  #releaseToolCommit(prepared: PreparedToolArtifactCommit): void {
    const record = this.#requirePreparedToolArtifact(prepared);
    if (record.lifecycle.released || record.lifecycle.draining) return;
    record.lifecycle.released = true;
    record.lifecycle.release();
  }

  #requirePreparedToolArtifact(prepared: PreparedToolArtifactCommit) {
    const record = inspectPreparedToolArtifact(prepared);
    if (record.owner !== this.#preparedArtifactOwner || record.projectId !== this.#projectId) {
      throw new ArtifactStoreError(
        'PROJECT_MISMATCH', 'Prepared Tool Artifact belongs to another Artifact Store.',
      );
    }
    return record;
  }

  async open(ref: ReadableArtifactRef, context: ArtifactIoContext = {}): Promise<ReadableStream<Uint8Array>> {
    return this.#own(this.#open(ref, context));
  }

  async #open(ref: ReadableArtifactRef, context: ArtifactIoContext): Promise<ReadableStream<Uint8Array>> {
    assertIoActive(context);
    assertReadableArtifact(ref, this.#projectId);
    this.#assertProject(ref.projectId);
    const gates = await awaitIoOrAbort(this.#acquireLifecycleGates(), context, (lateGates) => {
      lateGates.close();
    });
    let file: FileHandle | undefined;
    let baseline: BigIntStats | undefined;
    let releaseGates = true;
    try {
      assertIoActive(context);
      const lifecycle = await this.#artifactLifecycle(ref.artifactId, new Date(this.#now()), context);
      if (lifecycle === 'deleted') throw new ArtifactStoreError('DELETED', 'Artifact was deleted.');
      const fact = await this.#findCreatedFact(ref.artifactId, context);
      if (fact === undefined) {
        throw new ArtifactStoreError('NOT_FOUND', 'Artifact has no committed Journal reference.');
      }
      if (fact.payload.availability === 'legacy-unavailable' ||
        ref.availability === 'legacy-unavailable') {
        throw new ArtifactStoreError('LEGACY_UNAVAILABLE', 'Legacy artifact content is unavailable.');
      }
      assertMatchingFact(fact, ref, fact.runId);
      let metadata = await this.#readCommittedMetadata(ref.artifactId, context);
      if (metadata === undefined) {
        metadata = await this.#readCommittedMetadata(ref.artifactId, context);
        if (metadata === undefined) {
          const staged = await this.#readStagedMetadata(ref.artifactId, context);
          if (staged === undefined) {
            throw new ArtifactStoreError('CORRUPT', 'Committed artifact metadata is missing.');
          }
          await this.#promote(publicStaged(staged), fact.occurredAt, context);
          metadata = await this.#readCommittedMetadata(ref.artifactId, context);
        }
      }
      if (metadata === undefined) {
        throw new ArtifactStoreError('CORRUPT', 'Committed artifact metadata is missing after promotion.');
      }
      assertPersistedArtifact(metadata, this.#projectId);
      assertArtifactInput(metadata, ref);
      if (lifecycle === 'expired') {
        throw new ArtifactStoreError('EXPIRED', 'Artifact has expired.');
      }
      assertIoActive(context);
      const objectPath = this.#objectPath(ref.checksum);
      file = await awaitIoOrAbort(open(objectPath, 'r'), context, async (lateFile) => {
        await lateFile.close();
      });
      baseline = await awaitIoOrAbort(file.stat({ bigint: true }), context);
      if (!baseline.isFile()) {
        throw new ArtifactStoreError('CORRUPT', 'Artifact object is not a file.');
      }
    } catch (error) {
      if (error instanceof ArtifactIoInterruption) {
        const cleanupFile = file;
        const cleanup = afterCleanup(
          error.cleanup,
          async () => { await cleanupFile?.close(); },
        );
        file = undefined;
        releaseGates = false;
        void cleanup.then(() => gates.close(), () => undefined);
        throw new ArtifactIoInterruption(error, cleanup);
      }
      const cleanup = file?.close() ?? Promise.resolve();
      try { await awaitIoOrAbort(cleanup, context); }
      catch (cleanupError) {
        releaseGates = false;
        const pending = cleanupError instanceof ArtifactIoInterruption ? cleanupError.cleanup : Promise.reject(normalizeArtifactReadError(cleanupError));
        void pending.then(() => gates.close(), () => undefined);
        throw new ArtifactIoInterruption(normalizeArtifactReadError(error), pending);
      }
      throw normalizeArtifactReadError(error);
    } finally {
      if (releaseGates) gates.close();
    }
    if (file === undefined || baseline === undefined) {
      throw new ArtifactStoreError('CORRUPT', 'Artifact stream was not initialized.');
    }
    const verifiedFile = file;
    const verifiedBaseline = baseline;
    try {
      const cachedGeneration = this.#verifiedObjectGenerations.get(ref.checksum);
      if (cachedGeneration === undefined || !sameFileGeneration(cachedGeneration, verifiedBaseline)) {
        if (this.#beforeOpenPrehash !== undefined) {
          await awaitIoOrAbort(this.#beforeOpenPrehash(), context);
        }
        await verifyPinnedOpenFile(
          verifiedFile, ref.checksum, ref.byteSize, verifiedBaseline, context,
        );
        this.#verifiedObjectGenerations.delete(ref.checksum);
        this.#verifiedObjectGenerations.set(ref.checksum, fileGeneration(verifiedBaseline));
        while (this.#verifiedObjectGenerations.size > MAX_VERIFIED_OBJECT_GENERATIONS) {
          const oldest = this.#verifiedObjectGenerations.keys().next().value;
          if (oldest === undefined) break;
          this.#verifiedObjectGenerations.delete(oldest);
        }
      } else {
        this.#verifiedObjectGenerations.delete(ref.checksum);
        this.#verifiedObjectGenerations.set(ref.checksum, cachedGeneration);
      }
      assertIoActive(context);
      if (this.#afterOpenVerified !== undefined) {
        await awaitIoOrAbort(this.#afterOpenVerified(this.#objectPath(ref.checksum)), context);
      }
    } catch (error) {
      const inheritedCleanup = error instanceof ArtifactIoInterruption
        ? error.cleanup
        : Promise.resolve();
      const cleanup = afterCleanup(inheritedCleanup, async () => {
        await verifiedFile.close();
      });
      if (isIoInterruption(error)) throw new ArtifactIoInterruption(error, cleanup);
      await awaitIoOrAbort(cleanup, context);
      throw normalizeArtifactReadError(error);
    }
    const startOffset = context.startOffset ?? 0;
    if (!Number.isSafeInteger(startOffset) || startOffset < 0 || startOffset > ref.byteSize) {
      await awaitIoOrAbort(verifiedFile.close(), context);
      throw new ArtifactStoreError('INVALID_ARGUMENT', 'Artifact startOffset is invalid.');
    }
    let position = startOffset;
    let closeAuthority: Promise<void> | undefined;
    const currentClose = (): Promise<void> | undefined => closeAuthority;
    let activePull = Promise.resolve();
    let pendingReadCleanup = Promise.resolve();
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let resolveClosed!: () => void;
    let rejectClosed!: (error: unknown) => void;
    const physicallyClosed = new Promise<void>((resolve, reject) => {
      resolveClosed = resolve; rejectClosed = reject;
    });
    this.#trackCleanup(physicallyClosed);
    const detachStreamBoundary = (): void => {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      context.signal?.removeEventListener('abort', stopStream);
    };
    const hash = createHash('sha256');
    const settleFile = (): Promise<void> => {
      closeAuthority ??= verifiedFile.close().then(() => {
        detachStreamBoundary(); resolveClosed();
      }, (error: unknown) => {
        detachStreamBoundary(); rejectClosed(error); throw error;
      });
      return closeAuthority;
    };
    const stopStream = (): void => {
      const cleanup = afterCleanup(activePull, () => afterCleanup(pendingReadCleanup, settleFile));
      this.#trackCleanup(cleanup);
      void cleanup.then(() => {
        try { assertIoActive(context); }
        catch (error) { streamController?.error(error); }
      }, (error: unknown) => { streamController?.error(error); });
    };
    const closeFile = async (): Promise<void> => {
      await awaitIoOrAbort(settleFile(), context);
    };
    const finish = async (): Promise<void> => {
      const extra = new Uint8Array(1);
      const extraRead = await awaitIoOrAbort(
        verifiedFile.read(extra, 0, 1, ref.byteSize), context,
      );
      const after = await awaitIoOrAbort(verifiedFile.stat({ bigint: true }), context);
      const rangeChecksumInvalid = startOffset === 0 && hash.digest('hex') !== ref.checksum;
      if (extraRead.bytesRead !== 0 || !sameFileGeneration(verifiedBaseline, after) ||
        after.size !== BigInt(ref.byteSize) || rangeChecksumInvalid) {
        throw new ArtifactStoreError(
          'CORRUPT',
          'Artifact bytes changed or failed terminal integrity validation.',
        );
      }
      await closeFile();
    };
    const trackCleanup = (cleanup: Promise<void>): void => this.#trackCleanup(cleanup);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        context.signal?.addEventListener('abort', stopStream, { once: true });
        if (context.deadline !== undefined) {
          deadlineTimer = setTimeout(stopStream, Math.max(0, Date.parse(context.deadline) - Date.now()));
          deadlineTimer.unref?.();
        }
        if (context.signal?.aborted) stopStream();
      },
      pull(controller) {
        activePull = (async () => {
        try {
          assertIoActive(context);
          if (position === ref.byteSize) {
            await finish();
            controller.close();
            return;
          }
          const buffer = new Uint8Array(Math.min(64 * 1024, ref.byteSize - position));
          const { bytesRead } = await awaitIoOrAbort(
            verifiedFile.read(buffer, 0, buffer.byteLength, position), context,
          );
          assertIoActive(context);
          if (bytesRead === 0) {
            throw new ArtifactStoreError('CORRUPT', 'Artifact ended before its declared byte size.');
          }
          position += bytesRead;
          const emitted = buffer.subarray(0, bytesRead);
          hash.update(emitted);
          controller.enqueue(emitted);
          if (position === ref.byteSize) {
            await finish();
            controller.close();
          }
        } catch (error) {
          const inheritedCleanup = error instanceof ArtifactIoInterruption
            ? error.cleanup
            : Promise.resolve();
          const cleanup = afterCleanup(inheritedCleanup, settleFile);
          pendingReadCleanup = cleanup;
          if (isIoInterruption(error)) {
            trackCleanup(cleanup);
            controller.error(new ArtifactIoInterruption(error, cleanup));
          } else {
            try { await awaitIoOrAbort(cleanup, context); }
            catch (cleanupError) {
              const pending = cleanupError instanceof ArtifactIoInterruption ? cleanupError.cleanup : Promise.reject(normalizeArtifactReadError(cleanupError));
              trackCleanup(pending);
              controller.error(new ArtifactIoInterruption(normalizeArtifactReadError(error), pending));
              return;
            }
            controller.error(normalizeArtifactReadError(error));
          }
        }
        })();
        return activePull;
      },
      async cancel() {
        if (closeAuthority !== undefined) return await closeAuthority;
        let failure: unknown;
        try {
          await awaitIoOrAbort(afterCleanup(activePull, () => pendingReadCleanup), context);
          const closing = currentClose();
          if (closing !== undefined) return await closing;
          const after = await awaitIoOrAbort(verifiedFile.stat({ bigint: true }), context);
          if (!sameFileGeneration(verifiedBaseline, after) || after.size !== BigInt(ref.byteSize)) {
            throw new ArtifactStoreError('CORRUPT', 'Artifact generation changed during range read.');
          }
        } catch (error) { failure = error; }
        const cleanup = afterCleanup(
          failure instanceof ArtifactIoInterruption ? failure.cleanup : Promise.resolve(), settleFile,
        );
        trackCleanup(cleanup);
        try { await awaitIoOrAbort(cleanup, context); }
        catch (error) {
          if (error instanceof ArtifactIoInterruption) trackCleanup(error.cleanup);
          throw error;
        }
        if (failure !== undefined) throw normalizeArtifactReadError(failure);
      },
    });
  }

  async openContent(input: ContentOpenRequest): Promise<OpenedContent> {
    return this.#own(this.#openContent(input));
  }

  async #openContent(input: ContentOpenRequest): Promise<OpenedContent> {
    const resolved = await this.#resolveAuthorizedContent(input);
    const stream = await this.#openResolvedContent(resolved, input, 0);
    return Object.freeze({
      stream,
      contentRef: resolved.contentRef,
      contentType: resolved.metadata.mediaType,
      byteSize: resolved.metadata.byteSize,
      checksum: resolved.metadata.checksum,
    });
  }

  async readContent(input: ContentReadRequest): Promise<ContentReadResult> {
    return this.#own(this.#readContent(input).then((page) => {
      assertResultReadOutputBudget({ status: 'ok', summary: 'Runtime content page read.', ...page });
      return page;
    }));
  }

  async #readContent(input: ContentReadRequest): Promise<ContentReadResult> {
    assertReadMode(input.mode);
    assertContentLimit(input.limit);
    if (input.mode === 'line' && input.limit > RESULT_READ_STRUCTURE_BUDGET.maxLineItems) {
      throw new ContentReferenceError('limit', 'The requested line count exceeds the result_read page budget.');
    }
    const resolved = await this.#resolveAuthorizedContent(input);
    const { contentRef, metadata } = resolved;
    const cursorAuthority = {
      key: requireOwnedCursorKey(metadata), owner: metadata.owner, generation: metadata.checksum,
    };
    const offset = resolveContentOffset(input, cursorAuthority);
    const now = new Date(this.#now());
    const lifecycle = await this.#artifactLifecycle(metadata.artifactId, now, input);
    assertIoActive(input);
    if (lifecycle === 'deleted') {
      throw new ContentReferenceError('not_found', 'The referenced content has been deleted.');
    }
    if (lifecycle === 'expired') {
      throw new ContentReferenceError('expired', 'The referenced content has expired.');
    }
    if (offset > metadata.byteSize) {
      throw new ContentReferenceError('invalid_cursor', 'The cursor is beyond the end of the content.');
    }
    switch (input.mode) {
      case 'byte': {
        const stream = await this.#openResolvedContent(resolved, input, offset);
        const bytes = await readByteWindow(stream, 0, input.limit, input);
        const nextOffset = offset + bytes.byteLength;
        const eof = nextOffset >= metadata.byteSize;
        return Object.freeze({
          contentRef,
          mode: input.mode,
          contentType: metadata.mediaType,
          totalBytes: metadata.byteSize,
          offset,
          preview: bytesPreview(bytes),
          data: Buffer.from(bytes).toString('base64'),
          encoding: 'base64',
          ...(eof ? {} : { nextCursor: mintContentCursor(contentRef, input.mode, nextOffset, cursorAuthority) }),
          eof,
        });
      }
      case 'text': {
        assertTextMediaType(metadata.mediaType);
        const stream = await this.#openResolvedContent(resolved, input, offset);
        const bytes = await readByteWindow(stream, 0, Math.min(input.limit + 4, 1_048_580), input);
        const decoded = decodeUtf8Window(bytes, input.limit, offset === metadata.byteSize);
        const nextOffset = offset + decoded.bytesConsumed;
        const eof = nextOffset >= metadata.byteSize;
        return Object.freeze({
          contentRef,
          mode: input.mode,
          contentType: metadata.mediaType,
          totalBytes: metadata.byteSize,
          offset,
          preview: previewText(decoded.text),
          data: decoded.text,
          encoding: 'utf-8',
          ...(eof ? {} : { nextCursor: mintContentCursor(contentRef, input.mode, nextOffset, cursorAuthority) }),
          eof,
        });
      }
      case 'line': {
        assertTextMediaType(metadata.mediaType);
        const stream = await this.#openResolvedContent(resolved, input, offset);
        const page = await readDelimitedPage(stream, offset, input.limit, 'line', input);
        return Object.freeze({
          contentRef,
          mode: input.mode,
          contentType: metadata.mediaType,
          totalBytes: metadata.byteSize,
          offset,
          preview: previewText(page.items.join('\n')),
          data: Object.freeze(page.items),
          encoding: 'utf-8',
          ...(page.eof
            ? {}
            : { nextCursor: mintContentCursor(contentRef, input.mode, page.nextOffset, cursorAuthority) }),
          eof: page.eof,
        });
      }
      case 'record': {
        if (input.limit > RESULT_READ_STRUCTURE_BUDGET.maxRecordItems) {
          throw new ContentReferenceError('limit', 'The requested record count exceeds the result_read page budget.');
        }
        assertStructuredMediaType(metadata.mediaType);
        const stream = await this.#openResolvedContent(resolved, input, offset);
        const page = isJsonDocumentMediaType(metadata.mediaType)
          ? await readJsonArrayPage(stream, offset, input.limit, input)
          : await readDelimitedPage(stream, offset, input.limit, 'record', input);
        return Object.freeze({
          contentRef,
          mode: input.mode,
          contentType: metadata.mediaType,
          totalBytes: metadata.byteSize,
          offset,
          preview: previewText(JSON.stringify(page.items)),
          data: Object.freeze(page.items),
          ...(page.eof ? {} : { nextCursor: mintContentCursor(contentRef, input.mode, page.nextOffset, cursorAuthority) }),
          eof: page.eof,
        });
      }
    }
  }

  async #resolveAuthorizedContent(
    input: Readonly<{
      contentRef: string;
      access: ContentAccessScope;
      signal?: AbortSignal;
      deadline?: string;
    }>,
  ): Promise<Readonly<{ contentRef: string; metadata: OwnedCommittedMetadata }>> {
    if (input.deadline !== undefined) requireExactIso(input.deadline, 'deadline');
    const parsed = parseContentReference(input.contentRef);
    const access = normalizeContentAccess(input.access);
    assertIoActive(input);
    const metadata = await this.#resolveContentMetadata(parsed.artifactId, input);
    assertIoActive(input);
    if (metadata === undefined || metadata.contentRef !== parsed.contentRef || metadata.owner === undefined) {
      throw new ContentReferenceError('not_found', 'The content reference does not exist.');
    }
    assertPersistedArtifact(metadata, this.#projectId);
    assertContentAccess(metadata.owner, access);
    const lifecycle = await this.#artifactLifecycle(metadata.artifactId, new Date(this.#now()), input);
    assertIoActive(input);
    if (lifecycle === 'deleted') {
      throw new ContentReferenceError('not_found', 'The referenced content has been deleted.');
    }
    if (lifecycle === 'expired') {
      throw new ContentReferenceError('expired', 'The referenced content has expired.');
    }
    return Object.freeze({ contentRef: parsed.contentRef, metadata: metadata as OwnedCommittedMetadata });
  }

  async #openResolvedContent(
    resolved: Readonly<{ contentRef: string; metadata: OwnedCommittedMetadata }>,
    input: Readonly<{ signal?: AbortSignal; deadline?: string }>,
    startOffset: number,
  ): Promise<ReadableStream<Uint8Array>> {
    return await this.open(publicCommitted(resolved.metadata), ioContext(input, startOffset));
  }

  async pinContent(input: Readonly<{
    contentRef: string;
    access: ContentAccessScope;
    pinnedUntil: string;
  }>): Promise<void> {
    const parsed = parseContentReference(input.contentRef);
    const pinnedUntil = requireExactIso(input.pinnedUntil, 'pinnedUntil');
    if (Date.parse(pinnedUntil) <= Date.parse(this.#now())) {
      throw new ContentReferenceError('expired', 'A content pin must end in the future.');
    }
    const gates = await this.#acquireLifecycleGates();
    try {
      const metadata = await this.#readCommittedMetadata(parsed.artifactId);
      if (metadata === undefined || metadata.contentRef !== input.contentRef || metadata.owner === undefined) {
        throw new ContentReferenceError('not_found', 'The content reference does not exist.');
      }
      assertContentAccess(metadata.owner, input.access);
      if (await this.#artifactLifecycle(metadata.artifactId, new Date(this.#now())) !== 'available') {
        throw new ContentReferenceError('expired', 'Revoked or expired content cannot be pinned.');
      }
      const effectivePin = metadata.pinnedUntil !== undefined &&
        Date.parse(metadata.pinnedUntil) > Date.parse(pinnedUntil)
        ? metadata.pinnedUntil
        : pinnedUntil;
      await writeAtomicJson(
        this.#committedMetadataPath(metadata.artifactId),
        { ...metadata, pinnedUntil: effectivePin },
        this.#createId,
      );
    } finally {
      gates.close();
    }
  }

  async resolveEvidenceReference(
    evidenceRef: string,
    access: ContentAccessScope,
    expectedRevision?: string,
    context: Readonly<{ signal?: AbortSignal; deadline?: string; pinUntil?: string }> = {},
  ): Promise<EvidenceReferenceResolution> {
    return this.#own(this.#resolveEvidenceReference(evidenceRef, access, expectedRevision, context));
  }

  async #resolveEvidenceReference(
    evidenceRef: string,
    access: ContentAccessScope,
    expectedRevision: string | undefined,
    context: Readonly<{ signal?: AbortSignal; deadline?: string; pinUntil?: string }>,
  ): Promise<EvidenceReferenceResolution> {
    let artifactId: string;
    try {
      artifactId = parseRuntimeEvidenceReference(evidenceRef).artifactId;
    } catch {
      return Object.freeze({ status: 'not_found' });
    }
    let stream: ReadableStream<Uint8Array> | undefined;
    let gates: { close(): void } | undefined;
    let releaseGates = true;
    try {
      assertIoActive(context);
      const metadata = await this.#resolveContentMetadata(artifactId, context);
      assertIoActive(context);
      if (metadata === undefined || metadata.evidence?.evidenceRef !== evidenceRef) {
        return Object.freeze({ status: 'not_found' });
      }
      assertPersistedArtifact(metadata, this.#projectId);
      if (expectedRevision !== undefined && metadata.evidence.revision !== expectedRevision) {
        return Object.freeze({ status: 'revision_mismatch' });
      }
      if (metadata.evidence.expiresAt !== undefined &&
        Date.parse(metadata.evidence.expiresAt) <= Date.parse(this.#now())) {
        return Object.freeze({ status: 'expired' });
      }
      try {
        assertEvidenceReferenceAccess(metadata.evidence, access, undefined, new Date(this.#now()));
      } catch (error) {
        if (error instanceof ContentReferenceError && error.code === 'forbidden') {
          return Object.freeze({ status: 'forbidden' });
        }
        return Object.freeze({ status: 'corrupt' });
      }
      const lifecycle = await this.#artifactLifecycle(artifactId, new Date(this.#now()), context);
      if (lifecycle === 'deleted') return Object.freeze({ status: 'not_found' });
      if (lifecycle === 'expired') return Object.freeze({ status: 'expired' });
      stream = await this.open(publicCommitted(metadata), ioContext(context, 0));
      gates = await awaitIoOrAbort(this.#acquireLifecycleGates(), context, (lateGates) => {
        lateGates.close();
      });
      const lockedMetadata = await this.#readCommittedMetadata(artifactId, context);
      if (!sameEvidenceMetadata(metadata, lockedMetadata, evidenceRef)) {
        throw new ArtifactStoreError('NOT_FOUND', 'Evidence metadata changed before validation.');
      }
      const lockedLifecycle = await this.#artifactLifecycle(artifactId, new Date(this.#now()), context);
      if (lockedLifecycle === 'deleted') {
        throw new ArtifactStoreError('DELETED', 'Evidence was deleted before validation.');
      }
      if (lockedLifecycle === 'expired') {
        throw new ArtifactStoreError('EXPIRED', 'Evidence expired before validation.');
      }
      await drainVerifiedStream(stream, context);
      stream = undefined;
      const confirmedMetadata = await this.#readCommittedMetadata(artifactId, context);
      if (!sameEvidenceMetadata(lockedMetadata, confirmedMetadata, evidenceRef)) {
        return Object.freeze({ status: 'not_found' });
      }
      const confirmedLifecycle = await this.#artifactLifecycle(
        artifactId,
        new Date(this.#now()),
        context,
      );
      if (confirmedLifecycle === 'deleted') return Object.freeze({ status: 'not_found' });
      if (confirmedLifecycle === 'expired') {
        return Object.freeze({ status: 'expired' });
      }
      if (context.pinUntil !== undefined) {
        const pinUntil = requireExactIso(context.pinUntil, 'pinUntil');
        if (Date.parse(pinUntil) <= Date.parse(this.#now())) {
          throw new ContentReferenceError('expired', 'The evidence pin must end in the future.');
        }
        const effectivePin = confirmedMetadata.pinnedUntil !== undefined &&
          Date.parse(confirmedMetadata.pinnedUntil) > Date.parse(pinUntil)
          ? confirmedMetadata.pinnedUntil
          : pinUntil;
        await writeAtomicJson(
          this.#committedMetadataPath(artifactId),
          { ...confirmedMetadata, pinnedUntil: effectivePin },
          this.#createId,
          context,
        );
      }
      const confirmedEvidence = confirmedMetadata.evidence;
      if (confirmedEvidence === undefined) {
        throw new ArtifactStoreError('CORRUPT', 'Evidence metadata lost its evidence record.');
      }
      return Object.freeze({ status: 'valid', record: confirmedEvidence });
    } catch (error) {
      if (stream !== undefined) {
        if (error instanceof ArtifactIoInterruption) {
          const capturedStream = stream;
          const cleanup = afterCleanup(error.cleanup, async () => { await capturedStream.cancel(); });
          if (gates !== undefined) {
            releaseGates = false;
            void cleanup.then(() => gates?.close(), () => undefined);
          }
          throw new ArtifactIoInterruption(error, cleanup);
        }
        const streamCleanup = Promise.resolve(stream.cancel()).then(() => undefined);
        try {
          await awaitIoOrAbort(streamCleanup, context);
        } catch (cleanupError) {
          if (cleanupError instanceof ArtifactIoInterruption && gates !== undefined) {
            releaseGates = false;
            void cleanupError.cleanup.then(() => gates?.close(), () => undefined);
          }
          throw cleanupError;
        }
      }
      if (error instanceof ArtifactIoInterruption && gates !== undefined) {
        releaseGates = false;
        void error.cleanup.then(() => gates?.close(), () => undefined);
      }
      if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) throw error;
      if (error instanceof ArtifactStoreError) {
        if (error.code === 'NOT_FOUND' || error.code === 'DELETED') {
          return Object.freeze({ status: 'not_found' });
        }
        if (error.code === 'EXPIRED') return Object.freeze({ status: 'expired' });
      }
      return Object.freeze({ status: 'corrupt' });
    } finally {
      if (releaseGates) gates?.close();
    }
  }

  async #verifyCommitCandidate(
    stagedArtifact: StagedArtifact,
    context: ArtifactIoContext = {},
  ): Promise<StagedMetadata | CommittedMetadata> {
    const staged = await this.#readStagedMetadata(stagedArtifact.artifactId, context);
    const committedMetadata = await this.#readCommittedMetadata(stagedArtifact.artifactId, context);
    const candidate = staged ?? committedMetadata;
    if (candidate === undefined) {
      throw new ArtifactStoreError('NOT_FOUND', 'Staged artifact metadata was not found.');
    }
    assertPersistedArtifact(candidate, this.#projectId);
    assertArtifactInput(candidate, stagedArtifact);
    if (staged !== undefined) {
      await verifyFile(
        containedPath(this.#stagedDir(), staged.blobName), staged.checksum, staged.byteSize, context,
      );
    } else {
      await verifyFile(this.#objectPath(candidate.checksum), candidate.checksum, candidate.byteSize, context);
    }
    if (this.#afterCommitBytesVerified !== undefined) await awaitIoOrAbort(this.#afterCommitBytesVerified(), context);
    return candidate;
  }

  async expire(ref: ArtifactRef, context: ArtifactJournalContext): Promise<void> {
    const gates = await this.#acquireLifecycleGates();
    try {
      await this.#commitLifecycle('artifact.expired', ref, context);
    } finally {
      gates.close();
    }
  }

  async delete(ref: ArtifactRef, context: ArtifactJournalContext): Promise<void> {
    const gates = await this.#acquireLifecycleGates();
    try {
      await this.#commitLifecycle('artifact.deleted', ref, context);
    } finally {
      gates.close();
    }
  }

  async collectGarbage(now: Date): Promise<ArtifactGcReport> {
    if (!Number.isFinite(now.getTime())) {
      throw new ArtifactStoreError('INVALID_ARGUMENT', 'GC time must be valid.');
    }
    const gate = await this.#acquireLifecycleGates();
    try {
      return await this.#collectGarbageWithGate(now);
    } finally {
      gate.close();
    }
  }

  async #collectGarbageWithGate(now: Date): Promise<ArtifactGcReport> {
    await this.#ensureDirectories();
    const factStates = await this.#artifactStates();
    let stagedObjectsDeleted = 0;
    let committedObjectsDeleted = 0;
    let bytesDeleted = 0;
    let orphanTemporaryFilesDeleted = 0;
    for (const entry of await readdir(this.#stagedDir(), { withFileTypes: true })) {
      if (!entry.isFile() || !/^\.stage-[A-Za-z0-9_-]+\.tmp$/u.test(entry.name)) continue;
      const path = containedPath(this.#stagedDir(), entry.name);
      const details = await stat(path);
      if (details.mtimeMs > now.getTime() - ORPHAN_STAGE_TEMP_MAX_AGE_MS) continue;
      await rm(path, { force: true });
      orphanTemporaryFilesDeleted += 1;
      bytesDeleted += details.size;
    }
    for (const entry of await readdir(this.#metadataDir(), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.staged.json')) continue;
      const artifactId = entry.name.slice(0, -'.staged.json'.length);
      requireArtifactId(artifactId);
      const metadata = await this.#readStagedMetadata(artifactId);
      if (metadata === undefined) continue;
      assertPersistedArtifact(metadata, this.#projectId);
      if (factStates.has(artifactId)) continue;
      const eligible = metadata.expiresAt === undefined
        ? now.getTime() - Date.parse(metadata.stagedAt) >= this.#stagedOrphanRetentionMs
        : Date.parse(metadata.expiresAt) <= now.getTime();
      if (!eligible) continue;
      await rm(containedPath(this.#stagedDir(), metadata.blobName), { force: true });
      await rm(this.#stagedMetadataPath(artifactId), { force: true });
      stagedObjectsDeleted += 1;
      bytesDeleted += metadata.byteSize;
    }
    const committedCandidates: Array<Readonly<{
      artifactId: string;
      metadata: CommittedMetadata;
      deleteMetadata: boolean;
    }>> = [];
    for (const entry of await readdir(this.#metadataDir(), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.committed.json')) continue;
      const artifactId = entry.name.slice(0, -'.committed.json'.length);
      requireArtifactId(artifactId);
      const state = factStates.get(artifactId);
      const metadata = await this.#readCommittedMetadata(artifactId);
      if (metadata === undefined) continue;
      assertPersistedArtifact(metadata, this.#projectId);
      let deleteMetadata = false;
      const lifecycle = state === undefined ? 'available' : factLifecycle(state, now);
      const pinned = state?.explicitLifecycle === undefined && metadata.pinnedUntil !== undefined &&
        Date.parse(metadata.pinnedUntil) > now.getTime();
      if (state !== undefined && !pinned) {
        if (lifecycle !== 'available') {
          deleteMetadata = true;
        } else if (metadata.owner !== undefined) {
        const run = await this.#journal.getRunProjection(metadata.owner.runId);
          const terminalAt = run === null ? Number.NaN : Date.parse(run.updatedAt);
          if (
            run !== null && run.projectId === this.#projectId &&
            run.sessionId === metadata.owner.sessionId &&
            (run.state === 'Completed' || run.state === 'Failed' || run.state === 'Cancelled') &&
            Number.isFinite(terminalAt) && now.getTime() - terminalAt >= this.#contentRetentionGraceMs
          ) {
            deleteMetadata = true;
          }
        }
      }
      committedCandidates.push(Object.freeze({ artifactId, metadata, deleteMetadata }));
    }
    const retainedChecksums = new Set(
      committedCandidates.filter((candidate) => !candidate.deleteMetadata)
        .map((candidate) => candidate.metadata.checksum),
    );
    const deletedChecksums = new Set<string>();
    for (const candidate of committedCandidates) {
      if (!candidate.deleteMetadata) continue;
      await rm(this.#committedMetadataPath(candidate.artifactId), { force: true });
      committedObjectsDeleted += 1;
      if (!retainedChecksums.has(candidate.metadata.checksum) &&
        !deletedChecksums.has(candidate.metadata.checksum) &&
        await removeFileIfExists(this.#objectPath(candidate.metadata.checksum))) {
        deletedChecksums.add(candidate.metadata.checksum);
        this.#verifiedObjectGenerations.delete(candidate.metadata.checksum);
        bytesDeleted += candidate.metadata.byteSize;
      }
    }
    return {
      stagedObjectsDeleted,
      committedObjectsDeleted,
      orphanTemporaryFilesDeleted,
      bytesDeleted,
    };
  }

  async #acquireMutationGate() {
    try {
      return await acquireArtifactMutationGate(this.#rootDir, this.#mutationGateTimeoutMs);
    } catch (error) {
      if (error instanceof ArtifactMutationGateTimeoutError) {
        throw new ArtifactStoreError('STORE_BUSY', error.message);
      }
      if (error instanceof ArtifactStoreError) throw error;
      throw new ArtifactStoreError(
        'STORE_BUSY',
        `Artifact mutation gate failed${errorCode(error) === undefined ? '' : ` (${errorCode(error)})`}.`,
      );
    }
  }

  async #acquireLifecycleGates() {
    let stateGate: ReturnType<typeof acquireSharedStateWriterGate> | undefined;
    try {
      stateGate = acquireSharedStateWriterGate(legacyProjectDirForArtifactRoot(this.#rootDir));
      const artifactGate = await this.#acquireMutationGate();
      let closed = false;
      return {
        close() {
          if (closed) return;
          closed = true;
          try {
            artifactGate.close();
          } finally {
            stateGate!.close();
          }
        },
      };
    } catch (error) {
      stateGate?.close();
      if (error instanceof StateWriterGateError) {
        throw new ArtifactStoreError('STATE_MIGRATION_ACTIVE', error.message);
      }
      if (error instanceof ArtifactStoreError) throw error;
      throw new ArtifactStoreError(
        'STORE_BUSY',
        `Artifact lifecycle gate failed${errorCode(error) === undefined ? '' : ` (${errorCode(error)})`}.`,
      );
    }
  }

  async #commitLifecycle(
    type: 'artifact.expired' | 'artifact.deleted',
    ref: ArtifactRef,
    context: ArtifactJournalContext,
  ): Promise<void> {
    assertReadableArtifact(ref, this.#projectId);
    this.#assertProject(ref.projectId);
    const created = await this.#findCreatedFact(ref.artifactId);
    if (created === undefined) throw new ArtifactStoreError('NOT_COMMITTED', 'Artifact is not committed.');
    assertMatchingFact(created, ref, context.runId);
    await this.#journal.commit({
      projectId: this.#projectId,
      sessionId: context.sessionId,
      runId: context.runId,
      commandId: context.commandId,
      lease: context.lease,
      expectedRunRevision: context.expectedRunRevision,
      events: [{ type, payload: { artifactId: ref.artifactId } }],
    });
  }

  async #promote(
    staged: StagedArtifact,
    createdAt: string,
    context: Readonly<{ signal?: AbortSignal; deadline?: string }> = {},
  ): Promise<ArtifactRef> {
    assertStagedArtifact(staged, this.#projectId);
    const objectPath = this.#objectPath(staged.checksum);
    let committedPublished = false;
    const stagedMetadataPath = this.#stagedMetadataPath(staged.artifactId);
    try {
      await awaitIoOrAbort(mkdir(dirname(objectPath), { recursive: true }), context);
      const stagedMetadata = await this.#readStagedMetadata(staged.artifactId, context);
      const cursorMetadata = stagedMetadata ?? await this.#readCommittedMetadata(staged.artifactId, context);
      if (cursorMetadata === undefined) throw new ArtifactStoreError('CORRUPT', 'Artifact cursor metadata is missing.');
      assertPersistedArtifact(cursorMetadata, this.#projectId);
      const cursorKey = cursorMetadata.cursorKey;
      if (stagedMetadata !== undefined) {
        assertPersistedArtifact(stagedMetadata, this.#projectId);
        const stagedPath = containedPath(this.#stagedDir(), stagedMetadata.blobName);
        let stagedBytesExist = true;
        try {
          await verifyFile(stagedPath, staged.checksum, staged.byteSize, context);
        } catch (error) {
          if (!(error instanceof ArtifactStoreError) || error.code !== 'NOT_FOUND') throw error;
          stagedBytesExist = false;
          await verifyFile(objectPath, staged.checksum, staged.byteSize, context);
        }
        if (stagedBytesExist) {
          try {
            await awaitIoOrAbort(rename(stagedPath, objectPath), context, async () => {
              await verifyFile(objectPath, staged.checksum, staged.byteSize);
            });
          } catch (error) {
            if (!isAlreadyExists(error) && !isNotFound(error)) throw error;
            await verifyFile(objectPath, staged.checksum, staged.byteSize, context);
            await awaitIoOrAbort(rm(stagedPath, { force: true }), context);
          }
          await fsyncDirectory(dirname(objectPath), context);
        }
      } else {
        await verifyFile(objectPath, staged.checksum, staged.byteSize, context);
      }
      await verifyFile(objectPath, staged.checksum, staged.byteSize, context);
      const ref: ArtifactRef = {
      schemaVersion: 1,
      artifactId: staged.artifactId,
      handle: staged.handle,
      projectId: staged.projectId,
      checksum: staged.checksum,
      byteSize: staged.byteSize,
      mediaType: staged.mediaType,
      availability: 'available',
      createdAt,
      ...(staged.expiresAt === undefined ? {} : { expiresAt: staged.expiresAt }),
      ...(staged.pinnedUntil === undefined ? {} : { pinnedUntil: staged.pinnedUntil }),
      ...(staged.contentRef === undefined ? {} : { contentRef: staged.contentRef }),
      ...(staged.owner === undefined ? {} : { owner: staged.owner }),
      ...(staged.evidence === undefined ? {} : { evidence: staged.evidence }),
      };
      const metadata: CommittedMetadata = {
        ...ref,
        storageVersion: 1,
        objectName: basename(objectPath),
        cursorKey,
      };
      await writeAtomicJson(
        this.#committedMetadataPath(staged.artifactId),
        metadata,
        this.#createId,
        context,
        () => { committedPublished = true; },
      );
      await awaitIoOrAbort(rm(stagedMetadataPath, { force: true }), context);
      await fsyncDirectory(this.#metadataDir(), context);
      return ref;
    } catch (error) {
      if (error instanceof ArtifactIoInterruption) {
        const cleanPublishedMetadata = async (): Promise<void> => {
          if (committedPublished) {
            await rm(stagedMetadataPath, { force: true });
            await fsyncDirectory(this.#metadataDir());
          }
        };
        const cleanup = afterCleanup(error.cleanup, cleanPublishedMetadata);
        throw new ArtifactIoInterruption(error, cleanup);
      }
      throw error;
    }
  }

  async #findCreatedFact(
    artifactId: string,
    context: Readonly<{ signal?: AbortSignal; deadline?: string }> = {},
  ): Promise<CreatedArtifactFact | undefined> {
    requireArtifactId(artifactId);
    await this.#refreshArtifactStateIndex(context);
    return this.#artifactStateIndex.get(artifactId)?.fact;
  }

  async #refreshArtifactStateIndex(
    context: Readonly<{ signal?: AbortSignal; deadline?: string }> = {},
  ): Promise<void> {
    while (true) {
      const page = await awaitIoOrAbort(
        this.#journal.readProject(this.#projectId, this.#artifactStateCursor, 1_000),
        context,
      );
      for (const event of page) {
        // A concurrent reader may already have advanced the shared index while
        // this page was in flight. Only apply a new, monotonic sequence prefix.
        if (event.sequence <= this.#artifactStateCursor) continue;
        if (event.projectId !== this.#projectId) {
          throw new ArtifactStoreError('JOURNAL_REFERENCE_CONFLICT', 'Artifact index owner mismatch.');
        }
        if (event.type === 'artifact.created') {
          const existing = this.#artifactStateIndex.get(event.payload.artifactId);
          if (existing !== undefined && (
            JSON.stringify(existing.fact.payload) !== JSON.stringify(event.payload) ||
            existing.fact.projectId !== event.projectId ||
            existing.fact.sessionId !== event.sessionId || existing.fact.runId !== event.runId
          )) {
            throw new ArtifactStoreError(
              'JOURNAL_REFERENCE_CONFLICT',
              'Multiple conflicting artifact facts were committed.',
            );
          }
          this.#artifactStateIndex.set(event.payload.artifactId, {
            fact: event,
            ...(existing?.explicitLifecycle === undefined
              ? {}
              : { explicitLifecycle: existing.explicitLifecycle }),
          });
        } else if (event.type === 'artifact.expired' || event.type === 'artifact.deleted') {
          const existing = this.#artifactStateIndex.get(event.payload.artifactId);
          if (existing !== undefined && existing.explicitLifecycle !== 'deleted') {
            existing.explicitLifecycle = event.type === 'artifact.expired' ? 'expired' : 'deleted';
          }
        }
        this.#artifactStateCursor = event.sequence;
      }
      if (page.length < 1_000) return;
    }
  }

  async #artifactLifecycle(
    artifactId: string,
    now: Date,
    context: Readonly<{ signal?: AbortSignal; deadline?: string }> = {},
  ): Promise<'available' | 'expired' | 'deleted'> {
    requireArtifactId(artifactId);
    const state = (await this.#artifactStates(context)).get(artifactId);
    if (state === undefined) return 'available';
    const lifecycle = factLifecycle(state, now);
    if (lifecycle !== 'expired' || state.explicitLifecycle !== undefined) return lifecycle;
    const metadata = await this.#readCommittedMetadata(artifactId, context);
    return metadata?.pinnedUntil !== undefined && Date.parse(metadata.pinnedUntil) > now.getTime()
      ? 'available'
      : 'expired';
  }

  async #artifactStates(
    context: Readonly<{ signal?: AbortSignal; deadline?: string }> = {},
  ): Promise<Map<string, ArtifactFactState>> {
    await this.#refreshArtifactStateIndex(context);
    return this.#artifactStateIndex;
  }

  async #ensureDirectories(
    context: Readonly<{ signal?: AbortSignal; deadline?: string }> = {},
  ): Promise<void> {
    await awaitIoOrAbort(settleAll([
      mkdir(this.#stagedDir(), { recursive: true }).then(() => undefined),
      mkdir(this.#metadataDir(), { recursive: true }).then(() => undefined),
      mkdir(this.#objectsDir(), { recursive: true }).then(() => undefined),
    ]), context);
  }

  #assertProject(projectId: string): void {
    if (projectId !== this.#projectId) {
      throw new ArtifactStoreError('PROJECT_MISMATCH', 'Artifact belongs to another Project.');
    }
  }

  async #readStagedMetadata(
    artifactId: string,
    context: Readonly<{ signal?: AbortSignal; deadline?: string }> = {},
  ): Promise<StagedMetadata | undefined> {
    const metadata = await readJsonIfExists<StagedMetadata>(this.#stagedMetadataPath(artifactId), context);
    if (metadata !== undefined) assertPersistedArtifact(metadata, this.#projectId);
    return metadata;
  }

  async #readCommittedMetadata(
    artifactId: string,
    context: Readonly<{ signal?: AbortSignal; deadline?: string }> = {},
  ): Promise<CommittedMetadata | undefined> {
    const metadata = await readJsonIfExists<CommittedMetadata>(this.#committedMetadataPath(artifactId), context);
    if (metadata !== undefined) assertPersistedArtifact(metadata, this.#projectId);
    return metadata;
  }

  async #resolveContentMetadata(
    artifactId: string,
    context: Readonly<{ signal?: AbortSignal; deadline?: string }> = {},
  ): Promise<CommittedMetadata | undefined> {
    let metadata = await this.#readCommittedMetadata(artifactId, context);
    if (metadata !== undefined) return metadata;
    const gates = await awaitIoOrAbort(this.#acquireLifecycleGates(), context, (lateGates) => {
      lateGates.close();
    });
    let releaseGates = true;
    try {
      metadata = await this.#readCommittedMetadata(artifactId, context);
      if (metadata !== undefined) return metadata;
      const staged = await this.#readStagedMetadata(artifactId, context);
      if (staged === undefined) return undefined;
      const fact = await this.#findCreatedFact(artifactId, context);
      if (fact === undefined) return undefined;
      await this.#promote(publicStaged(staged), fact.occurredAt, context);
      return await this.#readCommittedMetadata(artifactId, context);
    } catch (error) {
      if (error instanceof ArtifactIoInterruption) {
        releaseGates = false;
        void error.cleanup.then(() => gates.close(), () => undefined);
      }
      throw error;
    } finally {
      if (releaseGates) gates.close();
    }
  }

  async #assertContentQuota(
    owner: ReturnType<typeof normalizeContentOwner> | undefined,
    bytes: number,
    context: Readonly<{ signal?: AbortSignal; deadline?: string }> = {},
  ): Promise<void> {
    assertIoActive(context);
    await this.#ensureDirectories(context);
    let projectBytes = 0;
    let sessionBytes = 0;
    let runBytes = 0;
    for (const entry of await awaitIoOrAbort(
      readdir(this.#metadataDir(), { withFileTypes: true }), context,
    )) {
      assertIoActive(context);
      if (!entry.isFile() || (!entry.name.endsWith('.committed.json') && !entry.name.endsWith('.staged.json'))) continue;
      const artifactId = entry.name.replace(/\.(?:committed|staged)\.json$/u, '');
      if (!/^artifact_[a-f0-9]{64}$/u.test(artifactId)) continue;
      const metadata = entry.name.endsWith('.committed.json')
        ? await this.#readCommittedMetadata(artifactId, context)
        : await this.#readStagedMetadata(artifactId, context);
      if (metadata === undefined) continue;
      projectBytes += metadata.byteSize;
      if (owner !== undefined && metadata.owner?.sessionId === owner.sessionId) {
        sessionBytes += metadata.byteSize;
        if (metadata.owner.runId === owner.runId) runBytes += metadata.byteSize;
      }
    }
    assertIoActive(context);
    if (
      projectBytes + bytes > this.#maxProjectBytes ||
      (owner !== undefined && (sessionBytes + bytes > this.#maxSessionBytes || runBytes + bytes > this.#maxRunBytes))
    ) {
      throw new ArtifactStoreError('LIMIT_EXCEEDED', 'Artifact storage quota would be exceeded.');
    }
  }

  #stagedDir(): string { return containedPath(this.#rootDir, 'staged'); }
  #metadataDir(): string { return containedPath(this.#rootDir, 'metadata'); }
  #objectsDir(): string { return containedPath(this.#rootDir, 'objects'); }
  #stagedMetadataPath(artifactId: string): string {
    requireArtifactId(artifactId);
    return containedPath(this.#metadataDir(), `${artifactId}.staged.json`);
  }
  #committedMetadataPath(artifactId: string): string {
    requireArtifactId(artifactId);
    return containedPath(this.#metadataDir(), `${artifactId}.committed.json`);
  }
  #objectPath(checksum: string): string {
    requireChecksum(checksum);
    return containedPath(this.#objectsDir(), checksum.slice(0, 2), checksum.slice(2));
  }
}

function factLifecycle(
  state: ArtifactFactState,
  now: Date,
): 'available' | 'expired' | 'deleted' {
  if (state.explicitLifecycle !== undefined) return state.explicitLifecycle;
  return state.fact.payload.expiresAt !== undefined &&
    Date.parse(state.fact.payload.expiresAt) <= now.getTime()
    ? 'expired'
    : 'available';
}

function sameEvidenceMetadata(
  expected: CommittedMetadata,
  candidate: CommittedMetadata | undefined,
  evidenceRef: string,
): candidate is CommittedMetadata {
  return candidate !== undefined && candidate.artifactId === expected.artifactId &&
    candidate.contentRef === expected.contentRef && candidate.checksum === expected.checksum &&
    candidate.byteSize === expected.byteSize && candidate.mediaType === expected.mediaType &&
    candidate.owner !== undefined && expected.owner !== undefined &&
    JSON.stringify(candidate.owner) === JSON.stringify(expected.owner) &&
    candidate.evidence !== undefined && expected.evidence !== undefined &&
    candidate.evidence.evidenceRef === evidenceRef &&
    JSON.stringify(candidate.evidence) === JSON.stringify(expected.evidence);
}

function requireText(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ArtifactStoreError('INVALID_ARGUMENT', `${name} is required.`);
  }
  return value.trim();
}

function validateStageInput(input: StageArtifactInput): void {
  requireMediaType(input.mediaType);
  if (input.expectedByteSize !== undefined &&
    (!Number.isSafeInteger(input.expectedByteSize) || input.expectedByteSize < 0)) {
    throw new ArtifactStoreError('INVALID_ARGUMENT', 'expectedByteSize must be non-negative.');
  }
  if (input.expectedChecksum !== undefined) requireChecksum(input.expectedChecksum);
  if (input.expiresAt !== undefined) requireExactIso(input.expiresAt, 'expiresAt');
  if (input.pinnedUntil !== undefined) requireExactIso(input.pinnedUntil, 'pinnedUntil');
  if (input.deadline !== undefined) requireExactIso(input.deadline, 'deadline');
  if (input.owner !== undefined) normalizeContentOwner(input.owner);
}

function requireMediaType(value: string): string {
  const mediaType = requireText(value, 'mediaType');
  if (
    mediaType.length > 255 ||
    !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:\s*;\s*[^\0\r\n]+)?$/u.test(mediaType)
  ) {
    throw new ArtifactStoreError('INVALID_ARGUMENT', 'mediaType is invalid.');
  }
  return mediaType;
}

function requireOpaqueId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
    throw new ArtifactStoreError('INVALID_ARGUMENT', 'Generated artifact ID is not opaque-safe.');
  }
  return value;
}

function requireArtifactId(value: string): string {
  if (typeof value !== 'string' || !/^artifact_[a-f0-9]{64}$/u.test(value)) {
    throw new ArtifactStoreError('INVALID_ARGUMENT', 'artifactId has an invalid opaque format.');
  }
  return value;
}

function requireChecksum(value: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new ArtifactStoreError('INVALID_ARGUMENT', 'checksum must be lowercase SHA-256.');
  }
  return value;
}

function requireExactIso(value: string, name: string): string {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new ArtifactStoreError('INVALID_ARGUMENT', `${name} must be an exact ISO timestamp.`);
  }
  return value;
}

function quota(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new ArtifactStoreError('INVALID_ARGUMENT', `${label} must be a positive safe integer.`);
  }
  return resolved;
}

function assertStagedArtifact(ref: StagedArtifact, projectId: string): void {
  assertArtifactCore(ref, projectId, 'staged');
  requireExactIso(ref.stagedAt, 'stagedAt');
}

function assertReadableArtifact(ref: ReadableArtifactRef, projectId: string): void {
  void projectId;
  if (ref.availability === 'legacy-unavailable') {
    requireArtifactId(ref.artifactId);
    if (!/^legacy-agent-artifact:[a-f0-9]{64}$/u.test(ref.handle)) {
      throw new ArtifactStoreError('INVALID_ARGUMENT', 'Legacy artifact handle is invalid.');
    }
    requireMediaType(ref.mediaType);
    return;
  }
  assertArtifactCore(ref, projectId, 'available');
  requireExactIso(ref.createdAt, 'createdAt');
}

function assertArtifactCore(
  ref: {
    schemaVersion: 1;
    artifactId: string;
    handle: string;
    projectId: string;
    checksum: string;
    byteSize: number;
    mediaType: string;
    availability: 'staged' | 'available';
    expiresAt?: string;
    pinnedUntil?: string;
    contentRef?: string;
    owner?: ContentOwnerScope;
    evidence?: RuntimeEvidenceReferenceRecord;
  },
  projectId: string,
  availability: 'staged' | 'available',
): void {
  void projectId;
  if (ref.schemaVersion !== 1 || ref.availability !== availability) {
    throw new ArtifactStoreError('INVALID_ARGUMENT', 'Artifact reference schema or availability is invalid.');
  }
  requireArtifactId(ref.artifactId);
  requireChecksum(ref.checksum);
  requireText(ref.projectId, 'projectId');
  const expectedHandle = `agent-artifact:${sha256(ref.projectId).slice(0, 24)}:${ref.artifactId.slice(-40)}`;
  if (ref.handle !== expectedHandle) {
    throw new ArtifactStoreError('INVALID_ARGUMENT', 'Artifact handle does not match its Project and ID.');
  }
  if (!Number.isSafeInteger(ref.byteSize) || ref.byteSize < 0) {
    throw new ArtifactStoreError('INVALID_ARGUMENT', 'Artifact byteSize is invalid.');
  }
  requireMediaType(ref.mediaType);
  if (ref.expiresAt !== undefined) requireExactIso(ref.expiresAt, 'expiresAt');
  if (ref.pinnedUntil !== undefined) requireExactIso(ref.pinnedUntil, 'pinnedUntil');
  if (ref.owner !== undefined) {
    const owner = normalizeContentOwner(ref.owner);
    if (owner.projectId !== undefined && owner.projectId !== ref.projectId) {
      throw new ArtifactStoreError('INVALID_ARGUMENT', 'Artifact owner Project is invalid.');
    }
    if (ref.contentRef === undefined || parseContentReference(ref.contentRef).artifactId !== ref.artifactId) {
      throw new ArtifactStoreError('INVALID_ARGUMENT', 'Artifact content reference is invalid.');
    }
    if (
      ref.evidence === undefined || ref.evidence.artifactId !== ref.artifactId ||
      ref.evidence.contentRef !== ref.contentRef ||
      parseRuntimeEvidenceReference(ref.evidence.evidenceRef).artifactId !== ref.artifactId
    ) {
      throw new ArtifactStoreError('INVALID_ARGUMENT', 'Artifact evidence reference is invalid.');
    }
  } else if (ref.contentRef !== undefined || ref.evidence !== undefined || ref.pinnedUntil !== undefined) {
    throw new ArtifactStoreError('INVALID_ARGUMENT', 'Unowned artifacts cannot publish content metadata.');
  }
}

function assertPersistedArtifact(
  metadata: StagedMetadata | CommittedMetadata,
  projectId: string,
): void {
  if (metadata === null || typeof metadata !== 'object' || metadata.storageVersion !== 1) {
    throw new ArtifactStoreError('CORRUPT', 'Artifact metadata storage version is invalid.');
  }
  if (metadata.owner !== undefined) requireOwnedCursorKey(metadata);
  else if (metadata.cursorKey !== null && metadata.cursorKey !== undefined) {
    throw new ArtifactStoreError('CORRUPT', 'Unowned Artifact metadata contains cursor authority.');
  }
  try {
    if (metadata.availability === 'staged') assertStagedArtifact(metadata, projectId);
    else assertReadableArtifact(metadata, projectId);
  } catch (error) {
    if (error instanceof ArtifactStoreError) {
      throw new ArtifactStoreError('CORRUPT', `Artifact metadata is invalid: ${error.message}`);
    }
    throw new ArtifactStoreError(
      'CORRUPT',
      `Artifact metadata is invalid${error instanceof Error ? `: ${error.message}` : '.'}`,
    );
  }
  if ('blobName' in metadata && metadata.blobName !== `${metadata.artifactId}.blob`) {
    throw new ArtifactStoreError('CORRUPT', 'Staged artifact blob path is invalid.');
  }
  if ('objectName' in metadata && metadata.objectName !== metadata.checksum.slice(2)) {
    throw new ArtifactStoreError('CORRUPT', 'Committed artifact object path is invalid.');
  }
}

function requireOwnedCursorKey(metadata: StagedMetadata | CommittedMetadata): string {
  if (typeof metadata.cursorKey !== 'string' || !/^[a-f0-9]{64}$/u.test(metadata.cursorKey)) {
    throw new ArtifactStoreError('CORRUPT', 'Owned Artifact metadata has missing or invalid cursor authority.');
  }
  return metadata.cursorKey;
}

function containedPath(root: string, ...parts: string[]): string {
  const absoluteRoot = resolve(root);
  const candidate = resolve(absoluteRoot, ...parts);
  const child = relative(absoluteRoot, candidate);
  if (child === '..' || child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(child)) {
    throw new ArtifactStoreError('INVALID_ARGUMENT', 'Artifact path escapes its project root.');
  }
  return candidate;
}

function publicStaged(metadata: StagedMetadata): StagedArtifact {
  return {
    schemaVersion: metadata.schemaVersion,
    artifactId: metadata.artifactId,
    handle: metadata.handle,
    projectId: metadata.projectId,
    checksum: metadata.checksum,
    byteSize: metadata.byteSize,
    mediaType: metadata.mediaType,
    availability: metadata.availability,
    stagedAt: metadata.stagedAt,
    ...(metadata.expiresAt === undefined ? {} : { expiresAt: metadata.expiresAt }),
    ...(metadata.pinnedUntil === undefined ? {} : { pinnedUntil: metadata.pinnedUntil }),
    ...(metadata.contentRef === undefined ? {} : { contentRef: metadata.contentRef }),
    ...(metadata.owner === undefined ? {} : { owner: metadata.owner }),
    ...(metadata.evidence === undefined ? {} : { evidence: metadata.evidence }),
  };
}

function publicCommitted(metadata: CommittedMetadata): ArtifactRef {
  return {
    schemaVersion: metadata.schemaVersion,
    artifactId: metadata.artifactId,
    handle: metadata.handle,
    projectId: metadata.projectId,
    checksum: metadata.checksum,
    byteSize: metadata.byteSize,
    mediaType: metadata.mediaType,
    availability: 'available',
    createdAt: metadata.createdAt,
    ...(metadata.expiresAt === undefined ? {} : { expiresAt: metadata.expiresAt }),
    ...(metadata.pinnedUntil === undefined ? {} : { pinnedUntil: metadata.pinnedUntil }),
    ...(metadata.contentRef === undefined ? {} : { contentRef: metadata.contentRef }),
    ...(metadata.owner === undefined ? {} : { owner: metadata.owner }),
    ...(metadata.evidence === undefined ? {} : { evidence: metadata.evidence }),
  };
}

function assertArtifactInput(
  actual: Pick<StagedArtifact, 'artifactId' | 'handle' | 'projectId' | 'checksum' | 'byteSize' | 'mediaType' | 'contentRef' | 'owner' | 'evidence' | 'pinnedUntil'>,
  expected: Pick<StagedArtifact, 'artifactId' | 'handle' | 'projectId' | 'checksum' | 'byteSize' | 'mediaType' | 'contentRef' | 'owner' | 'evidence' | 'pinnedUntil'>,
): void {
  if (
    actual.artifactId !== expected.artifactId ||
    actual.handle !== expected.handle ||
    actual.projectId !== expected.projectId ||
    actual.checksum !== expected.checksum ||
    actual.byteSize !== expected.byteSize ||
    actual.mediaType !== expected.mediaType ||
    actual.contentRef !== expected.contentRef ||
    JSON.stringify(actual.owner) !== JSON.stringify(expected.owner) ||
    JSON.stringify(actual.evidence) !== JSON.stringify(expected.evidence) ||
    actual.pinnedUntil !== expected.pinnedUntil
  ) {
    throw new ArtifactStoreError('METADATA_CONFLICT', 'Artifact metadata conflicts.');
  }
}

function assertMatchingFact(
  fact: CreatedArtifactFact,
  ref: Pick<StagedArtifact, 'artifactId' | 'handle' | 'checksum' | 'byteSize' | 'mediaType' | 'expiresAt'>,
  runId: string,
  summary?: string,
): void {
  const payload = fact.payload;
  if (
    fact.runId !== runId ||
    payload.availability !== 'available' ||
    payload.artifactId !== ref.artifactId ||
    payload.handle !== ref.handle ||
    payload.checksum !== ref.checksum ||
    payload.byteSize !== ref.byteSize ||
    payload.mediaType !== ref.mediaType ||
    payload.expiresAt !== ref.expiresAt ||
    (summary !== undefined && payload.summary !== summary)
  ) {
    throw new ArtifactStoreError(
      'JOURNAL_REFERENCE_CONFLICT',
      'Committed Journal artifact metadata does not match staged bytes.',
    );
  }
}

async function readByteWindow(
  stream: ReadableStream<Uint8Array>,
  start: number,
  limit: number,
  context: Readonly<{ signal?: AbortSignal; deadline?: string }> = {},
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let streamOffset = 0;
  let collected = 0;
  let inheritedCleanup = Promise.resolve();
  try {
    while (collected < limit) {
      assertIoActive(context);
      const next = await awaitIoOrAbort(reader.read(), context);
      assertIoActive(context);
      if (next.done) break;
      const chunkStart = streamOffset;
      const chunkEnd = chunkStart + next.value.byteLength;
      streamOffset = chunkEnd;
      if (chunkEnd <= start) continue;
      const from = Math.max(0, start - chunkStart);
      const take = Math.min(next.value.byteLength - from, limit - collected);
      if (take > 0) {
        chunks.push(next.value.slice(from, from + take));
        collected += take;
      }
    }
  } catch (error) {
    if (error instanceof ArtifactIoInterruption) inheritedCleanup = error.cleanup;
    throw error;
  } finally {
    await settleReader(reader, context, inheritedCleanup);
  }
  const result = new Uint8Array(collected);
  let position = 0;
  for (const chunk of chunks) {
    result.set(chunk, position);
    position += chunk.byteLength;
  }
  return result;
}

async function drainVerifiedStream(
  stream: ReadableStream<Uint8Array>,
  context: Readonly<{ signal?: AbortSignal; deadline?: string }> = {},
): Promise<void> {
  const reader = stream.getReader();
  let inheritedCleanup = Promise.resolve();
  try {
    while (true) {
      assertIoActive(context);
      const next = await awaitIoOrAbort(reader.read(), context);
      assertIoActive(context);
      if (next.done) return;
    }
  } catch (error) {
    if (error instanceof ArtifactIoInterruption) inheritedCleanup = error.cleanup;
    throw error;
  } finally {
    await settleReader(reader, context, inheritedCleanup);
  }
}

function decodeUtf8Window(
  bytes: Uint8Array,
  requestedBytes: number,
  atEnd: boolean,
): Readonly<{ text: string; bytesConsumed: number }> {
  if (bytes.byteLength === 0) return Object.freeze({ text: '', bytesConsumed: 0 });
  if ((bytes[0]! & 0xc0) === 0x80) {
    throw new ContentReferenceError('invalid_cursor', 'The text cursor is not on a UTF-8 boundary.');
  }
  const maximum = Math.min(bytes.byteLength, requestedBytes + 3);
  for (let length = Math.min(bytes.byteLength, requestedBytes); length <= maximum; length += 1) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
      if (length > 0 || atEnd) return Object.freeze({ text, bytesConsumed: length });
    } catch {
      // Extend through at most one complete UTF-8 scalar value.
    }
  }
  throw new ContentReferenceError('invalid_cursor', 'The requested text range cuts through invalid UTF-8 data.');
}

async function readDelimitedPage(
  stream: ReadableStream<Uint8Array>,
  startOffset: number,
  limit: number,
  mode: 'line' | 'record',
  context: Readonly<{ signal?: AbortSignal; deadline?: string }> = {},
): Promise<Readonly<{ items: unknown[]; nextOffset: number; eof: boolean }>> {
  const MAX_ITEM_BYTES = 64 * 1024;
  const MAX_PAGE_BYTES = 128 * 1024;
  const structureBudget = createContentPageBudget();
  const reader = stream.getReader();
  const items: unknown[] = [];
  let pending: number[] = [];
  let pageBytes = 0;
  let absoluteOffset = startOffset;
  let nextOffset = startOffset;
  let eof = false;
  let inheritedCleanup = Promise.resolve();
  const append = (bytes: Uint8Array): void => {
    let line = bytes;
    if (line.at(-1) === 13) line = line.subarray(0, -1);
    pageBytes += line.byteLength;
    if (pageBytes > MAX_PAGE_BYTES) {
      throw new ContentReferenceError('limit', 'The requested page exceeds the 131072-byte output limit.');
    }
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(line); }
    catch { throw new ContentReferenceError('type_mismatch', 'The content is not valid UTF-8 text.'); }
    if (mode === 'record') {
      if (text.trim() === '') throw new ContentReferenceError('type_mismatch', 'A structured record is empty.');
      let record: unknown;
      try { record = JSON.parse(text); }
      catch { throw new ContentReferenceError('type_mismatch', 'A structured record is not valid JSON.'); }
      structureBudget.admit(record);
      items.push(record);
    } else {
      structureBudget.admit(text);
      items.push(text);
    }
    nextOffset = absoluteOffset;
  };
  try {
    while (items.length < limit) {
      assertIoActive(context);
      const next = await awaitIoOrAbort(reader.read(), context);
      assertIoActive(context);
      if (next.done) {
        eof = true;
        if (pending.length > 0) {
          append(Uint8Array.from(pending));
          pending = [];
        }
        break;
      }
      for (const byte of next.value) {
        absoluteOffset += 1;
        if (byte === 10) {
          append(Uint8Array.from(pending));
          pending = [];
          if (items.length >= limit) break;
        } else {
          pending.push(byte);
          if (pending.length > MAX_ITEM_BYTES) {
            throw new ContentReferenceError('limit', `A single ${mode} exceeds the 65536-byte limit.`);
          }
        }
      }
    }
  } catch (error) {
    if (error instanceof ArtifactIoInterruption) inheritedCleanup = error.cleanup;
    throw error;
  } finally {
    await settleReader(reader, context, inheritedCleanup);
  }
  return Object.freeze({ items, nextOffset, eof });
}

async function readJsonArrayPage(
  stream: ReadableStream<Uint8Array>,
  startOffset: number,
  limit: number,
  context: Readonly<{ signal?: AbortSignal; deadline?: string }> = {},
): Promise<Readonly<{ items: unknown[]; nextOffset: number; eof: boolean }>> {
  const MAX_ITEM_BYTES = 64 * 1024;
  const MAX_PAGE_BYTES = 128 * 1024;
  const structureBudget = createContentPageBudget();
  const MAX_TRAILING_WHITESPACE_BYTES = 64 * 1024;
  const reader = stream.getReader();
  const items: unknown[] = [];
  let pending: number[] = [];
  let pageBytes = 0;
  let absoluteOffset = startOffset;
  let nextOffset = startOffset;
  let initialized = startOffset > 0;
  let recordRequired = startOffset > 0;
  let recordStarted = false;
  let inString = false;
  let escaped = false;
  let depth = 0;
  let eof = false;
  let closed = false;
  let trailingWhitespaceBytes = 0;
  let inheritedCleanup = Promise.resolve();
  const append = (): void => {
    let first = 0;
    let last = pending.length;
    while (first < last && isJsonWhitespace(pending[first]!)) first += 1;
    while (last > first && isJsonWhitespace(pending[last - 1]!)) last -= 1;
    if (first === last) {
      throw new ContentReferenceError('type_mismatch', 'A JSON array record is empty.');
    }
    const bytes = Uint8Array.from(pending.slice(first, last));
    pageBytes += bytes.byteLength;
    if (pageBytes > MAX_PAGE_BYTES) {
      throw new ContentReferenceError('limit', 'The requested page exceeds the 131072-byte output limit.');
    }
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new ContentReferenceError('type_mismatch', 'The JSON array is not valid UTF-8.'); }
    let record: unknown;
    try { record = JSON.parse(text); }
    catch { throw new ContentReferenceError('type_mismatch', 'A JSON array record is invalid.'); }
    structureBudget.admit(record);
    items.push(record);
    pending = [];
    recordStarted = false;
    inString = false;
    escaped = false;
    depth = 0;
  };
  try {
    outer: while ((items.length < limit || closed) && !eof) {
      assertIoActive(context);
      const next = await awaitIoOrAbort(reader.read(), context);
      if (next.done) {
        if (closed) {
          eof = true;
          break;
        }
        throw new ContentReferenceError('type_mismatch', 'The JSON array ended before its closing bracket.');
      }
      for (const byte of next.value) {
        absoluteOffset += 1;
        if (closed) {
          if (!isJsonWhitespace(byte)) {
            throw new ContentReferenceError(
              'type_mismatch',
              'The JSON array has non-whitespace content after its closing bracket.',
            );
          }
          trailingWhitespaceBytes += 1;
          if (trailingWhitespaceBytes > MAX_TRAILING_WHITESPACE_BYTES) {
            throw new ContentReferenceError(
              'limit',
              'The JSON array trailing whitespace exceeds the 65536-byte limit.',
            );
          }
          nextOffset = absoluteOffset;
          continue;
        }
        if (!initialized) {
          if (isJsonWhitespace(byte)) continue;
          if (byte !== 0x5b) {
            throw new ContentReferenceError('type_mismatch', 'Record mode requires a top-level JSON array.');
          }
          initialized = true;
          nextOffset = absoluteOffset;
          continue;
        }
        if (!recordStarted) {
          if (isJsonWhitespace(byte)) {
            nextOffset = absoluteOffset;
            continue;
          }
          if (byte === 0x5d) {
            if (recordRequired) {
              throw new ContentReferenceError('type_mismatch', 'A JSON array cannot end after a comma.');
            }
            closed = true;
            nextOffset = absoluteOffset;
            continue;
          }
          recordStarted = true;
        }
        if (!inString && depth === 0 && (byte === 0x2c || byte === 0x5d)) {
          append();
          nextOffset = absoluteOffset;
          if (byte === 0x5d) {
            closed = true;
            continue;
          }
          recordRequired = true;
          if (items.length >= limit) break outer;
          continue;
        }
        pending.push(byte);
        if (pending.length > MAX_ITEM_BYTES) {
          throw new ContentReferenceError('limit', 'A single JSON array record exceeds the 65536-byte limit.');
        }
        if (inString) {
          if (escaped) escaped = false;
          else if (byte === 0x5c) escaped = true;
          else if (byte === 0x22) inString = false;
          continue;
        }
        if (byte === 0x22) inString = true;
        else if (byte === 0x7b || byte === 0x5b) depth += 1;
        else if (byte === 0x7d || byte === 0x5d) depth -= 1;
        if (depth < 0 || depth > RESULT_READ_STRUCTURE_BUDGET.maxDepth - 2) {
          throw new ContentReferenceError('limit', 'A JSON array record exceeds the depth limit.');
        }
      }
    }
  } catch (error) {
    if (error instanceof ArtifactIoInterruption) inheritedCleanup = error.cleanup;
    throw error;
  } finally {
    await settleReader(reader, context, inheritedCleanup);
  }
  return Object.freeze({ items, nextOffset, eof });
}

function isJsonWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function assertTextMediaType(mediaType: string): void {
  if (
    !mediaType.startsWith('text/') && !/\/(?:json|xml|javascript)(?:;|$)/iu.test(mediaType)
  ) {
    throw new ContentReferenceError('type_mismatch', 'The referenced content is not text.');
  }
}

function assertStructuredMediaType(mediaType: string): void {
  if (!isJsonDocumentMediaType(mediaType) && !/\/(?:x-ndjson|jsonlines)(?:;|$)/iu.test(mediaType)) {
    throw new ContentReferenceError('type_mismatch', 'Record mode requires a JSON array or newline-delimited JSON.');
  }
}

function isJsonDocumentMediaType(mediaType: string): boolean {
  return /\/json(?:;|$)/iu.test(mediaType);
}

function previewText(value: string): string {
  if (value.length <= 4_096) return value;
  return `${value.slice(0, 3_072)}\n… [preview truncated] …\n${value.slice(-1_000)}`;
}

function bytesPreview(value: Uint8Array): string {
  try {
    return previewText(new TextDecoder('utf-8', { fatal: true }).decode(value));
  } catch {
    return Buffer.from(value.subarray(0, 256)).toString('base64');
  }
}

function ioContext(
  input: Readonly<{ signal?: AbortSignal; deadline?: string }>,
  startOffset: number,
): ArtifactIoContext {
  return {
    startOffset,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.deadline === undefined ? {} : { deadline: input.deadline }),
  };
}

function assertIoActive(context: Readonly<{ signal?: AbortSignal; deadline?: string }>): void {
  if (context.signal?.aborted) {
    const error = new ArtifactStoreError('STAGE_FAILED', 'Artifact I/O was cancelled.');
    error.name = 'AbortError';
    throw error;
  }
  if (context.deadline !== undefined && Date.now() >= Date.parse(context.deadline)) {
    const error = new ArtifactStoreError('STAGE_FAILED', 'Artifact I/O timed out.');
    error.name = 'TimeoutError';
    throw error;
  }
}

async function* asAsyncIterable(
  source: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
  context: Readonly<{ signal?: AbortSignal; deadline?: string }> = {},
): AsyncIterable<Uint8Array> {
  if (Symbol.asyncIterator in source) {
    const iterator = source[Symbol.asyncIterator]();
    let inheritedCleanup = Promise.resolve();
    try {
      while (true) {
        const result = await awaitIoOrAbort(Promise.resolve(iterator.next()), context);
        if (result.done) return;
        yield result.value;
      }
    } catch (error) {
      if (error instanceof ArtifactIoInterruption) inheritedCleanup = error.cleanup;
      throw error;
    } finally {
      const returned = Promise.resolve().then(async () => { await iterator.return?.(); });
      await settleCleanup(returned, context, inheritedCleanup);
    }
  }
  const reader = source.getReader();
  let inheritedCleanup = Promise.resolve();
  try {
    while (true) {
      const result = await awaitIoOrAbort(reader.read(), context);
      if (result.done) return;
      yield result.value;
    }
  } catch (error) {
    if (error instanceof ArtifactIoInterruption) inheritedCleanup = error.cleanup;
    throw error;
  } finally {
    await settleReader(reader, context, inheritedCleanup);
  }
}

async function settleReader<T>(
  reader: ReadableStreamDefaultReader<T>,
  context: Readonly<{ signal?: AbortSignal; deadline?: string }>,
  inheritedCleanup: Promise<void> = Promise.resolve(),
): Promise<void> {
  const cancelled = Promise.resolve().then(async () => { await reader.cancel(); });
  const cleanup = settleAll([inheritedCleanup, cancelled]).finally(() => {
    reader.releaseLock();
  });
  await awaitIoOrAbort(cleanup, context);
}

async function settleCleanup(
  current: Promise<void>,
  context: Readonly<{ signal?: AbortSignal; deadline?: string }>,
  inheritedCleanup: Promise<void> = Promise.resolve(),
): Promise<void> {
  await awaitIoOrAbort(settleAll([inheritedCleanup, current]), context);
}

async function settleAll(promises: readonly Promise<void>[]): Promise<void> {
  const outcomes = await Promise.allSettled(promises.map(followPhysicalCleanup));
  const rejected = outcomes.filter(
    (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
  );
  if (rejected.length > 0) throw new AggregateError(rejected.map((item) => item.reason as unknown), 'Artifact cleanup failed.');
}

async function followPhysicalCleanup(work: Promise<void>): Promise<void> {
  try { await work; }
  catch (error) {
    if (error instanceof ArtifactIoInterruption) { await error.cleanup; return; }
    throw error;
  }
}

async function afterCleanup(
  inherited: Promise<void>,
  cleanup: () => Promise<void>,
): Promise<void> {
  try {
    await followPhysicalCleanup(inherited);
  } catch (error) {
    try { await followPhysicalCleanup(Promise.resolve().then(cleanup)); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Artifact cleanup failed.'); }
    throw error;
  }
  await followPhysicalCleanup(Promise.resolve().then(cleanup));
}

async function awaitIoOrAbort<T>(
  operation: Promise<T>,
  context: Readonly<{ signal?: AbortSignal; deadline?: string }>,
  onLateSuccess?: (value: T) => void | Promise<void>,
): Promise<T> {
  void operation.catch(() => undefined);
  const lateCleanup = (): Promise<void> => operation.then(
    async (value) => await onLateSuccess?.(value),
    (error: unknown) => {
      if (error instanceof ArtifactIoInterruption) return error.cleanup;
      throw error;
    },
  ).then(() => undefined);
  try {
    assertIoActive(context);
  } catch (error) {
    throw new ArtifactIoInterruption(
      error instanceof Error ? error : new Error('Artifact I/O was interrupted.'),
      lateCleanup(),
    );
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let detach = (): void => undefined;
  let wasInterrupted = false;
  const interrupted = new Promise<never>((_resolve, reject) => {
    const rejectInactive = (): void => {
      try {
        assertIoActive(context);
        if (context.deadline !== undefined) {
          const remaining = Date.parse(context.deadline) - Date.now();
          timer = setTimeout(rejectInactive, Math.max(1, remaining));
        }
      } catch (error) {
        wasInterrupted = true;
        reject(error instanceof Error ? error : new Error('Artifact I/O was interrupted.'));
      }
    };
    if (context.signal !== undefined) {
      context.signal.addEventListener('abort', rejectInactive, { once: true });
      detach = () => context.signal?.removeEventListener('abort', rejectInactive);
    }
    if (context.deadline !== undefined) {
      const remaining = Date.parse(context.deadline) - Date.now();
      if (remaining <= 2_147_483_647) timer = setTimeout(rejectInactive, Math.max(0, remaining));
    }
  });
  try {
    const result = await Promise.race([operation, interrupted]);
    try {
      assertIoActive(context);
    } catch (error) {
      throw new ArtifactIoInterruption(
        error instanceof Error ? error : new Error('Artifact I/O was interrupted.'),
        lateCleanup(),
      );
    }
    return result;
  } catch (error) {
    if (wasInterrupted) {
      throw new ArtifactIoInterruption(
        error instanceof Error ? error : new Error('Artifact I/O was interrupted.'),
        lateCleanup(),
      );
    }
    throw error;
  } finally {
    detach();
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function verifyFile(
  path: string,
  checksum: string,
  byteSize: number,
  context: Readonly<{ signal?: AbortSignal; deadline?: string }> = {},
): Promise<void> {
  let file: FileHandle | undefined;
  try {
    assertIoActive(context);
    file = await awaitIoOrAbort(open(path, 'r'), context, async (lateFile) => {
      await lateFile.close();
    });
    await verifyOpenFile(file, checksum, byteSize, context);
  } catch (error) {
    const inheritedCleanup = error instanceof ArtifactIoInterruption
      ? error.cleanup
      : Promise.resolve();
    const cleanupFile = file;
    const cleanup = afterCleanup(inheritedCleanup, async () => {
      await cleanupFile?.close();
    });
    file = undefined;
    if (isIoInterruption(error)) {
      throw new ArtifactIoInterruption(error, cleanup);
    }
    await awaitIoOrAbort(cleanup, context);
    throw normalizeArtifactReadError(error);
  } finally {
    if (file !== undefined) await awaitIoOrAbort(file.close(), context);
  }
}

async function verifyOpenFile(
  file: FileHandle,
  checksum: string,
  byteSize: number,
  context: Readonly<{ signal?: AbortSignal; deadline?: string }> = {},
): Promise<void> {
  const before = await awaitIoOrAbort(file.stat({ bigint: true }), context);
  await verifyPinnedOpenFile(file, checksum, byteSize, before, context);
}

async function verifyPinnedOpenFile(
  file: FileHandle,
  checksum: string,
  byteSize: number,
  before: BigIntStats,
  context: Readonly<{ signal?: AbortSignal; deadline?: string }> = {},
): Promise<void> {
  if (!before.isFile()) throw new ArtifactStoreError('CORRUPT', 'Artifact object is not a file.');
  const hash = createHash('sha256');
  let actualSize = 0;
  let position = 0;
  const buffer = Buffer.allocUnsafe(64 * 1024);
  while (true) {
    assertIoActive(context);
    const { bytesRead } = await awaitIoOrAbort(
      file.read(buffer, 0, buffer.byteLength, position), context,
    );
    assertIoActive(context);
    if (bytesRead === 0) break;
    position += bytesRead;
    actualSize += bytesRead;
    hash.update(buffer.subarray(0, bytesRead));
  }
  const after = await awaitIoOrAbort(file.stat({ bigint: true }), context);
  if (!sameFileGeneration(before, after) || actualSize !== byteSize ||
    after.size !== BigInt(byteSize) || hash.digest('hex') !== checksum) {
    throw new ArtifactStoreError('CORRUPT', 'Artifact checksum or exact byte size is invalid.');
  }
}

function sameFileGeneration(
  before: FileGeneration,
  after: FileGeneration,
): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}

function fileGeneration(stats: BigIntStats): FileGeneration {
  return Object.freeze({
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  });
}

function normalizeArtifactReadError(error: unknown): ArtifactStoreError {
  if (error instanceof ArtifactStoreError) return error;
  if (isNotFound(error)) return new ArtifactStoreError('NOT_FOUND', 'Artifact bytes are missing.');
  const code = errorCode(error);
  return new ArtifactStoreError(
    'CORRUPT',
    `Artifact bytes could not be read${code === undefined ? '' : ` (${code})`}.`,
  );
}

async function removeFileIfExists(path: string): Promise<boolean> {
  try {
    const entry = await stat(path);
    if (!entry.isFile()) throw new ArtifactStoreError('CORRUPT', 'Artifact object is not a file.');
    await rm(path, { force: true });
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function writeAtomicJson(
  path: string,
  value: unknown,
  createId: () => string,
  context: Readonly<{ signal?: AbortSignal; deadline?: string }> = {},
  onPublished?: () => void,
): Promise<void> {
  await awaitIoOrAbort(mkdir(dirname(path), { recursive: true }), context);
  const temporaryPath = `${path}.${createId()}.tmp`;
  let file: FileHandle | undefined;
  let promoted = false;
  try {
    file = await awaitIoOrAbort(open(temporaryPath, 'wx', 0o600), context, async (lateFile) => {
      await lateFile.close();
    });
    await awaitIoOrAbort(file.writeFile(`${JSON.stringify(value)}\n`, 'utf8'), context);
    await awaitIoOrAbort(file.sync(), context);
    const completedFile = file;
    file = undefined;
    await awaitIoOrAbort(completedFile.close(), context);
    try {
      await awaitIoOrAbort(rename(temporaryPath, path), context, () => {
        promoted = true;
        onPublished?.();
      });
      if (!promoted) {
        promoted = true;
        onPublished?.();
      }
    } catch (error) {
      if (error instanceof ArtifactIoInterruption) throw error;
      let existing: string;
      try {
        existing = await awaitIoOrAbort(readFile(path, 'utf8'), context);
      } catch {
        throw error;
      }
      if (existing !== `${JSON.stringify(value)}\n`) throw error;
      await awaitIoOrAbort(rm(temporaryPath, { force: true }), context);
      promoted = true;
    }
    await fsyncDirectory(dirname(path), context);
  } catch (error) {
    const inheritedCleanup = error instanceof ArtifactIoInterruption
      ? error.cleanup
      : Promise.resolve();
    const cleanup = afterCleanup(inheritedCleanup, async () => {
      await file?.close();
      if (!promoted) await rm(temporaryPath, { force: true });
    });
    if (isIoInterruption(error)) throw new ArtifactIoInterruption(error, cleanup);
    await awaitIoOrAbort(cleanup, context);
    throw error;
  }
}

async function readJsonIfExists<T>(
  path: string,
  context: Readonly<{ signal?: AbortSignal; deadline?: string }> = {},
): Promise<T | undefined> {
  try {
    return JSON.parse(await awaitIoOrAbort(readFile(path, 'utf8'), context)) as T;
  } catch (error) {
    if (isIoInterruption(error)) throw error;
    if (isNotFound(error)) return undefined;
    throw new ArtifactStoreError('CORRUPT', `Artifact metadata is corrupt: ${String(error)}`);
  }
}

async function fsyncDirectory(
  path: string,
  context: Readonly<{ signal?: AbortSignal; deadline?: string }> = {},
): Promise<void> {
  const directory = await awaitIoOrAbort(open(path, 'r'), context, async (lateDirectory) => {
    await lateDirectory.close();
  });
  try {
    await awaitIoOrAbort(directory.sync(), context);
  } catch (error) {
    if (isUnsupportedDirectorySync(error)) {
      await awaitIoOrAbort(directory.close(), context);
      return;
    }
    const inheritedCleanup = error instanceof ArtifactIoInterruption
      ? error.cleanup
      : Promise.resolve();
    const cleanup = afterCleanup(inheritedCleanup, async () => {
      await directory.close();
    });
    if (isIoInterruption(error)) throw new ArtifactIoInterruption(error, cleanup);
    await awaitIoOrAbort(cleanup, context);
    throw error;
  }
  await awaitIoOrAbort(directory.close(), context);
}

function isIoInterruption(error: unknown): error is Error {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function isAlreadyExists(error: unknown): boolean {
  return errorCode(error) === 'EEXIST' || errorCode(error) === 'EPERM';
}

function isNotFound(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  return ['EINVAL', 'EBADF', 'EPERM', 'EISDIR'].includes(errorCode(error) ?? '');
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
