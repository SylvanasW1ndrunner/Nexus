import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import {
  AgentToolApprovalBroker,
  AgentSubagentPool,
  AgentSessionStore,
  ReactAgent,
  ToolRegistry,
  agentProjectReference,
  agentProjectStorageIdentity,
  assertSameAgentProject,
  createAgentProjectContext,
  defaultAgentStateDatabasePath,
  defaultAgentUserSkillsDirectory,
  isFinalResponseReady,
  type AgentContextCheckpoint,
  type AgentProjectContext,
  type AgentRunRecord,
  type AgentRunStore,
  type AgentSession,
} from '@dbagent/core-agent';
import {
  ConnectorRegistry,
  DatabaseAccessRuntime,
  DatabaseAccessRuntimeError,
  PostgresConnector,
  PostgresDriver,
  analyzeSqlSafety,
  type DatabaseConnectionConfig,
  type IDatabaseDriver,
} from '@dbagent/core-db';
import { ResourceRegistry } from '@dbagent/core-resource';
import {
  LlmRouter,
  LlmProviderError,
  type LlmGateway,
  type LlmAsyncJob,
  type LlmChatResponse,
  type LlmChatStreamEvent,
  type LlmGatewayResult,
  type LlmMetricsSnapshot,
  type LlmProvider,
  type RegisteredLlmModel,
} from '@dbagent/core-llm';
import {
  ProgressiveSchemaRagIndexer,
  SchemaRagEngine,
  SchemaRagSnapshotStore,
} from '@dbagent/core-rag';
import {
  SkillRegistry,
  systemSkillSource,
  type SkillDescriptor,
  type SkillOverlay,
} from '@dbagent/core-skills';
import {
  registerAgentRuntimeTools,
  registerAiSqlTools,
  registerSkillTools,
  registerSubagentTools,
  registerWebTools,
  registerWorkspaceTools,
  registerProcessTools,
  compileProjectContext,
  createMcpRuntimeLauncher,
  McpConfigStore,
  McpHealthManager,
  McpRuntimeManager,
  McpToolRegistrationManager,
  ProcessRuntime,
  type AiSqlQueryExecutionInput,
  type AiSqlResultStore,
  type StoredAiSqlResult,
  type McpServerConfig,
  type McpServerHealthState,
  type McpServerInput,
} from '@dbagent/core-tools';
import { UsageTracker } from '@dbagent/core-usage';
import {
  stringifyPublicJson,
  type ConnectionProfile,
  type QueryJob,
  type QueryExecutionResult,
  type QuerySafetyReport,
  type ResourceDescriptor,
  type ResourceRelation,
  type ResourceScope,
  type SavedConnection,
} from '@dbagent/shared';
import { DatabaseAgentError, asDatabaseAgentError } from './errors.js';
import { parseGeneratedSqlResponse } from './parse-generation.js';
import { SqlRunStore } from './sql-run-store.js';
import type {
  ConnectionTestResult,
  CompactAiSqlAgentSessionInput,
  CompactAiSqlAgentSessionResult,
  DatabaseAgentRuntimeOptions,
  ExecuteGeneratedOptions,
  ExecutedSqlRun,
  GenerateSqlInput,
  GeneratedSqlEvidence,
  GeneratedSqlRun,
  IndexSchemaOptions,
  InteractiveQueryResult,
  LlmRuntimeCallOptions,
  LlmRuntimeChatRequest,
  PostgresConnectionInput,
  RunAiSqlAgentInput,
  AiSqlAgentRun,
  AiSqlAgentRunView,
  AgentSessionListInput,
  AgentSessionListItem,
  AgentSessionView,
  AgentSkillCatalogEntry,
  AgentSkillListInput,
  AgentSkillRefreshResult,
  AgentApprovalRequest,
  McpServerStartSummary,
  McpServerStopSummary,
  McpServerSummary,
  RuntimeStatus,
  SchemaIndexSnapshot,
  SqlRunSnapshot,
} from './types.js';

const DEFAULT_ROW_LIMIT = 200;
const MAX_ROW_LIMIT = 1_000;
const DEFAULT_MAX_SCHEMA_TABLES = 200;
const MAX_SCHEMA_TABLES = 1_000;
const DEFAULT_CONTEXT_CHARS = 8_000;
const MAX_CONTEXT_CHARS = 20_000;
const MAX_QUESTION_CHARS = 4_000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
const DEFAULT_SCHEMA_FRESHNESS_INTERVAL_MS = 30_000;
const MAX_SCHEMA_FRESHNESS_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const SCHEMA_MISS_REFRESH_DEBOUNCE_MS = 5_000;
const DEFAULT_MODEL_METADATA_DISCOVERY_TIMEOUT_MS = 5_000;
const EXECUTABLE_STATEMENT_KINDS = new Set(['SELECT', 'WITH', 'VALUES']);

export class DatabaseAgentRuntime {
  private readonly driver: IDatabaseDriver;
  private readonly rag: SchemaRagEngine;
  private readonly ragIndexer: ProgressiveSchemaRagIndexer;
  private readonly createRunId: () => string;
  private readonly createConnectionId: () => string;
  private readonly now: () => string;
  private readonly defaultRowLimit: number;
  private readonly llmGateway: LlmGateway;
  private readonly llmRouter: LlmRouter;
  private readonly usageTracker: UsageTracker;
  private readonly reactAgent: ReactAgent;
  private readonly subagents: AgentSubagentPool;
  private readonly approvalBroker: AgentToolApprovalBroker | undefined;
  private readonly project: AgentProjectContext;
  private readonly defaultSessionSkills: SkillOverlay[];
  private readonly sessionSkillViews = new WeakMap<
    AgentSession,
    { baseRevision: number; registry: SkillRegistry }
  >();
  private readonly skillsReady: Promise<unknown>;
  private readonly dynamicToolDiscovery: boolean;
  private readonly defaultSystemPrompt: DatabaseAgentRuntimeOptions['systemPrompt'];
  private readonly defaultCapabilityInstructions: string[];
  private readonly defaultAllowedTools: string[] | undefined;
  private readonly defaultPinnedTools: string[];
  private readonly autoStartMcp: boolean;
  private mcpAutoStartPromise: Promise<unknown> | undefined;
  private readonly activeAgentRuns = new Set<Promise<unknown>>();
  private readonly activeAgentRunControllers = new Set<AbortController>();
  private readonly activeLlmOperations = new Set<Promise<unknown>>();
  private readonly activeLlmControllers = new Set<AbortController>();
  private readonly activeLlmStreamClosers = new Set<() => Promise<void>>();
  private readonly modelMetadataDiscovery = new Map<
    string,
    Promise<'completed' | 'cancelled'>
  >();
  private readonly agentRunRecovery: Promise<number>;
  private readonly agentRunStore: AgentRunStore;
  private readonly llmJobOwnerId = randomUUID();
  private closing = false;
  readonly tools: ToolRegistry;
  readonly skills: SkillRegistry;
  readonly results: AiSqlResultStore;
  readonly sessions: AgentSessionStore;
  readonly mcpConfig: McpConfigStore;
  readonly mcp: McpRuntimeManager;
  /** Session-isolated foreground/background process handles, when enabled. */
  readonly processes: ProcessRuntime | undefined;
  /**
   * Unified database/warehouse/cluster access API. Connector registration,
   * resources, capabilities, query jobs, transactions and operations all live
   * behind this stable SDK entrypoint.
   */
  readonly database: DatabaseAccessRuntime;
  /** Product-wide resource, graph, observation and state runtime. */
  readonly resources: ResourceRegistry;
  private readonly tenantId: string;
  private readonly resourceScope: ResourceScope;
  private readonly sqlRuns: SqlRunStore;
  private readonly ownsSqlRunStore: boolean;
  private sqlRunStoreClosed = false;
  private closedSqlRunCount = 0;
  private providerId?: string;
  private model?: string;
  private connection: SavedConnection | undefined;
  private readonly postgresConnector: PostgresConnector | undefined;
  private readonly usesDatabaseAccess: boolean;
  private legacyProfileId: string | undefined;
  private indexTruncated = false;
  private lastIndexMaxTables = DEFAULT_MAX_SCHEMA_TABLES;
  private schemaFreshnessPromise: Promise<void> | undefined;
  private readonly schemaFreshnessIntervalMs: number;
  private lastSchemaFreshnessCheckAt = 0;
  private lastForcedSchemaRefreshAt = 0;

