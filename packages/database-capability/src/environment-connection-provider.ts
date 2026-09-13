import { createHash } from 'node:crypto';
import type { AgentCapabilityLifecycleContext } from '@dbagent/core-agent';
import { POSTGRES_CONNECTOR_ID } from '@dbagent/core-db';
import type { ConnectionCandidate, EphemeralConnectionBinding, ExternalConnectionProfile, ExternalConnectionProvider } from './types.js';
import { DatabaseCapabilityError } from './errors.js';

export const ENVIRONMENT_CONNECTION_PROVIDER_ID = 'postgres-standard-environment.v1';
export const NO_ENVIRONMENT_CONNECTION_DIAGNOSTIC = 'No DATABASE_URL or PostgreSQL PG* connection environment is available. Set DATABASE_URL or PGHOST with the required PG* values, then retry.';

export type StandardDatabaseEnvironment = Readonly<Record<string, string | undefined>>;

type EnvironmentConnection = Readonly<{
  candidate: ConnectionCandidate;
  profile: ExternalConnectionProfile;
  credential: EphemeralConnectionBinding['credential'];
}>;

/**
 * Reads only standard process environment connection sources. It keeps no
 * SchemaNaut configuration and regenerates candidates for every discovery.
 */
export class EnvironmentConnectionProvider implements ExternalConnectionProvider {
  readonly providerId = ENVIRONMENT_CONNECTION_PROVIDER_ID;

  constructor(private readonly environment: StandardDatabaseEnvironment = process.env) {}

  diagnostic(): string {
    return NO_ENVIRONMENT_CONNECTION_DIAGNOSTIC;
  }

  discover(context?: AgentCapabilityLifecycleContext): Promise<readonly ConnectionCandidate[]> {
    return Promise.resolve().then(() => {
      assertLifecycle(context);
      const candidates = this.sources().map(source => source.candidate);
      assertLifecycle(context);
      return Object.freeze(candidates);
    });
  }

  resolve(candidateId: string, context?: AgentCapabilityLifecycleContext): Promise<EphemeralConnectionBinding> {
    return Promise.resolve().then(() => {
      assertLifecycle(context);
      const source = this.sources().find(entry => entry.candidate.candidateId === candidateId);
      if (!source) {
        throw new DatabaseCapabilityError('NOT_CONFIGURED', 'The selected standard database environment is unavailable. Set DATABASE_URL or PostgreSQL PG* variables, then retry.', true);
      }
      assertLifecycle(context);
      return Object.freeze({
        candidateId: source.candidate.candidateId,
        fingerprint: source.candidate.fingerprint,
        profile: source.profile,
        credential: source.credential,
      });
    });
  }

  private sources(): readonly EnvironmentConnection[] {
    const sources = [databaseUrlSource(this.environment), postgresEnvironmentSource(this.environment)].filter((source): source is EnvironmentConnection => source !== undefined);
    return Object.freeze(sources);
  }
}

export function createEnvironmentConnectionProvider(environment: StandardDatabaseEnvironment = process.env): EnvironmentConnectionProvider {
  return new EnvironmentConnectionProvider(environment);
}

function databaseUrlSource(environment: StandardDatabaseEnvironment): EnvironmentConnection | undefined {
  const raw = optionalEnvironmentValue(environment.DATABASE_URL, 'DATABASE_URL', 16_384);
  if (raw === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw invalidEnvironment('DATABASE_URL must be a valid PostgreSQL connection URL.');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw invalidEnvironment('DATABASE_URL must use the postgres or postgresql scheme.');
  }
  if (!parsed.hostname) throw invalidEnvironment('DATABASE_URL must include a PostgreSQL host.');
  const port = parsed.port === '' ? 5432 : portNumber(parsed.port, 'DATABASE_URL port');
  const database = decodedPath(parsed.pathname) || 'postgres';
  const username = decodedValue(parsed.username, 'DATABASE_URL username');
  const password = decodedValue(parsed.password, 'DATABASE_URL password');
  const connectTimeoutMs = connectionTimeout(parsed.searchParams.get('connect_timeout'), 'DATABASE_URL connect_timeout');
  const ssl = sslMode(parsed.searchParams.get('sslmode'), 'DATABASE_URL sslmode');
  return source({
    candidateId: 'environment-database-url', label: 'PostgreSQL from DATABASE_URL', source: 'DATABASE_URL',
    fingerprintValues: [raw], host: parsed.hostname, port, database, username, password, ssl, connectTimeoutMs,
  });
}

