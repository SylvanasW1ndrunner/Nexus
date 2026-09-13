import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  InMemoryResourceSnapshotStore,
  JsonFileResourceSnapshotStore,
  ResourceRegistry,
} from '../src/index.js';
import type { ResourceSnapshotStoreError } from '../src/index.js';
import { testResource } from './test-helpers.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('resource snapshot stores', () => {
  it('isolates in-memory snapshots from caller mutation', async () => {
    const registry = new ResourceRegistry();
    registry.upsertResource(testResource('public.orders'));
    const snapshot = registry.snapshot();
    const store = new InMemoryResourceSnapshotStore(snapshot);
    snapshot.resources[0]!.canonicalName = 'mutated';

    const first = await store.load();
    expect(first?.resources[0]?.canonicalName).toBe('public.orders');
    first!.resources[0]!.canonicalName = 'also-mutated';
    expect((await store.load())?.resources[0]?.canonicalName).toBe('public.orders');
    store.clear();
    expect(await store.load()).toBeUndefined();
  });

  it('atomically persists and reloads a snapshot in a path containing spaces', async () => {
    const directory = await createTemporaryDirectory();
    const file = join(directory, 'state with spaces', 'resources.json');
    const registry = new ResourceRegistry();
    registry.upsertResource(testResource('public.orders'));
    const store = new JsonFileResourceSnapshotStore(file);
    await store.save(registry.snapshot());

    const loaded = await store.load();
    const restored = new ResourceRegistry();
    restored.restore(loaded!);
    expect(restored.getResource(registry.query().items[0]!.id)).toBeDefined();
    expect((await readFile(file, 'utf8')).endsWith('\n')).toBe(true);
    expect((await readdir(join(directory, 'state with spaces'))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('returns undefined for a missing file and rejects structurally invalid snapshots', async () => {
    const directory = await createTemporaryDirectory();
    const file = join(directory, 'resources.json');
    const store = new JsonFileResourceSnapshotStore(file);
    expect(await store.load()).toBeUndefined();
    await writeFile(file, '{"password":"do-not-return"}', 'utf8');

    let failure: ResourceSnapshotStoreError | undefined;
    try {
      await store.load();
    } catch (error) {
      failure = error as ResourceSnapshotStoreError;
    }
    expect(failure).toMatchObject({ code: 'SNAPSHOT_INVALID' });
  });

  it('persists snapshots with arbitrary portable attribute content and cleans failed temporary files', async () => {
    const directory = await createTemporaryDirectory();
    const registry = new ResourceRegistry();
    registry.upsertResource(testResource('public.orders'));
    const unsafe = registry.snapshot();
    unsafe.events.push({
      id: 'unsafe',
      sequence: unsafe.lastEventSequence + 1,
      type: 'change-set-applied',
      occurredAt: '2026-07-23T00:01:00.000Z',
      source: {
        sourceId: 'test',
        sourceType: 'manual',
        observedAt: '2026-07-23T00:01:00.000Z',
      },
      attributes: { password: 'do-not-return' },
    });
    unsafe.lastEventSequence += 1;
    const store = new JsonFileResourceSnapshotStore(join(directory, 'resources.json'));
    await expect(store.save(unsafe)).resolves.toBeUndefined();
    await expect(store.load()).resolves.toEqual(unsafe);

    const destinationDirectory = join(directory, 'destination');
    await mkdir(destinationDirectory);
    const invalidDestination = new JsonFileResourceSnapshotStore(destinationDirectory);
    await expect(invalidDestination.save(registry.snapshot())).rejects.toMatchObject({
      code: 'SNAPSHOT_WRITE_FAILED',
    });
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dbagent-resource-store-'));
  temporaryDirectories.push(directory);
  return directory;
}
