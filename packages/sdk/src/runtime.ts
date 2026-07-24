import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  AgentSessionStore,
  ReactAgent,
  ToolRegistry,
  type AgentContextCheckpoint,
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
import { SchemaRagEngine } from '@dbagent/core-rag';
import {
  createDefaultBuiltinSkills,
  SkillRegistry,
} from '@dbagent/core-skills';
import {
  registerAiSqlTools,
  runAutoSkillAgent,
  type AiSqlQueryExecutionInput,
  type AiSqlResultStore,
} from '@dbagent/core-tools';
import { UsageTracker } from '@dbagent/core-usage';
import type {
  ConnectionProfile,
  QueryExecutionResult,
  QuerySafetyReport,
  ResourceDescriptor,
  ResourceRelation,
  SavedConnection,
} from '@dbagent/shared';
import { DatabaseAgentError, asDatabaseAgentError } from './errors.js';
import { parseGeneratedSqlResponse } from './parse-generation.js';
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
  LlmRuntimeCallOptions,
  LlmRuntimeChatRequest,
  PostgresConnectionInput,
  RunAiSqlAgentInput,
  AiSqlAgentRun,
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
const EXECUTABLE_STATEMENT_KINDS = new Set(['SELECT', 'WITH', 'VALUES']);

export class DatabaseAgentRuntime {
  private readonly driver: IDatabaseDriver;
  private readonly rag: SchemaRagEngine;
  private readonly createRunId: () => string;
  private readonly createConnectionId: () => string;
  private readonly now: () => string;
  private readonly defaultRowLimit: number;
  private readonly llmGateway: LlmGateway;
  private readonly llmRouter: LlmRouter;
  private readonly usageTracker: UsageTracker;
  private readonly reactAgent: ReactAgent;
  readonly tools: ToolRegistry;
  readonly skills: SkillRegistry;
  readonly results: AiSqlResultStore;
  readonly sessions: AgentSessionStore;
  /**
   * Unified database/warehouse/cluster access API. Connector registration,
   * resources, capabilities, query jobs, transactions and operations all live
   * behind this stable SDK entrypoint.
   */
  readonly database: DatabaseAccessRuntime;
  /** Product-wide resource, graph, observation and state runtime. */
  readonly resources: ResourceRegistry;
  private readonly tenantId: string;
  private readonly runs = new Map<string, SqlRunSnapshot>();
  private providerId?: string;
  private model?: string;
  private connection: SavedConnection | undefined;
  private readonly postgresConnector: PostgresConnector | undefined;
  private readonly legacyUsesDatabaseAccess: boolean;
  private legacyProfileId: string | undefined;
  private indexTruncated = false;

