import { lstat, opendir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expectedToolError, ToolExecutionError } from '@dbagent/core-agent';
import type { PortableValue } from '@dbagent/shared';
import type { WorkspaceDirectoryBackend, WorkspaceDirectoryEntry } from './workspace-tools.js';

export type ValidatedEntry = Readonly<{ path: string; identity: PortableValue }>;

/** Read-only optimistic validation. This is NOT a handle-relative mutation fence. */
export async function inspectValidatedEntry(path: string): Promise<PortableValue> {
  try {
  const before = await lstat(path, { bigint: true });
  if (before.isSymbolicLink() || resolve(await realpath(path)) !== resolve(path)) changed();
  const after = await lstat(path, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) changed();
  return { kind: 'filesystem-entry', canonicalPath: path, type: after.isDirectory() ? 'directory' : after.isFile() ? 'file' : 'other',
    device: String(after.dev), inode: String(after.ino), sizeBytes: Number(after.size), mtimeMs: Number(after.mtimeMs),
    mtimeNs: String(after.mtimeNs), ctimeNs: String(after.ctimeNs) };
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(String((error as NodeJS.ErrnoException).code))) changed();
    throw error;
  }
}

export function validatedIdentityKey(identity: PortableValue): string {
  const record = identity as Record<string, PortableValue>;
  return JSON.stringify(['kind', 'canonicalPath', 'type', 'device', 'inode', 'sizeBytes', 'mtimeNs', 'ctimeNs'].map((key) => record[key]));
}

export async function revalidateEntries(entries: readonly ValidatedEntry[], signal: AbortSignal, deadlineAt: number): Promise<void> {
  for (const entry of entries) {
    check(signal, deadlineAt);
    if (validatedIdentityKey(await inspectValidatedEntry(entry.path)) !== validatedIdentityKey(entry.identity)) changed();
  }
}

