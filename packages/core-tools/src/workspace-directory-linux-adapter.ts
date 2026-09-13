import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, opendir, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expectedToolError } from '@dbagent/core-agent';
import type { PortableValue } from '@dbagent/shared';
import type { WorkspaceDirectoryBackend, WorkspaceDirectoryEntry } from './workspace-tools.js';

const SNAPSHOT_TTL_MS = 5 * 60_000;
const MAX_SNAPSHOTS = 16;
const MAX_SNAPSHOTS_PER_OWNER = 4;

type DirectorySnapshot = Readonly<{
  ownerKey: string;
  identityKey: string;
  expiresAt: number;
  entries: readonly WorkspaceDirectoryEntry[];
  scannedEntries: number;
  scanLimited: boolean;
}>;

/**
 * Linux implementation using /proc/self/fd as an openat-style bridge. Every
 * traversal step is relative to a pinned O_DIRECTORY|O_NOFOLLOW handle. Other
 * platforms return null rather than silently falling back to pathname walking.
 */
export function createLinuxWorkspaceDirectoryBackend(): WorkspaceDirectoryBackend | null {
  if (process.platform !== 'linux' || constants.O_DIRECTORY === undefined || constants.O_NOFOLLOW === undefined) return null;
  const snapshots = new Map<string, DirectorySnapshot>();
  return Object.freeze({
    revision: 'linux-procfd.workspace-directory.v1',
    protocol: 'handle-relative-directory-page.v1' as const,
    async revalidate(path, identity, signal) {
      throwIfAborted(signal);
      let handle: FileHandle | undefined;
      try {
        handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        return sameIdentity(fileIdentity(path, await handle.stat({ bigint: true })), identity);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      } finally { await handle?.close().catch(() => undefined); }
    },
    async list(input) {
      prune(snapshots);
      const continuation = decodeCursor(input.cursor);
      if (continuation !== undefined) {
        const snapshot = snapshots.get(continuation.id);
        if (snapshot === undefined || snapshot.expiresAt <= Date.now()) throw expectedToolError('invalid_argument', 'The directory cursor expired.');
        if (snapshot.ownerKey !== input.ownerKey || snapshot.identityKey !== identityKey(input.identity)) {
          throw expectedToolError('invalid_argument', 'The directory cursor belongs to another owner or target snapshot.');
        }
        return page(snapshot, continuation.id, continuation.offset, input.maxEntries, input.maxOutputBytes);
      }

      const deadlineAt = Date.now() + input.timeoutMs;
      let root: FileHandle | undefined;
      try {
        root = await open(input.rootPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        const actual = fileIdentity(input.rootPath, await root.stat({ bigint: true }));
        if (!sameIdentity(actual, input.identity)) throw expectedToolError('conflict', 'The prepared directory changed.');
        const state = { scanned: 0, exceeded: false };
        const entries: WorkspaceDirectoryEntry[] = [];
        await scanPinned(root, input.rootPath, '', 1, input.depth, input.maxScanEntries, deadlineAt, input.signal, entries, state);
        entries.sort((left, right) => compare(left.canonicalPath, right.canonicalPath));
        const id = randomUUID();
        reserve(snapshots, input.ownerKey);
        const snapshot: DirectorySnapshot = Object.freeze({ ownerKey: input.ownerKey, identityKey: identityKey(input.identity),
          expiresAt: Date.now() + SNAPSHOT_TTL_MS, entries: Object.freeze(entries), scannedEntries: state.scanned, scanLimited: state.exceeded });
        snapshots.set(id, snapshot);
        return page(snapshot, id, 0, input.maxEntries, input.maxOutputBytes);
      } finally { await root?.close().catch(() => undefined); }
    },
  });
}

async function scanPinned(
  handle: FileHandle,
  canonicalRoot: string,
  prefix: string,
  level: number,
  maxDepth: number,
  maxEntries: number,
  deadlineAt: number,
  signal: AbortSignal,
  output: WorkspaceDirectoryEntry[],
  state: { scanned: number; exceeded: boolean },
): Promise<void> {
  const descriptorPath = `/proc/self/fd/${handle.fd}`;
  const directory = await opendir(descriptorPath);
  const names: string[] = [];
  try {
    for await (const entry of directory) {
      check(signal, deadlineAt);
      state.scanned += 1;
      names.push(entry.name);
      // Stop before another enumeration. Materialize the names already observed
      // into a sorted bounded snapshot instead of discarding the entire page.
      if (state.scanned >= maxEntries) { state.exceeded = true; break; }
    }
  } finally { await directory.close().catch(() => undefined); }
  names.sort(compare);
  for (const name of names) {
    check(signal, deadlineAt);
    const relativeName = prefix === '' ? name : `${prefix}/${name}`;
    const descriptorEntry = `${descriptorPath}/${name}`;
    let info;
    try { info = await lstat(descriptorEntry); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    const type = info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other';
    output.push(Object.freeze({ canonicalPath: join(canonicalRoot, ...relativeName.split('/')), type,
      ...((type === 'file' || type === 'other') ? { sizeBytes: info.size } : {}), mtimeMs: info.mtimeMs }));
    if (type === 'directory' && level < maxDepth && !state.exceeded) {
      let child: FileHandle | undefined;
      try {
        child = await open(descriptorEntry, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        await scanPinned(child, canonicalRoot, relativeName, level + 1, maxDepth, maxEntries, deadlineAt, signal, output, state);
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR', 'ELOOP'].includes(String((error as NodeJS.ErrnoException).code))) throw error;
      } finally { await child?.close().catch(() => undefined); }
    }
  }
}

function page(snapshot: DirectorySnapshot, id: string, offset: number, maxEntries: number, maxBytes: number) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > snapshot.entries.length) throw expectedToolError('invalid_argument', 'The directory cursor offset is invalid.');
  const entries: WorkspaceDirectoryEntry[] = []; let bytes = 2;
  while (offset + entries.length < snapshot.entries.length && entries.length < maxEntries) {
    const entry = snapshot.entries[offset + entries.length]!;
    const size = Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1;
    if (bytes + size > maxBytes) break;
    entries.push(entry); bytes += size;
  }
  const nextOffset = offset + entries.length; const hasMore = nextOffset < snapshot.entries.length;
  const reasons = hasMore ? [entries.length === maxEntries ? 'entry_limit' : 'byte_limit'] : [];
  if (snapshot.scanLimited) reasons.push('scan_limit');
  return Object.freeze({ entries: Object.freeze(entries), scannedEntries: offset === 0 ? snapshot.scannedEntries : 0,
    truncated: hasMore || snapshot.scanLimited, truncationReasons: Object.freeze(reasons),
    ...(hasMore && entries.length > 0 ? { nextCursor: `dirset:${id}:${nextOffset}` } : {}) });
}

function decodeCursor(value: string | undefined): { id: string; offset: number } | undefined {
  if (value === undefined) return undefined;
  const match = /^dirset:([0-9a-f-]{36}):(\d+)$/u.exec(value);
  if (match === null) throw expectedToolError('invalid_argument', 'The directory cursor is invalid.');
  return { id: match[1]!, offset: Number(match[2]!) };
}

function reserve(snapshots: Map<string, DirectorySnapshot>, ownerKey: string): void {
  const ordered = (): Array<[string, DirectorySnapshot]> => [...snapshots.entries()].sort((left, right) => left[1].expiresAt - right[1].expiresAt);
  while ([...snapshots.values()].filter((snapshot) => snapshot.ownerKey === ownerKey).length >= MAX_SNAPSHOTS_PER_OWNER) {
    const victim = ordered().find(([, snapshot]) => snapshot.ownerKey === ownerKey); if (victim === undefined) break; snapshots.delete(victim[0]);
  }
  while (snapshots.size >= MAX_SNAPSHOTS) { const victim = ordered()[0]; if (victim === undefined) break; snapshots.delete(victim[0]); }
}
function prune(snapshots: Map<string, DirectorySnapshot>): void { const now = Date.now(); for (const [id, snapshot] of snapshots) if (snapshot.expiresAt <= now) snapshots.delete(id); }
function fileIdentity(path: string, info: BigIntStats): PortableValue { return { kind: 'filesystem-entry', canonicalPath: path,
  type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other', device: String(info.dev), inode: String(info.ino), sizeBytes: Number(info.size),
  mtimeMs: Number(info.mtimeMs), mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs) }; }
function sameIdentity(left: PortableValue, right: PortableValue): boolean { const a = left as Record<string, PortableValue>; const b = right as Record<string, PortableValue>;
  return a.kind === b.kind && a.type === b.type && a.device === b.device && a.inode === b.inode && a.sizeBytes === b.sizeBytes && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs; }
function identityKey(value: PortableValue): string { const record = value as Record<string, PortableValue>;
  return JSON.stringify([record.kind, record.type, record.device, record.inode, record.sizeBytes, record.mtimeNs, record.ctimeNs]); }
function check(signal: AbortSignal, deadlineAt: number): void { throwIfAborted(signal); if (Date.now() >= deadlineAt) throw expectedToolError('external', 'Directory snapshot exceeded its deadline.', { retryable: true }); }
function throwIfAborted(signal: AbortSignal): void { if (signal.aborted) { const error = new Error('Directory snapshot was cancelled.'); error.name = 'AbortError'; throw error; } }
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
