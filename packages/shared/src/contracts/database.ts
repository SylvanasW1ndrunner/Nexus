import type {
  ConnectionId,
  ConnectionStatus,
  DatabaseEngine,
  DbColumnValue,
  QueryResultRow,
} from './database-sdk.js';
import type { QuerySafetyReport, QueryTransactionMode } from './database-runtime.js';
import type { OperationOutcome, PortableScalar, PortableValue, PublicErrorBase } from './common.js';
import type { ResourceId, ResourceScope } from './resource.js';

export type ConnectionProfileId = string;
export type ConnectionSessionId = string;
export type QueryJobId = string;
export type ResultHandleId = string;

export type TcpEndpoint = {
  transport: 'tcp';
  host: string;
  port: number;
  database?: string;
  ssl?: boolean | 'require' | 'verify-ca' | 'verify-full';
};

export type JdbcEndpoint = {
  transport: 'jdbc';
  url: string;
  driverClass?: string;
  properties?: Record<string, string>;
};

export type HttpEndpoint = {
  transport: 'http';
  baseUrl: string;
  apiVersion?: string;
  headers?: Record<string, string>;
};

export type SdkEndpoint = {
  transport: 'sdk';
  provider: string;
  account?: string;
  region?: string;
  options?: Record<string, PortableValue>;
};

export type CustomEndpoint = {
  transport: 'custom';
  scheme: string;
  options: Record<string, PortableValue>;
};

export type DatabaseEndpoint =
  | TcpEndpoint
  | JdbcEndpoint
  | HttpEndpoint
  | SdkEndpoint
  | CustomEndpoint;

export type CredentialReference = {
  provider: string;
  reference: string;
  version?: string;
  expiresAt?: string;
};

/** Short-lived credential material accepted at a connector boundary. */
export type DatabaseCredential = {
  username?: string;
  password?: string;
  token?: string;
  certificate?: string;
  privateKey?: string;
  properties?: Record<string, string>;
};

export type ConnectionPurpose = 'query' | 'read-only' | 'read-write' | 'admin' | 'monitor';

export type ConnectionNetwork = {
  proxyUrl?: string;
  sshTunnelRef?: string;
  privateLinkId?: string;
  connectTimeoutMs?: number;
  statementTimeoutMs?: number;
  keepAlive?: boolean;
};

export type ConnectionProfile = {
  id: ConnectionProfileId;
  name: string;
  connectorId: string;
  engine: DatabaseEngine;
  endpoints: DatabaseEndpoint[];
  credentialRef?: CredentialReference;
  /** Account/user name associated with this connection. */
  principal?: string;
  purpose: ConnectionPurpose;
  readOnly: boolean;
  /** Trusted host scope applied to every resource discovered through this profile. */
  scope?: ResourceScope;
  defaultResourceId?: ResourceId;
  defaultNamespace?: string;
  network?: ConnectionNetwork;
  sessionParameters?: Record<string, PortableScalar>;
  pool?: {
    min?: number;
    max?: number;
    idleTimeoutMs?: number;
  };
  labels?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
};

export type ConnectionHealth = {
  status: 'healthy' | 'degraded' | 'unavailable' | 'unknown';
  checkedAt: string;
  latencyMs?: number;
  engineVersion?: string;
  endpointIndex?: number;
  message?: string;
};

export type ConnectionTestResult = ConnectionHealth & {
  connectorId: string;
  engine: DatabaseEngine;
  capabilities?: CapabilityProfile;
};

export type ConnectionSession = {
  id: ConnectionSessionId;
  connectionId: ConnectionId;
  profileId: ConnectionProfileId;
  connectorId: string;
  status: ConnectionStatus;
  endpointIndex: number;
  connectedAt?: string;
  lastHealth?: ConnectionHealth;
  nativeSessionId?: string;
  generation: number;
};

export type CapabilityStatus = 'supported' | 'conditional' | 'unsupported' | 'unknown';

export type CapabilityConstraint = {
  name: string;
  operator?: 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte' | 'in' | 'contains';
  value: PortableValue;
  message?: string;
};

export type CapabilityDescriptor = {
  key: string;
  status: CapabilityStatus;
  reason?: string;
  constraints?: CapabilityConstraint[];
  limits?: Record<string, number | string | boolean>;
  source: string;
  observedAt: string;
};

export type CapabilityProfile = {
  connectorId: string;
  engine: DatabaseEngine;
  engineVersion?: string;
  resourceId?: ResourceId;
  connectionProfileId?: ConnectionProfileId;
  resolvedAt: string;
  capabilities: Record<string, CapabilityDescriptor>;
};

export type CapabilityRequirement = {
  key: string;
  context?: Record<string, PortableValue>;
};

export type CapabilityCheck = {
  requirement: CapabilityRequirement;
  satisfied: boolean;
  capability: CapabilityDescriptor;
  unmetConstraints?: CapabilityConstraint[];
};

export type SqlDialectDescriptor = {
  id: string;
  engine: DatabaseEngine;
  versionRange?: string;
  identifierQuote: string;
  parameterStyle: 'question-mark' | 'numbered' | 'named' | 'at-named';
  supportsCatalogs: boolean;
  supportsSchemas: boolean;
  pagination: 'limit-offset' | 'fetch-offset' | 'top' | 'connector';
  features: Record<string, CapabilityStatus>;
};

export type QueryExecutionMode = 'sync' | 'async' | 'auto';
/** Database-internal SQL risk classification; unrelated to Agent access modes. */
export type SqlOperationClass = 'query' | 'mutation' | 'schema-admin';
export type QueryJobState =
  | 'submitted'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelling'
  | 'cancelled'
  | 'expired';