  constructor(options: DatabaseAgentRuntimeOptions = {}) {
    if (options.schemaSnapshotDirectory !== undefined && !options.schemaSnapshotDirectory.trim()) {
      throw new TypeError('schemaSnapshotDirectory must not be blank');
    }
    const defaultDriver = options.driver ?? new PostgresDriver();
    this.driver = defaultDriver;
    if (options.databaseAccess) {
      this.database = options.databaseAccess;
      this.postgresConnector = undefined;
      this.usesDatabaseAccess = true;
    } else {
      const connectors = options.connectorRegistry ?? new ConnectorRegistry();
      const resources = options.resourceRegistry ?? new ResourceRegistry();
      const postgresDriver =
        defaultDriver instanceof PostgresDriver ? defaultDriver : new PostgresDriver();
      const postgresConnector = new PostgresConnector(postgresDriver);
      if (connectors.find({ engine: 'postgres', transport: 'tcp' }).length === 0) {
        connectors.register(postgresConnector);
      }
      for (const connector of options.connectors ?? []) {
        connectors.replace(connector);
      }
      this.database = new DatabaseAccessRuntime({
        connectors,
        resources,
        ...(options.credentialResolver ? { credentialResolver: options.credentialResolver } : {}),
        ...(options.databaseAuditSink ? { auditSink: options.databaseAuditSink } : {}),
      });
      this.postgresConnector = postgresConnector;
      this.usesDatabaseAccess = options.driver === undefined;
    }
    this.resources = this.database.resources;
    this.usageTracker = options.usageTracker ?? new UsageTracker();
    this.llmRouter = new LlmRouter(this.usageTracker);
    this.llmGateway = options.gateway ?? this.llmRouter.gateway;
    this.tenantId = options.tenantId?.trim() || 'local-default';
    this.rag =
      options.rag ??
      new SchemaRagEngine({
        ...(options.retrievalProfile === undefined
          ? {}
          : { retrievalProfile: options.retrievalProfile }),
        ...(options.retrievalProfile?.embedding === undefined
          ? {}
          : {
              embeddingAdapter: {
                embed: async ({ profile, texts }) => {
                  const response = await this.llmGateway.embed({
                    providerId: profile.providerInstanceId,
                    request: {
                      model: profile.modelId,
                      input: texts,
                      ...(profile.dimensions === undefined
                        ? {}
                        : { dimensions: profile.dimensions }),
                    },
                    context: {
                      tenantId: this.tenantId,
                      taskType: 'schema-rag-embedding',
                    },
                  });
                  return response.embeddings;
                },
              },
            }),
        ...(options.retrievalProfile?.reranker === undefined
          ? {}
          : {
              rerankAdapter: {
                rerank: async ({ profile, query, documents }) => {
                  const response = await this.llmGateway.rerank({
                    providerId: profile.providerInstanceId,
                    request: {
                      model: profile.modelId,
                      query,
                      documents: documents.map((document) => document.text),
                      ...(profile.topN === undefined ? {} : { topN: profile.topN }),
                    },
                    context: {
                      tenantId: this.tenantId,
                      taskType: 'schema-rag-rerank',
                    },
                  });
                  return response.results
                    .map((item) => {
                      const document = documents[item.index];
                      return document ? { id: document.id, score: item.score } : undefined;
                    })
                    .filter(
                      (
                        item,
                      ): item is {
                        id: string;
                        score: number;
                      } => item !== undefined,
                    );
                },
              },
            }),
      });
    this.createRunId = options.createRunId ?? randomUUID;
    this.createConnectionId = options.createConnectionId ?? randomUUID;
    this.now = options.now ?? (() => new Date().toISOString());
    this.defaultRowLimit = normalizeInteger(
      options.defaultRowLimit ?? DEFAULT_ROW_LIMIT,
      'defaultRowLimit',
      1,
      MAX_ROW_LIMIT,
    );
    this.schemaFreshnessIntervalMs = normalizeInteger(
      options.schemaFreshnessIntervalMs ?? DEFAULT_SCHEMA_FRESHNESS_INTERVAL_MS,
      'schemaFreshnessIntervalMs',
      0,
      MAX_SCHEMA_FRESHNESS_INTERVAL_MS,
    );
    this.tools = new ToolRegistry();
    this.project = createAgentProjectContext(resolve(options.projectDirectory ?? process.cwd()));
    const stateDatabasePath = options.sessionDatabasePath ?? defaultAgentStateDatabasePath();
    this.ownsSqlRunStore = options.sqlRunStore === undefined;
    this.sqlRuns =
      options.sqlRunStore ??
      new SqlRunStore({
        filePath: stateDatabasePath,
        projectKey: agentProjectStorageIdentity(agentProjectReference(this.project)).projectKey,
        now: this.now,
      });
    this.resourceScope = {
      tenantId: this.tenantId,
      projectId: agentProjectStorageIdentity(agentProjectReference(this.project)).projectKey,
    };
    this.ragIndexer = new ProgressiveSchemaRagIndexer({
      engine: this.rag,
      ...(options.schemaSnapshotDirectory === undefined
        ? {}
        : {
            snapshotStore: new SchemaRagSnapshotStore({
              rootDir: resolve(
                this.project.rootPath,
                options.schemaSnapshotDirectory,
                schemaSnapshotScopeDirectory(this.resourceScope),
              ),
            }),
          }),
    });
    this.defaultSessionSkills = structuredClone(options.sessionSkills ?? []);
    this.skills = new SkillRegistry({
      sources: [
        systemSkillSource(),
        {
          scope: 'user',
          path: options.userSkillsDirectory ?? defaultAgentUserSkillsDirectory(),
          id: 'schemanaut-user',
        },
        {
          scope: 'project',
          path: this.project.skillsDirectory,
          id: 'schemanaut-project',
        },
      ],
    });
    this.skillsReady = this.skills.refresh();
    this.dynamicToolDiscovery = options.dynamicToolDiscovery ?? true;
    this.defaultSystemPrompt =
      options.systemPrompt === undefined ? undefined : structuredClone(options.systemPrompt);
    this.defaultCapabilityInstructions = normalizeInstructionList(
      options.capabilityInstructions,
      'capabilityInstructions',
    );
    this.defaultAllowedTools = normalizeOptionalNameList(options.allowedTools, 'allowedTools');
    this.defaultPinnedTools = normalizeNameList(options.pinnedTools, 'pinnedTools');
    this.sessions = (
      options.sessionStore ??
      new AgentSessionStore(stateDatabasePath)
    ).forProject(agentProjectReference(this.project));
    const agentRunStore = options.agentDependencies?.runStore ?? this.sessions;
    this.agentRunStore = agentRunStore;
    registerAgentRuntimeTools(this.tools);
    registerSkillTools(this.tools, (session) => this.skillRegistryForSession(session), {
      isAvailable: (descriptor) => this.isSkillAvailable(descriptor),
    });
    const processToolsEnabled = options.enableProcessTools ?? options.enableShellTool ?? false;
    this.processes =
      processToolsEnabled || options.processRuntime
        ? options.processRuntime ??
          new ProcessRuntime({
            spoolDirectory: join(this.project.configDirectory, 'runtime', 'processes'),
          })
        : undefined;
    registerWorkspaceTools(this.tools, {
      rootPath: this.project.rootPath,
      ...(options.enableShellTool === undefined ? {} : { enableShell: options.enableShellTool }),
      ...(this.processes === undefined ? {} : { processRuntime: this.processes }),
    });
    if (processToolsEnabled && this.processes) {
      registerProcessTools(this.tools, {
        rootPath: this.project.rootPath,
        runtime: this.processes,
      });
    }
    if (options.webAdapter) registerWebTools(this.tools, options.webAdapter);
    this.mcpConfig = new McpConfigStore(this.project.mcpConfigPath);
    this.mcp = new McpRuntimeManager({
      configStore: this.mcpConfig,
      health: new McpHealthManager(),
      tools: new McpToolRegistrationManager(this.tools),
      launcher: createMcpRuntimeLauncher({
        cwd: this.project.rootPath,
        ...(options.mcpSecretResolver === undefined
          ? {}
          : { resolveSecret: options.mcpSecretResolver }),
      }),
    });
    this.autoStartMcp = options.autoStartMcp ?? false;
    this.results = registerAiSqlTools({
      registry: this.tools,
      driver: this.driver,
      queryExecutor: (input) => this.executeAiSqlQuery(input),
      rag: this.rag,
      getActiveConnection: () =>
        this.connection
          ? { connectionId: this.connection.id, connection: this.connection }
          : undefined,
      ...(options.resultStore === undefined ? {} : { resultStore: options.resultStore }),
      ensureSchemaFresh: async ({ connectionId, force, signal }) => {
        const connection = this.requireConnection();
        if (connection.id !== connectionId) {
          throw new DatabaseAgentError(
            'CONNECTION_FAILED',
            'The active connection changed during Schema refresh.',
            true,
          );
        }
        await this.ensureSchemaFresh(connection, signal, force);
      },
      onSchemaChanged: async () => {
        if (this.connection) await this.indexSchema({ maxTables: this.lastIndexMaxTables });
      },
    });
    this.approvalBroker =
      options.approvalProvider === undefined ? new AgentToolApprovalBroker() : undefined;
    this.reactAgent = new ReactAgent(
      this.llmRouter,
      this.tools,
      this.usageTracker,
      options.approvalProvider ?? this.approvalBroker?.createProvider(),
      {
        ...(options.agentDependencies ?? {}),
        sessionStore: this.sessions,
        runStore: agentRunStore,
        createRunId: options.agentDependencies?.createRunId ?? this.createRunId,
      },
    );
    this.agentRunRecovery = this.reactAgent.waitForRunRecovery();
    this.subagents = new AgentSubagentPool((runOptions) => this.reactAgent.run(runOptions), {
      store: this.sessions,
      steer: (childSessionId, message) => this.reactAgent.steer(childSessionId, message),
    });
    registerSubagentTools(this.tools, {
      pool: this.subagents,
      buildRunOptions: async (task, context) => {
        const { providerId, model } = this.requireModelConfiguration();
        await this.skillsReady;
        const effectiveSkills = this.skillRegistryForSession(context.session);
        const projectInstructions = await this.compileProjectInstructions(effectiveSkills);
        const runSignal = context.runSignal ?? context.signal;
        const allowedTools = this.availableToolNames(
          context.allowedTools ?? this.defaultAllowedTools,
        );
        const pinnedTools = this.defaultPinnedTools.filter(
          (name) => allowedTools === undefined || allowedTools.includes(name),
        );
        return {
          providerId,
          model,
          userMessage: task,
          ...(context.session.userId === undefined ? {} : { userId: context.session.userId }),
          mode: context.session.mode,
          ...(context.session.knowledgeSnapshot === undefined
            ? {}
            : {
                knowledgeSnapshot: structuredClone(context.session.knowledgeSnapshot),
              }),
          project: agentProjectReference(this.project),
          ...(projectInstructions?.trim() ? { projectInstructions } : {}),
          ...(this.defaultSystemPrompt === undefined
            ? {}
            : { systemPrompt: structuredClone(this.defaultSystemPrompt) }),
          ...(this.defaultCapabilityInstructions.length === 0
            ? {}
            : { capabilityInstructions: [...this.defaultCapabilityInstructions] }),
          ...(allowedTools === undefined ? {} : { allowedTools }),
          ...(pinnedTools.length === 0
            ? {}
            : { pinnedTools }),
          skillCatalog: this.skillCatalogForModel(effectiveSkills),
          ...(context.session.sessionSkills === undefined
            ? {}
            : { sessionSkills: structuredClone(context.session.sessionSkills) }),
          dynamicToolDiscovery: this.dynamicToolDiscovery,
          ...(runSignal === undefined ? {} : { signal: runSignal }),
        };
      },
    });
    if (options.provider || options.model) {
      if (!options.provider || !options.model?.trim()) {
        throw new DatabaseAgentError('INVALID_INPUT', 'provider 和 model 必须同时配置。', false);
      }
      this.configureProvider(options.provider, options.model);
    }
  }

