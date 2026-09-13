import { LlmProviderError } from './types.js';

export function redactKnownCookies(value: string, cookies: Iterable<string | undefined>): string {
  let redacted = value;
  for (const cookie of cookies) {
    if (cookie) redacted = redacted.split(cookie).join('[REDACTED]');
  }
  return redacted;
}
export function collectKnownCookieValues(headers: Readonly<Record<string, string>>): readonly string[] {
  const cookies = new Set<string>();
  for (const [name, rawValue] of Object.entries(headers)) {
    if (!/^cookie$/i.test(name)) continue;
    const value = rawValue.trim();
    if (!value) continue;
    cookies.add(value);
    for (const part of value.split(';')) {
      const cookieValue = /^[^=]+=(.*)$/.exec(part.trim())?.[1]?.trim();
      if (cookieValue) cookies.add(cookieValue);
    }
  }
  return [...cookies].sort((left, right) => right.length - left.length);
}

export function sanitizeKnownCookieError(
  error: LlmProviderError,
  cookies: Iterable<string | undefined>,
): LlmProviderError {
  const knownCookies = [...cookies];
  const message = redactKnownCookies(error.message, knownCookies);
  const detail = sanitizeDetail(error.detail, knownCookies);
  if (message === error.message && detail === error.detail) return error;
  return new LlmProviderError(error.code, message, error.retryable, error.statusCode, detail);
}

function sanitizeDetail(
  detail: Record<string, unknown> | undefined,
  cookies: readonly (string | undefined)[],
): Record<string, unknown> | undefined {
  if (detail === undefined) return undefined;
  return sanitizeValue(detail, cookies, new WeakMap<object, unknown>()) as Record<string, unknown>;
}

function sanitizeValue(
  value: unknown,
  cookies: readonly (string | undefined)[],
  seen: WeakMap<object, unknown>,
): unknown {
  if (typeof value === 'string') return redactKnownCookies(value, cookies);
  if (Array.isArray(value)) {
    const cached = seen.get(value);
    if (cached !== undefined) return cached;
    const result: unknown[] = [];
    seen.set(value, result);
    for (const item of value) result.push(sanitizeValue(item, cookies, seen));
    return result;
  }
  if (value && typeof value === 'object') {
    const cached = seen.get(value);
    if (cached !== undefined) return cached;
    const result: Record<string, unknown> = {};
    seen.set(value, result);
    for (const [key, item] of Object.entries(value)) result[key] = sanitizeValue(item, cookies, seen);
    return result;
  }
  return value;
}
