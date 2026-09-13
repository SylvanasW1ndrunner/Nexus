import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ok,
  stringifyPublicJson,
  type ConnectionProfile,
  type QueryResultRow,
  type SavedConnection,
} from '@dbagent/shared';
import { PostgresConnector } from '../src/postgres-connector.js';
import type { PostgresConnectorDriver, PostgresServerInfo } from '../src/postgres-driver.js';
import { ProjectDatabaseResultStore } from '../src/project-result-store.js';
import type { DatabaseResultStore } from '../src/result-store.js';

const timestamp = '2026-07-26T00:00:00.000Z';
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
  }));
});

function postgresDriverFixture(
  overrides: Partial<PostgresConnectorDriver> = {},
): PostgresConnectorDriver {
  const unavailable = () => Promise.reject(new Error('Unexpected PostgreSQL fixture operation.'));
  return {
    test: unavailable,
    connect: unavailable,
    disconnect: unavailable,
    execute: unavailable,
    cancel: unavailable,
    serverInfo: unavailable,
    discoverCatalog: unavailable,
    runtimeSnapshot: unavailable,
    terminateBackend: unavailable,
    maintainTable: unavailable,
    beginTransaction: unavailable,
    executeInTransaction: unavailable,
    createSavepoint: unavailable,
    rollbackToSavepoint: unavailable,
    commitTransaction: unavailable,
    rollbackTransaction: unavailable,
    ...overrides,
  };
}

