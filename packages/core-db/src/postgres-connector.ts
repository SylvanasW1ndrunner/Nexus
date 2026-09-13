import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AppError,
  CapabilityDescriptor,
  CapabilityProfile,
  ConnectionHealth,
  ConnectionProfile,
  ConnectionSession,
  ConnectionTestResult,
  DatabaseAccessError,
  DatabaseObservationRequest,
  DatabaseOperationRequest,
  DatabaseOperationResult,
  DatabaseTransaction,
  DbColumnValue,
  PortableValue,
  QueryJob,
  QueryResultRow,
  QuerySubmission,
  ResourceDescriptor,
  ResourceDiscoveryPage,
  ResourceObservation,
  ResourceRelation,
  ResultBatch,
  ResultHandle,
  SavedConnection,
} from '@dbagent/shared';
import { stringifyPublicJson } from '@dbagent/shared';
import { CapabilityResolver, DATABASE_CAPABILITIES } from './capability-resolver.js';
import type {
  ConnectorContext,
  ConnectorManifest,
  DatabaseConnector,
  DiscoveryRequest,
  TransactionOptions,
} from './connector.js';
import type { DatabaseConnectionConfig, QueryExecutionObserver } from './types.js';
import {
  PostgresDriver,
  type PostgresCatalogEntry,
  type PostgresConnectorDriver,
  type PostgresServerInfo,
} from './postgres-driver.js';
import {
  createResourceObservation,
  createStableRelationId,
  createStableResourceId,
} from '@dbagent/core-resource';
import { ProjectDatabaseResultStore } from './project-result-store.js';
import {
  DatabaseResultStoreError,
  type DatabaseResultStore,
  type DatabaseResultWriter,
} from './result-store.js';

const DEFAULT_RESULT_TTL_MS = 60 * 60 * 1_000;
const DEFAULT_MAX_RETAINED_RESULTS = 256;
const DEFAULT_MAX_RETAINED_RESULT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_RETAINED_JOBS = 1_024;
const RELEASED_RESULTS_BEFORE_GC = 16;
const RELEASED_BYTES_BEFORE_GC = 64 * 1024 * 1024;
const DEFAULT_DISCOVERY_PAGE_SIZE = 500;
const DEFAULT_RESULT_PAGE_SIZE = 1_000;

/** Stable registry identity used by every PostgreSQL connection profile. */
export const POSTGRES_CONNECTOR_ID = 'postgres-native';

type ConnectedPostgres = {
  session: ConnectionSession;
  connection: SavedConnection;
  serverInfo: PostgresServerInfo;
  endpointIndex: number;
  nativeResources: Map<string, { id: string; kind: string }>;
};

type InternalQueryJob = {
  job: QueryJob;
  backendPid?: number;
  cancelRequested: boolean;
  execution?: Promise<void>;
};

export type PostgresConnectorOptions = {
  resultStore?: DatabaseResultStore;
  resultTtlMs?: number;
  maxRetainedResults?: number;
  maxRetainedResultBytes?: number;
  maxRetainedJobs?: number;
};

export class PostgresConnector implements DatabaseConnector {
  readonly manifest: ConnectorManifest;
  readonly #driver: PostgresConnectorDriver;
  readonly #capabilityResolver = new CapabilityResolver();
  readonly #connections = new Map<string, ConnectedPostgres>();
  readonly #jobs = new Map<string, InternalQueryJob>();
  readonly #resultJobs = new Map<string, string>();
  readonly #resultTtlMs: number;
  readonly #maxRetainedResults: number;
  readonly #maxRetainedResultBytes: number;
  readonly #maxRetainedJobs: number;
  readonly #resultStore: DatabaseResultStore;
  #resultStoreReady: Promise<void> | undefined;
  #retainedResultBytes = 0;
  #releasedResultsSinceGc = 0;
  #releasedBytesSinceGc = 0;

