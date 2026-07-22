import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '@dbagent/core-agent';
import type { IDatabaseDriver } from '@dbagent/core-db';
import { ok, type QueryExecutionResult, type SavedConnection } from '@dbagent/shared';
import { registerDatabaseOperationTools } from '../src/index.js';

describe('database operation tools', () => {
  it('registers readonly PostgreSQL diagnosis tools and executes parameterized thresholds safely', async () => {
    const registry = new ToolRegistry();
    const calls: string[] = [];
    const driver = fakeDriver(calls);
    registerDatabaseOperationTools({
      registry,
      driver,
      getConnection: () => connection(),
    });

    expect(registry.list().map((tool) => tool.name)).toEqual([
      'explain_query',
      'database_health_snapshot',
      'diagnose_slow_queries',
      'diagnose_locks',
      'diagnose_long_transactions',
    ]);

    await registry.get('diagnose_long_transactions')!.handler(
      { connectionId: 'pg', minDurationSeconds: 600 },
      toolContext(),
    );
    expect(calls[0]).toContain('make_interval(secs => 600)');
  });

  it('blocks EXPLAIN for write SQL before reaching the driver', async () => {
    const registry = new ToolRegistry();
    const calls: string[] = [];
    registerDatabaseOperationTools({
      registry,
      driver: fakeDriver(calls),
      getConnection: () => connection(),
    });

    await expect(
      registry.get('explain_query')!.handler(
        { connectionId: 'pg', sql: 'delete from users' },
        toolContext(),
      ),
    ).rejects.toThrow('readonly');
    expect(calls).toEqual([]);
  });
});

function fakeDriver(calls: string[]): IDatabaseDriver {
  return {
    capabilities: {
      engine: 'postgres',
      supportsTransactions: true,
      supportsExplain: true,
      supportsSchemas: true,
    },
    test: () => Promise.resolve(ok({ latencyMs: 1 })),
    connect: () => Promise.resolve(ok(connection())),
    disconnect: () => Promise.resolve(ok(undefined)),
    execute: (request) => {
      calls.push(request.sql);
      return Promise.resolve(ok({
        queryId: 'query',
        columns: [],
        rows: [],
        rowCount: 0,
        elapsedMs: 1,
        safety: {
          statementKind: 'SELECT',
          riskLevel: 'safe',
          requiresConfirmation: false,
          blocked: false,
          reasons: [],
        },
      } satisfies QueryExecutionResult));
    },
    listTables: () => Promise.resolve(ok([])),
    describeTable: () => Promise.reject(new Error('not used')),
  };
}

function connection(): SavedConnection {
  return {
    id: 'pg',
    name: 'postgres',
    engine: 'postgres',
    host: '127.0.0.1',
    port: 5432,
    database: 'postgres',
    username: 'readonly',
    readOnly: true,
    status: 'connected',
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:00:00.000Z',
  };
}

function toolContext() {
  return {
    session: {
      id: 'session',
      title: 'test',
      mode: 'readonly' as const,
      strategy: 'react' as const,
      messages: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      aborted: false,
    },
  };
}
