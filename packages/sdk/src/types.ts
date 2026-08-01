import type {
  ConnectorRegistry,
  CredentialResolver,
  DatabaseAccessRuntime,
  DatabaseAuditSink,
  DatabaseConnector,
  IDatabaseDriver,
} from '@dbagent/core-db';
import type { ResourceRegistry } from '@dbagent/core-resource';
import type {
  LlmGateway,
  LlmGatewayChatRequest,
  LlmPolicyLayers,
  LlmBudgetLimits,
  LlmMetricsSnapshot,
  LlmProvider,
  LlmUsage,
  RegisteredLlmModel,
} from '@dbagent/core-llm';
import type {
  AgentMode,
  AgentContextCompactionResult,
  AgentRunDependencies,
  AgentRunResult,
  AgentRunStatus,
  AgentSessionStore,
  AgentSession,
  AgentSessionListFilter,
  AgentTaskStatus,
  AgentArtifactReference,
  AgentToolApprovalRequest,
  AgentUserEvent,
  AgentSystemPrompt,
  ApprovalProvider,
} from '@dbagent/core-agent';
import type { SkillCatalogEntry, SkillOverlay, SkillRefreshResult } from '@dbagent/core-skills';
import type { SchemaRagEngine, SchemaRagRetrievalProfile } from '@dbagent/core-rag';
import type {
  AgentWebAdapter,
  AiSqlResultStore,
  McpSecretResolver,
  McpServerInput,
  McpServerSource,
  McpServerStatus,
  McpTransport,
  ProcessRuntime,
} from '@dbagent/core-tools';
import type { UsageTracker } from '@dbagent/core-usage';
import type { QueryExecutionResult, QuerySafetyReport, SavedConnection } from '@dbagent/shared';
import type { DatabaseAgentErrorCode } from './errors.js';
import type { SqlRunStore } from './sql-run-store.js';

export type DatabaseAgentRuntimeOptions = {
  provider?: LlmProvider;
  gateway?: LlmGateway;
  model?: string;
  tenantId?: string;
  driver?: IDatabaseDriver;
  databaseAccess?: DatabaseAccessRuntime;
  connectors?: DatabaseConnector[];
  connectorRegistry?: ConnectorRegistry;
  resourceRegistry?: ResourceRegistry;
  credentialResolver?: CredentialResolver;
  databaseAuditSink?: DatabaseAuditSink;
  rag?: SchemaRagEngine;
  /**
   * Optional directory for durable Schema RAG snapshots. Relative paths are
   * resolved from the selected Project root. Omit to keep indexes in memory.
   */
  schemaSnapshotDirectory?: string;
  /**
   * Minimum interval between background checks for externally changed Schema.
   * Existing indexes remain immediately usable; exact retrieval misses can
   * still force one refresh. Set to 0 to check on every request in tests.
   */
  schemaFreshnessIntervalMs?: number;
  retrievalProfile?: SchemaRagRetrievalProfile;
  createRunId?: () => string;
  createConnectionId?: () => string;
  now?: () => string;
  defaultRowLimit?: number;
  usageTracker?: UsageTracker;
  approvalProvider?: ApprovalProvider;
  agentDependencies?: AgentRunDependencies;
  sessionStore?: AgentSessionStore;
  sessionDatabasePath?: string;
  sqlRunStore?: SqlRunStore;
  resultStore?: AiSqlResultStore;
  projectDirectory?: string;
  userSkillsDirectory?: string;
  /**
   * Default Session-private Markdown Skills copied into each newly created
   * Session. Restored Sessions keep their own persisted overlay.
   */
  sessionSkills?: SkillOverlay[];
  /** Default user-controlled role instructions. Runtime protocol and permissions remain enforced. */
  systemPrompt?: AgentSystemPrompt;
  /** Optional capability guidance layered below the role and above Project instructions. */
  capabilityInstructions?: string[];
  /** Optional allow-list applied to every Agent run unless overridden per run. */
  allowedTools?: string[];
  /** Deferred tools that should be directly visible without an initial tool_search call. */
  pinnedTools?: string[];
  webAdapter?: AgentWebAdapter;
  /** Register the host-permission shell tool. Disabled by default. */
  enableShellTool?: boolean;
  /** Register foreground/background process tools. enableShellTool also enables these for compatibility. */
  enableProcessTools?: boolean;
  /** Optional shared process runtime. It is closed with DatabaseAgentRuntime. */
  processRuntime?: ProcessRuntime;
  dynamicToolDiscovery?: boolean;
  mcpSecretResolver?: McpSecretResolver;
  /** Lazily start trusted MCP configurations marked autoStart. Disabled by default. */
  autoStartMcp?: boolean;
};

