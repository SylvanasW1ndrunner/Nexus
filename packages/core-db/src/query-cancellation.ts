import { err, ok, type Result } from '@dbagent/shared';

export type QueryRunStatus = 'running' | 'cancel-requested' | 'cancelled' | 'completed' | 'failed';

export type QueryCancellationDecision =
  | 'cancel-backend'
  | 'disconnect-connection'
  | 'already-finished'
  | 'not-found';

export type RunningQueryRecord = {
  queryId: string;
  connectionId: string;
  sql: string;
  startedAt: string;
  status: QueryRunStatus;
  backendPid?: number;
  cancelRequestedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  failedAt?: string;
  errorMessage?: string;
};

export type RegisterRunningQueryInput = {
  queryId: string;
  connectionId: string;
  sql: string;
  backendPid?: number;
  startedAt?: string | Date;
};

export type QueryCancellationPlan = {
  queryId: string;
  connectionId?: string;
  decision: QueryCancellationDecision;
  backendPid?: number;
  retryAfterMs?: number;
  message: string;
};

export type QueryCancellationRegistryOptions = {
  fallbackDisconnectAfterMs?: number;
};

const DEFAULT_FALLBACK_DISCONNECT_AFTER_MS = 5_000;

export class QueryCancellationRegistry {
  private readonly records = new Map<string, RunningQueryRecord>();
  private readonly fallbackDisconnectAfterMs: number;

  constructor(options: QueryCancellationRegistryOptions = {}) {
    this.fallbackDisconnectAfterMs = normalizePositiveInteger(
      options.fallbackDisconnectAfterMs,
      DEFAULT_FALLBACK_DISCONNECT_AFTER_MS,
    );
  }

  register(input: RegisterRunningQueryInput): Result<RunningQueryRecord> {
    const queryId = input.queryId.trim();
    const connectionId = input.connectionId.trim();
    const sql = input.sql.trim();

    if (!queryId) return validationError('Query id is required.');
    if (!connectionId) return validationError('Connection id is required.');
    if (!sql) return validationError('SQL is required.');
    if (input.backendPid !== undefined && !isPositiveInteger(input.backendPid)) {
      return validationError('Backend pid must be a positive integer.');
    }
    if (this.records.has(queryId)) {
      return err({ code: 'VALIDATION_ERROR', message: `Query ${queryId} is already registered.` });
    }

    const record: RunningQueryRecord = {
      queryId,
      connectionId,
      sql,
      startedAt: toIso(input.startedAt ?? new Date()),
      status: 'running',
    };
    if (input.backendPid !== undefined) record.backendPid = input.backendPid;
    this.records.set(queryId, record);
    return ok(cloneRecord(record));
  }

  get(queryId: string): RunningQueryRecord | undefined {
    const record = this.records.get(queryId);
    return record ? cloneRecord(record) : undefined;
  }

  listRunning(connectionId?: string): RunningQueryRecord[] {
    return [...this.records.values()]
      .filter((record) => isActive(record.status))
      .filter((record) => (connectionId ? record.connectionId === connectionId : true))
      .map(cloneRecord);
  }

  requestCancel(queryId: string, now: string | Date = new Date()): Result<QueryCancellationPlan> {
    const record = this.records.get(queryId);
    if (!record) {
      return ok({
        queryId,
        decision: 'not-found',
        message: '未找到正在运行的查询，可能已经结束或不属于当前会话。',
      });
    }

    if (!isActive(record.status)) {
      return ok({
        queryId: record.queryId,
        connectionId: record.connectionId,
        decision: 'already-finished',
        message: '查询已经结束，不需要取消。',
      });
    }

    const requestedAt = toIso(now);
    const elapsedSinceCancel = record.cancelRequestedAt
      ? Date.parse(requestedAt) - Date.parse(record.cancelRequestedAt)
      : 0;

    if (!record.cancelRequestedAt) {
      record.cancelRequestedAt = requestedAt;
      record.status = 'cancel-requested';
    }

    if (record.backendPid && elapsedSinceCancel < this.fallbackDisconnectAfterMs) {
      const retryAfterMs = Math.max(0, this.fallbackDisconnectAfterMs - elapsedSinceCancel);
      return ok({
        queryId: record.queryId,
        connectionId: record.connectionId,
        decision: 'cancel-backend',
        backendPid: record.backendPid,
        retryAfterMs,
        message: '优先调用 PostgreSQL backend cancel 取消当前查询。',
      });
    }

    return ok({
      queryId: record.queryId,
      connectionId: record.connectionId,
      decision: 'disconnect-connection',
      message: record.backendPid
        ? '取消请求已超时，下一步应断开当前查询所在连接。'
        : '当前查询缺少 PostgreSQL backend pid，下一步应断开当前查询所在连接。',
    });
  }

  markCompleted(queryId: string, completedAt: string | Date = new Date()): Result<RunningQueryRecord> {
    return this.transition(queryId, 'completed', completedAt);
  }

  markCancelled(queryId: string, cancelledAt: string | Date = new Date()): Result<RunningQueryRecord> {
    return this.transition(queryId, 'cancelled', cancelledAt);
  }

  markFailed(queryId: string, errorMessage: string, failedAt: string | Date = new Date()): Result<RunningQueryRecord> {
    if (!errorMessage.trim()) return validationError('Error message is required.');
    const result = this.transition(queryId, 'failed', failedAt);
    if (!result.ok) return result;
    const record = this.records.get(queryId);
    if (record) record.errorMessage = errorMessage;
    return ok(cloneRecord(this.records.get(queryId) ?? result.data));
  }

  setBackendPid(queryId: string, backendPid: number): Result<RunningQueryRecord> {
    if (!isPositiveInteger(backendPid)) return validationError('Backend pid must be a positive integer.');
    const record = this.records.get(queryId);
    if (!record) return err({ code: 'NOT_FOUND', message: `Query ${queryId} was not found.` });
    if (!isActive(record.status)) {
      return err({ code: 'VALIDATION_ERROR', message: `Query ${queryId} is not running.` });
    }
    record.backendPid = backendPid;
    return ok(cloneRecord(record));
  }

  pruneFinished(olderThanMs: number, now: string | Date = new Date()): number {
    const cutoff = Date.parse(toIso(now)) - Math.max(0, olderThanMs);
    let removed = 0;
    for (const [queryId, record] of this.records) {
      if (isActive(record.status)) continue;
      const finishedAt = record.completedAt ?? record.cancelledAt ?? record.failedAt;
      if (finishedAt && Date.parse(finishedAt) <= cutoff) {
        this.records.delete(queryId);
        removed += 1;
      }
    }
    return removed;
  }

  private transition(
    queryId: string,
    status: Exclude<QueryRunStatus, 'running' | 'cancel-requested'>,
    at: string | Date,
  ): Result<RunningQueryRecord> {
    const record = this.records.get(queryId);
    if (!record) return err({ code: 'NOT_FOUND', message: `Query ${queryId} was not found.` });
    record.status = status;
    const timestamp = toIso(at);
    if (status === 'completed') record.completedAt = timestamp;
    if (status === 'cancelled') record.cancelledAt = timestamp;
    if (status === 'failed') record.failedAt = timestamp;
    return ok(cloneRecord(record));
  }
}

function validationError<T>(message: string): Result<T> {
  return err({ code: 'VALIDATION_ERROR', message });
}

function isActive(status: QueryRunStatus): boolean {
  return status === 'running' || status === 'cancel-requested';
}

function toIso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && isPositiveInteger(value) ? value : fallback;
}

function cloneRecord(record: RunningQueryRecord): RunningQueryRecord {
  return { ...record };
}
