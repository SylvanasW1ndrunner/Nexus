import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { types as nodeUtilTypes } from 'node:util';
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';
import {
  assertAuthenticValidatedModelAttempt,
  type ModelContentBlock,
  type ModelProtocolEnvelope,
} from '@dbagent/core-llm';
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
  type StartRunCommand,
  type StartTurnCommand,
} from './agent-journal.js';
import type { AgentEvent, AgentEventDraft, AgentEventType } from './agent-event.js';
import {
  AGENT_EVENT_SCHEMA_REGISTRY,
  isAgentEventType,
  validateAndRedactEventPayload,
  validatePersistedAttempt,
} from './event-schema-registry.js';
import {
  replayAgentEvents,
  type AgentInvocationProjection,
  type AgentRunProjection,
  type AgentTurnProjection,
} from './event-projectors.js';
import { upcastAgentEvent } from './event-upcasters.js';
import type {
  CommitValidatedAttemptCommand,
  ModelTurnCommitResult,
} from './run-event-committer.js';
import type { LegacyMigrationWriterAuthority } from '../session/legacy-migration-writer.js';
import { LEGACY_MIGRATION_WRITER_AUTHORITY } from '../session/legacy-migration-writer.js';

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
    const snapshot = snapshotCreateRunCommand(command);
    const projectId = requireText(snapshot.projectId, 'projectId');
    const sessionId = requireText(snapshot.sessionId, 'sessionId');
    const clientRequestId = requireText(snapshot.clientRequestId, 'clientRequestId');
    validatePortable(snapshot.input, 'Run input');
    const input = snapshot.input;
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
    const normalized = validateJournalCommand(snapshotJournalCommand(command));
    return this.#commitNormalized(normalized);
  }

  /** @internal StateMigrationRunner is the only package boundary allowed to call this. */
  async commitLegacyImport(
    authority: LegacyMigrationWriterAuthority,
    command: JournalCommand,
    identity: { migrationId: string; sourceDigest: string },
  ): Promise<JournalCommitResult> {
    await Promise.resolve();
    if (authority !== LEGACY_MIGRATION_WRITER_AUTHORITY) {
      throw new AgentJournalError('COMMITTER_REQUIRED', 'Legacy migration writer authority is required.');
    }
    if (!/^[a-f0-9]{64}$/u.test(identity.migrationId) || !/^[a-f0-9]{64}$/u.test(identity.sourceDigest)) {
      throw new AgentJournalError('INVALID_ARGUMENT', 'Validated legacy migration identity is required.');
    }
    const normalized = validateJournalCommand(snapshotJournalCommand(command), true);
    if (normalized.events.some(({ type }) => type !== 'legacy.imported') ||
      !normalized.commandId.includes(identity.migrationId)) {
      throw new AgentJournalError(
        'COMMITTER_REQUIRED',
        'Legacy import boundary accepts only identity-bound legacy.imported facts.',
      );
    }
    const contextMatches = this.#withDatabase((database) => {
      const row = database.prepare(`
        SELECT migration_id, source_digest FROM legacy_migration_build_context WHERE id = 1
      `).get() as { migration_id: string; source_digest: string } | undefined;
      return row !== undefined && row.migration_id === identity.migrationId &&
        row.source_digest === identity.sourceDigest;
    });
    if (!contextMatches) {
      throw new AgentJournalError(
        'COMMITTER_REQUIRED',
        'Shadow database does not contain the validated legacy migration build context.',
      );
    }
    return this.#commitNormalized(normalized);
  }

  #commitNormalized(normalized: JournalCommand): JournalCommitResult {
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
        this.#assertRunRevision(
          database, normalized.projectId, normalized.runId, normalized.expectedRunRevision,
        );
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

  async startRun(command: StartRunCommand): Promise<JournalCommitResult> {
    await Promise.resolve();
    const normalized = validateStartRunCommand(snapshotStartRunCommand(command));
    return this.#withDatabase((database) => transaction(database, () => {
      const digest = digestValue({
        projectId: normalized.projectId,
        sessionId: normalized.sessionId,
        runId: normalized.runId,
      });
      const replay = readCommandResult<JournalCommitResult>(
        database, normalized.projectId, normalized.commandId, digest,
      );
      if (replay !== undefined) return replay;
      this.#assertRun(database, normalized.projectId, normalized.sessionId, normalized.runId);
      this.#assertLease(database, normalized.projectId, normalized.runId, normalized.lease);
      this.#assertRunRevision(
        database, normalized.projectId, normalized.runId, normalized.expectedRunRevision,
      );
      const occurredAt = this.#now();
      const event = this.#appendEvent(database, {
        projectId: normalized.projectId, sessionId: normalized.sessionId,
        runId: normalized.runId, type: 'run.started', payload: {}, occurredAt,
      });
      this.#applyRunProjection(database, event, normalized.expectedRunRevision);
      const result = { events: [event] };
      writeCommandResult(database, normalized.projectId, normalized.commandId, 'run.start', digest, result, occurredAt);
      return result;
    }));
  }

  async startTurn(command: StartTurnCommand): Promise<JournalCommitResult> {
    await Promise.resolve();
    const normalized = validateStartTurnCommand(snapshotStartTurnCommand(command));
    return this.#withDatabase((database) => transaction(database, () => {
      const digest = digestValue({
        projectId: normalized.projectId,
        sessionId: normalized.sessionId,
        runId: normalized.runId,
        turnId: normalized.turnId,
      });
      const replay = readCommandResult<JournalCommitResult>(
        database, normalized.projectId, normalized.commandId, digest,
      );
      if (replay !== undefined) return replay;
      this.#assertRun(database, normalized.projectId, normalized.sessionId, normalized.runId);
      this.#assertLease(database, normalized.projectId, normalized.runId, normalized.lease);
      this.#assertRunRevision(
        database, normalized.projectId, normalized.runId, normalized.expectedRunRevision,
      );
      const occurredAt = this.#now();
      const event = this.#appendEvent(database, {
        projectId: normalized.projectId, sessionId: normalized.sessionId,
        runId: normalized.runId, turnId: normalized.turnId,
        type: 'turn.started', payload: {}, occurredAt,
      });
      database.prepare(
        `INSERT INTO agent_turn_lifecycles
          (project_id, session_id, run_id, turn_id, revision, status, started_at)
         VALUES (?, ?, ?, ?, 1, 'started', ?)`,
      ).run(normalized.projectId, normalized.sessionId, normalized.runId, normalized.turnId, occurredAt);
      const runCas = database.prepare(
        `UPDATE agent_runs SET revision = revision + 1, updated_at = ?
         WHERE project_id = ? AND session_id = ? AND run_id = ? AND revision = ?`,
      ).run(
        occurredAt, normalized.projectId, normalized.sessionId, normalized.runId,
        normalized.expectedRunRevision,
      );
      if (Number(runCas.changes) !== 1) {
        throw new AgentJournalError('REVISION_CONFLICT', 'Concurrent Run update won the revision race.');
      }
      const result = { events: [event] };
      writeCommandResult(database, normalized.projectId, normalized.commandId, 'turn.start', digest, result, occurredAt);
      return result;
    }));
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
      return rows.map((row) => {
        assertStoredParentCausality(database, row);
        return eventFromRow(row);
      });
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

  async rebuildProjectProjections(projectIdInput: string): Promise<void> {
    await Promise.resolve();
    const projectId = requireText(projectIdInput, 'projectId');
    this.#withDatabase((database) => transaction(database, () => {
      const rows = database.prepare(
        'SELECT * FROM agent_events WHERE project_id = ? ORDER BY sequence ASC',
      ).all(projectId) as unknown as EventRow[];
      const events = rows.map((row) => {
        assertStoredParentCausality(database, row);
        return eventFromRow(row);
      });
      const replay = replayAgentEvents(events);
      database.prepare('DELETE FROM agent_invocations WHERE project_id = ?').run(projectId);
      database.prepare('DELETE FROM agent_protocol_envelopes WHERE project_id = ?').run(projectId);
      database.prepare('DELETE FROM agent_turns WHERE project_id = ?').run(projectId);
      database.prepare('DELETE FROM agent_attempts WHERE project_id = ?').run(projectId);
      database.prepare('DELETE FROM agent_turn_lifecycles WHERE project_id = ?').run(projectId);
      database.prepare('DELETE FROM agent_run_leases WHERE project_id = ?').run(projectId);
      database.prepare('DELETE FROM agent_runs WHERE project_id = ?').run(projectId);

      for (const run of replay.runs) {
        database.prepare(
          `INSERT INTO agent_runs (
            run_id, project_id, session_id, client_request_id, state, revision,
            input_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          run.runId, run.projectId, run.sessionId, run.clientRequestId, run.state, run.revision,
          JSON.stringify(run.input ?? null), run.createdAt, run.updatedAt,
        );
      }
      for (const started of events.filter((event) => event.type === 'turn.started')) {
        if (started.turnId === undefined) continue;
        const committed = replay.turns.some((turn) => turn.turnId === started.turnId);
        database.prepare(
          `INSERT INTO agent_turn_lifecycles
            (project_id, session_id, run_id, turn_id, revision, status, started_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          started.projectId, started.sessionId, started.runId, started.turnId,
          committed ? 2 : 1, committed ? 'committed' : 'started', started.occurredAt,
        );
      }

      for (const turn of replay.turns) {
        const attempt = replay.validatedAttempts.find((item) => item.attemptId === turn.attemptId);
        const envelope = replay.envelopes.find((item) => item.attemptId === turn.attemptId);
        if (attempt === undefined || envelope === undefined) {
          throw new AgentJournalError('INVALID_EVENT_PAYLOAD', 'Committed model event is incomplete.');
        }
        database.prepare(
          `INSERT INTO agent_attempts
            (attempt_id, project_id, session_id, run_id, turn_id, status, payload_json, committed_at)
           VALUES (?, ?, ?, ?, ?, 'committed', ?, ?)`,
        ).run(attempt.attemptId, turn.projectId, turn.sessionId, turn.runId, turn.turnId,
          JSON.stringify(attempt), turn.committedAt);
        database.prepare(
          `INSERT INTO agent_turns
            (turn_id, project_id, session_id, run_id, attempt_id, status,
             protocol_envelope_ref, payload_json, committed_at)
           VALUES (?, ?, ?, ?, ?, 'committed', ?, ?, ?)`,
        ).run(turn.turnId, turn.projectId, turn.sessionId, turn.runId, turn.attemptId,
          turn.protocolEnvelopeRef, JSON.stringify(turn), turn.committedAt);
        database.prepare(
          `INSERT INTO agent_protocol_envelopes
            (envelope_ref, project_id, session_id, run_id, turn_id, attempt_id, envelope_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(turn.protocolEnvelopeRef, turn.projectId, turn.sessionId, turn.runId, turn.turnId, turn.attemptId,
          JSON.stringify(envelope), turn.committedAt);
      }
      for (const invocation of replay.invocations) {
        database.prepare(
          `INSERT INTO agent_invocations
            (invocation_id, project_id, session_id, run_id, turn_id, attempt_id,
             call_id, action_ordinal, name, arguments_json, state, revision,
             payload_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', 1, ?, ?, ?)`,
        ).run(invocation.invocationId, invocation.projectId, invocation.sessionId,
          invocation.runId, invocation.turnId, invocation.attemptId, invocation.callId,
          invocation.actionOrdinal, invocation.name, JSON.stringify(invocation.arguments),
          JSON.stringify(invocation), invocation.createdAt, invocation.createdAt);
      }
    }));
  }

  async acquireRunLease(input: AcquireRunLeaseInput): Promise<RunLease> {
    await Promise.resolve();
    const normalized = validateLeaseInput(snapshotAcquireRunLeaseCommand(input));
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
    const normalized = validateLeaseInput(snapshotRenewRunLeaseCommand(input));
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
      const projection = {
        projectId: row.project_id,
        sessionId: row.session_id,
        runId: row.run_id,
        clientRequestId: row.client_request_id,
        state: row.state,
        revision: Number(row.revision),
        input: parseProjectionPortableJson(row.input_json, 'Agent Run input'),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
      assertRunProjection(projection);
      return projection;
    });
  }

  async getCommittedTurn(turnId: string): Promise<AgentTurnProjection | null> {
    await Promise.resolve();
    return this.#withDatabase((database) => {
      const row = database
        .prepare(
          `SELECT turn_id, project_id, session_id, run_id, attempt_id,
                  protocol_envelope_ref, committed_at, payload_json
           FROM agent_turns WHERE turn_id = ?`,
        )
        .get(turnId) as {
          turn_id: string; project_id: string; session_id: string; run_id: string;
          attempt_id: string; protocol_envelope_ref: string; committed_at: string;
          payload_json: string;
        } | undefined;
      return row === undefined ? null : parseProjectionJson(
        row.payload_json, 'Agent Turn', (value): asserts value is AgentTurnProjection => {
          assertTurnProjection(value);
          assertProjectionIdentity(value.projectId === row.project_id, 'Agent Turn projectId');
          assertProjectionIdentity(value.sessionId === row.session_id, 'Agent Turn sessionId');
          assertProjectionIdentity(value.runId === row.run_id, 'Agent Turn runId');
          assertProjectionIdentity(value.turnId === row.turn_id, 'Agent Turn turnId');
          assertProjectionIdentity(value.attemptId === row.attempt_id, 'Agent Turn attemptId');
          assertProjectionIdentity(
            value.protocolEnvelopeRef === row.protocol_envelope_ref,
            'Agent Turn protocolEnvelopeRef',
          );
          assertProjectionIdentity(value.committedAt === row.committed_at, 'Agent Turn committedAt');
        },
      );
    });
  }

  async getProtocolEnvelope(turnId: string): Promise<ModelProtocolEnvelope | null> {
    await Promise.resolve();
    return this.#withDatabase((database) => {
      const row = database
        .prepare(
          `SELECT envelope_ref, project_id, session_id, run_id, turn_id, attempt_id,
                  created_at, envelope_json
           FROM agent_protocol_envelopes WHERE turn_id = ?`,
        )
        .get(turnId) as {
          envelope_ref: string; project_id: string; session_id: string; run_id: string;
          turn_id: string; attempt_id: string; created_at: string; envelope_json: string;
        } | undefined;
      return row === undefined ? null : parseProjectionJson(
        row.envelope_json, 'Protocol Envelope', (value): asserts value is ModelProtocolEnvelope => {
          assertProtocolEnvelope(value);
          [row.envelope_ref, row.project_id, row.session_id, row.run_id, row.turn_id, row.created_at]
            .forEach((identity) => projectionText(identity, 'Protocol Envelope identity column'));
          assertProjectionIdentity(value.attemptId === row.attempt_id, 'Protocol Envelope attemptId');
        },
      );
    });
  }

  async listInvocations(runId: string): Promise<AgentInvocationProjection[]> {
    await Promise.resolve();
    return this.#withDatabase((database) => {
      const rows = database
        .prepare(
          `SELECT invocation_id, project_id, session_id, run_id, turn_id, attempt_id,
                  call_id, action_ordinal, name, arguments_json, state, revision,
                  created_at, payload_json
           FROM agent_invocations WHERE run_id = ? ORDER BY action_ordinal ASC`,
        )
        .all(runId) as unknown as Array<{
          invocation_id: string; project_id: string; session_id: string; run_id: string;
          turn_id: string; attempt_id: string; call_id: string; action_ordinal: number;
          name: string; arguments_json: string; state: string; revision: number;
          created_at: string; payload_json: string;
        }>;
      return rows.map((row) => parseProjectionJson(
        row.payload_json, 'Agent Invocation', (value): asserts value is AgentInvocationProjection => {
          assertInvocationProjection(value);
          assertProjectionIdentity(value.projectId === row.project_id, 'Agent Invocation projectId');
          assertProjectionIdentity(value.sessionId === row.session_id, 'Agent Invocation sessionId');
          assertProjectionIdentity(value.runId === row.run_id, 'Agent Invocation runId');
          assertProjectionIdentity(value.turnId === row.turn_id, 'Agent Invocation turnId');
          assertProjectionIdentity(value.attemptId === row.attempt_id, 'Agent Invocation attemptId');
          assertProjectionIdentity(
            value.invocationId === row.invocation_id, 'Agent Invocation invocationId',
          );
          assertProjectionIdentity(value.callId === row.call_id, 'Agent Invocation callId');
          assertProjectionIdentity(
            value.actionOrdinal === Number(row.action_ordinal), 'Agent Invocation actionOrdinal',
          );
          assertProjectionIdentity(value.name === row.name, 'Agent Invocation name');
          assertProjectionIdentity(value.state === row.state, 'Agent Invocation state');
          assertProjectionIdentity(value.revision === Number(row.revision), 'Agent Invocation revision');
          assertProjectionIdentity(value.createdAt === row.created_at, 'Agent Invocation createdAt');
          const storedArguments = parseProjectionPortableJson(
            row.arguments_json, 'Agent Invocation arguments',
          );
          assertProjectionIdentity(
            canonicalJson(value.arguments) === canonicalJson(storedArguments),
            'Agent Invocation arguments',
          );
        },
      ));
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

  async commitValidatedAttempt(
    command: CommitValidatedAttemptCommand,
  ): Promise<ModelTurnCommitResult> {
    await Promise.resolve();
    const normalized = snapshotValidatedAttemptCommand(command);
    const {
      projectId, sessionId, runId, turnId, commandId, attempt,
      expectedRunRevision, expectedTurnRevision,
    } = normalized;
    try {
      assertAuthenticValidatedModelAttempt(attempt);
    } catch {
      throw new AgentJournalError(
        'ATTEMPT_NOT_VALIDATED',
        'SqliteAgentJournal accepts only an authentic unmodified terminal ValidatedModelAttempt.',
      );
    }
    try {
      validatePersistedAttempt(attempt);
    } catch (error) {
      throw new AgentJournalError(
        'INVALID_EVENT_PAYLOAD',
        `Validated model attempt failed strict schema validation: ${errorMessage(error)}`,
      );
    }
    assertCanonicalAttemptIdentities(attempt);
    const prepared = prepareValidatedAttempt(normalized);
    const requestDigest = digestValue({
      projectId,
      sessionId,
      runId,
      turnId,
      attempt,
      prepared,
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
        this.#assertLease(database, projectId, runId, normalized.lease);
        this.#assertRunRevision(database, projectId, runId, expectedRunRevision);
        const lifecycle = database.prepare(
          `SELECT project_id, session_id, run_id, revision, status
           FROM agent_turn_lifecycles WHERE turn_id = ?`,
        ).get(turnId) as {
          project_id: string; session_id: string; run_id: string; revision: number; status: string;
        } | undefined;
        if (lifecycle === undefined) {
          throw new AgentJournalError('TURN_NOT_FOUND', `Turn not found: ${turnId}`);
        }
        if (
          lifecycle.project_id !== projectId || lifecycle.session_id !== sessionId ||
          lifecycle.run_id !== runId
        ) {
          throw new AgentJournalError('RUN_IDENTITY_CONFLICT', 'Turn does not belong to this Run.');
        }
        if (Number(lifecycle.revision) !== expectedTurnRevision || lifecycle.status !== 'started') {
          throw new AgentJournalError('REVISION_CONFLICT', 'Turn revision does not match.');
        }
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
          attemptId: attempt.attemptId,
          type: 'model_attempt_committed',
          payload: {
            validatedAttempt: attempt,
            turn: { protocolEnvelopeRef: turn.protocolEnvelopeRef },
            protocolEnvelope: {
              schemaVersion: prepared.envelope.schemaVersion,
              correlations: prepared.envelope.correlations,
            },
          },
          occurredAt,
        });
        this.#inject('after-model-event-before-attempt');
        database
          .prepare(
            `INSERT INTO agent_attempts (
              attempt_id, project_id, session_id, run_id, turn_id, status, payload_json, committed_at
            ) VALUES (?, ?, ?, ?, ?, 'committed', ?, ?)`,
          )
          .run(
            attempt.attemptId,
            projectId,
            sessionId,
            runId,
            turnId,
            JSON.stringify(attempt),
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
            attempt.attemptId,
            turn.protocolEnvelopeRef,
            JSON.stringify(turn),
            occurredAt,
          );
        this.#inject('after-turn-before-envelope');
        database
          .prepare(
            `INSERT INTO agent_protocol_envelopes (
              envelope_ref, project_id, session_id, run_id, turn_id, attempt_id, envelope_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            turn.protocolEnvelopeRef,
            projectId,
            sessionId,
            runId,
            turnId,
            attempt.attemptId,
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
              attempt.attemptId,
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
            attemptId: attempt.attemptId,
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
        const turnCas = database.prepare(
          `UPDATE agent_turn_lifecycles SET revision = revision + 1, status = 'committed'
           WHERE project_id = ? AND run_id = ? AND turn_id = ? AND revision = ? AND status = 'started'`,
        ).run(projectId, runId, turnId, expectedTurnRevision);
        if (Number(turnCas.changes) !== 1) {
          throw new AgentJournalError('REVISION_CONFLICT', 'Concurrent Turn commit won the revision race.');
        }
        const runCas = database.prepare(
          `UPDATE agent_runs SET revision = revision + 1, updated_at = ?
           WHERE project_id = ? AND session_id = ? AND run_id = ? AND revision = ?`,
        ).run(occurredAt, projectId, sessionId, runId, expectedRunRevision);
        if (Number(runCas.changes) !== 1) {
          throw new AgentJournalError('REVISION_CONFLICT', 'Concurrent Run commit won the revision race.');
        }
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

  #assertRunRevision(
    database: NodeDatabaseSync,
    projectId: string,
    runId: string,
    expectedRevision: number,
  ): void {
    const row = database.prepare(
      'SELECT revision FROM agent_runs WHERE project_id = ? AND run_id = ?',
    ).get(projectId, runId) as { revision: number } | undefined;
    if (row === undefined) throw new AgentJournalError('RUN_NOT_FOUND', `Run not found: ${runId}`);
    if (Number(row.revision) !== expectedRevision) {
      throw new AgentJournalError('REVISION_CONFLICT', 'Run revision does not match.');
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
        .prepare(
          `SELECT project_id, session_id, run_id, turn_id, attempt_id, invocation_id, sequence
           FROM agent_events WHERE event_id = ?`,
        )
        .get(input.parentEventId) as {
          project_id: string; session_id: string; run_id: string; turn_id: string | null;
          attempt_id: string | null; invocation_id: string | null; sequence: number;
        } | undefined;
      if (
        parent === undefined || parent.project_id !== input.projectId ||
        parent.session_id !== input.sessionId || parent.run_id !== input.runId ||
        (input.turnId !== undefined && parent.turn_id !== input.turnId) ||
        (parent.attempt_id !== null && input.attemptId !== undefined &&
          parent.attempt_id !== input.attemptId)
      ) {
        throw new AgentJournalError(
          'PARENT_EVENT_INVALID',
          'parentEventId must refer to an earlier event in the same causal scope.',
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

  #applyRunProjection(database: NodeDatabaseSync, event: AgentEvent, expectedRevision?: number): void {
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
        `UPDATE agent_runs SET state = ?, revision = revision + 1, updated_at = ?
         WHERE project_id = ? AND run_id = ?${expectedRevision === undefined ? '' : ' AND revision = ?'}`,
      )
      .run(state, event.occurredAt, event.projectId, event.runId, ...(expectedRevision === undefined ? [] : [expectedRevision]));
    if (Number(result.changes) !== 1) {
      throw new AgentJournalError('REVISION_CONFLICT', `Run revision changed: ${event.runId}`);
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
    } catch (error) {
      if (error instanceof Error && /database is (?:locked|busy)/iu.test(error.message)) {
        throw new AgentJournalError(
          'JOURNAL_BUSY',
          `Agent Journal remained busy for ${this.busyTimeoutMs}ms.`,
        );
      }
      throw error;
    } finally {
      database.close();
    }
  }
}

function snapshotCreateRunCommand(command: CreateRunCommand): CreateRunCommand {
  const record = snapshotDataRecord(command, [
    'projectId', 'sessionId', 'clientRequestId', 'input',
  ], [], 'Create Run command');
  return Object.freeze({
    projectId: record.projectId,
    sessionId: record.sessionId,
    clientRequestId: record.clientRequestId,
    input: snapshotPortableData(record.input, 'Create Run input'),
  }) as CreateRunCommand;
}

function snapshotJournalCommand(command: JournalCommand): JournalCommand {
  const record = snapshotDataRecord(command, [
    'projectId', 'sessionId', 'runId', 'commandId', 'lease', 'expectedRunRevision', 'events',
  ], [], 'Journal command');
  return Object.freeze({
    projectId: record.projectId,
    sessionId: record.sessionId,
    runId: record.runId,
    commandId: record.commandId,
    lease: snapshotRunLeaseReference(record.lease, 'Journal command lease'),
    expectedRunRevision: record.expectedRunRevision,
    events: snapshotDataArray(record.events, 'Journal command events', snapshotEventDraft),
  }) as JournalCommand;
}

function snapshotStartRunCommand(command: StartRunCommand): StartRunCommand {
  const record = snapshotDataRecord(command, [
    'projectId', 'sessionId', 'runId', 'commandId', 'lease', 'expectedRunRevision',
  ], [], 'Start Run command');
  return Object.freeze({
    projectId: record.projectId,
    sessionId: record.sessionId,
    runId: record.runId,
    commandId: record.commandId,
    lease: snapshotRunLeaseReference(record.lease, 'Start Run lease'),
    expectedRunRevision: record.expectedRunRevision,
  }) as StartRunCommand;
}

function snapshotStartTurnCommand(command: StartTurnCommand): StartTurnCommand {
  const record = snapshotDataRecord(command, [
    'projectId', 'sessionId', 'runId', 'turnId', 'commandId', 'lease', 'expectedRunRevision',
  ], [], 'Start Turn command');
  return Object.freeze({
    projectId: record.projectId,
    sessionId: record.sessionId,
    runId: record.runId,
    turnId: record.turnId,
    commandId: record.commandId,
    lease: snapshotRunLeaseReference(record.lease, 'Start Turn lease'),
    expectedRunRevision: record.expectedRunRevision,
  }) as StartTurnCommand;
}

function snapshotAcquireRunLeaseCommand(input: AcquireRunLeaseInput): AcquireRunLeaseInput {
  const record = snapshotDataRecord(input, [
    'projectId', 'runId', 'ownerId', 'ttlMs',
  ], [], 'Acquire Run lease command');
  return Object.freeze({
    projectId: record.projectId,
    runId: record.runId,
    ownerId: record.ownerId,
    ttlMs: record.ttlMs,
  }) as AcquireRunLeaseInput;
}

function snapshotRenewRunLeaseCommand(input: RenewRunLeaseInput): RenewRunLeaseInput {
  const record = snapshotDataRecord(input, [
    'projectId', 'runId', 'ownerId', 'ttlMs', 'fencingToken',
  ], [], 'Renew Run lease command');
  return Object.freeze({
    projectId: record.projectId,
    runId: record.runId,
    ownerId: record.ownerId,
    ttlMs: record.ttlMs,
    fencingToken: record.fencingToken,
  }) as RenewRunLeaseInput;
}

function snapshotRunLeaseReference(value: unknown, label: string): RunLeaseReference {
  const record = snapshotDataRecord(value, ['ownerId', 'fencingToken'], [], label);
  return Object.freeze({
    ownerId: record.ownerId,
    fencingToken: record.fencingToken,
  }) as RunLeaseReference;
}

function snapshotEventDraft(value: unknown, label: string): AgentEventDraft {
  const record = snapshotDataRecord(value, ['type', 'payload'], [
    'turnId', 'parentEventId', 'invocationId', 'attemptId',
    'schemaVersion', 'audience', 'persistence',
  ], label);
  if (
    Object.hasOwn(record, 'schemaVersion') || Object.hasOwn(record, 'audience') ||
    Object.hasOwn(record, 'persistence')
  ) {
    throw new AgentJournalError(
      'PRODUCER_METADATA_FORBIDDEN',
      'Event producers cannot choose schemaVersion, audience, or persistence.',
    );
  }
  return Object.freeze({
    type: record.type,
    payload: snapshotPortableData(record.payload, `${label} payload`),
    ...(Object.hasOwn(record, 'turnId') ? { turnId: record.turnId } : {}),
    ...(Object.hasOwn(record, 'parentEventId') ? { parentEventId: record.parentEventId } : {}),
    ...(Object.hasOwn(record, 'invocationId') ? { invocationId: record.invocationId } : {}),
    ...(Object.hasOwn(record, 'attemptId') ? { attemptId: record.attemptId } : {}),
  }) as AgentEventDraft;
}

function snapshotDataRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || nodeUtilTypes.isProxy(value)) {
    throw new AgentJournalError('INVALID_ARGUMENT', `${label} must be a plain non-Proxy object.`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AgentJournalError('INVALID_ARGUMENT', `${label} must be a plain non-Proxy object.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as
    Record<PropertyKey, PropertyDescriptor>;
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const actualKeys = Reflect.ownKeys(descriptors);
  const unknownKeys = actualKeys.filter((key) => typeof key !== 'string' || !allowed.has(key));
  if (unknownKeys.length > 0) {
    throw new AgentJournalError(
      'INVALID_ARGUMENT',
      `${label} contains unknown keys: ${unknownKeys.map(String).sort().join(', ')}.`,
    );
  }
  const output = Object.create(null) as Record<string, unknown>;
  for (const key of requiredKeys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined) {
      throw new AgentJournalError('INVALID_ARGUMENT', `${label}.${key} is required.`);
    }
    defineSnapshotValue(output, key, descriptor, `${label}.${key}`);
  }
  for (const key of optionalKeys) {
    const descriptor = descriptors[key];
    if (descriptor !== undefined) defineSnapshotValue(output, key, descriptor, `${label}.${key}`);
  }
  return Object.freeze(output);
}

function defineSnapshotValue(
  output: Record<string, unknown>, key: string, descriptor: PropertyDescriptor, label: string,
): void {
  if (!Object.hasOwn(descriptor, 'value')) {
    throw new AgentJournalError('INVALID_ARGUMENT', `${label} must be an own data property.`);
  }
  Object.defineProperty(output, key, {
    value: descriptor.value,
    enumerable: true,
    configurable: false,
    writable: false,
  });
}

function snapshotDataArray<T>(
  value: unknown,
  label: string,
  snapshotItem: (item: unknown, label: string) => T,
): readonly T[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    throw new AgentJournalError('INVALID_ARGUMENT', `${label} must be a non-Proxy array.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as
    Record<PropertyKey, PropertyDescriptor>;
  const lengthDescriptor = descriptors.length;
  if (lengthDescriptor === undefined || !Object.hasOwn(lengthDescriptor, 'value')) {
    throw new AgentJournalError('INVALID_ARGUMENT', `${label}.length must be a data property.`);
  }
  const length = Number(lengthDescriptor.value);
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new AgentJournalError('INVALID_ARGUMENT', `${label}.length must be a safe integer.`);
  }
  const entries: Array<{ index: number; value: unknown }> = [];
  const indices = new Set<number>();
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    const index = typeof key === 'string' ? canonicalArrayIndex(key) : undefined;
    const descriptor = descriptors[key];
    if (
      index === undefined || index >= length || indices.has(index) || descriptor === undefined
    ) {
      throw new AgentJournalError(
        'INVALID_ARGUMENT', `${label} contains an invalid array key: ${String(key)}.`,
      );
    }
    if (!Object.hasOwn(descriptor, 'value')) {
      throw new AgentJournalError(
        'INVALID_ARGUMENT', `${label}[${index}] must be an own data property.`,
      );
    }
    indices.add(index);
    entries.push({ index, value: descriptor.value });
  }
  if (entries.length !== length) {
    throw new AgentJournalError('INVALID_ARGUMENT', `${label} must be dense.`);
  }
  entries.sort((left, right) => left.index - right.index);
  const output = entries.map(({ index, value: item }) =>
    snapshotItem(item, `${label}[${index}]`));
  return Object.freeze(output);
}

function canonicalArrayIndex(key: string): number | undefined {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < 0xffff_ffff && String(index) === key
    ? index
    : undefined;
}

function snapshotPortableData(
  value: unknown,
  label: string,
  ancestors = new WeakSet<object>(),
): PortableValue {
  if (
    (typeof value === 'object' && value !== null || typeof value === 'function') &&
    nodeUtilTypes.isProxy(value)
  ) {
    throw new AgentJournalError('INVALID_ARGUMENT', `${label} must not contain a Proxy.`);
  }
  if (value === null || typeof value !== 'object') return value as PortableValue;
  if (ancestors.has(value)) {
    throw new AgentJournalError('INVALID_ARGUMENT', `${label} must not contain cycles.`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return snapshotDataArray(value, label, (item, itemLabel) =>
        snapshotPortableData(item, itemLabel, ancestors)) as PortableValue;
    }
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new AgentJournalError(
        'INVALID_EVENT_PAYLOAD', `${label} must contain only plain portable records.`,
      );
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output = Object.create(null) as Record<string, PortableValue>;
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string') {
        throw new AgentJournalError('INVALID_ARGUMENT', `${label} must not contain symbol keys.`);
      }
      const descriptor = descriptors[key];
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
        throw new AgentJournalError(
          'INVALID_ARGUMENT', `${label}.${key} must be an own data property.`,
        );
      }
      Object.defineProperty(output, key, {
        value: snapshotPortableData(descriptor.value, `${label}.${key}`, ancestors),
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return Object.freeze(output);
  } finally {
    ancestors.delete(value);
  }
}

function validateJournalCommand(command: JournalCommand, allowLegacyImport = false): JournalCommand {
  assertExactKeys(command, [
    'projectId', 'sessionId', 'runId', 'commandId', 'lease', 'expectedRunRevision', 'events',
  ], 'Journal command');
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
    assertExactKeys(value, [
      'type', 'payload', 'turnId', 'parentEventId', 'invocationId', 'attemptId',
    ], 'Event draft');
    if (typeof value.type !== 'string' || !isAgentEventType(value.type)) {
      throw new AgentJournalError('UNKNOWN_EVENT_TYPE', `Unknown Agent event type: ${String(value.type)}`);
    }
    validatePortable(value.payload, `${value.type} payload`);
    if (
      value.type === 'input.received' ||
      value.type.startsWith('run.') ||
      value.type.startsWith('turn.') ||
      value.type.startsWith('model_') ||
      value.type.startsWith('tool.')
      || (value.type === 'legacy.imported' && !allowLegacyImport)
    ) {
      throw new AgentJournalError(
        'COMMITTER_REQUIRED',
        `${value.type} can only be created by RunEventCommitter's atomic commit path.`,
      );
    }
    const payload = validateEventPayload(value.type, value.payload);
    return {
      type: value.type,
      payload,
      ...(value.turnId === undefined ? {} : { turnId: requireText(value.turnId, 'turnId') }),
      ...(value.parentEventId === undefined
        ? {}
        : { parentEventId: requireText(value.parentEventId, 'parentEventId') }),
      ...(value.invocationId === undefined
        ? {}
        : { invocationId: requireText(value.invocationId, 'invocationId') }),
      ...(value.attemptId === undefined
        ? {}
        : { attemptId: requireText(value.attemptId, 'attemptId') }),
    } as AgentEventDraft;
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
    expectedRunRevision: requireRevision(command.expectedRunRevision, 'expectedRunRevision'),
    events,
  };
}