function postgresEnvironmentSource(environment: StandardDatabaseEnvironment): EnvironmentConnection | undefined {
  const host = optionalEnvironmentValue(environment.PGHOST, 'PGHOST', 500);
  const port = optionalEnvironmentValue(environment.PGPORT, 'PGPORT', 16);
  const database = optionalEnvironmentValue(environment.PGDATABASE, 'PGDATABASE', 500);
  const username = optionalEnvironmentValue(environment.PGUSER, 'PGUSER', 16_384);
  const password = optionalEnvironmentValue(environment.PGPASSWORD, 'PGPASSWORD', 1_048_576);
  const sslModeValue = optionalEnvironmentValue(environment.PGSSLMODE, 'PGSSLMODE', 64);
  const timeout = optionalEnvironmentValue(environment.PGCONNECT_TIMEOUT, 'PGCONNECT_TIMEOUT', 16);
  if ([host, port, database, username, password, sslModeValue, timeout].every(value => value === undefined)) return undefined;
  return source({
    candidateId: 'environment-postgresql', label: 'PostgreSQL from PG* environment', source: 'PG*',
    fingerprintValues: [host, port, database, username, password, sslModeValue, timeout], host: host ?? 'localhost',
    port: port === undefined ? 5432 : portNumber(port, 'PGPORT'), database: database ?? 'postgres', username, password,
    ssl: sslMode(sslModeValue, 'PGSSLMODE'), connectTimeoutMs: connectionTimeout(timeout, 'PGCONNECT_TIMEOUT'),
  });
}

function source(input: Readonly<{
  candidateId: string; label: string; source: string; fingerprintValues: readonly (string | undefined)[];
  host: string; port: number; database: string; username: string | undefined; password: string | undefined;
  ssl: boolean | 'require' | 'verify-ca' | 'verify-full' | undefined; connectTimeoutMs: number | undefined;
}>): EnvironmentConnection {
  const candidate = Object.freeze({
    candidateId: input.candidateId,
    label: input.label,
    description: `PostgreSQL connection discovered from ${input.source}.`,
    metadata: Object.freeze({ source: input.source, engine: 'postgres' }),
    fingerprint: fingerprint(input.candidateId, input.fingerprintValues),
  });
  const profile = Object.freeze({
    name: input.label,
    connectorId: POSTGRES_CONNECTOR_ID,
    engine: 'postgres' as const,
    endpoints: Object.freeze([Object.freeze({ transport: 'tcp' as const, host: input.host, port: input.port, database: input.database, ...(input.ssl === undefined ? {} : { ssl: input.ssl }) })]),
    ...(input.username === undefined ? {} : { principal: input.username }),
    purpose: 'query' as const,
    readOnly: false,
    ...(input.connectTimeoutMs === undefined ? {} : { network: Object.freeze({ connectTimeoutMs: input.connectTimeoutMs }) }),
  }) satisfies ExternalConnectionProfile;
  const credential = Object.freeze({
    ...(input.username === undefined ? {} : { username: input.username }),
    ...(input.password === undefined ? {} : { password: input.password }),
  });
  return Object.freeze({ candidate, profile, credential });
}

function fingerprint(source: string, values: readonly (string | undefined)[]): string {
  return createHash('sha256').update(JSON.stringify({ source, values })).digest('hex');
}

function optionalEnvironmentValue(value: string | undefined, name: string, maximum: number): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (value.length > maximum || hasControlCharacter(value)) throw invalidEnvironment(`${name} is invalid.`);
  return value;
}

function decodedPath(pathname: string): string {
  const value = pathname.replace(/^\/+/, '');
  return value === '' ? '' : decodedValue(value, 'DATABASE_URL database');
}

function decodedValue(value: string, name: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded || decoded.length > 1_048_576 || hasControlCharacter(decoded)) throw invalidEnvironment(`${name} is invalid.`);
    return decoded;
  } catch (error) {
    if (error instanceof DatabaseCapabilityError) throw error;
    throw invalidEnvironment(`${name} is invalid.`);
  }
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some(character => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function portNumber(value: string, name: string): number {
  if (!/^\d{1,5}$/u.test(value)) throw invalidEnvironment(`${name} is invalid.`);
  const port = Number(value);
  if (port < 1 || port > 65_535) throw invalidEnvironment(`${name} is invalid.`);
  return port;
}

function connectionTimeout(value: string | null | undefined, name: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (!/^\d{1,5}$/u.test(value)) throw invalidEnvironment(`${name} is invalid.`);
  const seconds = Number(value);
  if (seconds < 1 || seconds > 86_400) throw invalidEnvironment(`${name} is invalid.`);
  return seconds * 1_000;
}

function sslMode(value: string | null | undefined, name: string): boolean | 'require' | 'verify-ca' | 'verify-full' | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'disable') return false;
  if (value === 'require' || value === 'verify-ca' || value === 'verify-full') return value;
  if (value === 'allow' || value === 'prefer') return undefined;
  throw invalidEnvironment(`${name} is invalid.`);
}

function assertLifecycle(context?: AgentCapabilityLifecycleContext): void {
  if (context?.signal.aborted) throw new DatabaseCapabilityError('ABORTED', 'Database environment discovery was cancelled.', true);
  if (context?.deadline !== undefined && (!Number.isFinite(Date.parse(context.deadline)) || Date.now() >= Date.parse(context.deadline))) {
    throw new DatabaseCapabilityError('ABORTED', 'Database environment discovery deadline expired.', true);
  }
}

function invalidEnvironment(message: string): DatabaseCapabilityError {
  return new DatabaseCapabilityError('NOT_CONFIGURED', `Standard PostgreSQL environment is invalid: ${message}`, true);
}
