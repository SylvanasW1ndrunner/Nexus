export type ConnectionId = string;
export type QueryId = string;

export type DatabaseEngine = 'postgres';

export type ExecutionMode = 'ask' | 'auto';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export type QueryRiskLevel = 'safe' | 'caution' | 'dangerous' | 'blocked';

export type UsageMode = 'byok' | 'subscription';

export type DbColumnValue = string | number | boolean | null | Date | Buffer | Record<string, unknown>;

export type QueryResultRow = Record<string, DbColumnValue>;
