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

  it('explains read-only blocks without losing database detail', () => {
    expect(
      formatAppError({
        code: 'READ_ONLY_VIOLATION',
        message: 'blocked',
        detail: 'DELETE is not allowed on a read-only connection.',
      }),
    ).toBe('Blocked by read-only mode. DELETE is not allowed on a read-only connection.');
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
