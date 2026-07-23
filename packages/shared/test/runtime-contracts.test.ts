import { describe, expect, it } from 'vitest';
import type { QueryExecutionResult, SavedConnection } from '../src/index.js';

describe('runtime contracts', () => {
  it('describes the public database connection and query result boundary', () => {
    const connection: SavedConnection = {
      id: 'connection-1',
      name: 'analytics',
      engine: 'postgres',
      host: '127.0.0.1',
      port: 5432,
      database: 'analytics',
      username: 'readonly',
      readOnly: true,
      status: 'connected',
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
    };
    const result: QueryExecutionResult = {
      queryId: 'query-1',
      columns: [{ name: 'count' }],
      rows: [{ count: 1 }],
      rowCount: 1,
      elapsedMs: 4,
      safety: {
        statementKind: 'SELECT',
        riskLevel: 'safe',
        requiresConfirmation: false,
        blocked: false,
        reasons: [],
      },
    };

    expect(connection.readOnly).toBe(true);
    expect(result.rows).toEqual([{ count: 1 }]);
  });
});
