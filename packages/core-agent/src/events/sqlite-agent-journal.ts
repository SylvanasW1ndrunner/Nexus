import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';
import { assertNoSecretMaterial, assertPortableValue, type PortableValue } from '@dbagent/shared';
import {
  AgentJournalError,
  type AcquireRunLeaseInput,
  type AgentJournal,
  type CreateRunCommand,
  type CreateRunResult,
  type JournalCommand,
  type JournalCommitResult,
  type RenewRunLeaseInput,
  type RunLease,
  type RunLeaseReference,
} from './agent-journal.js';
import type { AgentEvent, AgentEventDraft, AgentEventType } from './agent-event.js';
import { AGENT_EVENT_SCHEMA_REGISTRY, isAgentEventType, validateAndRedactEventPayload } from './event-schema-registry.js';
import type { AgentInvocationProjection, AgentRunProjection, AgentTurnProjection } from './event-projectors.js';
import { upcastAgentEvent } from './event-upcasters.js';
import type {
  CommitValidatedAttemptCommand,
  ModelTurnCommitResult,
  PreparedModelTurnCommit,
} from './run-event-committer.js';
import type { ModelProtocolEnvelope } from '@dbagent/core-llm';

type NodeDatabaseSyncConstructor = new (location: string) => NodeDatabaseSync;

export type ModelCommitFaultPoint =
  | 'after-model-event-before-attempt'
  | 'after-model-attempt-before-turn'
  | 'after-turn-before-envelope'
  | 'after-envelope-before-invocations'
  | 'after-first-invocation';

export type SqliteAgentJournalOptions = {
  filePath: string;
  busyTimeoutMs?: number;
  now?: () => string;
  createId?: () => string;
};

type EventRow = {
  project_id: string;
  sequence: number;
  event_id: string;
  schema_version: number;
  session_id: string;
  run_id: string;
  turn_id: string | null;
  parent_event_id: string | null;
  invocation_id: string | null;
  attempt_id: string | null;
  event_type: string;
  occurred_at: string;
  payload_json: string;
};

type CommandRow = { request_digest: string; result_json: string };
type IngressRow = { input_digest: string; result_json: string };
type LeaseRow = { owner_id: string; expires_at_ms: number; fencing_token: number };

export class SqliteAgentJournal implements AgentJournal {
  readonly filePath: string;
  readonly busyTimeoutMs: number;
  readonly #now: () => string;
  readonly #createId: () => string;
  #faultPoint: ModelCommitFaultPoint | undefined;

  constructor(options: SqliteAgentJournalOptions) {
    this.filePath = requireText(options.filePath, 'filePath');
    this.busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    if (!Number.isInteger(this.busyTimeoutMs) || this.busyTimeoutMs < 1 || this.busyTimeoutMs > 60_000) {
      throw new AgentJournalError('INVALID_ARGUMENT', 'busyTimeoutMs must be between 1 and 60000.');
    }
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#createId = options.createId ?? randomUUID;
  }

  failAt(point: ModelCommitFaultPoint): void {
    this.#faultPoint = point;
  }

