import { describe, expect, it } from 'vitest';
import type { AppError, SqlPerformanceWarning } from '@dbagent/shared';
import { formatAppError, summarizePerformanceWarnings } from './diagnostics.js';

describe('renderer diagnostics', () => {
  it('turns remote PostgreSQL timeout errors into actionable guidance', () => {
    const error: AppError = {
      code: 'DB_CONNECTION_TIMEOUT',
      message: 'Connection timed out.',
      detail: 'timeout expired',
      retryable: true,
    };

    expect(formatAppError(error)).toContain('VPN');
    expect(formatAppError(error)).toContain('firewall');
    expect(formatAppError(error)).toContain('retry');
  });

  it('explains when the local auth PostgreSQL database is not configured', () => {
    expect(
      formatAppError({
        code: 'AUTH_DATABASE_UNAVAILABLE',
        message: 'Authentication requires a PostgreSQL account database.',
        detail: 'Authentication requires DBAGENT_AUTH_DATABASE_URL pointing to a PostgreSQL database.',
      }),
    ).toContain('DBAGENT_AUTH_DATABASE_URL');
  });

  it('explains read-only blocks without losing database detail', () => {
    expect(
      formatAppError({
        code: 'READ_ONLY_VIOLATION',
        message: 'blocked',
        detail: 'DELETE is not allowed on a read-only connection.',
      }),
    ).toBe('Blocked by read-only mode. DELETE is not allowed on a read-only connection.');
  });

  it('formats confirmation-required errors with safety reasons', () => {
    expect(
      formatAppError({
        code: 'CONFIRMATION_REQUIRED',
        message: 'UPDATE requires explicit confirmation before execution.',
        detail: 'UPDATE writes data and requires explicit confirmation.',
      }),
    ).toBe(
      'UPDATE requires explicit confirmation before execution. UPDATE writes data and requires explicit confirmation.',
    );
  });

  it('summarizes mixed SQL performance warnings', () => {
    const warnings: SqlPerformanceWarning[] = [
      {
        code: 'MISSING_LIMIT',
        severity: 'warning',
        message: 'Query has no LIMIT.',
      },
      {
        code: 'SELECT_STAR',
        severity: 'info',
        message: 'Select only needed columns.',
      },
    ];

    expect(summarizePerformanceWarnings(warnings)).toEqual({
      title: '1 performance warnings / 1 optimization hints',
      items: warnings,
    });
  });
});
