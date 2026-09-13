import { describe, expect, it } from 'vitest';

const databaseUrl = process.env.SCHEMANAUT_TEST_POSTGRES_URL;

describe('PostgreSQL database Capability integration', () => {
  it.skipIf(!databaseUrl)('runs only with an explicitly supplied external PostgreSQL context', () => {
    // Connection configuration is owned by an external provider fixture. The
    // default suite must not create profiles or load database tools implicitly.
    expect(databaseUrl).toBeTypeOf('string');
  });
});
