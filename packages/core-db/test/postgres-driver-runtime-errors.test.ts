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

  it('requires confirmation for write SQL before hitting the PostgreSQL pool', async () => {
    const driver = driverWithQueryError(pgError('ECONNRESET'));

    const result = await driver.execute(
      {
        connectionId: connection.id,
        sql: "update users set status = 'inactive' where id = 1",
      },
      { ...connection, readOnly: false },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
    });
  });

  it('blocks read-only multi-statement batches when a later statement writes data before hitting the pool', async () => {
    const driver = driverWithQueryError(pgError('ECONNRESET'));

    const result = await driver.execute(
      {
        connectionId: connection.id,
        sql: "select count(*) from users; update users set status = 'inactive' where id = 1;",
        confirmed: true,
        transactionMode: 'rollback',
      },
      connection,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: 'READ_ONLY_VIOLATION',
    });
  });

  it('passes parameterized query values to the PostgreSQL pool', async () => {
    const calls: unknown[][] = [];
    const driver = new PostgresDriver();
    const pool = {
      connect() {
        return Promise.resolve({
          processID: 1201,
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
          release() {},
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
      ['BEGIN READ ONLY'],
      [expect.stringMatching(/^DECLARE dbagent_cursor_[a-f0-9]+ NO SCROLL CURSOR FOR select email from users where email like \$1 limit 10$/), ["%' OR 1=1 --"]],
      [expect.stringMatching(/^FETCH FORWARD 10001 FROM dbagent_cursor_[a-f0-9]+$/), undefined],
      [expect.stringMatching(/^CLOSE dbagent_cursor_[a-f0-9]+$/)],
      ['COMMIT'],
    ]);
  });

  it('applies a positive per-query timeout inside the server-side read transaction', async () => {
    const calls: unknown[][] = [];
    const driver = new PostgresDriver();
    const pool = {
      connect() {
        return Promise.resolve({
          processID: 1201,
          query(...args: unknown[]) {
            calls.push(args);
            return Promise.resolve({
              command: 'SELECT',
              rowCount: 1,
              oid: 0,
              fields: [{ name: 'value', dataTypeID: 23 }],
              rows: [{ value: 1 }],
            });
          },
          release() {},
        });
      },
    };
    (driver as unknown as { pools: Map<string, unknown> }).pools.set(connection.id, pool);

    const result = await driver.execute(
      {
        connectionId: connection.id,
        sql: 'select 1 as value',
        timeoutMs: 250,
      },
      { ...connection, statementTimeoutMs: 5_000 },
    );

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      ['BEGIN READ ONLY'],
      ["select set_config('statement_timeout', $1, true)", ['250ms']],
      [expect.stringMatching(/^DECLARE dbagent_cursor_[a-f0-9]+ NO SCROLL CURSOR FOR select 1 as value$/), undefined],
      [expect.stringMatching(/^FETCH FORWARD 10001 FROM dbagent_cursor_[a-f0-9]+$/), undefined],
      [expect.stringMatching(/^CLOSE dbagent_cursor_[a-f0-9]+$/)],
      ['COMMIT'],
    ]);
  });

  it('rejects invalid per-query timeouts before acquiring a PostgreSQL client', async () => {
    const driver = driverWithQueryError(pgError('ECONNRESET'));
    const result = await driver.execute(
      {
        connectionId: connection.id,
        sql: 'select 1',
        timeoutMs: 0,
      },
      connection,
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
      },
    });
  });

  it('preserves caller-provided query id in execution result', async () => {
    const driver = new PostgresDriver();
    const pool = {
      connect() {
        return Promise.resolve({
          processID: 1201,
          query() {
            return Promise.resolve({
              command: 'SELECT',
              rowCount: 1,
              oid: 0,
              fields: [{ name: 'value', dataTypeID: 23 }],
              rows: [{ value: 1 }],
            });
          },
          release() {},
        });
      },
    };
    (driver as unknown as { pools: Map<string, unknown> }).pools.set(connection.id, pool);

    const result = await driver.execute(
      {
        queryId: 'query-caller-1',
        connectionId: connection.id,
        sql: 'select 1 as value',
      },
      connection,
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        queryId: 'query-caller-1',
      },
    });
  });

  it('limits returned rows and reports truncation metadata before results cross public API boundaries', async () => {
    const driver = new PostgresDriver();
    const pool = {
      connect() {
        return Promise.resolve({
          processID: 1201,
          query() {
            return Promise.resolve({
              command: 'SELECT',
              rowCount: 4,
              oid: 0,
              fields: [{ name: 'id', dataTypeID: 23 }],
              rows: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
            });
          },
          release() {},
        });
      },
    };
    (driver as unknown as { pools: Map<string, unknown> }).pools.set(connection.id, pool);

    const result = await driver.execute(
      {
        connectionId: connection.id,
        sql: 'select id from large_events order by id',
        limit: 2,
      },
      connection,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      rowCount: 4,
      returnedRowCount: 2,
      rowLimit: 2,
      truncated: true,
      rows: [{ id: 1 }, { id: 2 }],
    });
    expect(result.data.messages).toEqual([
      expect.objectContaining({
        level: 'warning',
        message: 'Statement 1 returned 4 row(s); only 2 row(s) are included because of the row limit.',
      }),
    ]);
  });

  it('executes rollback transaction mode without committing changes', async () => {
    const driver = new PostgresDriver();
    const calls: string[] = [];
    const pool = {
      connect() {
        return Promise.resolve({
          processID: 1201,
          query(sql: string) {
            calls.push(sql);
            if (sql === 'BEGIN' || sql === 'ROLLBACK') {
              return Promise.resolve({
                command: sql,
                rowCount: null,
                oid: 0,
                fields: [],
                rows: [],
              });
            }
            return Promise.resolve({
              command: 'SELECT',
              rowCount: 1,
              oid: 0,
              fields: [{ name: 'affected_count', dataTypeID: 23 }],
              rows: [{ affected_count: 2 }],
            });
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
        sql: 'select count(*)::int as affected_count from orders',
        transactionMode: 'rollback',
      },
      connection,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toEqual(['BEGIN', 'select count(*)::int as affected_count from orders', 'ROLLBACK', 'release']);
    expect(result.data.transaction).toEqual({
      mode: 'rollback',
      started: true,
      committed: false,
      rolledBack: true,
      rollbackOnly: true,
    });
    expect(result.data.rows).toEqual([{ affected_count: 2 }]);
  });

  it('maps legacy dryRun to rollback mode and rejects conflicting transaction modes', async () => {
    const driver = new PostgresDriver();
    const calls: string[] = [];
    const pool = {
      connect() {
        return Promise.resolve({
          processID: 1201,
          query(sql: string) {
            calls.push(sql);
            return Promise.resolve({
              command: sql === 'select 1 as value' ? 'SELECT' : sql,
              rowCount: 1,
              oid: 0,
              fields: sql === 'select 1 as value' ? [{ name: 'value', dataTypeID: 23 }] : [],
              rows: sql === 'select 1 as value' ? [{ value: 1 }] : [],
            });
          },
          release() {
            calls.push('release');
          },
        });
      },
    };
    (driver as unknown as { pools: Map<string, unknown> }).pools.set(connection.id, pool);

    const dryRunResult = await driver.execute(
      {
        connectionId: connection.id,
        sql: 'select 1 as value',
        dryRun: true,
      },
      connection,
    );
    const conflictResult = await driver.execute(
      {
        connectionId: connection.id,
        sql: 'select 1 as value',
        dryRun: true,
        transactionMode: 'auto',
      },
      connection,
    );

    expect(dryRunResult.ok).toBe(true);
    if (!dryRunResult.ok) return;
    expect(dryRunResult.data.transaction).toMatchObject({ mode: 'rollback', rolledBack: true });
    expect(conflictResult.ok).toBe(false);
    if (conflictResult.ok) return;
    expect(conflictResult.error.code).toBe('VALIDATION_ERROR');
  });

  it('still requires confirmation before rollback-testing writes', async () => {
    const driver = driverWithQueryError(pgError('ECONNRESET'));

    const result = await driver.execute(
      {
        connectionId: connection.id,
        sql: "update users set status = 'inactive' where id = 1",
        transactionMode: 'rollback',
      },
      { ...connection, readOnly: false },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
    });
  });

  it('rejects PostgreSQL statements that cannot run inside rollback preview transactions', async () => {
    const driver = driverWithQueryError(pgError('ECONNRESET'));

    const result = await driver.execute(
      {
        connectionId: connection.id,
        sql: 'vacuum users',
        confirmed: true,
        transactionMode: 'rollback',
      },
      { ...connection, readOnly: false },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
      message: 'This PostgreSQL statement cannot run inside a rollback preview transaction.',
    });
  });

  it('rejects parameterized multi-statement batches before reaching PostgreSQL', async () => {
    const driver = driverWithQueryError(pgError('ECONNRESET'));

    const result = await driver.execute(
      {
        connectionId: connection.id,
        sql: 'select $1::int as first_value; select $2::int as second_value;',
        params: [1, 2],
        confirmed: true,
      },
      { ...connection, readOnly: false },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
      message: 'Parameterized multi-statement SQL is not supported.',
    });
  });

  it('reports committed transaction metadata for confirmed writes', async () => {
    const driver = new PostgresDriver();
    const calls: string[] = [];
    const pool = {
      connect() {
        return Promise.resolve({
          processID: 1201,
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
            return Promise.resolve({
              command: 'UPDATE',
              rowCount: 2,
              oid: 0,
              fields: [],
              rows: [],
            });
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
        sql: "update orders set status = 'paid' where status = 'pending'",
        confirmed: true,
      },
      { ...connection, readOnly: false },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toEqual(['BEGIN', "update orders set status = 'paid' where status = 'pending'", 'COMMIT', 'release']);
    expect(result.data.transaction).toEqual({
      mode: 'auto',
      started: true,
      committed: true,
      rolledBack: false,
      rollbackOnly: false,
    });
  });

  it('calls PostgreSQL pg_cancel_backend for backend cancellation', async () => {
    const calls: unknown[][] = [];
    const driver = new PostgresDriver();
    const pool = {
      query(...args: unknown[]) {
        calls.push(args);
        return Promise.resolve({
          command: 'SELECT',
          rowCount: 1,
          oid: 0,
          fields: [{ name: 'cancelled', dataTypeID: 16 }],
          rows: [{ cancelled: true }],
        });
      },
    };
    (driver as unknown as { pools: Map<string, unknown> }).pools.set(connection.id, pool);

    const result = await driver.cancel(
      {
        queryId: 'query-cancel-1',
        connectionId: connection.id,
        decision: 'cancel-backend',
        backendPid: 1201,
        message: 'cancel',
      },
      connection,
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        decision: 'cancel-backend',
        backendPid: 1201,
      },
    });
    expect(calls).toEqual([['select pg_cancel_backend($1) as cancelled', [1201]]]);
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
          processID: 1201,
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

  it('applies row limits independently to every multi-statement result set', async () => {
    const driver = new PostgresDriver();
    const multiResult = [
      {
        command: 'SELECT',
        rowCount: 3,
        oid: 0,
        fields: [{ name: 'first_id', dataTypeID: 23 }],
        rows: [{ first_id: 1 }, { first_id: 2 }, { first_id: 3 }],
      },
      {
        command: 'SELECT',
        rowCount: 4,
        oid: 0,
        fields: [{ name: 'second_id', dataTypeID: 23 }],
        rows: [{ second_id: 10 }, { second_id: 11 }, { second_id: 12 }, { second_id: 13 }],
      },
    ];
    const pool = {
      connect() {
        return Promise.resolve({
          processID: 1201,
          query(sql: string) {
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
          release() {},
        });
      },
    };
    (driver as unknown as { pools: Map<string, unknown> }).pools.set(connection.id, pool);

    const result = await driver.execute(
      {
        connectionId: connection.id,
        sql: 'select first_id from first_table; select second_id from second_table;',
        confirmed: true,
        limit: 2,
      },
      { ...connection, readOnly: false },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.resultSets).toEqual([
      expect.objectContaining({
        rowCount: 3,
        returnedRowCount: 2,
        rowLimit: 2,
        truncated: true,
        rows: [{ first_id: 1 }, { first_id: 2 }],
      }),
      expect.objectContaining({
        rowCount: 4,
        returnedRowCount: 2,
        rowLimit: 2,
        truncated: true,
        rows: [{ second_id: 10 }, { second_id: 11 }],
      }),
    ]);
    expect(result.data.messages).toEqual([
      expect.objectContaining({ level: 'warning', statementIndex: 0 }),
      expect.objectContaining({ level: 'warning', statementIndex: 1 }),
      expect.objectContaining({ level: 'info', statementIndex: 0 }),
      expect.objectContaining({ level: 'info', statementIndex: 1 }),
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
    connect() {
      return Promise.resolve({
        processID: 1201,
        query() {
          return Promise.reject(error);
        },
        release() {},
      });
    },
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
