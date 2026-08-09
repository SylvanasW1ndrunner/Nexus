import type { ValidatedModelAttempt } from './envelope.js';

const authenticAttemptDigests = new WeakMap<object, string>();

/** @internal Gateway-only mint. This module is intentionally not a package subpath export. */
export function mintAuthenticValidatedModelAttempt(
  attempt: ValidatedModelAttempt,
): ValidatedModelAttempt {
  authenticAttemptDigests.set(attempt, canonicalJson(attempt));
  return attempt;
}

export function assertAuthenticValidatedModelAttempt(
  attempt: unknown,
): asserts attempt is ValidatedModelAttempt {
  if (typeof attempt !== 'object' || attempt === null) {
    throw new TypeError('ValidatedModelAttempt is not an authentic ModelExecutionGateway result.');
  }
  const expectedDigest = authenticAttemptDigests.get(attempt);
  if (expectedDigest === undefined || canonicalJson(attempt) !== expectedDigest) {
    throw new TypeError(
      'ValidatedModelAttempt is not an authentic unmodified ModelExecutionGateway result.',
    );
  }
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}
