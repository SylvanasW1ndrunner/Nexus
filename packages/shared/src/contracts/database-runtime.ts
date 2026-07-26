import type {
  ConnectionId,
  ConnectionStatus,
  DatabaseEngine,
  DbColumnValue,
  QueryResultRow,
  QueryRiskLevel,
  UsageMode,
} from './database-sdk.js';

export type SavedConnection = {
  id: ConnectionId;
  name: string;
  engine: DatabaseEngine;
  host: string;
  port: number;
  database: string;
  username: string;
  ssl?: boolean;
  readOnly: boolean;
  connectionTimeoutMs?: number;
  statementTimeoutMs?: number;
  status: ConnectionStatus;
  createdAt: string;
  updatedAt: string;
};

export type ConnectionInput = {
  name: string;
  engine: DatabaseEngine;
  host: string;
  port: number;
  database: string;
  username: string;
  password?: string;
  ssl?: boolean;
  readOnly?: boolean;
  connectionTimeoutMs?: number;
  statementTimeoutMs?: number;
};

export type QueryRequest = {
  queryId?: string;
  connectionId: ConnectionId;
  sql: string;
  params?: DbColumnValue[];
  limit?: number;
  timeoutMs?: number;
  dryRun?: boolean;
  confirmed?: boolean;
  transactionMode?: QueryTransactionMode;
};

export type QueryTransactionMode = 'auto' | 'rollback';

export type QuerySafetyReport = {
  statementKind: string;
  riskLevel: QueryRiskLevel;
  requiresConfirmation: boolean;
  blocked: boolean;
  reasons: string[];
  performanceWarnings?: SqlPerformanceWarning[];
};

export type SqlPerformanceWarning = {
  code:
    | 'SELECT_STAR'
    | 'MISSING_LIMIT'
    | 'LEADING_WILDCARD_LIKE'
    | 'LARGE_OFFSET'
    | 'CARTESIAN_JOIN'
    | 'FUNCTION_ON_FILTER_COLUMN';
  message: string;
  severity: 'info' | 'warning';
};

export type QueryExecutionResult = {
  queryId: string;
  columns: Array<{ name: string; dataType?: string }>;
  rows: QueryResultRow[];
  rowCount: number;
  returnedRowCount?: number;
  rowLimit?: number;
  hasMore?: boolean;
  truncated?: boolean;
  elapsedMs: number;
  safety: QuerySafetyReport;
  transaction?: QueryTransactionReport;
  resultSets?: QueryResultSet[];
  messages?: QueryExecutionMessage[];
};

export type QueryTransactionReport = {
  mode: QueryTransactionMode;
  started: boolean;
  committed: boolean;
  rolledBack: boolean;
  rollbackOnly: boolean;
};

export type QueryResultSet = {
  index: number;
  command: string;
  columns: Array<{ name: string; dataType?: string }>;
  rows: QueryResultRow[];
  rowCount: number;
  returnedRowCount?: number;
  rowLimit?: number;
  hasMore?: boolean;
  truncated?: boolean;
};

export type QueryExecutionMessage = {
  level: 'info' | 'warning';
  message: string;
  statementIndex?: number;
};

export type QueryCancelRequest = {
  queryId: string;
};

export type QueryCancellationDecision =
  | 'cancel-backend'
  | 'disconnect-connection'
  | 'already-finished'
  | 'not-found';

export type QueryCancelResponse = {
  queryId: string;
  connectionId?: ConnectionId;
  decision: QueryCancellationDecision;
  backendPid?: number;
  retryAfterMs?: number;
  message: string;
};

export type QueryHistoryItem = {
  id: string;
  connectionId: ConnectionId;
  sql: string;
  status: 'success' | 'failed' | 'blocked' | 'cancelled';
  rowCount?: number;
  returnedRowCount?: number;
  rowLimit?: number;
  hasMore?: boolean;
  truncated?: boolean;
  elapsedMs?: number;
  errorMessage?: string;
  createdAt: string;
  safety: QuerySafetyReport;
  transaction?: QueryTransactionReport;
};

export type QueryHistoryRequest = {
  connectionId?: ConnectionId;
  limit?: number;
  offset?: number;
  searchText?: string;
  status?: QueryHistoryItem['status'] | QueryHistoryItem['status'][];
  riskLevel?: QueryRiskLevel | QueryRiskLevel[];
  statementKind?: string | string[];
  createdFrom?: string;
  createdTo?: string;
};

export type UsageSnapshot = {
  mode: UsageMode;
  windowStartedAt: string;
  windowEndsAt?: string;
  completedRounds: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};
