import { describe, expect, it } from 'vitest';
import { ok, type Result, type SavedConnection, type TableDetail, type TableSummary } from '@dbagent/shared';
import { createSchemaWorkflow } from './schema-workflow.js';

const baseConnection: SavedConnection = {
  id: 'conn-schema-flow',
  name: 'Remote Warehouse',
  engine: 'postgres',
  host: 'warehouse.example.com',
  port: 5432,
  database: 'analytics',
  username: 'analyst',
  ssl: true,
  readOnly: true,
  connectionTimeoutMs: 10_000,
  statementTimeoutMs: 60_000,
  status: 'connected',
  createdAt: '2026-06-08T00:00:00.000Z',
  updatedAt: '2026-06-08T00:00:00.000Z',
};

describe('createSchemaWorkflow', () => {
  it('routes table listing through the saved connection engine', async () => {
    const harness = createHarness({ connection: baseConnection });

    const result = await harness.workflow.listTables(baseConnection.id);

    expect(result.ok).toBe(true);
    expect(harness.resolvedEngines).toEqual(['postgres']);
    expect(harness.calls).toEqual([{ type: 'listTables', connectionId: baseConnection.id }]);
    if (result.ok) {
      expect(result.data).toEqual([{ schema: 'public', name: 'orders', type: 'table' }]);
    }
  });

  it('routes table detail requests with schema and table names intact', async () => {
    const harness = createHarness({ connection: baseConnection });

    const result = await harness.workflow.describeTable(baseConnection.id, 'sales', 'quarterly orders');

    expect(result.ok).toBe(true);
    expect(harness.resolvedEngines).toEqual(['postgres']);
    expect(harness.calls).toEqual([
      {
        type: 'describeTable',
        connectionId: baseConnection.id,
        schema: 'sales',
        table: 'quarterly orders',
      },
    ]);
    if (result.ok) {
      expect(result.data.primaryKey).toEqual(['id']);
    }
  });

  it('returns not found without touching drivers when the connection is missing', async () => {
    const harness = createHarness({ connection: undefined });

    const result = await harness.workflow.listTables('missing-connection');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
    expect(harness.resolvedEngines).toEqual([]);
    expect(harness.calls).toEqual([]);
  });
});

function createHarness({ connection }: { connection: SavedConnection | undefined }) {
  const calls: Array<
    | { type: 'listTables'; connectionId: string }
    | { type: 'describeTable'; connectionId: string; schema: string; table: string }
  > = [];
  const resolvedEngines: string[] = [];

  return {
    calls,
    resolvedEngines,
    workflow: createSchemaWorkflow({
      connections: {
        list() {
          return Promise.resolve(connection ? [connection] : []);
        },
      },
      driverForEngine(engine) {
        resolvedEngines.push(engine);
        return {
          listTables(connectionId) {
            calls.push({ type: 'listTables', connectionId });
            return Promise.resolve<Result<TableSummary[]>>(ok([{ schema: 'public', name: 'orders', type: 'table' }]));
          },
          describeTable(connectionId, schema, table) {
            calls.push({ type: 'describeTable', connectionId, schema, table });
            return Promise.resolve<Result<TableDetail>>(
              ok({
                schema,
                name: table,
                type: 'table',
                primaryKey: ['id'],
                columns: [
                  {
                    name: 'id',
                    ordinal: 1,
                    dataType: 'integer',
                    nullable: false,
                    isPrimaryKey: true,
                  },
                ],
              }),
            );
          },
        };
      },
    }),
  };
}