  configureProvider(provider: LlmProvider, model: string): void {
    const normalizedModel = requireText(model, 'model', 300);
    this.modelMetadataDiscovery.delete(`${provider.id}\u0000${normalizedModel}`);
    this.llmGateway.registerProvider(provider);
    if (this.llmGateway !== this.llmRouter.gateway) {
      this.llmRouter.registerProvider(provider);
    }
    this.llmGateway.registerModel({ providerId: provider.id, model: normalizedModel });
    this.providerId = provider.id;
    this.model = normalizedModel;
  }

  async testConnection(input: PostgresConnectionInput): Promise<ConnectionTestResult> {
    const config = normalizeConnection(input, input.id ?? 'connection-test');
    if (this.usesDatabaseAccess) {
      const profile = toPostgresProfile(config, this.now(), this.resourceScope);
      this.database.createProfile(profile);
      try {
        const result = await this.database.testProfile(profile.id, {
          username: config.username,
          ...(config.password ? { password: config.password } : {}),
        });
        return { latencyMs: result.latencyMs ?? 0, readOnly: config.readOnly };
      } catch (error) {
        throw mapDatabaseAccessError(error);
      } finally {
        this.database.deleteProfile(profile.id);
      }
    }
    const result = await this.driver.test(config);
    if (!result.ok) {
      throw new DatabaseAgentError(
        'CONNECTION_FAILED',
        result.error.message,
        result.error.retryable ?? true,
        result.error.detail,
      );
    }
    return { latencyMs: result.data.latencyMs, readOnly: config.readOnly };
  }

  async connect(input: PostgresConnectionInput): Promise<SavedConnection> {
    if (this.connection) await this.disconnect();
    const config = normalizeConnection(input, input.id ?? this.createConnectionId());
    if (this.usesDatabaseAccess) {
      const profile = toPostgresProfile(config, this.now(), this.resourceScope);
      this.database.createProfile(profile);
      try {
        const session = await this.database.connect(profile.id, {
          username: config.username,
          ...(config.password ? { password: config.password } : {}),
        });
        const connection =
          this.postgresConnector?.getLegacyConnection(profile.id) ??
          savedConnectionFromDatabaseSession(config, session.connectionId, this.now());
        this.connection = connection;
        this.legacyProfileId = profile.id;
        this.indexTruncated = false;
        this.lastIndexMaxTables = DEFAULT_MAX_SCHEMA_TABLES;
        const restored = await this.ragIndexer.restore(connection.id);
        if (restored?.ready) this.restoreSchemaIndexOptions(connection.id);
        return cloneConnection(connection);
      } catch (error) {
        this.database.deleteProfile(profile.id);
        throw mapDatabaseAccessError(error);
      }
    }
    const result = await this.driver.connect(config);
    if (!result.ok) {
      throw new DatabaseAgentError(
        'CONNECTION_FAILED',
        result.error.message,
        result.error.retryable ?? true,
        result.error.detail,
      );
    }
    this.connection = result.data;
    this.indexTruncated = false;
    this.lastIndexMaxTables = DEFAULT_MAX_SCHEMA_TABLES;
    const restored = await this.ragIndexer.restore(result.data.id);
    if (restored?.ready) this.restoreSchemaIndexOptions(result.data.id);
    return cloneConnection(result.data);
  }

  async disconnect(): Promise<void> {
    const current = this.connection;
    if (!current) return;
    if (this.usesDatabaseAccess && this.legacyProfileId) {
      const profileId = this.legacyProfileId;
      try {
        await this.database.disconnect(profileId);
        this.database.deleteProfile(profileId);
      } catch (error) {
        throw mapDatabaseAccessError(error);
      }
      this.legacyProfileId = undefined;
    } else {
      const result = await this.driver.disconnect(current.id);
      if (!result.ok) {
        throw new DatabaseAgentError(
          'CONNECTION_FAILED',
          result.error.message,
          result.error.retryable ?? true,
          result.error.detail,
        );
      }
    }
    this.rag.clear(current.id);
    this.connection = undefined;
    this.indexTruncated = false;
    this.lastIndexMaxTables = DEFAULT_MAX_SCHEMA_TABLES;
    this.schemaFreshnessPromise = undefined;
    this.lastSchemaFreshnessCheckAt = 0;
    this.lastForcedSchemaRefreshAt = 0;
  }

