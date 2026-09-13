import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AgentCapabilityModuleRegistration,
  type AgentCapabilityModuleRuntime,
  type AgentCapabilityLifecycleContext,
  type AgentCapabilityProbeResult,
  type ToolRetainedResultContent,
} from '@dbagent/core-agent';
import {
  ConnectorRegistry,
  DatabaseAccessRuntime,
  DatabaseAccessRuntimeError,
  type DatabaseResultStore,
  ProjectDatabaseResultStore,
  PostgresConnector,
  PostgresDriver,
  analyzeSqlSafety,
} from '@dbagent/core-db';
import { ResourceRegistry } from '@dbagent/core-resource';
import { LlmProviderError, type LlmChatRequest, type LlmGenerationConfig } from '@dbagent/core-llm';
import {
  ProgressiveSchemaRagIndexer,
  SchemaRagEngine,
  SchemaRagSnapshotStore,
} from '@dbagent/core-rag';
import type { SkillDirectorySource } from '@dbagent/core-skills';
import {
  type ActiveDatabaseBinding,
  type AiSqlQueryExecutionInput,
  type AiSqlQueryExecution,
  type AiSqlResultContentInput,
} from './ai-sql-tools.js';
import {
  stringifyPublicJson,
  assertPortableValue,
  type ConnectionProfile,
  type ConnectionSession,
  type QueryExecutionResult,
  type QueryJob,
  type ResultHandle,
  type QuerySafetyReport,
  type ResourceDescriptor,
  type ResourceRelation,
  type ResourceScope,
  type SavedConnection,
  type PortableValue,
} from '@dbagent/shared';
import { DatabaseCapabilityError, asDatabaseCapabilityError } from './errors.js';
import {
  ActiveBindingReadWriteGate,
  type ActiveBindingGateRelease,
} from './active-binding-gate.js';
import { parseGeneratedSqlResponse } from './parse-generation.js';
import { SqlRunStore } from './sql-run-store.js';
import type { DatabaseCapabilityHostPort } from './host-port.js';
import { createDatabaseToolGeneration } from './tool-generation.js';
import type {
  ConnectionCandidate,
  DatabaseCapabilityOptions,
  EphemeralConnectionBinding,
  ExecuteGeneratedOptions,
  ExecutedSqlRun,
  GenerateSqlInput,
  GeneratedSqlEvidence,
  GeneratedSqlRun,
  IndexSchemaOptions,
  DatabaseCapabilityStatus,
  ExternalConnectionProvider,
  ExternalConnectionProfile,
  SchemaIndexSnapshot,
  SqlRunSnapshot,
} from './types.js';

export const DATABASE_CAPABILITY_MODULE_ID = 'schemanaut.database';
export const DATABASE_CAPABILITY_INSTANCE_ID = 'primary';
const DATABASE_CAPABILITY_MODULE_REVISION = '1.0.0';

const DEFAULT_ROW_LIMIT = 200;
const MAX_ROW_LIMIT = 1_000;
const DEFAULT_MAX_SCHEMA_TABLES = 200;
const MAX_SCHEMA_TABLES = 1_000;
const DEFAULT_CONTEXT_CHARS = 8_000;
const MAX_CONTEXT_CHARS = 20_000;
const MAX_QUESTION_CHARS = 4_000;
const DEFAULT_SCHEMA_FRESHNESS_INTERVAL_MS = 30_000;
const MAX_SCHEMA_FRESHNESS_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const SCHEMA_MISS_REFRESH_DEBOUNCE_MS = 5_000;
const DATABASE_JOB_POLL_INTERVAL_MS = 10;
const DATABASE_JOB_SETTLE_TIMEOUT_MS = 1_000;
const EXECUTABLE_STATEMENT_KINDS = new Set(['SELECT', 'WITH', 'VALUES']);
const MAX_EXTERNAL_CONNECTION_CANDIDATES = 20;
const MAX_EXTERNAL_TEXT_CHARS = 500;
const MAX_EXTERNAL_METADATA_FIELDS = 16;

export type ValidatedDatabaseCapabilityOptions = Readonly<{
  defaultRowLimit: number;
  schemaFreshnessIntervalMs: number;
}>;

/**
 * Synchronous database-Capability option validation shared by the public
 * composition factory and the resource owner. Keeping it independent of an
 * AgentRuntime lets a failed database configuration leave no host resources
 * to unwind asynchronously.
 */
export function validateDatabaseCapabilityOptions(
  options: DatabaseCapabilityOptions = {},
): ValidatedDatabaseCapabilityOptions {
  if (
    options.schemaSnapshotDirectory !== undefined &&
    (typeof options.schemaSnapshotDirectory !== 'string' || !options.schemaSnapshotDirectory.trim())
  ) {
    throw new TypeError('schemaSnapshotDirectory must not be blank');
  }
  if (options.postgresDriver !== undefined && options.createPostgresDriver !== undefined) {
    throw new TypeError('Specify either postgresDriver or createPostgresDriver, not both.');
  }
  if (
    options.databaseAccess !== undefined &&
    (options.postgresDriver !== undefined || options.createPostgresDriver !== undefined)
  ) {
    throw new TypeError(
      'postgresDriver and createPostgresDriver cannot be used with an injected databaseAccess runtime.',
    );
  }
  return {
    defaultRowLimit: normalizeInteger(
      options.defaultRowLimit ?? DEFAULT_ROW_LIMIT,
      'defaultRowLimit',
      1,
      MAX_ROW_LIMIT,
    ),
    schemaFreshnessIntervalMs: normalizeInteger(
      options.schemaFreshnessIntervalMs ?? DEFAULT_SCHEMA_FRESHNESS_INTERVAL_MS,
      'schemaFreshnessIntervalMs',
      0,
      MAX_SCHEMA_FRESHNESS_INTERVAL_MS,
    ),
  };
}

type DatabaseCapabilityResources = {
  rag: SchemaRagEngine;
  database: DatabaseAccessRuntime;
  resources: ResourceRegistry;
  ragIndexer: ProgressiveSchemaRagIndexer;
  sqlRuns: SqlRunStore;
  ownsSqlRunStore: boolean;
};

async function* databaseResultNdjson(
  store: DatabaseResultStore,
  handle: ResultHandle,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  assertResultStreamActive(signal);
  yield encoder.encode(`${stringifyPublicJson({
    type: 'database-result',
    resultId: handle.id,
    format: handle.format,
    columns: handle.columns.map((column) => ({
      name: column.name,
      ...(column.dataType === undefined ? {} : { dataType: column.dataType }),
    })),
    ...(handle.rowCount === undefined ? {} : { rowCount: handle.rowCount }),
    ...(handle.hasMore === undefined ? {} : { hasMore: handle.hasMore }),
    ...(handle.truncated === undefined ? {} : { truncated: handle.truncated }),
  })}\n`);
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    assertResultStreamActive(signal);
    const page = await store.page(handle.id, {
      ...(cursor === undefined ? {} : { cursor }),
      limit: 500,
    });
    if (page.handleId !== handle.id) {
      throw new DatabaseCapabilityError(
        'QUERY_FAILED',
        'The database result page belongs to a different result identity.',
        false,
      );
    }
    for (const row of page.rows) {
      assertResultStreamActive(signal);
      yield encoder.encode(`${stringifyPublicJson({ type: 'row', row })}\n`);
    }
    if (page.complete) return;
    if (page.nextCursor === undefined || seen.has(page.nextCursor)) {
      throw new DatabaseCapabilityError(
        'QUERY_FAILED',
        'The database result store returned an invalid cursor.',
        false,
      );
    }
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
}

function assertResultStreamActive(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DatabaseCapabilityError('ABORTED', 'Database result retention was cancelled.', false);
  }
}

function databaseSkillSource(): SkillDirectorySource {
  const runtimeDirectory = dirname(fileURLToPath(import.meta.url));
  const bundledDirectory = resolve(runtimeDirectory, 'skills');
  return {
    id: 'database-system-skills',
    scope: 'system',
    path: existsSync(bundledDirectory) ? bundledDirectory : resolve(runtimeDirectory, '..', 'skills'),
  };
}

/**
 * The first production professional Capability module. Database state and all
 * database-specific decisions stay behind this boundary; the Agent kernel
 * sees only the generic Module contract and contributed tools/state.
 */
export class DatabaseCapabilityModule {
  private readonly host: DatabaseCapabilityHostPort;
  readonly registration: AgentCapabilityModuleRegistration;

  private resourcesState: DatabaseCapabilityResources | undefined;
  private readonly options: DatabaseCapabilityOptions;
  private readonly createRunId: () => string;
  private readonly now: () => string;
  private readonly defaultRowLimit: number;
  private readonly tenantId: string;
  private readonly resourceScope: ResourceScope;
  private readonly schemaFreshnessIntervalMs: number;
  private readonly connectionProvider: ExternalConnectionProvider | undefined;
  /** Provider selection belongs to this ephemeral module lifetime only. */
  private activeExternalBinding: Readonly<{
    providerId: string;
    candidateId: string;
    fingerprint: string;
  }> | undefined;
  /**
   * Keeps immutable Tool generations attached to the physical connection they
   * captured. Queries may share a generation concurrently; a connection
   * transition is exclusive and cannot cross an in-flight database action.
   */
  private readonly activeBindingGate = new ActiveBindingReadWriteGate();
  /** Synchronously fences new readers as soon as a lifecycle write is queued. */
  private pendingActiveBindingWrites = 0;
  private profileId: string | undefined;
  private connection: SavedConnection | undefined;
  private ownsActiveProfile = false;
  private indexTruncated = false;
  private lastIndexMaxTables = DEFAULT_MAX_SCHEMA_TABLES;
  private schemaFreshnessPromise: Promise<void> | undefined;
  private schemaFreshnessPromiseBinding: string | undefined;
  private schemaFreshnessBinding: string | undefined;
  /** A fresh index exists locally but its matching Tool generation is not published yet. */
  private schemaPublicationPending = false;
  private schemaPublicationPromise: Promise<void> | undefined;
  private schemaPublicationPromiseBinding: string | undefined;
  private lastSchemaFreshnessCheckAt = 0;
  private lastForcedSchemaRefreshAt = 0;
  /** A physical reconnect completed, but the matching Tool generation is not published yet. */
  private contributionPublicationPending = false;
  /** A query job whose cancellation state is unknown fences this binding until reconnect. */
  private isolatedBindingKey: string | undefined;
  private runtimeGeneration = 0;
  private sqlRunStoreClosed = false;
  private closedSqlRunCount = 0;
  private disposed = false;
  private disposeOperation: Promise<void> | undefined;
  private initializingResources = false;

  constructor(
    host: DatabaseCapabilityHostPort,
    options: DatabaseCapabilityOptions = {},
  ) {
    this.options = options;
    const validatedOptions = validateDatabaseCapabilityOptions(options);
    this.createRunId = options.createRunId ?? randomUUID;
    this.now = options.now ?? (() => new Date().toISOString());
    this.defaultRowLimit = validatedOptions.defaultRowLimit;
    this.schemaFreshnessIntervalMs = validatedOptions.schemaFreshnessIntervalMs;
    this.connectionProvider = options.connectionProvider;
    this.host = host;
    const project = this.host.project;
    this.tenantId = project.tenantId;
    this.resourceScope = {
      tenantId: this.tenantId,
      projectId: project.projectId,
    };

    this.registration = {
      manifest: {
        id: DATABASE_CAPABILITY_MODULE_ID,
        version: DATABASE_CAPABILITY_MODULE_REVISION,
        description:
          'Relational database connection, SQL execution, Schema knowledge retrieval, and query results',
        capabilities: [
          { id: 'database.query', description: 'Execute and explain SQL on an active database' },
          {
            id: 'database.schema',
            description: 'Retrieve indexed database Schema and business knowledge',
          },
        ],
      },
      instanceId: DATABASE_CAPABILITY_INSTANCE_ID,
      dispose: () => this.dispose(),
      load: () => ({
        probe: async (context) => await this.probe(context),
        activate: async (context) => await this.activateAutomatic(context),
        resolve: async (candidateId, context) => await this.resolveCandidate(candidateId, context),
        refresh: async (_current, context) => await this.refreshExternalBinding(context),
        dispose: () => this.dispose(),
      }),
    };
  }

