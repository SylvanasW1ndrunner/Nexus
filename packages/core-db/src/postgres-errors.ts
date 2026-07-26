import type { AppError } from '@dbagent/shared';

const retryableNetworkCodes = new Set([
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ECONNREFUSED',
]);

export function classifyPostgresConnectionError(error: unknown): AppError {
  const code = getErrorCode(error);
  const message = error instanceof Error ? error.message : String(error);

  if (code === '28P01' || /password authentication failed/i.test(message)) {
    return {
      code: 'DB_AUTH_FAILED',
      message: 'PostgreSQL authentication failed.',
      detail: 'Check the username, password, and pg_hba.conf rules on the database server.',
      retryable: false,
    };
  }

  if (code === '3D000') {
    return {
      code: 'DB_DATABASE_NOT_FOUND',
      message: 'PostgreSQL database does not exist.',
      detail: 'Check the database name in the connection settings.',
      retryable: false,
    };
  }

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return {
      code: 'DB_HOST_UNRESOLVED',
      message: 'PostgreSQL host could not be resolved.',
      detail: 'Check DNS, VPN, hosts file, or the server hostname.',
      retryable: true,
    };
  }

  if (code === 'ECONNREFUSED') {
    return {
      code: 'DB_PORT_CLOSED',
      message: 'PostgreSQL port refused the connection.',
      detail:
        'Check that PostgreSQL is running, listening on the configured host/port, and allowed by the firewall.',
      retryable: true,
    };
  }

  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || /timeout/i.test(message)) {
    return {
      code: 'DB_CONNECTION_TIMEOUT',
      message: 'PostgreSQL connection timed out.',
      detail:
        'Check network reachability, VPN, security groups, firewall rules, and whether the server accepts remote TCP connections.',
      retryable: true,
    };
  }

  if (code === 'ECONNRESET' || code === 'EPIPE') {
    return {
      code: 'DB_CONNECTION_INTERRUPTED',
      message: 'PostgreSQL connection was interrupted.',
      detail:
        'The remote server or network closed the connection. Retry after checking VPN, proxy, and server logs.',
      retryable: true,
    };
  }

  return {
    code: 'CONNECTION_FAILED',
    message: 'Unable to connect to PostgreSQL.',
    detail: message,
    retryable: true,
  };
}

export function classifyPostgresRuntimeError(error: unknown): AppError {
  const code = getErrorCode(error);
  const message = error instanceof Error ? error.message : String(error);

  if (code === 'DBAGENT_QUERY_TIMEOUT') {
    return {
      code: 'QUERY_TIMEOUT',
      message: 'PostgreSQL query exceeded its execution timeout.',
      detail: getErrorDetail(error) ?? message,
      retryable: false,
    };
  }

  if (
    (code === '57014' && /statement timeout/i.test(message)) ||
    /query read timeout/i.test(message)
  ) {
    return {
      code: 'QUERY_TIMEOUT',
      message: 'PostgreSQL query exceeded its execution timeout.',
      detail: message,
      retryable: false,
    };
  }

  if (code && retryableNetworkCodes.has(code)) {
    return classifyPostgresConnectionError(error);
  }

  if (/timeout/i.test(message)) {
    return classifyPostgresConnectionError(error);
  }

  if (code === '57014' || /canceling statement due to user request/i.test(message)) {
    return {
      code: 'QUERY_CANCELLED',
      message: 'PostgreSQL query was cancelled.',
      detail: message,
      retryable: false,
    };
  }

  if (code === '25006' || /read-only transaction/i.test(message)) {
    return {
      code: 'READ_ONLY_VIOLATION',
      message: 'PostgreSQL rejected a write inside a read-only transaction.',
      detail: message,
      retryable: false,
    };
  }

  return {
    code: 'QUERY_FAILED',
    message: 'PostgreSQL query failed.',
    detail: message,
    retryable: false,
  };
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function getErrorDetail(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('detail' in error)) return undefined;
  const detail = (error as { detail?: unknown }).detail;
  return typeof detail === 'string' ? detail : undefined;
}
