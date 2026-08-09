import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
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

export * from './artifact-store.js';

export type ArtifactCrashPoint = 'after-journal-before-promotion';

export type ProjectArtifactStoreOptions = {
  projectId: string;
  rootDir: string;
  journal: AgentJournal;
  now?: () => string;
  createId?: () => string;
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

export class ProjectArtifactStore implements AgentArtifactStore {
  readonly #projectId: string;
  readonly #rootDir: string;
  readonly #journal: AgentJournal;
  readonly #now: () => string;
  readonly #createId: () => string;
  #crashAt: ArtifactCrashPoint | undefined;

  constructor(options: ProjectArtifactStoreOptions) {
    this.#projectId = requireText(options.projectId, 'projectId');
    this.#rootDir = requireText(options.rootDir, 'rootDir');
    this.#journal = options.journal;
    this.#now = options.now ?? (() => new Date().toISOString());
    const createId = options.createId ?? randomUUID;
    this.#createId = () => requireOpaqueId(createId());
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
          await file.write(chunk);
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
    if (input.expectedChecksum !== undefined && input.expectedChecksum !== checksum) {
      await rm(temporaryPath, { force: true });
      throw new ArtifactStoreError('CHECKSUM_MISMATCH', 'Staged bytes did not match checksum.');
    }
    if (expectedByteSize !== undefined && expectedByteSize !== byteSize) {
      await rm(temporaryPath, { force: true });
      throw new ArtifactStoreError('SIZE_MISMATCH', 'Staged bytes did not match exact byte size.');
    }
    const artifactId = `artifact_${sha256(`${this.#projectId}\0${checksum}`)}`;
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
    const existing = await this.#readStagedMetadata(artifactId);
    if (existing !== undefined) {
      assertEquivalentStaged(existing, staged);
      await rm(temporaryPath, { force: true });
      return publicStaged(existing);
    }
    const blobPath = join(this.#stagedDir(), blobName);
    try {
      await rename(temporaryPath, blobPath);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      await rm(temporaryPath, { force: true });
      await verifyFile(blobPath, checksum, byteSize);
    }
    await fsyncDirectory(this.#stagedDir());
    await writeAtomicJson(this.#stagedMetadataPath(artifactId), staged, this.#createId);
    return publicStaged(staged);
  }

  async commit(input: CommitArtifactInput): Promise<ArtifactRef> {
    this.#assertProject(input.staged.projectId);
    const summary = requireText(input.summary, 'summary');
    const staged = await this.#readStagedMetadata(input.staged.artifactId);
    const committedMetadata = await this.#readCommittedMetadata(input.staged.artifactId);
    const candidate = staged ?? committedMetadata;
    if (candidate === undefined) {
      throw new ArtifactStoreError('NOT_FOUND', 'Staged artifact metadata was not found.');
    }
    assertArtifactInput(candidate, input.staged);

    let fact = await this.#findCreatedFact(input.staged.artifactId);
    if (fact !== undefined) assertMatchingFact(fact, input.staged, input.journal.runId);
    if (fact === undefined) {
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
            },
          },
        ],
      });
      fact = await this.#findCreatedFact(input.staged.artifactId);
    }
    if (fact === undefined) {
      throw new ArtifactStoreError(
        'NOT_COMMITTED',
        'Journal did not expose the committed artifact reference.',
      );
    }
    assertMatchingFact(fact, input.staged, input.journal.runId);
    if (this.#crashAt === 'after-journal-before-promotion') {
      this.#crashAt = undefined;
      throw new ArtifactStoreError('INJECTED_CRASH', 'Injected artifact promotion crash.');
    }
    return await this.#promote(input.staged, fact.occurredAt);
  }

  async open(ref: ReadableArtifactRef): Promise<ReadableStream<Uint8Array>> {
    this.#assertProject(ref.projectId);
    const lifecycle = await this.#artifactLifecycle(ref.artifactId);
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
    const metadata = await this.#readCommittedMetadata(ref.artifactId);
    if (metadata === undefined) {
      const staged = await this.#readStagedMetadata(ref.artifactId);
      if (staged === undefined) {
        throw new ArtifactStoreError('CORRUPT', 'Committed artifact metadata is missing.');
      }
      await this.#promote(publicStaged(staged), fact.occurredAt);
    } else {
      assertArtifactInput(metadata, ref);
    }
    const objectPath = this.#objectPath(ref.checksum);
    await verifyFile(objectPath, ref.checksum, ref.byteSize);
    const file = await open(objectPath, 'r');
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
          controller.error(error);
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
    await this.#ensureDirectories();
    let stagedObjectsDeleted = 0;
    let committedObjectsDeleted = 0;
    let bytesDeleted = 0;
    for (const entry of await readdir(this.#metadataDir(), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.staged.json')) continue;
      const artifactId = entry.name.slice(0, -'.staged.json'.length);
      const metadata = await this.#readStagedMetadata(artifactId);
      if (metadata === undefined || metadata.expiresAt === undefined) continue;
      if (Date.parse(metadata.expiresAt) > now.getTime()) continue;
      if ((await this.#findCreatedFact(artifactId)) !== undefined) continue;
      await rm(join(this.#stagedDir(), metadata.blobName), { force: true });
      await rm(this.#stagedMetadataPath(artifactId), { force: true });
      stagedObjectsDeleted += 1;
      bytesDeleted += metadata.byteSize;
    }
    for (const entry of await readdir(this.#metadataDir(), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.committed.json')) continue;
      const artifactId = entry.name.slice(0, -'.committed.json'.length);
      const lifecycle = await this.#artifactLifecycle(artifactId);
      if (lifecycle !== 'expired' && lifecycle !== 'deleted') continue;
      const metadata = await this.#readCommittedMetadata(artifactId);
      if (metadata === undefined) continue;
      await rm(this.#objectPath(metadata.checksum), { force: true });
      await rm(this.#committedMetadataPath(artifactId), { force: true });
      committedObjectsDeleted += 1;
      bytesDeleted += metadata.byteSize;
    }
    return { stagedObjectsDeleted, committedObjectsDeleted, bytesDeleted };
  }

  async #commitLifecycle(
    type: 'artifact.expired' | 'artifact.deleted',
    ref: ArtifactRef,
    context: ArtifactJournalContext,
  ): Promise<void> {
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
    const objectPath = this.#objectPath(staged.checksum);
    await mkdir(dirname(objectPath), { recursive: true });
    const stagedMetadata = await this.#readStagedMetadata(staged.artifactId);
    if (stagedMetadata !== undefined) {
      const stagedPath = join(this.#stagedDir(), stagedMetadata.blobName);
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

  async #artifactLifecycle(artifactId: string): Promise<'available' | 'expired' | 'deleted'> {
    let cursor = 0;
    let state: 'available' | 'expired' | 'deleted' = 'available';
    while (true) {
      const page = await this.#journal.readProject(this.#projectId, cursor, 1_000);
      for (const event of page) {
        if (event.payload && 'artifactId' in event.payload && event.payload.artifactId === artifactId) {
          if (event.type === 'artifact.expired') state = 'expired';
          if (event.type === 'artifact.deleted') state = 'deleted';
        }
      }
      if (page.length < 1_000) return state;
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

  #stagedDir(): string { return join(this.#rootDir, 'staged'); }
  #metadataDir(): string { return join(this.#rootDir, 'metadata'); }
  #objectsDir(): string { return join(this.#rootDir, 'objects'); }
  #stagedMetadataPath(artifactId: string): string {
    return join(this.#metadataDir(), `${artifactId}.staged.json`);
  }
  #committedMetadataPath(artifactId: string): string {
    return join(this.#metadataDir(), `${artifactId}.committed.json`);
  }
  #objectPath(checksum: string): string {
    return join(this.#objectsDir(), checksum.slice(0, 2), checksum.slice(2));
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

function assertEquivalentStaged(left: StagedMetadata, right: StagedMetadata): void {
  assertArtifactInput(left, right);
  if (left.expiresAt !== right.expiresAt) {
    throw new ArtifactStoreError('METADATA_CONFLICT', 'Equivalent content has conflicting retention.');
  }
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
  ref: Pick<StagedArtifact, 'artifactId' | 'handle' | 'checksum' | 'byteSize' | 'mediaType'>,
  runId: string,
): void {
  const payload = fact.payload;
  if (
    fact.runId !== runId ||
    payload.availability !== 'available' ||
    payload.artifactId !== ref.artifactId ||
    payload.handle !== ref.handle ||
    payload.checksum !== ref.checksum ||
    payload.byteSize !== ref.byteSize ||
    payload.mediaType !== ref.mediaType
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
  let file;
  try {
    file = await open(path, 'r');
  } catch (error) {
    if (isNotFound(error)) throw new ArtifactStoreError('NOT_FOUND', 'Artifact bytes are missing.');
    throw error;
  }
  const hash = createHash('sha256');
  let actualSize = 0;
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      actualSize += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await file.close();
  }
  if (actualSize !== byteSize || hash.digest('hex') !== checksum) {
    throw new ArtifactStoreError('CORRUPT', 'Artifact checksum or exact byte size is invalid.');
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
  await rename(temporaryPath, path);
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
