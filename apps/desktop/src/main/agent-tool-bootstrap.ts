import type { ToolRegistry } from '@dbagent/core-agent';
import type {
  DatabaseCapabilities,
  DatabaseConnectionConfig,
  IDatabaseDriver,
  QueryExecutionObserver,
  TableSummary,
} from '@dbagent/core-db';
import { SchemaRagEngine } from '@dbagent/core-rag';
import { registerDatabaseTools, registerWorkspaceTools } from '@dbagent/core-tools';
import { WorkspaceCore } from '@dbagent/core-workspace';
import type {
  ConnectionId,
  DatabaseEngine,
  QueryCancelResponse,
  QueryExecutionResult,
  QueryRequest,
  Result,
  SavedConnection,
  TableDetail,
  WorkspaceProject,
} from '@dbagent/shared';

type ConnectionReader = {
  list(): Promise<SavedConnection[]>;
};

type WorkspaceReader = {
  loadActive(): Promise<WorkspaceProject | undefined>;
};

export type AgentToolBootstrapDependencies = {
  registry: ToolRegistry;
  connections: ConnectionReader;
  workspaceProjects: WorkspaceReader;
  driverForEngine: (engine: DatabaseEngine) => IDatabaseDriver;
  rag?: SchemaRagEngine;
  workspace?: WorkspaceCore;
};

export function registerDesktopAgentTools(dependencies: AgentToolBootstrapDependencies): void {
  const rag = dependencies.rag ?? new SchemaRagEngine();
  registerDatabaseTools({
    registry: dependencies.registry,
    driver: new ConnectionRoutingDatabaseDriver(dependencies.connections, dependencies.driverForEngine),
    getConnection: async (connectionId) =>
      (await dependencies.connections.list()).find(
        (connection) => connection.id === connectionId && connection.status === 'connected',
      ),
    rag,
  });
  registerWorkspaceTools({
    registry: dependencies.registry,
    workspace: dependencies.workspace ?? new WorkspaceCore(),
    getWorkspaceRoot: () => undefined,
  });
}

class ConnectionRoutingDatabaseDriver implements IDatabaseDriver {
  readonly capabilities: DatabaseCapabilities = {
    engine: 'postgres',
    supportsTransactions: true,
    supportsExplain: true,
    supportsSchemas: true,
  };

  constructor(
    private readonly connections: ConnectionReader,
    private readonly driverForEngine: (engine: DatabaseEngine) => IDatabaseDriver,
  ) {}

  async test(config: DatabaseConnectionConfig): Promise<Result<{ latencyMs: number }>> {
    return this.driverForEngine(config.engine).test(config);
  }

  async connect(config: DatabaseConnectionConfig): Promise<Result<SavedConnection>> {
    return this.driverForEngine(config.engine).connect(config);
  }

  async disconnect(connectionId: ConnectionId): Promise<Result<void>> {
    const connection = await this.requireKnownConnection(connectionId);
    return this.driverForEngine(connection.engine).disconnect(connectionId);
  }

  async execute(
    request: QueryRequest,
    connection: SavedConnection,
    observer?: QueryExecutionObserver,
  ): Promise<Result<QueryExecutionResult>> {
    return this.driverForEngine(connection.engine).execute(request, connection, observer);
  }

  async cancel(request: QueryCancelResponse, connection: SavedConnection): Promise<Result<QueryCancelResponse>> {
    const driver = this.driverForEngine(connection.engine);
    if (!driver.cancel) {
      return {
        ok: false,
        error: {
          code: 'UNSUPPORTED_OPERATION',
          message: `Cancel is not supported for ${connection.engine}.`,
        },
      };
    }
    return driver.cancel(request, connection);
  }

  async listTables(connectionId: ConnectionId): Promise<Result<TableSummary[]>> {
    const connection = await this.requireKnownConnection(connectionId);
    return this.driverForEngine(connection.engine).listTables(connectionId);
  }

  async describeTable(connectionId: ConnectionId, schema: string, table: string): Promise<Result<TableDetail>> {
    const connection = await this.requireKnownConnection(connectionId);
    return this.driverForEngine(connection.engine).describeTable(connectionId, schema, table);
  }

  private async requireKnownConnection(connectionId: ConnectionId): Promise<SavedConnection> {
    const connection = (await this.connections.list()).find((item) => item.id === connectionId);
    if (!connection) throw new Error(`Connection is not registered: ${connectionId}`);
    return connection;
  }
}
