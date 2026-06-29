export type ConnectionId = string;
export type QueryId = string;

export type DatabaseEngine = 'postgres';

export type ExecutionMode = 'ask' | 'auto';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export type QueryRiskLevel = 'safe' | 'caution' | 'dangerous' | 'blocked';

export type UsageMode = 'byok' | 'subscription';

export type DbColumnValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | Date
  | Buffer
  | Record<string, unknown>;

export type QueryResultRow = Record<string, DbColumnValue>;

export type TableSummary = {
  schema: string;
  name: string;
  type: 'table' | 'view';
  comment?: string;
};

export type ColumnSummary = {
  name: string;
  ordinal: number;
  dataType: string;
  nullable: boolean;
  defaultValue?: string;
  comment?: string;
  isPrimaryKey: boolean;
  isIndexed?: boolean;
  isUnique?: boolean;
  foreignKey?: {
    schema: string;
    table: string;
    column: string;
  };
};

export type TableIndexSummary = {
  name: string;
  method: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
  valid: boolean;
  definition: string;
};

export type TableConstraintSummary = {
  name: string;
  type: 'primary_key' | 'foreign_key' | 'unique' | 'check' | 'exclusion' | 'unknown';
  columns: string[];
  definition: string;
};

export type TableDetail = TableSummary & {
  columns: ColumnSummary[];
  primaryKey: string[];
  rowEstimate?: number;
  viewDefinition?: string;
  indexes?: TableIndexSummary[];
  constraints?: TableConstraintSummary[];
};
