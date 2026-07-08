import { describe, expect, it } from 'vitest';
import { buildTableEditPreview, PostgresDriver } from '../src/index.js';
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

    const usersDetail = await driver.describeTable(config.id, 'public', 'users');
    expect(usersDetail.ok).toBe(true);
    if (!usersDetail.ok) return;
    expect(usersDetail.data.primaryKey).toEqual(['id']);
    expect(usersDetail.data.columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'id',
          dataType: 'bigint',
          isPrimaryKey: true,
          nullable: false,
        }),
        expect.objectContaining({
          name: 'email',
          dataType: 'text',
          isPrimaryKey: false,
          nullable: false,
        }),
      ]),
    );

    const ordersDetail = await driver.describeTable(config.id, 'public', 'orders');
    expect(ordersDetail.ok).toBe(true);
    if (!ordersDetail.ok) return;
    expect(ordersDetail.data.columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'user_id',
          foreignKey: { schema: 'public', table: 'users', column: 'id' },
        }),
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

    const describeAfterDisconnect = await driver.describeTable(config.id, 'public', 'users');
    expect(describeAfterDisconnect.ok).toBe(false);
    if (describeAfterDisconnect.ok) return;
    expect(describeAfterDisconnect.error.code).toBe('CONNECTION_FAILED');
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
        confirmed: true,
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
          confirmed: true,
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
          confirmed: true,
        },
        connectResult.data,
      );
      await driver.disconnect(writableConfig.id);
    }
  });

  it('supports rollback-only transaction previews for complex write batches', async () => {
    const driver = new PostgresDriver();
    const writableConfig = {
      ...config,
      id: 'integration-postgres-rollback-preview',
      readOnly: false,
    };

    const connectResult = await driver.connect(writableConfig);
    expect(connectResult.ok).toBe(true);
    if (!connectResult.ok) return;

    const tableName = `dbagent_rollback_preview_${Date.now()}`;

    try {
      const previewResult = await driver.execute(
        {
          connectionId: writableConfig.id,
          sql: `
            create table ${tableName} (
              id integer primary key,
              sku text not null,
              amount numeric not null check (amount >= 0)
            );
            insert into ${tableName} (id, sku, amount)
            values (1, 'sku-a', 12.50), (2, 'sku-b', 19.99);
            update ${tableName}
            set amount = amount * 1.1
            where sku = 'sku-b';
            select count(*)::int as row_count, round(sum(amount), 2)::text as total_amount
            from ${tableName};
          `,
          confirmed: true,
          transactionMode: 'rollback',
        },
        connectResult.data,
      );

      expect(previewResult.ok).toBe(true);
      if (!previewResult.ok) return;
      expect(previewResult.data.transaction).toEqual({
        mode: 'rollback',
        started: true,
        committed: false,
        rolledBack: true,
        rollbackOnly: true,
      });
      expect(previewResult.data.rows).toEqual([
        expect.objectContaining({ row_count: 2, total_amount: '34.49' }),
      ]);

      const tableExists = await driver.execute(
        {
          connectionId: writableConfig.id,
          sql: `select to_regclass('public.${tableName}') as table_name;`,
        },
        connectResult.data,
      );
      expect(tableExists.ok).toBe(true);
      if (!tableExists.ok) return;
      expect(tableExists.data.rows).toEqual([expect.objectContaining({ table_name: null })]);
    } finally {
      await driver.execute(
        {
          connectionId: writableConfig.id,
          sql: `drop table if exists ${tableName};`,
          confirmed: true,
        },
        connectResult.data,
      );
      await driver.disconnect(writableConfig.id);
    }
  });

  it('uses cursor pagination for large read queries without materializing the full result', async () => {
    const driver = new PostgresDriver();

    const connectResult = await driver.connect(config);
    expect(connectResult.ok).toBe(true);
    if (!connectResult.ok) return;

    try {
      const result = await driver.execute(
        {
          connectionId: config.id,
          sql: `
            select
              value::int as event_id,
              ('tenant-' || (value % 7)) as tenant_key,
              jsonb_build_object('event', 'page_view', 'value', value) as payload
            from generate_series(1, 15005) as value
            order by value
          `,
          limit: 25,
        },
        connectResult.data,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.rows).toHaveLength(25);
      expect(result.data.rows[0]).toMatchObject({ event_id: 1, tenant_key: 'tenant-1' });
      expect(result.data.rows[24]).toMatchObject({ event_id: 25 });
      expect(result.data.returnedRowCount).toBe(25);
      expect(result.data.rowLimit).toBe(25);
      expect(result.data.hasMore).toBe(true);
      expect(result.data.truncated).toBe(true);
      expect(result.data.rowCount).toBe(26);
      expect(result.data.messages).toEqual([
        expect.objectContaining({
          level: 'warning',
          message: 'Statement 1 returned 26 row(s); only 25 row(s) are included because of the row limit.',
        }),
      ]);
    } finally {
      await driver.disconnect(config.id);
    }
  });

  it('describes PostgreSQL indexes, constraints, view definitions, and row estimates', async () => {
    const driver = new PostgresDriver();
    const writableConfig = {
      ...config,
      id: 'integration-postgres-catalog-metadata',
      readOnly: false,
    };

    const connectResult = await driver.connect(writableConfig);
    expect(connectResult.ok).toBe(true);
    if (!connectResult.ok) return;

    const suffix = Date.now();
    const tableName = `dbagent_catalog_probe_${suffix}`;
    const viewName = `dbagent_catalog_probe_view_${suffix}`;
    const indexName = `ix_${tableName}_created_at`;

    const createResult = await driver.execute(
      {
        connectionId: writableConfig.id,
        sql: `
          create table ${tableName} (
            id integer generated always as identity primary key,
            email text not null unique,
            tenant_id integer not null,
            external_id text not null,
            total_amount numeric not null check (total_amount >= 0),
            created_at timestamptz not null default now(),
            unique (tenant_id, external_id)
          );
          comment on table ${tableName} is 'catalog metadata probe for RAG indexing';
          create index ${indexName} on ${tableName} (created_at);
          create view ${viewName} as
            select id, email, total_amount
            from ${tableName}
            where total_amount >= 0;
        `,
        confirmed: true,
      },
      connectResult.data,
    );
    expect(createResult.ok).toBe(true);

    try {
      const tableDetail = await driver.describeTable(writableConfig.id, 'public', tableName);
      expect(tableDetail.ok).toBe(true);
      if (!tableDetail.ok) return;

      expect(tableDetail.data.rowEstimate).toEqual(expect.any(Number));
      expect(tableDetail.data.indexes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: indexName,
            method: 'btree',
            unique: false,
            primary: false,
            valid: true,
          }),
          expect.objectContaining({ unique: true, primary: true, valid: true }),
        ]),
      );
      expect(tableDetail.data.constraints).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'primary_key', columns: ['id'] }),
          expect.objectContaining({ type: 'unique', columns: ['email'] }),
          expect.objectContaining({ type: 'unique', columns: ['tenant_id', 'external_id'] }),
          expect.objectContaining({ type: 'check' }),
        ]),
      );
      const checkConstraint = tableDetail.data.constraints?.find(
        (constraint) => constraint.type === 'check',
      );
      expect(checkConstraint?.definition).toContain('total_amount');
      const emailColumn = tableDetail.data.columns.find((column) => column.name === 'email');
      const tenantIdColumn = tableDetail.data.columns.find((column) => column.name === 'tenant_id');
      const createdAtColumn = tableDetail.data.columns.find(
        (column) => column.name === 'created_at',
      );
      expect(emailColumn).toMatchObject({ isIndexed: true, isUnique: true });
      expect(tenantIdColumn).toMatchObject({ isIndexed: true });
      expect(tenantIdColumn?.isUnique).toBeUndefined();
      expect(createdAtColumn).toMatchObject({ isIndexed: true });

      const viewDetail = await driver.describeTable(writableConfig.id, 'public', viewName);
      expect(viewDetail.ok).toBe(true);
      if (!viewDetail.ok) return;
      expect(viewDetail.data.type).toBe('view');
      expect(viewDetail.data.viewDefinition).toContain(tableName);
      expect(viewDetail.data.columns.map((column) => column.name)).toEqual([
        'id',
        'email',
        'total_amount',
      ]);
    } finally {
      await driver.execute(
        {
          connectionId: writableConfig.id,
          sql: `drop view if exists ${viewName}; drop table if exists ${tableName};`,
          confirmed: true,
        },
        connectResult.data,
      );
      await driver.disconnect(writableConfig.id);
    }
  });

  it('commits table edit previews transactionally and rolls back failed previews', async () => {
    const driver = new PostgresDriver();
    const writableConfig = {
      ...config,
      id: 'integration-postgres-table-edit',
      readOnly: false,
    };

    const connectResult = await driver.connect(writableConfig);
    expect(connectResult.ok).toBe(true);
    if (!connectResult.ok) return;

    const tableName = `dbagent_table_edit_${Date.now()}`;
    const createResult = await driver.execute(
      {
        connectionId: writableConfig.id,
        sql: `create table ${tableName} (id integer primary key, label text not null, payload jsonb, active boolean not null default true);`,
        confirmed: true,
      },
      connectResult.data,
    );
    expect(createResult.ok).toBe(true);

    try {
      const preview = buildTableEditPreview({
        schema: 'public',
        table: tableName,
        primaryKey: ['id'],
        operations: [
          {
            type: 'insert',
            values: { id: 1, label: 'draft', payload: { channel: 'web' }, active: true },
          },
          { type: 'insert', values: { id: 2, label: 'to_delete', active: false } },
          { type: 'update', key: { id: 1 }, values: { label: 'paid' } },
          { type: 'delete', key: { id: 2 } },
        ],
      });
      expect(preview.ok).toBe(true);
      if (!preview.ok) return;

      const applyResult = await driver.execute(
        {
          connectionId: writableConfig.id,
          sql: preview.data.sql,
          confirmed: true,
        },
        connectResult.data,
      );
      expect(applyResult.ok).toBe(true);

      const rowsResult = await driver.execute(
        {
          connectionId: writableConfig.id,
          sql: `select id, label, payload, active from ${tableName} order by id;`,
        },
        connectResult.data,
      );
      expect(rowsResult.ok).toBe(true);
      if (!rowsResult.ok) return;
      expect(rowsResult.data.rows).toEqual([
        expect.objectContaining({
          id: 1,
          label: 'paid',
          payload: { channel: 'web' },
          active: true,
        }),
      ]);

      const failedPreview = buildTableEditPreview({
        schema: 'public',
        table: tableName,
        primaryKey: ['id'],
        operations: [
          { type: 'insert', values: { id: 3, label: 'should_rollback' } },
          { type: 'insert', values: { id: 1, label: 'duplicate_key_failure' } },
        ],
      });
      expect(failedPreview.ok).toBe(true);
      if (!failedPreview.ok) return;

      const failedApply = await driver.execute(
        {
          connectionId: writableConfig.id,
          sql: failedPreview.data.sql,
          confirmed: true,
        },
        connectResult.data,
      );
      expect(failedApply.ok).toBe(false);

      const rollbackCheck = await driver.execute(
        {
          connectionId: writableConfig.id,
          sql: `select count(*)::int as count from ${tableName} where id = 3;`,
        },
        connectResult.data,
      );
      expect(rollbackCheck.ok).toBe(true);
      if (!rollbackCheck.ok) return;
      expect(rollbackCheck.data.rows).toEqual([expect.objectContaining({ count: 0 })]);
    } finally {
      await driver.execute(
        {
          connectionId: writableConfig.id,
          sql: `drop table if exists ${tableName};`,
          confirmed: true,
        },
        connectResult.data,
      );
      await driver.disconnect(writableConfig.id);
    }
  });
});
