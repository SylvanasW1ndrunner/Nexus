import { LlmProviderError } from './types.js';

export const RETRYABLE_LLM_HTTP_STATUSES = new Set([408, 429, 502, 503, 504]);

export function retryAfterMilliseconds(
  value: string | null | undefined,
  nowMs = Date.now(),
): number | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  const seconds = Number(normalized);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const date = Date.parse(normalized);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - nowMs);
}

export function computeLlmRetryDelay(input: {
  attempt: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
  random: () => number;
  retryAfterMs?: number;
}): number {
  const exponential = input.baseDelayMs * 2 ** input.attempt;
  const jitter = exponential * input.jitterRatio * (input.random() * 2 - 1);
  const calculated = Math.max(0, exponential + jitter);
  return Math.min(
    input.maxDelayMs,
    Math.max(calculated, input.retryAfterMs ?? 0),
  );
}

export function retryDelayFromError(
  error: unknown,
  input: Omit<Parameters<typeof computeLlmRetryDelay>[0], 'retryAfterMs'>,
): number {
  const retryAfterMs =
    error instanceof LlmProviderError &&
    typeof error.detail?.retryAfterMs === 'number' &&
    Number.isFinite(error.detail.retryAfterMs)
      ? Math.max(0, error.detail.retryAfterMs)
      : undefined;
  return computeLlmRetryDelay({
    ...input,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}
