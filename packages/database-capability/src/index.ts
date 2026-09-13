/**
 * Database Capability implementation.
 *
 * This package owns database-specific tool contributions.  The generic
 * Agent runtime obtains them only through a Capability registration.
 */
export {
  createAiSqlToolContributions,
  type ActiveDatabaseBinding,
  type AiSqlQueryExecution,
  type AiSqlQueryExecutionInput,
  type AiSqlQueryExecutor,
  type AiSqlToolContributionSet,
  type AiSqlToolRuntimeDependencies,
  type AiSqlResultContentInput,
  type AiSqlResultContentResolver,
  type SchemaRagReadView,
} from './ai-sql-tools.js';
export {
  createEnvironmentConnectionProvider,
  EnvironmentConnectionProvider,
  ENVIRONMENT_CONNECTION_PROVIDER_ID,
  NO_ENVIRONMENT_CONNECTION_DIAGNOSTIC,
  type StandardDatabaseEnvironment,
} from './environment-connection-provider.js';
export { DatabaseCapabilityError, asDatabaseCapabilityError, type DatabaseCapabilityErrorCode } from './errors.js';
export { parseGeneratedSqlResponse } from './parse-generation.js';
export { SqlRunStore } from './sql-run-store.js';
export { createDatabaseToolGeneration, type DatabaseToolGeneration } from './tool-generation.js';
export type { DatabaseCapabilityHostPort } from './host-port.js';
export {
  DatabaseCapabilityModule,
  DATABASE_CAPABILITY_INSTANCE_ID,
  DATABASE_CAPABILITY_MODULE_ID,
  validateDatabaseCapabilityOptions,
  type ValidatedDatabaseCapabilityOptions,
} from './database-capability-module.js';
export type {
  ExecuteGeneratedOptions,
  ExecutedSqlRun,
  GenerateSqlInput,
  GeneratedSqlEvidence,
  GeneratedSqlRun,
  ParsedGeneratedSql,
  SqlRunError,
  SqlRunSnapshot,
  SqlRunStatus,
  DatabaseCapabilityOptions,
  DatabaseCapabilityStatus,
  ConnectionCandidate,
  EphemeralConnectionBinding,
  ExternalConnectionProfile,
  ExternalConnectionProvider,
  IndexSchemaOptions,
  SchemaIndexSnapshot,
} from './types.js';