  private get rag(): SchemaRagEngine { return this.ensureResources().rag; }
  private get database(): DatabaseAccessRuntime { return this.ensureResources().database; }
  private get resources(): ResourceRegistry { return this.ensureResources().resources; }

  private ensureResources(): DatabaseCapabilityResources {
    if (this.disposed) {
      throw new DatabaseCapabilityError('NOT_CONFIGURED', 'The database Capability is closed.', false);
    }
    if (this.resourcesState) return this.resourcesState;
    if (this.initializingResources) {
      throw new DatabaseCapabilityError(
        'NOT_CONFIGURED',
        'Database Capability initialization cannot re-enter before it completes.',
        true,
      );
    }

    this.initializingResources = true;
    let sqlRuns: SqlRunStore | undefined;
    let ownsSqlRunStore = false;
    try {
      const options = this.options;
      const project = this.host.project;
      const databaseResultStore =
        options.databaseResultStore ??
        options.databaseAccess?.resultStore ??
        new ProjectDatabaseResultStore({
          projectId: project.projectId,
          rootDir: join(project.configDirectory, 'database-results'),
        });
      const rag = options.rag ?? this.createSchemaRag(options);
      const ragIndexer = new ProgressiveSchemaRagIndexer({
        engine: rag,
        ...(options.schemaSnapshotDirectory === undefined
          ? {}
          : {
              snapshotStore: new SchemaRagSnapshotStore({
                rootDir: resolve(
                  project.rootPath,
                  options.schemaSnapshotDirectory,
                  schemaSnapshotScopeDirectory(this.resourceScope),
                ),
              }),
            }),
      });
      ownsSqlRunStore = options.sqlRunStore === undefined;
      sqlRuns = options.sqlRunStore ?? options.createSqlRunStore?.() ?? new SqlRunStore({
        filePath: options.stateDatabasePath ?? join(project.configDirectory, 'state.db'),
        projectKey: project.projectId,
        now: this.now,
      });
      // DatabaseAccessRuntime is last: every preceding operation is synchronous
      // and can fail without creating or taking ownership of a database facade.
      let database: DatabaseAccessRuntime;
      let resourceRegistry: ResourceRegistry;
      if (options.databaseAccess) {
        database = options.databaseAccess;
        resourceRegistry = database.resources;
        database.attachResultStore(databaseResultStore);
      } else {
        const connectors = options.connectorRegistry ?? new ConnectorRegistry();
        resourceRegistry = options.resourceRegistry ?? new ResourceRegistry();
        const postgresDriver =
          options.postgresDriver ?? options.createPostgresDriver?.() ?? new PostgresDriver();
        const postgresConnector = new PostgresConnector(postgresDriver, {
          resultStore: databaseResultStore,
        });
        if (connectors.find({ engine: 'postgres', transport: 'tcp' }).length === 0) {
          connectors.register(postgresConnector);
        }
        for (const connector of options.connectors ?? []) connectors.replace(connector);
        database = new DatabaseAccessRuntime({
          connectors,
          resources: resourceRegistry,
          resultStore: databaseResultStore,
          ...(options.credentialResolver ? { credentialResolver: options.credentialResolver } : {}),
          ...(options.databaseAuditSink ? { auditSink: options.databaseAuditSink } : {}),
        });
      }
      const state: DatabaseCapabilityResources = {
        rag,
        database,
        resources: resourceRegistry,
        ragIndexer,
        sqlRuns,
        ownsSqlRunStore,
      };
      this.resourcesState = state;
      return state;
    } catch (error) {
      if (ownsSqlRunStore && sqlRuns) {
        try {
          sqlRuns.close();
        } catch {
          // Preserve the initialization failure; a partially opened run store
          // must not mask the primary diagnostic.
        }
      }
      throw error;
    } finally {
      this.initializingResources = false;
    }
  }

  private get ragIndexer(): ProgressiveSchemaRagIndexer {
    return this.ensureResources().ragIndexer;
  }

  private createSchemaRag(options: DatabaseCapabilityOptions): SchemaRagEngine {
    return new SchemaRagEngine({
      ...(options.retrievalProfile === undefined ? {} : { retrievalProfile: options.retrievalProfile }),
      ...(options.retrievalProfile?.embedding === undefined
        ? {}
        : {
            embeddingAdapter: {
              embed: async ({ profile, texts }) => (await this.host.embed({
                selection: { connectionId: profile.providerInstanceId, modelId: profile.modelId },
                input: texts,
                ...(profile.dimensions === undefined ? {} : { dimensions: profile.dimensions }),
                context: { tenantId: this.tenantId, taskType: 'schema-rag-embedding' },
              })).embeddings,
            },
          }),
      ...(options.retrievalProfile?.reranker === undefined
        ? {}
        : {
            rerankAdapter: {
              rerank: async ({ profile, query, documents }) => {
                const response = await this.host.rerank({
                  selection: { connectionId: profile.providerInstanceId, modelId: profile.modelId },
                  query,
                  documents: documents.map((document) => document.text),
                  ...(profile.topN === undefined ? {} : { topN: profile.topN }),
                  context: { tenantId: this.tenantId, taskType: 'schema-rag-rerank' },
                });
                return response.results
                  .map((item) => {
                    const document = documents[item.index];
                    return document ? { id: document.id, score: item.score } : undefined;
                  })
                  .filter((item): item is { id: string; score: number } => item !== undefined);
              },
            },
          }),
    });
  }

  private get sqlRuns(): SqlRunStore {
    return this.ensureResources().sqlRuns;
  }

  private get ownsSqlRunStore(): boolean {
    return this.ensureResources().ownsSqlRunStore;
  }

  private async activateAutomatic(
    context?: AgentCapabilityLifecycleContext,
  ): Promise<AgentCapabilityModuleRuntime> {
    const candidates = await this.discoverExternalCandidates(context);
    if (candidates.length !== 1) {
      throw new DatabaseCapabilityError(
        'NOT_CONFIGURED',
        candidates.length === 0
          ? 'No external database context is available.'
          : 'Select one external database context before activating this Capability.',
        true,
      );
    }
    return await this.resolveDiscoveredCandidate(candidates[0]!, context);
  }

  private async resolveCandidate(
    candidateId: string,
    context?: AgentCapabilityLifecycleContext,
  ): Promise<AgentCapabilityModuleRuntime> {
    const candidates = await this.discoverExternalCandidates(context);
    const candidate = candidates.find((entry) => entry.candidateId === candidateId);
    if (!candidate) {
      throw new DatabaseCapabilityError(
        'NOT_CONFIGURED',
        'The selected external database context is no longer available.',
        true,
      );
    }
    return await this.resolveDiscoveredCandidate(candidate, context);
  }

  private async refreshExternalBinding(
    context?: AgentCapabilityLifecycleContext,
  ): Promise<AgentCapabilityModuleRuntime> {
    const activeBinding = this.activeExternalBinding;
    if (!activeBinding) {
      throw new DatabaseCapabilityError(
        'NOT_CONFIGURED',
        'No external database context is active to refresh.',
        true,
      );
    }
    if (activeBinding.providerId !== this.externalProviderId(this.requireConnectionProvider())) {
      throw new DatabaseCapabilityError(
        'NOT_CONFIGURED',
        'The external database provider changed; probe and activate it again.',
        true,
      );
    }
    const candidates = await this.discoverExternalCandidates(context);
    const candidate = candidates.find((entry) => entry.candidateId === activeBinding.candidateId);
    if (!candidate || candidate.fingerprint !== activeBinding.fingerprint) {
      throw new DatabaseCapabilityError(
        'NOT_CONFIGURED',
        'The active external database context changed; probe and activate it again.',
        true,
      );
    }
    await this.resolveExternalCandidateBinding(candidate, context);
    assertLifecycleActive(context);
    return this.createRuntimeGeneration();
  }

  private async resolveDiscoveredCandidate(
    candidate: ConnectionCandidate,
    context?: AgentCapabilityLifecycleContext,
  ): Promise<AgentCapabilityModuleRuntime> {
    const provider = this.requireConnectionProvider();
    const providerId = this.externalProviderId(provider);
    const binding = await this.resolveExternalCandidateBinding(candidate, context);
    const profile = toRuntimeConnectionProfile(
      binding.profile,
      providerId,
      candidate,
      this.resourceScope,
      this.now(),
    );
    return await this.withActiveBindingWrite(async () => {
      const previous = this.activeProfileSnapshot();
      const reusingProfile = previous.profileId === profile.id;
      if (!reusingProfile) this.database.createProfile(profile);
      let connected = false;
      try {
        assertLifecycleActive(context);
        const session = reusingProfile
          ? await this.database.reconnect(profile.id, binding.credential)
          : await this.database.connect(profile.id, binding.credential);
        connected = true;
        assertLifecycleActive(context);
        await this.publishActiveProfile(profile, session, true, {
          retainOnPublicationFailure: reusingProfile,
        });
        const connection = this.requireConnection();
        const discovery = await discoverCurrentResources(this.database, profile.id);
        assertLifecycleActive(context);
        const schemaChanged = !this.rag.hasIndex(connection.id) ||
          this.rag.getCatalog(connection.id).sourceRevision !== discovery.sourceRevision;
        if (schemaChanged) {
          await this.indexDiscoveredSchema(connection, discovery, this.lastIndexMaxTables);
        }
        this.lastSchemaFreshnessCheckAt = Date.now();
        await this.retirePreviousProfile(previous, profile.id);
        this.activeExternalBinding = Object.freeze({
          providerId,
          candidateId: candidate.candidateId,
          fingerprint: candidate.fingerprint,
        });
        return this.createRuntimeGeneration();
      } catch (error) {
        if (connected) await this.database.disconnect(profile.id).catch(() => undefined);
        if (reusingProfile && connected) {
          this.profileId = undefined;
          this.connection = undefined;
          this.ownsActiveProfile = false;
          this.activeExternalBinding = undefined;
        }
        if (!reusingProfile) {
          try {
            this.database.deleteProfile(profile.id);
          } catch {
            // Preserve the original connection error; cleanup is best-effort.
          }
        }
        throw mapDatabaseAccessError(error);
      }
    });
  }

  private async resolveExternalCandidateBinding(
    candidate: ConnectionCandidate,
    context?: AgentCapabilityLifecycleContext,
  ): Promise<EphemeralConnectionBinding> {
    const provider = this.requireConnectionProvider();
    assertLifecycleActive(context);
    let resolved: EphemeralConnectionBinding;
    try {
      resolved = await awaitLifecycleOperation(provider.resolve(candidate.candidateId, context), context);
    } catch (error) {
      if (error instanceof DatabaseCapabilityError && error.code === 'ABORTED') throw error;
      assertLifecycleActive(context);
      throw externalProviderFailure('resolve', error);
    }
    assertLifecycleActive(context);
    return validateEphemeralConnectionBinding(resolved, candidate);
  }

