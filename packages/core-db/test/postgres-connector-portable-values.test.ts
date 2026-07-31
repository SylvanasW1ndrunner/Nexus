import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  ok,
  stringifyPublicJson,
  type ConnectionProfile,
  type QueryResultRow,
  type SavedConnection,
} from '@dbagent/shared';
import { PostgresConnector } from '../src/postgres-connector.js';
import type { PostgresDriver, PostgresServerInfo } from '../src/postgres-driver.js';

const timestamp = '2026-07-26T00:00:00.000Z';

describe('PostgresConnector portable result values', () => {
  it('scopes discovered resources and isolates stable identities for the same endpoint', async () => {
    const serverInfo: PostgresServerInfo = {
      database: 'shared',
      currentUser: 'tester',
      engineVersion: '16.3',
      engineVersionNumber: 160_003,
      inRecovery: false,
    };
    const driver = {
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
    } as unknown as PostgresDriver;
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
    const driver = {
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
    } as unknown as PostgresDriver;
    const connector = new PostgresConnector(driver);
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
      authorization: { permissionMode: 'read' },
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
    const driver = {
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
    } as unknown as PostgresDriver;
    const connector = new PostgresConnector(driver, {
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
      authorization: { permissionMode: 'read' },
    });
    const second = await connector.submit(context, {
      profileId: profile.id,
      sql: 'select 2',
      authorization: { permissionMode: 'read' },
    });
    const third = await connector.submit(context, {
      profileId: profile.id,
      sql: 'select 3',
      authorization: { permissionMode: 'read' },
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
