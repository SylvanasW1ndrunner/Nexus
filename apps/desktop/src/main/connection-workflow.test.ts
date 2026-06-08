import { describe, expect, it } from 'vitest';
import {
  err,
  ok,
  type ConnectionInput,
  type Result,
  type SavedConnection,
} from '@dbagent/shared';
import { createConnectionWorkflow } from './connection-workflow.js';

const baseConnection: SavedConnection = {
  id: 'conn-workflow',
  name: 'Remote PG',
  engine: 'postgres',
  host: 'db.example.com',
  port: 5432,
  database: 'warehouse',
  username: 'analyst',
  ssl: true,
  readOnly: true,
  connectionTimeoutMs: 10_000,
  statementTimeoutMs: 60_000,
  status: 'disconnected',
  createdAt: '2026-06-08T00:00:00.000Z',
  updatedAt: '2026-06-08T00:00:00.000Z',
};

const baseInput: ConnectionInput = {
  name: baseConnection.name,
  engine: 'postgres',
  host: baseConnection.host,
  port: baseConnection.port,
  database: baseConnection.database,
  username: baseConnection.username,
  password: 'pg-secret',
  ssl: true,
  readOnly: true,
  connectionTimeoutMs: 10_000,
  statementTimeoutMs: 60_000,
};

describe('createConnectionWorkflow', () => {
  it('creates a validated connection and stores its password outside metadata', async () => {
    const harness = createHarness({ connections: [] });

    const result = await harness.workflow.create(baseInput);

    expect(result.ok).toBe(true);
    expect(harness.connections).toHaveLength(1);
    expect(harness.credentials.get('generated-1')).toBe('pg-secret');
    expect(harness.connections[0]).not.toHaveProperty('password');
  });

  it('does not save credentials or touch drivers when updating a missing connection', async () => {
    const harness = createHarness({ connections: [] });

    const result = await harness.workflow.update('missing-connection', { password: 'orphan-secret' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
    expect(harness.credentials.size).toBe(0);
    expect(harness.driverCalls).toEqual([]);
  });

  it('updates metadata, saves a replacement password, disconnects the active pool, and marks disconnected', async () => {
    const harness = createHarness({ connections: [{ ...baseConnection, status: 'connected' }] });

    const result = await harness.workflow.update(baseConnection.id, {
      name: 'Remote PG prod',
      password: 'new-secret',
      statementTimeoutMs: 30_000,
    });

    expect(result.ok).toBe(true);
    expect(harness.credentials.get(baseConnection.id)).toBe('new-secret');
    expect(harness.driverCalls).toEqual([{ type: 'disconnect', engine: 'postgres', connectionId: baseConnection.id }]);
    expect(harness.connections[0]).toMatchObject({
      name: 'Remote PG prod',
      statementTimeoutMs: 30_000,
      status: 'disconnected',
    });
  });

  it('marks a saved connection as error when the driver cannot connect', async () => {
    const harness = createHarness({
      connections: [baseConnection],
      connectResult: err({ code: 'DB_CONNECTION_TIMEOUT', message: 'Connection timed out.', retryable: true }),
    });

    const result = await harness.workflow.connect(baseConnection.id);

    expect(result.ok).toBe(false);
    expect(harness.driverCalls).toEqual([{ type: 'connect', engine: 'postgres', connectionId: baseConnection.id }]);
    expect(harness.connections[0]?.status).toBe('error');
  });

  it('disconnects, removes metadata, and deletes credentials when removing a connection', async () => {
    const harness = createHarness({ connections: [baseConnection] });
    harness.credentials.set(baseConnection.id, 'pg-secret');

    const result = await harness.workflow.remove(baseConnection.id);

    expect(result).toEqual(ok({ id: baseConnection.id }));
    expect(harness.connections).toEqual([]);
    expect(harness.credentials.has(baseConnection.id)).toBe(false);
    expect(harness.driverCalls).toEqual([{ type: 'disconnect', engine: 'postgres', connectionId: baseConnection.id }]);
  });
});

function createHarness(options: {
  connections: SavedConnection[];
  connectResult?: Result<SavedConnection>;
}) {
  const connections = options.connections.map((connection) => ({ ...connection }));
  const credentials = new Map<string, string>();
  const driverCalls: Array<
    | { type: 'test'; engine: string; host: string }
    | { type: 'connect'; engine: string; connectionId: string }
    | { type: 'disconnect'; engine: string; connectionId: string }
  > = [];

  return {
    connections,
    credentials,
    driverCalls,
    workflow: createConnectionWorkflow({
      connections: {
        list() {
          return Promise.resolve(connections);
        },
        create(input) {
          const connection: SavedConnection = {
            id: `generated-${connections.length + 1}`,
            name: input.name.trim(),
            engine: input.engine,
            host: input.host.trim(),
            port: input.port,
            database: input.database.trim(),
            username: input.username.trim(),
            readOnly: input.readOnly ?? true,
            status: 'disconnected',
            createdAt: '2026-06-08T00:00:00.000Z',
            updatedAt: '2026-06-08T00:00:00.000Z',
          };
          if (input.ssl !== undefined) connection.ssl = input.ssl;
          if (input.connectionTimeoutMs !== undefined) connection.connectionTimeoutMs = input.connectionTimeoutMs;
          if (input.statementTimeoutMs !== undefined) connection.statementTimeoutMs = input.statementTimeoutMs;
          connections.push(connection);
          return Promise.resolve(connection);
        },
        update(id, patch) {
          const index = connections.findIndex((connection) => connection.id === id);
          if (index === -1) return Promise.resolve(undefined);
          const current = connections[index]!;
          const updated: SavedConnection = {
            ...current,
            ...('name' in patch && patch.name !== undefined ? { name: patch.name.trim() } : {}),
            ...('statementTimeoutMs' in patch ? { statementTimeoutMs: patch.statementTimeoutMs } : {}),
            updatedAt: '2026-06-08T00:01:00.000Z',
          };
          connections[index] = updated;
          return Promise.resolve(updated);
        },
        remove(id) {
          const index = connections.findIndex((connection) => connection.id === id);
          if (index === -1) return Promise.resolve(false);
          connections.splice(index, 1);
          return Promise.resolve(true);
        },
        markStatus(id, status) {
          const connection = connections.find((item) => item.id === id);
          if (!connection) return Promise.resolve(undefined);
          connection.status = status;
          connection.updatedAt = '2026-06-08T00:02:00.000Z';
          return Promise.resolve(connection);
        },
      },
      credentials: {
        save(connectionId, password) {
          credentials.set(connectionId, password);
          return Promise.resolve();
        },
        load(connectionId) {
          return Promise.resolve(credentials.get(connectionId));
        },
        remove(connectionId) {
          credentials.delete(connectionId);
          return Promise.resolve();
        },
      },
      driverForEngine(engine) {
        return {
          test(config) {
            driverCalls.push({ type: 'test', engine, host: config.host });
            return Promise.resolve(ok({ latencyMs: 12 }));
          },
          connect(config) {
            driverCalls.push({ type: 'connect', engine, connectionId: config.id ?? '' });
            return Promise.resolve(options.connectResult ?? ok({ ...baseConnection, id: config.id ?? baseConnection.id }));
          },
          disconnect(connectionId) {
            driverCalls.push({ type: 'disconnect', engine, connectionId });
            return Promise.resolve(ok(undefined));
          },
        };
      },
    }),
  };
}