export type PostgresConnectionInput = {
  id?: string;
  name?: string;
  host: string;
  port?: number;
  database: string;
  username: string;
  password?: string;
  ssl?: boolean | 'require' | 'verify-ca' | 'verify-full';
  connectionTimeoutMs?: number;
  statementTimeoutMs?: number;
  readOnly?: boolean;
};

export type ConnectionTestResult = {
  latencyMs: number;
  readOnly: boolean;
};

export type IndexSchemaOptions = {
  maxTables?: number;
};

export type SchemaIndexStage = 'not_connected' | 'not_indexed' | 'ready';

export type SchemaIndexSnapshot = {
  connectionId?: string;
  stage: SchemaIndexStage;
  ready: boolean;
  tableCount: number;
  columnCount: number;
  relationCount: number;
  documentCount: number;
  truncated: boolean;
  indexedAt?: string;
};

export type GenerateSqlInput = {
  question: string;
  maxContextChars?: number;
  signal?: AbortSignal;
};

export type RunAiSqlAgentInput = {
  message: string;
  userId?: string;
  mode?: Extract<AgentMode, 'read' | 'edit' | 'full'>;
  session?: AgentSession;
  sessionId?: string;
  /**
   * Session-private Markdown Skills for a new Session. This overrides the
   * Runtime default and cannot be supplied when resuming a Session.
   */
  sessionSkills?: SkillOverlay[];
  maxIterations?: number;
  maxToolExecutionMs?: number;
  systemPrompt?: AgentSystemPrompt;
  capabilityInstructions?: string[];
  allowedTools?: string[];
  pinnedTools?: string[];
  onEvent?: (event: AgentUserEvent) => void | Promise<void>;
  signal?: AbortSignal;
};

export type CompactAiSqlAgentSessionInput = {
  session?: AgentSession;
  sessionId?: string;
  focus?: string;
  signal?: AbortSignal;
};

export type CompactAiSqlAgentSessionResult = AgentContextCompactionResult;

export type InteractiveQueryResult = {
  executionId: string;
  connectionId: string;
  sql?: string;
  columns: QueryExecutionResult['columns'];
  rows: QueryExecutionResult['rows'];
  rowCount: number;
  returnedRowCount: number;
  hasMore: boolean;
  truncated: boolean;
  elapsedMs: number;
  messages: NonNullable<QueryExecutionResult['messages']>;
};

export type AiSqlAgentRun = {
  activatedSkills: string[];
  /**
   * Ephemeral, bounded database payloads for SDK/API/CLI result panes.
   * These rows are not part of Agent history and are not restored with a Session.
   */
  queryResults: InteractiveQueryResult[];
  result: AgentRunResult;
};

/**
 * User-facing conversation view. Internal tool messages, tool calls,
 * knowledge hashes and activated Skill instructions are deliberately omitted.
 */
export type AgentSessionView = {
  id: string;
  title: string;
  userId?: string;
  mode: AgentMode;
  messages: Array<{
    role: 'user' | 'assistant';
    content: string;
    createdAt: string;
  }>;
  tokenUsage: LlmUsage;
  project?: {
    rootPath: string;
  };
  taskPlan?: AgentTaskPlanView;
  artifacts?: AgentArtifactReference[];
  activeSkills?: SkillCatalogEntry[];
  aborted: boolean;
};

export type AgentTaskPlanView = {
  goal: string;
  tasks: Array<{
    id: string;
    title: string;
    description?: string;
    status: AgentTaskStatus;
  }>;
};