  constructor(driver: PostgresConnectorDriver = new PostgresDriver(), options: PostgresConnectorOptions = {}) {
    this.#driver = driver;
    this.#resultTtlMs = positiveRetentionOption(
      options.resultTtlMs,
      DEFAULT_RESULT_TTL_MS,
      'resultTtlMs',
    );
    this.#maxRetainedResults = positiveRetentionOption(
      options.maxRetainedResults,
      DEFAULT_MAX_RETAINED_RESULTS,
      'maxRetainedResults',
    );
    this.#maxRetainedResultBytes = positiveRetentionOption(
      options.maxRetainedResultBytes,
      DEFAULT_MAX_RETAINED_RESULT_BYTES,
      'maxRetainedResultBytes',
    );
    this.#maxRetainedJobs = positiveRetentionOption(
      options.maxRetainedJobs,
      DEFAULT_MAX_RETAINED_JOBS,
      'maxRetainedJobs',
    );
    if (options.resultStore) {
      this.#resultStore = options.resultStore;
    } else {
      const fallbackIdentity = randomUUID();
      this.#resultStore = new ProjectDatabaseResultStore({
        projectId: `unscoped:${fallbackIdentity}`,
        rootDir: join(
          tmpdir(),
          'schemanaut',
          'database-results',
          `unscoped-${process.pid}-${fallbackIdentity}`,
        ),
      });
      // Compatibility for callers that only inspect the connector manifest.
      // Production composition injects one Project-owned durable store.
    }
    this.manifest = createPostgresManifest();
  }

  async test(context: ConnectorContext): Promise<ConnectionTestResult> {
    const attempts: string[] = [];
    for (let index = 0; index < context.profile.endpoints.length; index += 1) {
      try {
        const config = this.#config(context.profile, context, index, `test-${randomUUID()}`);
        const result = await this.#driver.test(config);
        if (result.ok) {
          return {
            status: 'healthy',
            checkedAt: new Date().toISOString(),
            latencyMs: result.data.latencyMs,
            endpointIndex: index,
            connectorId: this.manifest.id,
            engine: this.manifest.engine,
            capabilities: this.#baseCapabilities(context.profile),
          };
        }
        attempts.push(`${index}:${result.error.code}`);
      } catch (error) {
        attempts.push(`${index}:${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new PostgresConnectorError({
      code: 'POSTGRES_TEST_FAILED',
      category: 'network',
      message: 'No PostgreSQL endpoint accepted the connection.',
      detail: attempts.join(', '),
      stage: 'connect',
      profileId: context.profile.id,
      retryable: true,
      outcome: 'unchanged',
    });
  }

  async connect(context: ConnectorContext): Promise<ConnectionSession> {
    const current = this.#connections.get(context.profile.id);
    if (current) return structuredClone(current.session);

    const failures: AppError[] = [];
    for (let index = 0; index < context.profile.endpoints.length; index += 1) {
      const connectionId = `pg_${context.profile.id}`;
      const config = this.#config(context.profile, context, index, connectionId);
      const connected = await this.#driver.connect(config);
      if (!connected.ok) {
        failures.push(connected.error);
        continue;
      }
      const serverInfoResult = await this.#driver.serverInfo(connectionId);
      if (!serverInfoResult.ok) {
        await this.#driver.disconnect(connectionId);
        failures.push(serverInfoResult.error);
        continue;
      }
      const now = new Date().toISOString();
      const session: ConnectionSession = {
        id: randomUUID(),
        connectionId,
        profileId: context.profile.id,
        connectorId: this.manifest.id,
        status: 'connected',
        endpointIndex: index,
        connectedAt: now,
        lastHealth: {
          status: 'healthy',
          checkedAt: now,
          engineVersion: serverInfoResult.data.engineVersion,
          endpointIndex: index,
        },
        nativeSessionId: connectionId,
        generation: (context.session?.generation ?? 0) + 1,
      };
      this.#connections.set(context.profile.id, {
        session,
        connection: connected.data,
        serverInfo: serverInfoResult.data,
        endpointIndex: index,
        nativeResources: new Map(),
      });
      return structuredClone(session);
    }
    const last = failures.at(-1);
    throw new PostgresConnectorError(
      toDatabaseError(
        last ?? { code: 'CONNECTION_FAILED', message: 'No PostgreSQL endpoint is available.' },
        'connect',
        context.profile.id,
      ),
    );
  }

  async disconnect(context: ConnectorContext): Promise<void> {
    const connected = this.#connections.get(context.profile.id);
    if (!connected) return;
    const result = await this.#driver.disconnect(connected.connection.id);
    if (!result.ok) {
      throw new PostgresConnectorError(
        toDatabaseError(result.error, 'connect', context.profile.id),
      );
    }
    this.#connections.delete(context.profile.id);
    await this.#purgeProfileQueries(context.profile.id);
  }

  async reconnect(context: ConnectorContext): Promise<ConnectionSession> {
    await this.disconnect(context);
    return this.connect({
      profile: context.profile,
      ...(context.credential ? { credential: context.credential } : {}),
      ...(context.session ? { session: context.session } : {}),
    });
  }

  async health(context: ConnectorContext): Promise<ConnectionHealth> {
    const connected = this.#requireConnection(context.profile.id);
    const started = performance.now();
    const result = await this.#driver.execute(
      {
        connectionId: connected.connection.id,
        sql: 'select 1::int as healthy',
        limit: 1,
      },
      connected.connection,
    );
    if (!result.ok) {
      return {
        status: result.error.retryable ? 'unavailable' : 'degraded',
        checkedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - started),
        engineVersion: connected.serverInfo.engineVersion,
        endpointIndex: connected.endpointIndex,
        message: result.error.message,
      };
    }
    return {
      status: 'healthy',
      checkedAt: new Date().toISOString(),
      latencyMs: Math.round(performance.now() - started),
      engineVersion: connected.serverInfo.engineVersion,
      endpointIndex: connected.endpointIndex,
    };
  }

  capabilities(context: ConnectorContext): Promise<CapabilityProfile> {
    const connected = this.#connections.get(context.profile.id);
    const base = this.#baseCapabilities(context.profile);
    return Promise.resolve(
      this.#capabilityResolver.resolve({
        connectorId: this.manifest.id,
        engine: this.manifest.engine,
        ...(connected ? { engineVersion: connected.serverInfo.engineVersion } : {}),
        connectionProfileId: context.profile.id,
        layers: [
          {
            source: `${this.manifest.id}:manifest`,
            capabilities: stripRuntimeCapabilityFields(base.capabilities),
          },
          {
            source: `${this.manifest.id}:profile`,
            capabilities: {
              [DATABASE_CAPABILITIES.SQL_WRITE]: capabilityInput(
                DATABASE_CAPABILITIES.SQL_WRITE,
                context.profile.readOnly ? 'unsupported' : 'conditional',
                context.profile.readOnly
                  ? 'Connection profile is read-only'
                  : 'PostgreSQL supports writes when the current role and safety policy allow them',
              ),
              [DATABASE_CAPABILITIES.SQL_DDL]: capabilityInput(
                DATABASE_CAPABILITIES.SQL_DDL,
                context.profile.readOnly ? 'unsupported' : 'conditional',
                context.profile.readOnly
                  ? 'Connection profile is read-only'
                  : 'DDL requires role permission, explicit confirmation and safety approval',
              ),
              [DATABASE_CAPABILITIES.OPERATE_TERMINATE_SESSION]: capabilityInput(
                DATABASE_CAPABILITIES.OPERATE_TERMINATE_SESSION,
                context.profile.purpose === 'admin' ? 'conditional' : 'unsupported',
                context.profile.purpose === 'admin'
                  ? 'Requires PostgreSQL role permission and operation approval'
                  : 'An admin-purpose profile is required',
                context.profile.purpose === 'admin'
                  ? [{ name: 'approved', value: true, message: 'Operation approval is required' }]
                  : undefined,
              ),
              [DATABASE_CAPABILITIES.OPERATE_VACUUM]: capabilityInput(
                DATABASE_CAPABILITIES.OPERATE_VACUUM,
                context.profile.purpose === 'admin' && !context.profile.readOnly
                  ? 'conditional'
                  : 'unsupported',
                'Requires an admin, writable profile and PostgreSQL table permission',
                context.profile.purpose === 'admin' && !context.profile.readOnly
                  ? [{ name: 'approved', value: true, message: 'Operation approval is required' }]
                  : undefined,
              ),
            },
          },
        ],
        context: {
          connected: connected !== undefined,
          purpose: context.profile.purpose,
          readOnly: context.profile.readOnly,
        },
      }),
    );
  }

  async discover(
    context: ConnectorContext,
    request: DiscoveryRequest,
  ): Promise<ResourceDiscoveryPage> {
    const connected = this.#requireConnection(context.profile.id);
    const offset = decodeOffset(request.cursor);
    const limit = Math.min(Math.max(request.limit ?? DEFAULT_DISCOVERY_PAGE_SIZE, 1), 10_000);
    const page = await this.#driver.discoverCatalog(connected.connection.id, { offset, limit });
    if (!page.ok) {
      throw new PostgresConnectorError(toDatabaseError(page.error, 'discover', context.profile.id));
    }
    const observedAt = new Date().toISOString();
    const source = {
      sourceId: `${this.manifest.id}:${context.profile.id}`,
      sourceType: 'connector' as const,
      connectorId: this.manifest.id,
      connectionProfileId: context.profile.id,
      observedAt,
      ...(request.cursor ? { cursor: request.cursor } : {}),
    };
    const resources: ResourceDescriptor[] = [];
    const relations: ResourceRelation[] = [];
    if (offset === 0) {
      const base = this.#baseResources(context.profile, connected, observedAt);
      resources.push(...base.resources);
      relations.push(...base.relations);
    }
    for (const entry of page.data.entries) {
      const resource = this.#catalogResource(context.profile, connected, entry, source);
      resources.push(resource);
      const parent = connected.nativeResources.get(entry.parentNativeId);
      if (!parent) {
        throw new PostgresConnectorError({
          code: 'POSTGRES_CATALOG_PARENT_MISSING',
          category: 'provider',
          message: `Catalog parent was not discovered before child: ${entry.parentNativeId}`,
          stage: 'discover',
          profileId: context.profile.id,
          retryable: false,
          outcome: 'unchanged',
        });
      }
      relations.push(createRelation('contains', parent.id, resource.id, source, observedAt));
      if (entry.kind === 'constraint') {
        relations.push(
          ...this.#foreignKeyRelations(connected, entry, resource, parent.id, source, observedAt),
        );
      }
    }
    const complete = !page.data.hasMore;
    return {
      resources,
      relations,
      complete,
      snapshotId: `${context.profile.id}:${connected.serverInfo.database}:${observedAt}`,
      ...(!complete ? { nextCursor: encodeOffset(offset + limit) } : {}),
    };
  }

  async submit(context: ConnectorContext, submission: QuerySubmission): Promise<QueryJob> {
    const connected = this.#requireConnection(context.profile.id);
    const now = new Date().toISOString();
    const job: QueryJob = {
      id: randomUUID(),
      profileId: context.profile.id,
      ...(submission.sessionId ? { sessionId: submission.sessionId } : {}),
      ...(submission.resourceId ? { resourceId: submission.resourceId } : {}),
      connectorId: this.manifest.id,
      state: submission.executionMode === 'async' ? 'queued' : 'submitted',
      submittedAt: now,
      progress: 0,
    };
    const internal: InternalQueryJob = { job, cancelRequested: false };
    this.#jobs.set(job.id, internal);
    const execution = this.#runJob(internal, connected, submission);
    internal.execution = execution;
    if (submission.executionMode !== 'async') {
      await execution;
    } else {
      void execution.catch(() => undefined);
    }
    return structuredClone(internal.job);
  }

  getJob(_context: ConnectorContext, jobId: string): Promise<QueryJob> {
    return Promise.resolve(structuredClone(this.#requireJob(jobId).job));
  }

  async cancel(context: ConnectorContext, jobId: string): Promise<QueryJob> {
    const internal = this.#requireJob(jobId);
    if (isTerminal(internal.job.state)) return structuredClone(internal.job);
    internal.cancelRequested = true;
    if (internal.job.state === 'queued' || internal.job.state === 'submitted') {
      internal.job = {
        ...internal.job,
        state: 'cancelled',
        progress: 1,
        completedAt: new Date().toISOString(),
      };
      return structuredClone(internal.job);
    }
    internal.job = { ...internal.job, state: 'cancelling' };
    if (internal.backendPid) {
      const connected = this.#requireConnection(context.profile.id);
      const cancelled = await this.#driver.cancel(
        {
          queryId: jobId,
          connectionId: connected.connection.id,
          decision: 'cancel-backend',
          backendPid: internal.backendPid,
          message: 'Cancel requested by Database Access Runtime.',
        },
        connected.connection,
      );
      if (!cancelled.ok) {
        throw new PostgresConnectorError(
          toDatabaseError(cancelled.error, 'cancel', context.profile.id, jobId),
        );
      }
    }
    return structuredClone(internal.job);
  }

  async readResult(
    _context: ConnectorContext,
    handleId: string,
    input: { cursor?: string; limit?: number } = {},
  ): Promise<ResultBatch> {
    await this.#ensureResultStoreReady();
    await this.#pruneRetainedResults();
    const jobId = this.#resultJobs.get(handleId);
    const internal = jobId ? this.#jobs.get(jobId) : undefined;
    if (!internal?.job.result) {
      throw connectorNotFound(
        'RESULT_NOT_FOUND',
        `Result handle was not found: ${handleId}`,
        'result',
      );
    }
    try {
      const page = await this.#resultStore.page(handleId, {
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        limit: Math.min(input.limit ?? DEFAULT_RESULT_PAGE_SIZE, DEFAULT_RESULT_PAGE_SIZE),
      });
      const binaryColumns = new Set(
        internal.job.result.columns
          .filter(isPostgresBinaryColumn)
          .map(({ name }) => name),
      );
      return {
        handleId: page.handleId,
        rows: page.rows.map((row) => restorePostgresResultRow(row, binaryColumns)),
        rowOffset: page.rowOffset,
        complete: page.complete,
        byteCount: page.byteCount,
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      };
    } catch (error) {
      if (error instanceof DatabaseResultStoreError) {
        if (error.code === 'EXPIRED') internal.job = { ...internal.job, state: 'expired' };
        throw resultStoreConnectorError(error, handleId);
      }
      throw error;
    }
  }

  async releaseResult(context: ConnectorContext, handleId: string): Promise<boolean> {
    await this.#ensureResultStoreReady();
    const jobId = this.#resultJobs.get(handleId);
    const internal = jobId ? this.#jobs.get(jobId) : undefined;
    if (!internal || internal.job.profileId !== context.profile.id) {
      return false;
    }
    const releasedBytes = internal.job.result?.byteCount ?? 0;
    const released = await this.#evictResult(handleId, false, true, 'released');
    if (released) {
      await this.#collectReleasedResultGarbage(releasedBytes).catch(() => undefined);
    }
    this.#pruneRetainedJobs();
    return released;
  }

  async *streamResult(
    context: ConnectorContext,
    handleId: string,
    input: { batchSize?: number } = {},
  ): AsyncIterable<ResultBatch> {
    let cursor: string | undefined;
    do {
      const batch = await this.readResult(context, handleId, {
        ...(cursor ? { cursor } : {}),
        ...(input.batchSize ? { limit: input.batchSize } : {}),
      });
      yield batch;
      if (batch.complete) return;
      cursor = batch.nextCursor;
    } while (cursor);
  }

  async beginTransaction(
    context: ConnectorContext,
    options: TransactionOptions = {},
  ): Promise<DatabaseTransaction> {
    const connected = this.#requireConnection(context.profile.id);
    const sessionId = context.session?.id ?? connected.session.id;
    const result = await this.#driver.beginTransaction(connected.connection, {
      profileId: context.profile.id,
      sessionId,
      ...(options.isolationLevel ? { isolationLevel: options.isolationLevel } : {}),
      ...(options.readOnly !== undefined ? { readOnly: options.readOnly } : {}),
    });
    return unwrap(result, 'execute', context.profile.id);
  }

  async createSavepoint(
    context: ConnectorContext,
    transactionId: string,
    name: string,
  ): Promise<DatabaseTransaction> {
    return unwrap(
      await this.#driver.createSavepoint(transactionId, name),
      'execute',
      context.profile.id,
    );
  }

  async rollbackToSavepoint(
    context: ConnectorContext,
    transactionId: string,
    name: string,
  ): Promise<DatabaseTransaction> {
    return unwrap(
      await this.#driver.rollbackToSavepoint(transactionId, name),
      'execute',
      context.profile.id,
    );
  }

  async commitTransaction(
    context: ConnectorContext,
    transactionId: string,
  ): Promise<DatabaseTransaction> {
    return unwrap(
      await this.#driver.commitTransaction(transactionId),
      'execute',
      context.profile.id,
    );
  }

  async rollbackTransaction(
    context: ConnectorContext,
    transactionId: string,
  ): Promise<DatabaseTransaction> {
    return unwrap(
      await this.#driver.rollbackTransaction(transactionId),
      'execute',
      context.profile.id,
    );
  }

  async observe(
    context: ConnectorContext,
    request: DatabaseObservationRequest,
  ): Promise<ResourceObservation[]> {
    const connected = this.#requireConnection(context.profile.id);
    const snapshot = await this.#driver.runtimeSnapshot(connected.connection.id);
    if (!snapshot.ok) {
      throw new PostgresConnectorError(
        toDatabaseError(snapshot.error, 'observe', context.profile.id),
      );
    }
    const databaseNativeId = connected.serverInfo.database;
    const databaseResource =
      request.resourceId ??
      connected.nativeResources.get(databaseNativeId)?.id ??
      this.#resourceId(context.profile, 'database', databaseNativeId);
    const observedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 30_000).toISOString();
    const source = {
      sourceId: `${this.manifest.id}:${context.profile.id}:runtime`,
      sourceType: 'driver' as const,
      connectorId: this.manifest.id,
      connectionProfileId: context.profile.id,
      observedAt,
      expiresAt,
    };
    const candidates: ResourceObservation[] = [
      createResourceObservation({
        resourceId: databaseResource,
        category: 'sessions',
        status: snapshot.data.idleInTransaction > 0 ? 'degraded' : 'healthy',
        metrics: {
          total: snapshot.data.totalSessions,
          active: snapshot.data.activeQueries,
          idleInTransaction: snapshot.data.idleInTransaction,
        },
        observedAt,
        expiresAt,
        source,
      }),
      createResourceObservation({
        resourceId: databaseResource,
        category: 'queries',
        status:
          snapshot.data.waitingQueries > 0 || snapshot.data.longestQuerySeconds > 60
            ? 'degraded'
            : 'healthy',
        metrics: {
          active: snapshot.data.activeQueries,
          waiting: snapshot.data.waitingQueries,
          longestSeconds: snapshot.data.longestQuerySeconds,
        },
        observedAt,
        expiresAt,
        source,
      }),
      createResourceObservation({
        resourceId: databaseResource,
        category: 'locks',
        status: snapshot.data.blockedLocks > 0 ? 'degraded' : 'healthy',
        metrics: { blocked: snapshot.data.blockedLocks },
        observedAt,
        expiresAt,
        source,
      }),
      createResourceObservation({
        resourceId: databaseResource,
        category: 'capacity',
        status: 'healthy',
        metrics: { databaseBytes: snapshot.data.databaseBytes },
        observedAt,
        expiresAt,
        source,
      }),
      createResourceObservation({
        resourceId: databaseResource,
        category: 'replication',
        status: (snapshot.data.maximumReplayLagSeconds ?? 0) > 30 ? 'degraded' : 'healthy',
        metrics: {
          clients: snapshot.data.replicationClients,
          maximumReplayLagSeconds: snapshot.data.maximumReplayLagSeconds ?? 0,
        },
        attributes: { inRecovery: snapshot.data.inRecovery },
        observedAt,
        expiresAt,
        source,
      }),
    ];
    return request.categories
      ? candidates.filter((item) => request.categories?.includes(item.category))
      : candidates;
  }

  async operate(
    context: ConnectorContext,
    request: DatabaseOperationRequest,
  ): Promise<DatabaseOperationResult> {
    const connected = this.#requireConnection(context.profile.id);
    const startedAt = new Date().toISOString();
    const operationId = randomUUID();
    let output: Record<string, PortableValue>;
    if (request.operation === 'cancel-query') {
      const jobId = readString(request.input, 'jobId');
      const job = await this.cancel(context, jobId);
      output = { jobId, state: job.state };
    } else if (request.operation === 'terminate-session') {
      const backendPid = readNumber(request.input, 'backendPid');
      const terminated = await this.#driver.terminateBackend(connected.connection.id, backendPid);
      output = { backendPid, terminated: unwrap(terminated, 'operate', context.profile.id) };
    } else if (request.operation === 'analyze-table' || request.operation === 'vacuum-table') {
      const schema = readString(request.input, 'schema');
      const table = readString(request.input, 'table');
      const maintained = await this.#driver.maintainTable(connected.connection.id, {
        operation: request.operation === 'analyze-table' ? 'analyze' : 'vacuum',
        schema,
        table,
      });
      const result = unwrap(maintained, 'operate', context.profile.id);
      output = { schema, table, elapsedMs: result.elapsedMs };
    } else {
      throw connectorNotFound(
        'OPERATION_UNSUPPORTED',
        `PostgreSQL operation is not supported: ${request.operation}`,
        'operate',
      );
    }
    return {
      operationId,
      operation: request.operation,
      status: 'succeeded',
      startedAt,
      completedAt: new Date().toISOString(),
      output,
    };
  }

  #config(
    profile: ConnectionProfile,
    context: ConnectorContext,
    endpointIndex: number,
    connectionId: string,
  ): DatabaseConnectionConfig {
    const endpoint = profile.endpoints[endpointIndex];
    if (!endpoint || endpoint.transport !== 'tcp') {
      throw connectorNotFound(
        'POSTGRES_TCP_REQUIRED',
        'PostgreSQL connector requires a TCP endpoint.',
        'connect',
      );
    }
    if (!endpoint.database) {
      throw connectorNotFound(
        'POSTGRES_DATABASE_REQUIRED',
        'PostgreSQL TCP endpoint requires a database name.',
        'connect',
      );
    }
    return {
      id: connectionId,
      name: profile.name,
      engine: 'postgres',
      host: endpoint.host,
      port: endpoint.port,
      database: endpoint.database,
      username: context.credential?.username ?? profile.principal ?? 'postgres',
      ...(context.credential?.password ? { password: context.credential.password } : {}),
      ...(endpoint.ssl !== undefined ? { ssl: endpoint.ssl } : {}),
      readOnly: profile.readOnly,
      ...(profile.pool?.max ? { maxClients: profile.pool.max } : {}),
      ...(profile.network?.connectTimeoutMs
        ? { connectionTimeoutMs: profile.network.connectTimeoutMs }
        : {}),
      ...(profile.network?.statementTimeoutMs
        ? { statementTimeoutMs: profile.network.statementTimeoutMs }
        : {}),
    };
  }

  #baseCapabilities(profile: ConnectionProfile): CapabilityProfile {
    const capabilities = structuredClone(this.manifest.capabilities);
    if (profile.readOnly) {
      capabilities[DATABASE_CAPABILITIES.SQL_WRITE] = descriptor(
        DATABASE_CAPABILITIES.SQL_WRITE,
        'unsupported',
        'Connection profile is read-only',
      );
      capabilities[DATABASE_CAPABILITIES.SQL_DDL] = descriptor(
        DATABASE_CAPABILITIES.SQL_DDL,
        'unsupported',
        'Connection profile is read-only',
      );
    }
    return {
      connectorId: this.manifest.id,
      engine: this.manifest.engine,
      connectionProfileId: profile.id,
      resolvedAt: new Date().toISOString(),
      capabilities,
    };
  }

  #baseResources(
    profile: ConnectionProfile,
    connected: ConnectedPostgres,
    observedAt: string,
  ): { resources: ResourceDescriptor[]; relations: ResourceRelation[] } {
    const endpoint = profile.endpoints[connected.endpointIndex];
    if (!endpoint || endpoint.transport !== 'tcp') {
      throw connectorNotFound('POSTGRES_TCP_REQUIRED', 'TCP endpoint is unavailable.', 'discover');
    }
    const source = {
      sourceId: `${this.manifest.id}:${profile.id}`,
      sourceType: 'connector' as const,
      connectorId: this.manifest.id,
      connectionProfileId: profile.id,
      observedAt,
    };
    const platformNative = `postgres://${endpoint.host}:${endpoint.port}`;
    const clusterNative = platformNative;
    const nodeNative = `${platformNative}/node/${connected.serverInfo.serverAddress ?? endpoint.host}:${connected.serverInfo.serverPort ?? endpoint.port}`;
    const databaseNative = connected.serverInfo.database;
    const resources: ResourceDescriptor[] = [
      this.#makeResource(
        profile,
        connected,
        'platform',
        platformNative,
        platformNative,
        'PostgreSQL',
        source,
        {
          host: endpoint.host,
          port: endpoint.port,
        },
      ),
      this.#makeResource(
        profile,
        connected,
        'cluster',
        clusterNative,
        clusterNative,
        profile.name,
        source,
        {
          engineVersion: connected.serverInfo.engineVersion,
          inRecovery: connected.serverInfo.inRecovery,
        },
      ),
      this.#makeResource(
        profile,
        connected,
        'node',
        nodeNative,
        nodeNative,
        endpoint.host,
        source,
        {
          host: connected.serverInfo.serverAddress ?? endpoint.host,
          port: connected.serverInfo.serverPort ?? endpoint.port,
          role: connected.serverInfo.inRecovery ? 'replica' : 'primary',
        },
      ),
      this.#makeResource(
        profile,
        connected,
        'database',
        databaseNative,
        databaseNative,
        databaseNative,
        source,
        { currentUser: connected.serverInfo.currentUser },
      ),
    ];
    const ids = Object.fromEntries(resources.map((resource) => [resource.kind, resource.id]));
    const relations = [
      createRelation('contains', ids.platform!, ids.cluster!, source, observedAt),
      createRelation('contains', ids.cluster!, ids.node!, source, observedAt),
      createRelation('contains', ids.cluster!, ids.database!, source, observedAt),
      createRelation('accessed_via', ids.database!, ids.node!, source, observedAt),
    ];
    return { resources, relations };
  }

  #catalogResource(
    profile: ConnectionProfile,
    connected: ConnectedPostgres,
    entry: PostgresCatalogEntry,
    source: ResourceDescriptor['sources'][number],
  ): ResourceDescriptor {
    return this.#makeResource(
      profile,
      connected,
      entry.kind,
      entry.nativeId,
      entry.canonicalName,
      entry.displayName,
      source,
      entry.attributes,
    );
  }

  #foreignKeyRelations(
    connected: ConnectedPostgres,
    entry: PostgresCatalogEntry,
    constraint: ResourceDescriptor,
    sourceTableId: string,
    source: ResourceRelation['sources'][number],
    observedAt: string,
  ): ResourceRelation[] {
    const referencedTableNativeId = entry.attributes.referencedTableNativeId;
    if (typeof referencedTableNativeId !== 'string') return [];
    const referencedTable = connected.nativeResources.get(referencedTableNativeId);
    if (!referencedTable) return [];

    const relations = [
      ...(sourceTableId === referencedTable.id
        ? []
        : [createRelation('references', sourceTableId, referencedTable.id, source, observedAt)]),
      createRelation('references', constraint.id, referencedTable.id, source, observedAt),
    ];
    const sourceColumns = portableStringArray(entry.attributes.sourceColumns);
    const targetColumns = portableStringArray(entry.attributes.targetColumns);
    for (let index = 0; index < sourceColumns.length; index += 1) {
      const sourceColumn = connected.nativeResources.get(
        `${entry.parentNativeId}.${sourceColumns[index]}`,
      );
      if (!sourceColumn) continue;
      const targetColumnName = targetColumns[index];
      const targetColumn = targetColumnName
        ? connected.nativeResources.get(`${referencedTableNativeId}.${targetColumnName}`)
        : undefined;
      const targetResourceId = targetColumn?.id ?? referencedTable.id;
      if (sourceColumn.id !== targetResourceId) {
        relations.push(
          createRelation('references', sourceColumn.id, targetResourceId, source, observedAt),
        );
      }
    }
    return relations;
  }

  #makeResource(
    profile: ConnectionProfile,
    connected: ConnectedPostgres,
    kind: string,
    nativeId: string,
    canonicalName: string,
    displayName: string,
    source: ResourceDescriptor['sources'][number],
    attributes: Record<string, PortableValue>,
  ): ResourceDescriptor {
    const id = this.#resourceId(profile, kind, nativeId);
    connected.nativeResources.set(nativeId, { id, kind });
    return {
      id,
      kind,
      nativeId,
      canonicalName,
      displayName,
      engine: 'postgres',
      engineVersion: connected.serverInfo.engineVersion,
      ...(profile.scope === undefined ? {} : { scope: structuredClone(profile.scope) }),
      attributes,
      version: 1,
      firstSeenAt: source.observedAt,
      updatedAt: source.observedAt,
      sources: [source],
    };
  }

  #resourceId(profile: ConnectionProfile, kind: string, nativeId: string): string {
    const endpoint = profile.endpoints[0];
    const endpointNamespace =
      endpoint?.transport === 'tcp'
        ? `postgres://${endpoint.host}:${endpoint.port}`
        : `postgres:${profile.id}`;
    const namespace =
      profile.scope === undefined
        ? endpointNamespace
        : `${stringifyPublicJson({
            tenantId: profile.scope.tenantId ?? null,
            organizationId: profile.scope.organizationId ?? null,
            projectId: profile.scope.projectId ?? null,
            environment: profile.scope.environment ?? null,
            region: profile.scope.region ?? null,
          })}\0${endpointNamespace}`;
    return createStableResourceId({ sourceNamespace: namespace, kind, nativeId });
  }

  async #runJob(
    internal: InternalQueryJob,
    connected: ConnectedPostgres,
    submission: QuerySubmission,
  ): Promise<void> {
    await Promise.resolve();
    if (internal.cancelRequested || internal.job.state === 'cancelled') return;
    const startedAt = new Date().toISOString();
    internal.job = {
      ...internal.job,
      state: 'running',
      progress: 0.1,
      startedAt,
    };
    const resultId = `result_${internal.job.id}`;
    let writer: DatabaseResultWriter | undefined;
    let streamedResult = false;
    let persistenceError: unknown;
    const expiresAt = new Date(Date.now() + this.#resultTtlMs).toISOString();
    const ensureWriter = async (
      columns: ResultHandle['columns'],
      completeResult: boolean,
    ): Promise<DatabaseResultWriter> => {
      if (writer) return writer;
      await this.#ensureResultStoreReady();
      writer = await this.#resultStore.create({
        resultId,
        jobId: internal.job.id,
        format: 'rows',
        columns,
        expiresAt,
        ...(completeResult ? { hasMore: false, truncated: false } : {}),
      });
      return writer;
    };
    const observer: QueryExecutionObserver = {
      onBackendPid: ({ backendPid }: { backendPid: number }) => {
        internal.backendPid = backendPid;
        internal.job = { ...internal.job, vendorQueryId: String(backendPid), progress: 0.25 };
        if (internal.cancelRequested) {
          void this.#driver.cancel(
            {
              queryId: internal.job.id,
              connectionId: connected.connection.id,
              decision: 'cancel-backend',
              backendPid,
              message: 'Deferred cancellation request.',
            },
            connected.connection,
          );
        }
      },
      ...(submission.batchSize === undefined ? {} : { resultBatchSize: submission.batchSize }),
      onResultBatch: async ({ columns, rows, ordinal }) => {
        streamedResult = true;
        try {
          const batchWriter = await ensureWriter(columns, true);
          const operationId = `query-result:${internal.job.id}:${ordinal}`;
          try {
            await batchWriter.append(rows, { operationId });
          } catch (error) {
            if (!isRecoverableAppendResponseLoss(error)) throw error;
            await batchWriter.append(rows, { operationId });
          }
        } catch (error) {
          persistenceError = error;
          throw error;
        }
      },
    };
    const request = {
      queryId: internal.job.id,
      connectionId: connected.connection.id,
      sql: submission.sql,
      ...(submission.params ? { params: submission.params } : {}),
      ...(submission.rowLimit ? { limit: submission.rowLimit } : {}),
      ...(submission.timeoutMs !== undefined ? { timeoutMs: submission.timeoutMs } : {}),
      ...(submission.dryRun ? { dryRun: submission.dryRun } : {}),
      ...(submission.confirmed !== undefined ? { confirmed: submission.confirmed } : {}),
      ...(submission.transactionMode ? { transactionMode: submission.transactionMode } : {}),
    };
    const enforceReadOnly = submission.authorization?.authorizedClass === 'query';
    const executionConnection = enforceReadOnly
      ? { ...connected.connection, readOnly: true }
      : connected.connection;
    let result: Awaited<ReturnType<PostgresConnectorDriver['execute']>>;
    try {
      result = submission.transactionId
        ? await this.#driver.executeInTransaction(submission.transactionId, request, observer, {
            enforceReadOnly,
          })
        : await this.#driver.execute(request, executionConnection, observer);
    } catch (error) {
      await this.#failResultPersistence(
        internal,
        resultId,
        writer,
        persistenceError ?? error,
      );
      return;
    }
    const completedAt = new Date().toISOString();
    if (!result.ok) {
      await this.#discardStagedResult(resultId, writer);
      const cancelled = result.error.code === 'QUERY_CANCELLED' || internal.cancelRequested;
      internal.job = {
        ...internal.job,
        state: cancelled ? 'cancelled' : 'failed',
        progress: 1,
        completedAt,
        error: toDatabaseError(
          result.error,
          cancelled ? 'cancel' : 'execute',
          internal.job.profileId,
          internal.job.id,
        ),
      };
      return;
    }
    let handle: ResultHandle | undefined;
    try {
      const resultWriter = writer ?? await ensureWriter(result.data.columns, false);
      if (!streamedResult) {
        await resultWriter.append(result.data.rows, {
          operationId: `query-result:${internal.job.id}:0`,
        });
      }
      handle = await resultWriter.commit();
    } catch (error) {
      try {
        handle = await this.#resultStore.getHandle(resultId);
      } catch {
        await writer?.abort().catch(() => undefined);
        await this.#resultStore.discardStaged(resultId).catch(() => undefined);
        await this.#resultStore.collectGarbage({
          stagedTtlMs: 0,
          tombstoneTtlMs: 0,
        }).catch(() => undefined);
        internal.job = {
          ...internal.job,
          state: 'failed',
          progress: 1,
          completedAt,
          error: resultPersistenceError(error, internal.job.profileId, internal.job.id),
        };
        return;
      }
    }
    if (!handle) {
      internal.job = {
        ...internal.job,
        state: 'failed',
        progress: 1,
        completedAt,
        error: resultPersistenceError(
          new Error('Result persistence did not return a handle.'),
          internal.job.profileId,
          internal.job.id,
        ),
      };
      return;
    }
    const byteCount = handle.byteCount ?? 0;
    this.#resultJobs.set(handle.id, internal.job.id);
    this.#retainedResultBytes += byteCount;
    internal.job = {
      ...internal.job,
      state: 'succeeded',
      progress: 1,
      completedAt,
      result: handle,
      safety: result.data.safety,
    };
    await this.#pruneRetainedResults();
  }

  async #failResultPersistence(
    internal: InternalQueryJob,
    resultId: string,
    writer: DatabaseResultWriter | undefined,
    error: unknown,
  ): Promise<void> {
    await this.#discardStagedResult(resultId, writer);
    internal.job = {
      ...internal.job,
      state: 'failed',
      progress: 1,
      completedAt: new Date().toISOString(),
      error: resultPersistenceError(error, internal.job.profileId, internal.job.id),
    };
  }

  async #discardStagedResult(
    resultId: string,
    writer: DatabaseResultWriter | undefined,
  ): Promise<void> {
    await writer?.abort().catch(() => undefined);
    await this.#resultStore.discardStaged(resultId).catch(() => undefined);
    await this.#resultStore.collectGarbage({
      stagedTtlMs: 0,
      tombstoneTtlMs: 0,
    }).catch(() => undefined);
  }

  async #pruneRetainedResults(): Promise<void> {
    const now = Date.now();
    let evicted = false;
    for (const [handleId, jobId] of this.#resultJobs) {
      const internal = this.#jobs.get(jobId);
      const expiresAt = internal?.job.result?.expiresAt;
      if (expiresAt && new Date(expiresAt).getTime() <= now) {
        await this.#evictResult(handleId, true, true, 'ttl');
        evicted = true;
      }
    }
    while (
      this.#resultJobs.size > this.#maxRetainedResults ||
      (this.#retainedResultBytes > this.#maxRetainedResultBytes &&
        this.#resultJobs.size > 1)
    ) {
      const oldest = this.#resultJobs.keys().next().value;
      if (!oldest) break;
      await this.#evictResult(oldest, false, true, 'capacity');
      evicted = true;
    }
    this.#pruneRetainedJobs();
    if (evicted) await this.#collectResultGarbage();
  }

  #ensureResultStoreReady(): Promise<void> {
    if (!this.#resultStoreReady) {
      const attempt = this.#collectResultGarbage().catch((error: unknown) => {
        if (this.#resultStoreReady === attempt) this.#resultStoreReady = undefined;
        throw error;
      });
      this.#resultStoreReady = attempt;
    }
    return this.#resultStoreReady;
  }

  async #collectReleasedResultGarbage(byteCount: number): Promise<void> {
    this.#releasedResultsSinceGc += 1;
    this.#releasedBytesSinceGc += byteCount;
    if (
      this.#releasedResultsSinceGc < RELEASED_RESULTS_BEFORE_GC &&
      this.#releasedBytesSinceGc < RELEASED_BYTES_BEFORE_GC
    ) return;
    await this.#collectResultGarbage({ stagedTtlMs: 0 });
  }

  async #collectResultGarbage(options = {}): Promise<void> {
    await this.#resultStore.collectGarbage(options);
    this.#releasedResultsSinceGc = 0;
    this.#releasedBytesSinceGc = 0;
  }

  async #evictResult(
    handleId: string,
    expired = false,
    persist = false,
    reason = 'released',
  ): Promise<boolean> {
    const jobId = this.#resultJobs.get(handleId);
    if (!jobId) return false;
    const internal = this.#jobs.get(jobId);
    if (persist) {
      const expiredInStore = await this.#resultStore.expire(handleId, reason);
      if (!expiredInStore) return false;
    }
    this.#resultJobs.delete(handleId);
    if (!internal) return true;
    const byteCount = internal.job.result?.byteCount ?? 0;
    this.#retainedResultBytes = Math.max(0, this.#retainedResultBytes - byteCount);
    const jobWithoutResult = { ...internal.job };
    delete jobWithoutResult.result;
    internal.job = expired
      ? { ...jobWithoutResult, state: 'expired' }
      : jobWithoutResult;
    return true;
  }

  #pruneRetainedJobs(): void {
    if (this.#jobs.size <= this.#maxRetainedJobs) return;
    for (const [jobId, internal] of this.#jobs) {
      if (this.#jobs.size <= this.#maxRetainedJobs) break;
      if (!isTerminal(internal.job.state) || internal.job.result) continue;
      this.#jobs.delete(jobId);
    }
  }

  async #purgeProfileQueries(profileId: string): Promise<void> {
    for (const [handleId, jobId] of this.#resultJobs) {
      if (this.#jobs.get(jobId)?.job.profileId === profileId) {
        await this.#evictResult(handleId);
      }
    }
    for (const [jobId, internal] of this.#jobs) {
      if (internal.job.profileId === profileId) this.#jobs.delete(jobId);
    }
  }

  #requireConnection(profileId: string): ConnectedPostgres {
    const connected = this.#connections.get(profileId);
    if (!connected) {
      throw connectorNotFound(
        'POSTGRES_NOT_CONNECTED',
        `PostgreSQL profile is not connected: ${profileId}`,
        'connect',
      );
    }
    return connected;
  }

  #requireJob(jobId: string): InternalQueryJob {
    const job = this.#jobs.get(jobId);
    if (!job)
      throw connectorNotFound(
        'QUERY_JOB_NOT_FOUND',
        `Query job was not found: ${jobId}`,
        'execute',
      );
    return job;
  }
}

