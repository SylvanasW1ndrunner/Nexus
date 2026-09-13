import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CapabilityControlPlane } from '@dbagent/core-agent';
import type { DatabaseAccessRuntime } from '@dbagent/core-db';
import { ResourceRegistry } from '@dbagent/core-resource';
import type {
  ConnectionProfile,
  ConnectionSession,
  DatabaseCredential,
  ResourceDescriptor,
} from '@dbagent/shared';
import {
  DatabaseCapabilityModule,
  DATABASE_CAPABILITY_INSTANCE_ID,
  DATABASE_CAPABILITY_MODULE_ID,
  type ConnectionCandidate,
  type DatabaseCapabilityHostPort,
  type EphemeralConnectionBinding,
  type ExternalConnectionProvider,
} from '../src/index.js';
import { executeAiSqlSnapshotInvocations } from './ai-sql-invocation-test-harness.js';

const timestamp = '2026-09-10T00:00:00.000Z';

describe('database Schema generation publication', () => {
  it('atomically publishes a refreshed global resource_list snapshot while retained Turns keep their old Schema', async () => {
    const control = new CapabilityControlPlane();
    const candidate = externalCandidate();
    const discovery = [table('table:commerce.orders', 'commerce.orders')];
    const database = fakeDatabase(() => discovery);
    const provider = fakeProvider(candidate);
    const module = new DatabaseCapabilityModule(host(control), {
      connectionProvider: provider,
      databaseAccess: database.runtime,
      stateDatabasePath: await temporaryStatePath(),
    });
    control.register(module.registration);
    const probe = await control.probe({
      moduleId: DATABASE_CAPABILITY_MODULE_ID,
      instanceId: DATABASE_CAPABILITY_INSTANCE_ID,
    });
    if (probe.activation === undefined) throw new Error('External database activation is required.');
    await control.activate({
      moduleId: DATABASE_CAPABILITY_MODULE_ID,
      instanceId: DATABASE_CAPABILITY_INSTANCE_ID,
      binding: control.bindProbeChoice({
        moduleId: DATABASE_CAPABILITY_MODULE_ID,
        instanceId: DATABASE_CAPABILITY_INSTANCE_ID,
        providerId: probe.activation.providerId,
        candidateId: candidate.candidateId,
        probeRevision: probe.activation.probeRevision,
      }),
    });
    await module.indexSchema();
    const oldTurn = control.captureRuntimeSnapshot();
    try {
      discovery.push(table('table:commerce.invoices', 'commerce.invoices'));
      await module.indexSchema();
      const newTurn = control.captureRuntimeSnapshot();
      try {
        expect(newTurn.identity.snapshotId).not.toBe(oldTurn.identity.snapshotId);
        expect(newTurn.tools.toolGeneration('resource_list')).toBeGreaterThan(
          oldTurn.tools.toolGeneration('resource_list') ?? 0,
        );

        const oldResult = await executeAiSqlSnapshotInvocations(oldTurn.tools, [{
          name: 'resource_list', arguments: { kinds: ['table'] },
        }]);
        const newResult = await executeAiSqlSnapshotInvocations(newTurn.tools, [{
          name: 'resource_list', arguments: { kinds: ['table'] },
        }]);
        try {
          expect(JSON.stringify(oldResult.observations)).toContain('commerce.orders');
          expect(JSON.stringify(oldResult.observations)).not.toContain('commerce.invoices');
          expect(JSON.stringify(newResult.observations)).toContain('commerce.orders');
          expect(JSON.stringify(newResult.observations)).toContain('commerce.invoices');
        } finally {
          await oldResult.dispose();
          await newResult.dispose();
        }
      } finally {
        newTurn.release();
      }
    } finally {
      oldTurn.release();
      await control.close();
    }
  }, 10_000);
});

function host(control: CapabilityControlPlane): DatabaseCapabilityHostPort {
  return {
    project: { projectId: 'project-schema-publication', tenantId: 'tenant-test', rootPath: process.cwd(), configDirectory: process.cwd() },
    chat: () => Promise.resolve({ text: '', toolCalls: [] }),
    embed: () => Promise.resolve({ embeddings: [] }),
    rerank: () => Promise.resolve({ results: [] }),
    requestCapabilityRefresh: async ({ reason }) => {
      expect(reason).toBe('schema');
      await control.refresh({
        moduleId: DATABASE_CAPABILITY_MODULE_ID,
        instanceId: DATABASE_CAPABILITY_INSTANCE_ID,
        retirement: 'defer',
      });
    },
  };
}

function externalCandidate(): ConnectionCandidate {
  return { candidateId: 'primary', label: 'Primary', fingerprint: 'primary-fingerprint' };
}

function fakeProvider(candidate: ConnectionCandidate): ExternalConnectionProvider {
  const credential: DatabaseCredential = { username: 'operator', password: 'ephemeral-only' };
  const resolved: EphemeralConnectionBinding = {
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
    resolve: vi.fn(() => Promise.resolve(resolved)),
  };
}

function fakeDatabase(resources: () => ResourceDescriptor[]) {
  const profiles = new Map<string, ConnectionProfile>();
  const connect = vi.fn((profileId: string) => Promise.resolve(session(profileId)));
  return {
    runtime: {
      resources: new ResourceRegistry(),
      attachResultStore: vi.fn(),
      createProfile: vi.fn((profile: ConnectionProfile) => profiles.set(profile.id, profile)),
      connect,
      reconnect: connect,
      disconnect: vi.fn(() => Promise.resolve()),
      deleteProfile: vi.fn((profileId: string) => profiles.delete(profileId)),
      discoverPage: vi.fn(() => Promise.resolve({ resources: resources(), relations: [], complete: true })),
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

function table(id: string, canonicalName: string): ResourceDescriptor {
  const tableName = canonicalName.slice(canonicalName.lastIndexOf('.') + 1);
  return {
    id,
    kind: 'table',
    nativeId: canonicalName,
    canonicalName,
    displayName: tableName,
    attributes: { schema: 'commerce', table: tableName },
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

async function temporaryStatePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'schemanaut-schema-publication-'));
  process.once('exit', () => { void rm(directory, { recursive: true, force: true }); });
  return join(directory, 'state.db');
}
