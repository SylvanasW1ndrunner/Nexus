import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { mkdir, mkdtemp, open, rm, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { expectedToolError } from '@dbagent/core-agent';
import type { PortableValue } from '@dbagent/shared';
import { inspectValidatedEntry, revalidateEntries, walkValidatedDirectory, type ValidatedEntry } from './workspace-directory-portable-adapter.js';

const CURSOR_TTL_MS = 5 * 60_000;
const MAX_CAPTURED_MATCHES = 1_001;
const MAX_STDERR_BYTES = 32 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const MAX_RESULT_SETS = 32;
const MAX_RESULT_SETS_PER_OWNER = 4;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_BYTES_PER_OWNER = 8 * 1024 * 1024;
const TERMINATION_CLOSE_MS = 2_000;

export type WorkspaceSearchMode = 'literal' | 'regex';
export type WorkspaceBinaryMode = 'exclude' | 'include';

export type WorkspaceSearchRequest = Readonly<{
  targetPath: string;
  targetIdentity: PortableValue;
  relativePath: string;
  ownerKey: string;
  query: string;
  mode: WorkspaceSearchMode;
  caseSensitive: boolean;
  binary: WorkspaceBinaryMode;
  globs: readonly string[];
  maxFiles: number;
  maxScanBytes: number;
  maxResults: number;
  maxOutputBytes: number;
  timeoutMs: number;
  after?: string;
  signal: AbortSignal;
}>;

export type WorkspaceSearchMatch = Readonly<{
  canonicalPath: string;
  line: number;
  byteColumn: number;
  text: string;
  match: string;
  digest: string;
  identity: PortableValue;
  key: string;
}>;

export type WorkspaceSearchResult = Readonly<{
  status: 'ok' | 'unavailable';
  reason?: string;
  matches: readonly WorkspaceSearchMatch[];
  scannedFiles: number;
  scannedBytes: number;
  truncated: boolean;
  truncationReasons: readonly string[];
}>;

/** A certified backend must bind match text, identity and digest to one snapshot. */
export type WorkspaceSearchBackend = Readonly<{
  revision: string;
  snapshotProtocol: 'workspace-search-snapshot.v1';
  targets: 'file' | 'file-and-directory';
  revalidate(path: string, identity: PortableValue, signal: AbortSignal): Promise<boolean>;
  search(request: WorkspaceSearchRequest): Promise<WorkspaceSearchResult>;
  drain(): Promise<void>;
}>;

export type RipgrepWorkspaceSearchOptions = Readonly<{ executable?: string; revision?: string }>;

type CapturedResultSet = Readonly<{
  createdAt: number;
  expiresAt: number;
  ownerKey: string;
  targetIdentityKey: string;
  retainedBytes: number;
  matches: readonly WorkspaceSearchMatch[];
  scannedFiles: number;
  scannedBytes: number;
  baseReasons: readonly string[];
  validation: readonly ValidatedEntry[];
}>;

/**
 * Copies checked read-only entries from validated FileHandles, hashes those exact
 * bytes, then runs rg only over the private snapshot. Directory traversal uses
 * optimistic before/after identity validation, not an atomic mutation fence.
 */
export function createRipgrepWorkspaceSearchBackend(options: RipgrepWorkspaceSearchOptions = {}): WorkspaceSearchBackend {
  const executable = options.executable;
  const resultSets = new Map<string, CapturedResultSet>();
  const activeOperations = new Set<Promise<unknown>>();
  let cleanupFailed = false;
  let draining = false;
  const managed = <T>(timeoutMs: number, signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (draining) return Promise.reject(expectedToolError('precondition', 'The workspace search generation is draining.'));
    const controller = new AbortController();
    // Track the real operation, including late filesystem completion and cleanup.
    // The bounded caller Promise is deliberately not the generation lease owner.
    const actual = Promise.resolve().then(() => { throwIfAborted(controller.signal); return operation(controller.signal); });
    activeOperations.add(actual);
    void actual.then(() => activeOperations.delete(actual), () => activeOperations.delete(actual));
    return awaitWithin(actual, timeoutMs, signal, controller);
  };
  return Object.freeze({
    revision: options.revision ?? 'ripgrep.workspace-search.v3',
    snapshotProtocol: 'workspace-search-snapshot.v1' as const,
    targets: 'file-and-directory' as const,
    async drain() {
      draining = true;
      while (activeOperations.size > 0) await Promise.allSettled([...activeOperations]);
      resultSets.clear();
      if (cleanupFailed) throw expectedToolError('external', 'Workspace search cleanup could not be confirmed.', { outcome: 'unknown' });
    },
    async revalidate(path, identity, signal) {
      return managed(30_000, signal, async (signal) => {
      throwIfAborted(signal);
      try {
        return samePortableIdentity(await inspectValidatedEntry(path), identity);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
      });
    },
    async search(request) {
      return managed(request.timeoutMs, request.signal, async (signal) => {
      request = { ...request, signal };
      const activeProcesses = new Set<Promise<void>>();
      prune(resultSets);
      const continuation = decodeBackendCursor(request.after);
      if (continuation !== undefined) {
        const captured = resultSets.get(continuation.id);
        if (captured === undefined || captured.expiresAt <= Date.now()) {
          throw expectedToolError('invalid_argument', 'The workspace search cursor expired.');
        }
        if (captured.ownerKey !== request.ownerKey || captured.targetIdentityKey !== identityKey(request.targetIdentity)) {
          throw expectedToolError('invalid_argument', 'The workspace search cursor belongs to another owner or target snapshot.');
        }
        await revalidateEntries(captured.validation, request.signal, Date.now() + request.timeoutMs);
        return page(captured, continuation.offset, request.maxResults);
      }

      throwIfAborted(request.signal);
      const deadlineAt = Date.now() + request.timeoutMs;
      if (isAbsolute(request.relativePath) || request.relativePath.replace(/\\/gu, '/').split('/').includes('..')) {
        throw expectedToolError('precondition', 'Workspace search snapshot requires a workspace-relative target.');
      }
      const snapshotDirectory = await mkdtemp(join(tmpdir(), 'schemanaut-rg-'));
      const snapshotPath = join(snapshotDirectory, ...request.relativePath.split('/'));
      let handle: FileHandle | undefined;
      try {
        throwIfAborted(request.signal); throwIfDeadline(deadlineAt);
        await mkdir(dirname(snapshotPath), { recursive: true });
        throwIfAborted(request.signal); throwIfDeadline(deadlineAt);
        const before = await inspectValidatedEntry(request.targetPath);
        const beforeRecord = before as Record<string, PortableValue>;
        if (beforeRecord.type !== 'file' && beforeRecord.type !== 'directory') throw expectedToolError('precondition', 'Workspace search requires a regular file or directory.');
        if (!samePortableIdentity(before, request.targetIdentity)) throw expectedToolError('conflict', 'The prepared search file changed.');
        const files = new Map<string, { path: string; identity: PortableValue; digest: string }>();
        const validation: ValidatedEntry[] = [{ path: request.targetPath, identity: before }];
        const baseReasons = new Set<string>(); let scannedFiles = 0; let scannedBytes = 0;
        const copyFile = async (entry: ValidatedEntry): Promise<boolean> => {
          const record = entry.identity as Record<string, PortableValue>;
          if (record.type !== 'file') return true;
          if (scannedFiles >= request.maxFiles) { baseReasons.add('file_limit'); return false; }
          const size = Number(record.sizeBytes);
          if (scannedBytes + size > request.maxScanBytes) { baseReasons.add('byte_limit'); return false; }
          throwIfAborted(request.signal); throwIfDeadline(deadlineAt);
          const target = beforeRecord.type === 'file' ? snapshotPath : join(snapshotPath, relative(request.targetPath, entry.path));
          await mkdir(dirname(target), { recursive: true });
          await revalidateEntries([validation[0]!, entry], request.signal, deadlineAt);
          handle = await open(entry.path, 'r').catch((error) => { throw mapFilesystemError(error); });
          try {
            const opened = portableIdentity(entry.path, await handle.stat({ bigint: true }));
            if (!samePortableIdentity(opened, entry.identity)) throw expectedToolError('conflict', 'target_changed: search file changed before snapshot.');
            const capture = await captureSnapshot(handle, target, size, deadlineAt, request.signal, () => { cleanupFailed = true; });
            if (!samePortableIdentity(portableIdentity(entry.path, await handle.stat({ bigint: true })), entry.identity)) {
              throw expectedToolError('conflict', 'target_changed: search file changed while snapshotting.');
            }
            await revalidateEntries([entry], request.signal, deadlineAt);
            files.set(relative(snapshotDirectory, target).replace(/\\/gu, '/'), { path: entry.path, identity: opened, digest: capture.digest });
            scannedFiles += 1; scannedBytes += capture.bytes;
          } finally { await handle.close().catch(() => { cleanupFailed = true; }); handle = undefined; }
          return true;
        };
        if (beforeRecord.type === 'file') await copyFile(validation[0]!);
        else {
          await mkdir(snapshotPath, { recursive: true });
          const walk = await walkValidatedDirectory(request.targetPath, { maxEntries: Math.min(40_000, request.maxFiles * 4), depth: 64,
            signal: request.signal, deadlineAt, visit: copyFile });
          validation.push(...walk.entries);
          if (walk.truncated && baseReasons.size === 0) baseReasons.add('file_limit');
        }
        await revalidateEntries(validation, request.signal, deadlineAt);
        if (files.size === 0) return { status: 'ok', matches: [], scannedFiles, scannedBytes, truncated: baseReasons.size > 0, truncationReasons: [...baseReasons] };

        const remainingMs = deadlineAt - Date.now();
        if (remainingMs <= 0) return timedOutResult(scannedFiles, scannedBytes);
        const resolvedExecutable = await resolveRipgrepExecutable(executable);
        if (resolvedExecutable === undefined) return unavailable('ripgrep_not_found');
        const run = await runRipgrep(resolvedExecutable, snapshotDirectory, request.relativePath, { ...request, timeoutMs: remainingMs }, activeProcesses);
        throwIfAborted(request.signal); throwIfDeadline(deadlineAt);
        if (run.status === 'unavailable') return unavailable(run.reason);
        const id = randomUUID();
        await revalidateEntries(validation, request.signal, deadlineAt);
        const matches = run.matches.map((match, index) => {
          const file = files.get(match.path.replace(/\\/gu, '/').replace(/^\.\//u, ''));
          if (file === undefined) throw expectedToolError('external', 'Search returned a path outside the captured file set.');
          return Object.freeze({
          canonicalPath: file.path,
          line: match.line,
          byteColumn: match.byteColumn,
          text: match.text,
          match: match.match,
          digest: file.digest,
          identity: file.identity,
          key: backendCursor(id, index + 1),
        }); });
        const captured: CapturedResultSet = Object.freeze({
          createdAt: Date.now(),
          expiresAt: Date.now() + CURSOR_TTL_MS,
          ownerKey: request.ownerKey,
          targetIdentityKey: identityKey(before),
          retainedBytes: retainedBytes(matches) + Buffer.byteLength(JSON.stringify(validation), 'utf8'),
          matches: Object.freeze(matches),
          scannedFiles,
          scannedBytes,
          baseReasons: Object.freeze([...baseReasons, ...run.reasons]),
          validation: Object.freeze(validation),
        });
        reserveResultSet(resultSets, request.ownerKey, captured.retainedBytes);
        resultSets.set(id, captured);
        return page(captured, 0, request.maxResults);
      } finally {
        // A close watchdog can end the bounded invocation, but cannot authorize
        // deleting a snapshot while the real child still owns it (Windows).
        await Promise.allSettled([...activeProcesses]);
        await handle?.close().catch(() => { cleanupFailed = true; });
        await rm(snapshotDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
          .catch(() => { cleanupFailed = true; });
      }
      });
    },
  });
}

/** Loads the npm-selected binary lazily so a missing optional platform package degrades only search. */
async function resolveRipgrepExecutable(executable: string | undefined): Promise<string | undefined> {
  if (executable !== undefined) return executable;
  try {
    return (await import('@vscode/ripgrep')).rgPath;
  } catch {
    return undefined;
  }
}

async function captureSnapshot(handle: FileHandle, path: string, size: number, deadlineAt: number, signal: AbortSignal, cleanupFailed: (error: unknown) => void): Promise<{ digest: string; bytes: number }> {
  const hash = createHash('sha256');
  throwIfAborted(signal); throwIfDeadline(deadlineAt);
  const output = await open(path, 'wx', 0o600);
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  try {
    while (position < size) {
      throwIfAborted(signal); throwIfDeadline(deadlineAt);
      const read = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position);
      if (read.bytesRead === 0) break;
      const chunk = buffer.subarray(0, read.bytesRead);
      hash.update(chunk);
      let written = 0;
      while (written < chunk.length) {
        throwIfAborted(signal); throwIfDeadline(deadlineAt);
        const result = await output.write(chunk, written, chunk.length - written, position + written);
        if (result.bytesWritten === 0) throw expectedToolError('external', 'Workspace search snapshot write made no progress.');
        written += result.bytesWritten;
      }
      position += read.bytesRead;
    }
    throwIfDeadline(deadlineAt);
    if (position !== size) throw expectedToolError('conflict', 'The search file changed while snapshotting.');
    await output.sync();
    throwIfAborted(signal); throwIfDeadline(deadlineAt);
  } finally { await output.close().catch(cleanupFailed); }
  return { digest: `sha256:${hash.digest('hex')}`, bytes: position };
}

async function runRipgrep(
  executable: string,
  snapshotDirectory: string,
  relativePath: string,
  request: WorkspaceSearchRequest,
  activeProcesses: Set<Promise<void>>,
): Promise<
  | { status: 'ok'; matches: Array<{ path: string; line: number; byteColumn: number; text: string; match: string }>; reasons: string[] }
  | { status: 'unavailable'; reason: string }
> {
  const args = ['--json', '--line-number', '--column', '--no-heading', '--no-require-git', '--color', 'never', '--encoding', 'auto',
    request.caseSensitive ? '--case-sensitive' : '--ignore-case'];
  if (request.mode === 'literal') args.push('--fixed-strings');
  if (request.binary === 'include') args.push('--text');
  for (const glob of request.globs) args.push('--glob', glob);
  args.push('--', request.query, relativePath);
  const matches: Array<{ path: string; line: number; byteColumn: number; text: string; match: string }> = [];
  const reasons = new Set<string>();
  const result = await runProcess(executable, args, {
    cwd: snapshotDirectory, signal: request.signal, timeoutMs: request.timeoutMs, activeProcesses,
    maxStdoutBytes: request.maxOutputBytes,
    onLine(line, stop) {
      const parsed = parseMatch(line);
      if (parsed === undefined) return;
      if (matches.length >= MAX_CAPTURED_MATCHES) { reasons.add('result_limit'); stop(); return; }
      matches.push(parsed);
    },
  });
  if (result.status === 'unavailable') return result;
  if (result.timedOut) reasons.add('time_limit');
  if (result.outputLimited) reasons.add('output_limit');
  if (result.exitCode === 2 && !result.stopped && !result.timedOut && !result.outputLimited) {
    throw expectedToolError('invalid_argument', safeFailure(result.stderr));
  }
  if (result.exitCode !== 0 && result.exitCode !== 1 && !result.stopped && !result.timedOut && !result.outputLimited) {
    throw expectedToolError('external', safeFailure(result.stderr), { retryable: true });
  }
  return { status: 'ok', matches, reasons: [...reasons] };
}

async function runProcess(
  executable: string,
  args: readonly string[],
  options: Readonly<{
    cwd: string;
    signal: AbortSignal;
    timeoutMs: number;
    maxStdoutBytes: number;
    activeProcesses: Set<Promise<void>>;
    onLine(line: string, stop: () => void): void;
  }>,
): Promise<
  | { status: 'ok'; exitCode: number | null; stderr: string; timedOut: boolean; outputLimited: boolean; stopped: boolean }
  | { status: 'unavailable'; reason: string }
> {
  throwIfAborted(options.signal);
  const child = spawn(executable, [...args], { cwd: options.cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let resolveClosed = (): void => undefined;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  options.activeProcesses.add(closed);
  void closed.finally(() => options.activeProcesses.delete(closed));
  return await new Promise((resolvePromise, reject) => {
    let pending = ''; let stderr = ''; let stdoutBytes = 0; let timedOut = false; let outputLimited = false; let stopped = false;
    let unavailable = false; let spawnError: Error | undefined; let settled = false; let terminationTimer: ReturnType<typeof setTimeout> | undefined;
    const settleReject = (error: Error): void => { if (!settled) { settled = true; reject(error); } };
    const requestStop = (): void => {
      child.kill('SIGKILL');
      if (terminationTimer === undefined) {
        terminationTimer = setTimeout(() => settleReject(expectedToolError('external', 'ripgrep termination was not confirmed before its hard deadline.', { outcome: 'unknown' })), TERMINATION_CLOSE_MS);
        terminationTimer.unref?.();
      }
    };
    const stop = (): void => { stopped = true; requestStop(); };
    const requestAbort = (): void => { requestStop(); };
    const timeout = setTimeout(() => { timedOut = true; requestStop(); }, options.timeoutMs);
    timeout.unref?.();
    options.signal.addEventListener('abort', requestAbort, { once: true });
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') { unavailable = true; return; }
      spawnError = error;
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk, 'utf8');
      if (stdoutBytes > options.maxStdoutBytes) { outputLimited = true; stop(); return; }
      pending += chunk;
      while (true) {
        const newline = pending.indexOf('\n');
        if (newline < 0) break;
        const line = pending.slice(0, newline).replace(/\r$/u, ''); pending = pending.slice(newline + 1);
        if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) { outputLimited = true; stop(); return; }
        options.onLine(line, stop);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { if (stderr.length < MAX_STDERR_BYTES) stderr += chunk.slice(0, MAX_STDERR_BYTES - stderr.length); });
    child.once('close', (exitCode) => {
      clearTimeout(timeout); if (terminationTimer !== undefined) clearTimeout(terminationTimer);
      options.signal.removeEventListener('abort', requestAbort); resolveClosed();
      if (settled) return;
      settled = true;
      if (unavailable) { resolvePromise({ status: 'unavailable', reason: 'ripgrep_not_found' }); return; }
      if (spawnError !== undefined) { reject(spawnError); return; }
      if (options.signal.aborted) {
        const error = new Error('Workspace search was cancelled after ripgrep exited.'); error.name = 'AbortError'; reject(error); return;
      }
      resolvePromise({ status: 'ok', exitCode, stderr, timedOut, outputLimited, stopped });
    });
  });
}

function page(captured: CapturedResultSet, offset: number, limit: number): WorkspaceSearchResult {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > captured.matches.length) throw expectedToolError('invalid_argument', 'The search cursor offset is invalid.');
  const matches = captured.matches.slice(offset, offset + limit);
  const nextOffset = offset + matches.length;
  const hasMore = nextOffset < captured.matches.length;
  const reasons = new Set(captured.baseReasons);
  if (hasMore) reasons.add('result_limit');
  return Object.freeze({ status: 'ok', matches, scannedFiles: offset === 0 ? captured.scannedFiles : 0,
    scannedBytes: offset === 0 ? captured.scannedBytes : 0, truncated: hasMore || reasons.size > 0,
    truncationReasons: Object.freeze([...reasons].sort()) });
}

function parseMatch(line: string): { path: string; line: number; byteColumn: number; text: string; match: string } | undefined {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return undefined; }
  if (!isRecord(value) || value.type !== 'match' || !isRecord(value.data)) return undefined;
  const data = value.data;
  if (!isRecord(data.path) || typeof data.path.text !== 'string') return undefined;
  if (!isRecord(data.lines) || typeof data.lines.text !== 'string' || typeof data.line_number !== 'number' || !Array.isArray(data.submatches)) return undefined;
  const first: unknown = data.submatches[0];
  if (!isRecord(first) || typeof first.start !== 'number' || !isRecord(first.match) || typeof first.match.text !== 'string') return undefined;
  return { path: data.path.text, line: data.line_number, byteColumn: first.start + 1, text: data.lines.text.replace(/[\r\n]+$/u, '').slice(0, 4_096), match: first.match.text.slice(0, 1_024) };
}

function portableIdentity(path: string, info: BigIntStats): PortableValue {
  return { kind: 'filesystem-entry', canonicalPath: path, type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other',
    device: info.dev.toString(), inode: info.ino.toString(), sizeBytes: Number(info.size), mtimeMs: Number(info.mtimeMs),
    mtimeNs: info.mtimeNs.toString(), ctimeNs: info.ctimeNs.toString() };
}

function samePortableIdentity(left: PortableValue, right: PortableValue): boolean {
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftRecord = left as Record<string, unknown>; const rightRecord = right as Record<string, unknown>;
  return leftRecord.kind === 'filesystem-entry' && rightRecord.kind === 'filesystem-entry' &&
    leftRecord.type === rightRecord.type && leftRecord.device === rightRecord.device && leftRecord.inode === rightRecord.inode &&
    leftRecord.sizeBytes === rightRecord.sizeBytes && leftRecord.mtimeNs === rightRecord.mtimeNs && leftRecord.ctimeNs === rightRecord.ctimeNs;
}

function backendCursor(id: string, offset: number): string { return `rgset:${id}:${offset}`; }
function decodeBackendCursor(value: string | undefined): { id: string; offset: number } | undefined {
  if (value === undefined) return undefined;
  const match = /^rgset:([0-9a-f-]{36}):(\d+)$/u.exec(value);
  if (match === null) throw expectedToolError('invalid_argument', 'The ripgrep result cursor is invalid.');
  return { id: match[1]!, offset: Number(match[2]!) };
}
function prune(sets: Map<string, CapturedResultSet>): void { const now = Date.now(); for (const [id, set] of sets) if (set.expiresAt <= now) sets.delete(id); }
function reserveResultSet(sets: Map<string, CapturedResultSet>, ownerKey: string, incomingBytes: number): void {
  if (incomingBytes > MAX_CACHE_BYTES_PER_OWNER) throw expectedToolError('limit', 'The search result snapshot exceeds its owner cache quota.');
  const ordered = (): Array<[string, CapturedResultSet]> => [...sets.entries()].sort((left, right) => left[1].createdAt - right[1].createdAt);
  while ([...sets.values()].filter((set) => set.ownerKey === ownerKey).length >= MAX_RESULT_SETS_PER_OWNER ||
    [...sets.values()].filter((set) => set.ownerKey === ownerKey).reduce((sum, set) => sum + set.retainedBytes, 0) + incomingBytes > MAX_CACHE_BYTES_PER_OWNER) {
    const victim = ordered().find(([, set]) => set.ownerKey === ownerKey);
    if (victim === undefined) break;
    sets.delete(victim[0]);
  }
  while (sets.size >= MAX_RESULT_SETS || [...sets.values()].reduce((sum, set) => sum + set.retainedBytes, 0) + incomingBytes > MAX_CACHE_BYTES) {
    const victim = ordered()[0];
    if (victim === undefined) break;
    sets.delete(victim[0]);
  }
}
function retainedBytes(matches: readonly WorkspaceSearchMatch[]): number { return Buffer.byteLength(JSON.stringify(matches), 'utf8'); }
function identityKey(value: PortableValue): string {
  const record = value as Record<string, PortableValue>;
  // Prepared identities also carry backendRevision. Hash exactly the filesystem
  // snapshot fields on both sides; revision is already bound by the outer cursor.
  const identity = Object.fromEntries(['kind', 'canonicalPath', 'type', 'device', 'inode', 'sizeBytes', 'mtimeMs', 'mtimeNs', 'ctimeNs']
    .map((key) => [key, record[key] ?? null])) as Record<string, PortableValue>;
  return createHash('sha256').update(canonicalPortable(identity)).digest('hex');
}

function awaitWithin<T>(actual: Promise<T>, timeoutMs: number, signal: AbortSignal, controller: AbortController): Promise<T> {
  const deadlineAt = Date.now() + timeoutMs;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (result: () => void): void => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort); result();
    };
    const abort = (): void => { controller.abort(signal.reason); finish(() => { const error = new Error('Workspace search was cancelled.'); error.name = 'AbortError'; reject(error); }); };
    const timer = setTimeout(() => {
      controller.abort(new Error('Workspace search deadline elapsed.'));
      finish(() => reject(expectedToolError('external', 'Workspace search exceeded its hard deadline.', { retryable: true })));
    }, timeoutMs);
    timer.unref?.();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void actual.then((value) => {
      if (Date.now() >= deadlineAt) {
        controller.abort(new Error('Workspace search deadline elapsed.'));
        finish(() => reject(expectedToolError('external', 'Workspace search exceeded its hard deadline.', { retryable: true })));
      } else finish(() => resolve(value));
    }, (error: unknown) => finish(() => reject(error instanceof Error ? error : new Error('Workspace search failed.'))));
  });
}
function canonicalPortable(value: PortableValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalPortable).join(',')}]`;
  const record = value as Record<string, PortableValue>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalPortable(record[key]!)}`).join(',')}}`;
}
function timedOutResult(scannedFiles: number, scannedBytes: number): WorkspaceSearchResult {
  return Object.freeze({ status: 'ok', matches: [], scannedFiles, scannedBytes, truncated: true, truncationReasons: ['time_limit'] });
}
function unavailable(reason: string): WorkspaceSearchResult { return Object.freeze({ status: 'unavailable', reason, matches: [], scannedFiles: 0, scannedBytes: 0, truncated: false, truncationReasons: [] }); }
function safeFailure(stderr: string): string { const text = stderr.trim(); return text ? text.slice(0, 2_048) : 'ripgrep could not complete the search.'; }
function mapFilesystemError(error: unknown): Error { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? expectedToolError('not_found', 'The search target was not found.') : error instanceof Error ? error : new Error('Search target inspection failed.'); }
function throwIfAborted(signal: AbortSignal): void { if (signal.aborted) { const error = new Error('Workspace search was cancelled.'); error.name = 'AbortError'; throw error; } }
function throwIfDeadline(deadlineAt: number): void { if (Date.now() >= deadlineAt) throw expectedToolError('external', 'Workspace search exceeded its user deadline.', { retryable: true }); }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
