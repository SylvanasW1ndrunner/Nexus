import { randomUUID } from 'node:crypto';
import { analyzeSqlSafety, type IDatabaseDriver } from '@dbagent/core-db';
import {
  err,
  ok,
  type DatabaseEngine,
  type QueryCancelResponse,
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

type QueryCancellationStore = {
  register(input: { queryId: string; connectionId: string; sql: string; startedAt?: string | Date }): Result<unknown>;
  setBackendPid(queryId: string, backendPid: number): Result<unknown>;
  markCompleted(queryId: string, completedAt?: string | Date): Result<unknown>;
  markCancelled(queryId: string, cancelledAt?: string | Date): Result<unknown>;
  markFailed(queryId: string, errorMessage: string, failedAt?: string | Date): Result<unknown>;
  requestCancel(queryId: string, now?: string | Date): Result<QueryCancelResponse>;
};

export type QueryWorkflowDependencies = {
  connections: ConnectionReader;
  history: QueryHistoryWriter;
  usage: UsageRecorder;
  driverForEngine: (engine: DatabaseEngine) => Pick<IDatabaseDriver, 'execute' | 'cancel' | 'disconnect'>;
  cancellations?: QueryCancellationStore;
  queryIdFactory?: () => string;
};

export function createQueryWorkflow({
  connections,
  history,
  usage,
  driverForEngine,
  cancellations,
  queryIdFactory = randomUUID,
}: QueryWorkflowDependencies): (request: QueryRequest) => Promise<Result<QueryExecutionResult>> {
  return async (request) => {
    const connection = (await connections.list()).find((item) => item.id === request.connectionId);
    if (!connection) return err({ code: 'NOT_FOUND', message: 'Connection not found.' });

    const safety = analyzeSqlSafety(request.sql, { readOnly: connection.readOnly });
    if (safety.statementKind === 'EMPTY') {
      return err({
        code: 'VALIDATION_ERROR',
        message: 'SQL is empty.',
        detail: safety.reasons.join(' '),
      });
    }

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

    const queryId = request.queryId?.trim() || queryIdFactory();
    const executionRequest: QueryRequest = { ...request, queryId };
    const registration = cancellations?.register({
      queryId,
      connectionId: request.connectionId,
      sql: request.sql,
    });
    if (registration && !registration.ok) return registration;

    const driver = driverForEngine(connection.engine);
    const result = await driver.execute(executionRequest, connection, {
      onBackendPid({ backendPid }) {
        cancellations?.setBackendPid(queryId, backendPid);
      },
    });
    if (result.ok) {
      cancellations?.markCompleted(queryId);
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
      cancellations?.markFailed(queryId, result.error.message);
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

export type QueryCancellationWorkflowDependencies = {
  cancellations: QueryCancellationStore;
  connections: ConnectionReader;
  driverForEngine: (engine: DatabaseEngine) => Pick<IDatabaseDriver, 'cancel' | 'disconnect'>;
};

export function createQueryCancellationWorkflow({
  cancellations,
  connections,
  driverForEngine,
}: QueryCancellationWorkflowDependencies) {
  return async (request: { queryId: string }): Promise<Result<QueryCancelResponse>> => {
    const queryId = request.queryId.trim();
    if (!queryId) return err({ code: 'VALIDATION_ERROR', message: 'Query id is required.' });
    const plan = cancellations.requestCancel(queryId);
    if (!plan.ok) return plan;
    if (!plan.data.connectionId || plan.data.decision === 'not-found' || plan.data.decision === 'already-finished') {
      return ok(plan.data);
    }
    const connection = (await connections.list()).find((item) => item.id === plan.data.connectionId);
    if (!connection) return err({ code: 'NOT_FOUND', message: 'Connection not found.' });
    const driver = driverForEngine(connection.engine);
    if (driver.cancel) {
      const cancelled = await driver.cancel(plan.data, connection);
      if (cancelled.ok && plan.data.decision === 'disconnect-connection') {
        cancellations.markCancelled(queryId);
      }
      return cancelled;
    }
    if (plan.data.decision === 'disconnect-connection') {
      const disconnected = await driver.disconnect(plan.data.connectionId);
      if (!disconnected.ok) return disconnected;
      cancellations.markCancelled(queryId);
      return ok({ ...plan.data, message: `${plan.data.message} 已断开当前连接。` });
    }
    return ok(plan.data);
  };
}
