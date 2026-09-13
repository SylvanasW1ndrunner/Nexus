import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, realpathSync } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  expectedToolError,
  type ContentAccessScope,
  type OpenedContent,
} from '@dbagent/core-agent';

export const RESULT_FILE_MAX_BYTES = 64 * 1024 * 1024;
const MANIFEST_NAME = 'manifest.json';
const MANIFEST_MAX_BYTES = 1024 * 1024;
const CHECKSUM_PATTERN = /^(?:sha256:)?([a-f0-9]{64})$/u;

export type ResultMaterializationOwner = Readonly<Required<ContentAccessScope>>;

export type MaterializedResultFile = Readonly<{
  contentRef: string;
  temporaryPath: string;
  contentType: string;
  sizeBytes: number;
  digest: string;
  lifecycle: 'run';
}>;

export type ResultMaterializationStoreOptions = Readonly<{
  projectRoot: string;
  rootDirectory?: string;
}>;

export type ResultMaterializationReapReport = Readonly<{
  retainedRuns: number;
  removedRuns: number;
  pendingRuns: number;
}>;

type ManifestEntry = Readonly<{
  contentRef: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  checksum: string;
}>;

type RunManifest = Readonly<{
  schemaVersion: 1;
  directoryId: string;
  owner: ResultMaterializationOwner;
  entries: readonly ManifestEntry[];
}>;

type RunDirectory = Readonly<{
  path: string;
  manifest: RunManifest;
}>;

type DirectoryIdentity = Readonly<{
  path: string;
  device: number | bigint;
  inode: number | bigint;
}>;

type MaterializationRootGuard = Readonly<{
  canonicalRoot: string;
  directories: readonly DirectoryIdentity[];
}>;

/** Runtime-owned byte files. It never opens Artifact paths or writes user workspace outputs. */
export class ResultMaterializationStore {
  readonly projectRoot: string;
  readonly rootDirectory: string;
  readonly #runs = new Map<string, RunDirectory>();
  readonly #pendingCleanup = new Set<string>();
  #tail: Promise<void> = Promise.resolve();
  #initialized = false;
  #rootGuard: MaterializationRootGuard | undefined;

  constructor(options: ResultMaterializationStoreOptions) {
    this.projectRoot = realpathSync(resolve(options.projectRoot));
    this.rootDirectory = resolve(
      options.rootDirectory ?? join(this.projectRoot, '.schemanaut', 'runtime', 'materialized'),
    );
    assertContained(this.projectRoot, this.rootDirectory);
  }