export class PostgresConnectorError extends Error {
  constructor(readonly databaseError: DatabaseAccessError) {
    super(databaseError.message);
    this.name = 'PostgresConnectorError';
    Object.defineProperty(this, 'code', { value: databaseError.code, enumerable: true });
  }
}

function createPostgresManifest(): ConnectorManifest {
  const capabilities = Object.fromEntries(
    [
      DATABASE_CAPABILITIES.CONNECTION_POOLING,
      DATABASE_CAPABILITIES.CONNECTION_RECONNECT,
      DATABASE_CAPABILITIES.CONNECTION_MULTI_ENDPOINT,
      DATABASE_CAPABILITIES.SQL_QUERY,
      DATABASE_CAPABILITIES.SQL_PARAMETERS,
      DATABASE_CAPABILITIES.SQL_MULTI_STATEMENT,
      DATABASE_CAPABILITIES.TRANSACTION,
      DATABASE_CAPABILITIES.TRANSACTION_SAVEPOINT,
      DATABASE_CAPABILITIES.TRANSACTION_ISOLATION,
      DATABASE_CAPABILITIES.QUERY_ASYNC,
      DATABASE_CAPABILITIES.QUERY_PROGRESS,
      DATABASE_CAPABILITIES.QUERY_CANCEL,
      DATABASE_CAPABILITIES.QUERY_RESULT_RESUME,
      DATABASE_CAPABILITIES.EXPLAIN,
      DATABASE_CAPABILITIES.EXPLAIN_ANALYZE,
      DATABASE_CAPABILITIES.METADATA_CATALOG,
      DATABASE_CAPABILITIES.METADATA_SCHEMA,
      DATABASE_CAPABILITIES.METADATA_OBJECTS,
      DATABASE_CAPABILITIES.METADATA_PRIVILEGES,
      DATABASE_CAPABILITIES.METADATA_DEPENDENCIES,
      DATABASE_CAPABILITIES.OBSERVE_SESSIONS,
      DATABASE_CAPABILITIES.OBSERVE_QUERIES,
      DATABASE_CAPABILITIES.OBSERVE_LOCKS,
      DATABASE_CAPABILITIES.OBSERVE_CAPACITY,
      DATABASE_CAPABILITIES.OBSERVE_REPLICATION,
      DATABASE_CAPABILITIES.OPERATE_CANCEL_QUERY,
      DATABASE_CAPABILITIES.OPERATE_ANALYZE,
      DATABASE_CAPABILITIES.RESULT_PAGINATION,
      DATABASE_CAPABILITIES.RESULT_STREAMING,
    ].map((key) => [key, descriptor(key, 'supported')]),
  );
  for (const [key, reason] of [
    [
      DATABASE_CAPABILITIES.SQL_WRITE,
      'Depends on profile mode, role permission and safety approval',
    ],
    [DATABASE_CAPABILITIES.SQL_DDL, 'Depends on profile mode, role permission and safety approval'],
    [
      DATABASE_CAPABILITIES.OPERATE_TERMINATE_SESSION,
      'Requires an admin profile and PostgreSQL permission',
    ],
    [
      DATABASE_CAPABILITIES.OPERATE_VACUUM,
      'Requires an admin writable profile and PostgreSQL permission',
    ],
  ] as const) {
    capabilities[key] = descriptor(key, 'conditional', reason);
  }
  for (const [key, reason] of [
    [
      DATABASE_CAPABILITIES.DRY_RUN,
      'Use rollback transaction preview instead of a vendor dry-run API',
    ],
    [DATABASE_CAPABILITIES.METADATA_INCREMENTAL, 'This connector currently uses paged snapshots'],
    [DATABASE_CAPABILITIES.RESULT_ARROW, 'Row batches are implemented; Arrow is not implemented'],
    [DATABASE_CAPABILITIES.RESULT_DOWNLOAD, 'Managed result downloads are not implemented'],
  ] as const) {
    capabilities[key] = descriptor(key, 'unsupported', reason);
  }
  return {
    id: POSTGRES_CONNECTOR_ID,
    displayName: 'PostgreSQL Native Connector',
    version: '1.0.0',
    engine: 'postgres',
    transports: ['tcp'],
    execution: 'hybrid',
    dialect: {
      id: 'postgresql',
      engine: 'postgres',
      identifierQuote: '"',
      parameterStyle: 'numbered',
      supportsCatalogs: false,
      supportsSchemas: true,
      pagination: 'limit-offset',
      features: {
        cte: 'supported',
        windowFunctions: 'supported',
        arrays: 'supported',
        json: 'supported',
        returning: 'supported',
      },
    },
    capabilities,
    operations: [
      {
        key: 'cancel-query',
        title: 'Cancel query',
        description: 'Cancel a SchemaNaut PostgreSQL query job.',
        risk: 'write',
        idempotent: true,
        requiredCapability: DATABASE_CAPABILITIES.OPERATE_CANCEL_QUERY,
      },
      {
        key: 'terminate-session',
        title: 'Terminate session',
        description: 'Terminate one PostgreSQL backend process.',
        risk: 'dangerous',
        idempotent: true,
        requiredCapability: DATABASE_CAPABILITIES.OPERATE_TERMINATE_SESSION,
      },
      {
        key: 'analyze-table',
        title: 'Analyze table',
        description: 'Refresh PostgreSQL planner statistics for one table.',
        risk: 'write',
        idempotent: true,
        requiredCapability: DATABASE_CAPABILITIES.OPERATE_ANALYZE,
      },
      {
        key: 'vacuum-table',
        title: 'Vacuum table',
        description: 'Vacuum one PostgreSQL table.',
        risk: 'write',
        idempotent: true,
        requiredCapability: DATABASE_CAPABILITIES.OPERATE_VACUUM,
      },
    ],
    verifiedAgainst: [
      {
        verifiedAt: new Date().toISOString(),
        scope: 'contract',
      },
    ],
  };
}

