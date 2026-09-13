import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as FileSystemPromises from 'node:fs/promises';

const captureGate = vi.hoisted(() => ({
  beforeStatPath: '',
  reached: undefined as (() => void) | undefined,
  release: undefined as Promise<void> | undefined,
  triggered: false,
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof FileSystemPromises>('node:fs/promises');
  return {
    ...actual,
    lstat: async (...input: unknown[]) => {
      const path = String(input[0]).replace(/\\/gu, '/').toLowerCase();
      if (!captureGate.triggered && path === captureGate.beforeStatPath) {
        captureGate.triggered = true;
        captureGate.reached?.();
        await captureGate.release;
      }
      return await (actual.lstat as (...arguments_: unknown[]) => ReturnType<typeof actual.lstat>)(
        ...input,
      );
    },
  };
});

import { SkillRegistry } from '../src/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  captureGate.beforeStatPath = '';
  captureGate.reached = undefined;
  captureGate.release = undefined;
  captureGate.triggered = false;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

describe('Skill bundle atomic capture', () => {
  it('retries the entire bundle when an already-read file changes before capture completes', async () => {
    const root = await temporaryDirectory();
    const cacheRoot = join(root, '.revision-cache');
    const bundleRoot = join(root, 'atomic-skill');
    await writeBundleVersion(bundleRoot, 1);

    let signalReached!: () => void;
    let signalRelease!: () => void;
    const reached = new Promise<void>((resolve) => {
      signalReached = resolve;
    });
    captureGate.beforeStatPath = comparablePath(join(bundleRoot, 'z-marker.txt'));
    captureGate.reached = signalReached;
    captureGate.release = new Promise<void>((resolve) => {
      signalRelease = resolve;
    });

    const registry = new SkillRegistry({
      sources: [{ scope: 'project', path: root }],
      revisionCachePath: cacheRoot,
    });
    const refresh = registry.refresh();
    await reached;
    await writeMutableBundleVersion(bundleRoot, 2);
    signalRelease();
    const result = await refresh;

    const descriptor = registry.inspect('atomic-skill');
    const current = descriptor
      ? [
          versionOf((await registry.loadRevision(descriptor.revisionRef)).instructions),
          versionOf(await registry.readRevisionResource(descriptor.revisionRef, 'a-marker.txt')),
          versionOf(await registry.readRevisionResource(descriptor.revisionRef, 'z-marker.txt')),
        ]
      : [];
    const cachedBundles = await cachedBundleVersions(cacheRoot);

    expect({
      issues: result.issues,
      current,
      cachedBundles,
      gateTriggered: captureGate.triggered,
    }).toEqual({
      issues: [],
      current: [2, 2, 2],
      cachedBundles: [[2, 2, 2]],
      gateTriggered: true,
    });
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'schemanaut-skill-concurrency-'));
  temporaryDirectories.push(path);
  return path;
}

async function writeBundleVersion(bundleRoot: string, version: number): Promise<void> {
  await mkdir(bundleRoot, { recursive: true });
  await writeMutableBundleVersion(bundleRoot, version);
}

async function writeMutableBundleVersion(bundleRoot: string, version: number): Promise<void> {
  const marker = `version-${String(version)}`;
  await Promise.all([
    writeFile(join(bundleRoot, 'a-marker.txt'), marker, 'utf8'),
    writeFile(
      join(bundleRoot, 'SKILL.md'),
      [
        '---',
        'name: atomic-skill',
        'description: Atomic bundle capture.',
        '---',
        marker,
      ].join('\n'),
      'utf8',
    ),
    writeFile(join(bundleRoot, 'z-marker.txt'), marker, 'utf8'),
  ]);
}

async function cachedBundleVersions(cacheRoot: string): Promise<number[][]> {
  const manifestDirectory = join(cacheRoot, 'manifests');
  const manifestNames = (await readdir(manifestDirectory)).sort();
  const bundles: number[][] = [];
  for (const manifestName of manifestNames) {
    const manifest = JSON.parse(
      await readFile(join(manifestDirectory, manifestName), 'utf8'),
    ) as {
      resources: { path: string; contentDigest: string }[];
    };
    const resources = new Map(
      manifest.resources.map(({ path, contentDigest }) => [path, contentDigest]),
    );
    const versions: number[] = [];
    for (const path of ['SKILL.md', 'a-marker.txt', 'z-marker.txt']) {
      const digest = resources.get(path);
      expect(digest).toMatch(/^[a-f0-9]{64}$/);
      const bytes = await readFile(join(cacheRoot, 'blobs', digest!));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(digest);
      versions.push(versionOf(bytes.toString('utf8')));
    }
    bundles.push(versions);
  }
  return bundles;
}

function versionOf(content: string): number {
  const match = /version-(\d+)/u.exec(content);
  if (!match) throw new Error(`Missing bundle version marker in: ${content}`);
  return Number(match[1]);
}

function comparablePath(path: string): string {
  return path.replace(/\\/gu, '/').toLowerCase();
}