  private async disconnectUnderWriteLease(
    options: Readonly<{
      resources?: DatabaseCapabilityResources;
    }> = {},
  ): Promise<void> {
    const current = this.connection;
    if (!current) return;
    const profileId = this.requireProfileId();
    const database = options.resources?.database ?? this.database;
    const rag = options.resources?.rag ?? this.rag;
    try {
      await database.disconnect(profileId);
    } catch (error) {
      throw mapDatabaseAccessError(error);
    }
    if (this.ownsActiveProfile) {
      try {
        database.deleteProfile(profileId);
      } catch {
        // The physical session is already closed and the Capability generation
        // is withdrawn. Profile cleanup must not republish a dead binding or
        // turn a successful disconnect into a contradictory failure.
      }
    }
    this.profileId = undefined;
    this.ownsActiveProfile = false;
    this.activeExternalBinding = undefined;
    try {
      rag.clear(current.id);
    } catch {
      // The retired in-memory index cannot be used after connection identity is
      // cleared. Resource disposal remains owned by close().
    }
    this.connection = undefined;
    this.indexTruncated = false;
    this.lastIndexMaxTables = DEFAULT_MAX_SCHEMA_TABLES;
    this.schemaFreshnessPromise = undefined;
    this.schemaFreshnessPromiseBinding = undefined;
    this.schemaFreshnessBinding = undefined;
    this.lastSchemaFreshnessCheckAt = 0;
    this.lastForcedSchemaRefreshAt = 0;
    this.schemaPublicationPending = false;
    this.schemaPublicationPromise = undefined;
    this.schemaPublicationPromiseBinding = undefined;
    this.contributionPublicationPending = false;
    this.isolatedBindingKey = undefined;
  }

  async indexSchema(options: IndexSchemaOptions = {}): Promise<SchemaIndexSnapshot> {
    const connection = this.requireConnection();
    const binding = this.captureBinding(connection);
    const maxTables = normalizeInteger(
      options.maxTables ?? DEFAULT_MAX_SCHEMA_TABLES,
      'maxTables',
      1,
      MAX_SCHEMA_TABLES,
    );
    return await this.indexSchemaForBinding(binding, maxTables);
  }

  private async indexSchemaForBinding(
    binding: ActiveDatabaseBinding,
    maxTables: number,
  ): Promise<SchemaIndexSnapshot> {
    return await this.withActiveBindingRead(
      binding,
      undefined,
      async () => await this.indexSchemaForBindingUnderReadLease(binding, maxTables),
    );
  }

  private async indexSchemaForBindingUnderReadLease(
    binding: ActiveDatabaseBinding,
    maxTables: number,
  ): Promise<SchemaIndexSnapshot> {
    this.assertActiveBinding(binding);
    const connection = this.requireConnection();
    const discovery = await discoverCurrentResources(this.database, binding.profileId);
    this.assertActiveBinding(binding);
    const snapshot = await this.indexDiscoveredSchema(connection, discovery, maxTables);
    this.assertActiveBinding(binding);
    await this.publishSchemaGeneration(binding);
    this.assertActiveBinding(binding);
    this.lastSchemaFreshnessCheckAt = Date.now();
    return snapshot;
  }

  schemaStatus(): SchemaIndexSnapshot {
    if (!this.connection) return emptySchemaStatus('not_connected');
    const status = this.rag.getIndexStatus(this.connection.id);
    if (!status.ready) {
      return { connectionId: this.connection.id, ...emptySchemaStatus('not_indexed') };
    }
    return {
      connectionId: this.connection.id,
      stage: 'ready',
      ready: true,
      tableCount: status.tableCount,
      columnCount: status.columnCount,
      relationCount: status.relationCount,
      documentCount: status.documentCount,
      truncated: this.indexTruncated,
      ...(status.indexedAt === undefined ? {} : { indexedAt: status.indexedAt }),
    };
  }

  status(): DatabaseCapabilityStatus {
    return {
      connected: Boolean(this.connection),
      agentPublication:
        this.pendingActiveBindingWrites > 0 ||
        this.contributionPublicationPending ||
        this.schemaPublicationPending
          ? 'pending'
          : 'current',
      ...(this.connection === undefined ? {} : { connection: cloneConnection(this.connection) }),
      schema: this.schemaStatus(),
      runCount: this.sqlRunStoreClosed
        ? this.closedSqlRunCount
        : this.resourcesState?.sqlRuns.count() ?? 0,
    };
  }

  async generate(input: GenerateSqlInput): Promise<GeneratedSqlRun> {
    const connection = this.requireConnection();
    const binding = this.captureBinding(connection);
    return await this.withActiveBindingRead(binding, input.signal, async () =>
      await this.generateUnderReadLease(input, connection));
  }

  private async generateUnderReadLease(
    input: GenerateSqlInput,
    connection: SavedConnection,
  ): Promise<GeneratedSqlRun> {
    await this.ensureSchemaFreshUnderReadLease(connection, input.signal);
    if (!this.rag.hasIndex(connection.id)) {
      throw new DatabaseCapabilityError('SCHEMA_NOT_INDEXED', 'Index the database Schema first.', true);
    }
    const question = requireText(input.question, 'question', MAX_QUESTION_CHARS);
    const maxContextChars = normalizeInteger(
      input.maxContextChars ?? DEFAULT_CONTEXT_CHARS,
      'maxContextChars',
      1_000,
      MAX_CONTEXT_CHARS,
    );
    if (input.signal?.aborted) {
      throw new DatabaseCapabilityError('ABORTED', 'SQL generation was cancelled.', false);
    }
    const context = this.rag.buildContext({
      connectionId: connection.id,
      query: question,
      maxChars: maxContextChars,
      limit: 12,
    });
    const contextText = context.text || this.fallbackSchemaContext(connection.id, maxContextChars);
    let response;
    try {
      const request = {
        ...toLlmGenerationRequest(input.generation ?? {}),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        messages: [
          { role: 'system' as const, content: buildNl2SqlSystemPrompt() },
          {
            role: 'user' as const,
            content: `User question:\n${question}\n\nAvailable PostgreSQL Schema:\n${contextText}`,
          },
        ],
      };
      response = await this.host.chat(request, {
        model: input.model,
        taskType: 'nl2sql-generation',
        maxRetries: 1,
      });
    } catch (error) {
      throw mapLlmError(error);
    }
    const parsed = parseGeneratedSqlResponse(response.text);
    const safety = analyzeSqlSafety(parsed.sql, { readOnly: true });
    const executable = isExecutableSafety(safety);
    const timestamp = this.now();
    const run: GeneratedSqlRun = {
      runId: this.createRunId(),
      connectionId: connection.id,
      executionResultAvailable: false,
      status: executable ? 'awaiting_execution' : 'blocked',
      question,
      sql: parsed.sql,
      explanation: parsed.explanation,
      assumptions: [...parsed.assumptions],
      evidence:
        context.documents.length > 0
          ? context.documents.map<GeneratedSqlEvidence>((item) => ({
              title: item.document.title,
              kind: item.document.kind,
              reasons: [...item.reasons],
            }))
          : this.fallbackSchemaEvidence(connection.id),
      safety,
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(response.usage === undefined ? {} : { usage: { ...response.usage } }),
    };
    this.sqlRuns.put(run);
    return cloneRun(run) as GeneratedSqlRun;
  }

  async executeGenerated(
    runId: string,
    options: ExecuteGeneratedOptions = {},
  ): Promise<ExecutedSqlRun> {
    const normalizedRunId = requireText(runId, 'runId', 300);
    const run = this.sqlRuns.get(normalizedRunId);
    if (!run) throw new DatabaseCapabilityError('RUN_NOT_FOUND', 'SQL run was not found.', false);
    if (run.status !== 'awaiting_execution') {
      throw new DatabaseCapabilityError(
        'RUN_NOT_EXECUTABLE',
        `SQL run cannot execute from status ${run.status}.`,
        false,
      );
    }
    const connection = this.requireConnection();
    if (run.connectionId !== connection.id) {
      throw new DatabaseCapabilityError(
        'RUN_NOT_EXECUTABLE',
        'The SQL run belongs to a different database connection.',
        false,
      );
    }
    const safety = analyzeSqlSafety(run.sql, { readOnly: true });
    if (!isExecutableSafety(safety)) {
      this.sqlRuns.put(updateRun(run, { status: 'blocked', safety, updatedAt: this.now() }));
      throw new DatabaseCapabilityError('SQL_BLOCKED', safetyMessage(safety), false);
    }
    const executing = updateRun(run, { status: 'executing', safety, updatedAt: this.now() });
    this.sqlRuns.put(executing);
    const limit = normalizeInteger(
      options.limit ?? this.defaultRowLimit,
      'limit',
      1,
      MAX_ROW_LIMIT,
    );
    let result: QueryExecutionResult;
    try {
      const execution = await this.executeAiSqlQuery({
        request: { connectionId: connection.id, sql: run.sql, limit },
        binding: this.captureBinding(connection),
        authorization: {},
      });
      result = 'result' in execution ? execution.result : execution;
    } catch (error) {
      const normalized = asDatabaseCapabilityError(error);
      const failure = new DatabaseCapabilityError(
        'QUERY_FAILED',
        normalized.message,
        normalized.retryable,
        normalized.detail,
      );
      this.sqlRuns.put(
        updateRun(executing, {
          status: 'failed',
          updatedAt: this.now(),
          error: toRunError(failure),
        }),
      );
      throw failure;
    }
    const { error: _error, execution: _execution, ...base } = executing;
    void _error;
    void _execution;
    const completed: ExecutedSqlRun = {
      ...base,
      status: 'completed',
      executionResultAvailable: true,
      safety,
      execution: result,
      updatedAt: this.now(),
    };
    this.sqlRuns.put(completed);
    return cloneRun(completed) as ExecutedSqlRun;
  }

  async reexecuteGenerated(
    runId: string,
    options: ExecuteGeneratedOptions = {},
  ): Promise<ExecutedSqlRun> {
    const normalizedRunId = requireText(runId, 'runId', 300);
    const run = this.sqlRuns.get(normalizedRunId);
    if (!run) throw new DatabaseCapabilityError('RUN_NOT_FOUND', 'SQL run was not found.', false);
    if (!['completed', 'failed', 'aborted', 'outcome_unknown'].includes(run.status)) {
      throw new DatabaseCapabilityError(
        'RUN_NOT_EXECUTABLE',
        `SQL run cannot be re-executed from status ${run.status}.`,
        false,
      );
    }
    const connection = this.requireConnection();
    if (run.connectionId !== connection.id) {
      throw new DatabaseCapabilityError(
        'RUN_NOT_EXECUTABLE',
        'The SQL run belongs to a different database connection.',
        false,
      );
    }
    const { execution: _execution, error: _error, ...base } = run;
    void _execution;
    void _error;
    this.sqlRuns.put({
      ...base,
      status: 'awaiting_execution',
      executionResultAvailable: false,
      updatedAt: this.now(),
    });
    return await this.executeGenerated(normalizedRunId, options);
  }

  getRun(runId: string): SqlRunSnapshot | undefined {
    const run = this.sqlRuns.get(runId);
    return run ? cloneRun(run) : undefined;
  }

  dispose(): Promise<void> {
    if (this.disposeOperation) return this.disposeOperation;
    this.disposed = true;
    const operation = this.withActiveBindingWrite(
      async () => await this.disposeUnderWriteLease(),
      { allowDisposed: true },
    );
    this.disposeOperation = operation;
    void operation.catch(() => {
      if (this.disposeOperation === operation) this.disposeOperation = undefined;
    });
    return operation;
  }

