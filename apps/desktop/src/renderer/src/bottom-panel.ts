import type { QueryExecutionResult, SavedConnection } from '@dbagent/shared';

export type BottomPanelId = 'problems' | 'results' | 'console' | 'ports';

export type WorkbenchProblemCode =
  | 'SQL_NO_CONNECTION'
  | 'SQL_CONNECTION_DISCONNECTED'
  | 'SQL_EMPTY_DOCUMENT'
  | 'DOCUMENT_UNSAVED'
  | 'QUERY_BLOCKED'
  | 'QUERY_PERFORMANCE_WARNING';

export type WorkbenchProblem = {
  code: WorkbenchProblemCode;
  severity: 'error' | 'warning' | 'info';
  source: 'SQL' | 'Editor' | 'Query';
  detail?: string;
};

export function buildWorkbenchProblems(input: {
  activeConnection?: Pick<SavedConnection, 'status'> | undefined;
  document: { dirty: boolean; language: string };
  result?: QueryExecutionResult | undefined;
  sql: string;
}): WorkbenchProblem[] {
  const problems: WorkbenchProblem[] = [];

  if (input.document.language === 'sql') {
    if (!input.sql.trim()) {
      problems.push({ code: 'SQL_EMPTY_DOCUMENT', severity: 'info', source: 'SQL' });
    }
    if (!input.activeConnection) {
      problems.push({ code: 'SQL_NO_CONNECTION', severity: 'warning', source: 'SQL' });
    } else if (input.activeConnection.status !== 'connected') {
      problems.push({ code: 'SQL_CONNECTION_DISCONNECTED', severity: 'warning', source: 'SQL' });
    }
  }

  if (input.document.dirty) {
    problems.push({ code: 'DOCUMENT_UNSAVED', severity: 'info', source: 'Editor' });
  }

  if (input.result?.safety.blocked) {
    for (const reason of input.result.safety.reasons) {
      problems.push({ code: 'QUERY_BLOCKED', severity: 'error', source: 'Query', detail: reason });
    }
  }

  for (const warning of input.result?.safety.performanceWarnings ?? []) {
    problems.push({
      code: 'QUERY_PERFORMANCE_WARNING',
      severity: warning.severity,
      source: 'Query',
      detail: warning.message,
    });
  }

  return problems;
}
