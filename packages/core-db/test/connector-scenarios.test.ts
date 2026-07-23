import { describe, expect, it } from 'vitest';
import type {
  CapabilityDescriptor,
  CapabilityProfile,
  ConnectionProfile,
  QueryJob,
  ResourceDescriptor,
  ResourceDiscoveryPage,
  ResourceObservation,
  ResourceRelation,
} from '@dbagent/shared';
import type { DatabaseConnector } from '../src/index.js';
import {
  ALL_DATABASE_CAPABILITIES,
  ConnectorRegistry,
  DATABASE_CAPABILITIES,
  DatabaseAccessRuntime,
  createStableRelationId,
  createStableResourceId,
  verifyConnectorContract,
} from '../src/index.js';

const timestamp = '2026-07-23T00:00:00.000Z';

type Scenario = 'relational' | 'warehouse' | 'cluster';

class ScenarioConnector implements DatabaseConnector {
  readonly manifest;
  readonly #jobs = new Map<string, QueryJob>();
  readonly #polls = new Map<string, number>();
  readonly #scenario: Scenario;
  readonly resourceIds: string[];

  constructor(scenario: Scenario) {
    this.#scenario = scenario;
    const engine = `mock-${scenario}`;
    const transports =
      scenario === 'warehouse' ? (['http'] as const) : scenario === 'cluster' ? (['jdbc'] as const) : (['tcp'] as const);
    const capabilities = completeCapabilities([
      DATABASE_CAPABILITIES.SQL_QUERY,
      DATABASE_CAPABILITIES.QUERY_CANCEL,
      DATABASE_CAPABILITIES.RESULT_PAGINATION,
      DATABASE_CAPABILITIES.METADATA_OBJECTS,
      ...(scenario === 'warehouse'
        ? [DATABASE_CAPABILITIES.QUERY_ASYNC, DATABASE_CAPABILITIES.QUERY_PROGRESS]
        : []),
      ...(scenario === 'relational'
        ? [DATABASE_CAPABILITIES.TRANSACTION, DATABASE_CAPABILITIES.TRANSACTION_SAVEPOINT]
        : []),
      ...(scenario === 'cluster'
        ? [DATABASE_CAPABILITIES.OBSERVE_REPLICATION, DATABASE_CAPABILITIES.OBSERVE_CAPACITY]
        : []),
    ]);
    this.manifest = {
      id: `${engine}-connector`,
      displayName: `${scenario} contract mock`,
      version: '1.0.0',
      engine,
      transports: [...transports],
      execution: scenario === 'warehouse' ? ('asynchronous' as const) : ('synchronous' as const),
      capabilities,
      operations: [],
      verifiedAgainst: [{ verifiedAt: timestamp, scope: 'contract' as const }],
    };
    this.resourceIds = this.resources().resources.map((resource) => resource.id);
  }

  test() {
    return Promise.resolve({
      connectorId: this.manifest.id,
      engine: this.manifest.engine,
      status: 'healthy' as const,
      checkedAt: timestamp,
      latencyMs: 1,
    });
  }

  connect(context: Parameters<DatabaseConnector['connect']>[0]) {
    return Promise.resolve({
      id: `${this.manifest.id}-session`,
      connectionId: `${this.manifest.id}-connection`,
      profileId: context.profile.id,
      connectorId: this.manifest.id,
      status: 'connected' as const,
      endpointIndex: 0,
      connectedAt: timestamp,
      generation: 1,
    });
  }

  disconnect() {
    return Promise.resolve();
  }

  health() {
    return Promise.resolve({ status: 'healthy' as const, checkedAt: timestamp, latencyMs: 1 });
  }

  capabilities(context: Parameters<DatabaseConnector['capabilities']>[0]): Promise<CapabilityProfile> {
    return Promise.resolve({
      connectorId: this.manifest.id,
      engine: this.manifest.engine,
      connectionProfileId: context.profile.id,
      resolvedAt: timestamp,
      capabilities: structuredClone(this.manifest.capabilities),
    });
  }