  private async disposeUnderWriteLease(): Promise<void> {
    const resources = this.resourcesState;
    if (!resources) return;
    const failures: unknown[] = [];
    if (this.connection) {
      try {
        // CapabilityControlPlane withdraws and drains the generation before it
        // invokes module.dispose(). Re-entering the host lifecycle here would
        // deadlock or attempt to reactivate a closing module.
        await this.disconnectUnderWriteLease({ resources });
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await resources.database.close();
    } catch (error) {
      failures.push(error);
    }
    if (resources.ownsSqlRunStore && !this.sqlRunStoreClosed) {
      this.closedSqlRunCount = resources.sqlRuns.count();
      resources.sqlRuns.close();
      this.sqlRunStoreClosed = true;
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Database Capability did not close cleanly.');
    }
  }

  private async probe(context?: AgentCapabilityLifecycleContext): Promise<AgentCapabilityProbeResult> {
    if (!this.connectionProvider) {
      return unavailableDatabaseProbe('No external database connection provider is available.');
    }
    try {
      const candidates = await this.discoverExternalCandidates(context);
      if (candidates.length === 0) {
        return unavailableDatabaseProbe('No externally configured database context is available.');
      }
      return {
        status: 'available',
        capabilities: {
          'database.query': { status: 'available' },
          // Schema is indexed only after activation, but the capability itself
          // is available from an externally managed context.
          'database.schema': { status: 'available' },
        },
        activation: {
          kind: 'external_context',
          selection: candidates.length === 1 ? 'automatic' : 'choice_required',
          providerId: this.externalProviderId(this.connectionProvider),
          probeRevision: externalProbeRevision(this.externalProviderId(this.connectionProvider), candidates),
          candidates,
        },
      };
    } catch (error) {
      if (error instanceof DatabaseCapabilityError && error.code === 'ABORTED') throw error;
      return unavailableDatabaseProbe(externalProviderReason(error));
    }
  }

  private requireConnectionProvider(): ExternalConnectionProvider {
    if (!this.connectionProvider) {
      throw new DatabaseCapabilityError(
        'NOT_CONFIGURED',
        'No external database connection provider is available.',
        true,
      );
    }
    return this.connectionProvider;
  }

  private externalProviderId(provider: ExternalConnectionProvider): string {
    return requireExternalText(provider.providerId, 'providerId', 200);
  }

  private async discoverExternalCandidates(
    context?: AgentCapabilityLifecycleContext,
  ): Promise<readonly ConnectionCandidate[]> {
    const provider = this.requireConnectionProvider();
    assertLifecycleActive(context);
    let candidates: readonly ConnectionCandidate[];
    try {
      candidates = await awaitLifecycleOperation(provider.discover(context), context);
    } catch (error) {
      if (error instanceof DatabaseCapabilityError && error.code === 'ABORTED') throw error;
      assertLifecycleActive(context);
      throw externalProviderFailure('discover', error);
    }
    assertLifecycleActive(context);
    return validateConnectionCandidates(candidates);
  }

  private createRuntimeGeneration(): AgentCapabilityModuleRuntime {
    const connection = this.requireConnection();
    const indexed = this.rag.hasIndex(connection.id);
    const databaseSkills = databaseSkillSource();
    const binding = this.captureBinding(connection);
    const generation = createDatabaseToolGeneration({
      binding,
      handlerGeneration: `runtime-${++this.runtimeGeneration}`,
      queryExecutor: (input) => this.executeAiSqlQuery(input),
      resultContent: (input) => this.resolveAiSqlResultContent(input),
      ensureSchemaFresh: async ({ binding: staleBinding, force, signal }) => {
        this.assertActiveBinding(staleBinding);
        if (staleBinding.connectionId !== connection.id || staleBinding.profileId !== binding.profileId) {
          throw new DatabaseCapabilityError('CONNECTION_FAILED', 'The database binding changed during Schema refresh.', true);
        }
        await this.ensureSchemaFresh(connection, signal, force);
        this.assertActiveBinding(staleBinding);
        return this.captureBinding(connection);
      },
      onSchemaChanged: async () => {
        this.assertActiveBinding(binding);
        await this.indexSchemaForBinding(binding, this.lastIndexMaxTables);
      },
    });
    // Every immutable runtime closes over this exact Schema snapshot. A later
    // index change asks the Host to publish another generation; captured Turns
    // keep this one until their generation lease drains.
    const tools = generation.contributions;
    const stateReferences: Array<{
      capabilityId: string;
      stateId: string;
      version: string;
    }> = [
      {
        capabilityId: 'database.query',
        stateId: connection.id,
        version: connection.updatedAt,
      },
    ];
    if (indexed) {
      const catalog = this.rag.getCatalog(connection.id);
      const manifest = this.rag.getIndexManifest(connection.id);
      stateReferences.push({
        capabilityId: 'database.schema',
        stateId: catalog.snapshotId,
        version: manifest.indexVersion,
      });
    }
    return {
      contributions: {
        tools,
        skillSources: [
          {
            id: 'database-system-skills',
            scope: databaseSkills.scope,
            path: databaseSkills.path,
            revision: `module:${DATABASE_CAPABILITY_MODULE_ID}@${DATABASE_CAPABILITY_MODULE_REVISION}:skills`,
          },
        ],
        stateReferences,
      },
    };
  }

  private captureBinding(connection: SavedConnection): ActiveDatabaseBinding {
    if (this.connection?.id !== connection.id) {
      throw new DatabaseCapabilityError(
        'CONNECTION_FAILED',
        'The database connection changed before its binding could be captured.',
        true,
      );
    }
    if (!this.rag.hasIndex(connection.id)) {
      return Object.freeze({
        connectionId: connection.id,
        profileId: this.requireProfileId(),
        host: connection.host,
        readOnly: connection.readOnly,
        schema: unavailableSchemaReadView(connection.id),
      });
    }
    const rag = this.rag as SchemaRagEngine & {
      captureReadView(connectionId: string): ActiveDatabaseBinding['schema'];
    };
    return Object.freeze({
      connectionId: connection.id,
      profileId: this.requireProfileId(),
      host: connection.host,
      readOnly: connection.readOnly,
      schema: rag.captureReadView(connection.id),
    });
  }

  private async publishActiveProfile(
    profile: ConnectionProfile,
    session: ConnectionSession,
    ownsProfile: boolean,
    options: Readonly<{ retainOnPublicationFailure?: boolean }> = {},
  ): Promise<void> {
    await this.publishActiveConnection(
      profile.id,
      savedConnectionFromProfileSession(profile, session, this.now()),
      ownsProfile,
      options,
    );
  }

  private activeProfileSnapshot(): Readonly<{
    profileId?: string;
    connection?: SavedConnection;
    ownsProfile: boolean;
  }> {
    return {
      ...(this.profileId === undefined ? {} : { profileId: this.profileId }),
      ...(this.connection === undefined ? {} : { connection: this.connection }),
      ownsProfile: this.ownsActiveProfile,
    };
  }

  private async retirePreviousProfile(
    previous: ReturnType<DatabaseCapabilityModule['activeProfileSnapshot']>,
    replacementProfileId: string,
  ): Promise<void> {
    if (previous.profileId === undefined || previous.profileId === replacementProfileId) return;
    await this.database.disconnect(previous.profileId).catch(() => undefined);
    if (previous.ownsProfile) {
      try {
        this.database.deleteProfile(previous.profileId);
      } catch {
        // The replacement is already published. Cleanup cannot roll that
        // committed generation back or make the caller observe a false failure.
      }
    }
    if (previous.connection) {
      try {
        this.rag.clear(previous.connection.id);
      } catch {
        // The retired binding is no longer reachable from any new generation.
      }
    }
  }

  /**
   * Establish the internal runtime binding. CapabilityControlPlane publishes
   * the returned generation; this module never re-enters host lifecycle APIs.
   */
  private async publishActiveConnection(
    profileId: string,
    connection: SavedConnection,
    ownsProfile: boolean,
    options: Readonly<{ retainOnPublicationFailure?: boolean }> = {},
  ): Promise<void> {
    const previous = {
      profileId: this.profileId,
      connection: this.connection,
      ownsProfile: this.ownsActiveProfile,
      indexTruncated: this.indexTruncated,
      lastIndexMaxTables: this.lastIndexMaxTables,
      contributionPublicationPending: this.contributionPublicationPending,
      schemaPublicationPending: this.schemaPublicationPending,
      isolatedBindingKey: this.isolatedBindingKey,
      schemaFreshnessBinding: this.schemaFreshnessBinding,
      lastSchemaFreshnessCheckAt: this.lastSchemaFreshnessCheckAt,
      lastForcedSchemaRefreshAt: this.lastForcedSchemaRefreshAt,
    };
    this.profileId = profileId;
    this.connection = connection;
    this.ownsActiveProfile = ownsProfile;
    this.contributionPublicationPending = true;
    this.selectFreshnessBinding(profileId, connection.id);
    try {
      await this.restoreSchema(connection.id);
      this.contributionPublicationPending = false;
      this.schemaPublicationPending = false;
      this.schemaPublicationPromise = undefined;
      this.schemaPublicationPromiseBinding = undefined;
      this.isolatedBindingKey = undefined;
    } catch (error) {
      if (options.retainOnPublicationFailure === true) {
        // DatabaseAccessRuntime has already committed the new physical session.
        // Retaining that identity lets the next reconnect retry publication only,
        // rather than pretending the old connection still exists.
        this.contributionPublicationPending = true;
        throw error;
      }
      this.profileId = previous.profileId;
      this.connection = previous.connection;
      this.ownsActiveProfile = previous.ownsProfile;
      this.indexTruncated = previous.indexTruncated;
      this.lastIndexMaxTables = previous.lastIndexMaxTables;
      this.contributionPublicationPending = previous.contributionPublicationPending;
      this.schemaPublicationPending = previous.schemaPublicationPending;
      this.isolatedBindingKey = previous.isolatedBindingKey;
      this.schemaFreshnessBinding = previous.schemaFreshnessBinding;
      this.lastSchemaFreshnessCheckAt = previous.lastSchemaFreshnessCheckAt;
      this.lastForcedSchemaRefreshAt = previous.lastForcedSchemaRefreshAt;
      if (previous.connection?.id !== connection.id) {
        try {
          this.rag.clear(connection.id);
        } catch {
          // The original publication failure is the actionable error. The
          // unpublished candidate index is unreachable and will be reclaimed
          // by module disposal or a later replacement.
        }
      }
      throw error;
    }
  }

  private async restoreSchema(connectionId: string): Promise<void> {
    this.indexTruncated = false;
    this.lastIndexMaxTables = DEFAULT_MAX_SCHEMA_TABLES;
    const restored = await this.ragIndexer.restore(connectionId);
    if (restored?.ready) this.restoreSchemaIndexOptions(connectionId);
  }

  private async executeAiSqlQuery(input: AiSqlQueryExecutionInput): Promise<AiSqlQueryExecution> {
    return await this.withActiveBindingRead(
      input.binding,
      input.signal,
      async () => await this.executeAiSqlQueryUnderReadLease(input),
    );
  }

  private async resolveAiSqlResultContent(
    input: AiSqlResultContentInput,
  ): Promise<ToolRetainedResultContent | undefined> {
    return await this.withActiveBindingRead(input.binding, input.signal, async () => {
      const store = this.database.resultStore;
      if (store === undefined) return undefined;
      const handle = await store.getHandle(input.resultId);
      if (handle.id !== input.resultId) {
        throw new DatabaseCapabilityError(
          'QUERY_FAILED',
          'The database result store returned a different result identity.',
          false,
        );
      }
      return Object.freeze({
        mediaType: 'application/x-ndjson',
        identity: handle.id,
        source: databaseResultNdjson(store, handle, input.signal),
      });
    });
  }

  private async executeAiSqlQueryUnderReadLease(
    input: AiSqlQueryExecutionInput,
  ): Promise<AiSqlQueryExecution> {
    const started = performance.now();
    if (input.signal?.aborted) {
      throw new DatabaseCapabilityError('ABORTED', 'Database query was cancelled.', false);
    }
    this.assertActiveBinding(input.binding);
    let job: QueryJob;
    try {
      job = await this.database.submit({
        profileId: input.binding.profileId,
        sql: input.request.sql,
        executionMode: input.signal === undefined ? 'sync' : 'async',
        ...(input.request.timeoutMs === undefined ? {} : { timeoutMs: input.request.timeoutMs }),
        ...(input.request.limit === undefined ? {} : { rowLimit: input.request.limit }),
        ...(input.request.dryRun === undefined ? {} : { dryRun: input.request.dryRun }),
        ...(input.request.confirmed === undefined ? {} : { confirmed: input.request.confirmed }),
        ...(input.request.transactionMode === undefined
          ? {}
          : { transactionMode: input.request.transactionMode }),
        authorization: input.authorization,
      });
      if (input.signal) job = await waitForDatabaseJob(this.database, job, input.signal);
    } catch (error) {
      if (error instanceof DatabaseJobSettlementError) this.isolateBinding(input.binding);
      throw mapDatabaseAccessError(error);
    }
    if (job.state === 'failed' || job.state === 'cancelled') {
      if (job.error) throw new DatabaseAccessRuntimeError(job.error);
      throw new DatabaseCapabilityError(
        'QUERY_FAILED',
        `Database query ended with state ${job.state}.`,
        false,
      );
    }
    if (job.state !== 'succeeded') {
      throw new DatabaseCapabilityError(
        'QUERY_FAILED',
        `Synchronous database query did not finish; state is ${job.state}.`,
        true,
      );
    }
    const rows: QueryExecutionResult['rows'] = [];
    if (job.result) {
      const previewLimit = Math.max(Math.floor(input.request.limit ?? 1_000), 1);
      for await (const batch of this.database.streamResult(job.result.id, {
        batchSize: Math.min(previewLimit, 1_000),
      })) {
        rows.push(...batch.rows.slice(0, previewLimit - rows.length));
        if (rows.length >= previewLimit) break;
      }
    }
    const safety =
      job.safety ?? analyzeSqlSafety(input.request.sql, { readOnly: input.binding.readOnly });
    const result: QueryExecutionResult = {
      queryId: job.id,
      columns:
        job.result?.columns.map((column) => ({
          name: column.name,
          ...(column.dataType || column.nativeType
            ? { dataType: column.dataType ?? column.nativeType }
            : {}),
        })) ?? [],
      rows,
      rowCount: job.result?.rowCount ?? rows.length,
      returnedRowCount: rows.length,
      ...(input.request.limit === undefined ? {} : { rowLimit: input.request.limit }),
      hasMore: (job.result?.rowCount ?? rows.length) > rows.length,
      truncated: (job.result?.rowCount ?? rows.length) > rows.length,
      elapsedMs: Math.round(performance.now() - started),
      safety,
    };
    return job.result ? { result, handle: structuredClone(job.result) } : result;
  }

  private async ensureSchemaFresh(
    connection: SavedConnection,
    signal?: AbortSignal,
    force = false,
  ): Promise<void> {
    const binding = this.captureBinding(connection);
    await this.withActiveBindingRead(
      binding,
      signal,
      async () => await this.ensureSchemaFreshUnderReadLease(connection, signal, force),
    );
  }

  private async ensureSchemaFreshUnderReadLease(
    connection: SavedConnection,
    signal?: AbortSignal,
    force = false,
  ): Promise<void> {
    const profileId = this.profileId;
    if (!profileId || !this.rag.hasIndex(connection.id)) {
      return;
    }
    if (signal?.aborted) {
      throw new DatabaseCapabilityError('ABORTED', 'Schema freshness check was cancelled.', false);
    }
    const bindingKey = this.selectFreshnessBinding(profileId, connection.id);
    let current = this.schemaFreshnessPromise;
    if (current && this.schemaFreshnessPromiseBinding === bindingKey) {
      await waitForSharedOperation(
        current,
        signal,
        () => new DatabaseCapabilityError('ABORTED', 'Schema freshness check was cancelled.', false),
      );
      return;
    }
    const checkedAt = Date.now();
    if (force && checkedAt - this.lastForcedSchemaRefreshAt < SCHEMA_MISS_REFRESH_DEBOUNCE_MS) {
      return;
    }
    if (!force && checkedAt - this.lastSchemaFreshnessCheckAt < this.schemaFreshnessIntervalMs) {
      return;
    }
    current = (async () => {
      const discovery = await discoverCurrentResources(this.database, profileId);
      if (this.connection?.id !== connection.id || this.profileId !== profileId) return;
      const schemaChanged = this.rag.getCatalog(connection.id).sourceRevision !== discovery.sourceRevision;
      if (schemaChanged) {
        await this.indexDiscoveredSchema(connection, discovery, this.lastIndexMaxTables);
      }
      if (schemaChanged || this.schemaPublicationPending) {
        // An indexed Schema is not current until its matching Capability Tool
        // generation is published. Background callers stay asynchronous by
        // discarding this promise, but the check itself has one boundary.
        await this.publishSchemaGeneration(this.captureBinding(connection));
      }
      if (this.schemaFreshnessBinding === bindingKey) {
        this.lastSchemaFreshnessCheckAt = Date.now();
        if (force) this.lastForcedSchemaRefreshAt = Date.now();
      }
    })();
    this.schemaFreshnessPromise = current;
    this.schemaFreshnessPromiseBinding = bindingKey;
    const clear = () => {
      if (this.schemaFreshnessPromise === current) {
        this.schemaFreshnessPromise = undefined;
        this.schemaFreshnessPromiseBinding = undefined;
      }
    };
    void current.then(clear, clear);
    await waitForSharedOperation(
      current,
      signal,
      () => new DatabaseCapabilityError('ABORTED', 'Schema freshness check was cancelled.', false),
    );
  }

  private assertActiveBinding(binding: ActiveDatabaseBinding): void {
    if (
      this.contributionPublicationPending ||
      this.connection === undefined ||
      this.profileId === undefined ||
      binding.connectionId !== this.connection.id ||
      binding.profileId !== this.profileId ||
      this.isolatedBindingKey === freshnessBindingKey(binding.profileId, binding.connectionId)
    ) {
      throw new DatabaseCapabilityError(
        'CONNECTION_FAILED',
        'The captured database binding is retired and cannot execute against the current connection.',
        true,
      );
    }
  }

  private assertActiveBindingAdmission(binding: ActiveDatabaseBinding): void {
    if (this.pendingActiveBindingWrites > 0) {
      throw new DatabaseCapabilityError(
        'CONNECTION_FAILED',
        'The active database connection is changing; retry with the next Capability generation.',
        true,
      );
    }
    this.assertActiveBinding(binding);
  }

  private async withActiveBindingRead<T>(
    binding: ActiveDatabaseBinding,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    // Reject a retired generation without queueing behind the writer that is
    // waiting for that generation's Turn lease to drain.
    this.assertActiveBindingAdmission(binding);
    const release = await this.activeBindingGate.acquireRead(signal);
    try {
      this.assertActiveBinding(binding);
      return await operation();
    } finally {
      release();
    }
  }

  private async withActiveBindingWrite<T>(
    operation: () => Promise<T>,
    options: Readonly<{ allowDisposed?: boolean }> = {},
  ): Promise<T> {
    if (this.disposed && options.allowDisposed !== true) {
      throw new DatabaseCapabilityError('NOT_CONFIGURED', 'The database Capability is closed.', false);
    }
    this.pendingActiveBindingWrites += 1;
    let release: ActiveBindingGateRelease | undefined;
    try {
      release = await this.activeBindingGate.acquireWrite();
      return await operation();
    } finally {
      release?.();
      this.pendingActiveBindingWrites -= 1;
    }
  }

  private async publishSchemaGeneration(binding: ActiveDatabaseBinding): Promise<void> {
    this.assertActiveBinding(binding);
    const bindingKey = freshnessBindingKey(binding.profileId, binding.connectionId);
    const current = this.schemaPublicationPromise;
    if (current !== undefined && this.schemaPublicationPromiseBinding === bindingKey) {
      await current;
      return;
    }
    this.schemaPublicationPending = true;
    const requestRefresh = this.host.requestCapabilityRefresh;
    if (requestRefresh === undefined) {
      throw new DatabaseCapabilityError(
        'CONNECTION_FAILED',
        'The host cannot publish the refreshed database Schema generation. Reconnect the database and retry.',
        true,
      );
    }
    const publication = (async () => {
      await requestRefresh({ reason: 'schema' });
      if (this.connection?.id === binding.connectionId && this.profileId === binding.profileId) {
        // The Host callback resolves only after CapabilityControlPlane.refresh
        // has committed the candidate generation atomically.
        this.schemaPublicationPending = false;
      }
    })();
    this.schemaPublicationPromise = publication;
    this.schemaPublicationPromiseBinding = bindingKey;
    try {
      await publication;
    } finally {
      if (this.schemaPublicationPromise === publication) {
        this.schemaPublicationPromise = undefined;
        this.schemaPublicationPromiseBinding = undefined;
      }
    }
  }

  private isolateBinding(binding: ActiveDatabaseBinding): void {
    if (this.connection?.id !== binding.connectionId || this.profileId !== binding.profileId) return;
    this.isolatedBindingKey = freshnessBindingKey(binding.profileId, binding.connectionId);
  }

  private selectFreshnessBinding(profileId: string, connectionId: string): string {
    const key = freshnessBindingKey(profileId, connectionId);
    if (this.schemaFreshnessBinding !== key) {
      this.schemaFreshnessBinding = key;
      this.lastSchemaFreshnessCheckAt = 0;
      this.lastForcedSchemaRefreshAt = 0;
    }
    return key;
  }

  private requireProfileId(): string {
    if (this.profileId) return this.profileId;
    throw new DatabaseCapabilityError(
      'CONNECTION_FAILED',
      'The active database connection has no DatabaseAccess profile.',
      false,
    );
  }

  private async indexDiscoveredSchema(
    connection: SavedConnection,
    discovery: {
      resources: ResourceDescriptor[];
      relations: ResourceRelation[];
      sourceRevision: string;
    },
    maxTables: number,
  ): Promise<SchemaIndexSnapshot> {
    const scopedResources = discovery.resources;
    const scopedIds = new Set(scopedResources.map((resource) => resource.id));
    const scopedRelations = discovery.relations.filter(
      (relation) => scopedIds.has(relation.fromResourceId) && scopedIds.has(relation.toResourceId),
    );
    const tableRoots = scopedResources
      .filter((resource) =>
        ['table', 'view', 'materialized-view', 'external-table'].includes(resource.kind),
      )
      .sort((left, right) => left.id.localeCompare(right.id));
    const excluded = collectContainedResources(
      new Set(tableRoots.slice(maxTables).map((resource) => resource.id)),
      scopedRelations,
    );
    const resources = scopedResources.filter((resource) => !excluded.has(resource.id));
    const resourceIds = new Set(resources.map((resource) => resource.id));
    const relations = scopedRelations.filter(
      (relation) =>
        resourceIds.has(relation.fromResourceId) && resourceIds.has(relation.toResourceId),
    );
    await this.ragIndexer.indexAsync({
      connectionId: connection.id,
      resources,
      relations,
      sourceRevision: discovery.sourceRevision,
      sourceTableCount: tableRoots.length,
      maxTables,
      indexedAt: this.now(),
    });
    this.indexTruncated = tableRoots.length > maxTables;
    this.lastIndexMaxTables = maxTables;
    return this.schemaStatus();
  }

  private restoreSchemaIndexOptions(connectionId: string): void {
    const manifest = this.rag.getIndexManifest(connectionId);
    if (manifest.maxTables === undefined || manifest.sourceTableCount === undefined) return;
    this.lastIndexMaxTables = manifest.maxTables;
    this.indexTruncated = manifest.sourceTableCount > manifest.maxTables;
  }

  private requireConnection(): SavedConnection {
    if (!this.connection) {
      throw new DatabaseCapabilityError('NOT_CONFIGURED', 'Connect a database first.', true);
    }
    return this.connection;
  }

  private fallbackSchemaContext(connectionId: string, maxChars: number): string {
    const summaries = this.rag.listTables({ connectionId, limit: 8 });
    const sections: string[] = [];
    for (const summary of summaries) {
      const description = this.rag.describeTable({
        connectionId,
        schema: summary.schema,
        table: summary.table,
        maxChars: Math.max(500, Math.floor(maxChars / Math.max(1, summaries.length))),
      });
      const next = [...sections, description.text].join('\n\n');
      if (next.length > maxChars) break;
      sections.push(description.text);
    }
    return sections.join('\n\n');
  }

  private fallbackSchemaEvidence(connectionId: string): GeneratedSqlEvidence[] {
    return this.rag.listTables({ connectionId, limit: 8 }).map((table) => ({
      title: table.title,
      kind: 'table',
      reasons: ['fallback_schema'],
    }));
  }
}

function unavailableSchemaReadView(connectionId: string): ActiveDatabaseBinding['schema'] {
  const unavailable = (): never => {
    throw new DatabaseCapabilityError('SCHEMA_NOT_INDEXED', 'Index the database Schema first.', true);
  };
  return Object.freeze({
    connectionId,
    getCatalog: unavailable,
    listResources: unavailable,
    getResource: unavailable,
    searchAsync: () => Promise.resolve().then(unavailable),
  });
}

function unavailableDatabaseProbe(reason: string): AgentCapabilityProbeResult {
  return {
    status: 'unavailable',
    reason,
    capabilities: {
      'database.query': { status: 'unavailable', reason },
      'database.schema': { status: 'unavailable', reason },
    },
  };
}

function externalProviderReason(error?: unknown): string {
  const detail = externalProviderErrorText(error);
  return detail === undefined
    ? 'External database discovery failed. Check the configured CLI, file, environment or keychain context, then retry.'
    : `External database discovery failed: ${detail}`;
}

function externalProviderFailure(operation: 'discover' | 'resolve', error: unknown): DatabaseCapabilityError {
  const detail = externalProviderErrorText(error);
  return new DatabaseCapabilityError(
    'NOT_CONFIGURED',
    detail === undefined
      ? operation === 'discover'
        ? externalProviderReason()
        : 'External database context resolution failed. Check the configured CLI, file, environment or keychain context, then retry.'
      : `External database ${operation} failed: ${detail}`,
    true,
  );
}

function externalProviderErrorText(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : undefined;
  if (message === undefined || message.length === 0) return undefined;
  return message.slice(0, 4_096);
}

function assertLifecycleActive(context?: AgentCapabilityLifecycleContext): void {
  if (context?.signal.aborted) {
    throw new DatabaseCapabilityError('ABORTED', 'Database Capability activation was cancelled.', true);
  }
  if (context?.deadline !== undefined) {
    const deadline = Date.parse(context.deadline);
    if (!Number.isFinite(deadline) || Date.now() >= deadline) {
      throw new DatabaseCapabilityError('ABORTED', 'Database Capability activation deadline expired.', true);
    }
  }
}

async function awaitLifecycleOperation<T>(
  operation: Promise<T>,
  context?: AgentCapabilityLifecycleContext,
): Promise<T> {
  assertLifecycleActive(context);
  if (context === undefined) return await operation;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    const abort = (): void => {
      reject(new DatabaseCapabilityError('ABORTED', 'Database Capability activation was cancelled.', true));
    };
    onAbort = abort;
    context.signal.addEventListener('abort', abort, { once: true });
    if (context.signal.aborted) abort();
    if (context.deadline !== undefined) {
      timeout = setTimeout(
        () => reject(new DatabaseCapabilityError('ABORTED', 'Database Capability activation deadline expired.', true)),
        Math.max(0, Date.parse(context.deadline) - Date.now()),
      );
      timeout.unref?.();
    }
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    if (onAbort !== undefined) context.signal.removeEventListener('abort', onAbort);
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function validateConnectionCandidates(value: unknown): readonly ConnectionCandidate[] {
  if (!Array.isArray(value) || value.length > MAX_EXTERNAL_CONNECTION_CANDIDATES) {
    throw new DatabaseCapabilityError(
      'NOT_CONFIGURED',
      `External database discovery must return 0-${MAX_EXTERNAL_CONNECTION_CANDIDATES} candidates.`,
      false,
    );
  }
  const ids = new Set<string>();
  const candidates = value.map((candidate) => {
    if (!isRecord(candidate)) {
      throw new DatabaseCapabilityError('NOT_CONFIGURED', 'External database candidate is invalid.', false);
    }
    requireExactKeys(candidate, ['candidateId', 'label', 'description', 'metadata', 'fingerprint'], 'candidate');
    const candidateId = requireExternalText(candidate.candidateId, 'candidateId', 200);
    if (ids.has(candidateId)) {
      throw new DatabaseCapabilityError('NOT_CONFIGURED', 'External database candidate ids must be unique.', false);
    }
    ids.add(candidateId);
    const label = requireExternalText(candidate.label, 'label', MAX_EXTERNAL_TEXT_CHARS);
    const fingerprint = requireExternalText(candidate.fingerprint, 'fingerprint', 256);
    const description = optionalExternalText(candidate.description, 'description', MAX_EXTERNAL_TEXT_CHARS);
    const metadata = validateExternalMetadata(candidate.metadata);
    const validated = Object.freeze({
      candidateId,
      label,
      fingerprint,
      ...(description === undefined ? {} : { description }),
      ...(metadata === undefined ? {} : { metadata }),
    });
    return validated;
  });
  candidates.sort((left, right) => compareUnicodeCodePoints(left.candidateId, right.candidateId));
  return Object.freeze(candidates);
}

function validateEphemeralConnectionBinding(
  value: unknown,
  candidate: ConnectionCandidate,
): EphemeralConnectionBinding {
  if (!isRecord(value)) {
    throw new DatabaseCapabilityError('NOT_CONFIGURED', 'External database provider returned an invalid binding.', false);
  }
  requireExactKeys(value, ['candidateId', 'fingerprint', 'profile', 'credential'], 'binding');
  const candidateId = requireExternalText(value.candidateId, 'candidateId', 200);
  const fingerprint = requireExternalText(value.fingerprint, 'fingerprint', 256);
  if (candidateId !== candidate.candidateId || fingerprint !== candidate.fingerprint) {
    throw new DatabaseCapabilityError(
      'NOT_CONFIGURED',
      'The external database context changed before it could be activated.',
      true,
    );
  }
  if (!isRecord(value.profile) || !isRecord(value.credential)) {
    throw new DatabaseCapabilityError('NOT_CONFIGURED', 'External database binding is missing a profile or credential.', false);
  }
  return Object.freeze({
    candidateId,
    fingerprint,
    profile: parseExternalConnectionProfile(value.profile),
    credential: parseDatabaseCredential(value.credential),
  });
}

function toRuntimeConnectionProfile(
  profile: ExternalConnectionProfile,
  providerId: string,
  candidate: ConnectionCandidate,
  scope: ResourceScope,
  now: string,
): ConnectionProfile {
  const cloned = parseExternalConnectionProfile(profile);
  const digest = createHash('sha256')
    .update(`${providerId}\u0000${candidate.candidateId}\u0000${candidate.fingerprint}`)
    .digest('hex');
  return {
    ...cloned,
    endpoints: cloned.endpoints.map((endpoint) => structuredClone(endpoint)),
    id: `external-${digest.slice(0, 40)}`,
    scope: structuredClone(scope),
    createdAt: now,
    updatedAt: now,
  };
}

function validateExternalMetadata(
  value: unknown,
): Readonly<Record<string, string | number | boolean | null>> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.keys(value).length > MAX_EXTERNAL_METADATA_FIELDS) {
    throw new DatabaseCapabilityError('NOT_CONFIGURED', 'External database candidate metadata is invalid.', false);
  }
  const metadata: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key)) {
      throw new DatabaseCapabilityError('NOT_CONFIGURED', 'External database candidate metadata key is invalid.', false);
    }
    if (
      item !== null &&
      typeof item !== 'string' &&
      typeof item !== 'number' &&
      typeof item !== 'boolean'
    ) {
      throw new DatabaseCapabilityError('NOT_CONFIGURED', 'External database candidate metadata must be scalar.', false);
    }
    if (typeof item === 'number' && !Number.isFinite(item)) {
      throw new DatabaseCapabilityError('NOT_CONFIGURED', 'External database candidate metadata is invalid.', false);
    }
    if (typeof item === 'string' && item.length > MAX_EXTERNAL_TEXT_CHARS) {
      throw new DatabaseCapabilityError('NOT_CONFIGURED', 'External database candidate metadata is too large.', false);
    }
    metadata[key] = item;
  }
  return Object.freeze(metadata);
}

