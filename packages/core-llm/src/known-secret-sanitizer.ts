import { LlmProviderError } from './types.js';

export function redactKnownSecrets(value: string, secrets: Iterable<string | undefined>): string {
  let sanitized = value;
  for (const secret of secrets) {
    if (secret) sanitized = sanitized.split(secret).join('[REDACTED]');
  }
  return sanitized;
}

export function sanitizeKnownSecretError(
  error: LlmProviderError,
  secrets: Iterable<string | undefined>,
): LlmProviderError {
  const knownSecrets = [...secrets];
  const message = redactKnownSecrets(error.message, knownSecrets);
  const detail = sanitizeDetail(error.detail, knownSecrets);
  if (message === error.message && detail === error.detail) return error;
  return new LlmProviderError(error.code, message, error.retryable, error.statusCode, detail);
}

function sanitizeDetail(
  detail: Record<string, unknown> | undefined,
  secrets: readonly (string | undefined)[],
): Record<string, unknown> | undefined {
  if (detail === undefined) return undefined;
  const sanitized = sanitizeValue(detail, secrets, new WeakMap<object, unknown>());
  return sanitized as Record<string, unknown>;
}

function sanitizeValue(
  value: unknown,
  secrets: readonly (string | undefined)[],
  seen: WeakMap<object, unknown>,
): unknown {
  if (typeof value === 'string') return redactKnownSecrets(value, secrets);
  if (Array.isArray(value)) {
    const cached = seen.get(value);
    if (cached !== undefined) return cached;
    const result: unknown[] = [];
    seen.set(value, result);
    for (const item of value) result.push(sanitizeValue(item, secrets, seen));
    return result;
  }
  if (value && typeof value === 'object') {
    const cached = seen.get(value);
    if (cached !== undefined) return cached;
    const result: Record<string, unknown> = {};
    seen.set(value, result);
    for (const [key, item] of Object.entries(value))
      result[key] = sanitizeValue(item, secrets, seen);
    return result;
  }
  return value;
}