  async createRun(command: CreateRunCommand): Promise<CreateRunResult> {
    await Promise.resolve();
    const projectId = requireText(command.projectId, 'projectId');
    const sessionId = requireText(command.sessionId, 'sessionId');
    const clientRequestId = requireText(command.clientRequestId, 'clientRequestId');
    validatePortable(command.input, 'Run input');
    const input = structuredClone(command.input);
    const digest = digestValue(input);
    return this.#withDatabase((database) =>
      transaction(database, () => {
        const existing = database
          .prepare(
            `SELECT input_digest, result_json FROM agent_run_ingress
             WHERE project_id = ? AND session_id = ? AND client_request_id = ?`,
          )
          .get(projectId, sessionId, clientRequestId) as IngressRow | undefined;
        if (existing !== undefined) {
          if (existing.input_digest !== digest) {
            throw new AgentJournalError(
              'IDEMPOTENCY_CONFLICT',
              'clientRequestId was already used with different normalized input.',
            );
          }
          return JSON.parse(existing.result_json) as CreateRunResult;
        }

        const runId = `run_${this.#createId()}`;
        const occurredAt = this.#now();
        const inputEvent = this.#appendEvent(database, {
          projectId,
          sessionId,
          runId,
          type: 'input.received',
          payload: { clientRequestId, content: input },
          occurredAt,
        });
        const createdEvent = this.#appendEvent(database, {
          projectId,
          sessionId,
          runId,
          type: 'run.created',
          payload: { clientRequestId },
          parentEventId: inputEvent.eventId,
          occurredAt,
        });
        database
          .prepare(
            `INSERT INTO agent_runs (
              run_id, project_id, session_id, client_request_id, state, revision,
              input_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'created', 1, ?, ?, ?)`,
          )
          .run(runId, projectId, sessionId, clientRequestId, JSON.stringify(input), occurredAt, occurredAt);
        const result: CreateRunResult = {
          runId,
          inputEventId: inputEvent.eventId,
          runCreatedEventId: createdEvent.eventId,
        };
        database
          .prepare(
            `INSERT INTO agent_run_ingress (
              project_id, session_id, client_request_id, input_digest, run_id, result_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(projectId, sessionId, clientRequestId, digest, runId, JSON.stringify(result), occurredAt);
        return result;
      }),
    );
  }

  async commit(command: JournalCommand): Promise<JournalCommitResult> {
    await Promise.resolve();
    const normalized = validateJournalCommand(command);
    const requestDigest = digestValue({
      projectId: normalized.projectId,
      sessionId: normalized.sessionId,
      runId: normalized.runId,
      events: normalized.events,
    });
    return this.#withDatabase((database) =>
      transaction(database, () => {
        const replay = readCommandResult<JournalCommitResult>(
          database,
          normalized.projectId,
          normalized.commandId,
          requestDigest,
        );
        if (replay !== undefined) return replay;
        this.#assertRun(database, normalized.projectId, normalized.sessionId, normalized.runId);
        this.#assertLease(database, normalized.projectId, normalized.runId, normalized.lease);
        const occurredAt = this.#now();
        const events = normalized.events.map((draft) =>
          this.#appendEvent(database, {
            projectId: normalized.projectId,
            sessionId: normalized.sessionId,
            runId: normalized.runId,
            ...draft,
            occurredAt,
          }),
        );
        for (const event of events) this.#applyRunProjection(database, event);
        const result = { events };
        writeCommandResult(
          database,
          normalized.projectId,
          normalized.commandId,
          'journal.commit',
          requestDigest,
          result,
          occurredAt,
        );
        return result;
      }),
    );
  }

  async readProject(projectId: string, afterSequence: number, limit: number): Promise<AgentEvent[]> {
    await Promise.resolve();
    requireText(projectId, 'projectId');
    if (!Number.isInteger(afterSequence) || afterSequence < 0) {
      throw new AgentJournalError('INVALID_ARGUMENT', 'afterSequence must be a non-negative integer.');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
      throw new AgentJournalError('INVALID_ARGUMENT', 'limit must be between 1 and 10000.');
    }
    return this.#withDatabase((database) => {
      const rows = database
        .prepare(
          `SELECT * FROM agent_events
           WHERE project_id = ? AND sequence > ?
           ORDER BY sequence ASC LIMIT ?`,
        )
        .all(projectId, afterSequence, limit) as unknown as EventRow[];
      return rows.map(eventFromRow);
    });
  }

  async countEvents(type?: AgentEventType, projectId?: string): Promise<number> {
    await Promise.resolve();
    return this.#withDatabase((database) => {
      let row: { count: number };
      if (type !== undefined && projectId !== undefined) {
        row = database
          .prepare('SELECT COUNT(*) AS count FROM agent_events WHERE event_type = ? AND project_id = ?')
          .get(type, projectId) as { count: number };
      } else if (type !== undefined) {
        row = database
          .prepare('SELECT COUNT(*) AS count FROM agent_events WHERE event_type = ?')
          .get(type) as { count: number };
      } else if (projectId !== undefined) {
        row = database
          .prepare('SELECT COUNT(*) AS count FROM agent_events WHERE project_id = ?')
          .get(projectId) as { count: number };
      } else {
        row = database.prepare('SELECT COUNT(*) AS count FROM agent_events').get() as { count: number };
      }
      return Number(row.count);
    });
  }

  async acquireRunLease(input: AcquireRunLeaseInput): Promise<RunLease> {
    await Promise.resolve();
    const normalized = validateLeaseInput(input);
    return this.#withDatabase((database) =>
      transaction(database, () => {
        this.#assertRun(database, normalized.projectId, undefined, normalized.runId);
        const nowMs = Date.parse(this.#now());
        const current = database
          .prepare(
            'SELECT owner_id, expires_at_ms, fencing_token FROM agent_run_leases WHERE project_id = ? AND run_id = ?',
          )
          .get(normalized.projectId, normalized.runId) as LeaseRow | undefined;
        if (current !== undefined && current.expires_at_ms > nowMs) {
          if (current.owner_id !== normalized.ownerId) {
            throw new AgentJournalError('LEASE_HELD', 'Run lease is held by another owner.');
          }
          return leaseResult(normalized.projectId, normalized.runId, current);
        }
        const fencingToken = (current?.fencing_token ?? 0) + 1;
        const expiresAtMs = nowMs + normalized.ttlMs;
        database
          .prepare(
            `INSERT INTO agent_run_leases (project_id, run_id, owner_id, expires_at_ms, fencing_token)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(project_id, run_id) DO UPDATE SET
               owner_id = excluded.owner_id,
               expires_at_ms = excluded.expires_at_ms,
               fencing_token = excluded.fencing_token`,
          )
          .run(
            normalized.projectId,
            normalized.runId,
            normalized.ownerId,
            expiresAtMs,
            fencingToken,
          );
        return leaseResult(normalized.projectId, normalized.runId, {
          owner_id: normalized.ownerId,
          expires_at_ms: expiresAtMs,
          fencing_token: fencingToken,
        });
      }),
    );
  }

  async renewRunLease(input: RenewRunLeaseInput): Promise<RunLease> {
    await Promise.resolve();
    const normalized = { ...validateLeaseInput(input), fencingToken: input.fencingToken };
    if (!Number.isInteger(normalized.fencingToken) || normalized.fencingToken < 1) {
      throw new AgentJournalError('INVALID_ARGUMENT', 'fencingToken must be a positive integer.');
    }
    return this.#withDatabase((database) =>
      transaction(database, () => {
        const nowMs = Date.parse(this.#now());
        const current = database
          .prepare(
            'SELECT owner_id, expires_at_ms, fencing_token FROM agent_run_leases WHERE project_id = ? AND run_id = ?',
          )
          .get(normalized.projectId, normalized.runId) as LeaseRow | undefined;
        if (
          current === undefined ||
          current.owner_id !== normalized.ownerId ||
          current.fencing_token !== normalized.fencingToken ||
          current.expires_at_ms <= nowMs
        ) {
          throw new AgentJournalError('STALE_LEASE', 'Cannot renew a stale or expired Run lease.');
        }
        const expiresAtMs = nowMs + normalized.ttlMs;
        database
          .prepare(
            `UPDATE agent_run_leases SET expires_at_ms = ?
             WHERE project_id = ? AND run_id = ? AND owner_id = ? AND fencing_token = ?`,
          )
          .run(
            expiresAtMs,
            normalized.projectId,
            normalized.runId,
            normalized.ownerId,
            normalized.fencingToken,
          );
        return leaseResult(normalized.projectId, normalized.runId, {
          owner_id: normalized.ownerId,
          expires_at_ms: expiresAtMs,
          fencing_token: normalized.fencingToken,
        });
      }),
    );
  }

  async getRunProjection(runId: string): Promise<AgentRunProjection | null> {
    await Promise.resolve();
    return this.#withDatabase((database) => {
      const row = database
        .prepare('SELECT * FROM agent_runs WHERE run_id = ?')
        .get(runId) as
        | {
            run_id: string;
            project_id: string;
            session_id: string;
            client_request_id: string;
            state: AgentRunProjection['state'];
            revision: number;
            input_json: string;
            created_at: string;
            updated_at: string;
          }
        | undefined;
      if (row === undefined) return null;
      return {
        projectId: row.project_id,
        sessionId: row.session_id,
        runId: row.run_id,
        clientRequestId: row.client_request_id,
        state: row.state,
        revision: Number(row.revision),
        input: parsePortableJson(row.input_json),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
  }

  async getCommittedTurn(turnId: string): Promise<AgentTurnProjection | null> {
    await Promise.resolve();
    return this.#withDatabase((database) => {
      const row = database
        .prepare('SELECT payload_json FROM agent_turns WHERE turn_id = ?')
        .get(turnId) as { payload_json: string } | undefined;
      return row === undefined ? null : (JSON.parse(row.payload_json) as AgentTurnProjection);
    });
  }

  async getProtocolEnvelope(turnId: string): Promise<ModelProtocolEnvelope | null> {
    await Promise.resolve();
    return this.#withDatabase((database) => {
      const row = database
        .prepare('SELECT envelope_json FROM agent_protocol_envelopes WHERE turn_id = ?')
        .get(turnId) as { envelope_json: string } | undefined;
      return row === undefined ? null : (JSON.parse(row.envelope_json) as ModelProtocolEnvelope);
    });
  }

  async listInvocations(runId: string): Promise<AgentInvocationProjection[]> {
    await Promise.resolve();
    return this.#withDatabase((database) => {
      const rows = database
        .prepare(
          'SELECT payload_json FROM agent_invocations WHERE run_id = ? ORDER BY action_ordinal ASC',
        )
        .all(runId) as unknown as Array<{ payload_json: string }>;
      return rows.map((row) => JSON.parse(row.payload_json) as AgentInvocationProjection);
    });
  }

  async inspectStoragePragmas(): Promise<{
    journalMode: string;
    synchronous: number;
    foreignKeys: number;
    busyTimeoutMs: number;
  }> {
    await Promise.resolve();
    return this.#withDatabase((database) => ({
      journalMode: String(firstColumn(database.prepare('PRAGMA journal_mode').get())),
      synchronous: Number(firstColumn(database.prepare('PRAGMA synchronous').get())),
      foreignKeys: Number(firstColumn(database.prepare('PRAGMA foreign_keys').get())),
      busyTimeoutMs: Number(firstColumn(database.prepare('PRAGMA busy_timeout').get())),
    }));
  }

  async commitPreparedModelAttempt(
    command: CommitValidatedAttemptCommand,
    prepared: PreparedModelTurnCommit,
  ): Promise<ModelTurnCommitResult> {
    await Promise.resolve();
    const projectId = requireText(command.projectId, 'projectId');
    const sessionId = requireText(command.sessionId, 'sessionId');
    const runId = requireText(command.runId, 'runId');
    const turnId = requireText(command.turnId, 'turnId');
    const commandId = requireText(command.commandId, 'commandId');
    const requestDigest = digestValue({
      projectId,
      sessionId,
      runId,
      turnId,
      attempt: command.attempt,
    });
    return this.#withDatabase((database) =>
      transaction(database, () => {
        const replay = readCommandResult<ModelTurnCommitResult>(
          database,
          projectId,
          commandId,
          requestDigest,
        );
        if (replay !== undefined) return replay;
        this.#assertRun(database, projectId, sessionId, runId);
        this.#assertLease(database, projectId, runId, command.lease);
        if (
          database.prepare('SELECT 1 AS present FROM agent_turns WHERE turn_id = ?').get(turnId) !==
          undefined
        ) {
          throw new AgentJournalError('MODEL_COMMIT_CONFLICT', 'Turn already has a committed attempt.');
        }
        const occurredAt = this.#now();
        const turn: AgentTurnProjection = {
          ...prepared.turn,
          committedAt: occurredAt,
        };
        const invocations = prepared.invocations.map((invocation) => ({
          ...invocation,
          createdAt: occurredAt,
        }));
        validatePortable(turn, 'Committed Turn');
        validatePortable(prepared.envelope, 'Protocol Envelope');
        validatePortable(invocations, 'Invocation projections');

        const modelEvent = this.#appendEvent(database, {
          projectId,
          sessionId,
          runId,
          turnId,
          attemptId: command.attempt.attemptId,
          type: 'model_attempt_committed',
          payload: {
            attemptId: command.attempt.attemptId,
            blocks: turn.blocks,
            finishReason: turn.finishReason,
            ...(turn.usage === undefined ? {} : { usage: turn.usage }),
            protocolEnvelopeRef: turn.protocolEnvelopeRef,
          },
          occurredAt,
        });
        this.#inject('after-model-event-before-attempt');
        database
          .prepare(
            `INSERT INTO agent_attempts (
              attempt_id, project_id, run_id, turn_id, status, payload_json, committed_at
            ) VALUES (?, ?, ?, ?, 'committed', ?, ?)`,
          )
          .run(
            command.attempt.attemptId,
            projectId,
            runId,
            turnId,
            JSON.stringify(command.attempt),
            occurredAt,
          );
        this.#inject('after-model-attempt-before-turn');
        database
          .prepare(
            `INSERT INTO agent_turns (
              turn_id, project_id, session_id, run_id, attempt_id, status,
              protocol_envelope_ref, payload_json, committed_at
            ) VALUES (?, ?, ?, ?, ?, 'committed', ?, ?, ?)`,
          )
          .run(
            turnId,
            projectId,
            sessionId,
            runId,
            command.attempt.attemptId,
            turn.protocolEnvelopeRef,
            JSON.stringify(turn),
            occurredAt,
          );
        this.#inject('after-turn-before-envelope');
        database
          .prepare(
            `INSERT INTO agent_protocol_envelopes (
              envelope_ref, project_id, run_id, turn_id, attempt_id, envelope_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            turn.protocolEnvelopeRef,
            projectId,
            runId,
            turnId,
            command.attempt.attemptId,
            JSON.stringify(prepared.envelope),
            occurredAt,
          );
        this.#inject('after-envelope-before-invocations');
        invocations.forEach((invocation, index) => {
          database
            .prepare(
              `INSERT INTO agent_invocations (
                invocation_id, project_id, session_id, run_id, turn_id, attempt_id,
                call_id, action_ordinal, name, arguments_json, state, revision,
                payload_json, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', 1, ?, ?, ?)`,
            )
            .run(
              invocation.invocationId,
              projectId,
              sessionId,
              runId,
              turnId,
              command.attempt.attemptId,
              invocation.callId,
              invocation.actionOrdinal,
              invocation.name,
              JSON.stringify(invocation.arguments),
              JSON.stringify(invocation),
              occurredAt,
              occurredAt,
            );
          this.#appendEvent(database, {
            projectId,
            sessionId,
            runId,
            turnId,
            attemptId: command.attempt.attemptId,
            invocationId: invocation.invocationId,
            parentEventId: modelEvent.eventId,
            type: 'tool.proposed',
            payload: {
              invocationId: invocation.invocationId,
              callId: invocation.callId,
              actionOrdinal: invocation.actionOrdinal,
              name: invocation.name,
              arguments: invocation.arguments,
            },
            occurredAt,
          });
          if (index === 0) this.#inject('after-first-invocation');
        });
        const result = { turn, envelope: prepared.envelope, invocations };
        writeCommandResult(
          database,
          projectId,
          commandId,
          'model.commit',
          requestDigest,
          result,
          occurredAt,
        );
        return result;
      }),
    );
  }

  #inject(point: ModelCommitFaultPoint): void {
    if (this.#faultPoint !== point) return;
    this.#faultPoint = undefined;
    throw new Error(`INJECTED_FAILURE:${point}`);
  }

  #assertRun(
    database: NodeDatabaseSync,
    projectId: string,
    sessionId: string | undefined,
    runId: string,
  ): void {
    const row = database
      .prepare('SELECT project_id, session_id FROM agent_runs WHERE run_id = ?')
      .get(runId) as { project_id: string; session_id: string } | undefined;
    if (row === undefined) throw new AgentJournalError('RUN_NOT_FOUND', `Run not found: ${runId}`);
    if (row.project_id !== projectId || (sessionId !== undefined && row.session_id !== sessionId)) {
      throw new AgentJournalError('RUN_IDENTITY_CONFLICT', 'Run does not belong to this Project/Session.');
    }
  }

  #assertLease(
    database: NodeDatabaseSync,
    projectId: string,
    runId: string,
    lease: RunLeaseReference,
  ): void {
    const current = database
      .prepare(
        'SELECT owner_id, expires_at_ms, fencing_token FROM agent_run_leases WHERE project_id = ? AND run_id = ?',
      )
      .get(projectId, runId) as LeaseRow | undefined;
    if (
      current === undefined ||
      current.owner_id !== lease.ownerId ||
      current.fencing_token !== lease.fencingToken ||
      current.expires_at_ms <= Date.parse(this.#now())
    ) {
      throw new AgentJournalError(
        'FENCING_TOKEN_STALE',
        'The mutating command does not hold the current non-expired Run lease.',
      );
    }
  }

  #appendEvent(
    database: NodeDatabaseSync,
    input: {
      projectId: string;
      sessionId: string;
      runId: string;
      type: AgentEventType;
      payload: unknown;
      occurredAt: string;
      turnId?: string;
      parentEventId?: string;
      invocationId?: string;
      attemptId?: string;
    },
  ): AgentEvent {
    const payload = validateEventPayload(input.type, input.payload);
    if (input.parentEventId !== undefined) {
      const parent = database
        .prepare('SELECT project_id, sequence FROM agent_events WHERE event_id = ?')
        .get(input.parentEventId) as { project_id: string; sequence: number } | undefined;
      if (parent === undefined || parent.project_id !== input.projectId) {
        throw new AgentJournalError(
          'PARENT_EVENT_INVALID',
          'parentEventId must refer to an earlier event in the same Project.',
        );
      }
    }
    const sequence = nextProjectSequence(database, input.projectId);
    const eventId = `event_${this.#createId()}`;
    const schema = AGENT_EVENT_SCHEMA_REGISTRY[input.type];
    database
      .prepare(
        `INSERT INTO agent_events (
          project_id, sequence, event_id, schema_version, session_id, run_id,
          turn_id, parent_event_id, invocation_id, attempt_id, event_type,
          occurred_at, payload_json, audience_json, persistence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.projectId,
        sequence,
        eventId,
        schema.schemaVersion,
        input.sessionId,
        input.runId,
        input.turnId ?? null,
        input.parentEventId ?? null,
        input.invocationId ?? null,
        input.attemptId ?? null,
        input.type,
        input.occurredAt,
        JSON.stringify(payload),
        JSON.stringify(schema.audience),
        schema.persistence,
      );
    return {
      eventId,
      projectId: input.projectId,
      sequence,
      schemaVersion: schema.schemaVersion,
      sessionId: input.sessionId,
      runId: input.runId,
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      ...(input.parentEventId === undefined ? {} : { parentEventId: input.parentEventId }),
      ...(input.invocationId === undefined ? {} : { invocationId: input.invocationId }),
      ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
      type: input.type,
      occurredAt: input.occurredAt,
      payload,
    } as AgentEvent;
  }

  #applyRunProjection(database: NodeDatabaseSync, event: AgentEvent): void {
    const states: Partial<Record<AgentEventType, AgentRunProjection['state']>> = {
      'run.started': 'Preparing',
      'run.resumed': 'Preparing',
      'run.input_requested': 'AwaitingUser',
      'run.cancel_requested': 'Cancelling',
      'run.limit_reached': 'LimitReached',
      'run.completed': 'Completed',
      'run.failed': 'Failed',
      'run.cancelled': 'Cancelled',
      'run.interrupted': 'Interrupted',
    };
    const state = states[event.type];
    if (state === undefined) return;
    const result = database
      .prepare(
        'UPDATE agent_runs SET state = ?, revision = revision + 1, updated_at = ? WHERE run_id = ?',
      )
      .run(state, event.occurredAt, event.runId);
    if (Number(result.changes) !== 1) {
      throw new AgentJournalError('RUN_NOT_FOUND', `Run not found: ${event.runId}`);
    }
  }

  #withDatabase<T>(operation: (database: NodeDatabaseSync) => T): T {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const sqliteModuleId = ['node', 'sqlite'].join(':');
    const { DatabaseSync } = createRequire(import.meta.url)(sqliteModuleId) as {
      DatabaseSync: NodeDatabaseSyncConstructor;
    };
    const database = new DatabaseSync(this.filePath);
    try {
      initializeDatabase(database, this.busyTimeoutMs);
      return operation(database);
    } finally {
      database.close();
    }
  }
}

function validateJournalCommand(command: JournalCommand): JournalCommand {
  const projectId = requireText(command.projectId, 'projectId');
  const sessionId = requireText(command.sessionId, 'sessionId');
  const runId = requireText(command.runId, 'runId');
  const commandId = requireText(command.commandId, 'commandId');
  if (!Array.isArray(command.events) || command.events.length === 0) {
    throw new AgentJournalError('INVALID_ARGUMENT', 'Journal command requires at least one event.');
  }
  const events = command.events.map((draft) => {
    const value = draft as unknown as Record<string, unknown>;
    if (
      Object.hasOwn(value, 'schemaVersion') ||
      Object.hasOwn(value, 'audience') ||
      Object.hasOwn(value, 'persistence')
    ) {
      throw new AgentJournalError(
        'PRODUCER_METADATA_FORBIDDEN',
        'Event producers cannot choose schemaVersion, audience, or persistence.',
      );
    }
    if (typeof value.type !== 'string' || !isAgentEventType(value.type)) {
      throw new AgentJournalError('UNKNOWN_EVENT_TYPE', `Unknown Agent event type: ${String(value.type)}`);
    }
    if (value.type === 'model_attempt_committed' || value.type === 'tool.proposed') {
      throw new AgentJournalError(
        'COMMITTER_REQUIRED',
        `${value.type} can only be created by RunEventCommitter's atomic commit path.`,
      );
    }
    const payload = validateEventPayload(value.type, value.payload);
    return { ...structuredClone(draft), payload } as AgentEventDraft;
  });
  return {
    projectId,
    sessionId,
    runId,
    commandId,
    lease: {
      ownerId: requireText(command.lease.ownerId, 'lease.ownerId'),
      fencingToken: command.lease.fencingToken,
    },
    events,
  };
}

