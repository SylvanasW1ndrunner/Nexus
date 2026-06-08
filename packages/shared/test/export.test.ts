import { describe, expect, it } from 'vitest';
import { queryResultToJson, type QueryExecutionResult } from '../src/index.js';

describe('queryResultToJson', () => {
  it('exports metadata and rows in result column order', () => {
    const result: QueryExecutionResult = {
      queryId: 'query-json-1',
      columns: [{ name: 'id' }, { name: 'created_at' }, { name: 'payload' }, { name: 'raw' }],
      rows: [
        {
          raw: Buffer.from('ok'),
          payload: { nested: { count: 3n } },
          created_at: new Date('2026-06-08T03:00:00.000Z'),
          id: 42n,
        },
      ],
      rowCount: 1,
      elapsedMs: 18,
      safety: {
        statementKind: 'SELECT',
        riskLevel: 'safe',
        requiresConfirmation: false,
        blocked: false,
        reasons: [],
      },
    };

    expect(JSON.parse(queryResultToJson(result))).toEqual({
      queryId: 'query-json-1',
      rowCount: 1,
      elapsedMs: 18,
      columns: [{ name: 'id' }, { name: 'created_at' }, { name: 'payload' }, { name: 'raw' }],
      rows: [
        {
          id: '42',
          created_at: '2026-06-08T03:00:00.000Z',
          payload: { nested: { count: '3' } },
          raw: 'b2s=',
        },
      ],
      safety: {
        statementKind: 'SELECT',
        riskLevel: 'safe',
        requiresConfirmation: false,
        blocked: false,
        reasons: [],
      },
    });
  });
});
