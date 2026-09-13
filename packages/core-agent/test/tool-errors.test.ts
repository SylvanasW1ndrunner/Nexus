import { describe, expect, it } from 'vitest';
import { expectedToolError } from '../src/index.js';
import { adaptToolHandlerFailure } from '../src/tools/tool-errors.js';

describe('Tool execution error contract', () => {
  it('persists stable expected boundary facts without provider details', () => {
    const error = expectedToolError('external', 'Database provider rejected the request.', {
      retryable: true,
    });

    expect(error).toMatchObject({ fact: {
      code: 'TOOL_EXTERNAL_FAILED', category: 'external', retryable: true,
      outcome: 'not_applied',
    } });
    expect(error.message).toBe('Database provider rejected the request.');
  });

  it('preserves a bounded unknown handler diagnostic', () => {
    const error = adaptToolHandlerFailure({
      error: new Error('postgres://user:secret@private-host:5432/database'),
      timedOut: false,
      cancelled: false,
    });

    expect(error).toMatchObject({ fact: {
      code: 'HANDLER_FAILED', category: 'internal', retryable: false, outcome: 'unknown',
    } });
    expect(error.message).toBe('postgres://user:secret@private-host:5432/database');
  });
});
