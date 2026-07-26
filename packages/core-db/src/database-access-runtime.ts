import { randomUUID } from 'node:crypto';
import type {
  CapabilityProfile,
  ConnectionHealth,
  ConnectionProfile,
  ConnectionProfileId,
  ConnectionSession,
  ConnectionSessionId,
  ConnectionTestResult,
  CredentialReference,
  DatabaseAccessError,
  DatabaseAuditEvent,
  DatabaseCredential,
  DbColumnValue,
  DatabaseObservationRequest,
  DatabaseOperationRequest,
  DatabaseOperationResult,
  DatabaseTransaction,
  QueryJob,
  QuerySubmission,
  ResourceDiscoveryPage,
  ResourceDescriptor,
  ResourceObservation,
  ResourceQuery,
  ResourceQueryPage,
  ResourceRegistrySnapshot,
  ResourceRelation,
  ResourceScope,
  ResultBatch,
} from '@dbagent/shared';
import {
  ContractValidationError,
  assertConnectionProfile,
  assertQuerySubmission,
} from '@dbagent/shared';
import { ResourceConflictError, ResourceRegistry } from '@dbagent/core-resource';
import {
  CapabilityResolver,
  CapabilityUnavailableError,
  DATABASE_CAPABILITIES,
} from './capability-resolver.js';
import type { ConnectorContext, TransactionOptions } from './connector.js';
import { ConnectorNotFoundError, ConnectorRegistry } from './connector-registry.js';
import { parseSql, permissionAllows } from './sql-parser.js';

export interface CredentialResolver {
  resolve(reference: CredentialReference): Promise<DatabaseCredential>;
}

export interface DatabaseAuditSink {
  write(event: DatabaseAuditEvent): Promise<void> | void;
}

export type DatabaseAccessRuntimeOptions = {
  connectors?: ConnectorRegistry;
  resources?: ResourceRegistry;
  credentialResolver?: CredentialResolver;
  auditSink?: DatabaseAuditSink;
  maxAuditEvents?: number;
  now?: () => Date;
};

export type DatabaseAccessMetrics = {
  profiles: number;
  connectedSessions: number;
  resources: number;
  relations: number;
  submittedQueries: number;
  cancelledQueries: number;
  discoveryPages: number;
  connectorErrors: number;
  platformSubmitTotalMs: number;
  platformCancelTotalMs: number;
};

type JobBinding = {
  profileId: ConnectionProfileId;
  sessionId?: ConnectionSessionId;
};

type QueryJobBinding = JobBinding & {
  resourceId?: string;
  authorization?: DatabaseAuditEvent['authorization'];
  started: Date;
};

