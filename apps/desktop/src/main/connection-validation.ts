import type { AppError, ConnectionInput } from '@dbagent/shared';

export function validateConnectionInput(input: ConnectionInput): AppError | undefined {
  if (!input.name.trim()) return { code: 'VALIDATION_ERROR', message: 'Connection name is required.' };
  if (!input.host.trim()) return { code: 'VALIDATION_ERROR', message: 'Host is required.' };
  if (!input.database.trim()) return { code: 'VALIDATION_ERROR', message: 'Database is required.' };
  if (!input.username.trim()) return { code: 'VALIDATION_ERROR', message: 'Username is required.' };
  if (input.port < 1 || input.port > 65535) {
    return { code: 'VALIDATION_ERROR', message: 'Port must be between 1 and 65535.' };
  }
  if (input.connectionTimeoutMs !== undefined && !isValidTimeout(input.connectionTimeoutMs)) {
    return {
      code: 'VALIDATION_ERROR',
      message: 'Connection timeout must be between 1,000 and 120,000 milliseconds.',
    };
  }
  if (input.statementTimeoutMs !== undefined && !isValidTimeout(input.statementTimeoutMs)) {
    return {
      code: 'VALIDATION_ERROR',
      message: 'Statement timeout must be between 1,000 and 120,000 milliseconds.',
    };
  }
  return undefined;
}

function isValidTimeout(value: number): boolean {
  return Number.isInteger(value) && value >= 1000 && value <= 120000;
}
