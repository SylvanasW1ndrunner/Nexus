import { describe, expect, it } from 'vitest';
import { classifyPostgresConnectionError } from '../src/index.js';

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
