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
  AgentSessionStore,
  AgentSession,
  ApprovalProvider,
} from '@dbagent/core-agent';
import type {
  SchemaRagEngine,
  SchemaRagRetrievalProfile,
} from '@dbagent/core-rag';
import type { AiSqlResultStore } from '@dbagent/core-tools';
import type { UsageTracker } from '@dbagent/core-usage';
import type { QueryExecutionResult, QuerySafetyReport, SavedConnection } from '@dbagent/shared';
import type { DatabaseAgentErrorCode } from './errors.js';

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
  resultStore?: AiSqlResultStore;
};

export type PostgresConnectionInput = {
  id?: string;
  name?: string;
  host: string;
  port?: number;
  database: string;
  username: string;
  password?: string;
  ssl?: boolean | 'prefer' | 'require' | 'verify-ca' | 'verify-full';
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
  maxIterations?: number;
  maxToolExecutionMs?: number;
  signal?: AbortSignal;
};

export type CompactAiSqlAgentSessionInput = {
  session?: AgentSession;
  sessionId?: string;
  focus?: string;
  signal?: AbortSignal;
};

export type CompactAiSqlAgentSessionResult = AgentContextCompactionResult;

export type AiSqlAgentRun = {
  selectedSkill: string;
  result: AgentRunResult;
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
  | 'aborted';

export type SqlRunError = {
  code: DatabaseAgentErrorCode;
  message: string;
  retryable: boolean;
};

export type SqlRunSnapshot = {
  runId: string;
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