  /** Rebuilds the in-memory index and removes terminal, orphaned or corrupt directories. */
  initialize(
    retainOwner: (owner: ResultMaterializationOwner) => boolean | Promise<boolean>,
  ): Promise<ResultMaterializationReapReport> {
    return this.#exclusive(async () => {
      const rootGuard = await ensureMaterializationRoot(
        this.projectRoot,
        this.rootDirectory,
      );
      this.#rootGuard = rootGuard;
      this.#runs.clear();
      this.#pendingCleanup.clear();
      let retainedRuns = 0;
      let removedRuns = 0;
      let pendingRuns = 0;
      const entries = await readdir(this.rootDirectory, { withFileTypes: true });
      for (const entry of entries) {
        const path = containedChild(this.rootDirectory, entry.name);
        let run: RunDirectory | undefined;
        if (entry.isDirectory() && isOpaqueRunDirectory(entry.name)) {
          run = await loadRunDirectory(path, entry.name).catch(() => undefined);
        }
        const retain = run === undefined
          ? false
          : await Promise.resolve(retainOwner(run.manifest.owner)).catch(() => false);
        if (run !== undefined && retain && await verifyRunDirectory(run)) {
          const key = ownerKey(run.manifest.owner);
          if (!this.#runs.has(key)) {
            this.#runs.set(key, run);
            retainedRuns += 1;
            continue;
          }
        }
        if (await removeDirectory(rootGuard, path)) removedRuns += 1;
        else {
          this.#pendingCleanup.add(path);
          pendingRuns += 1;
        }
      }
      this.#initialized = true;
      return Object.freeze({ retainedRuns, removedRuns, pendingRuns });
    });
  }

  materialize(input: Readonly<{
    opened: OpenedContent;
    owner: ContentAccessScope;
    signal: AbortSignal;
    deadline?: string;
  }>): Promise<MaterializedResultFile> {
    return this.#exclusive(async () => {
      this.#assertInitialized();
      await assertRootGuardCurrent(this.#requireRootGuard());
      assertActive(input.signal, input.deadline);
      const owner = normalizeOwner(input.owner);
      const checksum = normalizeChecksum(input.opened.checksum);
      if (input.opened.byteSize > RESULT_FILE_MAX_BYTES) {
        await input.opened.stream.cancel().catch(() => undefined);
        throw expectedToolError('limit', 'The Runtime result exceeds the 64 MiB materialization limit.');
      }
      const run = await this.#runDirectory(owner);
      const existing = run.manifest.entries.find(
        (candidate) => candidate.contentRef === input.opened.contentRef,
      );
      if (existing !== undefined && existing.checksum === checksum &&
        existing.sizeBytes === input.opened.byteSize &&
        existing.contentType === input.opened.contentType &&
        await verifyEntry(run.path, existing)) {
        await input.opened.stream.cancel().catch(() => undefined);
        return materializedPayload(this.projectRoot, run.path, existing);
      }
      if (existing !== undefined) {
        await unlink(containedChild(run.path, existing.fileName)).catch(() => undefined);
      }
      const entry = await writeOpenedContent(run.path, input.opened, checksum, input);
      const entries = [
        ...run.manifest.entries.filter((candidate) => candidate.contentRef !== entry.contentRef),
        entry,
      ];
      const manifest = Object.freeze({ ...run.manifest, entries: Object.freeze(entries) });
      await writeManifest(run.path, manifest);
      this.#runs.set(ownerKey(owner), Object.freeze({ path: run.path, manifest }));
      return materializedPayload(this.projectRoot, run.path, entry);
    });
  }

  /** Idempotent best-effort cleanup. A failed Windows deletion remains for startup reaping. */
  cleanupRun(owner: ContentAccessScope): Promise<boolean> {
    return this.#exclusive(async () => {
      this.#assertInitialized();
      const normalized = normalizeOwner(owner);
      const key = ownerKey(normalized);
      const run = this.#runs.get(key);
      if (run === undefined) return true;
      const removed = await removeDirectory(this.#requireRootGuard(), run.path);
      if (removed) this.#runs.delete(key);
      return removed;
    });
  }

  /** Retries cleanup for every indexed Run without treating delayed deletion as a fatal close error. */
  cleanupAll(): Promise<ResultMaterializationReapReport> {
    return this.#exclusive(async () => {
      this.#assertInitialized();
      let removedRuns = 0;
      let pendingRuns = 0;
      for (const [key, run] of [...this.#runs]) {
        if (await removeDirectory(this.#requireRootGuard(), run.path)) {
          this.#runs.delete(key);
          removedRuns += 1;
        } else {
          pendingRuns += 1;
        }
      }
      for (const path of [...this.#pendingCleanup]) {
        if (await removeDirectory(this.#requireRootGuard(), path)) {
          this.#pendingCleanup.delete(path);
          removedRuns += 1;
        } else {
          pendingRuns += 1;
        }
      }
      return Object.freeze({ retainedRuns: 0, removedRuns, pendingRuns });
    });
  }

  drain(): Promise<void> {
    return this.#tail;
  }

  #assertInitialized(): void {
    if (!this.#initialized) {
      throw expectedToolError('precondition', 'Runtime result materialization is not initialized.');
    }
  }

  #requireRootGuard(): MaterializationRootGuard {
    this.#assertInitialized();
    if (this.#rootGuard === undefined) {
      throw expectedToolError('precondition', 'Runtime result materialization root is unavailable.');
    }
    return this.#rootGuard;
  }

  async #runDirectory(owner: ResultMaterializationOwner): Promise<RunDirectory> {
    await assertRootGuardCurrent(this.#requireRootGuard());
    const key = ownerKey(owner);
    const current = this.#runs.get(key);
    if (current !== undefined) return current;
    for (;;) {
      const directoryId = `run-${randomUUID()}`;
      const path = containedChild(this.rootDirectory, directoryId);
      try {
        await mkdir(path, { mode: 0o700 });
        const manifest: RunManifest = Object.freeze({
          schemaVersion: 1,
          directoryId,
          owner,
          entries: Object.freeze([]),
        });
        await writeManifest(path, manifest);
        const created = Object.freeze({ path, manifest });
        this.#runs.set(key, created);
        return created;
      } catch (error) {
        if (!isFileSystemError(error, 'EEXIST')) throw error;
      }
    }
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

async function writeOpenedContent(
  runPath: string,
  opened: OpenedContent,
  checksum: string,
  boundary: Readonly<{ signal: AbortSignal; deadline?: string }>,
): Promise<ManifestEntry> {
  const suffix = extensionFor(opened.contentType);
  const identity = createHash('sha256').update(opened.contentRef).digest('hex').slice(0, 32);
  const fileName = `content-${identity}${suffix}`;
  const finalPath = containedChild(runPath, fileName);
  const partialPath = containedChild(runPath, `.partial-${randomUUID()}`);
  const reader = opened.stream.getReader();
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let published = false;
  const hash = createHash('sha256');
  let sizeBytes = 0;
  try {
    handle = await open(partialPath, 'wx', 0o600);
    for (;;) {
      assertActive(boundary.signal, boundary.deadline);
      const next = await readWithBoundary(reader, boundary);
      assertActive(boundary.signal, boundary.deadline);
      if (next.done) break;
      const chunk = next.value;
      if (!(chunk instanceof Uint8Array)) {
        throw expectedToolError('invalid_argument', 'The Runtime content stream yielded a non-byte chunk.');
      }
      if (chunk.byteLength > RESULT_FILE_MAX_BYTES - sizeBytes) {
        throw expectedToolError('limit', 'The Runtime result exceeds the 64 MiB materialization limit.');
      }
      await writeAll(handle, chunk);
      hash.update(chunk);
      sizeBytes += chunk.byteLength;
    }
    assertActive(boundary.signal, boundary.deadline);
    await handle.sync();
    await handle.close();
    handle = undefined;
    const actualChecksum = hash.digest('hex');
    if (sizeBytes !== opened.byteSize) {
      throw expectedToolError('external', 'The Runtime result size changed during materialization.', {
        outcome: 'not_applied',
      });
    }
    if (actualChecksum !== checksum) {
      throw expectedToolError('external', 'The Runtime result checksum changed during materialization.', {
        outcome: 'not_applied',
      });
    }
    await link(partialPath, finalPath);
    await unlink(partialPath);
    published = true;
    return Object.freeze({
      contentRef: opened.contentRef,
      fileName,
      contentType: opened.contentType,
      sizeBytes,
      checksum,
    });
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    try { reader.releaseLock(); } catch { /* A cancellation-raced read still owns the lock. */ }
    await handle?.close().catch(() => undefined);
    await unlink(partialPath).catch(() => undefined);
    if (!published) await unlink(finalPath).catch(() => undefined);
  }
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = await handle.write(bytes, offset, bytes.byteLength - offset, null);
    if (written.bytesWritten < 1) throw new Error('Runtime result materialization made no write progress.');
    offset += written.bytesWritten;
  }
}