function parseExternalConnectionProfile(value: unknown): ExternalConnectionProfile {
  if (!isRecord(value)) {
    throw new DatabaseCapabilityError('NOT_CONFIGURED', 'External database profile is invalid.', false);
  }
  requireExactKeys(value, [
    'name', 'connectorId', 'engine', 'endpoints', 'principal', 'purpose', 'readOnly',
    'defaultResourceId', 'defaultNamespace', 'network', 'sessionParameters', 'pool', 'labels',
  ], 'profile');
  if (!Array.isArray(value.endpoints) || value.endpoints.length === 0 || value.endpoints.length > 8) {
    throw new DatabaseCapabilityError('NOT_CONFIGURED', 'External database profile endpoints are invalid.', false);
  }
  const profile = Object.freeze({
    name: requireExternalText(value.name, 'profile name', MAX_EXTERNAL_TEXT_CHARS),
    connectorId: requireExternalText(value.connectorId, 'connectorId', 200),
    engine: requireExternalText(value.engine, 'engine', 100),
    endpoints: Object.freeze(value.endpoints.map((endpoint) => parseExternalEndpoint(endpoint))),
    ...(value.principal === undefined
      ? {}
      : { principal: requireExternalText(value.principal, 'principal', MAX_EXTERNAL_TEXT_CHARS) }),
    purpose: requireConnectionPurpose(value.purpose),
    readOnly: requireBoolean(value.readOnly, 'profile readOnly'),
    ...(value.defaultResourceId === undefined
      ? {}
      : { defaultResourceId: requireExternalText(value.defaultResourceId, 'defaultResourceId', 500) }),
    ...(value.defaultNamespace === undefined
      ? {}
      : { defaultNamespace: requireExternalText(value.defaultNamespace, 'defaultNamespace', 500) }),
    ...(value.network === undefined ? {} : { network: parseConnectionNetwork(value.network) }),
    ...(value.sessionParameters === undefined
      ? {}
      : { sessionParameters: parseScalarRecord(value.sessionParameters, 'sessionParameters') }),
    ...(value.pool === undefined ? {} : { pool: parseConnectionPool(value.pool) }),
    ...(value.labels === undefined ? {} : { labels: validateStringRecord(value.labels, 'labels') }),
  }) satisfies ExternalConnectionProfile;
  return profile;
}

