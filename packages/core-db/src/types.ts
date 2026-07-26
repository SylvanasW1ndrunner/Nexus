import type {
  ConnectionId,
  DatabaseEngine,
  QueryCancelResponse,
  QueryExecutionResult,
  QueryRequest,
  SavedConnection,
  TableDetail,
} from '@dbagent/shared';
import type { Result } from '@dbagent/shared';

export type DatabaseConnectionConfig = {
  id?: ConnectionId;
  name: string;
  engine: DatabaseEngine;
  host: string;
  port: number;
  database: string;
  username: string;
  password?: string;
  ssl?: boolean | 'require' | 'verify-ca' | 'verify-full';
  readOnly: boolean;
  maxClients?: number;
  connectionTimeoutMs?: number;
  statementTimeoutMs?: number;
};

export type DatabaseCapabilities = {
  engine: DatabaseEngine;
  supportsTransactions: boolean;
  supportsExplain: boolean;
  supportsSchemas: boolean;
};

export type TableSummary = {
  schema: string;
  name: string;
  type: 'table' | 'view';
  comment?: string;
};

export type QueryExecutionObserver = {
  onBackendPid?(input: { queryId: string; connectionId: ConnectionId; backendPid: number }): void;
  /**
   * Cancels the in-flight database operation when the caller abandons it.
   * Drivers that can address a running backend should propagate this signal
   * to that backend instead of only abandoning the local Promise.
   */
  signal?: AbortSignal;
};

export interface IDatabaseDriver {
  readonly capabilities: DatabaseCapabilities;
  test(config: DatabaseConnectionConfig): Promise<Result<{ latencyMs: number }>>;
  connect(config: DatabaseConnectionConfig): Promise<Result<SavedConnection>>;
  disconnect(connectionId: ConnectionId): Promise<Result<void>>;
  execute(
    request: QueryRequest,
    connection: SavedConnection,
    observer?: QueryExecutionObserver,
  ): Promise<Result<QueryExecutionResult>>;
  cancel?(
    request: QueryCancelResponse,
    connection: SavedConnection,
  ): Promise<Result<QueryCancelResponse>>;
  listTables(connectionId: ConnectionId): Promise<Result<TableSummary[]>>;
  describeTable(
    connectionId: ConnectionId,
    schema: string,
    table: string,
  ): Promise<Result<TableDetail>>;
}