describe('PostgresConnector portable result values', () => {
  it('defers result-store filesystem work until an awaited result operation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'schemanaut-postgres-result-lazy-'));
    temporaryDirectories.push(directory);
    const resultDirectory = join(directory, 'results');
    const connector = new PostgresConnector(postgresDriverFixture(), {
      resultStore: new ProjectDatabaseResultStore({
        projectId: 'project-lazy',
        rootDir: resultDirectory,
      }),
    });
    const profile: ConnectionProfile = {
      id: 'profile-lazy',
      name: 'Lazy PostgreSQL',
      connectorId: connector.manifest.id,
      engine: 'postgres',
      endpoints: [{ transport: 'tcp', host: '127.0.0.1', port: 5432, database: 'lazy' }],
      principal: 'tester',
      purpose: 'read-only',
      readOnly: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(existsSync(resultDirectory)).toBe(false);

    await expect(connector.readResult({ profile }, 'missing-result')).rejects.toThrow(
      /Result handle was not found/,
    );
    expect(existsSync(resultDirectory)).toBe(true);
  });

  it('does not run a full result-store garbage collection on every submit, page, and release', async () => {
    const store = await resultStore('gc-frequency');
    let garbageCollections = 0;
    const instrumentedStore = wrapResultStoreGarbageCollection(store, (...args) => {
      garbageCollections += 1;
      if (garbageCollections === 2) return Promise.reject(new Error('gc unavailable'));
      return store.collectGarbage(...args);
    });
    const connection: SavedConnection = {
      id: 'pg_profile-gc-frequency', name: 'GC PostgreSQL', engine: 'postgres',
      host: '127.0.0.1', port: 5432, database: 'gc', username: 'tester',
      readOnly: true, status: 'connected', createdAt: timestamp, updatedAt: timestamp,
    };
    const driver = postgresDriverFixture({
      connect: () => Promise.resolve(ok(connection)),
      serverInfo: () => Promise.resolve(ok({
        database: 'gc', currentUser: 'tester', engineVersion: '16.3',
        engineVersionNumber: 160_003, inRecovery: false,
      })),
      execute: () => Promise.resolve(ok({
        queryId: 'query-gc-frequency', columns: [{ name: 'value' }], rows: [{ value: 1 }],
        rowCount: 1, elapsedMs: 1,
        safety: {
          statementKind: 'SELECT', riskLevel: 'safe' as const,
          requiresConfirmation: false, blocked: false, reasons: [],
        },
      })),
    });
    const connector = new PostgresConnector(driver, { resultStore: instrumentedStore });
    const profile: ConnectionProfile = {
      id: 'profile-gc-frequency', name: 'GC PostgreSQL', connectorId: connector.manifest.id,
      engine: 'postgres',
      endpoints: [{ transport: 'tcp', host: '127.0.0.1', port: 5432, database: 'gc' }],
      principal: 'tester', purpose: 'read-only', readOnly: true,
      createdAt: timestamp, updatedAt: timestamp,
    };
    const context = { profile };
    await connector.connect(context);

    for (let index = 0; index < 17; index += 1) {
      const job = await connector.submit(context, {
        profileId: profile.id,
        sql: `select ${index}`,
        authorization: { authorizedClass: 'query' },
      });
      await connector.readResult(context, job.result!.id);
      await connector.releaseResult(context, job.result!.id);
      if (index === 0) expect(garbageCollections).toBe(1);
    }

    expect(garbageCollections).toBe(3);
  }, 15_000);

  it('retries result-store startup recovery after a transient garbage collection failure', async () => {
    const store = await resultStore('gc-startup-retry');
    let garbageCollections = 0;
    const instrumentedStore = wrapResultStoreGarbageCollection(store, (...args) => {
      garbageCollections += 1;
      if (garbageCollections === 1) return Promise.reject(new Error('temporary gc failure'));
      return store.collectGarbage(...args);
    });
    const connector = new PostgresConnector(postgresDriverFixture(), {
      resultStore: instrumentedStore,
    });
    const profile: ConnectionProfile = {
      id: 'profile-gc-startup-retry', name: 'GC retry PostgreSQL',
      connectorId: connector.manifest.id, engine: 'postgres',
      endpoints: [{ transport: 'tcp', host: '127.0.0.1', port: 5432, database: 'gc' }],
      principal: 'tester', purpose: 'read-only', readOnly: true,
      createdAt: timestamp, updatedAt: timestamp,
    };

    await expect(connector.readResult({ profile }, 'missing-result')).rejects.toThrow(
      /temporary gc failure/,
    );
    await expect(connector.readResult({ profile }, 'missing-result')).rejects.toThrow(
      /Result handle was not found/,
    );
    expect(garbageCollections).toBe(2);
  });

  it('scopes discovered resources and isolates stable identities for the same endpoint', async () => {
    const serverInfo: PostgresServerInfo = {
      database: 'shared',
      currentUser: 'tester',
      engineVersion: '16.3',
      engineVersionNumber: 160_003,
      inRecovery: false,
    };
    const driver = postgresDriverFixture({
      connect: (config: { id?: string; name: string }) =>
        Promise.resolve(
          ok({
            id: config.id!,
            name: config.name,
            engine: 'postgres' as const,
            host: '127.0.0.1',
            port: 5432,
            database: 'shared',
            username: 'tester',
            readOnly: true,
            status: 'connected' as const,
            createdAt: timestamp,
            updatedAt: timestamp,
          }),
        ),
      serverInfo: () => Promise.resolve(ok(serverInfo)),
      discoverCatalog: () => Promise.resolve(ok({ entries: [], hasMore: false })),
    });
    const connector = new PostgresConnector(driver);
    const createProfile = (tenantId: string): ConnectionProfile => ({
      id: `profile-${tenantId}`,
      name: `Shared PostgreSQL ${tenantId}`,
      connectorId: connector.manifest.id,
      engine: 'postgres',
      endpoints: [{ transport: 'tcp', host: '127.0.0.1', port: 5432, database: 'shared' }],
      principal: 'tester',
      purpose: 'read-only',
      readOnly: true,
      scope: { tenantId },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const profileA = createProfile('tenant-a');
    const profileB = createProfile('tenant-b');
    await connector.connect({ profile: profileA });
    await connector.connect({ profile: profileB });

    const pageA = await connector.discover({ profile: profileA }, { limit: 100 });
    const pageB = await connector.discover({ profile: profileB }, { limit: 100 });

    expect(pageA.resources).not.toHaveLength(0);
    expect(pageA.resources.every((resource) => resource.scope?.tenantId === 'tenant-a')).toBe(true);
    expect(pageB.resources.every((resource) => resource.scope?.tenantId === 'tenant-b')).toBe(true);
    expect(new Set(pageA.resources.map((resource) => resource.id))).not.toEqual(
      new Set(pageB.resources.map((resource) => resource.id)),
    );
  });

  it('measures result handles and pages with the public JSON encoding', async () => {
    const rows: QueryResultRow[] = [
      {
        exact: 9_007_199_254_740_993n,
        occurredAt: new Date('2026-07-26T08:09:10.000Z'),
        payload: Uint8Array.from([0, 127, 255]),
        nested: {
          values: [1n, new Date('2026-07-26T09:10:11.000Z'), Uint8Array.from([1, 2])],
        },
      },
    ];
    const connection: SavedConnection = {
      id: 'pg_profile-portable',
      name: 'Portable PostgreSQL',
      engine: 'postgres',
      host: '127.0.0.1',
      port: 5432,
      database: 'portable',
      username: 'tester',
      readOnly: true,
      status: 'connected',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const serverInfo: PostgresServerInfo = {
      database: 'portable',
      currentUser: 'tester',
      engineVersion: '16.3',
      engineVersionNumber: 160_003,
      inRecovery: false,
    };
    const driver = postgresDriverFixture({
      connect: () => Promise.resolve(ok(connection)),
      serverInfo: () => Promise.resolve(ok(serverInfo)),
      execute: () =>
        Promise.resolve(
          ok({
            queryId: 'query-portable',
            columns: [
              { name: 'exact' },
              { name: 'occurredAt' },
              { name: 'payload' },
              { name: 'nested' },
            ],
            rows,
            rowCount: 1,
            elapsedMs: 1,
            safety: {
              statementKind: 'SELECT',
              riskLevel: 'safe' as const,
              requiresConfirmation: false,
              blocked: false,
              reasons: [],
            },
          }),
        ),
    });
    const connector = new PostgresConnector(driver, { resultStore: await resultStore('portable') });
    const profile: ConnectionProfile = {
      id: 'profile-portable',
      name: 'Portable PostgreSQL',
      connectorId: connector.manifest.id,
      engine: 'postgres',
      endpoints: [{ transport: 'tcp', host: '127.0.0.1', port: 5432, database: 'portable' }],
      principal: 'tester',
      purpose: 'read-only',
      readOnly: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const context = { profile };
    await connector.connect(context);

    const job = await connector.submit(context, {
      profileId: profile.id,
      sql: 'select portable_values',
      authorization: { authorizedClass: 'query' },
    });
    const expectedBytes = Buffer.byteLength(stringifyPublicJson(rows));

    expect(job).toMatchObject({
      state: 'succeeded',
      result: { byteCount: expectedBytes },
    });
    const page = await connector.readResult(context, job.result!.id);
    expect(page.byteCount).toBe(expectedBytes);
    expect(page.rows).toEqual(rows);
  });

  it('restores PostgreSQL bytea values as Buffer after durable paging', async () => {
    const row = { rawValue: Buffer.from([0, 127, 255]) };
    const connection: SavedConnection = {
      id: 'pg_profile-buffer', name: 'Buffer PostgreSQL', engine: 'postgres',
      host: '127.0.0.1', port: 5432, database: 'buffer', username: 'tester',
      readOnly: true, status: 'connected', createdAt: timestamp, updatedAt: timestamp,
    };
    const driver = postgresDriverFixture({
      connect: () => Promise.resolve(ok(connection)),
      serverInfo: () => Promise.resolve(ok({
        database: 'buffer', currentUser: 'tester', engineVersion: '16.3',
        engineVersionNumber: 160_003, inRecovery: false,
      })),
      execute: () => Promise.resolve(ok({
        queryId: 'query-buffer', columns: [{ name: 'rawValue', dataType: 'bytea' }],
        rows: [row], rowCount: 1, elapsedMs: 1,
        safety: {
          statementKind: 'SELECT', riskLevel: 'safe' as const,
          requiresConfirmation: false, blocked: false, reasons: [],
        },
      })),
    });
    const connector = new PostgresConnector(driver, { resultStore: await resultStore('buffer') });
    const profile: ConnectionProfile = {
      id: 'profile-buffer', name: 'Buffer PostgreSQL', connectorId: connector.manifest.id,
      engine: 'postgres',
      endpoints: [{ transport: 'tcp', host: '127.0.0.1', port: 5432, database: 'buffer' }],
      principal: 'tester', purpose: 'read-only', readOnly: true,
      createdAt: timestamp, updatedAt: timestamp,
    };
    await connector.connect({ profile });
    const job = await connector.submit({ profile }, {
      profileId: profile.id, sql: 'select raw_value',
      authorization: { authorizedClass: 'query' },
    });

    const page = await connector.readResult({ profile }, job.result!.id);
    expect(Buffer.isBuffer(page.rows[0]?.rawValue)).toBe(true);
    expect(page.rows[0]?.rawValue).toEqual(row.rawValue);
  });

  it('bounds retained results, supports explicit release, and purges profile results on disconnect', async () => {
    const connection: SavedConnection = {
      id: 'pg_profile-retention',
      name: 'Retention PostgreSQL',
      engine: 'postgres',
      host: '127.0.0.1',
      port: 5432,
      database: 'retention',
      username: 'tester',
      readOnly: true,
      status: 'connected',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const serverInfo: PostgresServerInfo = {
      database: 'retention',
      currentUser: 'tester',
      engineVersion: '16.3',
      engineVersionNumber: 160_003,
      inRecovery: false,
    };
    let sequence = 0;
    const driver = postgresDriverFixture({
      connect: () => Promise.resolve(ok(connection)),
      disconnect: () => Promise.resolve(ok(undefined)),
      serverInfo: () => Promise.resolve(ok(serverInfo)),
      execute: () => {
        sequence += 1;
        return Promise.resolve(
          ok({
            queryId: `query-retention-${sequence}`,
            columns: [{ name: 'value' }],
            rows: [{ value: sequence }],
            rowCount: 1,
            elapsedMs: 1,
            safety: {
              statementKind: 'SELECT',
              riskLevel: 'safe' as const,
              requiresConfirmation: false,
              blocked: false,
              reasons: [],
            },
          }),
        );
      },
    });
    const connector = new PostgresConnector(driver, {
      resultStore: await resultStore('retention'),
      maxRetainedResults: 2,
      maxRetainedResultBytes: 1_024,
    });
    const profile: ConnectionProfile = {
      id: 'profile-retention',
      name: 'Retention PostgreSQL',
      connectorId: connector.manifest.id,
      engine: 'postgres',
      endpoints: [{ transport: 'tcp', host: '127.0.0.1', port: 5432, database: 'retention' }],
      principal: 'tester',
      purpose: 'read-only',
      readOnly: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const context = { profile };
    await connector.connect(context);

    const first = await connector.submit(context, {
      profileId: profile.id,
      sql: 'select 1',
      authorization: { authorizedClass: 'query' },
    });
    const second = await connector.submit(context, {
      profileId: profile.id,
      sql: 'select 2',
      authorization: { authorizedClass: 'query' },
    });
    const third = await connector.submit(context, {
      profileId: profile.id,
      sql: 'select 3',
      authorization: { authorizedClass: 'query' },
    });

    await expect(connector.readResult(context, first.result!.id)).rejects.toThrow(
      /Result handle was not found/,
    );
    await expect(connector.readResult(context, second.result!.id)).resolves.toMatchObject({
      rows: [{ value: 2 }],
    });
    await expect(connector.releaseResult(context, second.result!.id)).resolves.toBe(true);
    await expect(connector.releaseResult(context, second.result!.id)).resolves.toBe(false);
    await expect(connector.readResult(context, second.result!.id)).rejects.toThrow(
      /Result handle was not found/,
    );

    await connector.disconnect(context);
    await expect(connector.readResult(context, third.result!.id)).rejects.toThrow(
      /Result handle was not found/,
    );
  });
});

async function resultStore(label: string): Promise<ProjectDatabaseResultStore> {
  const directory = await mkdtemp(join(tmpdir(), `schemanaut-postgres-result-${label}-`));
  temporaryDirectories.push(directory);
  return new ProjectDatabaseResultStore({
    projectId: `project-${label}`,
    rootDir: join(directory, 'results'),
  });
}

function wrapResultStoreGarbageCollection(
  store: ProjectDatabaseResultStore,
  collectGarbage: DatabaseResultStore['collectGarbage'],
): DatabaseResultStore {
  return {
    create: (input) => store.create(input),
    page: (handle, request) => store.page(handle, request),
    export: (handle, format) => store.export(handle, format),
    openExport: (artifact, options) => store.openExport(artifact, options),
    inspect: (resultId) => store.inspect(resultId),
    getHandle: (resultId) => store.getHandle(resultId),
    discardStaged: (resultId) => store.discardStaged(resultId),
    expire: (resultId, reason) => store.expire(resultId, reason),
    collectGarbage,
  };
}
