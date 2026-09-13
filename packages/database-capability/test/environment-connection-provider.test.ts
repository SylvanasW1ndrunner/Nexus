import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ResourceRegistry } from '@dbagent/core-resource';
import { POSTGRES_CONNECTOR_ID, type DatabaseAccessRuntime } from '@dbagent/core-db';
import type { ConnectionProfile, ConnectionSession } from '@dbagent/shared';
import {
  createEnvironmentConnectionProvider,
  DatabaseCapabilityModule,
  type DatabaseCapabilityHostPort,
  type StandardDatabaseEnvironment,
} from '../src/index.js';

describe('EnvironmentConnectionProvider', () => {
  it('discovers and resolves a synthetic DATABASE_URL with a stable candidate fingerprint', async () => {
    const environment: StandardDatabaseEnvironment = { DATABASE_URL: 'postgresql://fixture-user:fixture-password@database.example.test:5544/fixture_db?sslmode=require&connect_timeout=12' };
    const provider = createEnvironmentConnectionProvider(environment);
    const first = await provider.discover(lifecycle());
    const second = await provider.discover(lifecycle());
    expect(first).toEqual(second);
    expect(first[0]).toMatchObject({ candidateId: 'environment-database-url', metadata: { source: 'DATABASE_URL', engine: 'postgres' } });
    const binding = await provider.resolve(first[0]!.candidateId, lifecycle());
    expect(binding).toMatchObject({
      profile: { connectorId: POSTGRES_CONNECTOR_ID, endpoints: [{ transport: 'tcp', host: 'database.example.test', port: 5544, database: 'fixture_db', ssl: 'require' }], network: { connectTimeoutMs: 12_000 } },
      credential: { username: 'fixture-user', password: 'fixture-password' },
    });
  });

  it('discovers PostgreSQL PG* variables, updates its fingerprint when the source changes, and never creates cookie profile fields', async () => {
    const environment: Record<string, string | undefined> = {
      PGHOST: 'postgres.example.test', PGPORT: '5433', PGDATABASE: 'fixture_database', PGUSER: 'fixture-user', PGPASSWORD: 'fixture-password', PGSSLMODE: 'verify-full', PGCONNECT_TIMEOUT: '8', COOKIE: 'synthetic-browser-cookie',
    };
    const provider = createEnvironmentConnectionProvider(environment);
    const first = (await provider.discover(lifecycle()))[0]!;
    environment.PGPORT = '5444';
    const second = (await provider.discover(lifecycle()))[0]!;
    expect(second.candidateId).toBe('environment-postgresql');
    expect(second.fingerprint).not.toBe(first.fingerprint);
    const binding = await provider.resolve(second.candidateId, lifecycle());
    expect(binding.profile).toMatchObject({ endpoints: [{ host: 'postgres.example.test', port: 5444, database: 'fixture_database', ssl: 'verify-full' }], network: { connectTimeoutMs: 8_000 } });
    expect('headers' in binding.profile).toBe(false);
    expect('cookie' in binding.profile).toBe(false);
  });

  it('returns no candidates with an actionable diagnostic when standard environment sources are absent', async () => {
    const provider = createEnvironmentConnectionProvider({});
    await expect(provider.discover(lifecycle())).resolves.toEqual([]);
    expect(provider.diagnostic()).toContain('Set DATABASE_URL or PGHOST');
  });

  it('requires the Database Capability Runtime to choose one of multiple standard sources', async () => {
    const provider = createEnvironmentConnectionProvider({
      DATABASE_URL: 'postgresql://fixture-user:fixture-password@url.example.test/url_db',
      PGHOST: 'pg.example.test', PGDATABASE: 'pg_db', PGUSER: 'fixture-pg-user', PGPASSWORD: 'fixture-pg-password',
    });
    const database = fakeDatabase();
    const module = new DatabaseCapabilityModule(host(), { connectionProvider: provider, databaseAccess: database.runtime, stateDatabasePath: await temporaryStatePath() });
    const loaded = await module.registration.load();
    const probe = await loaded.probe?.(lifecycle());
    expect(probe).toMatchObject({ status: 'available', activation: { selection: 'choice_required', candidates: [{ candidateId: 'environment-database-url' }, { candidateId: 'environment-postgresql' }] } });
    await expect(loaded.activate(lifecycle())).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    await loaded.resolve?.('environment-postgresql', lifecycle());
    expect(database.connect).toHaveBeenCalledWith(expect.stringMatching(/^external-/u), { username: 'fixture-pg-user', password: 'fixture-pg-password' });
    await module.dispose();
  });

  it('returns bounded typed failures for invalid standard environment values without content recognition', async () => {
    const provider = createEnvironmentConnectionProvider({ DATABASE_URL: 'https://not-postgres.example.test/fixture' });
    await expect(provider.discover(lifecycle())).rejects.toMatchObject({ code: 'NOT_CONFIGURED', retryable: true });
  });
});

function lifecycle() { return { signal: new AbortController().signal }; }
function fakeDatabase() {
  const profileById = new Map<string, ConnectionProfile>();
  const createProfile = vi.fn((profile: ConnectionProfile) => profileById.set(profile.id, profile));
  const connect = vi.fn((profileId: string) => Promise.resolve(session(profileId)));
  const runtime = {
    resources: new ResourceRegistry(), attachResultStore: vi.fn(), createProfile, connect, reconnect: connect,
    disconnect: vi.fn(() => Promise.resolve()), deleteProfile: vi.fn((profileId: string) => profileById.delete(profileId)), close: vi.fn(() => Promise.resolve()),
    discoverPage: vi.fn(() => Promise.resolve({ resources: [], relations: [], complete: true })),
  } as unknown as DatabaseAccessRuntime;
  return { runtime, connect };
}
function session(profileId: string): ConnectionSession {
  return { id: `session-${profileId}`, connectionId: `connection-${profileId}`, profileId, connectorId: POSTGRES_CONNECTOR_ID, status: 'connected', endpointIndex: 0, connectedAt: '2026-09-10T00:00:00.000Z', generation: 1 };
}
function host(): DatabaseCapabilityHostPort {
  return {
    project: { projectId: 'project-environment-provider', tenantId: 'tenant-fixture', rootPath: process.cwd(), configDirectory: process.cwd() },
    chat: () => Promise.resolve({ text: '', toolCalls: [] }), embed: () => Promise.resolve({ embeddings: [] }), rerank: () => Promise.resolve({ results: [] }),
  };
}
async function temporaryStatePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'schemanaut-environment-provider-'));
  process.once('exit', () => { void rm(directory, { recursive: true, force: true }); });
  return join(directory, 'state.db');
}