/** Every visited directory is checked before/after traversal; links are rejected. */
export async function walkValidatedDirectory(root: string, options: Readonly<{
  maxEntries: number; depth: number; signal: AbortSignal; deadlineAt: number;
  visit?: (entry: ValidatedEntry) => Promise<boolean>;
}>): Promise<{ entries: ValidatedEntry[]; scanned: number; truncated: boolean }> {
  const entries: ValidatedEntry[] = []; let scanned = 0; let truncated = false;
  const visitDirectory = async (path: string, depth: number): Promise<void> => {
    check(options.signal, options.deadlineAt);
    const identity = await inspectValidatedEntry(path);
    if ((identity as Record<string, PortableValue>).type !== 'directory') changed();
    const directory = await opendir(path);
    try {
      for await (const child of directory) {
        check(options.signal, options.deadlineAt);
        if (validatedIdentityKey(await inspectValidatedEntry(path)) !== validatedIdentityKey(identity)) changed();
        const childPath = join(path, child.name);
        const entry = { path: childPath, identity: await inspectValidatedEntry(childPath) };
        entries.push(entry); scanned += 1;
        if (options.visit !== undefined && !await options.visit(entry)) { truncated = true; break; }
        if (scanned >= options.maxEntries) { truncated = true; break; }
        if ((entry.identity as Record<string, PortableValue>).type === 'directory' && depth < options.depth) {
          await visitDirectory(childPath, depth + 1);
          if (truncated) break;
        }
        else if ((entry.identity as Record<string, PortableValue>).type === 'directory' && depth >= options.depth && options.visit !== undefined) {
          truncated = true; break;
        }
      }
    } finally { await directory.close().catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ERR_DIR_CLOSED') throw error; }); }
    if (validatedIdentityKey(await inspectValidatedEntry(path)) !== validatedIdentityKey(identity)) changed();
  };
  await visitDirectory(root, 1);
  await revalidateEntries(entries, options.signal, options.deadlineAt);
  return { entries, scanned, truncated };
}

export function createPortableWorkspaceDirectoryBackend(): WorkspaceDirectoryBackend {
  type Snapshot = { owner: string; root: ValidatedEntry; entries: ValidatedEntry[]; truncated: boolean; scanned: number; expiresAt: number };
  const snapshots = new Map<string, Snapshot>();
  return Object.freeze({
    revision: 'portable-revalidated.workspace-directory.v1',
    protocol: 'validated-directory-page.v1' as const,
    async revalidate(path, identity, signal) {
      check(signal, Date.now() + 30_000);
      return validatedIdentityKey(await inspectValidatedEntry(path)) === validatedIdentityKey(identity);
    },
    async list(input) {
      const deadlineAt = Date.now() + input.timeoutMs;
      for (const [id, snapshot] of snapshots) if (snapshot.expiresAt <= Date.now()) snapshots.delete(id);
      let id: string; let offset = 0; let snapshot: Snapshot;
      if (input.cursor !== undefined) {
        const match = /^portable-dir:([0-9a-f-]{36}):(\d+)$/u.exec(input.cursor);
        if (match === null) throw expectedToolError('invalid_cursor', 'Invalid directory cursor.');
        id = match[1]!; offset = Number(match[2]);
        const cached = snapshots.get(id);
        if (cached === undefined || cached.owner !== input.ownerKey || validatedIdentityKey(cached.root.identity) !== validatedIdentityKey(input.identity)) {
          throw expectedToolError('invalid_cursor', 'Directory cursor expired or belongs to another owner/snapshot.');
        }
        snapshot = cached;
        await revalidateEntries([snapshot.root, ...snapshot.entries], input.signal, deadlineAt);
      } else {
        await revalidateEntries([{ path: input.rootPath, identity: input.identity }], input.signal, deadlineAt);
        const walk = await walkValidatedDirectory(input.rootPath, { maxEntries: input.maxScanEntries, depth: input.depth, signal: input.signal, deadlineAt });
        snapshot = { owner: input.ownerKey, root: { path: input.rootPath, identity: input.identity },
          entries: walk.entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
          truncated: walk.truncated, scanned: walk.scanned, expiresAt: Date.now() + 300_000 };
        while ([...snapshots.values()].filter((value) => value.owner === input.ownerKey).length >= 4) {
          const victim = [...snapshots].find(([, value]) => value.owner === input.ownerKey)!; snapshots.delete(victim[0]);
        }
        while (snapshots.size >= 16) snapshots.delete(snapshots.keys().next().value!);
        id = randomUUID(); snapshots.set(id, snapshot);
      }
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > snapshot.entries.length) throw expectedToolError('invalid_cursor', 'Invalid directory cursor offset.');
      const entries: WorkspaceDirectoryEntry[] = []; let bytes = 2;
      for (const value of snapshot.entries.slice(offset, offset + input.maxEntries)) {
        const identity = value.identity as Record<string, PortableValue>;
        const entry: WorkspaceDirectoryEntry = { canonicalPath: value.path, type: identity.type as 'file' | 'directory' | 'other',
          mtimeMs: Number(identity.mtimeMs), ...(identity.type === 'file' ? { sizeBytes: Number(identity.sizeBytes) } : {}) };
        const size = Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1;
        if (bytes + size > input.maxOutputBytes) break;
        entries.push(entry); bytes += size;
      }
      const more = offset + entries.length < snapshot.entries.length;
      if (more && entries.length === 0) throw expectedToolError('limit', 'A directory entry exceeds the page byte budget.');
      return { entries, scannedEntries: offset === 0 ? snapshot.scanned : 0, truncated: snapshot.truncated || more,
        truncationReasons: [...(snapshot.truncated ? ['scan_limit'] : []), ...(more ? ['entry_limit'] : [])],
        ...(more ? { nextCursor: `portable-dir:${id}:${offset + entries.length}` } : {}) };
    },
  });
}

function changed(): never { throw new ToolExecutionError({ code: 'target_changed', category: 'conflict', outcome: 'not_applied', retryable: false }, 'Workspace traversal encountered a link or changed entry.'); }
function check(signal: AbortSignal, deadlineAt: number): void {
  if (signal.aborted) { const error = new Error('Workspace directory traversal cancelled.'); error.name = 'AbortError'; throw error; }
  if (Date.now() >= deadlineAt) throw expectedToolError('limit', 'Workspace directory traversal exceeded its deadline.');
}
