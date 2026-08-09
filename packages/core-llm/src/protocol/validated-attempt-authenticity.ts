import type { ValidatedModelAttempt } from './envelope.js';

const authenticAttempts = new WeakSet<object>();

/** @internal Gateway-only mint. This module is intentionally not a package subpath export. */
export function mintAuthenticValidatedModelAttempt(
  attempt: ValidatedModelAttempt,
): ValidatedModelAttempt {
  authenticAttempts.add(attempt);
  return attempt;
}

export function assertAuthenticValidatedModelAttempt(
  attempt: unknown,
): asserts attempt is ValidatedModelAttempt {
  if (typeof attempt !== 'object' || attempt === null || !authenticAttempts.has(attempt)) {
    throw new TypeError('ValidatedModelAttempt is not an authentic ModelExecutionGateway result.');
  }
}