export class DatabaseAccessRuntime {
  readonly connectors: ConnectorRegistry;
  readonly resources: ResourceRegistry;
  readonly #capabilityResolver = new CapabilityResolver();
  readonly #profiles = new Map<ConnectionProfileId, ConnectionProfile>();
  readonly #sessions = new Map<ConnectionSessionId, ConnectionSession>();
  readonly #profileSessions = new Map<ConnectionProfileId, ConnectionSessionId>();
  readonly #jobs = new Map<string, QueryJobBinding>();
  readonly #terminalAuditedJobs = new Set<string>();
  readonly #results = new Map<string, QueryJobBinding>();
  readonly #transactions = new Map<string, JobBinding>();
  readonly #audit: DatabaseAuditEvent[] = [];
  readonly #credentialResolver: CredentialResolver | undefined;
  readonly #auditSink: DatabaseAuditSink | undefined;
  readonly #maxAuditEvents: number;
  readonly #now: () => Date;
  readonly #metric = {
    submittedQueries: 0,
    cancelledQueries: 0,
    discoveryPages: 0,
    connectorErrors: 0,
    platformSubmitTotalMs: 0,
    platformCancelTotalMs: 0,
  };

  constructor(options: DatabaseAccessRuntimeOptions = {}) {
    this.connectors = options.connectors ?? new ConnectorRegistry();
    this.resources = options.resources ?? new ResourceRegistry();
    this.#credentialResolver = options.credentialResolver;
    this.#auditSink = options.auditSink;
    this.#maxAuditEvents = options.maxAuditEvents ?? 10_000;
    this.#now = options.now ?? (() => new Date());
  }

  createProfile(profile: ConnectionProfile): ConnectionProfile {
    if (this.#profiles.has(profile.id)) {
      throw runtimeError(
        'PROFILE_EXISTS',
        'conflict',
        `Connection profile already exists: ${profile.id}`,
        {
          stage: 'profile',
          profileId: profile.id,
        },
      );
    }
    this.#validateProfile(profile);
    const stored = cloneProfile(profile);
    this.#profiles.set(stored.id, stored);
    return cloneProfile(stored);
  }

  updateProfile(
    profileId: ConnectionProfileId,
    changes: Partial<Omit<ConnectionProfile, 'id' | 'createdAt'>>,
  ): ConnectionProfile {
    const current = this.#requireProfile(profileId);
    const session = this.getSessionForProfile(profileId);
    if (session?.status === 'connected' || session?.status === 'connecting') {
      throw runtimeError(
        'PROFILE_IN_USE',
        'conflict',
        'Disconnect the profile before changing connection settings',
        { stage: 'profile', profileId },
      );
    }
    const updated: ConnectionProfile = {
      ...current,
      ...structuredClone(changes),
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: this.#now().toISOString(),
    };
    this.#validateProfile(updated);
    this.#profiles.set(profileId, updated);
    return cloneProfile(updated);
  }

  deleteProfile(profileId: ConnectionProfileId): boolean {
    const session = this.getSessionForProfile(profileId);
    if (session?.status === 'connected' || session?.status === 'connecting') {
      throw runtimeError(
        'PROFILE_IN_USE',
        'conflict',
        'Disconnect the profile before deleting it',
        {
          stage: 'profile',
          profileId,
        },
      );
    }
    if (session) this.#sessions.delete(session.id);
    this.#profileSessions.delete(profileId);
    return this.#profiles.delete(profileId);
  }

  getProfile(profileId: ConnectionProfileId): ConnectionProfile | undefined {
    const profile = this.#profiles.get(profileId);
    return profile ? cloneProfile(profile) : undefined;
  }

  listProfiles(): ConnectionProfile[] {
    return [...this.#profiles.values()]
      .map(cloneProfile)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async testProfile(
    profileId: ConnectionProfileId,
    credential?: DatabaseCredential,
  ): Promise<ConnectionTestResult> {
    const started = this.#now();
    const context = await this.#context(profileId, credential, false);
    try {
      const result = await this.connectors.get(context.profile.connectorId).test(context);
      await this.#recordAudit({
        action: 'database.profile.test',
        profileId,
        started,
        status: 'succeeded',
      });
      return structuredClone(result);
    } catch (error) {
      await this.#recordFailure('database.profile.test', profileId, started, error);
      throw this.#normalizeError(error, 'connect', profileId, context.credential);
    }
  }

  async connect(
    profileId: ConnectionProfileId,
    credential?: DatabaseCredential,
  ): Promise<ConnectionSession> {
    const started = this.#now();
    const existing = this.getSessionForProfile(profileId);
    if (existing?.status === 'connected') return existing;
    const context = await this.#context(profileId, credential, false);
    try {
      const session = await this.connectors.get(context.profile.connectorId).connect(context);
      this.#validateSession(session, context.profile);
      const generation = (existing?.generation ?? 0) + 1;
      const stored = { ...structuredClone(session), generation, status: 'connected' as const };
      if (existing) this.#sessions.delete(existing.id);
      this.#sessions.set(stored.id, stored);
      this.#profileSessions.set(profileId, stored.id);
      await this.#recordAudit({
        action: 'database.connect',
        profileId,
        started,
        status: 'succeeded',
      });
      return structuredClone(stored);
    } catch (error) {
      await this.#recordFailure('database.connect', profileId, started, error);
      throw this.#normalizeError(error, 'connect', profileId, context.credential);
    }
  }

  async reconnect(
    profileId: ConnectionProfileId,
    credential?: DatabaseCredential,
  ): Promise<ConnectionSession> {
    const started = this.#now();
    const context = await this.#context(profileId, credential, true);
    const connector = this.connectors.get(context.profile.connectorId);
    try {
      const session = connector.reconnect
        ? await connector.reconnect(context)
        : await this.#disconnectThenConnect(context);
      this.#validateSession(session, context.profile);
      const previous = context.session;
      if (previous) this.#sessions.delete(previous.id);
      const stored = {
        ...structuredClone(session),
        generation: (previous?.generation ?? 0) + 1,
        status: 'connected' as const,
      };
      this.#sessions.set(stored.id, stored);
      this.#profileSessions.set(profileId, stored.id);
      await this.#recordAudit({
        action: 'database.reconnect',
        profileId,
        started,
        status: 'succeeded',
      });
      return structuredClone(stored);
    } catch (error) {
      await this.#recordFailure('database.reconnect', profileId, started, error);
      throw this.#normalizeError(error, 'connect', profileId, context.credential);
    }
  }

  async disconnect(profileId: ConnectionProfileId): Promise<void> {
    const started = this.#now();
    const context = await this.#context(profileId, undefined, true, false);
    if (!context.session || context.session.status === 'disconnected') return;
    try {
      await this.connectors.get(context.profile.connectorId).disconnect(context);
      const disconnected: ConnectionSession = {
        ...context.session,
        status: 'disconnected',
        lastHealth: {
          status: 'unavailable',
          checkedAt: this.#now().toISOString(),
          message: 'Disconnected by caller',
        },
      };
      this.#sessions.set(disconnected.id, disconnected);
      await this.#recordAudit({
        action: 'database.disconnect',
        profileId,
        started,
        status: 'succeeded',
      });
    } catch (error) {
      await this.#recordFailure('database.disconnect', profileId, started, error);
      throw this.#normalizeError(error, 'connect', profileId);
    }
  }

  async health(profileId: ConnectionProfileId): Promise<ConnectionHealth> {
    const context = await this.#context(profileId, undefined, true, false);
    try {
      const health = await this.connectors.get(context.profile.connectorId).health(context);
      if (context.session) {
        this.#sessions.set(context.session.id, { ...context.session, lastHealth: health });
      }
      return structuredClone(health);
    } catch (error) {
      throw this.#normalizeError(error, 'connect', profileId);
    }
  }

  getSession(sessionId: ConnectionSessionId): ConnectionSession | undefined {
    const session = this.#sessions.get(sessionId);
    return session ? structuredClone(session) : undefined;
  }

  getSessionForProfile(profileId: ConnectionProfileId): ConnectionSession | undefined {
    const sessionId = this.#profileSessions.get(profileId);
    return sessionId ? this.getSession(sessionId) : undefined;
  }

  async capabilities(profileId: ConnectionProfileId): Promise<CapabilityProfile> {
    const context = await this.#context(profileId, undefined, false, false);
    const connector = this.connectors.get(context.profile.connectorId);
    try {
      const dynamic = await connector.capabilities(context);
      return this.#capabilityResolver.resolve({
        connectorId: connector.manifest.id,
        engine: connector.manifest.engine,
        ...(dynamic.engineVersion ? { engineVersion: dynamic.engineVersion } : {}),
        connectionProfileId: profileId,
        layers: [
          {
            source: `${connector.manifest.id}:manifest`,
            capabilities: stripCapabilityRuntimeFields(connector.manifest.capabilities),
          },
          {
            source: `${connector.manifest.id}:runtime`,
            capabilities: stripCapabilityRuntimeFields(dynamic.capabilities),
          },
        ],
        context: {
          purpose: context.profile.purpose,
          readOnly: context.profile.readOnly,
          connected: context.session?.status === 'connected',
        },
      });
    } catch (error) {
      throw this.#normalizeError(error, 'connect', profileId);
    }
  }

  async discoverPage(
    profileId: ConnectionProfileId,
    input: { cursor?: string; limit?: number; kinds?: string[]; incrementalSince?: string } = {},
  ): Promise<ResourceDiscoveryPage> {
    const context = await this.#context(profileId, undefined, true, false);
    try {
      const page = applyProfileScope(
        await this.connectors.get(context.profile.connectorId).discover(context, input),
        context.profile.scope,
        profileId,
      );
      this.resources.applyDiscoveryPage(page);
      this.#metric.discoveryPages += 1;
      return structuredClone(page);
    } catch (error) {
      throw this.#normalizeError(error, 'discover', profileId);
    }
  }

  async discoverAll(
    profileId: ConnectionProfileId,
    input: {
      pageSize?: number;
      kinds?: string[];
      incrementalSince?: string;
      maxPages?: number;
    } = {},
  ): Promise<{ pages: number; resources: number; relations: number; observations: number }> {
    const maxPages = input.maxPages ?? 10_000;
    let cursor: string | undefined;
    let pages = 0;
    let resourceCount = 0;
    let relationCount = 0;
    let observationCount = 0;
    const seenCursors = new Set<string>();
    do {
      const page = await this.discoverPage(profileId, {
        ...(cursor ? { cursor } : {}),
        ...(input.pageSize ? { limit: input.pageSize } : {}),
        ...(input.kinds ? { kinds: input.kinds } : {}),
        ...(input.incrementalSince ? { incrementalSince: input.incrementalSince } : {}),
      });
      pages += 1;
      resourceCount += page.resources.length;
      relationCount += page.relations.length;
      observationCount += page.observations?.length ?? 0;
      if (pages > maxPages) {
        throw runtimeError(
          'DISCOVERY_PAGE_LIMIT',
          'provider',
          'Discovery exceeded its page limit',
          {
            stage: 'discover',
            profileId,
          },
        );
      }
      if (page.nextCursor && seenCursors.has(page.nextCursor)) {
        throw runtimeError(
          'DISCOVERY_CURSOR_LOOP',
          'provider',
          'Connector repeated a discovery cursor',
          {
            stage: 'discover',
            profileId,
          },
        );
      }
      if (page.nextCursor) seenCursors.add(page.nextCursor);
      cursor = page.complete ? undefined : page.nextCursor;
      if (!page.complete && !cursor) {
        throw runtimeError(
          'DISCOVERY_CURSOR_MISSING',
          'provider',
          'Incomplete discovery page did not provide a cursor',
          { stage: 'discover', profileId },
        );
      }
    } while (cursor);
    return {
      pages,
      resources: resourceCount,
      relations: relationCount,
      observations: observationCount,
    };
  }

  queryResources(query: ResourceQuery = {}): ResourceQueryPage {
    return this.resources.query(query);
  }

  resourceRelations(resourceId: string): ResourceRelation[] {
    return this.resources.relationsFor(resourceId);
  }

  async submit(submission: QuerySubmission): Promise<QueryJob> {
    const platformStarted = performance.now();
    const started = this.#now();
    this.#validateSubmission(submission);
    const context = await this.#context(submission.profileId, undefined, true, false);
    try {
      const permissionMode = submission.authorization?.permissionMode ?? 'read';
      const requiredPermission = parseSql(submission.sql).requiredPermission;
      if (!permissionAllows(permissionMode, requiredPermission)) {
        throw runtimeError(
          'QUERY_PERMISSION_DENIED',
          'authorization',
          `SQL requires ${requiredPermission} permission, but the effective mode is ${permissionMode}.`,
          {
            stage: 'submit',
            profileId: submission.profileId,
          },
        );
      }
      const effectiveAuthorization: NonNullable<QuerySubmission['authorization']> = {
        ...(submission.authorization ?? {}),
        permissionMode,
      };
      const effectiveSubmission: QuerySubmission = {
        ...submission,
        authorization: effectiveAuthorization,
      };
      const capabilities = await this.capabilities(submission.profileId);
      this.#capabilityResolver.require(capabilities, { key: DATABASE_CAPABILITIES.SQL_QUERY });
      if (submission.executionMode === 'async') {
        this.#capabilityResolver.require(capabilities, { key: DATABASE_CAPABILITIES.QUERY_ASYNC });
      }
      const job = await this.connectors
        .get(context.profile.connectorId)
        .submit(context, cloneQuerySubmission(effectiveSubmission));
      this.#validateJob(job, submission.profileId, context.profile.connectorId);
      const binding: QueryJobBinding = {
        profileId: submission.profileId,
        ...(context.session ? { sessionId: context.session.id } : {}),
        ...(submission.resourceId ? { resourceId: submission.resourceId } : {}),
        authorization: effectiveAuthorization,
        started,
      };
      this.#jobs.set(job.id, binding);
      if (job.result) this.#results.set(job.result.id, binding);
      this.#metric.submittedQueries += 1;
      this.#metric.platformSubmitTotalMs += performance.now() - platformStarted;
      if (isTerminalJob(job)) {
        await this.#recordTerminalJobAudit(job, binding, 'database.query.submit', started);
      } else {
        await this.#recordAudit({
          action: 'database.query.submit',
          profileId: submission.profileId,
          ...(submission.resourceId ? { resourceId: submission.resourceId } : {}),
          jobId: job.id,
          authorization: effectiveAuthorization,
          started,
          status: 'unknown',
        });
      }
      return structuredClone(job);
    } catch (error) {
      this.#metric.platformSubmitTotalMs += performance.now() - platformStarted;
      await this.#recordFailure('database.query.submit', submission.profileId, started, error);
      throw this.#normalizeError(error, 'submit', submission.profileId);
    }
  }

  async getJob(jobId: string): Promise<QueryJob> {
    const { context, binding } = await this.#jobContext(jobId);
    try {
      const job = await this.connectors.get(context.profile.connectorId).getJob(context, jobId);
      if (job.result) this.#results.set(job.result.id, binding);
      await this.#recordTerminalJobAudit(job, binding);
      return structuredClone(job);
    } catch (error) {
      throw this.#normalizeError(error, 'execute', binding.profileId, undefined, jobId);
    }
  }

  async cancel(jobId: string): Promise<QueryJob> {
    const platformStarted = performance.now();
    const started = this.#now();
    const { context, binding } = await this.#jobContext(jobId);
    try {
      const job = await this.connectors.get(context.profile.connectorId).cancel(context, jobId);
      this.#metric.cancelledQueries += 1;
      this.#metric.platformCancelTotalMs += performance.now() - platformStarted;
      if (isTerminalJob(job)) {
        await this.#recordTerminalJobAudit(job, binding, 'database.query.cancel', started);
      } else {
        await this.#recordAudit({
          action: 'database.query.cancel',
          profileId: binding.profileId,
          jobId,
          authorization: binding.authorization,
          started,
          status: 'unknown',
        });
      }
      return structuredClone(job);
    } catch (error) {
      this.#metric.platformCancelTotalMs += performance.now() - platformStarted;
      await this.#recordFailure('database.query.cancel', binding.profileId, started, error, jobId);
      throw this.#normalizeError(error, 'cancel', binding.profileId, undefined, jobId);
    }
  }

  async readResult(
    handleId: string,
    input: { cursor?: string; limit?: number } = {},
  ): Promise<ResultBatch> {
    const binding = this.#results.get(handleId);
    if (!binding) {
      throw runtimeError('RESULT_NOT_FOUND', 'not-found', `Unknown result handle: ${handleId}`, {
        stage: 'result',
      });
    }
    const context = await this.#context(binding.profileId, undefined, true, false);
    try {
      return cloneResultBatch(
        await this.connectors.get(context.profile.connectorId).readResult(context, handleId, input),
      );
    } catch (error) {
      throw this.#normalizeError(error, 'result', binding.profileId);
    }
  }

  async *streamResult(
    handleId: string,
    input: { batchSize?: number } = {},
  ): AsyncIterable<ResultBatch> {
    const binding = this.#results.get(handleId);
    if (!binding) {
      throw runtimeError('RESULT_NOT_FOUND', 'not-found', `Unknown result handle: ${handleId}`, {
        stage: 'result',
      });
    }
    const context = await this.#context(binding.profileId, undefined, true, false);
    const connector = this.connectors.get(context.profile.connectorId);
    if (connector.streamResult) {
      for await (const batch of connector.streamResult(context, handleId, input)) {
        yield cloneResultBatch(batch);
      }
      return;
    }
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const batch = await connector.readResult(context, handleId, {
        ...(cursor ? { cursor } : {}),
        ...(input.batchSize ? { limit: input.batchSize } : {}),
      });
      yield cloneResultBatch(batch);
      if (batch.complete) return;
      if (!batch.nextCursor || seen.has(batch.nextCursor)) {
        throw runtimeError(
          'RESULT_CURSOR_INVALID',
          'provider',
          'Connector returned an invalid result cursor',
          {
            stage: 'result',
            profileId: binding.profileId,
          },
        );
      }
      seen.add(batch.nextCursor);
      cursor = batch.nextCursor;
    } while (cursor);
  }

  async beginTransaction(
    profileId: ConnectionProfileId,
    options?: TransactionOptions,
  ): Promise<DatabaseTransaction> {
    const context = await this.#context(profileId, undefined, true, false);
    const connector = this.connectors.get(context.profile.connectorId);
    if (!connector.beginTransaction) {
      throw runtimeError(
        'TRANSACTION_UNSUPPORTED',
        'unsupported',
        'Connector does not support transactions',
        {
          stage: 'execute',
          profileId,
        },
      );
    }
    const capabilities = await this.capabilities(profileId);
    this.#capabilityResolver.require(capabilities, { key: DATABASE_CAPABILITIES.TRANSACTION });
    const transaction = await connector.beginTransaction(context, options);
    this.#transactions.set(transaction.id, {
      profileId,
      ...(context.session ? { sessionId: context.session.id } : {}),
    });
    return structuredClone(transaction);
  }

  async createSavepoint(transactionId: string, name: string): Promise<DatabaseTransaction> {
    validateSavepointName(name);
    return this.#transactionAction(transactionId, 'createSavepoint', name);
  }

  async rollbackToSavepoint(transactionId: string, name: string): Promise<DatabaseTransaction> {
    validateSavepointName(name);
    return this.#transactionAction(transactionId, 'rollbackToSavepoint', name);
  }

  async commitTransaction(transactionId: string): Promise<DatabaseTransaction> {
    return this.#transactionAction(transactionId, 'commitTransaction');
  }

  async rollbackTransaction(transactionId: string): Promise<DatabaseTransaction> {
    return this.#transactionAction(transactionId, 'rollbackTransaction');
  }

  async observe(request: DatabaseObservationRequest): Promise<ResourceObservation[]> {
    const context = await this.#context(request.profileId, undefined, true, false);
    const connector = this.connectors.get(context.profile.connectorId);
    if (!connector.observe) {
      throw runtimeError(
        'OBSERVATION_UNSUPPORTED',
        'unsupported',
        'Connector does not expose observations',
        {
          stage: 'observe',
          profileId: request.profileId,
        },
      );
    }
    try {
      const observations = await connector.observe(context, request);
      for (const observation of observations) {
        if (this.resources.getResource(observation.resourceId, true)) {
          this.resources.addObservation(observation);
        }
      }
      return structuredClone(observations);
    } catch (error) {
      throw this.#normalizeError(error, 'observe', request.profileId);
    }
  }

  async operate(request: DatabaseOperationRequest): Promise<DatabaseOperationResult> {
    const started = this.#now();
    const context = await this.#context(request.profileId, undefined, true, false);
    const connector = this.connectors.get(context.profile.connectorId);
    if (!connector.operate) {
      throw runtimeError(
        'OPERATION_UNSUPPORTED',
        'unsupported',
        'Connector does not expose operations',
        {
          stage: 'operate',
          profileId: request.profileId,
        },
      );
    }
    const descriptor = connector.manifest.operations.find((item) => item.key === request.operation);
    if (!descriptor) {
      throw runtimeError(
        'OPERATION_UNKNOWN',
        'unsupported',
        `Unknown operation: ${request.operation}`,
        {
          stage: 'operate',
          profileId: request.profileId,
        },
      );
    }
    if (descriptor.risk !== 'read' && !hasOperationAuthorization(request)) {
      throw runtimeError(
        'OPERATION_APPROVAL_REQUIRED',
        'authorization',
        `Operation ${request.operation} requires an authorization or approval context`,
        { stage: 'operate', profileId: request.profileId },
      );
    }
    const capabilities = await this.capabilities(request.profileId);
    this.#capabilityResolver.require(capabilities, {
      key: descriptor.requiredCapability,
      context: { approved: hasOperationAuthorization(request) },
    });
    try {
      const result = await connector.operate(context, structuredClone(request));
      await this.#recordAudit({
        action: `database.operation.${request.operation}`,
        profileId: request.profileId,
        ...(request.resourceId ? { resourceId: request.resourceId } : {}),
        authorization: request.authorization,
        started,
        status: result.status === 'failed' ? 'failed' : 'succeeded',
        ...(result.error ? { errorCode: result.error.code } : {}),
      });
      return structuredClone(result);
    } catch (error) {
      await this.#recordFailure(
        `database.operation.${request.operation}`,
        request.profileId,
        started,
        error,
      );
      throw this.#normalizeError(error, 'operate', request.profileId);
    }
  }

  listAuditEvents(input: { profileId?: string; limit?: number } = {}): DatabaseAuditEvent[] {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), this.#maxAuditEvents);
    return this.#audit
      .filter((event) => !input.profileId || event.profileId === input.profileId)
      .slice(-limit)
      .reverse()
      .map((event) => structuredClone(event));
  }

  metrics(): DatabaseAccessMetrics {
    return {
      profiles: this.#profiles.size,
      connectedSessions: [...this.#sessions.values()].filter((item) => item.status === 'connected')
        .length,
      resources: this.resources.size,
      relations: this.resources.relationCount,
      ...this.#metric,
    };
  }

  snapshotResources(): ResourceRegistrySnapshot {
    return this.resources.snapshot();
  }

  async close(): Promise<void> {
    const connected = [...this.#profileSessions.keys()];
    const failures: unknown[] = [];
    for (const profileId of connected) {
      try {
        await this.disconnect(profileId);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'One or more database connections could not be closed');
    }
  }

  async #context(
    profileId: ConnectionProfileId,
    directCredential: DatabaseCredential | undefined,
    requireSession: boolean,
    resolveCredential = true,
  ): Promise<ConnectorContext> {
    const profile = this.#requireProfile(profileId);
    const session = this.getSessionForProfile(profileId);
    if (requireSession && session?.status !== 'connected') {
      throw runtimeError('NOT_CONNECTED', 'network', `Profile is not connected: ${profileId}`, {
        stage: 'connect',
        profileId,
        retryable: true,
      });
    }
    let credential = directCredential;
    if (!credential && resolveCredential && profile.credentialRef) {
      if (!this.#credentialResolver) {
        throw runtimeError(
          'CREDENTIAL_RESOLVER_MISSING',
          'authentication',
          'Profile references a credential provider but no resolver is configured',
          { stage: 'connect', profileId },
        );
      }
      credential = await this.#credentialResolver.resolve(profile.credentialRef);
    }
    return {
      profile,
      ...(credential ? { credential: structuredClone(credential) } : {}),
      ...(session ? { session } : {}),
    };
  }

  #requireProfile(profileId: ConnectionProfileId): ConnectionProfile {
    const profile = this.#profiles.get(profileId);
    if (!profile) {
      throw runtimeError(
        'PROFILE_NOT_FOUND',
        'not-found',
        `Unknown connection profile: ${profileId}`,
        {
          stage: 'profile',
          profileId,
        },
      );
    }
    return cloneProfile(profile);
  }

  #validateProfile(profile: ConnectionProfile): void {
    if (!profile.id || !profile.name || !profile.connectorId || !profile.engine) {
      throw runtimeError(
        'PROFILE_INVALID',
        'validation',
        'Profile identity fields cannot be empty',
        {
          stage: 'profile',
          profileId: profile.id,
        },
      );
    }
    if (profile.endpoints.length === 0) {
      throw runtimeError('ENDPOINT_REQUIRED', 'validation', 'At least one endpoint is required', {
        stage: 'profile',
        profileId: profile.id,
      });
    }
    let connector;
    try {
      connector = this.connectors.get(profile.connectorId);
    } catch (error) {
      if (error instanceof ConnectorNotFoundError) {
        throw runtimeError('CONNECTOR_NOT_FOUND', 'not-found', error.message, {
          stage: 'profile',
          profileId: profile.id,
        });
      }
      throw error;
    }
    if (connector.manifest.engine !== profile.engine) {
      throw runtimeError(
        'ENGINE_MISMATCH',
        'validation',
        `Profile engine ${profile.engine} does not match connector engine ${connector.manifest.engine}`,
        { stage: 'profile', profileId: profile.id },
      );
    }
    for (const endpoint of profile.endpoints) {
      if (!connector.manifest.transports.includes(endpoint.transport)) {
        throw runtimeError(
          'TRANSPORT_UNSUPPORTED',
          'unsupported',
          `Connector ${connector.manifest.id} does not support ${endpoint.transport}`,
          { stage: 'profile', profileId: profile.id },
        );
      }
      validateEndpoint(endpoint, profile.id);
    }
    if (profile.purpose === 'read-only' && !profile.readOnly) {
      throw runtimeError(
        'READ_ONLY_PROFILE_INVALID',
        'validation',
        'A read-only purpose must use readOnly=true',
        { stage: 'profile', profileId: profile.id },
      );
    }
    try {
      assertConnectionProfile(profile);
    } catch (error) {
      if (error instanceof ContractValidationError) {
        throw runtimeError('PROFILE_CONTRACT_INVALID', 'validation', error.message, {
          stage: 'profile',
          profileId: profile.id,
        });
      }
      throw error;
    }
  }

  #validateSession(session: ConnectionSession, profile: ConnectionProfile): void {
    if (
      !session.id ||
      session.profileId !== profile.id ||
      session.connectorId !== profile.connectorId ||
      session.endpointIndex < 0 ||
      session.endpointIndex >= profile.endpoints.length
    ) {
      throw runtimeError(
        'CONNECTOR_SESSION_INVALID',
        'provider',
        'Connector returned an invalid session',
        {
          stage: 'connect',
          profileId: profile.id,
        },
      );
    }
  }

  #validateJob(job: QueryJob, profileId: string, connectorId: string): void {
    if (!job.id || job.profileId !== profileId || job.connectorId !== connectorId) {
      throw runtimeError(
        'CONNECTOR_JOB_INVALID',
        'provider',
        'Connector returned an invalid query job',
        {
          stage: 'submit',
          profileId,
        },
      );
    }
  }

  #validateSubmission(submission: QuerySubmission): void {
    if (!submission.profileId || typeof submission.profileId !== 'string') {
      throw runtimeError('QUERY_PROFILE_REQUIRED', 'validation', 'Query profileId is required.', {
        stage: 'submit',
      });
    }
    if (typeof submission.sql !== 'string' || !submission.sql.trim()) {
      throw runtimeError(
        'QUERY_SQL_REQUIRED',
        'validation',
        'Query SQL must be a non-empty string.',
        { stage: 'submit', profileId: submission.profileId },
      );
    }
    for (const [name, value] of [
      ['timeoutMs', submission.timeoutMs],
      ['rowLimit', submission.rowLimit],
      ['batchSize', submission.batchSize],
    ] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
        throw runtimeError(
          'QUERY_LIMIT_INVALID',
          'validation',
          `${name} must be a positive integer.`,
          { stage: 'submit', profileId: submission.profileId },
        );
      }
    }
    for (const [name, value] of [
      ['maximumBytesScanned', submission.maximumBytesScanned],
      ['maximumCost', submission.maximumCost],
    ] as const) {
      if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
        throw runtimeError(
          'QUERY_BUDGET_INVALID',
          'validation',
          `${name} must be a non-negative finite number.`,
          { stage: 'submit', profileId: submission.profileId },
        );
      }
    }
    if (
      submission.priority !== undefined &&
      (!Number.isSafeInteger(submission.priority) || submission.priority < 0)
    ) {
      throw runtimeError(
        'QUERY_PRIORITY_INVALID',
        'validation',
        'priority must be a non-negative integer.',
        { stage: 'submit', profileId: submission.profileId },
      );
    }
    try {
      assertQuerySubmission(submission);
    } catch (error) {
      if (error instanceof ContractValidationError) {
        throw runtimeError('QUERY_CONTRACT_INVALID', 'validation', error.message, {
          stage: 'submit',
          profileId: submission.profileId,
        });
      }
      throw error;
    }
  }

  async #disconnectThenConnect(context: ConnectorContext): Promise<ConnectionSession> {
    const connector = this.connectors.get(context.profile.connectorId);
    if (context.session) await connector.disconnect(context);
    return connector.connect({
      profile: context.profile,
      ...(context.credential ? { credential: context.credential } : {}),
    });
  }

  async #jobContext(
    jobId: string,
  ): Promise<{ context: ConnectorContext; binding: QueryJobBinding }> {
    const binding = this.#jobs.get(jobId);
    if (!binding) {
      throw runtimeError('QUERY_JOB_NOT_FOUND', 'not-found', `Unknown query job: ${jobId}`, {
        stage: 'execute',
        jobId,
      });
    }
    const context = await this.#context(binding.profileId, undefined, true, false);
    return { context, binding };
  }

  async #transactionAction(
    transactionId: string,
    action: 'createSavepoint' | 'rollbackToSavepoint' | 'commitTransaction' | 'rollbackTransaction',
    name?: string,
  ): Promise<DatabaseTransaction> {
    const binding = this.#transactions.get(transactionId);
    if (!binding) {
      throw runtimeError(
        'TRANSACTION_NOT_FOUND',
        'not-found',
        `Unknown transaction: ${transactionId}`,
        {
          stage: 'execute',
        },
      );
    }
    const context = await this.#context(binding.profileId, undefined, true, false);
    const connector = this.connectors.get(context.profile.connectorId);
    let result: DatabaseTransaction;
    if (action === 'createSavepoint') {
      if (!connector.createSavepoint) {
        throw unsupportedTransactionAction(action, binding.profileId);
      }
      result = await connector.createSavepoint(context, transactionId, name ?? '');
    } else if (action === 'rollbackToSavepoint') {
      if (!connector.rollbackToSavepoint) {
        throw unsupportedTransactionAction(action, binding.profileId);
      }
      result = await connector.rollbackToSavepoint(context, transactionId, name ?? '');
    } else if (action === 'commitTransaction') {
      if (!connector.commitTransaction) {
        throw unsupportedTransactionAction(action, binding.profileId);
      }
      result = await connector.commitTransaction(context, transactionId);
    } else {
      if (!connector.rollbackTransaction) {
        throw unsupportedTransactionAction(action, binding.profileId);
      }
      result = await connector.rollbackTransaction(context, transactionId);
    }
    return structuredClone(result);
  }

  async #recordFailure(
    action: string,
    profileId: string,
    started: Date,
    error: unknown,
    jobId?: string,
  ): Promise<void> {
    this.#metric.connectorErrors += 1;
    const normalized =
      error instanceof DatabaseAccessRuntimeError
        ? error.error
        : normalizeUnknownError(error, 'internal', profileId);
    await this.#recordAudit({
      action,
      profileId,
      ...(jobId ? { jobId } : {}),
      started,
      status: normalized.outcome === 'unknown' ? 'unknown' : 'failed',
      errorCode: normalized.code,
    });
  }

  async #recordTerminalJobAudit(
    job: QueryJob,
    binding: QueryJobBinding,
    action = 'database.query.complete',
    started = binding.started,
  ): Promise<boolean> {
    if (!isTerminalJob(job) || this.#terminalAuditedJobs.has(job.id)) return false;
    this.#terminalAuditedJobs.add(job.id);
    await this.#recordAudit({
      action,
      profileId: binding.profileId,
      ...(binding.resourceId ? { resourceId: binding.resourceId } : {}),
      jobId: job.id,
      authorization: binding.authorization,
      started,
      status: terminalAuditStatus(job),
      ...(job.completedAt ? { completedAt: new Date(job.completedAt) } : {}),
      ...(job.error ? { errorCode: job.error.code } : {}),
    });
    return true;
  }

  async #recordAudit(input: {
    action: string;
    profileId?: string;
    resourceId?: string;
    jobId?: string;
    authorization?: DatabaseAuditEvent['authorization'];
    started: Date;
    completedAt?: Date;
    status: DatabaseAuditEvent['status'];
    errorCode?: string;
  }): Promise<void> {
    const completedAt = input.completedAt ?? this.#now();
    const event: DatabaseAuditEvent = {
      id: randomUUID(),
      action: input.action,
      startedAt: input.started.toISOString(),
      completedAt: completedAt.toISOString(),
      status: input.status,
      elapsedMs: Math.max(0, completedAt.getTime() - input.started.getTime()),
      ...(input.profileId ? { profileId: input.profileId } : {}),
      ...(input.resourceId ? { resourceId: input.resourceId } : {}),
      ...(input.jobId ? { jobId: input.jobId } : {}),
      ...(input.authorization ? { authorization: structuredClone(input.authorization) } : {}),
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    };
    this.#audit.push(event);
    if (this.#audit.length > this.#maxAuditEvents) {
      this.#audit.splice(0, this.#audit.length - this.#maxAuditEvents);
    }
    await this.#auditSink?.write(structuredClone(event));
  }

  #normalizeError(
    error: unknown,
    stage: NonNullable<DatabaseAccessError['stage']>,
    profileId?: string,
    credential?: DatabaseCredential,
    jobId?: string,
  ): DatabaseAccessRuntimeError {
    if (error instanceof DatabaseAccessRuntimeError) return error;
    const normalized = normalizeUnknownError(error, stage, profileId, jobId);
    normalized.message = redact(normalized.message, credential);
    if (normalized.detail) normalized.detail = redact(normalized.detail, credential);
    return new DatabaseAccessRuntimeError(normalized);
  }
}