  discover(
    _context: Parameters<DatabaseConnector['discover']>[0],
    request: Parameters<DatabaseConnector['discover']>[1],
  ): Promise<ResourceDiscoveryPage> {
    const graph = this.resources();
    if (this.#scenario === 'warehouse' && !request.cursor) {
      return Promise.resolve({
        resources: graph.resources.slice(0, 1),
        relations: [],
        complete: false,
        nextCursor: 'warehouse-page-2',
      });
    }
    return Promise.resolve({
      resources:
        this.#scenario === 'warehouse' ? graph.resources.slice(1) : graph.resources,
      relations: graph.relations,
      ...(graph.observations ? { observations: graph.observations } : {}),
      complete: true,
    });
  }

  submit(
    context: Parameters<DatabaseConnector['submit']>[0],
    submission: Parameters<DatabaseConnector['submit']>[1],
  ): Promise<QueryJob> {
    const id = `${this.manifest.id}-job-${this.#jobs.size + 1}`;
    const async = this.#scenario === 'warehouse' || submission.executionMode === 'async';
    const job: QueryJob = {
      id,
      profileId: context.profile.id,
      connectorId: this.manifest.id,
      state: async ? 'queued' : 'succeeded',
      submittedAt: timestamp,
      progress: async ? 0 : 1,
      ...(async
        ? {
            cost: {
              bytesScanned: 64 * 1024 * 1024,
              estimatedCost: 0.42,
              currency: 'CNY',
            },
          }
        : terminalResult(id)),
    };
    this.#jobs.set(id, job);
    return Promise.resolve(structuredClone(job));
  }

