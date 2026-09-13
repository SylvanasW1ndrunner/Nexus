import { lstatSync, realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

export type FileSystemIdentity = Readonly<{
  dev: number | bigint | string;
  ino: number | bigint | string;
}>;

/**
 * Windows can report an unavailable zero device id for a path stat or an open
 * handle while retaining the same file index. Keep inode comparison strict and
 * ignore only that unavailable field; other platforms and non-zero ids remain
 * fully bound to their device.
 */
export function sameFileSystemIdentity(
  left: FileSystemIdentity,
  right: FileSystemIdentity,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (String(left.ino) !== String(right.ino)) return false;
  return platform === 'win32' && (String(left.dev) === '0' || String(right.dev) === '0')
    ? true
    : String(left.dev) === String(right.dev);
}

export function sameCanonicalPath(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

/** Use the native implementation so sync and async realpath agree on 8.3 paths. */
export function canonicalRealpathSync(path: string): string {
  return realpathSync.native(resolve(path));
}

export function canonicalizeProspectiveEntrySync(path: string): string {
  const absolute = resolve(path);
  try {
    const information = lstatSync(absolute);
    if (!information.isSymbolicLink()) return canonicalRealpathSync(absolute);
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }
  return resolve(canonicalizeProspectivePathSync(dirname(absolute)), basename(absolute));
}

function canonicalizeProspectivePathSync(path: string): string {
  let cursor = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      return resolve(canonicalRealpathSync(cursor), ...missing.reverse());
    } catch (error) {
      if (!isMissingPath(error) || dirname(cursor) === cursor) throw error;
      missing.push(basename(cursor));
      cursor = dirname(cursor);
    }
  }
}

export async function canonicalizeProspectivePath(path: string): Promise<string> {
  let cursor = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      return resolve(await realpath(cursor), ...missing.reverse());
    } catch (error) {
      if (!isMissingPath(error) || dirname(cursor) === cursor) throw error;
      missing.push(basename(cursor));
      cursor = dirname(cursor);
    }
  }
}

function isMissingPath(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}
