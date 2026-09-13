import type {
  LlmGenerationConfig,
  LlmModelSelection,
  LlmUsage,
} from '@dbagent/core-llm';
import type {
  ConnectionNetwork,
  ConnectionPurpose,
  DatabaseCredential,
  DatabaseEndpoint,
  DatabaseEngine,
  PortableScalar,
  QueryExecutionResult,
  QuerySafetyReport,
  SavedConnection,
} from '@dbagent/shared';
import type { SchemaRagEngine, SchemaRagRetrievalProfile } from '@dbagent/core-rag';
import type { ResourceRegistry } from '@dbagent/core-resource';
import type {
  ConnectorRegistry,
  CredentialResolver,
  DatabaseAccessRuntime,
  DatabaseAuditSink,
  DatabaseConnector,
  DatabaseResultStore,
  PostgresConnectorDriver,
} from '@dbagent/core-db';
import type { AgentCapabilityLifecycleContext } from '@dbagent/core-agent';
import type { SqlRunStore } from './sql-run-store.js';
import type { DatabaseCapabilityErrorCode } from './errors.js';

export type ParsedGeneratedSql = Readonly<{
  sql: string;
  explanation: string;
  assumptions: readonly string[];
}>;

/** Database-only composition options. Generic Agent Runtime options do not belong here. */
export type DatabaseCapabilityOptions = Readonly<{
  /**
   * The sole database connection ingress. Implementations discover connection
   * contexts from user-managed CLIs, files, environment variables or keychain
   * references. The Capability never owns a connection settings store.
   */
  connectionProvider?: ExternalConnectionProvider;
  createPostgresDriver?: () => PostgresConnectorDriver;
  createSqlRunStore?: () => SqlRunStore;
  createRunId?: () => string;
  now?: () => string;
  sqlRunStore?: SqlRunStore;
  databaseResultStore?: DatabaseResultStore;
  postgresDriver?: PostgresConnectorDriver;
  databaseAccess?: DatabaseAccessRuntime;
  connectors?: readonly DatabaseConnector[];
  connectorRegistry?: ConnectorRegistry;
  resourceRegistry?: ResourceRegistry;
  credentialResolver?: CredentialResolver;
  databaseAuditSink?: DatabaseAuditSink;
  rag?: SchemaRagEngine;
  schemaSnapshotDirectory?: string;
  schemaFreshnessIntervalMs?: number;
  retrievalProfile?: SchemaRagRetrievalProfile;
  stateDatabasePath?: string;
  defaultRowLimit?: number;
}>;

/** Stable description of one externally configured database context. */
export type ConnectionCandidate = Readonly<{
  candidateId: string;
  label: string;
  description?: string;
  metadata?: Readonly<Record<string, string | number | boolean | null>>;
  /** Endpoint/context identity; changes require a new activation. */
  fingerprint: string;
}>;

/**
 * Connection material supplied by an external provider. Runtime identity,
 * scope and timestamps remain Host-controlled.
 */
export type ExternalConnectionProfile = Readonly<{
  name: string;
  connectorId: string;
  engine: DatabaseEngine;
  endpoints: readonly DatabaseEndpoint[];
  principal?: string;
  purpose: ConnectionPurpose;
  readOnly: boolean;
  defaultResourceId?: string;
  defaultNamespace?: string;
  network?: ConnectionNetwork;
  sessionParameters?: Readonly<Record<string, PortableScalar>>;
  pool?: Readonly<{
    min?: number;
    max?: number;
    idleTimeoutMs?: number;
  }>;
  labels?: Readonly<Record<string, string>>;
}>;

/**
 * Material obtained after selecting a current external context. The credential
 * is a connector input rather than an Agent-facing candidate field.
 */
export type EphemeralConnectionBinding = Readonly<{
  candidateId: string;
  fingerprint: string;
  profile: ExternalConnectionProfile;
  credential: DatabaseCredential;
}>;

export type ExternalConnectionProvider = Readonly<{
  providerId: string;
  discover(context?: AgentCapabilityLifecycleContext): Promise<readonly ConnectionCandidate[]>;
  resolve(
    candidateId: string,
    context?: AgentCapabilityLifecycleContext,
  ): Promise<EphemeralConnectionBinding>;
}>;
export type IndexSchemaOptions = Readonly<{ maxTables?: number }>;
export type SchemaIndexSnapshot = Readonly<{
  connectionId?: string; stage: 'not_connected' | 'not_indexed' | 'ready'; ready: boolean;
  tableCount: number; columnCount: number; relationCount: number; documentCount: number;
  truncated: boolean; indexedAt?: string;
}>;
export type DatabaseCapabilityStatus = Readonly<{
  connected: boolean;
  /** Whether the active database identity matches the Agent-visible Capability generation. */
  agentPublication: 'current' | 'pending';
  connection?: SavedConnection;
  schema: SchemaIndexSnapshot;
  runCount: number;
}>;

export type GenerateSqlInput = Readonly<{
  question: string;
  model: LlmModelSelection;
  maxContextChars?: number;
  generation?: LlmGenerationConfig;
  signal?: AbortSignal;
}>;

export type ExecuteGeneratedOptions = Readonly<{ limit?: number }>;

export type GeneratedSqlEvidence = Readonly<{
  title: string;
  kind: string;
  reasons: readonly string[];
}>;

export type SqlRunStatus =
  | 'awaiting_execution'
  | 'blocked'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'outcome_unknown';

export type SqlRunError = Readonly<{
  code: DatabaseCapabilityErrorCode;
  message: string;
  retryable: boolean;
}>;

export type SqlRunSnapshot = Readonly<{
  runId: string;
  connectionId: string;
  executionResultAvailable: boolean;
  status: SqlRunStatus;
  question: string;
  sql: string;
  explanation: string;
  assumptions: readonly string[];
  evidence: readonly GeneratedSqlEvidence[];
  safety: QuerySafetyReport;
  createdAt: string;
  updatedAt: string;
  usage?: LlmUsage;
  execution?: QueryExecutionResult;
  error?: SqlRunError;
}>;

export type GeneratedSqlRun = SqlRunSnapshot & Readonly<{
  status: 'awaiting_execution' | 'blocked';
  execution?: never;
  error?: never;
}>;

export type ExecutedSqlRun = SqlRunSnapshot & Readonly<{
  status: 'completed';
  executionResultAvailable: true;
  execution: QueryExecutionResult;
  error?: never;
}>;
