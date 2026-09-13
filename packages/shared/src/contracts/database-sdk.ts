export type ConnectionId = string;
export type QueryId = string;

/**
 * Engine identifiers are connector-owned values such as `postgres`, `mysql`,
 * `clickhouse` or a vendor warehouse identifier.  Keeping this open is
 * intentional: adding a connector must not require changing the shared
 * contract package.
 */
export type DatabaseEngine = string;

export type ExecutionMode = 'ask' | 'auto';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export type QueryRiskLevel = 'safe' | 'caution' | 'dangerous' | 'blocked';

export type DbColumnValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | Date
  | Uint8Array
  | DbColumnValue[]
  | { [key: string]: DbColumnValue };

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
