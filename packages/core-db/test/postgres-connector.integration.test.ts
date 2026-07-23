import { describe, expect, it } from 'vitest';
import type { ConnectionProfile, DatabaseCredential, QueryJob } from '@dbagent/shared';
import {
  ConnectorRegistry,
  DATABASE_CAPABILITIES,
  DatabaseAccessRuntime,
  DatabaseAccessRuntimeError,
  PostgresConnector,
} from '../src/index.js';

const runPostgresTests = process.env.DBAGENT_RUN_POSTGRES_TESTS === '1';
const suffix = `${process.pid}_${Date.now()}`;
const objectPrefix = `dbagent_connector_${suffix}`;

function credentials(password = process.env.DBAGENT_TEST_PG_PASSWORD ?? 'postgres'): DatabaseCredential {
  return {
    username: process.env.DBAGENT_TEST_PG_USER ?? 'postgres',
    password,
  };
}

function postgresProfile(
  id: string,
  overrides: Partial<ConnectionProfile> = {},
): ConnectionProfile {
  const timestamp = new Date().toISOString();
  return {
    id,
    name: `PostgreSQL connector integration ${id}`,
    connectorId: 'postgres-native',
    engine: 'postgres',
    endpoints: [
      {
        transport: 'tcp',
        host: process.env.DBAGENT_TEST_PG_HOST ?? '127.0.0.1',
        port: Number(process.env.DBAGENT_TEST_PG_PORT ?? 5432),
        database: process.env.DBAGENT_TEST_PG_DATABASE ?? 'dbagent_core_db_test',
      },
    ],
    principal: process.env.DBAGENT_TEST_PG_USER ?? 'postgres',
    purpose: 'admin',
    readOnly: false,
    network: { connectTimeoutMs: 5_000, statementTimeoutMs: 30_000 },
    pool: { max: 4 },
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function createRuntime(): DatabaseAccessRuntime {
  const connectors = new ConnectorRegistry();
  connectors.register(new PostgresConnector());
  return new DatabaseAccessRuntime({ connectors });
}

describe.skipIf(!runPostgresTests)('PostgresConnector real PostgreSQL integration', () => {
  it('covers connection lifecycle, dynamic capabilities, complete catalog discovery and observations', async () => {
    const runtime = createRuntime();
    const profile = postgresProfile(`catalog-${suffix}`);
    runtime.createProfile(profile);

    const tested = await runtime.testProfile(profile.id, credentials());
    expect(tested).toMatchObject({
      status: 'healthy',
      connectorId: 'postgres-native',
      engine: 'postgres',
    });
    expect(tested.latencyMs).toEqual(expect.any(Number));

    const session = await runtime.connect(profile.id, credentials());
    expect(session).toMatchObject({
      status: 'connected',
      endpointIndex: 0,
      connectorId: 'postgres-native',
    });
    const health = await runtime.health(profile.id);
    expect(health.status).toBe('healthy');
    expect(typeof health.engineVersion).toBe('string');

    const capabilities = await runtime.capabilities(profile.id);
    expect(capabilities.capabilities[DATABASE_CAPABILITIES.SQL_QUERY]?.status).toBe('supported');
    expect(capabilities.capabilities[DATABASE_CAPABILITIES.TRANSACTION_SAVEPOINT]?.status).toBe(
      'supported',
    );
    expect(capabilities.capabilities[DATABASE_CAPABILITIES.METADATA_INCREMENTAL]?.status).toBe(
      'unsupported',
    );
    expect(capabilities.capabilities[DATABASE_CAPABILITIES.RESULT_ARROW]?.status).toBe(
      'unsupported',
    );

    const table = `${objectPrefix}_table`;
    const view = `${objectPrefix}_view`;
    const materializedView = `${objectPrefix}_mv`;
    const sequence = `${objectPrefix}_seq`;
    const functionName = `${objectPrefix}_fn`;
    const procedureName = `${objectPrefix}_proc`;
    const triggerFunction = `${objectPrefix}_trigger_fn`;
    const trigger = `${objectPrefix}_trigger`;

    try {
      const setup = await runtime.submit({
        profileId: profile.id,
        sql: `
          create sequence ${sequence};
          create table ${table} (
            id bigint primary key default nextval('${sequence}'),
            tenant_id integer not null,
            external_id text not null,
            amount numeric(18, 4) not null check (amount >= 0),
            tags text[] not null default '{}',
            payload jsonb not null default '{}',
            raw_value bytea,
            occurred_at timestamptz not null default now(),
            unique (tenant_id, external_id)
          );
          comment on table ${table} is 'DBAgent complete connector catalog test';
          create index ${table}_occurred_at_idx on ${table} (occurred_at);
          create view ${view} as select id, tenant_id, amount from ${table};
          create materialized view ${materializedView} as
            select tenant_id, count(*)::bigint as item_count from ${table} group by tenant_id;
          create function ${functionName}(input_value integer)
          returns integer language sql immutable as 'select input_value + 1';
          create procedure ${procedureName}()
          language plpgsql as 'begin perform 1; end';
          create function ${triggerFunction}()
          returns trigger language plpgsql as 'begin new.external_id := lower(new.external_id); return new; end';
          create trigger ${trigger}
          before insert on ${table}
          for each row execute function ${triggerFunction}();
          grant select on ${table} to public;
        `,
        confirmed: true,
        rowLimit: 100,
      });
      expect(setup.state).toBe('succeeded');

      const discovery = await runtime.discoverAll(profile.id, { pageSize: 7 });
      expect(discovery.pages).toBeGreaterThan(2);
      expect(discovery.resources).toBeGreaterThan(10);
      expect(discovery.relations).toBeGreaterThan(5);

      const resources = runtime.queryResources({ text: objectPrefix, limit: 1_000 }).items;
      const kinds = new Set(resources.map((resource) => resource.kind));
      for (const expectedKind of [
        'table',
        'view',
        'materialized-view',
        'sequence',
        'column',
        'index',
        'constraint',
        'function',
        'procedure',
        'trigger',
        'grant',
      ]) {
        expect(kinds.has(expectedKind), `missing ${expectedKind}`).toBe(true);
      }
      const tableResource = resources.find(
        (resource) => resource.kind === 'table' && resource.displayName === table,
      );
      expect(tableResource?.attributes?.comment).toBe('DBAgent complete connector catalog test');
      expect(typeof tableResource?.attributes?.owner).toBe('string');
      expect(runtime.resourceRelations(tableResource!.id).length).toBeGreaterThan(5);
      expect(tableResource?.sources[0]).toMatchObject({
        connectorId: 'postgres-native',
        connectionProfileId: profile.id,
      });

      const sizeBeforeRefresh = runtime.resources.size;
      const refreshed = await runtime.discoverAll(profile.id, { pageSize: 13 });
      expect(refreshed.pages).toBeGreaterThan(1);
      expect(runtime.resources.size).toBe(sizeBeforeRefresh);

      const observations = await runtime.observe({
        profileId: profile.id,
        resourceId: tableResource!.id,
        categories: ['sessions', 'queries', 'locks', 'capacity', 'replication'],
      });
      expect(observations.map((item) => item.category)).toEqual([
        'sessions',
        'queries',
        'locks',
        'capacity',
        'replication',
      ]);
      for (const observation of observations) {
        expect(observation.resourceId).toBe(tableResource!.id);
        expect(typeof observation.observedAt).toBe('string');
        expect(typeof observation.expiresAt).toBe('string');
        expect(observation.source.connectorId).toBe('postgres-native');
      }
    } finally {
      await runtime.submit({
        profileId: profile.id,
        sql: `
          drop materialized view if exists ${materializedView};
          drop view if exists ${view};
          drop table if exists ${table};
          drop procedure if exists ${procedureName}();
          drop function if exists ${functionName}(integer);
          drop function if exists ${triggerFunction}();
          drop sequence if exists ${sequence};
        `,
        confirmed: true,
      });
      await runtime.disconnect(profile.id);
      expect(runtime.getSessionForProfile(profile.id)?.status).toBe('disconnected');
      expect(runtime.deleteProfile(profile.id)).toBe(true);
    }
  }, 60_000);

  it('executes complex types and pages results through synchronous and asynchronous Query Jobs', async () => {
    const runtime = createRuntime();
    const profile = postgresProfile(`query-${suffix}`);
    runtime.createProfile(profile);
    await runtime.connect(profile.id, credentials());

    const table = `${objectPrefix}_query`;
    try {
      expect(
        (
          await runtime.submit({
            profileId: profile.id,
            sql: `
              create table ${table} (
                id integer primary key,
                tenant text not null,
                amount numeric(12,2) not null,
                tags text[] not null,
                payload jsonb not null,
                raw_value bytea,
                occurred_at timestamptz not null
              );
              insert into ${table}
              select
                value,
                'tenant-' || (value % 3),
                (value * 1.25)::numeric(12,2),
                array['tag-' || value, 'shared'],
                jsonb_build_object('value', value, 'active', value % 2 = 0),
                decode(lpad(to_hex(value), 2, '0'), 'hex'),
                timestamptz '2026-01-01 00:00:00+00' + value * interval '1 hour'
              from generate_series(1, 12) value;
            `,
            confirmed: true,
          })
        ).state,
      ).toBe('succeeded');

      const job = await runtime.submit({
        profileId: profile.id,
        sql: `
          with ranked as (
            select
              id,
              tenant,
              amount,
              tags,
              payload,
              raw_value,
              occurred_at,
              row_number() over (partition by tenant order by amount desc) as tenant_rank
            from ${table}
            where amount >= $1
          )
          select * from ranked order by id
        `,
        params: [2.5],
        rowLimit: 20,
        executionMode: 'sync',
      });
      expect(job.state).toBe('succeeded');
      expect(job.result).toMatchObject({
        format: 'rows',
        rowCount: 11,
      });
      expect(job.result?.columns.some((column) => column.name === 'tenant_rank')).toBe(true);
      expect(job.result?.columns.some((column) => column.name === 'payload')).toBe(true);

      const rows: Array<Record<string, unknown>> = [];
      for await (const batch of runtime.streamResult(job.result!.id, { batchSize: 4 })) {
        expect(batch.rows.length).toBeLessThanOrEqual(4);
        rows.push(...(batch.rows as Array<Record<string, unknown>>));
      }
      expect(rows).toHaveLength(11);
      expect(rows[0]).toMatchObject({
        id: 2,
        tenant: 'tenant-2',
        amount: '2.50',
        tags: ['tag-2', 'shared'],
        payload: { value: 2, active: true },
      });
      expect(typeof rows[0]?.tenant_rank).toBe('string');
      expect(rows[0]?.occurred_at).toBeInstanceOf(Date);
      expect(Buffer.isBuffer(rows[0]?.raw_value)).toBe(true);

      const limited = await runtime.submit({
        profileId: profile.id,
        sql: `select * from generate_series(1, 1000) value order by value`,
        rowLimit: 5,
      });
      expect(limited.result).toMatchObject({ rowCount: 5, hasMore: true, truncated: true });

      const queued = await runtime.submit({
        profileId: profile.id,
        sql: 'select pg_sleep(0.05), 42::int as answer',
        executionMode: 'async',
      });
      expect(['queued', 'running']).toContain(queued.state);
      const completed = await waitForTerminal(runtime, queued.id);
      expect(completed.state).toBe('succeeded');
      expect(
        (await runtime.readResult(completed.result!.id)).rows,
      ).toEqual([expect.objectContaining({ answer: 42 })]);
    } finally {
      await runtime.submit({
        profileId: profile.id,
        sql: `drop table if exists ${table}`,
        confirmed: true,
      });
      await runtime.close();
    }
  }, 60_000);

  it('uses sticky transactions, savepoints, cancellation, session termination and maintenance operations', async () => {
    const runtime = createRuntime();
    const profile = postgresProfile(`operations-${suffix}`);
    runtime.createProfile(profile);
    await runtime.connect(profile.id, credentials());
    const table = `${objectPrefix}_transaction`;
    try {
      await runtime.submit({
        profileId: profile.id,
        sql: `create table ${table} (id integer primary key, label text not null)`,
        confirmed: true,
      });

      const transaction = await runtime.beginTransaction(profile.id, {
        isolationLevel: 'serializable',
      });
      expect(transaction).toMatchObject({
        state: 'active',
        isolationLevel: 'serializable',
      });
      expect(
        (
          await runtime.submit({
            profileId: profile.id,
            transactionId: transaction.id,
            sql: `insert into ${table} values (1, 'kept')`,
            confirmed: true,
          })
        ).state,
      ).toBe('succeeded');
      await runtime.createSavepoint(transaction.id, 'before_failure');
      const failed = await runtime.submit({
        profileId: profile.id,
        transactionId: transaction.id,
        sql: `insert into ${table} values (1, 'duplicate')`,
        confirmed: true,
      });
      expect(failed.state).toBe('failed');
      expect(failed.error).toMatchObject({ outcome: 'unknown' });
      expect(
        (await runtime.rollbackToSavepoint(transaction.id, 'before_failure')).state,
      ).toBe('active');
      expect(
        (
          await runtime.submit({
            profileId: profile.id,
            transactionId: transaction.id,
            sql: `insert into ${table} values (2, 'after-recovery')`,
            confirmed: true,
          })
        ).state,
      ).toBe('succeeded');
      expect((await runtime.commitTransaction(transaction.id)).state).toBe('committed');

      const count = await runtime.submit({
        profileId: profile.id,
        sql: `select count(*)::int as count from ${table}`,
      });
      expect((await runtime.readResult(count.result!.id)).rows).toEqual([{ count: 2 }]);

      const rolledBack = await runtime.beginTransaction(profile.id);
      await runtime.submit({
        profileId: profile.id,
        transactionId: rolledBack.id,
        sql: `insert into ${table} values (3, 'rolled-back')`,
        confirmed: true,
      });
      expect((await runtime.rollbackTransaction(rolledBack.id)).state).toBe('rolled-back');

      const cancellable = await runtime.submit({
        profileId: profile.id,
        sql: 'select pg_sleep(20)',
        executionMode: 'async',
      });
      await waitForState(runtime, cancellable.id, (job) => job.state === 'running');
      const cancelStarted = performance.now();
      const cancelling = await runtime.cancel(cancellable.id);
      expect(['cancelling', 'cancelled']).toContain(cancelling.state);
      const cancelled = await waitForTerminal(runtime, cancellable.id);
      expect(cancelled.state).toBe('cancelled');
      expect(performance.now() - cancelStarted).toBeLessThan(5_000);

      const timeoutStarted = performance.now();
      const timedOut = await runtime.submit({
        profileId: profile.id,
        sql: 'select pg_sleep(5)',
        timeoutMs: 75,
      });
      expect(timedOut).toMatchObject({
        state: 'failed',
        error: {
          code: 'QUERY_TIMEOUT',
          category: 'timeout',
        },
      });
      expect(performance.now() - timeoutStarted).toBeLessThan(3_000);

      const terminable = await runtime.submit({
        profileId: profile.id,
        sql: 'select pg_sleep(20)',
        executionMode: 'async',
      });
      const running = await waitForState(
        runtime,
        terminable.id,
        (job) => job.state === 'running' && Boolean(job.vendorQueryId),
      );
      const terminated = await runtime.operate({
        profileId: profile.id,
        operation: 'terminate-session',
        input: { backendPid: Number(running.vendorQueryId) },
        authorization: { approvalId: 'real-postgres-test' },
      });
      expect(terminated).toMatchObject({
        status: 'succeeded',
      });
      expect(terminated.output?.terminated).toBe(true);
      expect((await waitForTerminal(runtime, terminable.id)).state).toBe('failed');

      expect(
        await runtime.operate({
          profileId: profile.id,
          operation: 'analyze-table',
          input: { schema: 'public', table },
          authorization: { approvalId: 'real-postgres-test' },
        }),
      ).toMatchObject({ status: 'succeeded' });
      expect(
        await runtime.operate({
          profileId: profile.id,
          operation: 'vacuum-table',
          input: { schema: 'public', table },
          authorization: { approvalId: 'real-postgres-test' },
        }),
      ).toMatchObject({ status: 'succeeded' });
      await expect(
        runtime.operate({
          profileId: profile.id,
          operation: 'vacuum-table',
          input: { schema: 'public;drop schema public', table },
          authorization: { approvalId: 'real-postgres-test' },
        }),
      ).rejects.toBeInstanceOf(DatabaseAccessRuntimeError);
    } finally {
      await runtime.submit({
        profileId: profile.id,
        sql: `drop table if exists ${table}`,
        confirmed: true,
      });
      await runtime.close();
    }
  }, 90_000);

  it('reports a real missing database through the unified error model without retaining credentials', async () => {
    const runtime = createRuntime();
    const profile = postgresProfile(`missing-${suffix}`, {
      endpoints: [
        {
          transport: 'tcp',
          host: process.env.DBAGENT_TEST_PG_HOST ?? '127.0.0.1',
          port: Number(process.env.DBAGENT_TEST_PG_PORT ?? 5432),
          database: `dbagent_missing_${suffix}`,
        },
      ],
    });
    runtime.createProfile(profile);
    const error = await captureRuntimeError(
      runtime.testProfile(profile.id, credentials('secret-not-in-error')),
    );
    expect(error.error.category).toBe('network');
    expect(error.error.message).not.toContain('secret-not-in-error');
    expect(runtime.getProfile(profile.id)).not.toHaveProperty('password');
    expect(runtime.listAuditEvents({ profileId: profile.id })).toEqual([
      expect.objectContaining({
        action: 'database.profile.test',
        status: 'failed',
      }),
    ]);
  }, 30_000);
});

async function waitForTerminal(
  runtime: DatabaseAccessRuntime,
  jobId: string,
  timeoutMs = 10_000,
): Promise<QueryJob> {
  return waitForState(runtime, jobId, (job) =>
    ['succeeded', 'failed', 'cancelled', 'expired'].includes(job.state),
  timeoutMs);
}

async function captureRuntimeError(promise: Promise<unknown>): Promise<DatabaseAccessRuntimeError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DatabaseAccessRuntimeError) return error;
    throw error;
  }
  throw new Error('Expected DatabaseAccessRuntimeError.');
}

async function waitForState(
  runtime: DatabaseAccessRuntime,
  jobId: string,
  predicate: (job: QueryJob) => boolean,
  timeoutMs = 10_000,
): Promise<QueryJob> {
  const deadline = Date.now() + timeoutMs;
  let last = await runtime.getJob(jobId);
  while (!predicate(last) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    last = await runtime.getJob(jobId);
  }
  expect(predicate(last), `job ${jobId} stopped at ${last.state}`).toBe(true);
  return last;
}