  async close(): Promise<void> {
    this.closing = true;
    const failures: unknown[] = [];
    for (const controller of this.activeAgentRunControllers) {
      controller.abort();
    }
    for (const controller of this.activeLlmControllers) {
      controller.abort();
    }
    for (const job of this.llmGateway.listJobs(this.tenantId, this.llmJobOwnerId)) {
      if (job?.status === 'queued' || job?.status === 'running') {
        this.llmGateway.cancelJob(job.id, this.tenantId, this.llmJobOwnerId);
      }
    }
    await Promise.allSettled(
      [...this.activeLlmStreamClosers].map(async (closeStream) => closeStream()),
    );
    const subagents = this.subagents.list();
    for (const subagent of subagents) {
      if (subagent.status === 'running') this.subagents.stop(subagent.id);
    }
    for (const request of this.approvalBroker?.listPending() ?? []) {
      this.approvalBroker?.cancel(request.id, 'runtime closed');
    }
    await Promise.allSettled(subagents.map((subagent) => this.subagents.wait(subagent.id, 30_000)));
    await Promise.allSettled([...this.activeAgentRuns]);
    await Promise.allSettled([...this.activeLlmOperations]);
    try {
      await this.mcp.stopAll();
    } catch (error) {
      failures.push(error);
    }
    if (this.processes) {
      try {
        await this.processes.close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (this.connection) {
      try {
        await this.disconnect();
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await this.database.close();
    } catch (error) {
      failures.push(error);
    }
    this.results.clear();
    if (this.ownsSqlRunStore && !this.sqlRunStoreClosed) {
      this.closedSqlRunCount = this.sqlRuns.count();
      this.sqlRuns.close();
      this.sqlRunStoreClosed = true;
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'SchemaNaut runtime did not close cleanly.');
    }
  }

  async indexSchema(options: IndexSchemaOptions = {}): Promise<SchemaIndexSnapshot> {
    const connection = this.requireConnection();
    const maxTables = normalizeInteger(
      options.maxTables ?? DEFAULT_MAX_SCHEMA_TABLES,
      'maxTables',
      1,
      MAX_SCHEMA_TABLES,
    );
    if (this.usesDatabaseAccess && this.legacyProfileId) {
      const discovery = await discoverCurrentResources(this.database, this.legacyProfileId);
      return await this.indexDiscoveredSchema(connection, discovery, maxTables);
    }
    const listed = await this.driver.listTables(connection.id);
    if (!listed.ok) {
      throw new DatabaseAgentError(
        'CONNECTION_FAILED',
        listed.error.message,
        listed.error.retryable ?? true,
        listed.error.detail,
      );
    }
    const selected = listed.data.slice(0, maxTables);
    const tables = await mapInBatches(selected, 4, async (table) => {
      const described = await this.driver.describeTable(connection.id, table.schema, table.name);
      if (!described.ok) {
        throw new DatabaseAgentError(
          'CONNECTION_FAILED',
          described.error.message,
          described.error.retryable ?? true,
          described.error.detail,
        );
      }
      return described.data;
    });
    await this.ragIndexer.indexAsync({
      connectionId: connection.id,
      tables,
      sourceTableCount: listed.data.length,
      maxTables,
      indexedAt: this.now(),
    });
    this.indexTruncated = listed.data.length > selected.length;
    this.lastIndexMaxTables = maxTables;
    this.lastSchemaFreshnessCheckAt = Date.now();
    return this.schemaStatus();
  }

  schemaStatus(): SchemaIndexSnapshot {
    const connection = this.connection;
    if (!connection) {
      return emptySchemaStatus('not_connected');
    }
    const status = this.rag.getIndexStatus(connection.id);
    if (!status.ready) {
      return {
        connectionId: connection.id,
        ...emptySchemaStatus('not_indexed'),
      };
    }
    return {
      connectionId: connection.id,
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

  status(): RuntimeStatus {
    return {
      providerConfigured: Boolean(this.providerId && this.model),
      ...(this.providerId === undefined ? {} : { providerId: this.providerId }),
      ...(this.model === undefined ? {} : { model: this.model }),
      connected: Boolean(this.connection),
      ...(this.connection === undefined ? {} : { connection: cloneConnection(this.connection) }),
      schema: this.schemaStatus(),
      runCount: this.sqlRunStoreClosed ? this.closedSqlRunCount : this.sqlRuns.count(),
      llm: {
        modelCount: this.llmGateway.registry.listModels().length,
        metrics: this.llmGateway.metricsSnapshot(),
      },
    };
  }

  runAgent(input: RunAiSqlAgentInput): Promise<AiSqlAgentRun> {
    if (this.closing) {
      return Promise.reject(
        new DatabaseAgentError('ABORTED', 'SchemaNaut runtime is closing.', false),
      );
    }
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(input.signal?.reason);
    if (input.signal?.aborted) forwardAbort();
    else input.signal?.addEventListener('abort', forwardAbort, { once: true });
    this.activeAgentRunControllers.add(controller);
    const runPromise = this.runAgentInternal({
      ...input,
      signal: controller.signal,
    });
    this.activeAgentRuns.add(runPromise);
    return runPromise.finally(() => {
      input.signal?.removeEventListener('abort', forwardAbort);
      this.activeAgentRunControllers.delete(controller);
      this.activeAgentRuns.delete(runPromise);
    });
  }

  private async runAgentInternal(input: RunAiSqlAgentInput): Promise<AiSqlAgentRun> {
    const { providerId, model } = this.requireModelConfiguration();
    await this.ensureSelectedModelMetadata(providerId, model, input.signal);
    await this.skillsReady;
    await this.skills.refresh();
    await this.ensureMcpAutoStarted();
    const connection = this.connection;
    if (connection) this.scheduleSchemaFreshness(connection);
    const rawMessage = requireText(input.message, 'message', MAX_QUESTION_CHARS);
    if (input.session && input.sessionId?.trim()) {
      throw new DatabaseAgentError('INVALID_INPUT', 'session 与 sessionId 只能提供一个。', false);
    }
    if (input.sessionSkills !== undefined && (input.session || input.sessionId?.trim())) {
      throw new DatabaseAgentError(
        'INVALID_INPUT',
        'sessionSkills 只能在创建新 Session 时提供，不能替换已存在 Session 的私有 Skills。',
        false,
      );
    }
    let initialSession =
      input.session ??
      (input.sessionId?.trim() ? await this.sessions.load(input.sessionId.trim()) : undefined);
    if (input.sessionId?.trim() && !initialSession) {
      throw new DatabaseAgentError(
        'INVALID_INPUT',
        `未找到 Session：${input.sessionId.trim()}`,
        false,
      );
    }
    if (initialSession) this.assertSessionProject(initialSession);
    if (initialSession?.activeSkills?.length) {
      const sessionRegistry = this.skills.createSessionView(initialSession.sessionSkills ?? []);
      const activeSkills = initialSession.activeSkills;
      initialSession = structuredClone(initialSession);
      initialSession.activeSkills = activeSkills.filter((skill) => {
        const descriptor = sessionRegistry.inspect({ name: skill.name, scope: skill.scope });
        return descriptor !== undefined && this.isSkillAvailable(descriptor);
      });
    }
    const existingResultIds = new Set(
      initialSession === undefined
        ? []
        : this.results.listSession(initialSession.id).map((item) => item.id),
    );
    const sessionSkills =
      initialSession?.sessionSkills ?? input.sessionSkills ?? this.defaultSessionSkills;
    const effectiveSkills = this.skills.createSessionView(sessionSkills);
    const knowledgeSnapshot =
      connection && this.rag.hasIndex(connection.id)
        ? (() => {
            const catalog = this.rag.getCatalog(connection.id);
            const manifest = this.rag.getIndexManifest(connection.id);
            return {
              connectionId: connection.id,
              knowledgeSnapshotId: catalog.snapshotId,
              catalogRootHash: catalog.catalogRootHash,
              retrievalProfileId: manifest.retrievalProfileId,
              indexVersion: manifest.indexVersion,
            };
          })()
        : undefined;
    const invokedSkill = await effectiveSkills.invoke(rawMessage);
    if (invokedSkill && !this.isSkillAvailable(invokedSkill.skill)) {
      throw new DatabaseAgentError(
        'NOT_CONFIGURED',
        `Skill ${invokedSkill.skill.name} requires a capability that is not currently available.`,
        true,
      );
    }
    const message =
      invokedSkill === undefined
        ? rawMessage
        : invokedSkill.arguments ||
          `Follow the activated Skill "${invokedSkill.skill.name}" and complete its workflow using the available project capabilities.`;
    const projectInstructions = await this.compileProjectInstructions(effectiveSkills);
    const requestedAllowedTools =
      input.allowedTools === undefined
        ? this.defaultAllowedTools
        : normalizeNameList(input.allowedTools, 'allowedTools');
    const allowedTools = this.availableToolNames(requestedAllowedTools);
    const pinnedTools = uniqueNames([
      ...this.defaultPinnedTools,
      ...normalizeNameList(input.pinnedTools, 'pinnedTools'),
    ]).filter((name) => allowedTools === undefined || allowedTools.includes(name));
    const capabilityInstructions = [
      ...this.defaultCapabilityInstructions,
      ...normalizeInstructionList(input.capabilityInstructions, 'capabilityInstructions'),
    ];
    const runPromise = this.reactAgent.run({
      providerId,
      model,
      userMessage: message,
      ...(input.userId === undefined ? {} : { userId: input.userId }),
      mode: input.mode ?? 'read',
      ...(knowledgeSnapshot === undefined ? {} : { knowledgeSnapshot }),
      ...(initialSession === undefined ? {} : { initialSession }),
      project: agentProjectReference(this.project),
      ...(projectInstructions?.trim() ? { projectInstructions } : {}),
      ...((input.systemPrompt ?? this.defaultSystemPrompt) === undefined
        ? {}
        : { systemPrompt: structuredClone(input.systemPrompt ?? this.defaultSystemPrompt!) }),
      ...(capabilityInstructions.length === 0 ? {} : { capabilityInstructions }),
      ...(allowedTools === undefined ? {} : { allowedTools }),
      ...(pinnedTools.length === 0 ? {} : { pinnedTools }),
      skillCatalog: this.skillCatalogForModel(effectiveSkills),
      ...(invokedSkill === undefined
        ? {}
        : {
            activatedSkills: [
              {
                name: invokedSkill.skill.name,
                description: invokedSkill.skill.description,
                scope: invokedSkill.skill.scope,
                instructions: invokedSkill.skill.instructions,
              },
            ],
          }),
      ...(initialSession !== undefined || sessionSkills.length === 0
        ? {}
        : { sessionSkills: structuredClone(sessionSkills) }),
      dynamicToolDiscovery: this.dynamicToolDiscovery,
      ...(input.onEvent === undefined ? {} : { eventSink: input.onEvent }),
      ...(input.maxIterations === undefined ? {} : { maxIterations: input.maxIterations }),
      ...(input.maxToolExecutionMs === undefined
        ? {}
        : { maxToolExecutionMs: input.maxToolExecutionMs }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const result = await runPromise;
    return {
      activatedSkills: (result.session.activeSkills ?? []).map((skill) => skill.name),
      queryResults: this.results
        .listSession(result.session.id)
        .filter((item) => !existingResultIds.has(item.id))
        .map(toInteractiveQueryResult),
      result,
    };
  }

  steerAgentSession(sessionId: string, message: string): boolean {
    const id = requireText(sessionId, 'sessionId', 300);
    const content = requireText(message, 'message', MAX_QUESTION_CHARS);
    this.approvalBroker?.cancelSession(id);
    return this.reactAgent.steer(id, content);
  }

  async listAgentSessions(input: AgentSessionListInput = {}): Promise<AgentSessionListItem[]> {
    return (await this.sessions.list(input)).map((session) => ({
      id: session.id,
      title: session.title,
      ...(session.userId === undefined ? {} : { userId: session.userId }),
      mode: session.mode,
      archived: session.archived,
      conversationMessageCount: Math.max(0, session.messageCount - session.toolMessageCount),
      tokenUsage: { ...session.tokenUsage },
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      ...(session.lastMessageAt === undefined ? {} : { lastMessageAt: session.lastMessageAt }),
    }));
  }

  async getAgentSession(sessionId: string): Promise<AgentSessionView | undefined> {
    const session = await this.sessions.load(requireText(sessionId, 'sessionId', 300));
    return session === undefined ? undefined : toAgentSessionView(session);
  }

  async getAgentRun(runId: string): Promise<AgentRunRecord | undefined> {
    await this.agentRunRecovery;
    return await this.agentRunStore.getRun(requireText(runId, 'runId', 300));
  }

  async listAgentRuns(sessionId?: string, limit?: number): Promise<AgentRunRecord[]> {
    await this.agentRunRecovery;
    return await this.agentRunStore.listRuns(
      sessionId === undefined ? undefined : requireText(sessionId, 'sessionId', 300),
      limit,
    );
  }

  async deleteAgentSession(sessionId: string): Promise<boolean> {
    const id = requireText(sessionId, 'sessionId', 300);
    return await this.reactAgent.runSessionOperation(id, async () => {
      const deleted = await this.sessions.delete(id);
      if (deleted) this.results.clearSession(id);
      return deleted;
    });
  }

  async listAgentSkills(input: AgentSkillListInput = {}): Promise<AgentSkillCatalogEntry[]> {
    await this.skillsReady;
    if (!input.sessionId?.trim()) return this.skills.catalogForModel();
    const session = await this.sessions.load(requireText(input.sessionId, 'sessionId', 300));
    if (!session) {
      throw new DatabaseAgentError(
        'INVALID_INPUT',
        `未找到 Session：${input.sessionId.trim()}`,
        false,
      );
    }
    this.assertSessionProject(session);
    return this.skillRegistryForSession(session).catalogForModel();
  }

  async refreshSkills(): Promise<AgentSkillRefreshResult> {
    return await this.skills.refresh();
  }

  listAgentApprovals(): AgentApprovalRequest[] {
    return this.approvalBroker?.listPending() ?? [];
  }

  resolveAgentApproval(
    requestId: string,
    approved: boolean,
    options: { resolvedBy?: string; reason?: string } = {},
  ): boolean {
    const broker = this.approvalBroker;
    if (!broker) return false;
    const id = requireText(requestId, 'requestId', 300);
    return approved ? broker.approve(id, options) : broker.deny(id, options);
  }

  async listMcpServers(): Promise<McpServerSummary[]> {
    const servers = await this.mcpConfig.list();
    return servers.map((server) =>
      toMcpServerSummary(server, this.mcp.health(server.id), this.mcp.isRunning(server.id)),
    );
  }

  async upsertMcpServer(input: McpServerInput): Promise<McpServerSummary> {
    let server: McpServerConfig;
    try {
      server = await this.mcpConfig.upsert(input);
    } catch (error) {
      throw new DatabaseAgentError(
        'INVALID_INPUT',
        error instanceof Error ? error.message : 'MCP Server 配置无效。',
        false,
      );
    }
    if (this.mcp.isRunning(server.id)) await this.mcp.stop(server.id);
    this.mcpAutoStartPromise = undefined;
    return toMcpServerSummary(server, this.mcp.health(server.id), this.mcp.isRunning(server.id));
  }

  async removeMcpServer(serverId: string): Promise<boolean> {
    const id = requireText(serverId, 'serverId', 300);
    if (this.mcp.isRunning(id)) await this.mcp.stop(id);
    const removed = (await this.mcpConfig.remove(id)).removed;
    if (removed) this.mcpAutoStartPromise = undefined;
    return removed;
  }

  async startMcpServer(serverId: string): Promise<McpServerStartSummary> {
    const id = requireText(serverId, 'serverId', 300);
    if (!(await this.mcpConfig.list()).some((server) => server.id === id)) {
      throw new DatabaseAgentError('INVALID_INPUT', `未找到 MCP Server：${id}`, false);
    }
    const started = await this.mcp.start(id);
    return {
      server: toMcpServerSummary(
        started.server,
        started.health,
        this.mcp.isRunning(started.server.id),
      ),
      tools: [...started.tools],
    };
  }

  async stopMcpServer(serverId: string): Promise<McpServerStopSummary> {
    const stopped = await this.mcp.stop(requireText(serverId, 'serverId', 300));
    return {
      serverId: stopped.serverId,
      removedTools: [...stopped.removedTools],
      status: stopped.health.status,
    };
  }

  async startConfiguredMcpServers() {
    return await this.mcp.startAutoStart();
  }

  async compactAgentSession(
    input: CompactAiSqlAgentSessionInput,
  ): Promise<CompactAiSqlAgentSessionResult> {
    const { providerId, model } = this.requireModelConfiguration();
    const session =
      input.session ??
      (input.sessionId?.trim() ? await this.sessions.load(input.sessionId.trim()) : undefined);
    if (!session) {
      throw new DatabaseAgentError('INVALID_INPUT', '请提供有效的 session 或 sessionId。', false);
    }
    this.assertSessionProject(session);
    return await this.reactAgent.compact({
      providerId,
      model,
      session,
      ...(input.focus?.trim() ? { focus: input.focus.trim() } : {}),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  async agentContextCheckpoints(
    sessionId: string,
    limit?: number,
  ): Promise<AgentContextCheckpoint[]> {
    return await this.sessions.listContextCheckpoints(
      requireText(sessionId, 'sessionId', 300),
      limit,
    );
  }

  async generate(input: GenerateSqlInput): Promise<GeneratedSqlRun> {
    const { providerId, model } = this.requireModelConfiguration();
    const connection = this.requireConnection();
    this.scheduleSchemaFreshness(connection);
    if (!this.rag.hasIndex(connection.id)) {
      throw new DatabaseAgentError('SCHEMA_NOT_INDEXED', '请先索引数据库 Schema。', true);
    }
    const question = requireText(input.question, 'question', MAX_QUESTION_CHARS);
    const maxContextChars = normalizeInteger(
      input.maxContextChars ?? DEFAULT_CONTEXT_CHARS,
      'maxContextChars',
      1_000,
      MAX_CONTEXT_CHARS,
    );
    if (input.signal?.aborted) {
      throw new DatabaseAgentError('ABORTED', 'SQL 生成已取消。', false);
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
      response = await this.llmGateway.chat({
        providerId,
        request: {
          model,
          temperature: 0,
          maxTokens: 1_200,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          messages: [
            { role: 'system', content: buildSystemPrompt() },
            {
              role: 'user',
              content: `用户问题：\n${question}\n\n可用 PostgreSQL Schema：\n${contextText}`,
            },
          ],
        },
        context: { tenantId: this.tenantId, taskType: 'nl2sql-generation' },
        maxRetries: 1,
        maxFallbacks: 0,
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
    if (!run) throw new DatabaseAgentError('RUN_NOT_FOUND', '未找到指定运行记录。', false);
    if (run.status !== 'awaiting_execution') {
      throw new DatabaseAgentError(
        'RUN_NOT_EXECUTABLE',
        `运行记录当前状态为 ${run.status}，不能执行。`,
        false,
      );
    }
    const connection = this.requireConnection();
    if (run.connectionId !== connection.id) {
      throw new DatabaseAgentError(
        'RUN_NOT_EXECUTABLE',
        'The SQL run belongs to a different database connection. Generate it again for the active connection.',
        false,
      );
    }
    const safety = analyzeSqlSafety(run.sql, { readOnly: true });
    if (!isExecutableSafety(safety)) {
      const blocked = updateRun(run, {
        status: 'blocked',
        safety,
        updatedAt: this.now(),
      });
      this.sqlRuns.put(blocked);
      throw new DatabaseAgentError('SQL_BLOCKED', safetyMessage(safety), false);
    }

    const executing = updateRun(run, { status: 'executing', safety, updatedAt: this.now() });
    this.sqlRuns.put(executing);
    const limit = normalizeInteger(
      options.limit ?? this.defaultRowLimit,
      'limit',
      1,
      MAX_ROW_LIMIT,
    );
    let result;
    try {
      result = await this.executeAiSqlQuery({
        request: { connectionId: connection.id, sql: run.sql, limit },
        connection,
        authorization: {},
      });
    } catch (error) {
      const normalized = asDatabaseAgentError(error);
      const failure = new DatabaseAgentError(
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

    const { error: _previousError, execution: _previousExecution, ...completedBase } = executing;
    void _previousError;
    void _previousExecution;
    const completed: ExecutedSqlRun = {
      ...completedBase,
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
    if (!run) throw new DatabaseAgentError('RUN_NOT_FOUND', '未找到指定运行记录。', false);
    if (!['completed', 'failed', 'aborted', 'outcome_unknown'].includes(run.status)) {
      throw new DatabaseAgentError(
        'RUN_NOT_EXECUTABLE',
        `SQL run cannot be re-executed from status ${run.status}.`,
        false,
      );
    }
    const connection = this.requireConnection();
    if (run.connectionId !== connection.id) {
      throw new DatabaseAgentError(
        'RUN_NOT_EXECUTABLE',
        'The SQL run belongs to a different database connection. Reconnect that database before re-executing it.',
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

  async llmChat(
    request: LlmRuntimeChatRequest,
    options: LlmRuntimeCallOptions = {},
  ): Promise<LlmChatResponse> {
    if (this.closing) {
      throw new DatabaseAgentError('ABORTED', 'SchemaNaut runtime is closing.', false);
    }
    const { providerId, model } = this.requireModelConfiguration();
    const linked = createLinkedAbortController(request.signal);
    this.activeLlmControllers.add(linked.controller);
    const operation = this.llmGateway.chat({
      providerId,
      request: { ...request, model, signal: linked.controller.signal },
      context: {
        tenantId: this.tenantId,
        taskType: options.taskType?.trim() || 'sdk-chat',
        ...(options.userId === undefined ? {} : { userId: options.userId }),
      },
      ...(options.policies === undefined ? {} : { policies: options.policies }),
      ...(options.budget === undefined ? {} : { budget: options.budget }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
      ...(options.maxFallbacks === undefined ? {} : { maxFallbacks: options.maxFallbacks }),
      ...(options.cache === undefined ? {} : { cache: options.cache }),
    });
    this.activeLlmOperations.add(operation);
    try {
      return await operation;
    } finally {
      linked.dispose();
      this.activeLlmControllers.delete(linked.controller);
      this.activeLlmOperations.delete(operation);
    }
  }

  llmStream(
    request: LlmRuntimeChatRequest,
    options: LlmRuntimeCallOptions = {},
  ): AsyncIterable<LlmChatStreamEvent> {
    if (this.closing) {
      throw new DatabaseAgentError('ABORTED', 'SchemaNaut runtime is closing.', false);
    }
    const { providerId, model } = this.requireModelConfiguration();
    const linked = createLinkedAbortController(request.signal);
    const source = this.llmGateway.stream({
      providerId,
      request: { ...request, model, signal: linked.controller.signal },
      context: {
        tenantId: this.tenantId,
        taskType: options.taskType?.trim() || 'sdk-stream',
        ...(options.userId === undefined ? {} : { userId: options.userId }),
      },
      ...(options.policies === undefined ? {} : { policies: options.policies }),
      ...(options.budget === undefined ? {} : { budget: options.budget }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
      ...(options.maxFallbacks === undefined ? {} : { maxFallbacks: options.maxFallbacks }),
    });
    let resolveOperation: (() => void) | undefined;
    const operation = new Promise<void>((resolve) => {
      resolveOperation = resolve;
    });
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      linked.dispose();
      this.activeLlmControllers.delete(linked.controller);
      this.activeLlmOperations.delete(operation);
      this.activeLlmStreamClosers.delete(closeStream);
      resolveOperation?.();
    };
    const iterator = (async function* () {
      try {
        yield* source;
      } finally {
        cleanup();
      }
    })();
    const closeStream = async () => {
      linked.controller.abort();
      try {
        await iterator.return(undefined);
      } finally {
        cleanup();
      }
    };
    this.activeLlmControllers.add(linked.controller);
    this.activeLlmOperations.add(operation);
    this.activeLlmStreamClosers.add(closeStream);
    return iterator;
  }

  submitLlmBatch(
    requests: LlmRuntimeChatRequest[],
    options: LlmRuntimeCallOptions & { concurrency?: number } = {},
  ): LlmAsyncJob<LlmGatewayResult> {
    if (this.closing) {
      throw new DatabaseAgentError('ABORTED', 'SchemaNaut runtime is closing.', false);
    }
    const { providerId, model } = this.requireModelConfiguration();
    const inputs = requests.map((request) => ({
      providerId,
      request: { ...request, model },
      context: {
        tenantId: this.tenantId,
        taskType: options.taskType?.trim() || 'sdk-batch',
        ...(options.userId === undefined ? {} : { userId: options.userId }),
      },
      ...(options.policies === undefined ? {} : { policies: options.policies }),
      ...(options.budget === undefined ? {} : { budget: options.budget }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
      ...(options.maxFallbacks === undefined ? {} : { maxFallbacks: options.maxFallbacks }),
    }));
    const job = this.llmGateway.submitBatch(inputs, {
      ownerId: this.llmJobOwnerId,
      ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    });
    const operation = waitForLlmJobCompletion(
      this.llmGateway,
      job.id,
      this.tenantId,
      this.llmJobOwnerId,
    );
    this.activeLlmOperations.add(operation);
    void operation.finally(() => this.activeLlmOperations.delete(operation));
    return job;
  }

  getLlmJob(id: string): LlmAsyncJob<LlmGatewayResult> | undefined {
    return this.llmGateway.getJob(id, this.tenantId, this.llmJobOwnerId);
  }

  cancelLlmJob(id: string): LlmAsyncJob<LlmGatewayResult> | undefined {
    return this.llmGateway.cancelJob(id, this.tenantId, this.llmJobOwnerId);
  }

  llmModels(): RegisteredLlmModel[] {
    return this.llmGateway.registry.listModels();
  }

  async discoverLlmModels(): Promise<RegisteredLlmModel[]> {
    const { providerId, model } = this.requireModelConfiguration();
    const provider = this.llmGateway.registry.provider(providerId);
    if (!provider)
      throw new DatabaseAgentError('NOT_CONFIGURED', 'LLM Provider is not registered.', true);
    const selected = this.llmGateway.registry.find(providerId, model);
    if (!selected)
      throw new DatabaseAgentError('NOT_CONFIGURED', 'LLM model is not registered.', true);
    this.llmGateway.registry.applyModelMetadata(selected.id, {
      model,
      source: 'provider-declaration',
      capabilities: { ...provider.capabilities },
    });
    if (!provider.listModels) return this.llmModels();
    try {
      const remoteModels = await provider.listModels();
      for (const remoteModel of remoteModels) {
        const registered =
          this.llmGateway.registry.find(providerId, remoteModel) ??
          this.llmGateway.registerModel({ providerId, model: remoteModel });
        this.llmGateway.registry.applyModelMetadata(registered.id, {
          model: remoteModel,
          source: 'provider-declaration',
          capabilities: { ...provider.capabilities },
        });
      }
      if (remoteModels.includes(model) && provider.getModelMetadata) {
        this.llmGateway.registry.applyModelMetadata(
          selected.id,
          await provider.getModelMetadata(model),
        );
      }
    } catch (error) {
      this.llmGateway.registry.updateHealth(selected.id, {
        state: 'unknown',
        checkedAt: new Date().toISOString(),
        detail: `Model metadata discovery failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    return this.llmModels();
  }

  private async ensureSelectedModelMetadata(
    providerId: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const registered = this.llmGateway.registry.find(providerId, model);
    if (!registered || registered.discovery?.source === 'provider-api') return;
    const provider = this.llmGateway.registry.provider(providerId);
    if (!provider?.getModelMetadata) return;

    const key = `${providerId}\u0000${model}`;
    let pending = this.modelMetadataDiscovery.get(key);
    if (!pending) {
      pending = this.fetchSelectedModelMetadata(provider, registered.id, model, signal);
      this.modelMetadataDiscovery.set(key, pending);
    }
    const outcome = await pending;
    if (outcome === 'cancelled' && this.modelMetadataDiscovery.get(key) === pending) {
      this.modelMetadataDiscovery.delete(key);
    }
  }

  private async fetchSelectedModelMetadata(
    provider: LlmProvider,
    registeredModelId: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<'completed' | 'cancelled'> {
    const linked = createLinkedAbortController(signal);
    const timer = setTimeout(
      () => linked.controller.abort(new Error('Model metadata discovery timed out.')),
      DEFAULT_MODEL_METADATA_DISCOVERY_TIMEOUT_MS,
    );
    timer.unref?.();
    try {
      this.llmGateway.registry.applyModelMetadata(
        registeredModelId,
        await provider.getModelMetadata!(model, linked.controller.signal),
      );
      return 'completed';
    } catch (error) {
      if (signal?.aborted) return 'cancelled';
      this.llmGateway.registry.updateHealth(registeredModelId, {
        state: 'unknown',
        checkedAt: new Date().toISOString(),
        detail: `Model metadata discovery failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      return 'completed';
    } finally {
      clearTimeout(timer);
      linked.dispose();
    }
  }

  llmMetrics(): LlmMetricsSnapshot {
    return this.llmGateway.metricsSnapshot();
  }

  private async executeAiSqlQuery(input: AiSqlQueryExecutionInput): Promise<QueryExecutionResult> {
    if (!this.usesDatabaseAccess || !this.legacyProfileId) {
      const result = await this.driver.execute(
        input.request,
        input.connection,
        input.signal === undefined ? undefined : { signal: input.signal },
      );
      if (!result.ok) {
        throw new DatabaseAgentError(
          'QUERY_FAILED',
          result.error.message,
          result.error.retryable ?? false,
          result.error.detail,
        );
      }
      return result.data;
    }

    const started = performance.now();
    let job;
    if (input.signal?.aborted) {
      throw new DatabaseAgentError('ABORTED', '数据库查询已取消。', false);
    }
    try {
      job = await this.database.submit({
        profileId: this.legacyProfileId,
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
      if (input.signal !== undefined) {
        job = await waitForDatabaseJob(this.database, job, input.signal);
      }
    } catch (error) {
      throw mapDatabaseAccessError(error);
    }

    if (job.state === 'failed' || job.state === 'cancelled') {
      if (job.error) throw new DatabaseAccessRuntimeError(job.error);
      throw new DatabaseAgentError(
        'QUERY_FAILED',
        `数据库查询任务以 ${job.state} 状态结束。`,
        false,
      );
    }
    if (job.state !== 'succeeded') {
      throw new DatabaseAgentError(
        'QUERY_FAILED',
        `同步数据库查询未完成，当前状态为 ${job.state}。`,
        true,
      );
    }

    const rows: QueryExecutionResult['rows'] = [];
    if (job.result) {
      for await (const batch of this.database.streamResult(job.result.id, {
        batchSize: Math.min(input.request.limit ?? 1_000, 1_000),
      })) {
        rows.push(...batch.rows);
      }
    }
    const safety =
      job.safety ??
      analyzeSqlSafety(input.request.sql, {
        readOnly: input.connection.readOnly,
      });
    return {
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
      ...(job.result?.hasMore === undefined ? {} : { hasMore: job.result.hasMore }),
      ...(job.result?.truncated === undefined ? {} : { truncated: job.result.truncated }),
      elapsedMs: Math.round(performance.now() - started),
      safety,
    };
  }

  private async ensureSchemaFresh(
    connection: SavedConnection,
    signal?: AbortSignal,
    force = false,
  ): Promise<void> {
    if (!this.usesDatabaseAccess || !this.legacyProfileId || !this.rag.hasIndex(connection.id)) {
      return;
    }
    if (signal?.aborted) {
      throw new DatabaseAgentError('ABORTED', 'Schema freshness check was cancelled.', false);
    }
    const checkedAt = Date.now();
    if (force && checkedAt - this.lastForcedSchemaRefreshAt < SCHEMA_MISS_REFRESH_DEBOUNCE_MS) {
      return;
    }
    if (!force && checkedAt - this.lastSchemaFreshnessCheckAt < this.schemaFreshnessIntervalMs) {
      return;
    }
    let current = this.schemaFreshnessPromise;
    if (!current) {
      this.lastSchemaFreshnessCheckAt = checkedAt;
      if (force) this.lastForcedSchemaRefreshAt = checkedAt;
      const profileId = this.legacyProfileId;
      current = (async () => {
        const discovery = await discoverCurrentResources(this.database, profileId);
        if (this.connection?.id !== connection.id || this.legacyProfileId !== profileId) return;
        const indexedRevision = this.rag.getCatalog(connection.id).sourceRevision;
        if (indexedRevision === discovery.sourceRevision) return;
        await this.indexDiscoveredSchema(connection, discovery, this.lastIndexMaxTables);
      })();
      this.schemaFreshnessPromise = current;
      const clear = () => {
        if (this.schemaFreshnessPromise === current) this.schemaFreshnessPromise = undefined;
      };
      void current.then(clear, clear);
    }
    await waitForSharedOperation(
      current,
      signal,
      () => new DatabaseAgentError('ABORTED', 'Schema freshness check was cancelled.', false),
    );
  }

  private scheduleSchemaFreshness(connection: SavedConnection): void {
    void this.ensureSchemaFresh(connection).catch(() => undefined);
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
    const scopedResourceIds = new Set(scopedResources.map((resource) => resource.id));
    const scopedRelations = discovery.relations.filter(
      (relation) =>
        scopedResourceIds.has(relation.fromResourceId) &&
        scopedResourceIds.has(relation.toResourceId),
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
    this.lastSchemaFreshnessCheckAt = Date.now();
    return this.schemaStatus();
  }

  private restoreSchemaIndexOptions(connectionId: string): void {
    const manifest = this.rag.getIndexManifest(connectionId);
    if (manifest.maxTables === undefined || manifest.sourceTableCount === undefined) return;
    this.lastIndexMaxTables = manifest.maxTables;
    this.indexTruncated = manifest.sourceTableCount > manifest.maxTables;
  }

  private async ensureMcpAutoStarted(): Promise<void> {
    if (!this.autoStartMcp) return;
    this.mcpAutoStartPromise ??= this.mcp.startAutoStart();
    await this.mcpAutoStartPromise;
  }

  private async compileProjectInstructions(skills: SkillRegistry): Promise<string> {
    const mcpServers = await this.listMcpServers();
    const compilation = await compileProjectContext({
      rootPath: this.project.rootPath,
      ...(this.connection === undefined
        ? {}
        : {
            databases: [
              {
                kind: this.connection.engine,
                label: this.connection.name,
              },
            ],
          }),
      mcpServers: mcpServers.map((server) => ({
        id: server.id,
        status: !server.enabled
          ? ('disabled' as const)
          : server.running && server.healthy
            ? ('ready' as const)
            : ('unavailable' as const),
        transport: server.transport,
      })),
      skills: this.skillCatalogForModel(skills),
    });
    return compilation.compiledInstructions;
  }

  /**
   * Keep unavailable capability packages out of the model contract. A database
   * connection enables execution tools; an indexed Schema additionally enables
   * RAG tools. Other built-ins remain usable in a database-free project.
   */
  private availableToolNames(requested: readonly string[] | undefined): string[] | undefined {
    const hasConnection = this.connection !== undefined;
    const hasKnowledge = hasConnection && this.rag.hasIndex(this.connection!.id);
    const available = this.tools
      .listDescriptors()
      .filter((tool) => tool.source !== 'database' || hasConnection)
      .filter((tool) => tool.source !== 'schema-rag' || hasKnowledge)
      .map((tool) => tool.flatName);
    if (requested === undefined) {
      return available.length === this.tools.listDescriptors().length ? undefined : available;
    }
    const availableSet = new Set(available);
    return requested.filter((name) => availableSet.has(name));
  }

  private skillCatalogForModel(registry: SkillRegistry) {
    return registry.catalogForModel().filter((skill) => {
      const descriptor = registry.inspect(skill);
      return descriptor !== undefined && this.isSkillAvailable(descriptor);
    });
  }

  private isSkillAvailable(descriptor: SkillDescriptor): boolean {
    const required = (descriptor.metadata.capabilities ?? '')
      .split(/[,;\s]+/)
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    return required.every((capability) => {
      if (capability === 'database') return this.connection !== undefined;
      if (capability === 'schema-rag') {
        return this.connection !== undefined && this.rag.hasIndex(this.connection.id);
      }
      if (capability === 'process') return this.processes !== undefined;
      if (capability === 'web') return this.tools.has('web_search') || this.tools.has('web_fetch');
      if (capability === 'mcp') {
        return this.tools.listDescriptors().some((tool) => tool.source === 'user-mcp');
      }
      if (capability === 'workspace') return this.tools.has('workspace_read');
      return false;
    });
  }

  private skillRegistryForSession(session: AgentSession): SkillRegistry {
    const baseRevision = this.skills.currentRevision();
    const cached = this.sessionSkillViews.get(session);
    if (cached?.baseRevision === baseRevision) return cached.registry;
    const registry = this.skills.createSessionView(session.sessionSkills ?? []);
    this.sessionSkillViews.set(session, { baseRevision, registry });
    return registry;
  }

  private assertSessionProject(session: AgentSession): void {
    try {
      assertSameAgentProject(session.project, agentProjectReference(this.project));
    } catch (error) {
      throw new DatabaseAgentError(
        'INVALID_INPUT',
        error instanceof Error ? error.message : String(error),
        false,
      );
    }
  }

  private requireModelConfiguration(): { providerId: string; model: string } {
    if (!this.providerId || !this.model) {
      throw new DatabaseAgentError('NOT_CONFIGURED', '请先配置模型 Provider 和模型名。', true);
    }
    return { providerId: this.providerId, model: this.model };
  }

  private requireConnection(): SavedConnection {
    if (!this.connection) {
      throw new DatabaseAgentError('NOT_CONFIGURED', '请先连接 PostgreSQL。', true);
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

export function toAgentSessionView(session: AgentSession): AgentSessionView {
  const messages: AgentSessionView['messages'] = [];
  let pendingAssistant: AgentSessionView['messages'][number] | undefined;
  const flushAssistant = () => {
    if (pendingAssistant && isFinalResponseReady(pendingAssistant.content)) {
      messages.push(pendingAssistant);
    }
    pendingAssistant = undefined;
  };
  for (const message of session.messages) {
    if (message.role === 'user') {
      flushAssistant();
      messages.push({
        role: 'user',
        content: message.content,
        createdAt: message.createdAt,
      });
      continue;
    }
    if (message.role === 'assistant' && message.content.trim()) {
      pendingAssistant = {
        role: 'assistant',
        content: message.content,
        createdAt: message.createdAt,
      };
    }
  }
  flushAssistant();
  return {
    id: session.id,
    title: session.title,
    ...(session.userId === undefined ? {} : { userId: session.userId }),
    mode: session.mode,
    messages,
    tokenUsage: { ...session.tokenUsage },
    ...(session.project === undefined ? {} : { project: { rootPath: session.project.rootPath } }),
    ...(session.taskPlan === undefined
      ? {}
      : {
          taskPlan: {
            goal: session.taskPlan.goal,
            tasks: session.taskPlan.tasks.map((task) => ({
              id: task.id,
              title: task.title,
              ...(task.description === undefined ? {} : { description: task.description }),
              status: task.status,
            })),
          },
        }),
    ...(session.artifacts === undefined
      ? {}
      : { artifacts: session.artifacts.map((artifact) => ({ ...artifact })) }),
    ...(session.activeSkills === undefined
      ? {}
      : {
          activeSkills: session.activeSkills.map((skill) => ({
            name: skill.name,
            description: skill.description,
            scope: skill.scope,
          })),
        }),
    aborted: session.aborted,
  };
}

export function toAiSqlAgentRunView(run: AiSqlAgentRun): AiSqlAgentRunView {
  return {
    activatedSkills: [...run.activatedSkills],
    queryResults: run.queryResults.map((result) => structuredClone(result)),
    result: {
      runId: run.result.runId,
      status: run.result.status,
      session: toAgentSessionView(run.result.session),
      finalText: run.result.finalText,
      iterations: run.result.iterations,
      ...(run.result.events === undefined
        ? {}
        : { events: run.result.events.map((event) => structuredClone(event)) }),
      ...(run.result.artifacts === undefined
        ? {}
        : {
            artifacts: run.result.artifacts.map((artifact) => ({
              ...artifact,
            })),
          }),
      ...(run.result.completion === undefined
        ? {}
        : {
            completion: {
              verified: run.result.completion.verified,
              unresolvedTaskIds: [...run.result.completion.unresolvedTaskIds],
              deliveryReady: run.result.completion.deliveryReady,
              finalResponseReady: run.result.completion.finalResponseReady,
              phase: run.result.completion.phase,
              missing: [...run.result.completion.missing],
              evidenceKinds: [...run.result.completion.evidenceKinds],
            },
          }),
    },
  };
}

function toInteractiveQueryResult(stored: StoredAiSqlResult): InteractiveQueryResult {
  const result = stored.result;
  return {
    executionId: stored.id,
    connectionId: stored.connectionId,
    ...(stored.sql === undefined ? {} : { sql: stored.sql }),
    columns: structuredClone(result.columns),
    rows: structuredClone(result.rows),
    rowCount: result.rowCount,
    returnedRowCount: result.returnedRowCount ?? result.rows.length,
    hasMore: result.hasMore === true,
    truncated: result.truncated === true,
    elapsedMs: result.elapsedMs,
    messages: structuredClone(result.messages ?? []),
  };
}

function toMcpServerSummary(
  server: McpServerConfig,
  health: McpServerHealthState,
  running: boolean,
): McpServerSummary {
  return {
    id: server.id,
    name: server.name,
    source: server.source,
    transport: server.transport,
    enabled: server.enabled,
    autoStart: server.autoStart,
    running,
    status: health.status,
    healthy: health.healthy,
    warnings: [...health.warnings],
  };
}

function normalizeConnection(input: PostgresConnectionInput, id: string): DatabaseConnectionConfig {
  const host = requireText(input.host, 'host', 500);
  const database = requireText(input.database, 'database', 300);
  const username = requireText(input.username, 'username', 300);
  const port = normalizeInteger(input.port ?? 5432, 'port', 1, 65_535);
  const name = input.name?.trim() || `${database}@${host}`;
  const ssl = normalizePostgresSsl(input.ssl);
  return {
    id: requireText(id, 'id', 300),
    name,
    engine: 'postgres',
    host,
    port,
    database,
    username,
    ...(input.password === undefined ? {} : { password: input.password }),
    ...(ssl === undefined ? {} : { ssl }),
    readOnly: input.readOnly ?? false,
    connectionTimeoutMs: normalizeInteger(
      input.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
      'connectionTimeoutMs',
      100,
      300_000,
    ),
    statementTimeoutMs: normalizeInteger(
      input.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
      'statementTimeoutMs',
      100,
      3_600_000,
    ),
  };
}

function normalizePostgresSsl(value: unknown): DatabaseConnectionConfig['ssl'] {
  if (
    value === undefined ||
    value === true ||
    value === false ||
    value === 'require' ||
    value === 'verify-ca' ||
    value === 'verify-full'
  ) {
    return value;
  }
  throw new DatabaseAgentError(
    'INVALID_INPUT',
    'ssl must be a boolean, require, verify-ca, or verify-full.',
    false,
  );
}

function toPostgresProfile(
  config: DatabaseConnectionConfig,
  now: string,
  scope: ResourceScope,
): ConnectionProfile {
  return {
    id: config.id!,
    name: config.name,
    connectorId: 'postgres-native',
    engine: 'postgres',
    endpoints: [
      {
        transport: 'tcp',
        host: config.host,
        port: config.port,
        database: config.database,
        ...(config.ssl !== undefined ? { ssl: config.ssl } : {}),
      },
    ],
    principal: config.username,
    purpose: config.readOnly ? 'read-only' : 'read-write',
    readOnly: config.readOnly,
    scope: structuredClone(scope),
    network: {
      ...(config.connectionTimeoutMs ? { connectTimeoutMs: config.connectionTimeoutMs } : {}),
      ...(config.statementTimeoutMs ? { statementTimeoutMs: config.statementTimeoutMs } : {}),
    },
    pool: { max: config.maxClients ?? 5 },
    createdAt: now,
    updatedAt: now,
  };
}

function savedConnectionFromDatabaseSession(
  config: DatabaseConnectionConfig,
  connectionId: string,
  now: string,
): SavedConnection {
  return {
    id: connectionId,
    name: config.name,
    engine: 'postgres',
    host: config.host,
    port: config.port,
    database: config.database,
    username: config.username,
    ...(typeof config.ssl === 'boolean' ? { ssl: config.ssl } : {}),
    readOnly: config.readOnly,
    ...(config.connectionTimeoutMs === undefined
      ? {}
      : { connectionTimeoutMs: config.connectionTimeoutMs }),
    ...(config.statementTimeoutMs === undefined
      ? {}
      : { statementTimeoutMs: config.statementTimeoutMs }),
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
      throw new DatabaseAgentError(
        'CONNECTION_FAILED',
        'Schema discovery exceeded 10,000 pages.',
        false,
      );
    }
    for (const resource of page.resources) {
      resources.set(resource.id, resource);
    }
    for (const relation of page.relations) {
      relations.set(relation.id, relation);
    }
    if (page.complete) {
      cursor = undefined;
      break;
    }
    if (!page.nextCursor) {
      throw new DatabaseAgentError(
        'CONNECTION_FAILED',
        'Schema discovery returned an incomplete page without a cursor.',
        false,
      );
    }
    if (seenCursors.has(page.nextCursor)) {
      throw new DatabaseAgentError(
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
  const encoded = stringifyPublicJson(canonicalizeRevisionValue(revisionInput));
  return `sha256:${createHash('sha256').update(encoded).digest('hex')}`;
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
  if (Array.isArray(value)) return value.map((item) => canonicalizeRevisionValue(item));
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

function mapDatabaseAccessError(error: unknown): DatabaseAgentError {
  if (error instanceof DatabaseAgentError) return error;
  if (error instanceof DatabaseAccessRuntimeError) {
    return new DatabaseAgentError(
      'CONNECTION_FAILED',
      error.error.message,
      error.error.retryable,
      error.error.detail,
    );
  }
  return asDatabaseAgentError(error);
}

async function waitForDatabaseJob(
  database: DatabaseAccessRuntime,
  initialJob: QueryJob,
  signal: AbortSignal,
): Promise<QueryJob> {
  let job = initialJob;
  let cancellation: Promise<unknown> | undefined;
  const requestCancellation = () => {
    cancellation ??= database.cancel(job.id).catch(() => undefined);
  };
  signal.addEventListener('abort', requestCancellation, { once: true });
  try {
    if (signal.aborted) requestCancellation();
    while (!['succeeded', 'failed', 'cancelled', 'expired'].includes(job.state)) {
      if (signal.aborted) {
        requestCancellation();
        await cancellation;
      }
      await pollingDelay(10);
      job = await database.getJob(job.id);
    }
    await cancellation;
    return job;
  } finally {
    signal.removeEventListener('abort', requestCancellation);
  }
}

async function pollingDelay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
}

function buildSystemPrompt(): string {
  return [
    '你是 PostgreSQL 查询生成器。',
    '只输出一个 JSON 对象，字段必须是 sql、explanation、assumptions。',
    'sql 只能是一条只读 SELECT、只读 WITH 或 VALUES 语句。',
    '禁止 INSERT、UPDATE、DELETE、MERGE、CALL、CREATE、ALTER、DROP、TRUNCATE、COPY、SET、事务控制和多条语句。',
    '只能使用给出的表和字段；优先使用注释、主外键和业务语义。',
    '默认避免 SELECT *，并为明细查询提供合理 LIMIT。',
    '信息不足时仍给出最保守的查询，并把口径或时间假设写入 assumptions。',
    '不要输出 Markdown、代码围栏或 JSON 之外的文字。',
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
  return detail ? `生成的 SQL 已被安全策略阻止：${detail}` : '生成的 SQL 不符合只读执行策略。';
}

function mapLlmError(error: unknown): DatabaseAgentError {
  if (error instanceof DatabaseAgentError) return error;
  if (error instanceof LlmProviderError) {
    if (error.code === 'LLM_ABORTED') {
      return new DatabaseAgentError('ABORTED', 'SQL 生成已取消。', false);
    }
    return new DatabaseAgentError('LLM_REQUEST_FAILED', error.message, error.retryable);
  }
  const normalized = asDatabaseAgentError(error);
  if (normalized.code === 'ABORTED') return normalized;
  return new DatabaseAgentError('LLM_REQUEST_FAILED', normalized.message, true);
}

function requireText(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new DatabaseAgentError('INVALID_INPUT', `${name} 不能为空。`, false);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new DatabaseAgentError(
      'INVALID_INPUT',
      `${name} 长度不能超过 ${maxLength} 个字符。`,
      false,
    );
  }
  return trimmed;
}

function normalizeInstructionList(
  values: readonly string[] | undefined,
  name: string,
): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > 100) {
    throw new DatabaseAgentError(
      'INVALID_INPUT',
      `${name} 必须是最多包含 100 项的字符串数组。`,
      false,
    );
  }
  return values.map((value, index) => requireText(value, `${name}[${index}]`, 20_000));
}

function normalizeNameList(values: readonly string[] | undefined, name: string): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > 2_000) {
    throw new DatabaseAgentError(
      'INVALID_INPUT',
      `${name} 必须是最多包含 2000 项的工具名称数组。`,
      false,
    );
  }
  return uniqueNames(values.map((value, index) => requireText(value, `${name}[${index}]`, 300)));
}

function normalizeOptionalNameList(
  values: readonly string[] | undefined,
  name: string,
): string[] | undefined {
  return values === undefined ? undefined : normalizeNameList(values, name);
}

function uniqueNames(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function normalizeInteger(value: number, name: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new DatabaseAgentError(
      'INVALID_INPUT',
      `${name} 必须是 ${min} 到 ${max} 之间的整数。`,
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

function toRunError(error: DatabaseAgentError): {
  code: DatabaseAgentError['code'];
  message: string;
  retryable: boolean;
} {
  return { code: error.code, message: error.message, retryable: error.retryable };
}

function createLinkedAbortController(signal?: AbortSignal): {
  controller: AbortController;
  dispose: () => void;
} {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) {
    forwardAbort();
  } else {
    signal?.addEventListener('abort', forwardAbort, { once: true });
  }
  return {
    controller,
    dispose: () => signal?.removeEventListener('abort', forwardAbort),
  };
}

async function waitForLlmJobCompletion(
  gateway: LlmGateway,
  id: string,
  tenantId: string,
  ownerId: string,
): Promise<void> {
  while (true) {
    const job = gateway.getJob(id, tenantId, ownerId);
    if (
      job === undefined ||
      job.status === 'completed' ||
      job.status === 'failed' ||
      job.status === 'cancelled'
    ) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function waitForSharedOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  abortedError: () => Error,
): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(abortedError());
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => {
      cleanup();
      reject(abortedError());
    };
    signal.addEventListener('abort', abort, { once: true });
    void operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        const reason: unknown = error;
        reject(
          reason instanceof Error
            ? reason
            : new Error('Shared operation rejected with a non-Error reason.', { cause: reason }),
        );
      },
    );
  });
}

async function mapInBatches<T, R>(
  values: T[],
  batchSize: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const output: R[] = [];
  for (let index = 0; index < values.length; index += batchSize) {
    output.push(...(await Promise.all(values.slice(index, index + batchSize).map(mapper))));
  }
  return output;
}