async function readWithBoundary(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  boundary: Readonly<{ signal: AbortSignal; deadline?: string }>,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const deadlineAt = parseDeadline(boundary.deadline);
  return await new Promise((resolvePromise, rejectPromise) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      boundary.signal.removeEventListener('abort', abort);
      callback();
    };
    const abort = (): void => finish(() => rejectPromise(abortError()));
    if (boundary.signal.aborted) return abort();
    boundary.signal.addEventListener('abort', abort, { once: true });
    if (deadlineAt !== undefined) {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) {
        return finish(() => rejectPromise(expectedToolError('limit', 'Result materialization deadline expired.', { retryable: true })));
      }
      timer = setTimeout(
        () => finish(() => rejectPromise(expectedToolError('limit', 'Result materialization deadline expired.', { retryable: true }))),
        remaining,
      );
      timer.unref?.();
    }
    void reader.read().then(
      (value) => finish(() => resolvePromise(value)),
      (error) => finish(() => rejectPromise(error instanceof Error ? error : new Error('Result materialization stream read failed.'))),
    );
  });
}

async function writeManifest(runPath: string, manifest: RunManifest): Promise<void> {
  const line = `${JSON.stringify(manifest)}\n`;
  if (Buffer.byteLength(line, 'utf8') > MANIFEST_MAX_BYTES) {
    throw expectedToolError('limit', 'Runtime materialization metadata exceeds its limit.');
  }
  const temporary = containedChild(runPath, `.manifest-${randomUUID()}`);
  const target = containedChild(runPath, MANIFEST_NAME);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(line, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function loadRunDirectory(path: string, directoryId: string): Promise<RunDirectory> {
  const manifestPath = containedChild(path, MANIFEST_NAME);
  const info = await lstat(manifestPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MANIFEST_MAX_BYTES) {
    throw new Error('Invalid result materialization manifest.');
  }
  const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
  const manifest = parseManifest(parsed, directoryId);
  return Object.freeze({ path, manifest });
}

function parseManifest(value: unknown, directoryId: string): RunManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.directoryId !== directoryId ||
    !isRecord(value.owner) || !Array.isArray(value.entries)) {
    throw new Error('Invalid result materialization manifest.');
  }
  const owner = normalizeOwner(value.owner as ContentAccessScope);
  const entries = value.entries.map((entry) => {
    if (!isRecord(entry) || typeof entry.contentRef !== 'string' ||
      typeof entry.fileName !== 'string' || !isMaterializedFileName(entry.fileName) ||
      typeof entry.contentType !== 'string' || entry.contentType.length < 1 ||
      typeof entry.sizeBytes !== 'number' || !Number.isSafeInteger(entry.sizeBytes) ||
      entry.sizeBytes < 0 || entry.sizeBytes > RESULT_FILE_MAX_BYTES ||
      typeof entry.checksum !== 'string') {
      throw new Error('Invalid result materialization entry.');
    }
    return Object.freeze({
      contentRef: entry.contentRef,
      fileName: entry.fileName,
      contentType: entry.contentType,
      sizeBytes: entry.sizeBytes,
      checksum: normalizeChecksum(entry.checksum),
    });
  });
  if (new Set(entries.map((entry) => entry.contentRef)).size !== entries.length ||
    new Set(entries.map((entry) => entry.fileName)).size !== entries.length) {
    throw new Error('Duplicate result materialization entry.');
  }
  return Object.freeze({ schemaVersion: 1, directoryId, owner, entries: Object.freeze(entries) });
}

