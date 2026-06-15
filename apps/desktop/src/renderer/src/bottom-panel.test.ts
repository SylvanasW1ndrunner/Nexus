import { describe, expect, it } from 'vitest';
import { buildWorkbenchProblems } from './bottom-panel.js';

describe('bottom panel diagnostics', () => {
  it('reports SQL editor problems before the user can run a query', () => {
    const problems = buildWorkbenchProblems({
      document: { dirty: true, language: 'sql' },
      sql: '',
    });

    expect(problems.map((problem) => problem.code)).toEqual(['SQL_EMPTY_DOCUMENT', 'SQL_NO_CONNECTION', 'DOCUMENT_UNSAVED']);
    expect(problems.find((problem) => problem.code === 'SQL_NO_CONNECTION')?.severity).toBe('warning');
  });

  it('warns when the selected SQL connection is not connected', () => {
    const problems = buildWorkbenchProblems({
      activeConnection: { status: 'disconnected' },
      document: { dirty: false, language: 'sql' },
      sql: 'select 1',
    });

    expect(problems.map((problem) => problem.code)).toEqual(['SQL_CONNECTION_DISCONNECTED']);
  });

  it('surfaces blocked query reasons and performance warnings from the latest result', () => {
    const problems = buildWorkbenchProblems({
      activeConnection: { status: 'connected' },
      document: { dirty: false, language: 'sql' },
      sql: 'select * from orders',
      result: {
        queryId: 'q1',
        columns: [],
        rows: [],
        rowCount: 0,
        elapsedMs: 1,
        safety: {
          statementKind: 'SELECT',
          riskLevel: 'blocked',
          requiresConfirmation: true,
          blocked: true,
          reasons: ['Write statement requires confirmation.'],
          performanceWarnings: [{ code: 'SELECT_STAR', message: 'Avoid select *.', severity: 'warning' }],
        },
      },
    });

    expect(problems.map((problem) => problem.code)).toEqual(['QUERY_BLOCKED', 'QUERY_PERFORMANCE_WARNING']);
    expect(problems.map((problem) => problem.detail)).toEqual(['Write statement requires confirmation.', 'Avoid select *.']);
  });
});
