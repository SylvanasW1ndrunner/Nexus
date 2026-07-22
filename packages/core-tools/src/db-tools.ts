import { registerSchemaRagTools, type ToolRegistry } from '@dbagent/core-agent';
import {
  analyzeSqlSafety,
  type IDatabaseDriver,
  type QueryHistoryListOptions,
  type TableSummary,
} from '@dbagent/core-db';
import type { SchemaRagEngine } from '@dbagent/core-rag';
import type { QueryHistoryItem, QueryRiskLevel, SavedConnection } from '@dbagent/shared';
import { optionalPositiveInteger, optionalString, requireString } from './validation.js';

export type DbToolDependencies = {
  registry: ToolRegistry;
  driver: IDatabaseDriver;
  getConnection: (connectionId: string) => SavedConnection | undefined | Promise<SavedConnection | undefined>;
  rag?: SchemaRagEngine;
  history?: {
    list(options?: QueryHistoryListOptions): Promise<QueryHistoryItem[]>;
  };
};

export function registerDatabaseTools(dependencies: DbToolDependencies): void {
  const { registry, driver, getConnection, rag, history } = dependencies;

  registry.register(
    {
      name: 'list_schemas',
      description: 'List schemas available in the active database connection.',
      inputSchema: objectSchema({
        connectionId: { type: 'string' },
      }),
      dangerLevel: 'safe',
      readonly: true,
    },
    async (args) => {
      const connectionId = requireString(args, 'connectionId');
      const result = await driver.listTables(connectionId);
      if (!result.ok) throw new Error(result.error.message);
      return {
        schemas: unique(result.data.map((table) => table.schema)).map((schema) => ({ schema })),
      };
    },
  );

  registry.register(
    {
      name: 'list_tables',
      description: 'List tables and views for a database connection, optionally filtered by schema.',
      inputSchema: objectSchema({
        connectionId: { type: 'string' },
        schema: { type: 'string' },
      }),
      dangerLevel: 'safe',
      readonly: true,
    },
    async (args) => {
      const connectionId = requireString(args, 'connectionId');
      const schema = optionalString(args, 'schema');
      const result = await driver.listTables(connectionId);
      if (!result.ok) throw new Error(result.error.message);
      return {
        tables: result.data.filter((table) => !schema || table.schema === schema).map(tableSummary),
      };
    },
  );

  registry.register(
    {
      name: 'describe_table',
      description: 'Describe a table with columns, primary key, comments, and foreign keys.',
      inputSchema: objectSchema({
        connectionId: { type: 'string' },
        schema: { type: 'string' },
        table: { type: 'string' },
      }),
      dangerLevel: 'safe',
      readonly: true,
    },
    async (args) => {
      const connectionId = requireString(args, 'connectionId');
      const schema = requireString(args, 'schema');
      const table = requireString(args, 'table');
      const result = await driver.describeTable(connectionId, schema, table);
      if (!result.ok) throw new Error(result.error.message);
      return result.data;
    },
  );

  registry.register(
    {
      name: 'audit_sql',
      description: 'Audit SQL safety before execution. Use this before write, DDL, or uncertain SQL.',
      inputSchema: objectSchema({
        connectionId: { type: 'string' },
        sql: { type: 'string' },
      }),
      dangerLevel: 'safe',
      readonly: true,
    },
    async (args) => {
      const connectionId = requireString(args, 'connectionId');
      const sql = requireString(args, 'sql');
      const connection = await requireConnection(getConnection, connectionId);
      return analyzeSqlSafety(sql, { readOnly: connection.readOnly });
    },
  );

  registry.register(
    {
      name: 'query_database',
      description: 'Execute readonly SQL and return result rows. Use for SELECT-style analysis.',
      inputSchema: objectSchema({
        connectionId: { type: 'string' },
        sql: { type: 'string' },
        limit: { type: 'number' },
      }),
      dangerLevel: 'medium',
      readonly: true,
    },
    async (args) => {
      const connectionId = requireString(args, 'connectionId');
      const sql = requireString(args, 'sql');
      const limit = optionalPositiveInteger(args, 'limit', 100);
      const connection = await requireConnection(getConnection, connectionId);
      const safety = analyzeSqlSafety(sql, { readOnly: true });
      if (safety.statementKind === 'EMPTY') {
        throw new Error('SQL is empty.');
      }
      if (safety.blocked || safety.requiresConfirmation) {
        throw new Error(`query_database only accepts readonly single-statement SQL. ${safety.reasons.join(' ')}`);
      }
      const result = await driver.execute(
        {
          connectionId,
          sql,
          ...(limit === undefined ? {} : { limit }),
        },
        connection,
      );
      if (!result.ok) throw new Error(result.error.message);
      return result.data;
    },
  );

  registry.register(
    {
      name: 'execute_sql',
      description: 'Execute SQL that may change data or schema. Requires stronger permissions.',
      inputSchema: objectSchema({
        connectionId: { type: 'string' },
        sql: { type: 'string' },
        confirmed: { type: 'boolean' },
      }),
      dangerLevel: 'high',
      readonly: false,
    },
    async (args, context) => {
      const connectionId = requireString(args, 'connectionId');
      const sql = requireString(args, 'sql');
      const connection = await requireConnection(getConnection, connectionId);
      const safety = analyzeSqlSafety(sql, { readOnly: connection.readOnly });
      if (safety.blocked) {
        throw new Error(`SQL is blocked by connection policy. ${safety.reasons.join(' ')}`);
      }
      if (safety.requiresConfirmation && (args.confirmed !== true || !isApprovedToolContext(context, 'execute_sql'))) {
        throw new Error(`SQL requires explicit confirmation. ${safety.reasons.join(' ')}`);
      }
      const result = await driver.execute({ connectionId, sql, confirmed: args.confirmed === true }, connection);
      if (!result.ok) throw new Error(result.error.message);
      return result.data;
    },
  );

  if (history) {
    registry.register(
      {
        name: 'read_query_history',
        description:
          'Read local SQL execution history for rerun planning and incident investigation. This does not execute SQL.',
        inputSchema: objectSchema({
          connectionId: { type: 'string' },
          searchText: { type: 'string' },
          status: { type: 'string' },
          riskLevel: { type: 'string' },
          statementKind: { type: 'string' },
          limit: { type: 'number' },
          offset: { type: 'number' },
        }),
        dangerLevel: 'safe',
        readonly: true,
      },
      async (args) => {
        const connectionId = optionalString(args, 'connectionId');
        const searchText = optionalString(args, 'searchText');
        const status = optionalHistoryStatuses(args, 'status');
        const riskLevel = optionalRiskLevels(args, 'riskLevel');
        const statementKind = optionalString(args, 'statementKind');
        const limit = optionalPositiveInteger(args, 'limit');
        const offset = optionalNonNegativeInteger(args, 'offset');
        return {
          items: await history.list({
            ...(connectionId ? { connectionId } : {}),
            ...(searchText ? { searchText } : {}),
            ...(status ? { status } : {}),
            ...(riskLevel ? { riskLevel } : {}),
            ...(statementKind ? { statementKind } : {}),
            ...(limit !== undefined ? { limit } : {}),
            ...(offset !== undefined ? { offset } : {}),
          }),
        };
      },
    );
  }

  if (rag) {
    registerSchemaRagTools(registry, rag, { skipExistingTools: true });

    registry.register(
      {
        name: 'build_schema_context',
        description: 'Build compact schema context for a user request.',
        inputSchema: objectSchema({
          connectionId: { type: 'string' },
          query: { type: 'string' },
          maxChars: { type: 'number' },
        }),
        dangerLevel: 'safe',
        readonly: true,
      },
      (args) => {
        const connectionId = requireString(args, 'connectionId');
        const query = requireString(args, 'query');
        const maxChars = optionalPositiveInteger(args, 'maxChars', 4_000);
        return rag.buildContext({
          connectionId,
          query,
          ...(maxChars === undefined ? {} : { maxChars }),
        });
      },
    );
  }
}

