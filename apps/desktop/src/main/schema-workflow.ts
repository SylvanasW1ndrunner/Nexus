import type { IDatabaseDriver, TableSummary } from '@dbagent/core-db';
import {
  err,
  type ConnectionId,
  type DatabaseEngine,
  type Result,
  type SavedConnection,
  type TableDetail,
} from '@dbagent/shared';

type ConnectionReader = {
  list(): Promise<SavedConnection[]>;
};

export type SchemaWorkflowDependencies = {
  connections: ConnectionReader;
  driverForEngine: (engine: DatabaseEngine) => Pick<IDatabaseDriver, 'listTables' | 'describeTable'>;
};

export function createSchemaWorkflow({ connections, driverForEngine }: SchemaWorkflowDependencies): {
  listTables(connectionId: ConnectionId): Promise<Result<TableSummary[]>>;
  describeTable(connectionId: ConnectionId, schema: string, table: string): Promise<Result<TableDetail>>;
} {
  async function findConnection(connectionId: ConnectionId): Promise<Result<SavedConnection>> {
    const connection = (await connections.list()).find((item) => item.id === connectionId);
    return connection ? { ok: true, data: connection } : err({ code: 'NOT_FOUND', message: 'Connection not found.' });
  }

  return {
    async listTables(connectionId) {
      const connection = await findConnection(connectionId);
      if (!connection.ok) return connection;
      return driverForEngine(connection.data.engine).listTables(connectionId);
    },

    async describeTable(connectionId, schema, table) {
      const connection = await findConnection(connectionId);
      if (!connection.ok) return connection;
      return driverForEngine(connection.data.engine).describeTable(connectionId, schema, table);
    },
  };
}