function positiveRetentionOption(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function descriptor(
  key: string,
  status: CapabilityDescriptor['status'],
  reason?: string,
): CapabilityDescriptor {
  return {
    key,
    status,
    source: `${POSTGRES_CONNECTOR_ID}:manifest`,
    observedAt: new Date().toISOString(),
    ...(reason ? { reason } : {}),
  };
}

function capabilityInput(
  key: string,
  status: CapabilityDescriptor['status'],
  reason?: string,
  constraints?: CapabilityDescriptor['constraints'],
): Omit<CapabilityDescriptor, 'source' | 'observedAt'> {
  return {
    key,
    status,
    ...(reason ? { reason } : {}),
    ...(constraints ? { constraints } : {}),
  };
}

function stripRuntimeCapabilityFields(
  capabilities: Record<string, CapabilityDescriptor>,
): Record<string, Omit<CapabilityDescriptor, 'source' | 'observedAt'> & { observedAt?: string }> {
  return Object.fromEntries(
    Object.entries(capabilities).map(([key, item]) => {
      const { source, observedAt, ...rest } = item;
      void source;
      return [key, { ...rest, observedAt }];
    }),
  );
}

function createRelation(
  kind: string,
  fromResourceId: string,
  toResourceId: string,
  source: ResourceRelation['sources'][number],
  observedAt: string,
): ResourceRelation {
  return {
    id: createStableRelationId({ kind, fromResourceId, toResourceId }),
    kind,
    fromResourceId,
    toResourceId,
    version: 1,
    firstSeenAt: observedAt,
    updatedAt: observedAt,
    sources: [source],
  };
}

function portableStringArray(value: PortableValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function encodeOffset(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

function decodeOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  const offset = Number.parseInt(Buffer.from(cursor, 'base64url').toString('utf8'), 10);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw connectorNotFound('CURSOR_INVALID', 'Cursor is invalid.', 'result');
  }
  return offset;
}

function toDatabaseError(
  error: AppError,
  stage: NonNullable<DatabaseAccessError['stage']>,
  profileId: string,
  jobId?: string,
): DatabaseAccessError {
  const category = appErrorCategory(error.code);
  return {
    code: error.code,
    category,
    message: error.message,
    ...(error.detail ? { detail: error.detail } : {}),
    stage,
    profileId,
    ...(jobId ? { jobId } : {}),
    retryable: error.retryable ?? false,
    outcome:
      stage === 'execute' &&
      !['VALIDATION_ERROR', 'READ_ONLY_VIOLATION', 'CONFIRMATION_REQUIRED'].includes(error.code)
        ? 'unknown'
        : 'unchanged',
  };
}

function appErrorCategory(code: AppError['code']): DatabaseAccessError['category'] {
  if (code === 'DB_AUTH_FAILED') return 'authentication';
  if (code === 'PERMISSION_DENIED' || code === 'READ_ONLY_VIOLATION') return 'authorization';
  if (code === 'DB_CONNECTION_TIMEOUT') return 'timeout';
  if (code === 'QUERY_TIMEOUT') return 'timeout';
  if (code === 'QUERY_CANCELLED') return 'cancelled';
  if (code === 'VALIDATION_ERROR' || code === 'CONFIRMATION_REQUIRED') return 'validation';
  if (code === 'NOT_FOUND') return 'not-found';
  if (code === 'UNSUPPORTED_OPERATION') return 'unsupported';
  if (code.startsWith('DB_') || code === 'CONNECTION_FAILED') return 'network';
  return 'provider';
}

function connectorNotFound(
  code: string,
  message: string,
  stage: NonNullable<DatabaseAccessError['stage']>,
): PostgresConnectorError {
  return new PostgresConnectorError({
    code,
    category: code.includes('NOT_FOUND') ? 'not-found' : 'validation',
    message,
    stage,
    retryable: false,
    outcome: 'unchanged',
  });
}

function resultStoreConnectorError(
  error: DatabaseResultStoreError,
  handleId: string,
): PostgresConnectorError {
  const classification: Record<
    DatabaseResultStoreError['code'],
    { code: string; category: DatabaseAccessError['category']; retryable?: boolean }
  > = {
    NOT_FOUND: { code: 'RESULT_NOT_FOUND', category: 'not-found' },
    NOT_COMMITTED: { code: 'RESULT_NOT_COMMITTED', category: 'conflict' },
    EXPIRED: { code: 'RESULT_EXPIRED', category: 'not-found' },
    CORRUPT: { code: 'RESULT_CORRUPT', category: 'provider' },
    CURSOR_INVALID: { code: 'CURSOR_INVALID', category: 'validation' },
    INVALID_ARGUMENT: { code: 'RESULT_REQUEST_INVALID', category: 'validation' },
    CONFLICT: { code: 'RESULT_CONFLICT', category: 'conflict' },
    UNSUPPORTED_SCHEMA: {
      code: 'RESULT_STORE_SCHEMA_UNSUPPORTED',
      category: 'unsupported',
    },
    STORAGE_FAILURE: { code: 'STORAGE_FAILURE', category: 'internal', retryable: true },
    INJECTED_CRASH: { code: 'STORAGE_FAILURE', category: 'internal', retryable: true },
  };
  const mapped = classification[error.code];
  return new PostgresConnectorError({
    code: mapped.code,
    category: mapped.category,
    message: `${error.message} (${handleId})`,
    stage: 'result',
    retryable: mapped.retryable ?? false,
    outcome: 'unchanged',
  });
}

function resultPersistenceError(
  error: unknown,
  profileId: string,
  jobId: string,
): DatabaseAccessError {
  if (error instanceof DatabaseResultStoreError) {
    const mapped = resultStoreConnectorError(error, `result_${jobId}`).databaseError;
    return {
      ...mapped,
      profileId,
      jobId,
      outcome: 'unknown',
    };
  }
  return {
    code: 'STORAGE_FAILURE',
    category: 'internal',
    message: error instanceof Error ? error.message : String(error),
    stage: 'result',
    profileId,
    jobId,
    retryable: true,
    outcome: 'unknown',
  };
}

function isRecoverableAppendResponseLoss(error: unknown): boolean {
  return error instanceof DatabaseResultStoreError && error.code === 'INJECTED_CRASH';
}

function unwrap<T>(
  result: { ok: true; data: T } | { ok: false; error: AppError },
  stage: NonNullable<DatabaseAccessError['stage']>,
  profileId: string,
): T {
  if (result.ok) return result.data;
  throw new PostgresConnectorError(toDatabaseError(result.error, stage, profileId));
}

function isTerminal(state: QueryJob['state']): boolean {
  return ['succeeded', 'failed', 'cancelled', 'expired'].includes(state);
}

function readString(input: Record<string, PortableValue> | undefined, key: string): string {
  const value = input?.[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw connectorNotFound(
      'OPERATION_INPUT_INVALID',
      `${key} must be a non-empty string.`,
      'operate',
    );
  }
  return value;
}

function readNumber(input: Record<string, PortableValue> | undefined, key: string): number {
  const value = input?.[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw connectorNotFound('OPERATION_INPUT_INVALID', `${key} must be a number.`, 'operate');
  }
  return value;
}

function cloneDatabaseRow(row: QueryResultRow): QueryResultRow {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, cloneDatabaseValue(value)]),
  );
}

function cloneDatabaseValue(value: DbColumnValue): DbColumnValue {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map((item) => cloneDatabaseValue(item));
  if (value && typeof value === 'object') return cloneDatabaseRow(value);
  return value;
}

function isPostgresBinaryColumn(
  column: ResultHandle['columns'][number],
): boolean {
  return [column.dataType, column.nativeType]
    .some((type) => type?.trim().toLowerCase() === 'bytea');
}

function restorePostgresResultRow(
  row: QueryResultRow,
  binaryColumns: ReadonlySet<string>,
): QueryResultRow {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    binaryColumns.has(key) && value instanceof Uint8Array
      ? Buffer.from(value)
      : cloneDatabaseValue(value),
  ]));
}