export type AiSqlAgentRunView = {
  activatedSkills: string[];
  queryResults: InteractiveQueryResult[];
  result: {
    runId: string;
    status: AgentRunStatus;
    session: AgentSessionView;
    finalText: string;
    iterations: number;
    events?: AgentUserEvent[];
    artifacts?: AgentArtifactReference[];
    completion?: {
      verified: boolean;
      unresolvedTaskIds: string[];
      deliveryReady: boolean;
      finalResponseReady: boolean;
      phase: 'verify' | 'finalize' | 'done';
      missing: string[];
      evidenceKinds: string[];
    };
  };
};

export type AgentSessionListInput = AgentSessionListFilter;
export type AgentSessionListItem = {
  id: string;
  title: string;
  userId?: string;
  mode: AgentMode;
  archived: boolean;
  conversationMessageCount: number;
  tokenUsage: LlmUsage;
  createdAt: string;
  updatedAt: string;
  lastMessageAt?: string;
};
export type AgentSkillCatalogEntry = SkillCatalogEntry;
export type AgentSkillRefreshResult = SkillRefreshResult;
export type AgentSkillListInput = {
  /** Omit for the shared system/user/Project catalog. */
  sessionId?: string;
};
export type AgentApprovalRequest = AgentToolApprovalRequest;

export type McpServerRegistrationInput = McpServerInput;

export type McpServerSummary = {
  id: string;
  name: string;
  source: McpServerSource;
  transport: McpTransport;
  enabled: boolean;
  autoStart: boolean;
  running: boolean;
  status: McpServerStatus;
  healthy: boolean;
  warnings: string[];
};

export type McpServerStartSummary = {
  server: McpServerSummary;
  tools: string[];
};

export type McpServerStopSummary = {
  serverId: string;
  removedTools: string[];
  status: McpServerStatus;
};

export type ExecuteGeneratedOptions = {
  limit?: number;
};

export type GeneratedSqlEvidence = {
  title: string;
  kind: string;
  reasons: string[];
};

export type SqlRunStatus =
  | 'awaiting_execution'
  | 'blocked'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'outcome_unknown';

export type SqlRunError = {
  code: DatabaseAgentErrorCode;
  message: string;
  retryable: boolean;
};

export type SqlRunSnapshot = {
  runId: string;
  connectionId: string;
  /** True only on the immediate execution response; persisted run history never retains rows. */
  executionResultAvailable: boolean;
  status: SqlRunStatus;
  question: string;
  sql: string;
  explanation: string;
  assumptions: string[];
  evidence: GeneratedSqlEvidence[];
  safety: QuerySafetyReport;
  createdAt: string;
  updatedAt: string;
  usage?: LlmUsage;
  execution?: QueryExecutionResult;
  error?: SqlRunError;
};

export type GeneratedSqlRun = SqlRunSnapshot & {
  status: 'awaiting_execution' | 'blocked';
  execution?: never;
  error?: never;
};

export type ExecutedSqlRun = SqlRunSnapshot & {
  status: 'completed';
  executionResultAvailable: true;
  execution: QueryExecutionResult;
  error?: never;
};

export type RuntimeStatus = {
  providerConfigured: boolean;
  providerId?: string;
  model?: string;
  connected: boolean;
  connection?: SavedConnection;
  schema: SchemaIndexSnapshot;
  runCount: number;
  llm: {
    modelCount: number;
    metrics: LlmMetricsSnapshot;
  };
};

export type LlmRuntimeStatus = {
  providerId?: string;
  model?: string;
  models: RegisteredLlmModel[];
  metrics: LlmMetricsSnapshot;
};

export type LlmRuntimeCallOptions = {
  taskType?: string;
  userId?: string;
  policies?: LlmPolicyLayers;
  budget?: LlmBudgetLimits;
  timeoutMs?: number;
  maxRetries?: number;
  maxFallbacks?: number;
  cache?: { enabled: boolean; ttlMs?: number; namespace?: string };
};

export type LlmRuntimeChatRequest = Omit<LlmGatewayChatRequest, 'model'>;

export type ParsedGeneratedSql = {
  sql: string;
  explanation: string;
  assumptions: string[];
};
