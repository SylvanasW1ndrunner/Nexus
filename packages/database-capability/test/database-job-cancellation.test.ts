import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAccessRuntime } from '@dbagent/core-db';
import { ResourceRegistry } from '@dbagent/core-resource';
import type {
  ConnectionProfile,
  ConnectionSession,
  DatabaseCredential,
  QueryAuthorization,
  QueryRequest,
  SavedConnection,
} from '@dbagent/shared';
import {
  DatabaseCapabilityModule,
  type ActiveDatabaseBinding,
  type AiSqlQueryExecution,
  type ConnectionCandidate,
  type DatabaseCapabilityHostPort,
  type EphemeralConnectionBinding,
  type ExternalConnectionProvider,
} from '../src/index.js';

const timestamp = '2026-09-10T00:00:00.000Z';

describe('database job cancellation settlement', () => {
  it('releases the active binding read lease and permits reconnect when cancellation cannot be confirmed', async () => {
    const candidate = externalCandidate();
    const database = fakeDatabase();
    const module = new DatabaseCapabilityModule(host(), {
      connectionProvider: fakeProvider(candidate),
      databaseAccess: database.runtime,
      stateDatabasePath: await temporaryStatePath(),
    });
    const loaded = await module.registration.load();
    await loaded.activate(lifecycle());
    const internals = module as unknown as DatabaseModuleInternals;
    const binding = internals.captureBinding(internals.requireConnection());
    const controller = new AbortController();
    const execution = internals.executeAiSqlQuery({
      request: { connectionId: binding.connectionId, sql: 'SELECT 1' },
      binding,
      authorization: {},
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(database.submit).toHaveBeenCalledTimes(1));
    controller.abort();
    const reconnect = loaded.resolve?.(candidate.candidateId, lifecycle());
    await expect(execution).rejects.toMatchObject({
      code: 'CONNECTION_FAILED',
      retryable: true,
    });
    await expect(reconnect).resolves.toBeDefined();
    expect(database.reconnect).toHaveBeenCalledTimes(2);
    expect(module.status()).toMatchObject({ connected: true, agentPublication: 'current' });
    await module.dispose();
  });
});

type DatabaseModuleInternals = {
  requireConnection(): SavedConnection;
  captureBinding(connection: SavedConnection): ActiveDatabaseBinding;
  executeAiSqlQuery(input: Readonly<{
    request: QueryRequest;
    binding: ActiveDatabaseBinding;
    authorization: QueryAuthorization;
    signal: AbortSignal;
  }>): Promise<AiSqlQueryExecution>;
};

function lifecycle() { return { signal: new AbortController().signal }; }

function externalCandidate(): ConnectionCandidate {
  return { candidateId: 'primary', label: 'Primary', fingerprint: 'primary-fingerprint' };
}

function fakeProvider(candidate: ConnectionCandidate): ExternalConnectionProvider {
  const credential: DatabaseCredential = { username: 'operator', password: 'ephemeral-only' };
  const binding: EphemeralConnectionBinding = {
    candidateId: candidate.candidateId,
    fingerprint: candidate.fingerprint,
    credential,
    profile: {
      name: candidate.label,
      connectorId: 'fake-postgres',
      engine: 'postgres',
      endpoints: [{ transport: 'tcp', host: 'database.example.test', port: 5432, database: 'app' }],
      purpose: 'query',
      readOnly: true,
    },
  };
  return {
    providerId: 'fixture-provider',
    discover: vi.fn(() => Promise.resolve([candidate])),
    resolve: vi.fn(() => Promise.resolve(binding)),
  };
}

function fakeDatabase() {
  const profiles = new Map<string, ConnectionProfile>();
  const reconnect = vi.fn((profileId: string) => Promise.resolve(session(profileId)));
  const submit = vi.fn(() => Promise.resolve({
    id: 'job-unsettled', profileId: 'external-fixture-provider-primary', connectorId: 'fake-postgres',
    state: 'running' as const, submittedAt: timestamp,
  }));
  const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
  return {
    submit,
    reconnect,
    runtime: {
      resources: new ResourceRegistry(),
      attachResultStore: vi.fn(),
      createProfile: vi.fn((profile: ConnectionProfile) => profiles.set(profile.id, profile)),
      connect: reconnect,
      reconnect,
      disconnect: vi.fn(() => Promise.resolve()),
      deleteProfile: vi.fn((profileId: string) => profiles.delete(profileId)),
      discoverPage: vi.fn(() => Promise.resolve({ resources: [], relations: [], complete: true })),
      submit,
      getJob: vi.fn(() => never()),
      cancel: vi.fn(() => never()),
      close: vi.fn(() => Promise.resolve()),
    } as unknown as DatabaseAccessRuntime,
  };
}

function session(profileId: string): ConnectionSession {
  return {
    id: `session-${profileId}`,
    connectionId: `connection-${profileId}`,
    profileId,
    connectorId: 'fake-postgres',
    status: 'connected',
    endpointIndex: 0,
    connectedAt: timestamp,
    generation: 1,
  };
}

function host(): DatabaseCapabilityHostPort {
  return {
    project: { projectId: 'project-job-cancellation', tenantId: 'tenant-test', rootPath: process.cwd(), configDirectory: process.cwd() },
    chat: () => Promise.resolve({ text: '', toolCalls: [] }),
    embed: () => Promise.resolve({ embeddings: [] }),
    rerank: () => Promise.resolve({ results: [] }),
  };
}

async function temporaryStatePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'schemanaut-job-cancellation-'));
  process.once('exit', () => { void rm(directory, { recursive: true, force: true }); });
  return join(directory, 'state.db');
}
