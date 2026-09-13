import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ResourceRegistry } from '@dbagent/core-resource';
import type { DatabaseAccessRuntime } from '@dbagent/core-db';
import type {
  ConnectionProfile,
  ConnectionSession,
  DatabaseCredential,
  ResourceDescriptor,
} from '@dbagent/shared';
import {
  DatabaseCapabilityModule,
  type ConnectionCandidate,
  type DatabaseCapabilityHostPort,
  type EphemeralConnectionBinding,
  type ExternalConnectionProvider,
} from '../src/index.js';

const timestamp = '2026-09-10T00:00:00.000Z';

describe('DatabaseCapabilityModule external connection lifecycle', () => {
  it('does not load database resources until an external context activates the module', async () => {
    const provider = fakeProvider([]);
    const database = fakeDatabase();
    const module = new DatabaseCapabilityModule(host(), {
      connectionProvider: provider, databaseAccess: database.runtime,
      stateDatabasePath: await temporaryStatePath(),
    });
    const loaded = await module.registration.load();
    const probe = await loaded.probe?.(lifecycle());
    expect(probe).toMatchObject({ status: 'unavailable' });
    expect(database.createProfile).not.toHaveBeenCalled();
    expect(database.connect).not.toHaveBeenCalled();
    await module.dispose();
  });

  it('automatically resolves one external context and keeps the credential at the connection boundary', async () => {
    const candidate = externalCandidate('primary', 'fingerprint-primary');
    const credential: DatabaseCredential = { username: 'operator', password: 'ephemeral-only' };
    const provider = fakeProvider([candidate], binding(candidate, credential));
    const database = fakeDatabase();
    const module = new DatabaseCapabilityModule(host(), {
      connectionProvider: provider, databaseAccess: database.runtime,
      stateDatabasePath: await temporaryStatePath(),
    });
    const loaded = await module.registration.load();
    const probe = await loaded.probe?.(lifecycle());
    const generation = await loaded.activate(lifecycle());
    expect(probe).toMatchObject({
      status: 'available',
      activation: { kind: 'external_context', selection: 'automatic', candidates: [candidate] },
    });
    expect(provider.resolve).toHaveBeenCalledWith('primary', expect.anything());
    expect(database.connect).toHaveBeenCalledWith(expect.stringMatching(/^external-/u), credential);
    expect(module.status()).toMatchObject({ connected: true, agentPublication: 'current' });
    expect(generation.contributions.tools?.map(({ definition }) => definition.name)).toEqual(
      expect.arrayContaining([
        'resource_list',
        'resource_get',
        'knowledge_search',
        'sql_execute',
        'sql_explain',
      ]),
    );
    expect(generation.contributions.stateReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ capabilityId: 'database.schema' }),
    ]));
    expect(database.discoverPage).toHaveBeenCalledWith(
      expect.stringMatching(/^external-/u),
      expect.objectContaining({ limit: 500 }),
    );
    expect(JSON.stringify(generation)).not.toContain('ephemeral-only');
    await module.dispose();
  });

  it('requires a selected external context when discovery has multiple candidates', async () => {
    const first = externalCandidate('first', 'fingerprint-first');
    const second = externalCandidate('second', 'fingerprint-second');
    const provider = fakeProvider([first, second], binding(second));
    const database = fakeDatabase();
    const module = new DatabaseCapabilityModule(host(), {
      connectionProvider: provider, databaseAccess: database.runtime,
      stateDatabasePath: await temporaryStatePath(),
    });
    const loaded = await module.registration.load();
    await expect(loaded.activate(lifecycle())).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    const generation = await loaded.resolve?.('second', lifecycle());
    expect(generation?.contributions.tools).toHaveLength(5);
    expect(provider.resolve).toHaveBeenCalledWith('second', expect.anything());
    await module.dispose();
  });

  it('rejects a stale candidate fingerprint before opening a connection', async () => {
    const candidate = externalCandidate('primary', 'fingerprint-current');
    const provider = fakeProvider([candidate], binding(candidate, undefined, 'fingerprint-stale'));
    const database = fakeDatabase();
    const module = new DatabaseCapabilityModule(host(), {
      connectionProvider: provider, databaseAccess: database.runtime,
      stateDatabasePath: await temporaryStatePath(),
    });
    const loaded = await module.registration.load();
    await expect(loaded.activate(lifecycle())).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(database.connect).not.toHaveBeenCalled();
    await module.dispose();
  });

  it('preserves externally supplied connection content without credential-like scanning', async () => {
    const candidate: ConnectionCandidate = {
      candidateId: 'content',
      label: 'Content database',
      fingerprint: 'fingerprint-content',
      metadata: { token: 'candidate-visible-value', dsn: 'external-description' },
    };
    const resolved: EphemeralConnectionBinding = {
      candidateId: candidate.candidateId,
      fingerprint: candidate.fingerprint,
      credential: { token: 'connector-token' },
      profile: {
        name: candidate.label,
        connectorId: 'fake-http',
        engine: 'postgres',
        endpoints: [
          {
            transport: 'tcp',
            host: 'database.example.test',
            port: 5432,
            database: 'content_database',
          },
          {
            transport: 'http',
            baseUrl: 'https://user:password@example.test/database?api_key=value',
            headers: { Authorization: 'Bearer external-value', 'X-Api-Key': 'external-key' },
          },
        ],
        purpose: 'query',
        readOnly: true,
        labels: { password: 'label-value' },
      },
    };
    const database = fakeDatabase();
    const module = new DatabaseCapabilityModule(host(), {
      connectionProvider: fakeProvider([candidate], resolved),
      databaseAccess: database.runtime,
      stateDatabasePath: await temporaryStatePath(),
    });
    const loaded = await module.registration.load();
    const probe = await loaded.probe?.(lifecycle());
    await loaded.activate(lifecycle());

    expect(probe).toMatchObject({
      activation: { candidates: [{ metadata: candidate.metadata }] },
    });
    expect(database.createProfile).toHaveBeenCalledWith(expect.objectContaining({
      endpoints: resolved.profile.endpoints,
      labels: resolved.profile.labels,
    }));
    await module.dispose();
  });

  it('returns bounded external provider diagnostics without content-aware redaction', async () => {
    const provider: ExternalConnectionProvider = {
      providerId: 'failing-provider',
      discover: vi.fn(() => Promise.reject(new Error('provider token=visible-diagnostic'))),
      resolve: vi.fn(() => Promise.reject(new Error('unused'))),
    };
    const module = new DatabaseCapabilityModule(host(), {
      connectionProvider: provider,
      databaseAccess: fakeDatabase().runtime,
      stateDatabasePath: await temporaryStatePath(),
    });
    const loaded = await module.registration.load();
    const probe = await loaded.probe?.(lifecycle());
    expect(probe?.status).toBe('unavailable');
    expect(probe?.reason).toContain('provider token=visible-diagnostic');
    await module.dispose();
  });
});

