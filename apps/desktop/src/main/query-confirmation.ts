import type { AppError, QuerySafetyReport } from '@dbagent/shared';

export function confirmationRequiredError(safety: QuerySafetyReport): AppError | undefined {
  if (!safety.requiresConfirmation) return undefined;
  return {
    code: 'CONFIRMATION_REQUIRED',
    message: `${safety.statementKind} requires explicit confirmation before execution.`,
    detail: safety.reasons.join(' '),
    retryable: false,
  };
}