function parseExternalEndpoint(value: unknown): ExternalConnectionProfile['endpoints'][number] {
  if (!isRecord(value)) {
    throw new DatabaseCapabilityError('NOT_CONFIGURED', 'External database endpoint is invalid.', false);
  }
  const transport = requireExternalText(value.transport, 'endpoint transport', 30);
  switch (transport) {
    case 'tcp': {
      requireExactKeys(value, ['transport', 'host', 'port', 'database', 'ssl'], 'tcp endpoint');
      return Object.freeze({
        transport,
        host: requireExternalText(value.host, 'endpoint host', 500),
        port: requireInteger(value.port, 'endpoint port', 1, 65_535),
        ...(value.database === undefined
          ? {}
          : { database: requireExternalText(value.database, 'endpoint database', 500) }),
        ...(value.ssl === undefined ? {} : { ssl: requireSslMode(value.ssl) }),
      });
    }
    case 'jdbc': {
      requireExactKeys(value, ['transport', 'url', 'driverClass', 'properties'], 'jdbc endpoint');
      return Object.freeze({
        transport,
        url: requireExternalText(value.url, 'JDBC URL', 2_048),
        ...(value.driverClass === undefined
          ? {}
          : { driverClass: requireExternalText(value.driverClass, 'JDBC driverClass', 500) }),
        ...(value.properties === undefined
          ? {}
          : { properties: validateStringRecord(value.properties, 'JDBC properties') }),
      });
    }
    case 'http': {
      requireExactKeys(value, ['transport', 'baseUrl', 'apiVersion', 'headers'], 'HTTP endpoint');
      return Object.freeze({
        transport,
        baseUrl: requireExternalText(value.baseUrl, 'HTTP baseUrl', 2_048),
        ...(value.apiVersion === undefined
          ? {}
          : { apiVersion: requireExternalText(value.apiVersion, 'HTTP apiVersion', 200) }),
        ...(value.headers === undefined
          ? {}
          : { headers: validateHttpHeaders(value.headers) }),
      });
    }
    case 'sdk': {
      requireExactKeys(value, ['transport', 'provider', 'account', 'region', 'options'], 'SDK endpoint');
      return Object.freeze({
        transport,
        provider: requireExternalText(value.provider, 'SDK provider', 200),
        ...(value.account === undefined
          ? {}
          : { account: requireExternalText(value.account, 'SDK account', 500) }),
        ...(value.region === undefined
          ? {}
          : { region: requireExternalText(value.region, 'SDK region', 200) }),
        ...(value.options === undefined
          ? {}
          : { options: validatePortableRecord(value.options, 'SDK options') }),
      });
    }
    case 'custom': {
      requireExactKeys(value, ['transport', 'scheme', 'options'], 'custom endpoint');
      return Object.freeze({
        transport,
        scheme: requireExternalText(value.scheme, 'custom scheme', 200),
        options: validatePortableRecord(value.options, 'custom options'),
      });
    }
    default:
      throw new DatabaseCapabilityError('NOT_CONFIGURED', 'External database endpoint transport is unsupported.', false);
  }
}

