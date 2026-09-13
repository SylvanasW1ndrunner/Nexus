import { createHash } from 'node:crypto';
import {
  constants,
  link,
  lstat,
  open,
  realpath,
  stat,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { expectedToolError } from '@dbagent/core-agent';
import type { PortableValue } from '@dbagent/shared';
import type {
  WorkspaceMutationJournal,
  WorkspaceMutationPrimitive,
  WorkspaceMutationSnapshot,
  WorkspaceParentMutationFence,
} from './workspace-mutation-adapter.js';

const MAX_MUTATION_FILE_BYTES = 8 * 1024 * 1024;
const MAX_STREAM_MUTATION_FILE_BYTES = 64 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 256 * 1024;
const TOKEN_PROTOCOL = 'node-workspace-parent.v1';
const IDENTITY_PROTOCOL = 'node-fs-entry.v1';

type ParentToken = Readonly<{ protocol: typeof TOKEN_PROTOCOL; path: string }>;
type EntryIdentity = Readonly<{
  protocol: typeof IDENTITY_PROTOCOL;
  device: string;
  inode: string;
}>;

/**
 * Local Node filesystem implementation for the Core Tools no-replace mutation
 * state machine. Every operation revalidates the canonical parent identity;
 * exclusive create and hard-link publication prevent pathname replacement.
 */
export function createNodeWorkspaceMutationPrimitive(): WorkspaceMutationPrimitive {
  const primitive: WorkspaceMutationPrimitive = Object.freeze({
    revision: 'node-local-fs.v1',
    protocol: 'revalidated-parent-no-replace.v1',
    sameIdentity(left, right) {
      const leftIdentity = parseIdentity(left);
      const rightIdentity = parseIdentity(right);
      return leftIdentity !== undefined && rightIdentity !== undefined &&
        leftIdentity.device === rightIdentity.device && leftIdentity.inode === rightIdentity.inode;
    },
    async bind(input) {
      throwIfAborted(input.signal);
      const rootPath = await realpath(resolve(input.rootPath));
      const requested = resolve(rootPath, input.requestedPath);
      const requestedParent = dirname(requested);
      const parentPath = await realpath(requestedParent);
      const parentStats = await stat(parentPath, { bigint: true });
      if (!parentStats.isDirectory()) throw expectedToolError('precondition', 'The workspace mutation parent is not a directory.');
      const entryName = basename(requested);
      validateEntryName(entryName);
      const canonicalPath = join(parentPath, entryName);
      const workspaceRelative = relative(rootPath, canonicalPath);
      const insideWorkspace = workspaceRelative === '' ||
        !(workspaceRelative === '..' || workspaceRelative.startsWith(`..${sep}`) || isAbsolute(workspaceRelative));
      return Object.freeze({
        canonicalPath,
        displayPath: insideWorkspace ? workspaceRelative || entryName : canonicalPath,
        insideWorkspace,
        parentToken: Object.freeze({ protocol: TOKEN_PROTOCOL, path: parentPath }),
        parentIdentity: entryIdentity(parentStats),
        entryName,
      });
    },
    async withParent(parentToken, parentIdentity, signal, operation) {
      throwIfAborted(signal);
      const token = parseParentToken(parentToken);
      const expectedIdentity = requireIdentity(parentIdentity, 'workspace parent');
      await assertParentIdentity(token.path, expectedIdentity);
      const fence = createParentFence(token.path, expectedIdentity);
      const result = await operation(fence);
      throwIfAborted(signal);
      await assertParentIdentity(token.path, expectedIdentity);
      return result;
    },
  });
  return primitive;
}

function createParentFence(parentPath: string, parentIdentity: EntryIdentity): WorkspaceParentMutationFence {
  const pathFor = (name: string): string => {
    validateEntryName(name);
    return join(parentPath, name);
  };
  return Object.freeze({
    inspect: async (name, options) => inspectRegularFile(pathFor(name), options),
    async writeExclusive(name, bytes, signal) {
      throwIfAborted(signal);
      if (bytes.byteLength > MAX_MUTATION_FILE_BYTES) throw expectedToolError('limit', 'The workspace mutation file exceeds 8 MiB.');
      const path = pathFor(name);
      const handle = await open(path, 'wx', 0o600);
      let operationError: Error | undefined;
      try {
        await handle.writeFile(bytes);
        throwIfAborted(signal);
        await handle.sync();
      } catch (error) {
        operationError = error instanceof Error ? error : new Error('Workspace mutation write failed.');
      }
      const cleanupErrors: Error[] = [];
      try {
        await handle.close();
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error : new Error('Workspace mutation cleanup failed.'));
      }
      if (operationError !== undefined || cleanupErrors.length > 0) {
        try {
          await unlink(path);
        } catch (error) {
          if (!isFileSystemError(error, 'ENOENT')) {
            cleanupErrors.push(error instanceof Error ? error : new Error('Workspace mutation cleanup failed.'));
          }
        }
      }
      if (operationError !== undefined) {
        if (cleanupErrors.length === 0) throw operationError;
        throw new AggregateError([operationError, ...cleanupErrors], 'Workspace mutation write and cleanup did not both complete.');
      }
      if (cleanupErrors.length === 1) {
        const cleanupError = cleanupErrors[0];
        if (cleanupError !== undefined) throw cleanupError;
      }
      if (cleanupErrors.length > 1) {
        throw new AggregateError(cleanupErrors, 'Workspace mutation write and cleanup did not both complete.');
      }
    },
    async writeExclusiveStream(name, source, options) {
      throwIfAborted(options.signal);
      const maximum = boundedStreamBytes(options.maxBytes);
      const streamDeadlineAt = parseDeadline(options.deadline);
      throwIfDeadline(streamDeadlineAt);
      const path = pathFor(name);
      const reader = source.getReader();
      const hash = createHash('sha256');
      let handle: FileHandle | undefined;
      let sizeBytes = 0;
      let completed = false;
      let operationError: Error | undefined;
      let result: Readonly<{ digest: string; sizeBytes: number }> | undefined;
      try {
        handle = await open(path, 'wx', 0o600);
        for (;;) {
          throwIfAborted(options.signal);
          throwIfDeadline(streamDeadlineAt);
          const next = await readStreamChunk(reader, options.signal, streamDeadlineAt);
          throwIfAborted(options.signal);
          throwIfDeadline(streamDeadlineAt);
          if (next.done) break;
          const chunk = next.value;
          if (!(chunk instanceof Uint8Array)) throw expectedToolError('invalid_argument', 'The workspace mutation stream yielded a non-byte chunk.');
          if (chunk.byteLength > maximum - sizeBytes) throw expectedToolError('limit', 'The workspace mutation stream exceeds its byte limit.');
          await handle.writeFile(chunk);
          hash.update(chunk);
          sizeBytes += chunk.byteLength;
        }
        throwIfAborted(options.signal);
        throwIfDeadline(streamDeadlineAt);
        await handle.sync();
        throwIfAborted(options.signal);
        throwIfDeadline(streamDeadlineAt);
        completed = true;
        result = Object.freeze({ digest: `sha256:${hash.digest('hex')}`, sizeBytes });
      } catch (error) {
        operationError = error instanceof Error ? error : new Error('Workspace mutation stream write failed.');
      }
      const cleanupErrors: Error[] = [];
      if (operationError !== undefined) {
        try {
          await reader.cancel(operationError);
        } catch (error) {
          cleanupErrors.push(error instanceof Error ? error : new Error('Workspace mutation stream cleanup failed.'));
        }
      }
      try {
        reader.releaseLock();
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error : new Error('Workspace mutation stream cleanup failed.'));
      }
      try {
        await handle?.close();
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error : new Error('Workspace mutation stream cleanup failed.'));
      }
      if (handle !== undefined && (!completed || cleanupErrors.length > 0)) {
        try {
          await unlink(path);
        } catch (error) {
          if (!isFileSystemError(error, 'ENOENT')) {
            cleanupErrors.push(error instanceof Error ? error : new Error('Workspace mutation stream cleanup failed.'));
          }
        }
      }
      if (operationError !== undefined) {
        if (cleanupErrors.length === 0) throw operationError;
        throw new AggregateError(
          [operationError, ...cleanupErrors],
          'Workspace mutation stream write and cleanup did not both complete.',
        );
      }
      if (cleanupErrors.length === 1) {
        const cleanupError = cleanupErrors[0];
        if (cleanupError !== undefined) throw cleanupError;
      }
      if (cleanupErrors.length > 1) {
        throw new AggregateError(cleanupErrors, 'Workspace mutation stream write and cleanup did not both complete.');
      }
      if (result === undefined) throw new Error('Workspace mutation stream write did not produce a result.');
      return result;
    },
    async moveNoReplace(sourceName, targetName) {
      const sourcePath = pathFor(sourceName);
      const targetPath = pathFor(targetName);
      await link(sourcePath, targetPath);
      try {
        await unlink(sourcePath);
      } catch (error) {
        await unlink(targetPath).catch(() => undefined);
        throw error;
      }
    },
    async linkNoReplace(sourceName, targetName) {
      await link(pathFor(sourceName), pathFor(targetName));
    },
    async unlink(name) {
      try {
        await unlink(pathFor(name));
      } catch (error) {
        if (!isFileSystemError(error, 'ENOENT')) throw error;
      }
    },
    async readJournal(name) {
      return readJournal(pathFor(name));
    },
    async writeJournal(name, expectedPhase, journal) {
      const path = pathFor(name);
      const line = `${JSON.stringify(journal)}\n`;
      if (Buffer.byteLength(line, 'utf8') > MAX_JOURNAL_BYTES) {
        throw expectedToolError('limit', 'The workspace mutation Journal entry is too large.');
      }
      if (expectedPhase === 'missing') {
        const handle = await open(path, 'wx', 0o600);
        try {
          await handle.writeFile(line, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        return;
      }
      const handle = await openNoFollow(path, 'r+');
      try {
        const before = await handle.stat({ bigint: true });
        ensureRegularFile(before);
        const current = parseJournalLog(await handle.readFile({ encoding: 'utf8' }));
        if (current.phase !== expectedPhase) throw expectedToolError('conflict', 'The workspace mutation Journal phase changed.');
        const afterRead = await handle.stat({ bigint: true });
        if (!sameEntryStats(before, afterRead)) throw expectedToolError('conflict', 'The workspace mutation Journal identity changed.');
        const bytes = Buffer.from(line, 'utf8');
        if (afterRead.size + BigInt(bytes.byteLength) > BigInt(MAX_JOURNAL_BYTES)) {
          throw expectedToolError('limit', 'The workspace mutation Journal is too large.');
        }
        await handle.write(bytes, 0, bytes.byteLength, Number(afterRead.size));
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    async sync() {
      await assertParentIdentity(parentPath, parentIdentity);
      let handle: FileHandle | undefined;
      try {
        handle = await open(parentPath, 'r');
        await handle.sync();
      } catch (error) {
        if (!isUnsupportedDirectorySync(error)) throw error;
      } finally {
        await handle?.close();
      }
    },
  });
}

async function inspectRegularFile(
  path: string,
  options: { includeContent?: boolean; maxBytes?: number } = {},
): Promise<WorkspaceMutationSnapshot | undefined> {
  let pathStats: BigIntStats;
  try {
    pathStats = await lstat(path, { bigint: true });
  } catch (error) {
    if (isFileSystemError(error, 'ENOENT')) return undefined;
    throw error;
  }
  if (pathStats.isSymbolicLink()) throw expectedToolError('precondition', 'Symbolic links and reparse points cannot be workspace mutation targets.');
  ensureRegularFile(pathStats);
  const handle = await openNoFollow(path, 'r');
  try {
    const openedStats = await handle.stat({ bigint: true });
    ensureRegularFile(openedStats);
    if (!sameEntryStats(pathStats, openedStats)) throw expectedToolError('conflict', 'The workspace mutation target changed while it was opened.');
    const maximum = options.maxBytes ?? MAX_MUTATION_FILE_BYTES;
    const readableMaximum = options.includeContent === true ? Math.min(maximum, MAX_MUTATION_FILE_BYTES) : maximum;
    if (openedStats.size > BigInt(readableMaximum) || openedStats.size > BigInt(MAX_STREAM_MUTATION_FILE_BYTES)) {
      throw expectedToolError('limit', 'The workspace mutation target exceeds the readable file limit.');
    }
    const content = options.includeContent === true ? await handle.readFile() : undefined;
    const digest = content === undefined
      ? await digestOpenFile(handle, Number(openedStats.size))
      : `sha256:${createHash('sha256').update(content).digest('hex')}`;
    const afterRead = await handle.stat({ bigint: true });
    if (!sameEntryStats(openedStats, afterRead) || openedStats.size !== afterRead.size || openedStats.mtimeNs !== afterRead.mtimeNs) {
      throw expectedToolError('conflict', 'The workspace mutation target changed while it was read.');
    }
    return Object.freeze({
      identity: entryIdentity(openedStats),
      digest,
      sizeBytes: Number(openedStats.size),
      ...(content === undefined ? {} : { content: new Uint8Array(content) }),
    });
  } finally {
    await handle.close();
  }
}

async function digestOpenFile(handle: FileHandle, sizeBytes: number): Promise<string> {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, sizeBytes));
  let offset = 0;
  while (offset < sizeBytes) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.byteLength, sizeBytes - offset), offset);
    if (bytesRead === 0) throw expectedToolError('conflict', 'The workspace mutation target changed while it was read.');
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return `sha256:${hash.digest('hex')}`;
}

