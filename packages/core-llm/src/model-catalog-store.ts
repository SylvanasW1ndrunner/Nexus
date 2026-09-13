import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { LlmModelMetadata } from './types.js';

/** V2 safely invalidates prior cache schema entries. */
const CACHE_SCHEMA_VERSION = 2 as const;
const MAX_CACHED_MODELS = 100_000;
const MAX_CACHE_BYTES = 32 * 1_024 * 1_024;

export type LlmModelCatalogCacheKey = {
  connectionId: string;
  credentialRevision: string;
  pluginId: string;
  pluginVersion: string;
};

export type LlmCachedModelMetadata = Partial<Omit<LlmModelMetadata, 'model' | 'source'>>;

export type LlmCachedEndpointModel = {
  modelId: string;
  metadata: LlmCachedModelMetadata;
};

export type LlmModelCatalogCacheWrite = {
  fetchedAt: string;
  ttlMs: number;
  etag?: string;
  models: readonly LlmCachedEndpointModel[];
};

export type LlmModelCatalogCacheSnapshot = {
  schemaVersion: typeof CACHE_SCHEMA_VERSION;
  keyDigest: string;
  connectionId: string;
  pluginId: string;
  pluginVersion: string;
  fetchedAt: string;
  expiresAt: string;
  etag?: string;
  models: LlmCachedEndpointModel[];
};

export type LlmModelCatalogCacheRead = {
  snapshot: LlmModelCatalogCacheSnapshot;
  stale: boolean;
};

export class LlmModelCatalogStore {
  readonly directory: string;
  private readonly now: () => number;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(directory: string, options: { now?: () => number } = {}) {
    if (!directory.trim()) throw new Error('Model catalog cache directory must not be empty.');
    this.directory = directory;
    this.now = options.now ?? Date.now;
  }

  cachePath(key: LlmModelCatalogCacheKey): string {
    return join(this.directory, `catalog-${keyDigest(key)}.json`);
  }

  async read(key: LlmModelCatalogCacheKey): Promise<LlmModelCatalogCacheRead | undefined> {
    const path = this.cachePath(key);
    try {
      const file = await stat(path);
      if (file.size > MAX_CACHE_BYTES) throw new Error('Model catalog cache exceeds its size limit.');
      const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
      const snapshot = validateCacheSnapshot(parsed, key);
      return {
        snapshot,
        stale: this.now() >= Date.parse(snapshot.expiresAt),
      };
    } catch (error) {
      if (isFileSystemError(error, 'ENOENT')) return undefined;
      await quarantine(path);
      return undefined;
    }
  }

  async write(key: LlmModelCatalogCacheKey, input: LlmModelCatalogCacheWrite): Promise<void> {
    return this.enqueueWrite(async () => {
      validateCacheWrite(input);
      const fetchedAt = Date.parse(input.fetchedAt);
      const snapshot: LlmModelCatalogCacheSnapshot = {
        schemaVersion: CACHE_SCHEMA_VERSION,
        keyDigest: keyDigest(key),
        connectionId: key.connectionId,
        pluginId: key.pluginId,
        pluginVersion: key.pluginVersion,
        fetchedAt: new Date(fetchedAt).toISOString(),
        expiresAt: new Date(fetchedAt + input.ttlMs).toISOString(),
        ...(input.etag === undefined ? {} : { etag: input.etag }),
        models: structuredClone([...input.models]),
      };
      const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
      if (Buffer.byteLength(serialized) > MAX_CACHE_BYTES) {
        throw new Error('Model catalog cache exceeds its size limit.');
      }
      await mkdir(this.directory, { recursive: true });
      const target = this.cachePath(key);
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      const previous = `${target}.previous`;
      const handle = await open(temporary, 'wx');
      try {
        await handle.writeFile(serialized, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      let movedPrevious = false;
      try {
        await rm(previous, { force: true });
        if (await exists(target)) {
          await rename(target, previous);
          movedPrevious = true;
        }
        await rename(temporary, target);
        await rm(previous, { force: true });
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        if (movedPrevious && !(await exists(target))) {
          await rename(previous, target).catch(() => undefined);
        }
        throw error;
      }
    });
  }

  private async enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeTail;
    let release!: () => void;
    this.writeTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function validateCacheWrite(input: LlmModelCatalogCacheWrite): void {
  if (!Number.isFinite(Date.parse(input.fetchedAt))) throw new Error('fetchedAt must be an ISO date.');
  if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) {
    throw new Error('ttlMs must be a positive integer.');
  }
  if (input.models.length > MAX_CACHED_MODELS) throw new Error('Too many cached models.');
  for (const model of input.models) {
    if (!model.modelId.trim() || !isRecord(model.metadata)) {
      throw new Error('Cached model entries require a modelId and metadata object.');
    }
  }
}

function validateCacheSnapshot(
  input: unknown,
  key: LlmModelCatalogCacheKey,
): LlmModelCatalogCacheSnapshot {
  if (!isRecord(input) || input.schemaVersion !== CACHE_SCHEMA_VERSION) {
    throw new Error('Unsupported model catalog cache schema.');
  }
  if (
    input.keyDigest !== keyDigest(key) ||
    input.connectionId !== key.connectionId ||
    input.pluginId !== key.pluginId ||
    input.pluginVersion !== key.pluginVersion ||
    typeof input.fetchedAt !== 'string' ||
    typeof input.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(input.fetchedAt)) ||
    !Number.isFinite(Date.parse(input.expiresAt)) ||
    !Array.isArray(input.models) ||
    input.models.length > MAX_CACHED_MODELS
  ) {
    throw new Error('Invalid model catalog cache contents.');
  }
  const models: LlmCachedEndpointModel[] = input.models.map((model) => {
    if (!isRecord(model) || typeof model.modelId !== 'string' || !model.modelId.trim() || !isRecord(model.metadata)) {
      throw new Error('Invalid cached model entry.');
    }
    return {
      modelId: model.modelId,
      metadata: structuredClone(model.metadata),
    };
  });
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    keyDigest: input.keyDigest,
    connectionId: input.connectionId,
    pluginId: input.pluginId,
    pluginVersion: input.pluginVersion,
    fetchedAt: input.fetchedAt,
    expiresAt: input.expiresAt,
    ...(typeof input.etag === 'string' ? { etag: input.etag } : {}),
    models,
  };
}

function keyDigest(key: LlmModelCatalogCacheKey): string {
  return createHash('sha256')
    .update(JSON.stringify([
      key.connectionId,
      key.credentialRevision,
      key.pluginId,
      key.pluginVersion,
      CACHE_SCHEMA_VERSION,
    ]))
    .digest('hex');
}

async function quarantine(path: string): Promise<void> {
  if (!(await exists(path))) return;
  await rename(path, `${path}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}`).catch(() => undefined);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isFileSystemError(error, 'ENOENT')) return false;
    throw error;
  }
}

function isFileSystemError(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
