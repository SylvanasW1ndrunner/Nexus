import { randomUUID } from 'node:crypto';
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
  QueryExecutionResult,
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
import { CapabilityResolver, DATABASE_CAPABILITIES } from './capability-resolver.js';
import type {
  ConnectorContext,
  ConnectorManifest,
  DatabaseConnector,
  DiscoveryRequest,
  TransactionOptions,
} from './connector.js';
import type { DatabaseConnectionConfig } from './types.js';
import {
  PostgresDriver,
  type PostgresCatalogEntry,
  type PostgresServerInfo,
} from './postgres-driver.js';
import {
  createResourceObservation,
  createStableRelationId,
  createStableResourceId,
} from '@dbagent/core-resource';

const RESULT_TTL_MS = 60 * 60 * 1_000;
const DEFAULT_DISCOVERY_PAGE_SIZE = 500;
const DEFAULT_RESULT_PAGE_SIZE = 1_000;
const MAX_RESULT_PAGE_SIZE = 10_000;

type ConnectedPostgres = {
  session: ConnectionSession;
  connection: SavedConnection;
  serverInfo: PostgresServerInfo;
  endpointIndex: number;
  nativeResources: Map<string, { id: string; kind: string }>;
};

type InternalQueryJob = {
  job: QueryJob;
  result?: QueryExecutionResult;
  backendPid?: number;
  cancelRequested: boolean;
  execution?: Promise<void>;
};

export class PostgresConnector implements DatabaseConnector {
  readonly manifest: ConnectorManifest;
  readonly #driver: PostgresDriver;
  readonly #capabilityResolver = new CapabilityResolver();
  readonly #connections = new Map<string, ConnectedPostgres>();
  readonly #jobs = new Map<string, InternalQueryJob>();
  readonly #resultJobs = new Map<string, string>();

