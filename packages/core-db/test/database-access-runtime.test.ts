import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  CapabilityDescriptor,
  CapabilityProfile,
  ConnectionProfile,
  DatabaseTransaction,
  QueryJob,
  ResourceDescriptor,
  ResourceRelation,
  ResultBatch,
} from '@dbagent/shared';
import type { DatabaseConnector } from '../src/index.js';
import {
  ConnectorRegistry,
  DATABASE_CAPABILITIES,
  DatabaseAccessRuntime,
  DatabaseAccessRuntimeError,
  createStableRelationId,
  createStableResourceId,
} from '../src/index.js';

const now = '2026-07-23T00:00:00.000Z';

function descriptor(key: string): CapabilityDescriptor {
  return { key, status: 'supported', source: 'mock', observedAt: now };
}

function profile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'profile-1',
    name: 'Mock database',
    connectorId: 'mock-connector',
    engine: 'mock',
    endpoints: [{ transport: 'tcp', host: '127.0.0.1', port: 9999, database: 'demo' }],
    principal: 'tester',
    purpose: 'admin',
    readOnly: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createMockConnector(options: {
  failSecret?: boolean;
  repeatDiscoveryCursor?: boolean;
  nativeStream?: boolean;
  disconnectFails?: boolean;
} = {}) {
  const calls: string[] = [];
  const jobs = new Map<string, QueryJob>();
  const rows = Array.from({ length: 7 }, (_, index) => ({ value: index + 1 }));
  const databaseId = createStableResourceId({
    sourceNamespace: 'mock',
    kind: 'database',
    nativeId: 'demo',
  });
  const tableId = createStableResourceId({
    sourceNamespace: 'mock',
    kind: 'table',
    nativeId: 'demo.orders',
  });
  const source = {
    sourceId: 'mock',
    sourceType: 'connector' as const,
    connectorId: 'mock-connector',
    observedAt: now,
  };
  const database: ResourceDescriptor = {
    id: databaseId,
    kind: 'database',
    nativeId: 'demo',
    canonicalName: 'demo',
    engine: 'mock',
    version: 1,
    firstSeenAt: now,
    updatedAt: now,
    sources: [source],
  };
  const table: ResourceDescriptor = {
    id: tableId,
    kind: 'table',
    nativeId: 'demo.orders',
    canonicalName: 'orders',
    engine: 'mock',
    version: 1,
    firstSeenAt: now,
    updatedAt: now,
    sources: [source],
  };
  const relation: ResourceRelation = {
    id: createStableRelationId({
      kind: 'contains',
      fromResourceId: database.id,
      toResourceId: table.id,
    }),
    kind: 'contains',
    fromResourceId: database.id,
    toResourceId: table.id,
    version: 1,
    firstSeenAt: now,
    updatedAt: now,
    sources: [source],
  };
  const capabilities = Object.fromEntries(
    [
      DATABASE_CAPABILITIES.SQL_QUERY,
      DATABASE_CAPABILITIES.QUERY_ASYNC,
      DATABASE_CAPABILITIES.TRANSACTION,
      DATABASE_CAPABILITIES.OPERATE_ANALYZE,
    ].map((key) => [key, descriptor(key)]),
  );
  const connector: DatabaseConnector = {
    manifest: {
      id: 'mock-connector',
      displayName: 'Mock',
      version: '1',
      engine: 'mock',
      transports: ['tcp'],
      execution: 'hybrid',
      capabilities,
      operations: [
        {
          key: 'inspect',
          title: 'Inspect',
          description: 'Read operation',
          risk: 'read',
          idempotent: true,
          requiredCapability: DATABASE_CAPABILITIES.SQL_QUERY,
        },
        {
          key: 'analyze',
          title: 'Analyze',
          description: 'Write operation',
          risk: 'write',
          idempotent: true,
          requiredCapability: DATABASE_CAPABILITIES.OPERATE_ANALYZE,
        },
      ],
    },
    test(context) {
      calls.push('test');
      if (options.failSecret) {
        return Promise.reject(new Error(`credential=${context.credential?.password}`));
      }
      return Promise.resolve({
        connectorId: 'mock-connector',
        engine: 'mock',
        status: 'healthy',
        checkedAt: now,
        latencyMs: 3,
      });
    },
    connect(context) {
      calls.push('connect');
      return Promise.resolve({
        id: randomUUID(),
        connectionId: `connection-${context.profile.id}`,
        profileId: context.profile.id,
        connectorId: 'mock-connector',
        status: 'connected',
        endpointIndex: 0,
        connectedAt: now,
        generation: 1,
      });
    },
    disconnect() {
      calls.push('disconnect');
      return options.disconnectFails
        ? Promise.reject(new Error('disconnect failed'))
        : Promise.resolve();
    },
    reconnect(context) {
      calls.push('reconnect');
      return Promise.resolve({
        id: randomUUID(),
        connectionId: `connection-${context.profile.id}`,
        profileId: context.profile.id,
        connectorId: 'mock-connector',
        status: 'connected',
        endpointIndex: 0,
        connectedAt: now,
        generation: (context.session?.generation ?? 0) + 1,
      });
    },
    health() {
      calls.push('health');
      return Promise.resolve({ status: 'healthy', checkedAt: now, latencyMs: 1 });
    },
    capabilities(context): Promise<CapabilityProfile> {
      calls.push('capabilities');
      return Promise.resolve({
        connectorId: 'mock-connector',
        engine: 'mock',
        connectionProfileId: context.profile.id,
        resolvedAt: now,
        capabilities,
      });
    },
    discover(_context, request) {
      calls.push(`discover:${request.cursor ?? 'first'}`);
      if (!request.cursor) {
        return Promise.resolve({
          resources: [database],
          relations: [],
          complete: false,
          nextCursor: 'second',
        });
      }
      return Promise.resolve({
        resources: [table],
        relations: [relation],
        complete: false,
        nextCursor: options.repeatDiscoveryCursor ? 'second' : 'third',
      });
    },
    submit(context, submission) {
      calls.push('submit');
      const job: QueryJob = {
        id: randomUUID(),
        profileId: context.profile.id,
        connectorId: 'mock-connector',
        state: submission.sql === 'queued' ? 'queued' : 'succeeded',
        submittedAt: now,
        ...(submission.sql === 'queued'
          ? {}
          : {
              completedAt: now,
              result: {
                id: 'result-1',
                jobId: 'placeholder',
                format: 'rows',
                columns: [{ name: 'value', dataType: 'integer' }],
                rowCount: rows.length,
              },
            }),
      };
      if (job.result) job.result.jobId = job.id;
      jobs.set(job.id, job);
      return Promise.resolve(job);
    },
    getJob(_context, jobId) {
      calls.push('getJob');
      const job = jobs.get(jobId);
      return job ? Promise.resolve(job) : Promise.reject(new Error('job missing'));
    },
    cancel(_context, jobId) {
      calls.push('cancel');
      const job = jobs.get(jobId);
      if (!job) return Promise.reject(new Error('job missing'));
      const cancelled: QueryJob = { ...job, state: 'cancelled', completedAt: now };
      jobs.set(jobId, cancelled);
      return Promise.resolve(cancelled);
    },
    readResult(_context, handleId, input = {}): Promise<ResultBatch> {
      calls.push('readResult');
      const offset = input.cursor ? Number(input.cursor) : 0;
      const limit = input.limit ?? 3;
      const batchRows = rows.slice(offset, offset + limit);
      const next = offset + batchRows.length;
      return Promise.resolve({
        handleId,
        rows: batchRows,
        rowOffset: offset,
        complete: next >= rows.length,
        ...(next < rows.length ? { nextCursor: String(next) } : {}),
      });
    },
    ...(options.nativeStream
      ? {
          async *streamResult(_context, handleId) {
            calls.push('nativeStream');
            await Promise.resolve();
            yield { handleId, rows, rowOffset: 0, complete: true };
          },
        }
      : {}),
    beginTransaction(context, transactionOptions = {}) {
      calls.push('beginTransaction');
      return Promise.resolve({
        id: 'tx-1',
        profileId: context.profile.id,
        sessionId: context.session?.id ?? 'session',
        state: 'active',
        readOnly: transactionOptions.readOnly ?? false,
        startedAt: now,
        savepoints: [],
      });
    },
    createSavepoint(context, transactionId, name) {
      calls.push('createSavepoint');
      return Promise.resolve(transaction(context.profile.id, transactionId, [name]));
    },
    rollbackToSavepoint(context, transactionId, name) {
      calls.push('rollbackToSavepoint');
      return Promise.resolve(transaction(context.profile.id, transactionId, [name]));
    },
    commitTransaction(context, transactionId) {
      calls.push('commitTransaction');
      return Promise.resolve({
        ...transaction(context.profile.id, transactionId),
        state: 'committed',
        completedAt: now,
      });
    },
    rollbackTransaction(context, transactionId) {
      calls.push('rollbackTransaction');
      return Promise.resolve({
        ...transaction(context.profile.id, transactionId),
        state: 'rolled-back',
        completedAt: now,
      });
    },
    observe(_context, request) {
      calls.push('observe');
      return Promise.resolve([
        {
          id: 'observation-1',
          resourceId: request.resourceId ?? databaseId,
          category: 'capacity',
          status: 'healthy',
          observedAt: now,
          expiresAt: '2099-01-01T00:00:00.000Z',
          source,
        },
      ]);
    },
    operate(_context, request) {
      calls.push(`operate:${request.operation}`);
      return Promise.resolve({
        operationId: randomUUID(),
        operation: request.operation,
        status: 'succeeded',
        startedAt: now,
        completedAt: now,
        output: { accepted: true },
      });
    },
  };
  return { connector, calls, databaseId, tableId };
}