function validateStartRunCommand(command: StartRunCommand): StartRunCommand {
  assertExactKeys(command, [
    'projectId', 'sessionId', 'runId', 'commandId', 'lease', 'expectedRunRevision',
  ], 'Start Run command');
  return {
    projectId: requireText(command.projectId, 'projectId'),
    sessionId: requireText(command.sessionId, 'sessionId'),
    runId: requireText(command.runId, 'runId'),
    commandId: requireText(command.commandId, 'commandId'),
    lease: {
      ownerId: requireText(command.lease.ownerId, 'lease.ownerId'),
      fencingToken: requireRevision(command.lease.fencingToken, 'lease.fencingToken'),
    },
    expectedRunRevision: requireRevision(command.expectedRunRevision, 'expectedRunRevision'),
  };
}

function validateStartTurnCommand(command: StartTurnCommand): StartTurnCommand {
  assertExactKeys(command, [
    'projectId', 'sessionId', 'runId', 'turnId', 'commandId', 'lease', 'expectedRunRevision',
  ], 'Start Turn command');
  return {
    projectId: requireText(command.projectId, 'projectId'),
    sessionId: requireText(command.sessionId, 'sessionId'),
    runId: requireText(command.runId, 'runId'),
    turnId: requireText(command.turnId, 'turnId'),
    commandId: requireText(command.commandId, 'commandId'),
    lease: {
      ownerId: requireText(command.lease.ownerId, 'lease.ownerId'),
      fencingToken: requireRevision(command.lease.fencingToken, 'lease.fencingToken'),
    },
    expectedRunRevision: requireRevision(command.expectedRunRevision, 'expectedRunRevision'),
  };
}

