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

  it.each([
    ['42601', 'syntax error at or near "fromm"'],
    ['42703', 'column "missing_column" does not exist'],
    ['42P01', 'relation "missing_table" does not exist'],
  ])('classifies SQLSTATE %s statement validation errors as correctable SQL input', (code, detail) => {
    expect(classifyPostgresRuntimeError(pgError(code, detail))).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'PostgreSQL rejected invalid SQL.',
      detail,
      retryable: false,
    });
  });

  it('classifies user-cancelled PostgreSQL queries separately from failures', () => {
    expect(
      classifyPostgresRuntimeError(pgError('57014', 'canceling statement due to user request')),
    ).toMatchObject({
      code: 'QUERY_CANCELLED',
      detail: 'canceling statement due to user request',
      retryable: false,
    });
  });

  it('classifies PostgreSQL read-only transaction violations', () => {
    expect(
      classifyPostgresRuntimeError(
        pgError('25006', 'cannot execute INSERT in a read-only transaction'),
      ),
    ).toMatchObject({
      code: 'READ_ONLY_VIOLATION',
      retryable: false,
    });
  });

  it('classifies server and client query timeouts separately from network timeouts', () => {
    expect(
      classifyPostgresRuntimeError(
        pgError('57014', 'canceling statement due to statement timeout'),
      ),
    ).toMatchObject({
      code: 'QUERY_TIMEOUT',
      retryable: false,
    });
    expect(classifyPostgresRuntimeError(new Error('Query read timeout'))).toMatchObject({
      code: 'QUERY_TIMEOUT',
      retryable: false,
    });
    expect(
      classifyPostgresRuntimeError(
        Object.assign(new Error('localized timeout'), {
          code: 'DBAGENT_QUERY_TIMEOUT',
          detail: '由于语句执行超时，正在取消查询命令',
        }),
      ),
    ).toMatchObject({
      code: 'QUERY_TIMEOUT',
      detail: '由于语句执行超时，正在取消查询命令',
    });
  });
});
