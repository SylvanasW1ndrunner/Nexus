import type { IDatabaseDriver } from '@dbagent/core-db';
import type { LlmProvider, LlmUsage } from '@dbagent/core-llm';
import type { SchemaRagEngine } from '@dbagent/core-rag';
import type { QueryExecutionResult, QuerySafetyReport, SavedConnection } from '@dbagent/shared';
import type { DatabaseAgentErrorCode } from './errors.js';

export type DatabaseAgentRuntimeOptions = {
  provider?: LlmProvider;
  model?: string;
  driver?: IDatabaseDriver;
  rag?: SchemaRagEngine;
  createRunId?: () => string;
  createConnectionId?: () => string;
  now?: () => string;
  defaultRowLimit?: number;
};

export type PostgresConnectionInput = {
  id?: string;
  name?: string;
  host: string;
  port?: number;
  database: string;
  username: string;
  password?: string;
  ssl?: boolean;
  connectionTimeoutMs?: number;
  statementTimeoutMs?: number;
};

export type ConnectionTestResult = {
  latencyMs: number;
  readOnly: true;
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
  model?: string;
  connected: boolean;
  connection?: SavedConnection;
  schema: SchemaIndexSnapshot;
  runCount: number;
};

export type ParsedGeneratedSql = {
  sql: string;
  explanation: string;
  assumptions: string[];
};