async function verifyRunDirectory(run: RunDirectory): Promise<boolean> {
  const expected = new Set([MANIFEST_NAME, ...run.manifest.entries.map((entry) => entry.fileName)]);
  const entries = await readdir(run.path, { withFileTypes: true }).catch(() => []);
  if (entries.some((entry) => !expected.has(entry.name) || !entry.isFile())) return false;
  for (const entry of run.manifest.entries) {
    if (!await verifyEntry(run.path, entry)) return false;
  }
  return true;
}

async function verifyEntry(runPath: string, entry: ManifestEntry): Promise<boolean> {
  try {
    const path = containedChild(runPath, entry.fileName);
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size !== entry.sizeBytes) return false;
    const hash = createHash('sha256');
    let sizeBytes = 0;
    for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
      const bytes = chunk as Buffer;
      if (bytes.byteLength > RESULT_FILE_MAX_BYTES - sizeBytes) return false;
      hash.update(bytes);
      sizeBytes += bytes.byteLength;
    }
    const after = await stat(path);
    return before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
      sizeBytes === entry.sizeBytes && hash.digest('hex') === entry.checksum;
  } catch {
    return false;
  }
}

function materializedPayload(
  projectRoot: string,
  runPath: string,
  entry: ManifestEntry,
): MaterializedResultFile {
  const absolutePath = containedChild(runPath, entry.fileName);
  const temporaryPath = relative(projectRoot, absolutePath).split(sep).join('/');
  if (temporaryPath === '' || temporaryPath === '..' || temporaryPath.startsWith('../') || isAbsolute(temporaryPath)) {
    throw new Error('Runtime materialization escaped the project root.');
  }
  return Object.freeze({
    contentRef: entry.contentRef,
    temporaryPath,
    contentType: entry.contentType,
    sizeBytes: entry.sizeBytes,
    digest: `sha256:${entry.checksum}`,
    lifecycle: 'run',
  });
}

function normalizeOwner(value: ContentAccessScope): ResultMaterializationOwner {
  if (!isRecord(value) || typeof value.hostId !== 'string' || value.hostId.length < 1 ||
    typeof value.projectId !== 'string' || value.projectId.length < 1 ||
    typeof value.sessionId !== 'string' || value.sessionId.length < 1 ||
    typeof value.runId !== 'string' || value.runId.length < 1) {
    throw expectedToolError('invalid_argument', 'Runtime result owner scope is invalid.');
  }
  return Object.freeze({
    hostId: value.hostId,
    projectId: value.projectId,
    sessionId: value.sessionId,
    runId: value.runId,
  });
}

function ownerKey(owner: ResultMaterializationOwner): string {
  return `${owner.hostId}\0${owner.projectId}\0${owner.sessionId}\0${owner.runId}`;
}

function normalizeChecksum(value: string): string {
  const match = CHECKSUM_PATTERN.exec(value);
  if (match === null) throw expectedToolError('precondition', 'Runtime content checksum is invalid.');
  return match[1]!;
}

