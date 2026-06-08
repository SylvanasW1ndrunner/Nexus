import type { ConnectionInput, SavedConnection } from '@dbagent/shared';

export const DEFAULT_CONNECTION_TIMEOUT_MS = 10000;
export const DEFAULT_STATEMENT_TIMEOUT_MS = 60000;

export const defaultConnectionDraft: ConnectionInput = {
  name: 'Local PostgreSQL',
  engine: 'postgres',
  host: '127.0.0.1',
  port: 5432,
  database: 'postgres',
  username: 'postgres',
  password: '',
  readOnly: true,
  ssl: false,
  connectionTimeoutMs: DEFAULT_CONNECTION_TIMEOUT_MS,
  statementTimeoutMs: DEFAULT_STATEMENT_TIMEOUT_MS,
};

export function connectionToDraft(connection: SavedConnection): ConnectionInput {
  return {
    name: connection.name,
    engine: connection.engine,
    host: connection.host,
    port: connection.port,
    database: connection.database,
    username: connection.username,
    password: '',
    readOnly: connection.readOnly,
    ssl: connection.ssl ?? false,
    connectionTimeoutMs: connection.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    statementTimeoutMs: connection.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
  };
}