async function requireConnection(
  getConnection: (connectionId: string) => SavedConnection | undefined | Promise<SavedConnection | undefined>,
  connectionId: string,
): Promise<SavedConnection> {
  const connection = await getConnection(connectionId);
  if (!connection) throw new Error(`Connection is not active: ${connectionId}`);
  return connection;
}

function isApprovedToolContext(context: unknown, toolName: string): boolean {
  if (!context || typeof context !== 'object') return false;
  const approval = (context as { approval?: unknown }).approval;
  if (!approval || typeof approval !== 'object') return false;
  const record = approval as { granted?: unknown; toolName?: unknown };
  return record.granted === true && record.toolName === toolName;
}

function tableSummary(table: TableSummary): TableSummary {
  return table;
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function objectSchema(properties: Record<string, Record<string, unknown>>): Record<string, unknown> {
  return {
    type: 'object',
    properties,
  };
}

function optionalHistoryStatuses(
  args: Record<string, unknown>,
  key: string,
): QueryHistoryItem['status'] | QueryHistoryItem['status'][] | undefined {
  const values = optionalStringList(args, key);
  if (values === undefined) return undefined;
  const valid = new Set<QueryHistoryItem['status']>(['success', 'failed', 'blocked', 'cancelled']);
  for (const value of values) {
    if (!valid.has(value as QueryHistoryItem['status'])) {
      throw new Error(`Tool argument "${key}" contains an unsupported query history status.`);
    }
  }
  return values.length === 1 ? (values[0] as QueryHistoryItem['status']) : (values as QueryHistoryItem['status'][]);
}

function optionalRiskLevels(
  args: Record<string, unknown>,
  key: string,
): QueryRiskLevel | QueryRiskLevel[] | undefined {
  const values = optionalStringList(args, key);
  if (values === undefined) return undefined;
  const valid = new Set<QueryRiskLevel>(['safe', 'caution', 'dangerous', 'blocked']);
  for (const value of values) {
    if (!valid.has(value as QueryRiskLevel)) {
      throw new Error(`Tool argument "${key}" contains an unsupported SQL risk level.`);
    }
  }
  return values.length === 1 ? (values[0] as QueryRiskLevel) : (values as QueryRiskLevel[]);
}

function optionalStringList(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  const values = Array.isArray(value) ? value : [value];
  const normalized = values.map((item) => {
    if (typeof item !== 'string') throw new Error(`Tool argument "${key}" must be a string or string array.`);
    return item.trim();
  }).filter((item) => item.length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

function optionalNonNegativeInteger(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Tool argument "${key}" must be a non-negative integer.`);
  }
  return value;
}