function extensionFor(contentType: string): string {
  const mediaType = contentType.split(';', 1)[0]!.trim().toLowerCase();
  if (mediaType === 'application/x-ndjson' || mediaType === 'application/ndjson') return '.ndjson';
  if (mediaType === 'application/json' || mediaType.endsWith('+json')) return '.json';
  if (mediaType.startsWith('text/')) return '.txt';
  return '.bin';
}

function isOpaqueRunDirectory(value: string): boolean {
  return /^run-[a-f0-9-]{36}$/u.test(value);
}

function isMaterializedFileName(value: string): boolean {
  return /^content-[a-f0-9]{32}\.(?:ndjson|json|txt|bin)$/u.test(value);
}

function containedChild(parent: string, name: string): string {
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new Error('Invalid Runtime materialization entry name.');
  }
  const child = resolve(parent, name);
  assertContained(parent, child);
  return child;
}

function assertContained(parent: string, child: string): void {
  const rel = relative(resolve(parent), resolve(child));
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new TypeError('Runtime materialization root must stay inside the project root.');
  }
}

async function ensureMaterializationRoot(
  projectRoot: string,
  rootDirectory: string,
): Promise<MaterializationRootGuard> {
  const rel = relative(projectRoot, rootDirectory);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new TypeError('Runtime materialization root must stay strictly inside the project root.');
  }
  const projectInfo = await lstat(projectRoot);
  if (projectInfo.isSymbolicLink() || !projectInfo.isDirectory()) {
    throw expectedToolError('precondition', 'The Runtime project root must be a real directory.');
  }
  const directories: DirectoryIdentity[] = [directoryIdentity(projectRoot, projectInfo)];
  let parent = projectRoot;
  for (const segment of rel.split(sep)) {
    parent = containedChild(parent, segment);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(parent);
    } catch (error) {
      if (!isFileSystemError(error, 'ENOENT')) throw error;
      try {
        await mkdir(parent, { mode: 0o700 });
      } catch (mkdirError) {
        // A concurrent Runtime or config watcher may have created this exact
        // segment after lstat reported ENOENT. Re-read it below so the usual
        // real-directory, non-link and identity checks still decide whether it
        // is safe to use.
        if (!isFileSystemError(mkdirError, 'EEXIST')) throw mkdirError;
      }
      info = await lstat(parent);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw expectedToolError(
        'precondition',
        'Runtime materialization directories cannot be symbolic links, junctions, or files.',
      );
    }
    directories.push(directoryIdentity(parent, info));
  }
  const canonicalRoot = await realpath(rootDirectory);
  assertContained(projectRoot, canonicalRoot);
  return Object.freeze({ canonicalRoot, directories: Object.freeze(directories) });
}

async function assertRootGuardCurrent(guard: MaterializationRootGuard): Promise<void> {
  for (const expected of guard.directories) {
    const current = await lstat(expected.path);
    if (current.isSymbolicLink() || !current.isDirectory() ||
      current.dev !== expected.device || current.ino !== expected.inode) {
      throw expectedToolError(
        'precondition',
        'Runtime materialization directories changed after initialization.',
      );
    }
  }
  if (await realpath(guard.canonicalRoot) !== guard.canonicalRoot) {
    throw expectedToolError(
      'precondition',
      'Runtime materialization root changed after initialization.',
    );
  }
}

function directoryIdentity(
  path: string,
  info: Awaited<ReturnType<typeof lstat>>,
): DirectoryIdentity {
  return Object.freeze({ path, device: info.dev, inode: info.ino });
}

async function removeDirectory(guard: MaterializationRootGuard, path: string): Promise<boolean> {
  try {
    await assertRootGuardCurrent(guard);
    assertContained(guard.canonicalRoot, path);
    const info = await lstat(path).catch((error) => {
      if (isFileSystemError(error, 'ENOENT')) return undefined;
      throw error;
    });
    if (info === undefined) return true;
    if (info.isSymbolicLink()) {
      await unlink(path);
      return true;
    }
    await rm(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 });
    return true;
  } catch {
    return false;
  }
}

function assertActive(signal: AbortSignal, deadline: string | undefined): void {
  if (signal.aborted) throw abortError();
  const deadlineAt = parseDeadline(deadline);
  if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
    throw expectedToolError('limit', 'Result materialization deadline expired.', { retryable: true });
  }
}

function parseDeadline(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw expectedToolError('precondition', 'The prepared result deadline is invalid.');
  return parsed;
}

function abortError(): Error {
  const error = new Error('Result materialization was cancelled.');
  error.name = 'AbortError';
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && !Array.isArray(value) && typeof value === 'object';
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}