  getJob(
    _context: Parameters<DatabaseConnector['getJob']>[0],
    jobId: string,
  ): Promise<QueryJob> {
    const job = this.#jobs.get(jobId)!;
    if (job.state === 'queued') {
      const polls = (this.#polls.get(jobId) ?? 0) + 1;
      this.#polls.set(jobId, polls);
      const updated: QueryJob =
        polls === 1
          ? {
              ...job,
              state: 'running',
              startedAt: timestamp,
              progress: 0.5,
              stages: [{ id: 'scan', name: 'Scan', state: 'running', progress: 0.5 }],
            }
          : {
              ...job,
              state: 'succeeded',
              startedAt: timestamp,
              progress: 1,
              cost: {
                ...job.cost,
                bytesProcessed: 32 * 1024 * 1024,
                actualCost: 0.21,
              },
              ...terminalResult(job.id),
            };
      this.#jobs.set(jobId, updated);
      return Promise.resolve(structuredClone(updated));
    }
    if (job.state === 'running') {
      const updated = {
        ...job,
        state: 'succeeded' as const,
        progress: 1,
        cost: {
          ...job.cost,
          bytesProcessed: 32 * 1024 * 1024,
          actualCost: 0.21,
        },
        ...terminalResult(job.id),
      };
      this.#jobs.set(jobId, updated);
      return Promise.resolve(structuredClone(updated));
    }
    return Promise.resolve(structuredClone(job));
  }

  cancel(
    _context: Parameters<DatabaseConnector['cancel']>[0],
    jobId: string,
  ): Promise<QueryJob> {
    const job = {
      ...this.#jobs.get(jobId)!,
      state: 'cancelled' as const,
      completedAt: timestamp,
      progress: 1,
    };
    this.#jobs.set(jobId, job);
    return Promise.resolve(structuredClone(job));
  }

  readResult(
    _context: Parameters<DatabaseConnector['readResult']>[0],
    handleId: string,
    input: Parameters<DatabaseConnector['readResult']>[2] = {},
  ) {
    const allRows = [{ value: 1 }, { value: 2 }, { value: 3 }];
    const offset = input.cursor ? Number(input.cursor) : 0;
    const limit = input.limit ?? 2;
    const rows = allRows.slice(offset, offset + limit);
    const next = offset + rows.length;
    return Promise.resolve({
      handleId,
      rows,
      rowOffset: offset,
      complete: next >= allRows.length,
      ...(next < allRows.length ? { nextCursor: String(next) } : {}),
    });
  }

  observe(): Promise<ResourceObservation[]> {
    return Promise.resolve(this.resources().observations ?? []);
  }

  private resources(): {
    resources: ResourceDescriptor[];
    relations: ResourceRelation[];
    observations?: ResourceObservation[];
  } {
    const source = {
      sourceId: this.manifest?.id ?? `mock-${this.#scenario}`,
      sourceType: 'connector' as const,
      observedAt: timestamp,
    };
    if (this.#scenario === 'cluster') {
      const cluster = mockResource('cluster', 'cluster-a', this.manifest?.engine ?? 'mock-cluster', source);
      const primary = mockResource('node', 'node-primary', this.manifest?.engine ?? 'mock-cluster', source);
      const replica = mockResource('replica', 'node-replica', this.manifest?.engine ?? 'mock-cluster', source);
      const shard = mockResource('shard', 'shard-01', this.manifest?.engine ?? 'mock-cluster', source);
      return {
        resources: [cluster, primary, replica, shard],
        relations: [
          mockRelation('contains', cluster, primary, source),
          mockRelation('contains', cluster, replica, source),
          mockRelation('contains', cluster, shard, source),
          mockRelation('replicates_to', primary, replica, source),
        ],
        observations: [
          observation(cluster.id, 'topology', 'degraded', source, { availableNodes: 1, totalNodes: 2 }),
          observation(primary.id, 'replication', 'healthy', source, { lagSeconds: 0 }),
          observation(replica.id, 'replication', 'degraded', source, { lagSeconds: 42 }),
          observation(shard.id, 'capacity', 'healthy', source, { usedPercent: 61 }),
        ],
      };
    }
    const parentKind = this.#scenario === 'warehouse' ? 'platform' : 'database';
    const childKind = this.#scenario === 'warehouse' ? 'compute-group' : 'table';
    const parent = mockResource(
      parentKind,
      `${this.#scenario}-parent`,
      this.manifest?.engine ?? `mock-${this.#scenario}`,
      source,
    );
    const child = mockResource(
      childKind,
      `${this.#scenario}-child`,
      this.manifest?.engine ?? `mock-${this.#scenario}`,
      source,
    );
    return {
      resources: [parent, child],
      relations: [mockRelation('contains', parent, child, source)],
    };
  }
}

describe('connector contract scenarios', () => {
  it.each(['relational', 'warehouse', 'cluster'] as const)(
    'passes the reusable %s architecture contract without claiming vendor certification',
    async (scenario) => {
      const connector = new ScenarioConnector(scenario);
      const report = await verifyConnectorContract({
        connector,
        profile: scenarioProfile(connector, scenario),
        readQuery: { sql: 'select 1', executionMode: scenario === 'warehouse' ? 'async' : 'sync' },
      });
      expect(report).toMatchObject({
        connectorId: connector.manifest.id,
        scope: 'contract',
        passed: true,
      });
      expect(report.checks.every((check) => check.passed)).toBe(true);
      expect(report.checks.map((check) => check.name)).toEqual([
        'manifest',
        'capability-coverage',
        'connection-test',
        'connect',
        'health',
        'dynamic-capabilities',
        'paged-discovery',
        'query-job-and-results',
        'disconnect',
      ]);
    },
  );

  it('preserves warehouse queue, stage, scan cost, cancellation and resumable results', async () => {
    const connector = new ScenarioConnector('warehouse');
    const runtime = scenarioRuntime(connector);
    const profile = scenarioProfile(connector, 'warehouse');
    runtime.createProfile(profile);
    await runtime.connect(profile.id);
    const queued = await runtime.submit({
      profileId: profile.id,
      sql: 'select warehouse_data',
      executionMode: 'async',
      maximumBytesScanned: 128 * 1024 * 1024,
      maximumCost: 1,
    });
    expect(queued).toMatchObject({
      state: 'queued',
      cost: { bytesScanned: 64 * 1024 * 1024, estimatedCost: 0.42, currency: 'CNY' },
    });
    const running = await runtime.getJob(queued.id);
    expect(running).toMatchObject({
      state: 'running',
      progress: 0.5,
      stages: [expect.objectContaining({ name: 'Scan' })],
    });
    const completed = await runtime.getJob(queued.id);
    expect(completed).toMatchObject({
      state: 'succeeded',
      cost: { bytesProcessed: 32 * 1024 * 1024, actualCost: 0.21 },
    });
    const rows = [];
    for await (const batch of runtime.streamResult(completed.result!.id, { batchSize: 1 })) {
      rows.push(...batch.rows);
    }
    expect(rows).toEqual([{ value: 1 }, { value: 2 }, { value: 3 }]);

    const cancellable = await runtime.submit({
      profileId: profile.id,
      sql: 'select long_warehouse_query',
      executionMode: 'async',
    });
    expect((await runtime.cancel(cancellable.id)).state).toBe('cancelled');
  });

  it('keeps cluster, primary, degraded replica and healthy shard states independent', async () => {
    const connector = new ScenarioConnector('cluster');
    const runtime = scenarioRuntime(connector);
    const profile = scenarioProfile(connector, 'cluster');
    runtime.createProfile(profile);
    await runtime.connect(profile.id);
    await runtime.discoverAll(profile.id);
    expect(runtime.queryResources({ kinds: ['cluster'] }).items).toHaveLength(1);
    expect(runtime.queryResources({ kinds: ['node'] }).items).toHaveLength(1);
    expect(runtime.queryResources({ kinds: ['replica'] }).items).toHaveLength(1);
    expect(runtime.queryResources({ kinds: ['shard'] }).items).toHaveLength(1);
    const observations = await runtime.observe({ profileId: profile.id });
    expect(observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'topology', status: 'degraded' }),
        expect.objectContaining({
          category: 'replication',
          status: 'healthy',
          metrics: { lagSeconds: 0 },
        }),
        expect.objectContaining({
          category: 'replication',
          status: 'degraded',
          metrics: { lagSeconds: 42 },
        }),
        expect.objectContaining({ category: 'capacity', status: 'healthy' }),
      ]),
    );
    expect(runtime.resources.size).toBe(4);
  });

  it('makes timeout, unsupported capability and uncertain submit failures explicit', async () => {
    const base = new ScenarioConnector('relational');
    const faultCapabilities = {
      ...base.manifest.capabilities,
      [DATABASE_CAPABILITIES.QUERY_ASYNC]: {
        key: DATABASE_CAPABILITIES.QUERY_ASYNC,
        status: 'unsupported' as const,
        reason: 'Fault fixture has no async jobs',
        source: 'fault',
        observedAt: timestamp,
      },
    };
    const fault: DatabaseConnector = {
      manifest: {
        ...base.manifest,
        id: 'fault-connector',
        engine: 'fault',
        capabilities: faultCapabilities,
      },
      test() {
        return Promise.reject(
          Object.assign(new Error('network timeout'), { code: 'ETIMEDOUT' }),
        );
      },
      connect(context) {
        return Promise.resolve({
          id: 'fault-session',
          connectionId: 'fault-connection',
          profileId: context.profile.id,
          connectorId: 'fault-connector',
          status: 'connected' as const,
          endpointIndex: 0,
          generation: 1,
        });
      },
      disconnect() {
        return base.disconnect();
      },
      health() {
        return base.health();
      },
      capabilities(context) {
        return Promise.resolve({
          connectorId: 'fault-connector',
          engine: 'fault',
          connectionProfileId: context.profile.id,
          resolvedAt: timestamp,
          capabilities: faultCapabilities,
        });
      },
      discover(context, request) {
        return base.discover(context, request);
      },
      submit() {
        return Promise.reject(
          Object.assign(new Error('permission changed while submitting write'), {
            code: 'PERMISSION_CHANGED',
          }),
        );
      },
      getJob(context, jobId) {
        return base.getJob(context, jobId);
      },
      cancel(context, jobId) {
        return base.cancel(context, jobId);
      },
      readResult(context, handleId, input) {
        return base.readResult(context, handleId, input);
      },
      observe() {
        return base.observe();
      },
    };
    const runtime = scenarioRuntime(fault);
    const profile = {
      ...scenarioProfile(fault, 'relational'),
      engine: 'fault',
      connectorId: 'fault-connector',
    };
    runtime.createProfile(profile);
    await expect(runtime.testProfile(profile.id)).rejects.toMatchObject({
      error: {
        code: 'ETIMEDOUT',
        category: 'network',
        retryable: true,
        outcome: 'unchanged',
      },
    });
    await runtime.connect(profile.id);
    await expect(
      runtime.submit({
        profileId: profile.id,
        sql: 'select async',
        executionMode: 'async',
      }),
    ).rejects.toMatchObject({
      error: {
        code: 'CAPABILITY_UNAVAILABLE',
        category: 'unsupported',
        outcome: 'unchanged',
      },
    });
    await expect(runtime.submit({ profileId: profile.id, sql: 'select uncertain' })).rejects.toMatchObject(
      {
        error: {
          code: 'PERMISSION_CHANGED',
          category: 'provider',
          outcome: 'unknown',
        },
      },
    );
  });
});