  constructor(options: DatabaseAgentRuntimeOptions = {}) {
    const defaultDriver = options.driver ?? new PostgresDriver();
    this.driver = defaultDriver;
    if (options.databaseAccess) {
      this.database = options.databaseAccess;
      this.postgresConnector = undefined;
      this.legacyUsesDatabaseAccess = false;
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
      this.legacyUsesDatabaseAccess = options.driver === undefined;
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
                      return document
                        ? { id: document.id, score: item.score }
                        : undefined;
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
    this.tools = new ToolRegistry();
    this.skills = new SkillRegistry();
    this.sessions =
      options.sessionStore ??
      new AgentSessionStore(
        options.sessionDatabasePath ??
          resolve(process.cwd(), '.schemanaut', 'schemanaut.db'),
      );
    for (const skill of createDefaultBuiltinSkills()) this.skills.register(skill);
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
      onSchemaChanged: async () => {
        if (this.connection) await this.indexSchema();
      },
    });
    this.reactAgent = new ReactAgent(
      this.llmRouter,
      this.tools,
      this.usageTracker,
      options.approvalProvider,
      {
        ...(options.agentDependencies ?? {}),
        sessionStore: this.sessions,
      },
    );
    if (options.provider || options.model) {
      if (!options.provider || !options.model?.trim()) {
        throw new DatabaseAgentError('INVALID_INPUT', 'provider 和 model 必须同时配置。', false);
      }
      this.configureProvider(options.provider, options.model);
    }
  }

  configureProvider(provider: LlmProvider, model: string): void {
    const normalizedModel = requireText(model, 'model', 300);
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
    if (this.legacyUsesDatabaseAccess) {
      const profile = toPostgresProfile(config, this.now());
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
    if (this.legacyUsesDatabaseAccess) {
      const profile = toPostgresProfile(config, this.now());
      this.database.createProfile(profile);
      try {
        await this.database.connect(profile.id, {
          username: config.username,
          ...(config.password ? { password: config.password } : {}),
        });
        const connection = this.postgresConnector?.getLegacyConnection(profile.id);
        if (!connection) {
          throw new DatabaseAgentError(
            'CONNECTION_FAILED',
            'PostgreSQL Connector did not expose the active driver connection.',
            false,
          );
        }
        this.connection = connection;
        this.legacyProfileId = profile.id;
        this.indexTruncated = false;
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
    return cloneConnection(result.data);
  }

  async disconnect(): Promise<void> {
    const current = this.connection;
    if (!current) return;
    if (this.legacyUsesDatabaseAccess && this.legacyProfileId) {
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
    this.runs.clear();
  }

  async close(): Promise<void> {
    const failures: unknown[] = [];
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
    this.runs.clear();
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
    if (this.legacyUsesDatabaseAccess && this.legacyProfileId) {
      const discovery = await discoverCurrentResources(
        this.database,
        this.legacyProfileId,
      );
      const scopedResources = discovery.resources;
      const scopedResourceIds = new Set(scopedResources.map((resource) => resource.id));
      const scopedRelations = discovery.relations.filter(
        (relation) =>
          scopedResourceIds.has(relation.fromResourceId) &&
          scopedResourceIds.has(relation.toResourceId),
      );
      const tableRoots = scopedResources
        .filter((resource) =>
          ['table', 'view', 'materialized-view', 'external-table'].includes(
            resource.kind,
          ),
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
          resourceIds.has(relation.fromResourceId) &&
          resourceIds.has(relation.toResourceId),
      );
      await this.rag.indexAsync({
        connectionId: connection.id,
        resources,
        relations,
        sourceRevision: discovery.sourceRevision,
        indexedAt: this.now(),
      });
      this.indexTruncated = tableRoots.length > maxTables;
      return this.schemaStatus();
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
    await this.rag.indexAsync({
      connectionId: connection.id,
      tables,
      indexedAt: this.now(),
    });
    this.indexTruncated = listed.data.length > selected.length;
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
      runCount: this.runs.size,
      llm: {
        modelCount: this.llmGateway.registry.listModels().length,
        metrics: this.llmGateway.metricsSnapshot(),
      },
    };
  }

  async runAgent(input: RunAiSqlAgentInput): Promise<AiSqlAgentRun> {
    const { providerId, model } = this.requireModelConfiguration();
    const connection = this.requireConnection();
    if (!this.rag.hasIndex(connection.id)) {
      throw new DatabaseAgentError(
        'SCHEMA_NOT_INDEXED',
        '请先索引当前数据库的知识目录。',
        true,
      );
    }
    const message = requireText(input.message, 'message', MAX_QUESTION_CHARS);
    if (input.session && input.sessionId?.trim()) {
      throw new DatabaseAgentError(
        'INVALID_INPUT',
        'session 与 sessionId 只能提供一个。',
        false,
      );
    }
    const initialSession =
      input.session ??
      (input.sessionId?.trim()
        ? await this.sessions.load(input.sessionId.trim())
        : undefined);
    if (input.sessionId?.trim() && !initialSession) {
      throw new DatabaseAgentError(
        'INVALID_INPUT',
        `未找到 Session：${input.sessionId.trim()}`,
        false,
      );
    }
    const catalog = this.rag.getCatalog(connection.id);
    const manifest = this.rag.getIndexManifest(connection.id);
    const output = await runAutoSkillAgent(this.reactAgent, {
      skills: this.skills.list(),
      userInput: message,
      toolPolicy: { toolRegistry: this.tools },
      providerId,
      model,
      ...(input.userId === undefined ? {} : { userId: input.userId }),
      mode: input.mode ?? 'read',
      knowledgeSnapshot: {
        connectionId: connection.id,
        knowledgeSnapshotId: catalog.snapshotId,
        catalogRootHash: catalog.catalogRootHash,
        retrievalProfileId: manifest.retrievalProfileId,
        indexVersion: manifest.indexVersion,
      },
      ...(initialSession === undefined ? {} : { initialSession }),
      ...(input.maxIterations === undefined
        ? {}
        : { maxIterations: input.maxIterations }),
      ...(input.maxToolExecutionMs === undefined
        ? {}
        : { maxToolExecutionMs: input.maxToolExecutionMs }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return {
      selectedSkill: output.autoPlan.candidate.skill.name,
      result: output.result,
    };
  }

  async compactAgentSession(
    input: CompactAiSqlAgentSessionInput,
  ): Promise<CompactAiSqlAgentSessionResult> {
    const { providerId, model } = this.requireModelConfiguration();
    const session =
      input.session ??
      (input.sessionId?.trim()
        ? await this.sessions.load(input.sessionId.trim())
        : undefined);
    if (!session) {
      throw new DatabaseAgentError(
        'INVALID_INPUT',
        '请提供有效的 session 或 sessionId。',
        false,
      );
    }
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
    this.runs.set(run.runId, cloneRun(run));
    return cloneRun(run) as GeneratedSqlRun;
  }

  async executeGenerated(
    runId: string,
    options: ExecuteGeneratedOptions = {},
  ): Promise<ExecutedSqlRun> {
    const normalizedRunId = requireText(runId, 'runId', 300);
    const run = this.runs.get(normalizedRunId);
    if (!run) throw new DatabaseAgentError('RUN_NOT_FOUND', '未找到指定运行记录。', false);
    if (run.status !== 'awaiting_execution') {
      throw new DatabaseAgentError(
        'RUN_NOT_EXECUTABLE',
        `运行记录当前状态为 ${run.status}，不能执行。`,
        false,
      );
    }
    const connection = this.requireConnection();
    const safety = analyzeSqlSafety(run.sql, { readOnly: true });
    if (!isExecutableSafety(safety)) {
      const blocked = updateRun(run, {
        status: 'blocked',
        safety,
        updatedAt: this.now(),
      });
      this.runs.set(run.runId, blocked);
      throw new DatabaseAgentError('SQL_BLOCKED', safetyMessage(safety), false);
    }

    const executing = updateRun(run, { status: 'executing', safety, updatedAt: this.now() });
    this.runs.set(run.runId, executing);
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
      this.runs.set(
        run.runId,
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
      safety,
      execution: result,
      updatedAt: this.now(),
    };
    this.runs.set(run.runId, cloneRun(completed));
    return cloneRun(completed) as ExecutedSqlRun;
  }

  getRun(runId: string): SqlRunSnapshot | undefined {
    const run = this.runs.get(runId);
    return run ? cloneRun(run) : undefined;
  }

  async llmChat(request: LlmRuntimeChatRequest, options: LlmRuntimeCallOptions = {}): Promise<LlmChatResponse> {
    const { providerId, model } = this.requireModelConfiguration();
    return await this.llmGateway.chat({
      providerId,
      request: { ...request, model },
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
  }

  async *llmStream(
    request: LlmRuntimeChatRequest,
    options: LlmRuntimeCallOptions = {},
  ): AsyncIterable<LlmChatStreamEvent> {
    const { providerId, model } = this.requireModelConfiguration();
    yield* this.llmGateway.stream({
      providerId,
      request: { ...request, model },
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
  }

  submitLlmBatch(
    requests: LlmRuntimeChatRequest[],
    options: LlmRuntimeCallOptions & { concurrency?: number } = {},
  ): LlmAsyncJob<LlmGatewayResult> {
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
    return this.llmGateway.submitBatch(
      inputs,
      options.concurrency === undefined ? {} : { concurrency: options.concurrency },
    );
  }

  getLlmJob(id: string): LlmAsyncJob<LlmGatewayResult> | undefined {
    return this.llmGateway.getJob(id);
  }

  cancelLlmJob(id: string): LlmAsyncJob<LlmGatewayResult> | undefined {
    return this.llmGateway.cancelJob(id);
  }

  llmModels(): RegisteredLlmModel[] {
    return this.llmGateway.registry.listModels();
  }

  async discoverLlmModels(): Promise<RegisteredLlmModel[]> {
    const { providerId, model } = this.requireModelConfiguration();
    const provider = this.llmGateway.registry.provider(providerId);
    if (!provider) throw new DatabaseAgentError('NOT_CONFIGURED', 'LLM Provider is not registered.', true);
    const selected = this.llmGateway.registry.find(providerId, model);
    if (!selected) throw new DatabaseAgentError('NOT_CONFIGURED', 'LLM model is not registered.', true);
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

  llmMetrics(): LlmMetricsSnapshot {
    return this.llmGateway.metricsSnapshot();
  }

  private async executeAiSqlQuery(
    input: AiSqlQueryExecutionInput,
  ): Promise<QueryExecutionResult> {
    if (!this.legacyUsesDatabaseAccess || !this.legacyProfileId) {
      const result = await this.driver.execute(input.request, input.connection);
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
    try {
      job = await this.database.submit({
        profileId: this.legacyProfileId,
        sql: input.request.sql,
        executionMode: 'sync',
        ...(input.request.timeoutMs === undefined
          ? {}
          : { timeoutMs: input.request.timeoutMs }),
        ...(input.request.limit === undefined
          ? {}
          : { rowLimit: input.request.limit }),
        ...(input.request.dryRun === undefined
          ? {}
          : { dryRun: input.request.dryRun }),
        ...(input.request.confirmed === undefined
          ? {}
          : { confirmed: input.request.confirmed }),
        ...(input.request.transactionMode === undefined
          ? {}
          : { transactionMode: input.request.transactionMode }),
        authorization: input.authorization,
      });
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
      ...(input.request.limit === undefined
        ? {}
        : { rowLimit: input.request.limit }),
      ...(job.result?.hasMore === undefined
        ? {}
        : { hasMore: job.result.hasMore }),
      ...(job.result?.truncated === undefined
        ? {}
        : { truncated: job.result.truncated }),
      elapsedMs: Math.round(performance.now() - started),
      safety,
    };
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

function normalizeConnection(input: PostgresConnectionInput, id: string): DatabaseConnectionConfig {
  const host = requireText(input.host, 'host', 500);
  const database = requireText(input.database, 'database', 300);
  const username = requireText(input.username, 'username', 300);
  const port = normalizeInteger(input.port ?? 5432, 'port', 1, 65_535);
  const name = input.name?.trim() || `${database}@${host}`;
  return {
    id: requireText(id, 'id', 300),
    name,
    engine: 'postgres',
    host,
    port,
    database,
    username,
    ...(input.password === undefined ? {} : { password: input.password }),
    ...(input.ssl === undefined ? {} : { ssl: input.ssl }),
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

function toPostgresProfile(
  config: DatabaseConnectionConfig,
  now: string,
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
    network: {
      ...(config.connectionTimeoutMs
        ? { connectTimeoutMs: config.connectionTimeoutMs }
        : {}),
      ...(config.statementTimeoutMs
        ? { statementTimeoutMs: config.statementTimeoutMs }
        : {}),
    },
    pool: { max: config.maxClients ?? 5 },
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
  const snapshots: string[] = [];
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
    if (page.snapshotId) snapshots.push(page.snapshotId);
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

  return {
    resources: [...resources.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    relations: [...relations.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    sourceRevision: JSON.stringify({
      profileId,
      pages,
      snapshots,
      resourceVersions: [...resources.values()]
        .map((resource) => [resource.id, resource.version] as const)
        .sort(([left], [right]) => left.localeCompare(right)),
      relationVersions: [...relations.values()]
        .map((relation) => [relation.id, relation.version] as const)
        .sort(([left], [right]) => left.localeCompare(right)),
    }),
  };
}

function collectContainedResources(
  roots: Set<string>,
  relations: ResourceRelation[],
): Set<string> {
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

function requireText(value: string, name: string, maxLength: number): string {
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