async function readJournal(path: string): Promise<WorkspaceMutationJournal | undefined> {
  let handle: FileHandle;
  try {
    handle = await openNoFollow(path, 'r');
  } catch (error) {
    if (isFileSystemError(error, 'ENOENT')) return undefined;
    throw error;
  }
  try {
    const stats = await handle.stat({ bigint: true });
    ensureRegularFile(stats);
    if (stats.size > BigInt(MAX_JOURNAL_BYTES)) throw expectedToolError('limit', 'The workspace mutation Journal is too large.');
    return parseJournalLog(await handle.readFile({ encoding: 'utf8' }));
  } finally {
    await handle.close();
  }
}

function parseJournalLog(value: string): WorkspaceMutationJournal {
  const lines = value.split('\n').filter(line => line.trim() !== '');
  const line = lines.at(-1);
  if (line === undefined) throw expectedToolError('precondition', 'The workspace mutation Journal is empty.');
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { throw expectedToolError('precondition', 'The workspace mutation Journal is invalid.'); }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw expectedToolError('precondition', 'The workspace mutation Journal entry is invalid.');
  }
  const journal = parsed as Partial<WorkspaceMutationJournal>;
  if (journal.protocol !== 'workspace-mutation-journal.v1' || typeof journal.transactionName !== 'string' ||
    (journal.action !== 'create' && journal.action !== 'update' && journal.action !== 'delete') ||
    !isJournalPhase(journal.phase) || (journal.streamed !== undefined && journal.streamed !== true)) {
    throw expectedToolError('precondition', 'The workspace mutation Journal entry is invalid.');
  }
  return journal as WorkspaceMutationJournal;
}