function parseDatabaseCredential(value: Record<string, unknown>): EphemeralConnectionBinding['credential'] {
  requireExactKeys(value, ['username', 'password', 'token', 'certificate', 'privateKey', 'properties'], 'credential');
  const properties = value.properties === undefined
    ? undefined
    : validateStringRecord(value.properties, 'credential properties');
  return Object.freeze({
    ...(value.username === undefined ? {} : { username: requireCredentialText(value.username, 'username') }),
    ...(value.password === undefined ? {} : { password: requireCredentialText(value.password, 'password') }),
    ...(value.token === undefined ? {} : { token: requireCredentialText(value.token, 'token') }),
    ...(value.certificate === undefined ? {} : { certificate: requireCredentialText(value.certificate, 'certificate') }),
    ...(value.privateKey === undefined ? {} : { privateKey: requireCredentialText(value.privateKey, 'privateKey') }),
    ...(properties === undefined ? {} : { properties }),
  });
}

function parseConnectionNetwork(value: unknown): NonNullable<ExternalConnectionProfile['network']> {
  if (!isRecord(value)) throw new DatabaseCapabilityError('NOT_CONFIGURED', 'External database network is invalid.', false);
  requireExactKeys(value, [
    'proxyUrl', 'sshTunnelRef', 'privateLinkId', 'connectTimeoutMs', 'statementTimeoutMs', 'keepAlive',
  ], 'network');
  return Object.freeze({
    ...(value.proxyUrl === undefined
      ? {}
      : { proxyUrl: requireExternalText(value.proxyUrl, 'proxyUrl', 2_048) }),
    ...(value.sshTunnelRef === undefined
      ? {}
      : { sshTunnelRef: requireExternalText(value.sshTunnelRef, 'sshTunnelRef', 500) }),
    ...(value.privateLinkId === undefined
      ? {}
      : { privateLinkId: requireExternalText(value.privateLinkId, 'privateLinkId', 500) }),
    ...(value.connectTimeoutMs === undefined
      ? {}
      : { connectTimeoutMs: requireInteger(value.connectTimeoutMs, 'connectTimeoutMs', 1, 86_400_000) }),
    ...(value.statementTimeoutMs === undefined
      ? {}
      : { statementTimeoutMs: requireInteger(value.statementTimeoutMs, 'statementTimeoutMs', 1, 86_400_000) }),
    ...(value.keepAlive === undefined ? {} : { keepAlive: requireBoolean(value.keepAlive, 'keepAlive') }),
  });
}

function parseConnectionPool(value: unknown): NonNullable<ExternalConnectionProfile['pool']> {
  if (!isRecord(value)) throw new DatabaseCapabilityError('NOT_CONFIGURED', 'External database pool is invalid.', false);
  requireExactKeys(value, ['min', 'max', 'idleTimeoutMs'], 'pool');
  const pool = Object.freeze({
    ...(value.min === undefined ? {} : { min: requireInteger(value.min, 'pool min', 0, 1_000) }),
    ...(value.max === undefined ? {} : { max: requireInteger(value.max, 'pool max', 1, 1_000) }),
    ...(value.idleTimeoutMs === undefined
      ? {}
      : { idleTimeoutMs: requireInteger(value.idleTimeoutMs, 'pool idleTimeoutMs', 1, 86_400_000) }),
  });
  if (pool.min !== undefined && pool.max !== undefined && pool.min > pool.max) {
    throw new DatabaseCapabilityError('NOT_CONFIGURED', 'External database pool min exceeds max.', false);
  }
  return pool;
}

function parseScalarRecord(value: unknown, name: string): Readonly<Record<string, string | number | boolean | null>> {
  if (!isRecord(value) || Object.keys(value).length > 64) {
    throw new DatabaseCapabilityError('NOT_CONFIGURED', `External database ${name} is invalid.`, false);
  }
  const output: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key) ||
        (item !== null && typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') ||
        (typeof item === 'number' && !Number.isFinite(item))) {
      throw new DatabaseCapabilityError('NOT_CONFIGURED', `External database ${name} is invalid.`, false);
    }
    output[key] = item;
  }
  return Object.freeze(output);
}

function validateStringRecord(value: unknown, name: string): Readonly<Record<string, string>> {
  if (!isRecord(value) || Object.keys(value).length > 64) {
    throw new DatabaseCapabilityError('NOT_CONFIGURED', `External database ${name} is invalid.`, false);
  }
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!key || key.length > 128 || typeof item !== 'string' || item.length > 16_384) {
      throw new DatabaseCapabilityError('NOT_CONFIGURED', `External database ${name} is invalid.`, false);
    }
    output[key] = item;
  }
  return Object.freeze(output);
}

function validateHttpHeaders(value: unknown): Readonly<Record<string, string>> {
  const headers = validateStringRecord(value, 'HTTP headers');
  for (const [name, headerValue] of Object.entries(headers)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/u.test(name) || /[\r\n]/u.test(headerValue)) {
      throw new DatabaseCapabilityError('NOT_CONFIGURED', 'External database HTTP headers are invalid.', false);
    }
    if (name.toLowerCase() === 'cookie') {
      throw new DatabaseCapabilityError(
        'NOT_CONFIGURED',
        'Cookie headers must stay in an execute-only HTTP or browser session.',
        false,
      );
    }
  }
  return headers;
}

function validatePortableRecord(value: unknown, name: string): Readonly<Record<string, PortableValue>> {
  if (!isRecord(value) || Object.keys(value).length > 64) {
    throw new DatabaseCapabilityError('NOT_CONFIGURED', `External database ${name} is invalid.`, false);
  }
  try {
    assertPortableValue(value);
  } catch {
    throw new DatabaseCapabilityError('NOT_CONFIGURED', `External database ${name} is invalid.`, false);
  }
  return Object.freeze(structuredClone(value) as Record<string, PortableValue>);
}

function requireConnectionPurpose(value: unknown): ExternalConnectionProfile['purpose'] {
  if (!['query', 'read-only', 'read-write', 'admin', 'monitor'].includes(String(value))) {
    throw new DatabaseCapabilityError('NOT_CONFIGURED', 'External database purpose is invalid.', false);
  }
  return value as ExternalConnectionProfile['purpose'];
}

function requireSslMode(value: unknown): boolean | 'require' | 'verify-ca' | 'verify-full' {
  if (typeof value === 'boolean' || ['require', 'verify-ca', 'verify-full'].includes(String(value))) {
    return value as boolean | 'require' | 'verify-ca' | 'verify-full';
  }
  throw new DatabaseCapabilityError('NOT_CONFIGURED', 'External database SSL mode is invalid.', false);
}

function requireInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new DatabaseCapabilityError('NOT_CONFIGURED', `External database ${name} is invalid.`, false);
  }
  return value as number;
}

function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') {
    throw new DatabaseCapabilityError('NOT_CONFIGURED', `External database ${name} is invalid.`, false);
  }
  return value;
}

function requireCredentialText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_048_576) {
    throw new DatabaseCapabilityError('NOT_CONFIGURED', `External database credential ${name} is invalid.`, false);
  }
  return value;
}

function requireExactKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new DatabaseCapabilityError('NOT_CONFIGURED', `External database ${name} contains unsupported fields.`, false);
  }
}

function compareUnicodeCodePoints(left: string, right: string): number {
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftPoint = left.codePointAt(leftIndex)!;
    const rightPoint = right.codePointAt(rightIndex)!;
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
    leftIndex += leftPoint > 0xffff ? 2 : 1;
    rightIndex += rightPoint > 0xffff ? 2 : 1;
  }
  if (leftIndex < left.length) return 1;
  if (rightIndex < right.length) return -1;
  return 0;
}

function externalProbeRevision(providerId: string, candidates: readonly ConnectionCandidate[]): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({ providerId, candidates: candidates.map(({ candidateId, fingerprint }) => ({ candidateId, fingerprint })) }))
    .digest('hex');
  return `external-db:${digest.slice(0, 32)}`;
}

function requireExternalText(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new DatabaseCapabilityError('NOT_CONFIGURED', `External database ${name} is invalid.`, false);
  }
  return value.trim();
}

