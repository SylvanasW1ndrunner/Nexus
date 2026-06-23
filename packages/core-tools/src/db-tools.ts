import { registerSchemaRagTools, type ToolRegistry } from '@dbagent/core-agent';
import type { IDatabaseDriver, TableSummary } from '@dbagent/core-db';
import type { SchemaRagEngine } from '@dbagent/core-rag';
import type { SavedConnection } from '@dbagent/shared';
import { optionalPositiveInteger, optionalString, requireString } from './validation.js';

export type DbToolDependencies = {
  registry: ToolRegistry;
  driver: IDatabaseDriver;
  getConnection: (connectionId: string) => SavedConnection | undefined;
  rag?: SchemaRagEngine;
};

export function registerDatabaseTools(dependencies: DbToolDependencies): void {
  const { registry, driver, getConnection, rag } = dependencies;

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
      const connection = requireConnection(getConnection, connectionId);
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
    async (args) => {
      const connectionId = requireString(args, 'connectionId');
      const sql = requireString(args, 'sql');
      const connection = requireConnection(getConnection, connectionId);
      const result = await driver.execute({ connectionId, sql, confirmed: args.confirmed === true }, connection);
      if (!result.ok) throw new Error(result.error.message);
      return result.data;
    },
  );

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

function requireConnection(
  getConnection: (connectionId: string) => SavedConnection | undefined,
  connectionId: string,
): SavedConnection {
  const connection = getConnection(connectionId);
  if (!connection) throw new Error(`Connection is not active: ${connectionId}`);
  return connection;
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
