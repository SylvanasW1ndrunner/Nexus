import { containsMultipleStatements, firstStatementKind, stripSqlComments } from '@dbagent/core-db';
import { err, ok, type QueryExecutionResult, type QueryRequest, type Result } from '@dbagent/shared';

const explainableStatementKinds = new Set(['SELECT', 'WITH', 'VALUES']);

export type ExplainWorkflowDependencies = {
  executeQuery: (request: QueryRequest) => Promise<Result<QueryExecutionResult>>;
};

export function buildExplainSql(sql: string): Result<string> {
  const normalizedSql = stripSqlComments(sql).trim();
  if (!normalizedSql) {
    return err({ code: 'VALIDATION_ERROR', message: 'SQL is empty.' });
  }

  if (containsMultipleStatements(normalizedSql)) {
    return err({
      code: 'VALIDATION_ERROR',
      message: 'EXPLAIN supports one read query at a time.',
    });
  }

  const statementKind = firstStatementKind(normalizedSql);
  if (!explainableStatementKinds.has(statementKind)) {
    return err({
      code: 'VALIDATION_ERROR',
      message: 'EXPLAIN is available for SELECT, WITH, and VALUES queries in M1.5.',
      detail: `Received ${statementKind}.`,
    });
  }

  return ok(`EXPLAIN (FORMAT JSON) ${sql}`);
}

export function createExplainWorkflow({
  executeQuery,
}: ExplainWorkflowDependencies): (request: QueryRequest) => Promise<Result<QueryExecutionResult>> {
  return async (request) => {
    const explainSql = buildExplainSql(request.sql);
    if (!explainSql.ok) return explainSql;
    return executeQuery({ ...request, sql: explainSql.data, confirmed: false });
  };
}
