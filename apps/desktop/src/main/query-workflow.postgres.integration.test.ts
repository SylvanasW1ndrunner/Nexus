import { describe, expect, it } from 'vitest';
import {
  PostgresDriver,
  QueryCancellationRegistry,
  type DatabaseConnectionConfig,
} from '@dbagent/core-db';
import type { QueryHistoryItem, SavedConnection } from '@dbagent/shared';
import { createQueryCancellationWorkflow, createQueryWorkflow } from './query-workflow.js';

const runPostgresTests = process.env.DBAGENT_RUN_POSTGRES_TESTS === '1';

const config: DatabaseConnectionConfig = {
  id: 'desktop-query-cancel-postgres',
  name: 'Desktop Query Cancel PostgreSQL',
  engine: 'postgres',
  host: process.env.DBAGENT_TEST_PG_HOST ?? '127.0.0.1',
  port: Number(process.env.DBAGENT_TEST_PG_PORT ?? 5432),
  database: process.env.DBAGENT_TEST_PG_DATABASE ?? 'dbagent_demo',
  username: process.env.DBAGENT_TEST_PG_USER ?? 'postgres',
  password: process.env.DBAGENT_TEST_PG_PASSWORD ?? 'postgres',
  readOnly: true,
  maxClients: 4,
  statementTimeoutMs: 60_000,
};

describe.skipIf(!runPostgresTests)('desktop query workflow real PostgreSQL cancellation', () => {
  it('cancels pg_sleep through pg_cancel_backend, including a single-client business pool', async () => {
    await runCancellationScenario({
      queryId: 'real-postgres-cancel-pg-sleep',
      config,
    });

    await runCancellationScenario({
      queryId: 'real-postgres-cancel-single-client-pool',
      config: {
        ...config,
        id: 'desktop-query-cancel-postgres-single-client',
        maxClients: 1,
      },
    });
  }, 40_000);
});

async function runCancellationScenario(input: {
  queryId: string;
  config: DatabaseConnectionConfig;
}): Promise<void> {
  const driver = new PostgresDriver();
  const cancellations = new QueryCancellationRegistry({ fallbackDisconnectAfterMs: 10_000 });
  const history: QueryHistoryItem[] = [];
  let usageCount = 0;

  const connectResult = await driver.connect(input.config);
  expect(connectResult.ok).toBe(true);
  if (!connectResult.ok) return;
  const connection = connectResult.data;

  try {
    const executeQuery = createQueryWorkflow({
      connections: connectionReader(connection),
      history: historyWriter(history),
      usage: {
        recordLocalQuery() {
          usageCount += 1;
          return Promise.resolve();
        },
      },
      driverForEngine: () => driver,
      cancellations,
    });
    const cancelQuery = createQueryCancellationWorkflow({
      cancellations,
      connections: connectionReader(connection),
      driverForEngine: () => driver,
    });

    const queryId = input.queryId;
    const runningQuery = executeQuery({
      queryId,
      connectionId: connection.id,
      sql: 'select pg_sleep(30)',
    });
    const backendPid = await waitForBackendPid(cancellations, queryId);

    const cancelResult = await cancelQuery({ queryId });
    if (!cancelResult.ok) {
      throw new Error(
        `Expected PostgreSQL cancel to succeed for ${queryId}: ${JSON.stringify({
          error: cancelResult.error,
          record: cancellations.get(queryId),
        })}`,
      );
    }
    expect(cancelResult).toMatchObject({
      ok: true,
      data: {
        queryId,
        connectionId: connection.id,
        decision: 'cancel-backend',
        backendPid,
      },
    });

    const queryResult = await runningQuery;
    expect(queryResult).toMatchObject({
      ok: false,
      error: {
        code: 'QUERY_CANCELLED',
      },
    });
    expect(cancellations.get(queryId)).toMatchObject({
      queryId,
      connectionId: connection.id,
      status: 'cancelled',
      backendPid,
    });
    expect(history).toEqual([
      expect.objectContaining({
        connectionId: connection.id,
        sql: 'select pg_sleep(30)',
        status: 'cancelled',
        errorMessage: 'PostgreSQL query was cancelled.',
      }),
    ]);
    expect(usageCount).toBe(0);

    const afterCancel = await driver.execute(
      {
        connectionId: connection.id,
        sql: 'select 1::int as ok',
      },
      connection,
    );
    expect(afterCancel).toMatchObject({
      ok: true,
      data: {
        rows: [expect.objectContaining({ ok: 1 })],
      },
    });
  } finally {
    await driver.disconnect(connection.id);
  }
}

function connectionReader(connection: SavedConnection) {
  return {
    list() {
      return Promise.resolve([connection]);
    },
  };
}

function historyWriter(history: QueryHistoryItem[]) {
  return {
    append(input: Omit<QueryHistoryItem, 'id' | 'createdAt'>): Promise<QueryHistoryItem> {
      const item: QueryHistoryItem = {
        id: `history-${history.length + 1}`,
        createdAt: new Date().toISOString(),
        ...input,
      };
      history.push(item);
      return Promise.resolve(item);
    },
  };
}

async function waitForBackendPid(
  cancellations: QueryCancellationRegistry,
  queryId: string,
  timeoutMs = 5_000,
): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const backendPid = cancellations.get(queryId)?.backendPid;
    if (backendPid !== undefined) return backendPid;
    await delay(25);
  }
  throw new Error(`Timed out waiting for PostgreSQL backend pid for ${queryId}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
