import { describe, expect, it } from 'vitest';
import {
  err,
  ok,
  type QueryExecutionResult,
  type QueryHistoryItem,
  type Result,
  type SavedConnection,
} from '@dbagent/shared';
import { createQueryWorkflow } from './query-workflow.js';

const baseConnection: SavedConnection = {
  id: 'conn-main-flow',
  name: 'Local PG',
  engine: 'postgres',
  host: '127.0.0.1',
  port: 5432,
  database: 'dbagent_demo',
  username: 'postgres',
  ssl: false,
  readOnly: true,
  status: 'connected',
  createdAt: '2026-06-08T00:00:00.000Z',
  updatedAt: '2026-06-08T00:00:00.000Z',
};

describe('createQueryWorkflow', () => {
  it('executes a safe query, records usage, and writes success history', async () => {
    const harness = createHarness({ connection: baseConnection });

    const result = await harness.execute({
      connectionId: baseConnection.id,
      sql: 'select city from users order by city limit 10',
    });

    expect(result.ok).toBe(true);
    expect(harness.resolvedEngines).toEqual(['postgres']);
    expect(harness.driverCalls).toHaveLength(1);
    expect(harness.usageCount).toBe(1);
    expect(harness.history).toEqual([
      expect.objectContaining({
        connectionId: baseConnection.id,
        sql: 'select city from users order by city limit 10',
        status: 'success',
        rowCount: 2,
        elapsedMs: 12,
      }),
    ]);
  });

  it('blocks read-only writes before hitting the driver and records blocked history', async () => {
    const harness = createHarness({ connection: baseConnection });

    const result = await harness.execute({
      connectionId: baseConnection.id,
      sql: "delete from users where email = 'alice@example.com'",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('READ_ONLY_VIOLATION');
    expect(harness.driverCalls).toHaveLength(0);
    expect(harness.usageCount).toBe(0);
    expect(harness.history).toHaveLength(1);
    expect(harness.history[0]).toMatchObject({
      connectionId: baseConnection.id,
      status: 'blocked',
    });
    expect(harness.history[0]?.errorMessage).toContain('read-only');
  });

  it('rejects empty SQL as validation without touching the driver or history', async () => {
    const harness = createHarness({ connection: baseConnection });

    const result = await harness.execute({
      connectionId: baseConnection.id,
      sql: ' -- analyst note only',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION_ERROR');
    expect(harness.driverCalls).toHaveLength(0);
    expect(harness.usageCount).toBe(0);
    expect(harness.history).toEqual([]);
  });

  it('requires confirmation for writable risky SQL before execution', async () => {
    const connection = { ...baseConnection, readOnly: false };
    const harness = createHarness({ connection });

    const result = await harness.execute({
      connectionId: connection.id,
      sql: "update users set city = 'Hangzhou' where email = 'alice@example.com'",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CONFIRMATION_REQUIRED');
    expect(harness.driverCalls).toHaveLength(0);
    expect(harness.history).toEqual([]);
  });

  it('records failed execution history after confirmed driver failure', async () => {
    const connection = { ...baseConnection, readOnly: false };
    const harness = createHarness({
      connection,
      driverResult: err({ code: 'QUERY_FAILED', message: 'syntax error at or near "fromm"' }),
    });

    const result = await harness.execute({
      connectionId: connection.id,
      sql: 'select * fromm users',
      confirmed: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('QUERY_FAILED');
    expect(harness.usageCount).toBe(0);
    expect(harness.history).toEqual([
      expect.objectContaining({
        connectionId: connection.id,
        status: 'failed',
        errorMessage: 'syntax error at or near "fromm"',
      }),
    ]);
  });
});

function createHarness(options: {
  connection: SavedConnection;
  driverResult?: Result<QueryExecutionResult>;
}) {
  const history: QueryHistoryItem[] = [];
  const driverCalls: Array<{ sql: string; connection: SavedConnection }> = [];
  const resolvedEngines: string[] = [];
  let usageCount = 0;
  const driverResult =
    options.driverResult ??
    ok<QueryExecutionResult>({
      queryId: 'query-main-flow',
      columns: [{ name: 'city', dataType: 'text' }],
      rows: [{ city: 'Beijing' }, { city: 'Shanghai' }],
      rowCount: 2,
      elapsedMs: 12,
      safety: {
        statementKind: 'SELECT',
        riskLevel: 'safe',
        requiresConfirmation: false,
        blocked: false,
        reasons: [],
      },
    });

  return {
    history,
    driverCalls,
    resolvedEngines,
    get usageCount() {
      return usageCount;
    },
    execute: createQueryWorkflow({
      connections: {
        list() {
          return Promise.resolve([options.connection]);
        },
      },
      history: {
        append(input) {
          const item: QueryHistoryItem = {
            id: `history-${history.length + 1}`,
            createdAt: '2026-06-08T00:00:00.000Z',
            ...input,
          };
          history.push(item);
          return Promise.resolve(item);
        },
      },
      usage: {
        recordLocalQuery() {
          usageCount += 1;
          return Promise.resolve();
        },
      },
      driverForEngine(engine) {
        resolvedEngines.push(engine);
        return {
          execute(request, connection) {
            driverCalls.push({ sql: request.sql, connection });
            return Promise.resolve(driverResult);
          },
        };
      },
    }),
  };
}
