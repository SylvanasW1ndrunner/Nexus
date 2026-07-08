import type { DatabaseConnectionConfig, IDatabaseDriver } from '@dbagent/core-db';
import {
  err,
  ok,
  type ConnectionId,
  type ConnectionInput,
  type DatabaseEngine,
  type Result,
  type SavedConnection,
} from '@dbagent/shared';
import { validateConnectionInput } from './connection-validation.js';

type ConnectionRepository = {
  list(): Promise<SavedConnection[]>;
  create(input: ConnectionInput): Promise<SavedConnection>;
  update(id: ConnectionId, patch: Partial<ConnectionInput>): Promise<SavedConnection | undefined>;
  remove(id: ConnectionId): Promise<boolean>;
  markStatus(id: ConnectionId, status: SavedConnection['status']): Promise<SavedConnection | undefined>;
};

type CredentialRepository = {
  save(connectionId: ConnectionId, password: string): Promise<void>;
  load(connectionId: ConnectionId): Promise<string | undefined>;
  remove(connectionId: ConnectionId): Promise<void>;
};

type SchemaRagConnectionLifecycle = {
  clear(connectionId: ConnectionId): void | Promise<void>;
  removeSnapshot(connectionId: ConnectionId): Promise<void>;
};

export type ConnectionWorkflowDependencies = {
  connections: ConnectionRepository;
  credentials: CredentialRepository;
  driverForEngine: (engine: DatabaseEngine) => Pick<IDatabaseDriver, 'test' | 'connect' | 'disconnect'>;
  schemaRag?: SchemaRagConnectionLifecycle;
};

export function createConnectionWorkflow({
  connections,
  credentials,
  driverForEngine,
  schemaRag,
}: ConnectionWorkflowDependencies) {
  async function findConnection(id: ConnectionId): Promise<SavedConnection | undefined> {
    return (await connections.list()).find((connection) => connection.id === id);
  }

  return {
    async list(): Promise<Result<SavedConnection[]>> {
      return ok(await connections.list());
    },

    async test(input: ConnectionInput): Promise<Result<{ success: true; latencyMs: number }>> {
      const validation = validateConnectionInput(input);
      if (validation) return err(validation);
      const result = await driverForEngine(input.engine).test(toDbConfig(input));
      return result.ok ? ok({ success: true, latencyMs: result.data.latencyMs }) : result;
    },

    async create(input: ConnectionInput): Promise<Result<SavedConnection>> {
      const validation = validateConnectionInput(input);
      if (validation) return err(validation);
      const connection = await connections.create(input);
      if (input.password) await credentials.save(connection.id, input.password);
      return ok(connection);
    },

    async update(id: ConnectionId, patch: Partial<ConnectionInput>): Promise<Result<SavedConnection>> {
      const existing = await findConnection(id);
      if (!existing) return err({ code: 'NOT_FOUND', message: 'Connection not found.' });

      const validation = validateConnectionInput(toConnectionInput(existing, patch));
      if (validation) return err(validation);

      const updated = await connections.update(id, patch);
      if (!updated) return err({ code: 'NOT_FOUND', message: 'Connection not found.' });
      if (patch.password) await credentials.save(id, patch.password);

      await driverForEngine(existing.engine).disconnect(id);
      const disconnected = await connections.markStatus(id, 'disconnected');
      return ok(disconnected ?? updated);
    },

    async remove(id: ConnectionId): Promise<Result<{ id: ConnectionId }>> {
      const existing = await findConnection(id);
      if (!existing) return err({ code: 'NOT_FOUND', message: 'Connection not found.' });

      await driverForEngine(existing.engine).disconnect(id);
      const cleanup = await cleanupSchemaRag(schemaRag, id);
      if (!cleanup.ok) return cleanup;
      const removed = await connections.remove(id);
      if (!removed) return err({ code: 'NOT_FOUND', message: 'Connection not found.' });
      await credentials.remove(id);
      return ok({ id });
    },

    async connect(id: ConnectionId): Promise<Result<SavedConnection>> {
      const connection = await findConnection(id);
      if (!connection) return err({ code: 'NOT_FOUND', message: 'Connection not found.' });

      const password = await credentials.load(connection.id);
      const config: DatabaseConnectionConfig = { ...connection, maxClients: 5 };
      if (password !== undefined) config.password = password;

      const result = await driverForEngine(connection.engine).connect(config);
      if (!result.ok) {
        await connections.markStatus(id, 'error');
        return result;
      }
      const updated = await connections.markStatus(id, 'connected');
      return ok(updated ?? result.data);
    },

    async disconnect(id: ConnectionId): Promise<Result<SavedConnection>> {
      const connection = await findConnection(id);
      if (!connection) return err({ code: 'NOT_FOUND', message: 'Connection not found.' });

      await driverForEngine(connection.engine).disconnect(id);
      const updated = await connections.markStatus(id, 'disconnected');
      return updated ? ok(updated) : err({ code: 'NOT_FOUND', message: 'Connection not found.' });
    },
  };
}

async function cleanupSchemaRag(
  schemaRag: SchemaRagConnectionLifecycle | undefined,
  connectionId: ConnectionId,
): Promise<Result<{ id: ConnectionId }>> {
  if (!schemaRag) return ok({ id: connectionId });

  try {
    await schemaRag.removeSnapshot(connectionId);
    await schemaRag.clear(connectionId);
    return ok({ id: connectionId });
  } catch (error) {
    return err({
      code: 'INTERNAL_ERROR',
      message: 'Failed to remove Schema RAG snapshot for the deleted connection.',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

function toDbConfig(input: ConnectionInput): DatabaseConnectionConfig {
  return {
    ...input,
    readOnly: input.readOnly ?? true,
    maxClients: 5,
  };
}

function toConnectionInput(connection: SavedConnection, patch: Partial<ConnectionInput>): ConnectionInput {
  const input: ConnectionInput = {
    name: patch.name ?? connection.name,
    engine: connection.engine,
    host: patch.host ?? connection.host,
    port: patch.port ?? connection.port,
    database: patch.database ?? connection.database,
    username: patch.username ?? connection.username,
    readOnly: patch.readOnly ?? connection.readOnly,
  };
  if (patch.password !== undefined) input.password = patch.password;
  const ssl = patch.ssl ?? connection.ssl;
  const connectionTimeoutMs = patch.connectionTimeoutMs ?? connection.connectionTimeoutMs;
  const statementTimeoutMs = patch.statementTimeoutMs ?? connection.statementTimeoutMs;
  if (ssl !== undefined) input.ssl = ssl;
  if (connectionTimeoutMs !== undefined) input.connectionTimeoutMs = connectionTimeoutMs;
  if (statementTimeoutMs !== undefined) input.statementTimeoutMs = statementTimeoutMs;
  return input;
}