function requireRevision(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new AgentJournalError('INVALID_ARGUMENT', `${name} must be a positive integer.`);
  }
  return Number(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new AgentJournalError(
      'INVALID_ARGUMENT',
      `${label} contains unknown keys: ${unknown.sort().join(', ')}.`,
    );
  }
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
  assertExactKeys(input, [
    'projectId', 'runId', 'ownerId', 'ttlMs',
    ...(Object.hasOwn(input, 'fencingToken') ? ['fencingToken'] : []),
  ], 'Lease command');
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
  if (!isAgentEventType(row.event_type)) {
    throw new AgentJournalError('CORRUPT_EVENT', `Unknown stored Agent event type: ${row.event_type}`);
  }
  if (!Number.isInteger(Number(row.schema_version)) || Number(row.schema_version) < 1) {
    throw new AgentJournalError('CORRUPT_EVENT', 'Stored Agent event schemaVersion is invalid.');
  }
  if (
    !isNonEmptyText(row.event_id) || !isNonEmptyText(row.project_id) ||
    !isNonEmptyText(row.session_id) || !isNonEmptyText(row.run_id) ||
    !Number.isSafeInteger(Number(row.sequence)) || Number(row.sequence) < 1 ||
    !isIsoTimestamp(row.occurred_at)
  ) {
    throw new AgentJournalError('CORRUPT_EVENT', 'Stored Agent event metadata is invalid.');
  }
  if ([row.turn_id, row.parent_event_id, row.invocation_id, row.attempt_id]
    .some((value) => value !== null && !isNonEmptyText(value))) {
    throw new AgentJournalError('CORRUPT_EVENT', 'Stored optional causal identifiers are invalid.');
  }
  if (
    ((row.event_type.startsWith('turn.') || row.event_type === 'model_attempt_committed' ||
      row.event_type.startsWith('tool.')) && !isNonEmptyText(row.turn_id)) ||
    ((row.event_type === 'model_attempt_committed' || row.event_type.startsWith('tool.')) &&
      !isNonEmptyText(row.attempt_id)) ||
    (row.event_type.startsWith('tool.') && !isNonEmptyText(row.invocation_id))
  ) {
    throw new AgentJournalError('CORRUPT_EVENT', 'Stored Agent event causal identifiers are invalid.');
  }
  let payload: PortableValue;
  try {
    payload = parsePortableJson(row.payload_json);
  } catch (error) {
    throw new AgentJournalError(
      'CORRUPT_EVENT',
      `Stored Agent event payload is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    const event = upcastAgentEvent({
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
      type: row.event_type,
      occurredAt: row.occurred_at,
      payload,
    });
    assertEventOuterPayloadConsistency(row, event.payload);
    return event;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('UNSUPPORTED_EVENT_SCHEMA:')) {
      throw new AgentJournalError('UNSUPPORTED_EVENT_SCHEMA', error.message);
    }
    if (error instanceof AgentJournalError) throw error;
    throw new AgentJournalError(
      'CORRUPT_EVENT',
      `Stored Agent event failed runtime validation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assertStoredParentCausality(database: NodeDatabaseSync, row: EventRow): void {
  if (row.parent_event_id === null) return;
  const parent = database.prepare(
    `SELECT project_id, session_id, run_id, turn_id, attempt_id, sequence
     FROM agent_events WHERE event_id = ?`,
  ).get(row.parent_event_id) as {
    project_id: string; session_id: string; run_id: string; turn_id: string | null;
    attempt_id: string | null; sequence: number;
  } | undefined;
  if (
    parent === undefined || parent.project_id !== row.project_id ||
    parent.session_id !== row.session_id || parent.run_id !== row.run_id ||
    Number(parent.sequence) >= Number(row.sequence) ||
    (row.turn_id !== null && parent.turn_id !== row.turn_id) ||
    (row.attempt_id !== null && parent.attempt_id !== null &&
      parent.attempt_id !== row.attempt_id)
  ) {
    throw new AgentJournalError(
      'CORRUPT_EVENT',
      'Stored parent event is not earlier or is outside the child causal scope.',
    );
  }
}

function assertEventOuterPayloadConsistency(row: EventRow, payload: PortableValue): void {
  const record = payload as Record<string, PortableValue>;
  if (
    row.event_type === 'model_attempt_committed' &&
    row.attempt_id !== (record.validatedAttempt as Record<string, PortableValue>).attemptId
  ) {
    throw new AgentJournalError(
      'CORRUPT_EVENT', 'Stored model attempt outer and payload identifiers disagree.',
    );
  }
  if (
    Object.hasOwn(record, 'invocationId') &&
    row.invocation_id !== record.invocationId
  ) {
    throw new AgentJournalError(
      'CORRUPT_EVENT', 'Stored invocation outer and payload identifiers disagree.',
    );
  }
  if (row.event_type === 'artifact.created' && record.availability === 'available') {
    const projectDigest = createHash('sha256').update(row.project_id).digest('hex').slice(0, 24);
    if (typeof record.handle !== 'string' || !record.handle.startsWith(`agent-artifact:${projectDigest}:`)) {
      throw new AgentJournalError(
        'CORRUPT_EVENT', 'Stored artifact handle does not belong to the outer Project.',
      );
    }
  }
}

function parseProjectionJson<T>(
  json: string,
  label: string,
  assertion: (value: unknown) => asserts value is T,
): T {
  try {
    const value: unknown = JSON.parse(json);
    assertion(value);
    return value;
  } catch (error) {
    if (error instanceof AgentJournalError && error.code === 'PROJECTION_CORRUPT') throw error;
    throw new AgentJournalError(
      'PROJECTION_CORRUPT',
      `${label} projection is corrupt: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseProjectionPortableJson(json: string, label: string): PortableValue {
  return parseProjectionJson(json, label, (value): asserts value is PortableValue => {
    assertPortableValue(value);
  });
}

function assertRunProjection(value: unknown): asserts value is AgentRunProjection {
  const record = projectionRecord(value, 'Agent Run');
  projectionExactKeys(record, [
    'projectId', 'sessionId', 'runId', 'clientRequestId', 'state', 'revision', 'input',
    'createdAt', 'updatedAt',
  ], 'Agent Run');
  ['projectId', 'sessionId', 'runId', 'clientRequestId'].forEach((key) =>
    projectionText(record[key], `Agent Run ${key}`));
  if (![
    'created', 'Preparing', 'Compacting', 'CallingModel', 'ReceivingModel', 'ResolvingActions',
    'AwaitingUser', 'ExecutingTools', 'ApplyingObservations', 'Finalizing', 'Cancelling',
    'LimitReached', 'Interrupted', 'Completed', 'Failed', 'Cancelled',
  ].includes(String(record.state))) throw new TypeError('Agent Run state is invalid.');
  projectionPositiveInteger(record.revision, 'Agent Run revision');
  assertPortableValue(record.input);
  projectionIso(record.createdAt, 'Agent Run createdAt');
  projectionIso(record.updatedAt, 'Agent Run updatedAt');
}

function assertTurnProjection(value: unknown): asserts value is AgentTurnProjection {
  const record = projectionRecord(value, 'Agent Turn');
  projectionExactKeys(record, [
    'projectId', 'sessionId', 'runId', 'turnId', 'attemptId', 'blocks', 'finishReason',
    'usage', 'protocolEnvelopeRef', 'committedAt',
  ], 'Agent Turn');
  ['projectId', 'sessionId', 'runId', 'turnId', 'attemptId', 'protocolEnvelopeRef']
    .forEach((key) => projectionText(record[key], `Agent Turn ${key}`));
  if (!Array.isArray(record.blocks)) throw new TypeError('Agent Turn blocks must be an array.');
  record.blocks.forEach(assertProjectedModelContentBlock);
  if (!['stop', 'tool-calls', 'length', 'content-filter', 'error', 'unknown']
    .includes(String(record.finishReason))) throw new TypeError('Agent Turn finishReason is invalid.');
  if (record.usage !== undefined) assertProjectionUsage(record.usage);
  projectionIso(record.committedAt, 'Agent Turn committedAt');
}

function assertProtocolEnvelope(value: unknown): asserts value is ModelProtocolEnvelope {
  const record = projectionRecord(value, 'Protocol Envelope');
  projectionExactKeys(record, [
    'schemaVersion', 'attemptId', 'origin', 'correlations', 'opaqueBlockRefs',
  ], 'Protocol Envelope');
  if (record.schemaVersion !== 1) throw new TypeError('Protocol Envelope schemaVersion is invalid.');
  projectionText(record.attemptId, 'Protocol Envelope attemptId');
  const origin = projectionRecord(record.origin, 'Protocol Envelope origin');
  projectionExactKeys(origin, ['connectionId', 'model', 'protocol'], 'Protocol Envelope origin');
  ['connectionId', 'model', 'protocol'].forEach((key) =>
    projectionText(origin[key], `Protocol Envelope origin ${key}`));
  if (!Array.isArray(record.correlations) || !Array.isArray(record.opaqueBlockRefs)) {
    throw new TypeError('Protocol Envelope arrays are invalid.');
  }
  record.correlations.forEach(assertProjectedCorrelation);
  record.opaqueBlockRefs.forEach((item) => projectionText(item, 'Protocol Envelope opaqueBlockRef'));
}

function assertProjectedModelContentBlock(value: unknown): void {
  const block = projectionRecord(value, 'Model content block');
  switch (block.type) {
    case 'text':
      projectionExactKeys(block, ['type', 'text'], 'Text block');
      projectionText(block.text, 'Text block text');
      return;
    case 'resource-ref':
      projectionExactKeys(block, ['type', 'artifactId', 'mediaType', 'purpose'], 'Resource block');
      projectionText(block.artifactId, 'Resource block artifactId');
      projectionText(block.mediaType, 'Resource block mediaType');
      if (!['input', 'output'].includes(String(block.purpose))) {
        throw new TypeError('Resource block purpose is invalid.');
      }
      return;
    case 'reasoning-summary':
      projectionExactKeys(block, ['type', 'text', 'derivedFromOpaqueRef'], 'Reasoning block');
      projectionText(block.text, 'Reasoning block text');
      if (Object.hasOwn(block, 'derivedFromOpaqueRef')) {
        projectionText(block.derivedFromOpaqueRef, 'Reasoning block derivedFromOpaqueRef');
      }
      return;
    case 'provider-opaque': {
      projectionExactKeys(
        block, ['type', 'opaqueRef', 'protocol', 'origin', 'replay', 'value'], 'Opaque block',
      );
      projectionText(block.opaqueRef, 'Opaque block opaqueRef');
      projectionText(block.protocol, 'Opaque block protocol');
      const origin = projectionRecord(block.origin, 'Opaque block origin');
      projectionExactKeys(origin, ['connectionId', 'model'], 'Opaque block origin');
      projectionText(origin.connectionId, 'Opaque block origin connectionId');
      projectionText(origin.model, 'Opaque block origin model');
      assertProjectionReplay(block.replay, 'Opaque block replay');
      assertPortableValue(block.value);
      return;
    }
    case 'tool-call':
      projectionExactKeys(block, ['type', 'callId', 'name', 'arguments'], 'Tool call block');
      projectionText(block.callId, 'Tool call block callId');
      projectionText(block.name, 'Tool call block name');
      assertPortableValue(block.arguments);
      return;
    case 'tool-result':
      projectionExactKeys(block, ['type', 'callId', 'output', 'isError'], 'Tool result block');
      projectionText(block.callId, 'Tool result block callId');
      assertPortableValue(block.output);
      if (typeof block.isError !== 'boolean') throw new TypeError('Tool result isError is invalid.');
      return;
    default:
      throw new TypeError(`Unknown Model content block type: ${String(block.type)}.`);
  }
}

function assertProjectedCorrelation(value: unknown): void {
  const correlation = projectionRecord(value, 'Protocol correlation');
  projectionExactKeys(
    correlation, ['callId', 'draftCallKey', 'wireIdentity', 'replay'], 'Protocol correlation',
  );
  projectionText(correlation.callId, 'Protocol correlation callId');
  projectionText(correlation.draftCallKey, 'Protocol correlation draftCallKey');
  assertProjectionReplay(correlation.replay, 'Protocol correlation replay');
  if (Object.hasOwn(correlation, 'wireIdentity')) {
    const identity = projectionRecord(correlation.wireIdentity, 'Protocol wire identity');
    projectionExactKeys(identity, ['callId', 'providerItemId'], 'Protocol wire identity');
    if (Object.hasOwn(identity, 'callId')) {
      projectionText(identity.callId, 'Protocol wire identity callId');
    }
    if (Object.hasOwn(identity, 'providerItemId')) {
      projectionText(identity.providerItemId, 'Protocol wire identity providerItemId');
    }
    if (!Object.hasOwn(identity, 'callId') && !Object.hasOwn(identity, 'providerItemId')) {
      throw new TypeError('Protocol wire identity requires callId or providerItemId.');
    }
  }
}

function assertProjectionReplay(value: unknown, label: string): void {
  if (!['same-connection-only', 'compatible-protocol'].includes(String(value))) {
    throw new TypeError(`${label} is invalid.`);
  }
}

function assertInvocationProjection(value: unknown): asserts value is AgentInvocationProjection {
  const record = projectionRecord(value, 'Agent Invocation');
  projectionExactKeys(record, [
    'projectId', 'sessionId', 'runId', 'turnId', 'attemptId', 'invocationId', 'callId',
    'actionOrdinal', 'name', 'arguments', 'state', 'revision', 'createdAt',
  ], 'Agent Invocation');
  ['projectId', 'sessionId', 'runId', 'turnId', 'attemptId', 'invocationId', 'callId', 'name']
    .forEach((key) => projectionText(record[key], `Agent Invocation ${key}`));
  projectionNonNegativeInteger(record.actionOrdinal, 'Agent Invocation actionOrdinal');
  assertPortableValue(record.arguments);
  if (record.state !== 'proposed') throw new TypeError('Agent Invocation state is invalid.');
  projectionPositiveInteger(record.revision, 'Agent Invocation revision');
  projectionIso(record.createdAt, 'Agent Invocation createdAt');
}

function assertProjectionUsage(value: unknown): void {
  const record = projectionRecord(value, 'Model usage');
  projectionExactKeys(record, ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens'], 'Model usage');
  ['inputTokens', 'outputTokens', 'totalTokens'].forEach((key) =>
    projectionNonNegativeInteger(record[key], `Model usage ${key}`));
  if (record.cachedInputTokens !== undefined) {
    projectionNonNegativeInteger(record.cachedInputTokens, 'Model usage cachedInputTokens');
  }
}

function projectionRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function projectionExactKeys(
  record: Record<string, unknown>, allowed: readonly string[], label: string,
): void {
  const actual = Object.keys(record);
  const unknown = actual.filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new TypeError(`${label} has unknown fields: ${unknown.join(', ')}.`);
}

function projectionText(value: unknown, label: string): void {
  if (!isNonEmptyText(value)) throw new TypeError(`${label} must be a non-empty string.`);
}

function assertProjectionIdentity(condition: boolean, label: string): void {
  if (!condition) throw new TypeError(`${label} disagrees with its projection column.`);
}

function projectionNonNegativeInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${label} must be a non-negative integer.`);
  }
}

function projectionPositiveInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
}

function projectionIso(value: unknown, label: string): void {
  if (!isIsoTimestamp(value)) throw new TypeError(`${label} must be an ISO timestamp.`);
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
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
      UNIQUE (project_id, session_id, client_request_id),
      UNIQUE (project_id, run_id),
      UNIQUE (project_id, session_id, run_id)
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
      UNIQUE (project_id, session_id, run_id, turn_id, attempt_id),
      FOREIGN KEY (project_id, session_id, run_id)
        REFERENCES agent_runs(project_id, session_id, run_id),
      FOREIGN KEY (project_id, session_id, run_id, turn_id, attempt_id)
        REFERENCES agent_attempts(project_id, session_id, run_id, turn_id, attempt_id)
    );
    CREATE TABLE IF NOT EXISTS agent_turn_lifecycles (
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      turn_id TEXT NOT NULL PRIMARY KEY,
      revision INTEGER NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      UNIQUE (project_id, run_id, turn_id),
      UNIQUE (project_id, session_id, run_id, turn_id),
      FOREIGN KEY (project_id, session_id, run_id)
        REFERENCES agent_runs(project_id, session_id, run_id)
    );
    CREATE TABLE IF NOT EXISTS agent_attempts (
      attempt_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      committed_at TEXT NOT NULL,
      UNIQUE (project_id, session_id, run_id, turn_id, attempt_id),
      FOREIGN KEY (project_id, session_id, run_id)
        REFERENCES agent_runs(project_id, session_id, run_id),
      FOREIGN KEY (project_id, session_id, run_id, turn_id)
        REFERENCES agent_turn_lifecycles(project_id, session_id, run_id, turn_id)
    );
    CREATE TABLE IF NOT EXISTS agent_protocol_envelopes (
      envelope_ref TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      turn_id TEXT NOT NULL UNIQUE,
      attempt_id TEXT NOT NULL UNIQUE,
      envelope_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (project_id, session_id, run_id, turn_id, attempt_id)
        REFERENCES agent_turns(project_id, session_id, run_id, turn_id, attempt_id),
      FOREIGN KEY (project_id, session_id, run_id, turn_id, attempt_id)
        REFERENCES agent_attempts(project_id, session_id, run_id, turn_id, attempt_id)
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
      FOREIGN KEY (project_id, session_id, run_id, turn_id, attempt_id)
        REFERENCES agent_turns(project_id, session_id, run_id, turn_id, attempt_id),
      FOREIGN KEY (project_id, session_id, run_id, turn_id, attempt_id)
        REFERENCES agent_attempts(project_id, session_id, run_id, turn_id, attempt_id)
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
      FOREIGN KEY (project_id, run_id) REFERENCES agent_runs(project_id, run_id)
    );
  `);
  migrateArtifactReferenceUniqueness(database);
  migrateLegacyRunLeaseForeignKey(database);
}

function migrateArtifactReferenceUniqueness(database: NodeDatabaseSync): void {
  try {
    const duplicate = database.prepare(`
      SELECT project_id, json_extract(payload_json, '$.artifactId') AS artifact_id,
        COUNT(*) AS fact_count
      FROM agent_events
      WHERE event_type = 'artifact.created'
      GROUP BY project_id, artifact_id
      HAVING fact_count > 1
      LIMIT 1
    `).get() as { project_id: string; artifact_id: string | null; fact_count: number } | undefined;
    if (duplicate !== undefined) {
      throw new AgentJournalError(
        'PROJECTION_CORRUPT',
        `Artifact reference ${duplicate.artifact_id ?? '<missing>'} has duplicate committed facts.`,
      );
    }
    database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_events_artifact_reference
        ON agent_events(project_id, json_extract(payload_json, '$.artifactId'))
        WHERE event_type = 'artifact.created'
    `);
  } catch (error) {
    if (error instanceof AgentJournalError) throw error;
    throw new AgentJournalError(
      'PROJECTION_CORRUPT',
      `Artifact reference uniqueness migration failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function migrateLegacyRunLeaseForeignKey(database: NodeDatabaseSync): void {
  database.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_project_run_unique
     ON agent_runs(project_id, run_id)`,
  );
  const foreignKeys = database.prepare('PRAGMA foreign_key_list(agent_run_leases)').all() as unknown as
    Array<{ id: number; seq: number; table: string; from: string; to: string }>;
  const scopedForeignKeyId = foreignKeys.find((row) =>
    row.table === 'agent_runs' && row.from === 'project_id' && row.to === 'project_id')?.id;
  if (
    scopedForeignKeyId !== undefined &&
    foreignKeys.some((row) =>
      row.id === scopedForeignKeyId && row.from === 'run_id' && row.to === 'run_id')
  ) {
    return;
  }
  const invalid = database.prepare(
    `SELECT COUNT(*) AS count
     FROM agent_run_leases AS lease
     LEFT JOIN agent_runs AS run
       ON run.project_id = lease.project_id AND run.run_id = lease.run_id
     WHERE run.run_id IS NULL`,
  ).get() as { count: number };
  if (Number(invalid.count) > 0) {
    throw new AgentJournalError(
      'PROJECTION_CORRUPT',
      'Legacy Run lease rows contain project/run scope mismatches and cannot be migrated safely.',
    );
  }
  transaction(database, () => {
    database.exec(`
      CREATE TABLE agent_run_leases_scoped_v2 (
        project_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
        PRIMARY KEY (project_id, run_id),
        FOREIGN KEY (project_id, run_id) REFERENCES agent_runs(project_id, run_id)
      );
      INSERT INTO agent_run_leases_scoped_v2
        (project_id, run_id, owner_id, expires_at_ms, fencing_token)
      SELECT project_id, run_id, owner_id, expires_at_ms, fencing_token
      FROM agent_run_leases;
      DROP TABLE agent_run_leases;
      ALTER TABLE agent_run_leases_scoped_v2 RENAME TO agent_run_leases;
    `);
  });
}