function transaction(profileId: string, id: string, savepoints: string[] = []): DatabaseTransaction {
  return {
    id,
    profileId,
    sessionId: 'session',
    state: 'active',
    readOnly: false,
    startedAt: now,
    savepoints,
  };
}

function runtimeWith(connector: DatabaseConnector, options: ConstructorParameters<typeof DatabaseAccessRuntime>[0] = {}) {
  const connectors = new ConnectorRegistry();
  connectors.register(connector);
  return new DatabaseAccessRuntime({ ...options, connectors });
}

describe('DatabaseAccessRuntime', () => {
  it('validates profile transports, URLs, secrets, read-only consistency and lifecycle conflicts', async () => {
    const mock = createMockConnector();
    const runtime = runtimeWith(mock.connector);
    expect(() => runtime.createProfile(profile())).not.toThrow();
    expect(() => runtime.createProfile(profile())).toThrow(/already exists/);
    expect(() =>
      runtime.createProfile(profile({ id: 'bad-port', endpoints: [{ transport: 'tcp', host: '', port: 0 }] })),
    ).toThrow(/host and port/);
    expect(() =>
      runtime.createProfile(
        profile({
          id: 'bad-read',
          purpose: 'read-only',
          readOnly: false,
        }),
      ),
    ).toThrow(/readOnly=true/);
    expect(() =>
      runtime.createProfile(
        profile({
          id: 'bad-http',
          endpoints: [{ transport: 'http', baseUrl: 'https://user:secret@example.com' }],
        }),
      ),
    ).toThrow(/does not support http/);

    await runtime.connect('profile-1', { username: 'tester', password: 'secret' });
    expect(() => runtime.updateProfile('profile-1', { name: 'changed' })).toThrow(/Disconnect/);
    expect(() => runtime.deleteProfile('profile-1')).toThrow(/Disconnect/);
    await runtime.disconnect('profile-1');
    expect(runtime.updateProfile('profile-1', { name: 'changed' }).name).toBe('changed');
    expect(runtime.deleteProfile('profile-1')).toBe(true);
    expect(runtime.deleteProfile('profile-1')).toBe(false);
  });

  it('tests, connects, checks health, reconnects and never returns credentials', async () => {
    const mock = createMockConnector();
    const resolved: string[] = [];
    const runtime = runtimeWith(mock.connector, {
      credentialResolver: {
        resolve(reference) {
          resolved.push(reference.reference);
          return Promise.resolve({ username: 'tester', password: 'resolved-secret' });
        },
      },
    });
    runtime.createProfile(
      profile({ credentialRef: { provider: 'memory', reference: 'credential-1' } }),
    );
    const tested = await runtime.testProfile('profile-1');
    expect(tested).toMatchObject({ status: 'healthy', latencyMs: 3 });
    const session = await runtime.connect('profile-1');
    expect(session.status).toBe('connected');
    expect(await runtime.connect('profile-1')).toEqual(session);
    expect(await runtime.health('profile-1')).toMatchObject({ status: 'healthy' });
    const reconnected = await runtime.reconnect('profile-1');
    expect(reconnected.generation).toBeGreaterThan(session.generation);
    expect(runtime.getProfile('profile-1')).not.toHaveProperty('password');
    expect(runtime.listProfiles()).toHaveLength(1);
    expect(resolved).toEqual(['credential-1', 'credential-1', 'credential-1']);
    expect(mock.calls).toEqual(
      expect.arrayContaining(['test', 'connect', 'health', 'reconnect']),
    );
    await runtime.close();
    expect(runtime.getSessionForProfile('profile-1')?.status).toBe('disconnected');
  });

  it('redacts direct credentials from connector errors', async () => {
    const mock = createMockConnector({ failSecret: true });
    const runtime = runtimeWith(mock.connector);
    runtime.createProfile(profile());
    const error = await captureRuntimeError(
      runtime.testProfile('profile-1', { password: 'top-secret-value' }),
    );
    expect(error.error.message).not.toContain('top-secret-value');
  });

  it('discovers paged resources, detects cursor loops and exposes graph queries', async () => {
    const mock = createMockConnector({ repeatDiscoveryCursor: true });
    const runtime = runtimeWith(mock.connector);
    runtime.createProfile(profile());
    await runtime.connect('profile-1');
    await expect(runtime.discoverAll('profile-1')).rejects.toThrow(/repeated a discovery cursor/);
    expect(runtime.queryResources({ kinds: ['database'] }).items[0]?.id).toBe(mock.databaseId);
    expect(runtime.queryResources({ kinds: ['table'] }).items[0]?.id).toBe(mock.tableId);
    expect(runtime.resourceRelations(mock.databaseId)).toHaveLength(1);
    expect(runtime.metrics()).toMatchObject({ discoveryPages: 2, resources: 2, relations: 1 });
  });

  it('submits sync and async jobs, polls, cancels, pages and streams results', async () => {
    const mock = createMockConnector();
    const runtime = runtimeWith(mock.connector);
    runtime.createProfile(profile());
    await runtime.connect('profile-1');
    const completed = await runtime.submit({ profileId: 'profile-1', sql: 'select values' });
    expect(completed.state).toBe('succeeded');
    expect(await runtime.getJob(completed.id)).toEqual(completed);
    const first = await runtime.readResult(completed.result!.id, { limit: 2 });
    expect(first.rows).toHaveLength(2);
    expect(first.complete).toBe(false);
    const values: number[] = [];
    for await (const batch of runtime.streamResult(completed.result!.id, { batchSize: 3 })) {
      values.push(...batch.rows.map((row) => Number(row.value)));
    }
    expect(values).toEqual([1, 2, 3, 4, 5, 6, 7]);

    const queued = await runtime.submit({
      profileId: 'profile-1',
      sql: 'queued',
      executionMode: 'async',
    });
    expect((await runtime.cancel(queued.id)).state).toBe('cancelled');
    await expect(
      runtime.submit({ profileId: 'profile-1', sql: 'select 1', timeoutMs: 0 }),
    ).rejects.toMatchObject({
      error: {
        code: 'QUERY_LIMIT_INVALID',
        category: 'validation',
      },
    });
    await expect(
      runtime.submit({ profileId: 'profile-1', sql: '   ' }),
    ).rejects.toMatchObject({
      error: {
        code: 'QUERY_SQL_REQUIRED',
        category: 'validation',
      },
    });
    expect(runtime.metrics()).toMatchObject({ submittedQueries: 2, cancelledQueries: 1 });
    expect(runtime.listAuditEvents({ profileId: 'profile-1' }).map((event) => event.action)).toEqual(
      expect.arrayContaining(['database.query.submit', 'database.query.cancel']),
    );
    await expect(runtime.getJob('missing')).rejects.toBeInstanceOf(DatabaseAccessRuntimeError);
    await expect(runtime.readResult('missing')).rejects.toBeInstanceOf(DatabaseAccessRuntimeError);
  });

  it('uses a connector-native result stream when available', async () => {
    const mock = createMockConnector({ nativeStream: true });
    const runtime = runtimeWith(mock.connector);
    runtime.createProfile(profile());
    await runtime.connect('profile-1');
    const job = await runtime.submit({ profileId: 'profile-1', sql: 'select values' });
    const batches = [];
    for await (const batch of runtime.streamResult(job.result!.id)) batches.push(batch);
    expect(batches).toHaveLength(1);
    expect(mock.calls).toContain('nativeStream');
  });

  it('runs sticky transaction, savepoint, observation and approved operations', async () => {
    const mock = createMockConnector();
    const auditEvents: string[] = [];
    const runtime = runtimeWith(mock.connector, {
      auditSink: {
        write: (event) => {
          auditEvents.push(event.action);
        },
      },
    });
    runtime.createProfile(profile());
    await runtime.connect('profile-1');
    await runtime.discoverPage('profile-1');
    const tx = await runtime.beginTransaction('profile-1', {
      isolationLevel: 'serializable',
      readOnly: false,
    });
    expect((await runtime.createSavepoint(tx.id, 'before_change')).savepoints).toEqual([
      'before_change',
    ]);
    expect((await runtime.rollbackToSavepoint(tx.id, 'before_change')).state).toBe('active');
    expect((await runtime.commitTransaction(tx.id)).state).toBe('committed');
    await expect(runtime.createSavepoint('missing', 'valid')).rejects.toThrow(/Unknown transaction/);
    await expect(runtime.createSavepoint(tx.id, 'bad-name')).rejects.toThrow(/Savepoint names/);

    const observations = await runtime.observe({
      profileId: 'profile-1',
      resourceId: mock.databaseId,
      categories: ['capacity'],
    });
    expect(observations).toHaveLength(1);
    expect(runtime.resources.observationsFor(mock.databaseId)).toHaveLength(1);
    expect(
      await runtime.operate({ profileId: 'profile-1', operation: 'inspect' }),
    ).toMatchObject({ status: 'succeeded' });
    await expect(
      runtime.operate({ profileId: 'profile-1', operation: 'analyze' }),
    ).rejects.toThrow(/authorization or approval/);
    expect(
      await runtime.operate({
        profileId: 'profile-1',
        operation: 'analyze',
        authorization: { approvalId: 'approval-1' },
      }),
    ).toMatchObject({ status: 'succeeded' });
    expect(auditEvents).toContain('database.operation.analyze');
    expect(runtime.snapshotResources().resources).toHaveLength(1);

    const secondTx = await runtime.beginTransaction('profile-1');
    expect((await runtime.rollbackTransaction(secondTx.id)).state).toBe('rolled-back');
  });

  it('reports close failures as an aggregate without losing the profile', async () => {
    const mock = createMockConnector({ disconnectFails: true });
    const runtime = runtimeWith(mock.connector);
    runtime.createProfile(profile());
    await runtime.connect('profile-1');
    await expect(runtime.close()).rejects.toBeInstanceOf(AggregateError);
    expect(runtime.getProfile('profile-1')).toBeTruthy();
  });
});

async function captureRuntimeError(promise: Promise<unknown>): Promise<DatabaseAccessRuntimeError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DatabaseAccessRuntimeError) return error;
    throw error;
  }
  throw new Error('Expected DatabaseAccessRuntimeError.');
}
