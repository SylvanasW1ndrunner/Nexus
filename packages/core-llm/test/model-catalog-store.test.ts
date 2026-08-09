import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LlmModelCatalogStore,
  type LlmModelCatalogCacheKey,
} from '../src/index.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('LlmModelCatalogStore', () => {
  it('writes atomically, preserves ETag and reports fresh versus stale snapshots', async () => {
    let now = Date.parse('2026-08-07T00:00:00.000Z');
    const store = new LlmModelCatalogStore(await directory(), { now: () => now });
    const key = cacheKey();
    await store.write(key, {
      fetchedAt: new Date(now).toISOString(),
      ttlMs: 60_000,
      etag: '"catalog-v1"',
      models: [{ modelId: 'model-a', metadata: { contextTokens: 32_768 } }],
    });

    expect(await store.read(key)).toMatchObject({
      stale: false,
      snapshot: { etag: '"catalog-v1"', models: [{ modelId: 'model-a' }] },
    });
    now += 60_001;
    expect(await store.read(key)).toMatchObject({ stale: true });
    expect((await readdir(store.directory)).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('isolates credential scopes and plugin versions without serializing credentials', async () => {
    const store = new LlmModelCatalogStore(await directory());
    const first = cacheKey({ credentialScope: 'scope-a' });
    const second = cacheKey({ credentialScope: 'scope-b' });
    await store.write(first, {
      fetchedAt: '2026-08-07T00:00:00.000Z',
      ttlMs: 60_000,
      models: [{ modelId: 'first', metadata: {} }],
    });

    expect(await store.read(second)).toBeUndefined();
    expect(await store.read({ ...first, pluginVersion: '2.0.0' })).toBeUndefined();
    const serialized = await readFile(store.cachePath(first), 'utf8');
    expect(serialized).not.toContain('scope-a');
    expect(serialized).not.toContain('sk-sensitive-value');
  });

  it('quarantines a corrupt cache and lets the caller rediscover', async () => {
    const store = new LlmModelCatalogStore(await directory());
    const key = cacheKey();
    await store.write(key, {
      fetchedAt: '2026-08-07T00:00:00.000Z',
      ttlMs: 60_000,
      models: [{ modelId: 'model-a', metadata: {} }],
    });
    await writeFile(store.cachePath(key), '{broken', 'utf8');

    expect(await store.read(key)).toBeUndefined();
    expect((await readdir(store.directory)).some((name) => name.includes('.corrupt-'))).toBe(true);
  });

  it('rejects unsupported schema versions and leaves no usable cache', async () => {
    const store = new LlmModelCatalogStore(await directory());
    const key = cacheKey();
    await store.write(key, {
      fetchedAt: '2026-08-07T00:00:00.000Z',
      ttlMs: 60_000,
      models: [],
    });
    const value = JSON.parse(await readFile(store.cachePath(key), 'utf8')) as Record<string, unknown>;
    value.schemaVersion = 99;
    await writeFile(store.cachePath(key), JSON.stringify(value), 'utf8');

    expect(await store.read(key)).toBeUndefined();
  });
});

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'schemanaut-model-cache-'));
  directories.push(path);
  return path;
}

function cacheKey(overrides: Partial<LlmModelCatalogCacheKey> = {}): LlmModelCatalogCacheKey {
  return {
    connectionId: 'connection-a',
    credentialScope: 'scope-a',
    pluginId: 'openai-compatible',
    pluginVersion: '1.0.0',
    ...overrides,
  };
}