function validateEventPayload(type: AgentEventType, payload: unknown): PortableValue {
  try {
    return validateAndRedactEventPayload(type, payload);
  } catch (error) {
    throw new AgentJournalError(
      'INVALID_EVENT_PAYLOAD',
      `Invalid ${type} payload: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function validatePortable(value: unknown, label: string): asserts value is PortableValue {
  try {
    assertPortableValue(value);
    assertNoSecretMaterial(value);
  } catch (error) {
    throw new AgentJournalError(
      'INVALID_EVENT_PAYLOAD',
      `${label} is not safe portable data: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function validateLeaseInput<T extends AcquireRunLeaseInput>(input: T): T {
  requireText(input.projectId, 'projectId');
  requireText(input.runId, 'runId');
  requireText(input.ownerId, 'ownerId');
  if (!Number.isInteger(input.ttlMs) || input.ttlMs < 1 || input.ttlMs > 86_400_000) {
    throw new AgentJournalError('INVALID_ARGUMENT', 'ttlMs must be between 1 and 86400000.');
  }
  return input;
}

function leaseResult(projectId: string, runId: string, row: LeaseRow): RunLease {
  return {
    projectId,
    runId,
    ownerId: row.owner_id,
    fencingToken: Number(row.fencing_token),
    expiresAt: new Date(Number(row.expires_at_ms)).toISOString(),
  };
}

function readCommandResult<T>(
  database: NodeDatabaseSync,
  projectId: string,
  commandId: string,
  requestDigest: string,
): T | undefined {
  const row = database
    .prepare(
      'SELECT request_digest, result_json FROM agent_commands WHERE project_id = ? AND command_id = ?',
    )
    .get(projectId, commandId) as CommandRow | undefined;
  if (row === undefined) return undefined;
  if (row.request_digest !== requestDigest) {
    throw new AgentJournalError(
      'COMMAND_CONFLICT',
      'commandId was already committed with a different normalized command.',
    );
  }
  return JSON.parse(row.result_json) as T;
}

function writeCommandResult(
  database: NodeDatabaseSync,
  projectId: string,
  commandId: string,
  kind: string,
  requestDigest: string,
  result: unknown,
  occurredAt: string,
): void {
  database
    .prepare(
      `INSERT INTO agent_commands (
        project_id, command_id, command_kind, request_digest, result_json, committed_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(projectId, commandId, kind, requestDigest, JSON.stringify(result), occurredAt);
}

function nextProjectSequence(database: NodeDatabaseSync, projectId: string): number {
  database
    .prepare(
      `INSERT INTO agent_project_sequences (project_id, current_sequence) VALUES (?, 0)
       ON CONFLICT(project_id) DO NOTHING`,
    )
    .run(projectId);
  database
    .prepare(
      'UPDATE agent_project_sequences SET current_sequence = current_sequence + 1 WHERE project_id = ?',
    )
    .run(projectId);
  const row = database
    .prepare('SELECT current_sequence FROM agent_project_sequences WHERE project_id = ?')
    .get(projectId) as { current_sequence: number };
  return Number(row.current_sequence);
}

function eventFromRow(row: EventRow): AgentEvent {
  return upcastAgentEvent({
    eventId: row.event_id,
    projectId: row.project_id,
    sequence: Number(row.sequence),
    schemaVersion: Number(row.schema_version),
    sessionId: row.session_id,
    runId: row.run_id,
    ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
    ...(row.parent_event_id === null ? {} : { parentEventId: row.parent_event_id }),
    ...(row.invocation_id === null ? {} : { invocationId: row.invocation_id }),
    ...(row.attempt_id === null ? {} : { attemptId: row.attempt_id }),
    type: row.event_type as AgentEventType,
    occurredAt: row.occurred_at,
    payload: JSON.parse(row.payload_json) as PortableValue,
  });
}

function transaction<T>(database: NodeDatabaseSync, operation: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const value = operation();
    database.exec('COMMIT');
    return value;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function initializeDatabase(database: NodeDatabaseSync, busyTimeoutMs: number): void {
  database.exec(`
    PRAGMA busy_timeout = ${busyTimeoutMs};
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;

    CREATE TABLE IF NOT EXISTS agent_project_sequences (
      project_id TEXT PRIMARY KEY,
      current_sequence INTEGER NOT NULL CHECK (current_sequence >= 0)
    );
    CREATE TABLE IF NOT EXISTS agent_events (
      project_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      event_id TEXT NOT NULL UNIQUE,
      schema_version INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      turn_id TEXT,
      parent_event_id TEXT,
      invocation_id TEXT,
      attempt_id TEXT,
      event_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      audience_json TEXT NOT NULL,
      persistence TEXT NOT NULL,
      PRIMARY KEY (project_id, sequence),
      FOREIGN KEY (parent_event_id) REFERENCES agent_events(event_id)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_events_run_sequence
      ON agent_events(run_id, sequence);
    CREATE TABLE IF NOT EXISTS agent_commands (
      project_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      command_kind TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      result_json TEXT NOT NULL,
      committed_at TEXT NOT NULL,
      PRIMARY KEY (project_id, command_id)
    );
    CREATE TABLE IF NOT EXISTS agent_run_ingress (
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      client_request_id TEXT NOT NULL,
      input_digest TEXT NOT NULL,
      run_id TEXT NOT NULL UNIQUE,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, session_id, client_request_id)
    );
    CREATE TABLE IF NOT EXISTS agent_runs (
      run_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      client_request_id TEXT NOT NULL,
      state TEXT NOT NULL,
      revision INTEGER NOT NULL,
      input_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (project_id, session_id, client_request_id)
    );
    CREATE TABLE IF NOT EXISTS agent_environment_bindings (
      environment_binding_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      run_id TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES agent_runs(run_id)
    );
    CREATE TABLE IF NOT EXISTS agent_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      snapshot_type TEXT NOT NULL,
      revision TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES agent_runs(run_id)
    );
    CREATE TABLE IF NOT EXISTS agent_turns (
      turn_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      protocol_envelope_ref TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      committed_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES agent_runs(run_id)
    );
    CREATE TABLE IF NOT EXISTS agent_attempts (
      attempt_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      committed_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES agent_runs(run_id)
    );
    CREATE TABLE IF NOT EXISTS agent_protocol_envelopes (
      envelope_ref TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      turn_id TEXT NOT NULL UNIQUE,
      attempt_id TEXT NOT NULL UNIQUE,
      envelope_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES agent_runs(run_id),
      FOREIGN KEY (turn_id) REFERENCES agent_turns(turn_id),
      FOREIGN KEY (attempt_id) REFERENCES agent_attempts(attempt_id)
    );
    CREATE TABLE IF NOT EXISTS agent_invocations (
      invocation_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      call_id TEXT NOT NULL,
      action_ordinal INTEGER NOT NULL,
      name TEXT NOT NULL,
      arguments_json TEXT NOT NULL,
      state TEXT NOT NULL,
      revision INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (run_id, turn_id, action_ordinal),
      UNIQUE (run_id, call_id),
      FOREIGN KEY (run_id) REFERENCES agent_runs(run_id),
      FOREIGN KEY (turn_id) REFERENCES agent_turns(turn_id),
      FOREIGN KEY (attempt_id) REFERENCES agent_attempts(attempt_id)
    );
    CREATE TABLE IF NOT EXISTS agent_observations (
      observation_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      invocation_id TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (invocation_id) REFERENCES agent_invocations(invocation_id)
    );
    CREATE TABLE IF NOT EXISTS agent_approvals (
      approval_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      invocation_id TEXT NOT NULL,
      tool_revision TEXT NOT NULL,
      arguments_digest TEXT NOT NULL,
      effect TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (invocation_id, tool_revision, arguments_digest, effect),
      FOREIGN KEY (invocation_id) REFERENCES agent_invocations(invocation_id)
    );
    CREATE TABLE IF NOT EXISTS agent_context_checkpoints (
      checkpoint_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      covered_sequence INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_artifacts (
      artifact_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_projection_offsets (
      project_id TEXT NOT NULL,
      projector_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, projector_id)
    );
    CREATE TABLE IF NOT EXISTS agent_run_leases (
      project_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
      PRIMARY KEY (project_id, run_id),
      FOREIGN KEY (run_id) REFERENCES agent_runs(run_id)
    );
  `);
}

function requireText(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AgentJournalError('INVALID_ARGUMENT', `${name} is required.`);
  }
  return value.trim();
}

function digestValue(value: PortableValue): string {
  validatePortable(value, 'Idempotency input');
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: PortableValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as { [key: string]: PortableValue };
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key] as PortableValue)}`)
    .join(',')}}`;
}

function firstColumn(row: unknown): unknown {
  if (row === undefined || row === null || typeof row !== 'object') return undefined;
  return Object.values(row)[0];
}

function parsePortableJson(value: string): PortableValue {
  const parsed: unknown = JSON.parse(value);
  assertPortableValue(parsed);
  return parsed;
}
