import { describe, expect, it } from 'vitest';
import { PostgresDriver } from '../src/index.js';
import type { DatabaseConnectionConfig } from '../src/index.js';

const runPostgresTests = process.env.DBAGENT_RUN_POSTGRES_TESTS === '1';

const config: DatabaseConnectionConfig = {
  id: 'integration-postgres',
  name: 'Integration PostgreSQL',
  engine: 'postgres',
  host: process.env.DBAGENT_TEST_PG_HOST ?? '127.0.0.1',
  port: Number(process.env.DBAGENT_TEST_PG_PORT ?? 5432),
  database: process.env.DBAGENT_TEST_PG_DATABASE ?? 'dbagent_demo',
  username: process.env.DBAGENT_TEST_PG_USER ?? 'postgres',
  password: process.env.DBAGENT_TEST_PG_PASSWORD ?? 'postgres',
  readOnly: true,
  maxClients: 2,
};

describe.skipIf(!runPostgresTests)('PostgresDriver real PostgreSQL integration', () => {
  it('connects, lists schema objects, executes a realistic join, blocks read-only writes, and disconnects', async () => {
    const driver = new PostgresDriver();

    const testResult = await driver.test(config);
    expect(testResult.ok).toBe(true);

    const connectResult = await driver.connect(config);
    expect(connectResult.ok).toBe(true);
    if (!connectResult.ok) return;

    const tablesResult = await driver.listTables(config.id);
    expect(tablesResult.ok).toBe(true);
    if (!tablesResult.ok) return;
    expect(tablesResult.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ schema: 'public', name: 'users', type: 'table' }),
        expect.objectContaining({ schema: 'public', name: 'orders', type: 'table' }),
      ]),
    );

    const queryResult = await driver.execute(
      {
        connectionId: config.id,
        sql: `
          select u.city, coalesce(sum(o.total_amount), 0)::numeric(12, 2) as revenue
          from users u
          left join orders o on o.user_id = u.id
          group by u.city
          order by u.city
        `,
      },
      connectResult.data,
    );
    expect(queryResult.ok).toBe(true);
    if (!queryResult.ok) return;
    expect(queryResult.data.columns.map((column) => column.name)).toEqual(['city', 'revenue']);
    expect(queryResult.data.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ city: 'Shanghai' }),
        expect.objectContaining({ city: 'Beijing' }),
      ]),
    );

    const blockedWrite = await driver.execute(
      {
        connectionId: config.id,
        sql: "delete from users where email = 'alice@example.com'",
      },
      connectResult.data,
    );
    expect(blockedWrite.ok).toBe(false);
    if (blockedWrite.ok) return;
    expect(blockedWrite.error.code).toBe('READ_ONLY_VIOLATION');

    await expect(driver.disconnect(config.id)).resolves.toEqual({ ok: true, data: undefined });

    const afterDisconnect = await driver.listTables(config.id);
    expect(afterDisconnect.ok).toBe(false);
    if (afterDisconnect.ok) return;
    expect(afterDisconnect.error.code).toBe('CONNECTION_FAILED');
  });

  it('rolls back failed write batches on writable connections', async () => {
    const driver = new PostgresDriver();
    const writableConfig = {
      ...config,
      id: 'integration-postgres-writable',
      readOnly: false,
    };

    const connectResult = await driver.connect(writableConfig);
    expect(connectResult.ok).toBe(true);
    if (!connectResult.ok) return;

    const tableName = `dbagent_rollback_probe_${Date.now()}`;
    const createResult = await driver.execute(
      {
        connectionId: writableConfig.id,
        sql: `create table ${tableName} (id integer primary key, label text not null);`,
      },
      connectResult.data,
    );
    expect(createResult.ok).toBe(true);

    try {
      const failedBatch = await driver.execute(
        {
          connectionId: writableConfig.id,
          sql: `
            insert into ${tableName} (id, label) values (1, 'should_rollback');
            insert into missing_table_for_rollback_probe (id) values (1);
          `,
        },
        connectResult.data,
      );
      expect(failedBatch.ok).toBe(false);

      const countResult = await driver.execute(
        {
          connectionId: writableConfig.id,
          sql: `select count(*)::int as count from ${tableName};`,
        },
        connectResult.data,
      );
      expect(countResult.ok).toBe(true);
      if (!countResult.ok) return;
      expect(countResult.data.rows).toEqual([expect.objectContaining({ count: 0 })]);
    } finally {
      await driver.execute(
        {
          connectionId: writableConfig.id,
          sql: `drop table if exists ${tableName};`,
        },
        connectResult.data,
      );
      await driver.disconnect(writableConfig.id);
    }
  });
});
