import { describe, expect, it } from 'vitest';
import { classifyPostgresConnectionError, classifyPostgresRuntimeError } from '../src/index.js';

function pgError(code: string, message = code) {
  return Object.assign(new Error(message), { code });
}

describe('classifyPostgresConnectionError', () => {
  it('classifies remote network and firewall failures', () => {
    expect(classifyPostgresConnectionError(pgError('ECONNREFUSED'))).toMatchObject({
      code: 'DB_PORT_CLOSED',
      retryable: true,
    });
    expect(classifyPostgresConnectionError(pgError('ETIMEDOUT'))).toMatchObject({
      code: 'DB_CONNECTION_TIMEOUT',
      retryable: true,
    });
    expect(classifyPostgresConnectionError(pgError('ENOTFOUND'))).toMatchObject({
      code: 'DB_HOST_UNRESOLVED',
      retryable: true,
    });
  });

  it('classifies credential and database-name failures as user-fixable non-retryable errors', () => {
    expect(classifyPostgresConnectionError(pgError('28P01'))).toMatchObject({
      code: 'DB_AUTH_FAILED',
      retryable: false,
    });
    expect(classifyPostgresConnectionError(pgError('3D000'))).toMatchObject({
      code: 'DB_DATABASE_NOT_FOUND',
      retryable: false,
    });
  });

  it('keeps unknown failures debuggable', () => {
    expect(classifyPostgresConnectionError(new Error('server requires SSL'))).toMatchObject({
      code: 'CONNECTION_FAILED',
      detail: 'server requires SSL',
    });
  });
});

describe('classifyPostgresRuntimeError', () => {
  it('keeps interrupted remote queries retryable and diagnosable', () => {
    expect(classifyPostgresRuntimeError(pgError('ECONNRESET'))).toMatchObject({
      code: 'DB_CONNECTION_INTERRUPTED',
      retryable: true,
    });
    expect(classifyPostgresRuntimeError(pgError('ETIMEDOUT'))).toMatchObject({
      code: 'DB_CONNECTION_TIMEOUT',
      retryable: true,
    });
  });

  it('keeps SQL and catalog errors as query failures', () => {
    expect(classifyPostgresRuntimeError(pgError('42601', 'syntax error at or near "fromm"'))).toMatchObject({
      code: 'QUERY_FAILED',
      detail: 'syntax error at or near "fromm"',
      retryable: false,
    });
  });

  it('classifies user-cancelled PostgreSQL queries separately from failures', () => {
    expect(classifyPostgresRuntimeError(pgError('57014', 'canceling statement due to user request'))).toMatchObject({
      code: 'QUERY_CANCELLED',
      detail: 'canceling statement due to user request',
      retryable: false,
    });
  });
});
