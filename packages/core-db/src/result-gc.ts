import { DatabaseResultStoreError, type DatabaseResultGcOptions } from './result-store.js';

export const DEFAULT_STAGED_RESULT_TTL_MS = 60 * 60 * 1_000;
export const DEFAULT_RESULT_TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export type NormalizedResultGcOptions = {
  nowMs: number;
  stagedBeforeMs: number;
  tombstoneBeforeMs: number;
  maxBytes?: number;
  maxResults?: number;
};

export function normalizeResultGcOptions(
  options: DatabaseResultGcOptions,
  fallbackNow: Date,
): NormalizedResultGcOptions {
  const now = options.now ?? fallbackNow;
  if (!Number.isFinite(now.getTime())) invalid('now must be a valid Date.');
  const stagedTtlMs = options.stagedTtlMs ?? DEFAULT_STAGED_RESULT_TTL_MS;
  if (!Number.isSafeInteger(stagedTtlMs) || stagedTtlMs < 0) {
    invalid('stagedTtlMs must be a non-negative safe integer.');
  }
  if (options.maxBytes !== undefined &&
      (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)) {
    invalid('maxBytes must be a non-negative safe integer.');
  }
  if (options.maxResults !== undefined &&
      (!Number.isSafeInteger(options.maxResults) || options.maxResults < 0)) {
    invalid('maxResults must be a non-negative safe integer.');
  }
  const tombstoneTtlMs = options.tombstoneTtlMs ?? DEFAULT_RESULT_TOMBSTONE_TTL_MS;
  if (!Number.isSafeInteger(tombstoneTtlMs) || tombstoneTtlMs < 0) {
    invalid('tombstoneTtlMs must be a non-negative safe integer.');
  }
  return {
    nowMs: now.getTime(),
    stagedBeforeMs: now.getTime() - stagedTtlMs,
    tombstoneBeforeMs: now.getTime() - tombstoneTtlMs,
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    ...(options.maxResults === undefined ? {} : { maxResults: options.maxResults }),
  };
}

function invalid(message: string): never {
  throw new DatabaseResultStoreError('INVALID_ARGUMENT', message);
}