function lifecycle() { return { signal: new AbortController().signal }; }
function externalCandidate(candidateId: string, fingerprint: string): ConnectionCandidate {
  return { candidateId, label: `Database ${candidateId}`, fingerprint, metadata: { environment: 'test' } };
}
function binding(candidate: ConnectionCandidate, credential: DatabaseCredential = { username: 'operator' }, fingerprint = candidate.fingerprint): EphemeralConnectionBinding {
  return {
    candidateId: candidate.candidateId, fingerprint, credential,
    profile: {
      name: candidate.label, connectorId: 'fake-postgres', engine: 'postgres',
      endpoints: [{ transport: 'tcp', host: 'database.example.test', port: 5432, database: 'app' }],
      purpose: 'query', readOnly: true,
    },
  };
}
function fakeProvider(candidates: readonly ConnectionCandidate[], resolved: EphemeralConnectionBinding | undefined = undefined): ExternalConnectionProvider & { resolve: ReturnType<typeof vi.fn> } {
  return {
    providerId: 'fixture-external-provider', discover: vi.fn(() => Promise.resolve(candidates)),
    resolve: vi.fn(() => {
      if (resolved === undefined) return Promise.reject(new Error('No fake binding is configured.'));
      return Promise.resolve(resolved);
    }),
  };
}
function fakeDatabase() {
  const profileById = new Map<string, ConnectionProfile>();
  const createProfile = vi.fn((profile: ConnectionProfile) => profileById.set(profile.id, profile));
  const connect = vi.fn((profileId: string) => Promise.resolve(session(profileId)));
  const discoverPage = vi.fn(() => Promise.resolve({
    resources: [tableResource('table:public.orders', 'public.orders')],
    relations: [],
    complete: true,
  }));
  const runtime = {
    resources: new ResourceRegistry(), attachResultStore: vi.fn(), createProfile, connect, reconnect: connect,
    disconnect: vi.fn(() => Promise.resolve()), deleteProfile: vi.fn((profileId: string) => profileById.delete(profileId)), close: vi.fn(() => Promise.resolve()),
    discoverPage,
  } as unknown as DatabaseAccessRuntime;
  return { runtime, createProfile, connect, discoverPage };
}
function session(profileId: string): ConnectionSession {
  return { id: `session-${profileId}`, connectionId: `connection-${profileId}`, profileId,
    connectorId: 'fake-postgres', status: 'connected', endpointIndex: 0, connectedAt: timestamp, generation: 1 };
}
function tableResource(id: string, canonicalName: string): ResourceDescriptor {
  const table = canonicalName.slice(canonicalName.lastIndexOf('.') + 1);
  return {
    id,
    kind: 'table',
    nativeId: canonicalName,
    canonicalName,
    displayName: table,
    attributes: { schema: 'public', table },
    version: 1,
    firstSeenAt: timestamp,
    updatedAt: timestamp,
    sources: [{
      sourceId: 'fixture',
      sourceType: 'connector',
      connectionProfileId: 'fixture-profile',
      observedAt: timestamp,
    }],
  };
}
function host(): DatabaseCapabilityHostPort {
  return {
    project: { projectId: 'project-external-connection', tenantId: 'tenant-test', rootPath: process.cwd(), configDirectory: process.cwd() },
    chat: () => Promise.resolve({ text: '', toolCalls: [] }), embed: () => Promise.resolve({ embeddings: [] }), rerank: () => Promise.resolve({ results: [] }),
  };
}
async function temporaryStatePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'schemanaut-db-module-'));
  process.once('exit', () => { void rm(directory, { recursive: true, force: true }); });
  return join(directory, 'state.db');
}
