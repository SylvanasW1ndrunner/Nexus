import type {
  ConnectionId,
  ConnectionStatus,
  DatabaseEngine,
  QueryResultRow,
  QueryRiskLevel,
  TableDetail,
  TableSummary,
  UsageMode,
} from './domain.js';
import type { Result } from './result.js';

export const ipcChannels = {
  connection: {
    list: 'connection:list',
    test: 'connection:test',
    create: 'connection:create',
    update: 'connection:update',
    remove: 'connection:remove',
    connect: 'connection:connect',
    disconnect: 'connection:disconnect',
  },
  db: {
    executeQuery: 'db:execute-query',
    queryHistory: 'db:query-history',
    explainQuery: 'db:explain-query',
    listTables: 'db:list-tables',
    describeTable: 'db:describe-table',
  },
  app: {
    loadWorkspaceState: 'app:load-workspace-state',
    saveWorkspaceState: 'app:save-workspace-state',
  },
  auth: {
    login: 'auth:login',
    logout: 'auth:logout',
    status: 'auth:status',
  },
  usage: {
    currentQuota: 'usage:current-quota',
    history: 'usage:history',
  },
} as const;

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
  connectionId: ConnectionId;
  sql: string;
  limit?: number;
  dryRun?: boolean;
  confirmed?: boolean;
};

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
  elapsedMs: number;
  safety: QuerySafetyReport;
};

export type QueryHistoryItem = {
  id: string;
  connectionId: ConnectionId;
  sql: string;
  status: 'success' | 'failed' | 'blocked';
  rowCount?: number;
  elapsedMs?: number;
  errorMessage?: string;
  createdAt: string;
  safety: QuerySafetyReport;
};

export type AuthStatus = {
  authenticated: boolean;
  user?: {
    id: string;
    email: string;
    plan: 'free' | 'pro' | 'team';
  };
};

export type UsageSnapshot = {
  mode: UsageMode;
  windowStartedAt: string;
  windowEndsAt?: string;
  usedRounds: number;
  roundLimit?: number;
  byokTokenEstimate: number;
};

export type WorkspaceState = {
  activeConnectionId?: string;
  sqlDraft: string;
  updatedAt: string;
};

export type IpcRequestMap = {
  'connection:list': void;
  'connection:test': ConnectionInput;
  'connection:create': ConnectionInput;
  'connection:update': { id: ConnectionId; patch: Partial<ConnectionInput> };
  'connection:remove': { id: ConnectionId };
  'connection:connect': { id: ConnectionId };
  'connection:disconnect': { id: ConnectionId };
  'db:execute-query': QueryRequest;
  'db:query-history': { connectionId?: ConnectionId; limit?: number };
  'db:explain-query': QueryRequest;
  'db:list-tables': { connectionId: ConnectionId };
  'db:describe-table': { connectionId: ConnectionId; schema: string; table: string };
  'auth:login': { email: string; password: string };
  'auth:logout': void;
  'auth:status': void;
  'usage:current-quota': void;
  'usage:history': { limit?: number };
  'app:load-workspace-state': void;
  'app:save-workspace-state': WorkspaceState;
};

export type IpcResponseMap = {
  'connection:list': Result<SavedConnection[]>;
  'connection:test': Result<{ success: true; latencyMs: number }>;
  'connection:create': Result<SavedConnection>;
  'connection:update': Result<SavedConnection>;
  'connection:remove': Result<{ id: ConnectionId }>;
  'connection:connect': Result<SavedConnection>;
  'connection:disconnect': Result<SavedConnection>;
  'db:execute-query': Result<QueryExecutionResult>;
  'db:query-history': Result<QueryHistoryItem[]>;
  'db:explain-query': Result<QueryExecutionResult>;
  'db:list-tables': Result<TableSummary[]>;
  'db:describe-table': Result<TableDetail>;
  'auth:login': Result<AuthStatus>;
  'auth:logout': Result<AuthStatus>;
  'auth:status': Result<AuthStatus>;
  'usage:current-quota': Result<UsageSnapshot>;
  'usage:history': Result<UsageSnapshot[]>;
  'app:load-workspace-state': Result<WorkspaceState | undefined>;
  'app:save-workspace-state': Result<WorkspaceState>;
};

export type IpcChannel = keyof IpcRequestMap;