  constructor(driver = new PostgresDriver()) {
    this.#driver = driver;
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
      throw new PostgresConnectorError(toDatabaseError(result.error, 'connect', context.profile.id));
    }
    this.#connections.delete(context.profile.id);
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
    return Promise.resolve(this.#capabilityResolver.resolve({
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
    }));
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
      relations.push(
        createRelation('contains', parent.id, resource.id, source, observedAt),
      );
      if (entry.kind === 'constraint') {
        relations.push(
          ...this.#foreignKeyRelations(
            connected,
            entry,
            resource,
            parent.id,
            source,
            observedAt,
          ),
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
        throw new PostgresConnectorError(toDatabaseError(cancelled.error, 'cancel', context.profile.id, jobId));
      }
    }
    return structuredClone(internal.job);
  }

  readResult(
    _context: ConnectorContext,
    handleId: string,
    input: { cursor?: string; limit?: number } = {},
  ): Promise<ResultBatch> {
    const jobId = this.#resultJobs.get(handleId);
    const internal = jobId ? this.#jobs.get(jobId) : undefined;
    if (!internal?.job.result || !internal.result) {
      throw connectorNotFound('RESULT_NOT_FOUND', `Result handle was not found: ${handleId}`, 'result');
    }
    if (
      internal.job.result.expiresAt &&
      new Date(internal.job.result.expiresAt).getTime() <= Date.now()
    ) {
      internal.job = { ...internal.job, state: 'expired' };
      throw connectorNotFound('RESULT_EXPIRED', `Result handle expired: ${handleId}`, 'result');
    }
    const offset = decodeOffset(input.cursor);
    const limit = Math.min(
      Math.max(input.limit ?? DEFAULT_RESULT_PAGE_SIZE, 1),
      MAX_RESULT_PAGE_SIZE,
    );
    const rows = internal.result.rows.slice(offset, offset + limit);
    const nextOffset = offset + rows.length;
    const complete = nextOffset >= internal.result.rows.length;
    return Promise.resolve({
      handleId,
      rows: rows.map(cloneDatabaseRow),
      rowOffset: offset,
      complete,
      byteCount: Buffer.byteLength(JSON.stringify(rows)),
      ...(!complete ? { nextCursor: encodeOffset(nextOffset) } : {}),
    });
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
      throw new PostgresConnectorError(toDatabaseError(snapshot.error, 'observe', context.profile.id));
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
        status:
          (snapshot.data.maximumReplayLagSeconds ?? 0) > 30 ? 'degraded' : 'healthy',
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

  get legacyDriver(): PostgresDriver {
    return this.#driver;
  }

  getLegacyConnection(profileId: string): SavedConnection | undefined {
    const connection = this.#connections.get(profileId)?.connection;
    return connection ? structuredClone(connection) : undefined;
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
      this.#makeResource(profile, connected, 'platform', platformNative, platformNative, 'PostgreSQL', source, {
        host: endpoint.host,
        port: endpoint.port,
      }),
      this.#makeResource(profile, connected, 'cluster', clusterNative, clusterNative, profile.name, source, {
        engineVersion: connected.serverInfo.engineVersion,
        inRecovery: connected.serverInfo.inRecovery,
      }),
      this.#makeResource(profile, connected, 'node', nodeNative, nodeNative, endpoint.host, source, {
        host: connected.serverInfo.serverAddress ?? endpoint.host,
        port: connected.serverInfo.serverPort ?? endpoint.port,
        role: connected.serverInfo.inRecovery ? 'replica' : 'primary',
      }),
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
          createRelation(
            'references',
            sourceColumn.id,
            targetResourceId,
            source,
            observedAt,
          ),
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
      attributes,
      version: 1,
      firstSeenAt: source.observedAt,
      updatedAt: source.observedAt,
      sources: [source],
    };
  }

  #resourceId(profile: ConnectionProfile, kind: string, nativeId: string): string {
    const endpoint = profile.endpoints[0];
    const namespace =
      endpoint?.transport === 'tcp'
        ? `postgres://${endpoint.host}:${endpoint.port}`
        : `postgres:${profile.id}`;
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
    const observer = {
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
    const result = submission.transactionId
      ? await this.#driver.executeInTransaction(submission.transactionId, request, observer)
      : await this.#driver.execute(request, connected.connection, observer);
    const completedAt = new Date().toISOString();
    if (!result.ok) {
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
    internal.result = result.data;
    const handle: ResultHandle = {
      id: randomUUID(),
      jobId: internal.job.id,
      format: 'rows',
      columns: result.data.columns,
      rowCount: result.data.returnedRowCount ?? result.data.rows.length,
      byteCount: Buffer.byteLength(JSON.stringify(result.data.rows)),
      expiresAt: new Date(Date.now() + RESULT_TTL_MS).toISOString(),
      ...(result.data.hasMore !== undefined ? { hasMore: result.data.hasMore } : {}),
      ...(result.data.truncated !== undefined ? { truncated: result.data.truncated } : {}),
    };
    this.#resultJobs.set(handle.id, internal.job.id);
    internal.job = {
      ...internal.job,
      state: 'succeeded',
      progress: 1,
      completedAt,
      result: handle,
      safety: result.data.safety,
    };
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
    if (!job) throw connectorNotFound('QUERY_JOB_NOT_FOUND', `Query job was not found: ${jobId}`, 'execute');
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
    [DATABASE_CAPABILITIES.SQL_WRITE, 'Depends on profile mode, role permission and safety approval'],
    [DATABASE_CAPABILITIES.SQL_DDL, 'Depends on profile mode, role permission and safety approval'],
    [DATABASE_CAPABILITIES.OPERATE_TERMINATE_SESSION, 'Requires an admin profile and PostgreSQL permission'],
    [DATABASE_CAPABILITIES.OPERATE_VACUUM, 'Requires an admin writable profile and PostgreSQL permission'],
  ] as const) {
    capabilities[key] = descriptor(key, 'conditional', reason);
  }
  for (const [key, reason] of [
    [DATABASE_CAPABILITIES.DRY_RUN, 'Use rollback transaction preview instead of a vendor dry-run API'],
    [DATABASE_CAPABILITIES.METADATA_INCREMENTAL, 'This connector currently uses paged snapshots'],
    [DATABASE_CAPABILITIES.RESULT_ARROW, 'Row batches are implemented; Arrow is not implemented'],
    [DATABASE_CAPABILITIES.RESULT_DOWNLOAD, 'Managed result downloads are not implemented'],
  ] as const) {
    capabilities[key] = descriptor(key, 'unsupported', reason);
  }
  return {
    id: 'postgres-native',
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
        description: 'Cancel a DBAgent PostgreSQL query job.',
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

function descriptor(
  key: string,
  status: CapabilityDescriptor['status'],
  reason?: string,
): CapabilityDescriptor {
  return {
    key,
    status,
    source: 'postgres-native:manifest',
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
): Record<
  string,
  Omit<CapabilityDescriptor, 'source' | 'observedAt'> & { observedAt?: string }
> {
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
      stage === 'execute' && !['VALIDATION_ERROR', 'READ_ONLY_VIOLATION', 'CONFIRMATION_REQUIRED'].includes(error.code)
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
    throw connectorNotFound('OPERATION_INPUT_INVALID', `${key} must be a non-empty string.`, 'operate');
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
