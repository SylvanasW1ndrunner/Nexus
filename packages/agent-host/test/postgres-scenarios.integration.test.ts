import { describe, expect, it } from 'vitest';

const databaseUrl = process.env.SCHEMANAUT_TEST_POSTGRES_URL;

describe('PostgreSQL database Capability scenarios', () => {
  it.skipIf(!databaseUrl)('keeps live scenarios behind the explicit PostgreSQL environment gate', () => {
    expect(databaseUrl).toBeTypeOf('string');
  });
});