export class DatabaseAccessRuntimeError extends Error {
  constructor(readonly error: DatabaseAccessError) {
    super(error.message);
    this.name = 'DatabaseAccessRuntimeError';
  }
}

function runtimeError(
  code: string,
  category: DatabaseAccessError['category'],
  message: string,
  options: {
    stage?: DatabaseAccessError['stage'];
    profileId?: string;
    jobId?: string;
    retryable?: boolean;
    outcome?: DatabaseAccessError['outcome'];
  } = {},
): DatabaseAccessRuntimeError {
  return new DatabaseAccessRuntimeError({
    code,
    category,
    message,
    retryable: options.retryable ?? false,
    outcome: options.outcome ?? 'unchanged',
    ...(options.stage ? { stage: options.stage } : {}),
    ...(options.profileId ? { profileId: options.profileId } : {}),
    ...(options.jobId ? { jobId: options.jobId } : {}),
  });
}

const RESOURCE_SCOPE_KEYS = [
  'tenantId',
  'organizationId',
  'projectId',
  'environment',
  'region',
] as const satisfies readonly (keyof ResourceScope)[];

function applyProfileScope(
  page: ResourceDiscoveryPage,
  profileScope: ResourceScope | undefined,
  profileId: ConnectionProfileId,
): ResourceDiscoveryPage {
  if (!profileScope) return page;
  return {
    ...page,
    resources: page.resources.map((resource) =>
      applyResourceScope(resource, profileScope, profileId),
    ),
  };
}

