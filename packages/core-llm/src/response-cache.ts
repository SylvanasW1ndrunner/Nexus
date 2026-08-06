import { createHash } from 'node:crypto';
import { estimateRetainedValueBytes } from './retained-size.js';
import type { LlmChatRequest, LlmChatResponse } from './types.js';

type CacheEntry = {
  value: LlmChatResponse;
  expiresAt: number;
  accessedAt: number;
  byteSize: number;
};

export type LlmResponseCacheOptions = {
  maxEntries?: number;
  maxEntryBytes?: number;
  maxTotalBytes?: number;
  defaultTtlMs?: number;
  now?: () => number;
};

const DEFAULT_MAX_ENTRY_BYTES = 8 * 1_024 * 1_024;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1_024 * 1_024;

export class LlmResponseCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly maxEntryBytes: number;
  private readonly maxTotalBytes: number;
  private readonly defaultTtlMs: number;
  private readonly now: () => number;
  private totalBytes = 0;

  constructor(options: LlmResponseCacheOptions = {}) {
    this.maxEntries = positiveInteger(options.maxEntries ?? 500, 'maxEntries');
    this.maxEntryBytes = positiveInteger(
      options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES,
      'maxEntryBytes',
    );
    this.maxTotalBytes = positiveInteger(
      options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
      'maxTotalBytes',
    );
    this.defaultTtlMs = positiveInteger(options.defaultTtlMs ?? 300_000, 'defaultTtlMs');
    this.now = options.now ?? Date.now;
  }

  get(
    tenantId: string,
    providerId: string,
    request: LlmChatRequest,
    namespace = 'chat',
  ): LlmChatResponse | undefined {
    const key = this.key(tenantId, providerId, request, namespace);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const now = this.now();
    if (entry.expiresAt <= now) {
      this.remove(key);
      return undefined;
    }
    entry.accessedAt = now;
    return cloneResponse(entry.value);
  }

  set(
    tenantId: string,
    providerId: string,
    request: LlmChatRequest,
    response: LlmChatResponse,
    options: { namespace?: string; ttlMs?: number } = {},
  ): void {
    const now = this.now();
    const ttlMs = positiveInteger(options.ttlMs ?? this.defaultTtlMs, 'ttlMs');
    const key = this.key(tenantId, providerId, request, options.namespace ?? 'chat');
    const byteSize = estimateRetainedValueBytes(response, this.maxEntryBytes);
    if (byteSize > this.maxEntryBytes) {
      this.remove(key);
      return;
    }
    this.remove(key);
    this.entries.set(key, {
      value: cloneResponse(response),
      expiresAt: now + ttlMs,
      accessedAt: now,
      byteSize,
    });
    this.totalBytes += byteSize;
    this.evictExpired(now);
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxTotalBytes) {
      this.evictLeastRecentlyUsed();
    }
  }

  deleteTenant(tenantId: string): number {
    const prefix = `${hash(tenantId)}:`;
    let removed = 0;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.remove(key);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  size(): number {
    this.evictExpired(this.now());
    return this.entries.size;
  }

  private key(
    tenantId: string,
    providerId: string,
    request: LlmChatRequest,
    namespace: string,
  ): string {
    if (!tenantId.trim()) throw new Error('tenantId is required for cache isolation.');
    if (!providerId.trim()) throw new Error('providerId is required for cache isolation.');
    const cacheable = {
      namespace,
      model: request.model,
      messages: request.messages,
      tools: request.tools ?? [],
      temperature: request.temperature,
      topP: request.topP,
      maxTokens: request.maxTokens,
      responseFormat: request.responseFormat,
      reasoning: request.reasoning,
      stop: request.stop,
      seed: request.seed,
    };
    return `${hash(tenantId)}:${hash(providerId)}:${hash(stableStringify(cacheable))}`;
  }

  private evictExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.remove(key);
    }
  }

  private evictLeastRecentlyUsed(): void {
    let oldestKey: string | undefined;
    let oldestAccess = Number.POSITIVE_INFINITY;
    for (const [key, entry] of this.entries) {
      if (entry.accessedAt < oldestAccess) {
        oldestAccess = entry.accessedAt;
        oldestKey = key;
      }
    }
    if (oldestKey) this.remove(oldestKey);
  }

  private remove(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.totalBytes -= entry.byteSize;
    return true;
  }
}

function cloneResponse(response: LlmChatResponse): LlmChatResponse {
  return structuredClone(response);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer.`);
  return value;
}