function completeCapabilities(supported: string[]): Record<string, CapabilityDescriptor> {
  const supportedSet = new Set(supported);
  return Object.fromEntries(
    ALL_DATABASE_CAPABILITIES.map((key) => [
      key,
      {
        key,
        status: supportedSet.has(key) ? 'supported' : 'unsupported',
        reason: supportedSet.has(key) ? 'Implemented by contract mock' : 'Explicitly not implemented',
        source: 'contract-mock',
        observedAt: timestamp,
      },
    ]),
  );
}

function terminalResult(jobId: string): Pick<QueryJob, 'completedAt' | 'result'> {
  return {
    completedAt: timestamp,
    result: {
      id: `${jobId}-result`,
      jobId,
      format: 'rows',
      columns: [{ name: 'value', dataType: 'integer' }],
      rowCount: 3,
      expiresAt: '2099-01-01T00:00:00.000Z',
    },
  };
}

function scenarioProfile(
  connector: DatabaseConnector,
  scenario: Scenario,
): ConnectionProfile {
  const endpoint =
    scenario === 'warehouse'
      ? ({ transport: 'http', baseUrl: 'https://warehouse.invalid' } as const)
      : scenario === 'cluster'
        ? ({ transport: 'jdbc', url: 'jdbc:mock://cluster.invalid/demo' } as const)
        : ({ transport: 'tcp', host: '127.0.0.1', port: 9999, database: 'demo' } as const);
  return {
    id: `${connector.manifest.id}-profile`,
    name: `${scenario} profile`,
    connectorId: connector.manifest.id,
    engine: connector.manifest.engine,
    endpoints: [endpoint],
    purpose: 'query',
    readOnly: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function scenarioRuntime(connector: DatabaseConnector): DatabaseAccessRuntime {
  const connectors = new ConnectorRegistry();
  connectors.register(connector);
  return new DatabaseAccessRuntime({ connectors });
}

function mockResource(
  kind: string,
  nativeId: string,
  engine: string,
  source: ResourceDescriptor['sources'][number],
): ResourceDescriptor {
  return {
    id: createStableResourceId({ sourceNamespace: engine, kind, nativeId }),
    kind,
    nativeId,
    canonicalName: nativeId,
    engine,
    version: 1,
    firstSeenAt: timestamp,
    updatedAt: timestamp,
    sources: [source],
  };
}

function mockRelation(
  kind: string,
  from: ResourceDescriptor,
  to: ResourceDescriptor,
  source: ResourceRelation['sources'][number],
): ResourceRelation {
  return {
    id: createStableRelationId({
      kind,
      fromResourceId: from.id,
      toResourceId: to.id,
    }),
    kind,
    fromResourceId: from.id,
    toResourceId: to.id,
    version: 1,
    firstSeenAt: timestamp,
    updatedAt: timestamp,
    sources: [source],
  };
}

function observation(
  resourceId: string,
  category: string,
  status: ResourceObservation['status'],
  source: ResourceObservation['source'],
  metrics: Record<string, number>,
): ResourceObservation {
  return {
    id: `${resourceId}-${category}`,
    resourceId,
    category,
    status,
    metrics,
    observedAt: timestamp,
    expiresAt: '2099-01-01T00:00:00.000Z',
    source,
  };
}