function applyResourceScope(
  resource: ResourceDescriptor,
  profileScope: ResourceScope,
  profileId: ConnectionProfileId,
): ResourceDescriptor {
  for (const key of RESOURCE_SCOPE_KEYS) {
    const expected = profileScope[key];
    const actual = resource.scope?.[key];
    if (expected !== undefined && actual !== undefined && expected !== actual) {
      throw runtimeError(
        'DISCOVERY_SCOPE_MISMATCH',
        'authorization',
        `Connector returned resource ${resource.id} outside the connection profile scope`,
        { stage: 'discover', profileId },
      );
    }
  }
  return {
    ...resource,
    scope: {
      ...resource.scope,
      ...profileScope,
    },
  };
}

function normalizeUnknownError(
  error: unknown,
  stage: NonNullable<DatabaseAccessError['stage']> | 'internal',
  profileId?: string,
  jobId?: string,
): DatabaseAccessError {
  if (error instanceof CapabilityUnavailableError) {
    return {
      code: 'CAPABILITY_UNAVAILABLE',
      category: 'unsupported',
      message: error.message,
      ...(stage === 'internal' ? {} : { stage }),
      retryable: false,
      outcome: 'unchanged',
      ...(profileId ? { profileId } : {}),
      ...(jobId ? { jobId } : {}),
    };
  }
  if (error instanceof ResourceConflictError) {
    return {
      code: 'RESOURCE_CONFLICT',
      category: 'conflict',
      message: error.message,
      stage: stage === 'internal' ? 'discover' : stage,
      retryable: false,
      outcome: 'unchanged',
      ...(profileId ? { profileId } : {}),
      ...(jobId ? { jobId } : {}),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'CONNECTOR_ERROR';
  return {
    code,
    category: stage === 'connect' ? 'network' : 'provider',
    message,
    ...(stage === 'internal' ? {} : { stage }),
    retryable:
      stage === 'connect' || stage === 'discover' || stage === 'result' || stage === 'observe',
    outcome:
      stage === 'submit' || stage === 'execute' || stage === 'operate' ? 'unknown' : 'unchanged',
    ...(profileId ? { profileId } : {}),
    ...(jobId ? { jobId } : {}),
  };
}

function unsupportedTransactionAction(
  action: string,
  profileId: string,
): DatabaseAccessRuntimeError {
  return runtimeError(
    'TRANSACTION_ACTION_UNSUPPORTED',
    'unsupported',
    `Connector does not support ${action}`,
    { stage: 'execute', profileId },
  );
}

function validateEndpoint(
  endpoint: ConnectionProfile['endpoints'][number],
  profileId: string,
): void {
  if (endpoint.transport === 'tcp') {
    if (
      !endpoint.host ||
      !Number.isInteger(endpoint.port) ||
      endpoint.port < 1 ||
      endpoint.port > 65_535
    ) {
      throw runtimeError('TCP_ENDPOINT_INVALID', 'validation', 'TCP host and port are invalid', {
        stage: 'profile',
        profileId,
      });
    }
  }
  if (endpoint.transport === 'jdbc') {
    if (!endpoint.url.startsWith('jdbc:') || /\/\/[^/@:]+:[^/@]+@/.test(endpoint.url)) {
      throw runtimeError(
        'JDBC_ENDPOINT_INVALID',
        'validation',
        'JDBC URL must use jdbc: and cannot contain credentials',
        { stage: 'profile', profileId },
      );
    }
  }
  if (endpoint.transport === 'http') {
    let url: URL;
    try {
      url = new URL(endpoint.baseUrl);
    } catch {
      throw runtimeError(
        'HTTP_ENDPOINT_INVALID',
        'validation',
        'HTTP endpoint is not a valid URL',
        {
          stage: 'profile',
          profileId,
        },
      );
    }
    if (url.username || url.password) {
      throw runtimeError(
        'HTTP_ENDPOINT_SECRET',
        'validation',
        'HTTP endpoint cannot contain credentials',
        { stage: 'profile', profileId },
      );
    }
    const secretHeaders = new Set(['authorization', 'proxy-authorization', 'cookie', 'x-api-key']);
    if (Object.keys(endpoint.headers ?? {}).some((key) => secretHeaders.has(key.toLowerCase()))) {
      throw runtimeError(
        'HTTP_HEADER_SECRET',
        'validation',
        'Secret-bearing headers must come from a credential resolver',
        { stage: 'profile', profileId },
      );
    }
  }
}

function validateSavepointName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name)) {
    throw runtimeError(
      'SAVEPOINT_NAME_INVALID',
      'validation',
      'Savepoint names must be 1-63 unquoted identifier characters',
      { stage: 'execute' },
    );
  }
}

