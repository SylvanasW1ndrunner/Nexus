import type {
  ConnectionId,
  DatabaseEngine,
  QueryExecutionResult,
  QueryRequest,
  SavedConnection,
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
  ssl?: boolean;
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

export interface IDatabaseDriver {
  readonly capabilities: DatabaseCapabilities;
  test(config: DatabaseConnectionConfig): Promise<Result<{ latencyMs: number }>>;
  connect(config: DatabaseConnectionConfig): Promise<Result<SavedConnection>>;
  disconnect(connectionId: ConnectionId): Promise<Result<void>>;
  execute(request: QueryRequest, connection: SavedConnection): Promise<Result<QueryExecutionResult>>;
  listTables(connectionId: ConnectionId): Promise<Result<TableSummary[]>>;
}