function snapshotValidatedAttemptCommand(
  command: CommitValidatedAttemptCommand,
): Readonly<CommitValidatedAttemptCommand> {
  const values = snapshotDataRecord(command, [
    'projectId', 'sessionId', 'runId', 'turnId', 'commandId', 'lease',
    'expectedRunRevision', 'expectedTurnRevision', 'attempt',
  ], [], 'Model commit command');
  const leaseValues = snapshotDataRecord(values.lease, [
    'ownerId', 'fencingToken',
  ], [], 'Model commit lease');
  const lease = Object.freeze({
    ownerId: requireText(leaseValues.ownerId, 'lease.ownerId'),
    fencingToken: requireRevision(leaseValues.fencingToken, 'lease.fencingToken'),
  });
  return Object.freeze({
    projectId: requireText(values.projectId, 'projectId'),
    sessionId: requireText(values.sessionId, 'sessionId'),
    runId: requireText(values.runId, 'runId'),
    turnId: requireText(values.turnId, 'turnId'),
    commandId: requireText(values.commandId, 'commandId'),
    lease,
    expectedRunRevision: requireRevision(values.expectedRunRevision, 'expectedRunRevision'),
    expectedTurnRevision: requireRevision(values.expectedTurnRevision, 'expectedTurnRevision'),
    attempt: values.attempt as CommitValidatedAttemptCommand['attempt'],
  });
}