async function openNoFollow(path: string, flags: string): Promise<FileHandle> {
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const base = flags === 'r' ? constants.O_RDONLY : constants.O_RDWR;
  return open(path, base | noFollow);
}

async function assertParentIdentity(path: string, expected: EntryIdentity): Promise<void> {
  const current = await stat(path, { bigint: true });
  if (!current.isDirectory() || !sameIdentityValue(entryIdentity(current), expected)) {
    throw expectedToolError('conflict', 'The workspace mutation parent directory identity changed.');
  }
}

function entryIdentity(stats: BigIntStats): EntryIdentity {
  return Object.freeze({
    protocol: IDENTITY_PROTOCOL,
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
  });
}

function parseIdentity(value: PortableValue): EntryIdentity | undefined {
  if (value === null || Array.isArray(value) || typeof value !== 'object') return undefined;
  const record = value as Record<string, PortableValue>;
  return record.protocol === IDENTITY_PROTOCOL && typeof record.device === 'string' && typeof record.inode === 'string'
    ? { protocol: IDENTITY_PROTOCOL, device: record.device, inode: record.inode }
    : undefined;
}

function requireIdentity(value: PortableValue, label: string): EntryIdentity {
  const identity = parseIdentity(value);
  if (identity === undefined) throw expectedToolError('precondition', `The ${label} identity is invalid.`);
  return identity;
}

