import { describe, expect, it } from 'vitest';
import { queryResultToCsv, type QueryExecutionResult } from '../src/index.js';

function result(rows: QueryExecutionResult['rows']): QueryExecutionResult {
  return {
    queryId: 'query-1',
    columns: [
      { name: 'id' },
      { name: 'email' },
      { name: 'note' },
      { name: 'metadata' },
    ],
    rows,
    rowCount: rows.length,
    elapsedMs: 12,
    safety: {
      statementKind: 'SELECT',
      riskLevel: 'safe',
      requiresConfirmation: false,
      blocked: false,
      reasons: [],
    },
  };
}

describe('queryResultToCsv', () => {
  it('exports query results with stable column order', () => {
    expect(
      queryResultToCsv(
        result([
          {
            id: 1,
            email: 'ana@example.com',
            note: 'vip',
            metadata: { cohort: 'spring' },
          },
        ]),
      ),
    ).toBe('id,email,note,metadata\r\n1,ana@example.com,vip,"{""cohort"":""spring""}"');
  });

  it('escapes commas, quotes, new lines, and null values for spreadsheet import', () => {
    expect(
      queryResultToCsv(
        result([
          {
            id: 2,
            email: 'li@example.com',
            note: 'first line\n"quoted", second line',
            metadata: null,
          },
        ]),
      ),
    ).toBe('id,email,note,metadata\r\n2,li@example.com,"first line\n""quoted"", second line",');
  });
});