function assertCanonicalAttemptIdentities(
  attempt: CommitValidatedAttemptCommand['attempt'],
): void {
  requireText(attempt.attemptId, 'attempt.attemptId');
  requireText(attempt.origin.connectionId, 'attempt.origin.connectionId');
  requireText(attempt.origin.model, 'attempt.origin.model');
  for (const block of attempt.blocks) {
    if (block.type === 'tool-call-draft') {
      requireText(block.draftCallKey, 'attempt.block.draftCallKey');
      requireText(block.name, 'attempt.block.name');
      if (block.wireIdentity?.callId !== undefined) {
        requireText(block.wireIdentity.callId, 'attempt.block.wireIdentity.callId');
      }
      if (block.wireIdentity?.providerItemId !== undefined) {
        requireText(
          block.wireIdentity.providerItemId,
          'attempt.block.wireIdentity.providerItemId',
        );
      }
    }
    if (block.type === 'provider-opaque') {
      requireText(block.opaqueRef, 'attempt.block.opaqueRef');
      requireText(block.origin.connectionId, 'attempt.block.origin.connectionId');
      requireText(block.origin.model, 'attempt.block.origin.model');
    }
  }
  attempt.opaqueBlockRefs.forEach((reference) =>
    requireText(reference, 'attempt.opaqueBlockRef'));
}