function parseParentToken(value: PortableValue): ParentToken {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw expectedToolError('precondition', 'The workspace parent token is invalid.');
  }
  const record = value as Record<string, PortableValue>;
  if (record.protocol !== TOKEN_PROTOCOL || typeof record.path !== 'string' || !isAbsolute(record.path)) {
    throw expectedToolError('precondition', 'The workspace parent token is invalid.');
  }
  return { protocol: TOKEN_PROTOCOL, path: record.path };
}

function validateEntryName(name: string): void {
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw expectedToolError('invalid_argument', 'The workspace mutation entry name is invalid.');
  }
}

function ensureRegularFile(stats: BigIntStats): void {
  if (!stats.isFile()) throw expectedToolError('precondition', 'Workspace mutations only support regular files.');
}

function sameEntryStats(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameIdentityValue(left: EntryIdentity, right: EntryIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function isJournalPhase(value: unknown): value is WorkspaceMutationJournal['phase'] {
  return value === 'prepared' || value === 'temporary_ready' || value === 'target_backed_up' ||
    value === 'published' || value === 'committed' || value === 'rolled_back';
}

function boundedStreamBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw expectedToolError('invalid_argument', 'The workspace mutation stream byte limit is invalid.');
  }
  return Math.min(value, MAX_STREAM_MUTATION_FILE_BYTES);
}

