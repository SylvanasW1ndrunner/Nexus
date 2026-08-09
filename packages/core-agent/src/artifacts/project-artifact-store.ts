import { createHash, randomUUID } from 'node:crypto';
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
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { AgentEvent } from '../events/agent-event.js';
import type { AgentJournal } from '../events/agent-journal.js';
import {
  ArtifactStoreError,
  type AgentArtifactStore,
  type ArtifactGcReport,
  type ArtifactJournalContext,
  type ArtifactRef,
  type ReadableArtifactRef,
  type CommitArtifactInput,
  type StageArtifactInput,
  type StagedArtifact,
} from './artifact-store.js';
import {
  acquireArtifactMutationGate,
  ArtifactMutationGateTimeoutError,
} from './artifact-mutation-gate.js';

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
  afterCommitBytesVerified?: () => Promise<void>;
  mutationGateTimeoutMs?: number;
  crashAt?: ArtifactCrashPoint;
};

type StagedMetadata = StagedArtifact & {
  storageVersion: 1;
  blobName: string;
};

type CommittedMetadata = ArtifactRef & {
  storageVersion: 1;
  objectName: string;
  expiresAt?: string;
};

type CreatedArtifactFact = Extract<AgentEvent, { type: 'artifact.created' }>;
type ArtifactFactState = {
  fact: CreatedArtifactFact;
  lifecycle: 'available' | 'expired' | 'deleted';
};