function prepareValidatedAttempt(command: CommitValidatedAttemptCommand): ModelTurnCommitResult {
  const { attempt } = command;
  try {
    assertPortableValue(attempt);
    assertNoSecretMaterial(attempt);
  } catch (error) {
    throw new AgentJournalError(
      'INVALID_EVENT_PAYLOAD',
      `Validated model attempt is not safe portable data: ${errorMessage(error)}`,
    );
  }

  const actualOpaqueRefs = attempt.blocks.flatMap((block) =>
    block.type === 'provider-opaque' ? [block.opaqueRef] : [],
  );
  if (canonicalJson(actualOpaqueRefs) !== canonicalJson(attempt.opaqueBlockRefs)) {
    throw new AgentJournalError(
      'INVALID_EVENT_PAYLOAD',
      'Validated attempt opaqueBlockRefs do not match its ordered opaque blocks.',
    );
  }

  const correlations: ModelProtocolEnvelope['correlations'] = [];
  const invocations: AgentInvocationProjection[] = [];
  const blocks: ModelContentBlock[] = [];
  const draftKeys = new Set<string>();
  let actionOrdinal = 0;
  const committedAt = new Date(0).toISOString();
  for (const block of attempt.blocks) {
    if (block.type !== 'tool-call-draft') {
      blocks.push(structuredClone(block));
      continue;
    }
    if (draftKeys.has(block.draftCallKey)) {
      throw new AgentJournalError('INVALID_EVENT_PAYLOAD', 'Tool draftCallKey must be unique.');
    }
    draftKeys.add(block.draftCallKey);
    const callId = stableIdentity('call', command.runId, command.turnId, actionOrdinal);
    const invocationId = stableIdentity('invocation', command.runId, command.turnId, actionOrdinal);
    blocks.push({
      type: 'tool-call',
      callId,
      name: block.name,
      arguments: structuredClone(block.arguments),
    });
    correlations.push({
      callId,
      draftCallKey: block.draftCallKey,
      ...(block.wireIdentity === undefined
        ? {}
        : { wireIdentity: structuredClone(block.wireIdentity) }),
      replay: 'same-connection-only',
    });
    invocations.push({
      projectId: command.projectId,
      sessionId: command.sessionId,
      runId: command.runId,
      turnId: command.turnId,
      attemptId: attempt.attemptId,
      invocationId,
      callId,
      actionOrdinal,
      name: block.name,
      arguments: structuredClone(block.arguments),
      state: 'proposed',
      revision: 1,
      createdAt: committedAt,
    });
    actionOrdinal += 1;
  }

  const envelope: ModelProtocolEnvelope = {
    schemaVersion: 1,
    attemptId: attempt.attemptId,
    origin: structuredClone(attempt.origin),
    correlations,
    opaqueBlockRefs: [...attempt.opaqueBlockRefs],
  };
  const turn: AgentTurnProjection = {
    projectId: command.projectId,
    sessionId: command.sessionId,
    runId: command.runId,
    turnId: command.turnId,
    attemptId: attempt.attemptId,
    blocks,
    finishReason: attempt.finishReason ?? 'unknown',
    ...(attempt.usage === undefined ? {} : { usage: structuredClone(attempt.usage) }),
    protocolEnvelopeRef: `protocol-envelope:${command.turnId}`,
    committedAt,
  };
  return { turn, envelope, invocations };
}

function stableIdentity(
  prefix: 'call' | 'invocation',
  runId: string,
  turnId: string,
  actionOrdinal: number,
): string {
  const digest = createHash('sha256')
    .update(`${runId}\0${turnId}\0${actionOrdinal}`)
    .digest('hex')
    .slice(0, 32);
  return `${prefix}_${digest}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AgentJournalError('INVALID_ARGUMENT', `${name} is required.`);
  }
  if (value !== value.trim()) {
    throw new AgentJournalError('INVALID_ARGUMENT', `${name} must be canonical without outer whitespace.`);
  }
  return value;
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