function stripCapabilityRuntimeFields(capabilities: CapabilityProfile['capabilities']): Record<
  string,
  Omit<CapabilityProfile['capabilities'][string], 'source' | 'observedAt'> & {
    observedAt?: string;
  }
> {
  return Object.fromEntries(
    Object.entries(capabilities).map(([key, descriptor]) => {
      const { source, observedAt, ...rest } = descriptor;
      void source;
      return [key, { ...rest, observedAt }];
    }),
  );
}

function terminalAuditStatus(job: QueryJob): DatabaseAuditEvent['status'] {
  if (job.state === 'succeeded') return 'succeeded';
  if (job.state === 'failed') return 'failed';
  if (job.state === 'cancelled') return 'cancelled';
  return 'unknown';
}

function isTerminalJob(job: QueryJob): boolean {
  return ['succeeded', 'failed', 'cancelled', 'expired'].includes(job.state);
}

function hasOperationAuthorization(request: DatabaseOperationRequest): boolean {
  return Boolean(
    request.authorization?.approvalId ||
    request.authorization?.policyId ||
    request.authorization?.permissionMode === 'full',
  );
}

function cloneProfile(profile: ConnectionProfile): ConnectionProfile {
  return structuredClone(profile);
}

function cloneQuerySubmission(submission: QuerySubmission): QuerySubmission {
  const { params, ...rest } = submission;
  return {
    ...structuredClone(rest),
    ...(params ? { params: params.map((value) => cloneDatabaseValue(value)) } : {}),
  };
}

function cloneResultBatch(batch: ResultBatch): ResultBatch {
  return {
    ...batch,
    rows: batch.rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [key, cloneDatabaseValue(value)]),
      ),
    ),
  };
}

function cloneDatabaseValue(value: DbColumnValue): DbColumnValue {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map((item) => cloneDatabaseValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        cloneDatabaseValue(item as DbColumnValue),
      ]),
    );
  }
  return value;
}

function redact(message: string, credential: DatabaseCredential | undefined): string {
  let redacted = message.replace(/(\/\/)[^/@\s]+:[^/@\s]+@/g, '$1***:***@');
  const secrets = [
    credential?.password,
    credential?.token,
    credential?.privateKey,
    credential?.certificate,
    ...Object.values(credential?.properties ?? {}),
  ].filter((value): value is string => Boolean(value && value.length >= 3));
  for (const secret of secrets) redacted = redacted.split(secret).join('[REDACTED]');
  return redacted;
}
