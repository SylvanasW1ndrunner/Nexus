import { describe, expect, it } from 'vitest';
import { PostgresDriver } from '../src/postgres-driver.js';

const connection = {
  id: 'remote-runtime-error',
  name: 'Remote PostgreSQL',
  engine: 'postgres' as const,
  host: 'db.example.com',
  port: 5432,
  database: 'analytics',
  username: 'analyst',
  ssl: true,
  readOnly: true,
  status: 'connected' as const,
  createdAt: '2026-06-08T00:00:00.000Z',
  updatedAt: '2026-06-08T00:00:00.000Z',
};

describe('PostgresDriver runtime errors', () => {
  it('classifies interrupted execute calls without throwing outside Result', async () => {
    const driver = driverWithQueryError(pgError('ECONNRESET'));

    const result = await driver.execute(
      {
        connectionId: connection.id,
        sql: 'select * from orders limit 10',
      },
      connection,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: 'DB_CONNECTION_INTERRUPTED',
      retryable: true,
    });
  });

  it('classifies schema list timeouts without throwing outside Result', async () => {
    const driver = driverWithQueryError(pgError('ETIMEDOUT'));

    const result = await driver.listTables(connection.id);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: 'DB_CONNECTION_TIMEOUT',
      retryable: true,
    });
  });

  it('classifies schema describe query failures without throwing outside Result', async () => {
    const driver = driverWithQueryError(pgError('42601', 'syntax error in metadata query'));

    const result = await driver.describeTable(connection.id, 'public', 'orders');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: 'QUERY_FAILED',
      detail: 'syntax error in metadata query',
      retryable: false,
    });
  });
});

function driverWithQueryError(error: Error & { code: string }): PostgresDriver {
  const driver = new PostgresDriver();
  const pool = {
    query() {
      return Promise.reject(error);
    },
  };
  (driver as unknown as { pools: Map<string, unknown> }).pools.set(connection.id, pool);
  return driver;
}

function pgError(code: string, message = code): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