export type QueryAuthorization = {
  actorId?: string;
  policyId?: string;
  approvalId?: string;
  /** Highest SQL operation class authorized for this submission. */
  authorizedClass?: SqlOperationClass;
};

export type QuerySubmission = {
  profileId: ConnectionProfileId;
  sessionId?: ConnectionSessionId;
  transactionId?: string;
  resourceId?: ResourceId;
  sql: string;
  params?: DbColumnValue[];
  executionMode?: QueryExecutionMode;
  transactionMode?: QueryTransactionMode;
  timeoutMs?: number;
  rowLimit?: number;
  batchSize?: number;
  dryRun?: boolean;
  confirmed?: boolean;
  priority?: number;
  maximumBytesScanned?: number;
  maximumCost?: number;
  authorization?: QueryAuthorization;
  labels?: Record<string, string>;
};

export type TransactionIsolationLevel =
  | 'read-uncommitted'
  | 'read-committed'
  | 'repeatable-read'
  | 'serializable';

export type DatabaseTransaction = {
  id: string;
  profileId: ConnectionProfileId;
  sessionId: ConnectionSessionId;
  state: 'active' | 'committed' | 'rolled-back' | 'failed' | 'closed';
  isolationLevel?: TransactionIsolationLevel;
  readOnly: boolean;
  startedAt: string;
  completedAt?: string;
  savepoints: string[];
};

export type QueryStage = {
  id: string;
  name: string;
  state: QueryJobState;
  progress?: number;
  startedAt?: string;
  completedAt?: string;
  metrics?: Record<string, number>;
};

export type QueryCost = {
  bytesScanned?: number;
  bytesProcessed?: number;
  cpuMs?: number;
  slotMs?: number;
  estimatedCost?: number;
  actualCost?: number;
  currency?: string;
};

export type ResultFormat = 'rows' | 'arrow' | 'parquet' | 'csv' | 'json';

export type ResultHandle = {
  id: ResultHandleId;
  jobId: QueryJobId;
  format: ResultFormat;
  columns: Array<{ name: string; dataType?: string; nativeType?: string }>;
  rowCount?: number;
  byteCount?: number;
  hasMore?: boolean;
  truncated?: boolean;
  expiresAt?: string;
  externalUrl?: string;
};

export type QueryJob = {
  id: QueryJobId;
  profileId: ConnectionProfileId;
  sessionId?: ConnectionSessionId;
  resourceId?: ResourceId;
  connectorId: string;
  state: QueryJobState;
  vendorQueryId?: string;
  submittedAt: string;
  startedAt?: string;
  completedAt?: string;
  expiresAt?: string;
  progress?: number;
  stages?: QueryStage[];
  cost?: QueryCost;
  result?: ResultHandle;
  safety?: QuerySafetyReport;
  error?: DatabaseAccessError;
};

export type ResultBatch = {
  handleId: ResultHandleId;
  rows: QueryResultRow[];
  rowOffset: number;
  nextCursor?: string;
  complete: boolean;
  byteCount?: number;
};

export type DatabaseOperationRisk = 'read' | 'write' | 'dangerous';

export type DatabaseObservationRequest = {
  profileId: ConnectionProfileId;
  resourceId?: ResourceId;
  categories?: string[];
};

export type DatabaseOperationDescriptor = {
  key: string;
  title: string;
  description: string;
  risk: DatabaseOperationRisk;
  idempotent: boolean;
  requiredCapability: string;
  inputSchema?: Record<string, PortableValue>;
};

export type DatabaseOperationRequest = {
  profileId: ConnectionProfileId;
  operation: string;
  resourceId?: ResourceId;
  input?: Record<string, PortableValue>;
  authorization?: QueryAuthorization;
};

export type DatabaseOperationResult = {
  operationId: string;
  operation: string;
  status: 'succeeded' | 'failed' | 'accepted';
  startedAt: string;
  completedAt?: string;
  output?: Record<string, PortableValue>;
  error?: DatabaseAccessError;
};

export type DatabaseAccessErrorCategory =
  | 'validation'
  | 'authentication'
  | 'authorization'
  | 'network'
  | 'timeout'
  | 'rate-limit'
  | 'quota'
  | 'syntax'
  | 'transaction'
  | 'lock'
  | 'cancelled'
  | 'unsupported'
  | 'not-found'
  | 'conflict'
  | 'provider'
  | 'internal';

export type DatabaseAccessError = Omit<PublicErrorBase, 'retryable' | 'outcome'> & {
  category: DatabaseAccessErrorCategory;
  stage?:
    | 'profile'
    | 'connect'
    | 'discover'
    | 'submit'
    | 'execute'
    | 'cancel'
    | 'result'
    | 'observe'
    | 'operate';
  resourceId?: ResourceId;
  profileId?: ConnectionProfileId;
  jobId?: QueryJobId;
  providerCode?: string;
  retryable: boolean;
  outcome: OperationOutcome;
};

export type DatabaseAuditEvent = {
  id: string;
  action: string;
  actorId?: string;
  profileId?: ConnectionProfileId;
  resourceId?: ResourceId;
  jobId?: QueryJobId;
  authorization?: QueryAuthorization;
  startedAt: string;
  completedAt?: string;
  status: 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  elapsedMs?: number;
  resultRows?: number;
  resultBytes?: number;
  errorCode?: string;
  attributes?: Record<string, PortableValue>;
};