export class ProjectArtifactStore implements AgentArtifactStore {
  readonly #projectId: string;
  readonly #rootDir: string;
  readonly #journal: AgentJournal;
  readonly #now: () => string;
  readonly #createId: () => string;
  readonly #writeChunk: (file: FileHandle, chunk: Uint8Array, offset: number) => Promise<number>;
  readonly #afterOpenVerified: ((objectPath: string) => Promise<void>) | undefined;
  readonly #afterCommitBytesVerified: (() => Promise<void>) | undefined;
  readonly #mutationGateTimeoutMs: number;
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
    this.#afterCommitBytesVerified = options.afterCommitBytesVerified;
    this.#mutationGateTimeoutMs = options.mutationGateTimeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.#mutationGateTimeoutMs) ||
      this.#mutationGateTimeoutMs < 100 || this.#mutationGateTimeoutMs > 60_000) {
      throw new ArtifactStoreError(
        'INVALID_ARGUMENT',
        'mutationGateTimeoutMs must be between 100 and 60000.',
      );
    }
    this.#crashAt = options.crashAt;
  }

  async stage(input: StageArtifactInput): Promise<StagedArtifact> {
    const mediaType = requireMediaType(input.mediaType);
    const expectedByteSize = input.expectedByteSize;
    if (
      expectedByteSize !== undefined &&
      (!Number.isSafeInteger(expectedByteSize) || expectedByteSize < 0)
    ) {
      throw new ArtifactStoreError('INVALID_ARGUMENT', 'expectedByteSize must be non-negative.');
    }
    if (input.expiresAt !== undefined && !Number.isFinite(Date.parse(input.expiresAt))) {
      throw new ArtifactStoreError('INVALID_ARGUMENT', 'expiresAt must be an ISO date.');
    }
    await this.#ensureDirectories();
    const temporaryName = `.stage-${this.#createId()}.tmp`;
    const temporaryPath = join(this.#stagedDir(), temporaryName);
    const file = await open(temporaryPath, 'wx', 0o600);
    const hash = createHash('sha256');
    let byteSize = 0;
    try {
      try {
        for await (const chunk of asAsyncIterable(input.source)) {
          if (!(chunk instanceof Uint8Array)) {
            throw new ArtifactStoreError('INVALID_ARGUMENT', 'Artifact chunks must be Uint8Array.');
          }
          byteSize += chunk.byteLength;
          if (!Number.isSafeInteger(byteSize)) {
            throw new ArtifactStoreError('INVALID_ARGUMENT', 'Artifact is too large.');
          }
          hash.update(chunk);
          let offset = 0;
          while (offset < chunk.byteLength) {
            const bytesWritten = await this.#writeChunk(file, chunk, offset);
            if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 ||
              bytesWritten > chunk.byteLength - offset) {
              throw new ArtifactStoreError('STAGE_FAILED', 'Artifact write made invalid progress.');
            }
            offset += bytesWritten;
          }
        }
        await file.sync();
      } finally {
        await file.close();
      }
    } catch (error) {
      await rm(temporaryPath, { force: true });
      if (error instanceof ArtifactStoreError) throw error;
      throw new ArtifactStoreError('STAGE_FAILED', 'Artifact source failed during staging.');
    }
    const checksum = hash.digest('hex');
    await verifyFile(temporaryPath, checksum, byteSize);
    if (input.expectedChecksum !== undefined && input.expectedChecksum !== checksum) {
      await rm(temporaryPath, { force: true });
      throw new ArtifactStoreError('CHECKSUM_MISMATCH', 'Staged bytes did not match checksum.');
    }
    if (expectedByteSize !== undefined && expectedByteSize !== byteSize) {
      await rm(temporaryPath, { force: true });
      throw new ArtifactStoreError('SIZE_MISMATCH', 'Staged bytes did not match exact byte size.');
    }
    const referenceNonce = this.#createId();
    const artifactId = `artifact_${sha256(`${this.#projectId}\0${checksum}\0${referenceNonce}`)}`;
    const handle = `agent-artifact:${sha256(this.#projectId).slice(0, 24)}:${artifactId.slice(-40)}`;
    const blobName = `${artifactId}.blob`;
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
      stagedAt: this.#now(),
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      blobName,
    };
    const blobPath = containedPath(this.#stagedDir(), blobName);
    try {
      await rename(temporaryPath, blobPath);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      await rm(temporaryPath, { force: true });
      await verifyFile(blobPath, checksum, byteSize);
    }
    await verifyFile(blobPath, checksum, byteSize);
    await fsyncDirectory(this.#stagedDir());
    await writeAtomicJson(this.#stagedMetadataPath(artifactId), staged, this.#createId);
    return publicStaged(staged);
  }

  async commit(input: CommitArtifactInput): Promise<ArtifactRef> {
    const gate = await this.#acquireMutationGate();
    try {
      return await this.#commitWithGate(input);
    } finally {
      gate.close();
    }
  }

  async #commitWithGate(input: CommitArtifactInput): Promise<ArtifactRef> {
    assertStagedArtifact(input.staged, this.#projectId);
    this.#assertProject(input.staged.projectId);
    const summary = requireText(input.summary, 'summary');
    const staged = await this.#readStagedMetadata(input.staged.artifactId);
    const committedMetadata = await this.#readCommittedMetadata(input.staged.artifactId);
    const candidate = staged ?? committedMetadata;
    if (candidate === undefined) {
      throw new ArtifactStoreError('NOT_FOUND', 'Staged artifact metadata was not found.');
    }
    assertPersistedArtifact(candidate, this.#projectId);
    assertArtifactInput(candidate, input.staged);
    if (staged !== undefined) {
      await verifyFile(containedPath(this.#stagedDir(), staged.blobName), staged.checksum, staged.byteSize);
    } else {
      await verifyFile(this.#objectPath(candidate.checksum), candidate.checksum, candidate.byteSize);
    }
    await this.#afterCommitBytesVerified?.();

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

  async open(ref: ReadableArtifactRef): Promise<ReadableStream<Uint8Array>> {
    assertReadableArtifact(ref, this.#projectId);
    this.#assertProject(ref.projectId);
    const lifecycle = await this.#artifactLifecycle(ref.artifactId, new Date(this.#now()));
    if (lifecycle === 'expired') throw new ArtifactStoreError('EXPIRED', 'Artifact has expired.');
    if (lifecycle === 'deleted') throw new ArtifactStoreError('DELETED', 'Artifact was deleted.');
    const fact = await this.#findCreatedFact(ref.artifactId);
    if (fact === undefined) {
      throw new ArtifactStoreError('NOT_FOUND', 'Artifact has no committed Journal reference.');
    }
    if (fact.payload.availability === 'legacy-unavailable') {
      throw new ArtifactStoreError('LEGACY_UNAVAILABLE', 'Legacy artifact content is unavailable.');
    }
    if (ref.availability === 'legacy-unavailable') {
      throw new ArtifactStoreError('LEGACY_UNAVAILABLE', 'Legacy artifact content is unavailable.');
    }
    assertMatchingFact(fact, ref, fact.runId);
    let metadata = await this.#readCommittedMetadata(ref.artifactId);
    if (metadata === undefined) {
      const gate = await this.#acquireMutationGate();
      try {
        metadata = await this.#readCommittedMetadata(ref.artifactId);
        if (metadata === undefined) {
          const staged = await this.#readStagedMetadata(ref.artifactId);
          if (staged === undefined) {
            throw new ArtifactStoreError('CORRUPT', 'Committed artifact metadata is missing.');
          }
          await this.#promote(publicStaged(staged), fact.occurredAt);
          metadata = await this.#readCommittedMetadata(ref.artifactId);
        }
      } finally {
        gate.close();
      }
    }
    if (metadata === undefined) {
      throw new ArtifactStoreError('CORRUPT', 'Committed artifact metadata is missing after promotion.');
    }
    assertPersistedArtifact(metadata, this.#projectId);
    assertArtifactInput(metadata, ref);
    const objectPath = this.#objectPath(ref.checksum);
    let file: FileHandle | undefined;
    try {
      file = await open(objectPath, 'r');
      await verifyOpenFile(file, ref.checksum, ref.byteSize);
      await this.#afterOpenVerified?.(objectPath);
    } catch (error) {
      await file?.close().catch(() => undefined);
      throw normalizeArtifactReadError(error);
    }
    let position = 0;
    let closed = false;
    const closeFile = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await file.close();
    };
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const buffer = new Uint8Array(64 * 1024);
          const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, position);
          if (bytesRead === 0) {
            await closeFile();
            controller.close();
            return;
          }
          position += bytesRead;
          controller.enqueue(buffer.subarray(0, bytesRead));
        } catch (error) {
          await closeFile();
          controller.error(normalizeArtifactReadError(error));
        }
      },
      async cancel() {
        await closeFile();
      },
    });
  }

  async expire(ref: ArtifactRef, context: ArtifactJournalContext): Promise<void> {
    await this.#commitLifecycle('artifact.expired', ref, context);
  }

  async delete(ref: ArtifactRef, context: ArtifactJournalContext): Promise<void> {
    await this.#commitLifecycle('artifact.deleted', ref, context);
  }

  async collectGarbage(now: Date): Promise<ArtifactGcReport> {
    if (!Number.isFinite(now.getTime())) {
      throw new ArtifactStoreError('INVALID_ARGUMENT', 'GC time must be valid.');
    }
    const gate = await this.#acquireMutationGate();
    try {
      return await this.#collectGarbageWithGate(now);
    } finally {
      gate.close();
    }
  }

  async #collectGarbageWithGate(now: Date): Promise<ArtifactGcReport> {
    await this.#ensureDirectories();
    const factStates = await this.#artifactStates(now);
    let stagedObjectsDeleted = 0;
    let committedObjectsDeleted = 0;
    let bytesDeleted = 0;
    for (const entry of await readdir(this.#metadataDir(), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.staged.json')) continue;
      const artifactId = entry.name.slice(0, -'.staged.json'.length);
      requireArtifactId(artifactId);
      const metadata = await this.#readStagedMetadata(artifactId);
      if (metadata === undefined || metadata.expiresAt === undefined) continue;
      assertPersistedArtifact(metadata, this.#projectId);
      if (Date.parse(metadata.expiresAt) > now.getTime()) continue;
      if (factStates.has(artifactId)) continue;
      await rm(containedPath(this.#stagedDir(), metadata.blobName), { force: true });
      await rm(this.#stagedMetadataPath(artifactId), { force: true });
      stagedObjectsDeleted += 1;
      bytesDeleted += metadata.byteSize;
    }
    for (const entry of await readdir(this.#metadataDir(), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.committed.json')) continue;
      const artifactId = entry.name.slice(0, -'.committed.json'.length);
      requireArtifactId(artifactId);
      const state = factStates.get(artifactId);
      if (state === undefined || state.lifecycle === 'available') continue;
      const metadata = await this.#readCommittedMetadata(artifactId);
      if (metadata === undefined) continue;
      assertPersistedArtifact(metadata, this.#projectId);
      await rm(this.#committedMetadataPath(artifactId), { force: true });
      committedObjectsDeleted += 1;
      const hasAvailableReference = [...factStates.values()].some(({ fact, lifecycle }) =>
        lifecycle === 'available' && fact.payload.availability === 'available' &&
        fact.payload.checksum === metadata.checksum);
      if (!hasAvailableReference && await removeFileIfExists(this.#objectPath(metadata.checksum))) {
        bytesDeleted += metadata.byteSize;
      }
    }
    return { stagedObjectsDeleted, committedObjectsDeleted, bytesDeleted };
  }

  async #acquireMutationGate() {
    try {
      return await acquireArtifactMutationGate(this.#rootDir, this.#mutationGateTimeoutMs);
    } catch (error) {
      if (error instanceof ArtifactMutationGateTimeoutError) {
        throw new ArtifactStoreError('STORE_BUSY', error.message);
      }
      throw error;
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

  async #promote(staged: StagedArtifact, createdAt: string): Promise<ArtifactRef> {
    assertStagedArtifact(staged, this.#projectId);
    const objectPath = this.#objectPath(staged.checksum);
    await mkdir(dirname(objectPath), { recursive: true });
    const stagedMetadata = await this.#readStagedMetadata(staged.artifactId);
    if (stagedMetadata !== undefined) {
      assertPersistedArtifact(stagedMetadata, this.#projectId);
      const stagedPath = containedPath(this.#stagedDir(), stagedMetadata.blobName);
      await verifyFile(stagedPath, staged.checksum, staged.byteSize);
      try {
        await rename(stagedPath, objectPath);
      } catch (error) {
        if (!isAlreadyExists(error) && !isNotFound(error)) throw error;
        await verifyFile(objectPath, staged.checksum, staged.byteSize);
        await rm(stagedPath, { force: true });
      }
      await fsyncDirectory(dirname(objectPath));
    } else {
      await verifyFile(objectPath, staged.checksum, staged.byteSize);
    }
    await verifyFile(objectPath, staged.checksum, staged.byteSize);
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
    };
    const metadata: CommittedMetadata = {
      ...ref,
      storageVersion: 1,
      objectName: basename(objectPath),
    };
    await writeAtomicJson(this.#committedMetadataPath(staged.artifactId), metadata, this.#createId);
    await rm(this.#stagedMetadataPath(staged.artifactId), { force: true });
    await fsyncDirectory(this.#metadataDir());
    return ref;
  }

  async #findCreatedFact(artifactId: string): Promise<CreatedArtifactFact | undefined> {
    requireArtifactId(artifactId);
    let cursor = 0;
    let match: CreatedArtifactFact | undefined;
    while (true) {
      const page = await this.#journal.readProject(this.#projectId, cursor, 1_000);
      for (const event of page) {
        if (event.type !== 'artifact.created' || event.payload.artifactId !== artifactId) continue;
        if (match !== undefined && JSON.stringify(match.payload) !== JSON.stringify(event.payload)) {
          throw new ArtifactStoreError(
            'JOURNAL_REFERENCE_CONFLICT',
            'Multiple conflicting artifact facts were committed.',
          );
        }
        match = event;
      }
      if (page.length < 1_000) return match;
      cursor = page.at(-1)!.sequence;
    }
  }

  async #artifactLifecycle(
    artifactId: string,
    now: Date,
  ): Promise<'available' | 'expired' | 'deleted'> {
    requireArtifactId(artifactId);
    return (await this.#artifactStates(now)).get(artifactId)?.lifecycle ?? 'available';
  }

  async #artifactStates(now: Date): Promise<Map<string, ArtifactFactState>> {
    const states = new Map<string, ArtifactFactState>();
    let cursor = 0;
    while (true) {
      const page = await this.#journal.readProject(this.#projectId, cursor, 1_000);
      for (const event of page) {
        if (event.type === 'artifact.created') {
          states.set(event.payload.artifactId, {
            fact: event,
            lifecycle: event.payload.expiresAt !== undefined &&
              Date.parse(event.payload.expiresAt) <= now.getTime() ? 'expired' : 'available',
          });
        } else if (event.type === 'artifact.expired' || event.type === 'artifact.deleted') {
          const state = states.get(event.payload.artifactId);
          if (state !== undefined) {
            state.lifecycle = event.type === 'artifact.expired' ? 'expired' : 'deleted';
          }
        }
      }
      if (page.length < 1_000) return states;
      cursor = page.at(-1)!.sequence;
    }
  }

  async #ensureDirectories(): Promise<void> {
    await Promise.all([
      mkdir(this.#stagedDir(), { recursive: true }),
      mkdir(this.#metadataDir(), { recursive: true }),
      mkdir(this.#objectsDir(), { recursive: true }),
    ]);
  }

  #assertProject(projectId: string): void {
    if (projectId !== this.#projectId) {
      throw new ArtifactStoreError('PROJECT_MISMATCH', 'Artifact belongs to another Project.');
    }
  }

  async #readStagedMetadata(artifactId: string): Promise<StagedMetadata | undefined> {
    return await readJsonIfExists<StagedMetadata>(this.#stagedMetadataPath(artifactId));
  }

  async #readCommittedMetadata(artifactId: string): Promise<CommittedMetadata | undefined> {
    return await readJsonIfExists<CommittedMetadata>(this.#committedMetadataPath(artifactId));
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

function requireText(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ArtifactStoreError('INVALID_ARGUMENT', `${name} is required.`);
  }
  return value.trim();
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
}

function assertPersistedArtifact(
  metadata: StagedMetadata | CommittedMetadata,
  projectId: string,
): void {
  if (metadata.storageVersion !== 1) {
    throw new ArtifactStoreError('CORRUPT', 'Artifact metadata storage version is invalid.');
  }
  try {
    if (metadata.availability === 'staged') assertStagedArtifact(metadata, projectId);
    else assertReadableArtifact(metadata, projectId);
  } catch (error) {
    if (error instanceof ArtifactStoreError) {
      throw new ArtifactStoreError('CORRUPT', `Artifact metadata is invalid: ${error.message}`);
    }
    throw error;
  }
  if ('blobName' in metadata && metadata.blobName !== `${metadata.artifactId}.blob`) {
    throw new ArtifactStoreError('CORRUPT', 'Staged artifact blob path is invalid.');
  }
  if ('objectName' in metadata && metadata.objectName !== metadata.checksum.slice(2)) {
    throw new ArtifactStoreError('CORRUPT', 'Committed artifact object path is invalid.');
  }
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
  };
}

function assertArtifactInput(
  actual: Pick<StagedArtifact, 'artifactId' | 'handle' | 'projectId' | 'checksum' | 'byteSize' | 'mediaType'>,
  expected: Pick<StagedArtifact, 'artifactId' | 'handle' | 'projectId' | 'checksum' | 'byteSize' | 'mediaType'>,
): void {
  if (
    actual.artifactId !== expected.artifactId ||
    actual.handle !== expected.handle ||
    actual.projectId !== expected.projectId ||
    actual.checksum !== expected.checksum ||
    actual.byteSize !== expected.byteSize ||
    actual.mediaType !== expected.mediaType
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

async function* asAsyncIterable(
  source: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  if (Symbol.asyncIterator in source) {
    yield* source;
    return;
  }
  const reader = source.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) return;
      yield result.value;
    }
  } finally {
    reader.releaseLock();
  }
}

async function verifyFile(path: string, checksum: string, byteSize: number): Promise<void> {
  let file: FileHandle | undefined;
  try {
    file = await open(path, 'r');
    await verifyOpenFile(file, checksum, byteSize);
  } catch (error) {
    throw normalizeArtifactReadError(error);
  } finally {
    await file?.close().catch(() => undefined);
  }
}

async function verifyOpenFile(
  file: FileHandle,
  checksum: string,
  byteSize: number,
): Promise<void> {
  const before = await file.stat();
  if (!before.isFile()) throw new ArtifactStoreError('CORRUPT', 'Artifact object is not a file.');
  const hash = createHash('sha256');
  let actualSize = 0;
  let position = 0;
  const buffer = Buffer.allocUnsafe(64 * 1024);
  while (true) {
    const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, position);
    if (bytesRead === 0) break;
    position += bytesRead;
    actualSize += bytesRead;
    hash.update(buffer.subarray(0, bytesRead));
  }
  const after = await file.stat();
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs || actualSize !== byteSize || hash.digest('hex') !== checksum) {
    throw new ArtifactStoreError('CORRUPT', 'Artifact checksum or exact byte size is invalid.');
  }
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
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${createId()}.tmp`;
  const file = await open(temporaryPath, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    let existing: string;
    try {
      existing = await readFile(path, 'utf8');
    } catch {
      throw error;
    }
    if (existing !== `${JSON.stringify(value)}\n`) throw error;
    await rm(temporaryPath, { force: true });
  }
  await fsyncDirectory(dirname(path));
}

async function readJsonIfExists<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw new ArtifactStoreError('CORRUPT', `Artifact metadata is corrupt: ${String(error)}`);
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r');
  try {
    await directory.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    await directory.close();
  }
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
