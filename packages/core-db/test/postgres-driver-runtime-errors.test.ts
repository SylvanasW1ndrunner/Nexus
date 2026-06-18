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
  it('rejects empty SQL as validation without hitting the pool', async () => {
    const driver = driverWithQueryError(pgError('ECONNRESET'));

    const result = await driver.execute(
      {
        connectionId: connection.id,
        sql: '/* comment only */',
      },
      connection,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'SQL is empty.',
    });
  });

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

  it('passes parameterized query values to the PostgreSQL pool', async () => {
    const calls: unknown[][] = [];
    const driver = new PostgresDriver();
    const pool = {
      query(...args: unknown[]) {
        calls.push(args);
        return Promise.resolve({
          command: 'SELECT',
          rowCount: 1,
          oid: 0,
          fields: [{ name: 'email', dataTypeID: 25 }],
          rows: [{ email: 'alice@example.com' }],
        });
      },
    };
    (driver as unknown as { pools: Map<string, unknown> }).pools.set(connection.id, pool);

    const result = await driver.execute(
      {
        connectionId: connection.id,
        sql: 'select email from users where email like $1 limit 10',
        params: ["%' OR 1=1 --"],
      },
      connection,
    );

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      ['select email from users where email like $1 limit 10', ["%' OR 1=1 --"]],
    ]);
  });

  it('preserves multi-statement result sets and user-visible messages', async () => {
    const driver = new PostgresDriver();
    const calls: string[] = [];
    const multiResult = [
      {
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [{ name: 'user_count', dataTypeID: 23 }],
        rows: [{ user_count: 3 }],
      },
      {
        command: 'UPDATE',
        rowCount: 2,
        oid: 0,
        fields: [],
        rows: [],
      },
      {
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [{ name: 'order_count', dataTypeID: 23 }],
        rows: [{ order_count: 7 }],
      },
    ];
    const pool = {
      connect() {
        return Promise.resolve({
          query(sql: string) {
            calls.push(sql);
            if (sql === 'BEGIN' || sql === 'COMMIT') {
              return Promise.resolve({
                command: sql,
                rowCount: null,
                oid: 0,
                fields: [],
                rows: [],
              });
            }
            return Promise.resolve(multiResult);
          },
          release() {
            calls.push('release');
          },
        });
      },
    };
    (driver as unknown as { pools: Map<string, unknown> }).pools.set(connection.id, pool);

    const result = await driver.execute(
      {
        connectionId: connection.id,
        sql: 'select count(*) as user_count from users; update audit set touched = true; select count(*) as order_count from orders;',
        confirmed: true,
      },
      { ...connection, readOnly: false },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toEqual([
      'BEGIN',
      'select count(*) as user_count from users; update audit set touched = true; select count(*) as order_count from orders;',
      'COMMIT',
      'release',
    ]);
    expect(result.data.columns.map((column) => column.name)).toEqual(['user_count']);
    expect(result.data.rows).toEqual([{ user_count: 3 }]);
    expect(result.data.resultSets).toEqual([
      expect.objectContaining({
        index: 0,
        command: 'SELECT',
        columns: [{ name: 'user_count', dataType: '23' }],
        rows: [{ user_count: 3 }],
        rowCount: 1,
      }),
      expect.objectContaining({
        index: 1,
        command: 'UPDATE',
        columns: [],
        rows: [],
        rowCount: 2,
      }),
      expect.objectContaining({
        index: 2,
        command: 'SELECT',
        columns: [{ name: 'order_count', dataType: '23' }],
        rows: [{ order_count: 7 }],
        rowCount: 1,
      }),
    ]);
    expect(result.data.messages?.map((message) => message.message)).toEqual([
      'Statement 1 returned 1 row(s).',
      'Statement 2 completed with command UPDATE and affected 2 row(s).',
      'Statement 3 returned 1 row(s).',
    ]);
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