function optionalExternalText(value: unknown, name: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  return requireExternalText(value, name, maxLength);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function freshnessBindingKey(profileId: string, connectionId: string): string {
  return `${profileId}\u0000${connectionId}`;
}

function savedConnectionFromProfileSession(
  profile: ConnectionProfile,
  session: ConnectionSession,
  now: string,
): SavedConnection {
  const endpoint = profile.endpoints[session.endpointIndex];
  if (!endpoint || endpoint.transport !== 'tcp' || endpoint.database === undefined) {
    throw new DatabaseCapabilityError(
      'CONNECTION_FAILED',
      'Only TCP database profiles with a database name can become the active SQL Capability profile.',
      false,
    );
  }
  return {
    id: session.connectionId,
    name: profile.name,
    engine: profile.engine,
    host: endpoint.host,
    port: endpoint.port,
    database: endpoint.database,
    username: profile.principal ?? '',
    ...(typeof endpoint.ssl === 'boolean' ? { ssl: endpoint.ssl } : {}),
    readOnly: profile.readOnly,
    ...(profile.network?.connectTimeoutMs === undefined
      ? {}
      : { connectionTimeoutMs: profile.network.connectTimeoutMs }),
    ...(profile.network?.statementTimeoutMs === undefined
      ? {}
      : { statementTimeoutMs: profile.network.statementTimeoutMs }),
    status: 'connected',
    createdAt: now,
    updatedAt: now,
  };
}

async function discoverCurrentResources(
  database: DatabaseAccessRuntime,
  profileId: string,
): Promise<{
  resources: ResourceDescriptor[];
  relations: ResourceRelation[];
  sourceRevision: string;
}> {
  const resources = new Map<string, ResourceDescriptor>();
  const relations = new Map<string, ResourceRelation>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await database.discoverPage(profileId, {
      ...(cursor === undefined ? {} : { cursor }),
      limit: 500,
    });
    pages += 1;
    if (pages > 10_000) {
      throw new DatabaseCapabilityError(
        'CONNECTION_FAILED',
        'Schema discovery exceeded 10,000 pages.',
        false,
      );
    }
    for (const resource of page.resources) resources.set(resource.id, resource);
    for (const relation of page.relations) relations.set(relation.id, relation);
    if (page.complete) {
      cursor = undefined;
      break;
    }
    if (!page.nextCursor) {
      throw new DatabaseCapabilityError(
        'CONNECTION_FAILED',
        'Schema discovery returned an incomplete page without a cursor.',
        false,
      );
    }
    if (seenCursors.has(page.nextCursor)) {
      throw new DatabaseCapabilityError(
        'CONNECTION_FAILED',
        'Schema discovery repeated a cursor.',
        false,
      );
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (cursor);
  const sortedResources = [...resources.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const sortedRelations = [...relations.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  return {
    resources: sortedResources,
    relations: sortedRelations,
    sourceRevision: schemaSourceRevision(profileId, sortedResources, sortedRelations),
  };
}

function schemaSourceRevision(
  profileId: string,
  resources: ResourceDescriptor[],
  relations: ResourceRelation[],
): string {
  const revisionInput = {
    profileId,
    resources: resources.map((resource) => ({
      id: resource.id,
      kind: resource.kind,
      nativeId: resource.nativeId,
      canonicalName: resource.canonicalName,
      displayName: resource.displayName ?? null,
      aliases: [...(resource.aliases ?? [])].sort(),
      engine: resource.engine ?? null,
      engineVersion: resource.engineVersion ?? null,
      scope: resource.scope ?? {},
      tags: resource.tags ?? {},
      attributes: resource.attributes ?? {},
      facts: Object.fromEntries(
        Object.entries(resource.facts ?? {})
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, candidates]) => [
            key,
            candidates
              .map((candidate) => ({
                value: candidate.value,
                confidence: candidate.confidence ?? null,
                source: {
                  sourceId: candidate.source.sourceId,
                  sourceType: candidate.source.sourceType,
                  connectorId: candidate.source.connectorId ?? null,
                  connectionProfileId: candidate.source.connectionProfileId ?? null,
                  priority: candidate.source.priority ?? null,
                },
              }))
              .sort((left, right) =>
                stringifyPublicJson(canonicalizeRevisionValue(left)).localeCompare(
                  stringifyPublicJson(canonicalizeRevisionValue(right)),
                ),
              ),
          ]),
      ),
      version: resource.version,
      deleted: resource.deletedAt !== undefined,
    })),
    relations: relations.map((relation) => ({
      id: relation.id,
      kind: relation.kind,
      fromResourceId: relation.fromResourceId,
      toResourceId: relation.toResourceId,
      attributes: relation.attributes ?? {},
      version: relation.version,
      deleted: relation.deletedAt !== undefined,
    })),
  };
  return `sha256:${createHash('sha256')
    .update(stringifyPublicJson(canonicalizeRevisionValue(revisionInput)))
    .digest('hex')}`;
}

function schemaSnapshotScopeDirectory(scope: ResourceScope): string {
  const encoded = stringifyPublicJson({
    tenantId: scope.tenantId ?? null,
    organizationId: scope.organizationId ?? null,
    projectId: scope.projectId ?? null,
    environment: scope.environment ?? null,
    region: scope.region ?? null,
  });
  return `scope-${createHash('sha256').update(encoded).digest('hex')}`;
}

function canonicalizeRevisionValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeRevisionValue);
  if (value instanceof Date || value instanceof Uint8Array) return value;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalizeRevisionValue(item)]),
    );
  }
  return value;
}

function collectContainedResources(roots: Set<string>, relations: ResourceRelation[]): Set<string> {
  const children = new Map<string, string[]>();
  for (const relation of relations) {
    if (relation.kind !== 'contains' || relation.deletedAt) continue;
    const values = children.get(relation.fromResourceId) ?? [];
    values.push(relation.toResourceId);
    children.set(relation.fromResourceId, values);
  }
  const excluded = new Set(roots);
  const queue = [...roots];
  for (let index = 0; index < queue.length; index += 1) {
    for (const childId of children.get(queue[index]!) ?? []) {
      if (excluded.has(childId)) continue;
      excluded.add(childId);
      queue.push(childId);
    }
  }
  return excluded;
}

async function waitForDatabaseJob(
  database: DatabaseAccessRuntime,
  initialJob: QueryJob,
  signal: AbortSignal,
): Promise<QueryJob> {
  let job = initialJob;
  while (!isTerminalDatabaseJob(job)) {
    if (signal.aborted) return await settleCancelledDatabaseJob(database, job);
    await waitForDatabaseJobPoll(signal);
    if (signal.aborted) return await settleCancelledDatabaseJob(database, job);
    try {
      job = await awaitBoundedDatabaseJobOperation(
        database.getJob(job.id),
        signal,
        'Database job status could not be confirmed.',
      );
    } catch (error) {
      if (error instanceof DatabaseJobAbortSignal) {
        return await settleCancelledDatabaseJob(database, job);
      }
      if (error instanceof DatabaseJobSettlementError) throw error;
      throw new DatabaseJobSettlementError('Database job status could not be confirmed.', error);
    }
  }
  return job;
}

async function settleCancelledDatabaseJob(
  database: DatabaseAccessRuntime,
  job: QueryJob,
): Promise<QueryJob> {
  let cancelled: QueryJob | undefined;
  try {
    cancelled = await awaitBoundedDatabaseJobOperation(
      database.cancel(job.id),
      undefined,
      'Database job cancellation could not be confirmed.',
    );
  } catch (error) {
    if (error instanceof DatabaseJobSettlementError) throw error;
  }
  if (cancelled !== undefined && isTerminalDatabaseJob(cancelled)) return cancelled;
  try {
    const observed = await awaitBoundedDatabaseJobOperation(
      database.getJob(job.id),
      undefined,
      'Database job cancellation could not be confirmed.',
    );
    if (isTerminalDatabaseJob(observed)) return observed;
  } catch (error) {
    if (error instanceof DatabaseJobSettlementError) throw error;
  }
  throw new DatabaseJobSettlementError('Database job cancellation could not be confirmed.');
}

async function waitForDatabaseJobPoll(signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, DATABASE_JOB_POLL_INTERVAL_MS));
  if (signal.aborted) throw new DatabaseJobAbortSignal();
}

async function awaitBoundedDatabaseJobOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMessage: string,
): Promise<T> {
  const observed = Promise.resolve(operation);
  // The driver call can settle after we have fenced this binding. Observe a
  // late rejection so it never becomes an unhandled background failure.
  void observed.catch(() => undefined);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let removeAbort: (() => void) | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new DatabaseJobSettlementError(timeoutMessage)), DATABASE_JOB_SETTLE_TIMEOUT_MS);
  });
  const aborted = signal === undefined ? undefined : new Promise<never>((_resolve, reject) => {
    const abort = () => reject(new DatabaseJobAbortSignal());
    removeAbort = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race(
      aborted === undefined ? [observed, timedOut] : [observed, timedOut, aborted],
    );
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    removeAbort?.();
  }
}

function isTerminalDatabaseJob(job: QueryJob): boolean {
  return ['succeeded', 'failed', 'cancelled', 'expired'].includes(job.state);
}

class DatabaseJobAbortSignal extends Error {
  constructor() {
    super('Database job polling was cancelled.');
    this.name = 'DatabaseJobAbortSignal';
  }
}

class DatabaseJobSettlementError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'DatabaseJobSettlementError';
    if (cause !== undefined) this.cause = cause;
  }
}

function mapDatabaseAccessError(error: unknown): DatabaseCapabilityError {
  if (error instanceof DatabaseCapabilityError) return error;
  if (error instanceof DatabaseJobSettlementError) {
    return new DatabaseCapabilityError('CONNECTION_FAILED', error.message, true);
  }
  if (error instanceof DatabaseAccessRuntimeError) {
    return new DatabaseCapabilityError(
      'CONNECTION_FAILED',
      error.error.message,
      error.error.retryable,
      error.error.detail,
    );
  }
  return asDatabaseCapabilityError(error);
}

function buildNl2SqlSystemPrompt(): string {
  return [
    'Generate exactly one read-only PostgreSQL query.',
    'Return only one JSON object with sql, explanation, and assumptions fields.',
    'The SQL must be one SELECT, read-only WITH, or VALUES statement.',
    'Use only the supplied tables and columns; prefer explicit columns and a reasonable LIMIT for detail queries.',
    'Do not return Markdown or text outside the JSON object.',
  ].join('\n');
}

function isExecutableSafety(safety: QuerySafetyReport): boolean {
  return (
    EXECUTABLE_STATEMENT_KINDS.has(safety.statementKind) &&
    safety.riskLevel === 'safe' &&
    !safety.blocked &&
    !safety.requiresConfirmation
  );
}

function safetyMessage(safety: QuerySafetyReport): string {
  const detail = safety.reasons.join(' ');
  return detail ? `Generated SQL was blocked: ${detail}` : 'Generated SQL is not read-only.';
}

function mapLlmError(error: unknown): DatabaseCapabilityError {
  if (error instanceof DatabaseCapabilityError) return error;
  if (error instanceof LlmProviderError) {
    if (error.code === 'LLM_ABORTED') {
      return new DatabaseCapabilityError('ABORTED', 'SQL generation was cancelled.', false);
    }
    return new DatabaseCapabilityError('LLM_REQUEST_FAILED', error.message, error.retryable);
  }
  const normalized = asDatabaseCapabilityError(error);
  if (normalized.code === 'ABORTED') return normalized;
  return new DatabaseCapabilityError('LLM_REQUEST_FAILED', normalized.message, true);
}

function toLlmGenerationRequest(
  config: LlmGenerationConfig,
): Pick<LlmChatRequest, 'temperature' | 'topP' | 'maxTokens' | 'seed' | 'stop' | 'reasoning'> {
  return {
    ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
    ...(config.topP === undefined ? {} : { topP: config.topP }),
    ...(config.maxOutputTokens === undefined ? {} : { maxTokens: config.maxOutputTokens }),
    ...(config.seed === undefined ? {} : { seed: config.seed }),
    ...(config.stop === undefined ? {} : { stop: [...config.stop] }),
    ...(config.reasoningEffort === undefined
      ? {}
      : { reasoning: { effort: config.reasoningEffort } }),
  };
}

function requireText(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new DatabaseCapabilityError('INVALID_INPUT', `${name} must not be blank.`, false);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new DatabaseCapabilityError(
      'INVALID_INPUT',
      `${name} must not exceed ${maxLength} characters.`,
      false,
    );
  }
  return normalized;
}

function normalizeInteger(value: number, name: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new DatabaseCapabilityError(
      'INVALID_INPUT',
      `${name} must be an integer between ${min} and ${max}.`,
      false,
    );
  }
  return value;
}

function emptySchemaStatus(stage: 'not_connected' | 'not_indexed'): SchemaIndexSnapshot {
  return {
    stage,
    ready: false,
    tableCount: 0,
    columnCount: 0,
    relationCount: 0,
    documentCount: 0,
    truncated: false,
  };
}

function cloneConnection(connection: SavedConnection): SavedConnection {
  return { ...connection };
}

function cloneRun(run: SqlRunSnapshot): SqlRunSnapshot {
  return {
    ...run,
    assumptions: [...run.assumptions],
    evidence: run.evidence.map((item) => ({ ...item, reasons: [...item.reasons] })),
    safety: {
      ...run.safety,
      reasons: [...run.safety.reasons],
      ...(run.safety.performanceWarnings === undefined
        ? {}
        : {
            performanceWarnings: run.safety.performanceWarnings.map((warning) => ({ ...warning })),
          }),
    },
    ...(run.usage === undefined ? {} : { usage: { ...run.usage } }),
    ...(run.error === undefined ? {} : { error: { ...run.error } }),
  };
}

function updateRun(run: SqlRunSnapshot, patch: Partial<SqlRunSnapshot>): SqlRunSnapshot {
  return cloneRun({ ...run, ...patch });
}

function toRunError(error: DatabaseCapabilityError) {
  return { code: error.code, message: error.message, retryable: error.retryable };
}

function waitForSharedOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  abortedError: () => Error,
): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(abortedError());
  return new Promise<T>((resolvePromise, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => {
      cleanup();
      reject(abortedError());
    };
    signal.addEventListener('abort', abort, { once: true });
    void operation.then(
      (value) => {
        cleanup();
        resolvePromise(value);
      },
      (error) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
