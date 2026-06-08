import { describe, expect, it } from 'vitest';
import { validateConnectionInput } from './connection-validation.js';

const validInput = {
  name: 'Remote PostgreSQL',
  engine: 'postgres' as const,
  host: 'db.example.com',
  port: 5432,
  database: 'warehouse',
  username: 'analyst',
  readOnly: true,
  ssl: true,
  connectionTimeoutMs: 10000,
  statementTimeoutMs: 60000,
};

describe('validateConnectionInput', () => {
  it('accepts remote PostgreSQL options used by production users', () => {
    expect(validateConnectionInput(validInput)).toBeUndefined();
  });

  it('rejects connection timeouts outside the supported range', () => {
    expect(validateConnectionInput({ ...validInput, connectionTimeoutMs: 999 })).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Connection timeout must be between 1,000 and 120,000 milliseconds.',
    });
  });

  it('rejects statement timeouts outside the supported range', () => {
    expect(validateConnectionInput({ ...validInput, statementTimeoutMs: 120001 })).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Statement timeout must be between 1,000 and 120,000 milliseconds.',
    });
  });
});
