import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalizeProspectiveEntrySync,
  sameCanonicalPath,
  sameFileSystemIdentity,
} from '../src/filesystem-identity.js';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('filesystem identity portability', () => {
  it('keeps device and inode binding strict on non-Windows platforms', () => {
    expect(sameFileSystemIdentity({ dev: 7n, ino: 42n }, { dev: 7n, ino: 42n }, 'linux')).toBe(true);
    expect(sameFileSystemIdentity({ dev: 7n, ino: 42n }, { dev: 8n, ino: 42n }, 'linux')).toBe(false);
  });

  it('treats only a zero Windows device id as unavailable', () => {
    expect(sameFileSystemIdentity({ dev: 0n, ino: 42n }, { dev: 7n, ino: 42n }, 'win32')).toBe(true);
    expect(sameFileSystemIdentity({ dev: '7', ino: '42' }, { dev: '0', ino: '42' }, 'win32')).toBe(true);
    expect(sameFileSystemIdentity({ dev: 7n, ino: 42n }, { dev: 8n, ino: 42n }, 'win32')).toBe(false);
    expect(sameFileSystemIdentity({ dev: 0n, ino: 42n }, { dev: 7n, ino: 43n }, 'win32')).toBe(false);
  });

  it('uses Windows case-insensitive canonical path comparison only on Windows', () => {
    expect(sameCanonicalPath('C:\\Work\\File.txt', 'c:\\work\\file.TXT', 'win32')).toBe(true);
    expect(sameCanonicalPath('/Work/File.txt', '/work/file.txt', 'linux')).toBe(false);
  });

  it('rebases a prospective entry onto the canonical spelling of its existing ancestor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'schemanaut-identity-'));
    temporaryDirectories.push(root);
    const parent = join(root, 'missing-parent');
    const entry = join(parent, 'result.ndjson');

    expect(canonicalizeProspectiveEntrySync(entry)).toBe(join(await realpath(root), 'missing-parent', 'result.ndjson'));
    await mkdir(parent);
    expect(canonicalizeProspectiveEntrySync(entry)).toBe(join(await realpath(root), 'missing-parent', 'result.ndjson'));
  });
});