function parseDeadline(deadline: string | undefined): number | undefined {
  if (deadline === undefined) return undefined;
  const value = Date.parse(deadline);
  if (!Number.isFinite(value)) throw expectedToolError('invalid_argument', 'The workspace mutation stream deadline is invalid.');
  return value;
}

function throwIfDeadline(value: number | undefined): void {
  if (value !== undefined && Date.now() >= value) {
    throw expectedToolError('limit', 'The workspace mutation stream deadline expired.', { retryable: true });
  }
}

function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  deadline: number | undefined,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      callback();
    };
    const abort = () => finish(() => reject(abortError()));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    if (deadline !== undefined) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return finish(() => reject(expectedToolError('limit', 'The workspace mutation stream deadline expired.', { retryable: true })));
      timer = setTimeout(() => finish(() => reject(expectedToolError('limit', 'The workspace mutation stream deadline expired.', { retryable: true }))), remaining);
    }
    void reader.read().then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error instanceof Error ? error : new Error('Workspace mutation stream read failed.'))),
    );
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw abortError();
}

function abortError(): Error {
  const error = new Error('Workspace mutation was cancelled.');
  error.name = 'AbortError';
  return error;
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error !== null && typeof error === 'object' && 'code' in error &&
    (error as { code?: unknown }).code === code;
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  return ['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].some(code => isFileSystemError(error, code));
}
