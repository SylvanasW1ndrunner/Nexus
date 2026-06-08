import { analyzeSqlSafety, type IDatabaseDriver } from '@dbagent/core-db';
import {
  err,
  type QueryExecutionResult,
  type QueryHistoryItem,
  type QueryRequest,
  type Result,
  type SavedConnection,
} from '@dbagent/shared';
import { confirmationRequiredError } from './query-confirmation.js';

type ConnectionReader = {
  list(): Promise<SavedConnection[]>;
};

type QueryHistoryWriter = {
  append(input: {
    connectionId: string;
    sql: string;
    status: QueryHistoryItem['status'];
    rowCount?: number;
    elapsedMs?: number;
    errorMessage?: string;
    safety: QueryHistoryItem['safety'];
  }): Promise<QueryHistoryItem>;
};

type UsageRecorder = {
  recordLocalQuery(): Promise<unknown>;
};

export type QueryWorkflowDependencies = {
  connections: ConnectionReader;
  history: QueryHistoryWriter;
  usage: UsageRecorder;
  driver: Pick<IDatabaseDriver, 'execute'>;
};

export function createQueryWorkflow({
  connections,
  history,
  usage,
  driver,
}: QueryWorkflowDependencies): (request: QueryRequest) => Promise<Result<QueryExecutionResult>> {
  return async (request) => {
    const connection = (await connections.list()).find((item) => item.id === request.connectionId);
    if (!connection) return err({ code: 'NOT_FOUND', message: 'Connection not found.' });

    const safety = analyzeSqlSafety(request.sql, { readOnly: connection.readOnly });
    if (safety.blocked) {
      await history.append({
        connectionId: request.connectionId,
        sql: request.sql,
        status: 'blocked',
        safety,
        errorMessage: safety.reasons.join(' '),
      });
      return err({
        code: 'READ_ONLY_VIOLATION',
        message: 'This query is blocked by read-only mode.',
        detail: safety.reasons.join(' '),
      });
    }

    if (!request.confirmed) {
      const confirmationError = confirmationRequiredError(safety);
      if (confirmationError) return err(confirmationError);
    }

    const result = await driver.execute(request, connection);
    if (result.ok) {
      await usage.recordLocalQuery();
      await history.append({
        connectionId: request.connectionId,
        sql: request.sql,
        status: 'success',
        rowCount: result.data.rowCount,
        elapsedMs: result.data.elapsedMs,
        safety: result.data.safety,
      });
    } else {
      await history.append({
        connectionId: request.connectionId,
        sql: request.sql,
        status: 'failed',
        safety,
        errorMessage: result.error.message,
      });
    }
    return result;
  };
}
