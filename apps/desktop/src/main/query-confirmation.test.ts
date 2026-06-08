import { describe, expect, it } from 'vitest';
import { analyzeSqlSafety } from '@dbagent/core-db';
import { confirmationRequiredError } from './query-confirmation.js';

describe('confirmationRequiredError', () => {
  it('requires explicit confirmation for writable SQL on writable connections', () => {
    const safety = analyzeSqlSafety("update users set city = 'Shanghai' where id = 1", { readOnly: false });

    expect(confirmationRequiredError(safety)).toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
      message: 'UPDATE requires explicit confirmation before execution.',
      retryable: false,
    });
  });

  it('does not require confirmation for safe reads', () => {
    const safety = analyzeSqlSafety('select * from users limit 10', { readOnly: true });

    expect(confirmationRequiredError(safety)).toBeUndefined();
  });
});
