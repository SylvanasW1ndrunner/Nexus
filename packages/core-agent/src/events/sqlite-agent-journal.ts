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
  type GetToolApprovalInput,
  type ListToolApprovalsInput,
  type ToolApprovalPage,
  type ListTurnInvocationsInput,
  type RenewRunLeaseInput,
  type RunLease,
  type RunLeaseReference,
  type ToolInvocationCommitResult,
  type ToolInvocationJournalCommand,
  type AgentObservationProjection,
  type StartRunCommand,
  type StartTurnCommand,
} from './agent-journal.js';
import type {
  AgentEvent,
  AgentEventDraft,
  AgentEventType,
  AgentRunState,
  ToolApprovalFact,
  ToolEffectFact,
  ToolExecutionErrorFact,
} from './agent-event.js';
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
import { activeLegacyMigrationIdentity } from '../internal/legacy-migration-writer.js';
import { bindToolLifecycleCommitter } from '../internal/tool-lifecycle-authority.js';
import { bindKernelJournalCommitter } from '../internal/kernel-journal-authority.js';
import { bindSessionBindingCommitter } from '../internal/session-binding-authority.js';
import type {
  BindSessionModelCommand,
  SessionModelBinding,
} from '../kernel/session-model-binding.js';
import type {
  EnvironmentBindingInput,
  FinalizeRunKernelCommand,
  KernelJournalCommand,
  KernelJournalCommitResult,
  KernelRunProjection,
  PersistedEnvironmentBinding,
  PersistedTurnSnapshot,
  TurnSnapshotInput,
} from '../kernel/run-controller.js';
import {
  createKernelRunProjection,
  projectKernelRunEvent,
  projectKernelSchedule,
} from '../kernel/kernel-run-projector.js';
import {
  decideSchedule,
  type ScheduledToolInvocation,
} from '../tools/tool-scheduler.js';

type NodeDatabaseSyncConstructor = new (location: string) => NodeDatabaseSync;

export type ModelCommitFaultPoint =
  | 'after-model-event-before-attempt'
  | 'after-model-attempt-before-turn'
  | 'after-turn-before-envelope'
  | 'after-envelope-before-invocations'
  | 'after-first-invocation';

export type KernelCommitFaultPoint = 'after-events-before-projection';

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
type KernelEnvironmentRow = {
  environment_binding_id: string; project_id: string; session_id: string; run_id: string;
  schema_version: number; digest: string; payload_json: string; created_at: string;
};
type KernelSnapshotRow = {
  snapshot_id: string; project_id: string; session_id: string; run_id: string; turn_id: string;
  environment_binding_id: string; schema_version: number; digest: string;
  payload_json: string; created_at: string;
};

const MAX_TOOL_SUMMARY_CHARS = 4_096;
const MAX_APPROVAL_SUMMARY_CHARS = 2_000;
const MAX_APPROVAL_REASON_CHARS = 2_000;
const MAX_DECIDED_BY_CHARS = 256;
const MAX_TOOL_RESULT_REFS = 32;
const KERNEL_RESERVED_EVENT_TYPES = new Set<AgentEventType>([
  'run.environment_bound', 'delivery.decided', 'plan.created', 'plan.updated',
]);
const PROJECT_ARTIFACT_HANDLE = /^agent-artifact:[a-f0-9]{24}:[a-f0-9]{40}$/u;
const TOOL_INVOCATION_COMMON_KEYS = [
  'action', 'projectId', 'sessionId', 'runId', 'turnId', 'invocationId',
  'commandId', 'lease', 'expectedRunRevision', 'expectedInvocationRevision',
] as const;
const TOOL_INVOCATION_ACTION_KEYS: Record<ToolInvocationJournalCommand['action'], readonly string[]> = {
  validate: [
    'canonicalToolId', 'toolRevision', 'effect', 'normalizedArgumentsDigest',
    'authorization', 'approvalSummary',
  ],
  'reject-validation': ['summary', 'error'],
  'decide-approval': [
    'approvalId', 'canonicalToolId', 'toolRevision', 'effect',
    'normalizedArgumentsDigest', 'proposedRevision', 'decision', 'decidedBy', 'reason',
  ],
  start: ['idempotencyKey', 'attempt', 'recoveryOfFencingToken'],
  finish: [
    'outcome', 'summary', 'resultRefs', 'durableSummary', 'modelProjection',
    'userProjection', 'error', 'interruptedFencingToken',
  ],
  observe: ['observation'],
  'authorize-retry': [
    'permitId', 'toolRevision', 'effect', 'normalizedArgumentsDigest', 'reason',
  ],
  'resolve-outcome': [
    'resolutionId', 'outcome', 'canonicalToolId', 'toolRevision', 'effect',
    'normalizedArgumentsDigest', 'proposedRevision', 'summary',
  ],
};
const TOOL_INVOCATION_OPTIONAL_ACTION_KEYS: Record<
  ToolInvocationJournalCommand['action'], readonly string[]
> = {
  validate: [],
  'reject-validation': [],
  'decide-approval': ['decidedBy', 'reason'],
  start: ['recoveryOfFencingToken'],
  finish: [
    'durableSummary', 'modelProjection', 'userProjection', 'error',
    'interruptedFencingToken',
  ],
  observe: [],
  'authorize-retry': [],
  'resolve-outcome': [],
};

export class SqliteAgentJournal implements AgentJournal {
  readonly filePath: string;
  readonly busyTimeoutMs: number;
  readonly #now: () => string;
  readonly #createId: () => string;
  #faultPoint: ModelCommitFaultPoint | undefined;
  #kernelFaultPoint: KernelCommitFaultPoint | undefined;

  constructor(options: SqliteAgentJournalOptions) {
    this.filePath = requireText(options.filePath, 'filePath');
    this.busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    if (!Number.isInteger(this.busyTimeoutMs) || this.busyTimeoutMs < 1 || this.busyTimeoutMs > 60_000) {
      throw new AgentJournalError('INVALID_ARGUMENT', 'busyTimeoutMs must be between 1 and 60000.');
    }
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#createId = options.createId ?? randomUUID;
    bindToolLifecycleCommitter(this, (command) => this.#commitToolInvocation(command));
    bindKernelJournalCommitter(this, (command) => this.#commitKernelCommand(command));
    bindSessionBindingCommitter(this, (command) => this.#commitSessionModelBinding(command));
  }

  failAt(point: ModelCommitFaultPoint): void {
    this.#faultPoint = point;
  }

  failKernelAt(point: KernelCommitFaultPoint): void {
    this.#kernelFaultPoint = point;
  }

  async createRun(command: CreateRunCommand): Promise<CreateRunResult> {
    await Promise.resolve();
    const migrationIdentity = activeLegacyMigrationIdentity(this);
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
          payload: {
            clientRequestId,
            ...(migrationIdentity === undefined ? {} : {
              visibility: 'legacy-import-carrier' as const,
            }),
          },
          parentEventId: inputEvent.eventId,
          occurredAt,
        });
        database
          .prepare(
            `INSERT INTO agent_runs (
              run_id, project_id, session_id, client_request_id, state, revision,
              input_json, created_at, updated_at, hidden
            ) VALUES (?, ?, ?, ?, 'created', 1, ?, ?, ?, ?)`,
          )
          .run(
            runId, projectId, sessionId, clientRequestId, JSON.stringify(input),
            occurredAt, occurredAt, migrationIdentity === undefined ? 0 : 1,
          );
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

  async #commitSessionModelBinding(
    command: BindSessionModelCommand,
  ): Promise<SessionModelBinding> {
    const snapshot = snapshotSessionBindingCommand(command);
    await Promise.resolve();
    const requestDigest = digestValue(snapshot);
    return this.#withDatabase((database) => transaction(database, () => {
      const replay = readCommandResult<SessionModelBinding>(
        database, snapshot.projectId, snapshot.commandId, requestDigest,
      );
      if (replay !== undefined) return deepFreezeKernelValue(replay);
      const current = database.prepare(
        `SELECT revision FROM agent_session_model_bindings
         WHERE project_id = ? AND session_id = ?`,
      ).get(snapshot.projectId, snapshot.sessionId) as { revision: number } | undefined;
      const currentRevision = current?.revision ?? 0;
      if (currentRevision !== snapshot.expectedRevision) {
        throw new AgentJournalError('REVISION_CONFLICT', 'Session model binding revision changed.');
      }
      const sequenceRow = database.prepare(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
         FROM agent_session_events WHERE project_id = ?`,
      ).get(snapshot.projectId) as { next_sequence: number };
      const nextRevision = currentRevision + 1;
      const occurredAt = this.#now();
      const binding: SessionModelBinding = deepFreezeKernelValue({
        schemaVersion: 1, projectId: snapshot.projectId, sessionId: snapshot.sessionId,
        revision: nextRevision, connectionId: snapshot.connectionId,
        modelId: snapshot.modelId, updatedAt: occurredAt,
      });
      database.prepare(
        `INSERT INTO agent_session_events (
          project_id, sequence, event_id, schema_version, session_id,
          event_type, payload_json, occurred_at
        ) VALUES (?, ?, ?, 1, ?, 'session.model_bound', ?, ?)`,
      ).run(
        snapshot.projectId, sequenceRow.next_sequence, `session_event_${this.#createId()}`,
        snapshot.sessionId, JSON.stringify(binding), occurredAt,
      );
      database.prepare(
        `INSERT INTO agent_session_model_bindings (
          project_id, session_id, revision, connection_id, model_id, payload_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, session_id) DO UPDATE SET
          revision = excluded.revision, connection_id = excluded.connection_id,
          model_id = excluded.model_id, payload_json = excluded.payload_json,
          updated_at = excluded.updated_at`,
      ).run(
        snapshot.projectId, snapshot.sessionId, nextRevision, snapshot.connectionId,
        snapshot.modelId, JSON.stringify(binding), occurredAt,
      );
      writeCommandResult(
        database, snapshot.projectId, snapshot.commandId, 'session.model-bind',
        requestDigest, binding, occurredAt,
      );
      return binding;
    }));
  }

  async commit(command: JournalCommand): Promise<JournalCommitResult> {
    await Promise.resolve();
    const identity = activeLegacyMigrationIdentity(this);
    const normalized = validateJournalCommand(snapshotJournalCommand(command), identity !== undefined);
    if (
      identity === undefined &&
      normalized.events.some(({ type }) => KERNEL_RESERVED_EVENT_TYPES.has(type))
    ) {
      throw new AgentJournalError(
        'COMMITTER_REQUIRED',
        'Kernel lifecycle facts require the sealed RunController committer.',
      );
    }
    if (identity !== undefined && (
      normalized.events.some(({ type }) => type !== 'legacy.imported' && type !== 'run.cancelled') ||
      !normalized.commandId.includes(identity.migrationId)
    )) {
      throw new AgentJournalError(
        'COMMITTER_REQUIRED',
        'Legacy import boundary accepts only identity-bound migration facts.',
      );
    }
    const contextMatches = identity === undefined || this.#withDatabase((database) => {
      const row = database.prepare(`
        SELECT migration_id, source_digest, sealed
        FROM legacy_migration_build_context WHERE id = 1
      `).get() as { migration_id: string; source_digest: string; sealed: number } | undefined;
      return row !== undefined && row.migration_id === identity.migrationId &&
        row.source_digest === identity.sourceDigest && row.sealed === 0;
    });
    if (!contextMatches) {
      throw new AgentJournalError(
        'COMMITTER_REQUIRED',
        'Shadow database does not contain the validated legacy migration build context.',
      );
    }
    return this.#commitNormalized(normalized);
  }

  async #commitToolInvocation(
    command: ToolInvocationJournalCommand,
  ): Promise<ToolInvocationCommitResult> {
    const snapshot = snapshotToolInvocationCommand(command);
    await Promise.resolve();
    const normalized = normalizeToolInvocationCommand(snapshot);
    const requestDigest = digestValue(toolInvocationCommandIdentity(normalized));
    return this.#withDatabase((database) => transaction(database, () => {
      const replay = readCommandResult<ToolInvocationCommitResult>(
        database, normalized.projectId, normalized.commandId, requestDigest,
      );
      if (replay !== undefined) return replay;
      this.#assertRun(
        database, normalized.projectId, normalized.sessionId, normalized.runId,
      );
      this.#assertLease(database, normalized.projectId, normalized.runId, normalized.lease);
      this.#assertRunRevision(
        database, normalized.projectId, normalized.runId, normalized.expectedRunRevision,
      );
      const invocation = readInvocationProjection(database, normalized.invocationId);
      if (invocation === null) {
        throw new AgentJournalError(
          'INVOCATION_NOT_FOUND', `Invocation not found: ${normalized.invocationId}`,
        );
      }
      assertInvocationBinding(invocation, normalized);
      if (invocation.revision !== normalized.expectedInvocationRevision) {
        throw new AgentJournalError(
          'REVISION_CONFLICT', 'Invocation revision does not match.',
        );
      }
      const occurredAt = this.#now();
      const events: AgentEvent[] = [];
      let approval: ToolApprovalFact | undefined;
      let retryPermit: ToolInvocationCommitResult['retryPermit'];
      const append = (
        type: AgentEventType,
        payload: unknown,
      ): AgentEvent => {
        const event = this.#appendEvent(database, {
          projectId: invocation.projectId,
          sessionId: invocation.sessionId,
          runId: invocation.runId,
          turnId: invocation.turnId,
          attemptId: invocation.attemptId,
          invocationId: invocation.invocationId,
          type,
          payload,
          occurredAt,
        });
        events.push(event);
        invocation.revision += 1;
        invocation.updatedAt = occurredAt;
        return event;
      };

      switch (normalized.action) {
        case 'resolve-outcome': {
          const decisionDigest = digestValue(outcomeResolutionIdentity(normalized));
          if (invocation.outcomeResolution !== undefined) {
            if (invocation.outcomeResolution.decisionDigest !== decisionDigest) {
              throw new AgentJournalError(
                'OUTCOME_RESOLUTION_CONFLICT',
                'Unknown outcome already has a conflicting resolution.',
              );
            }
            const result: ToolInvocationCommitResult = { events, invocation };
            writeCommandResult(
              database, normalized.projectId, normalized.commandId,
              'tool.resolve-outcome', requestDigest, result, occurredAt,
            );
            return result;
          }
          requireInvocationState(invocation, ['observed']);
          if (
            invocation.terminal?.kind !== 'outcome_unknown' ||
            invocation.observation === undefined ||
            invocation.canonicalToolId === undefined ||
            canonicalJson(invocation.canonicalToolId) !==
              canonicalJson(normalized.canonicalToolId) ||
            invocation.toolRevision !== normalized.toolRevision ||
            invocation.effect !== normalized.effect ||
            invocation.normalizedArgumentsDigest !== normalized.normalizedArgumentsDigest ||
            invocation.proposedRevision !== normalized.proposedRevision
          ) {
            throw new AgentJournalError(
              'INVOCATION_STATE_CONFLICT',
              'Outcome resolution does not match the exact unknown Invocation.',
            );
          }
          invocation.state = 'observed';
          const priorTerminal = invocation.terminal;
          const resolutionError: ToolExecutionErrorFact | undefined =
            normalized.outcome === 'failed'
              ? {
                  code: 'OUTCOME_RESOLVED_FAILED', category: 'resolution',
                  retryable: false, outcome: 'unknown',
                }
              : undefined;
          invocation.terminal = {
            kind: normalized.outcome,
            summary: boundedText(normalized.summary, 4_096),
            resultRefs: [...priorTerminal.resultRefs],
            ...(priorTerminal.durableSummary === undefined
              ? {}
              : { durableSummary: structuredClone(priorTerminal.durableSummary) }),
            ...(priorTerminal.modelProjection === undefined
              ? {}
              : { modelProjection: structuredClone(priorTerminal.modelProjection) }),
            ...(priorTerminal.userProjection === undefined
              ? {}
              : { userProjection: structuredClone(priorTerminal.userProjection) }),
            ...(resolutionError === undefined ? {} : { error: resolutionError }),
            occurredAt,
          };
          invocation.observation = {
            observationId: invocation.observation.observationId,
            invocationId: invocation.observation.invocationId,
            summary: invocation.terminal.summary,
            evidenceRefs: [...invocation.terminal.resultRefs],
            outcome: normalized.outcome,
            ...(invocation.terminal.modelProjection === undefined
              ? {}
              : { modelProjection: structuredClone(invocation.terminal.modelProjection) }),
            ...(resolutionError === undefined
              ? {}
              : { errorCode: resolutionError.code }),
            occurredAt,
          };
          invocation.outcomeResolution = {
            resolutionId: normalized.resolutionId,
            decisionDigest,
            outcome: normalized.outcome,
            resolvedAt: occurredAt,
          };
          append('tool.outcome_resolved', {
            resolutionId: normalized.resolutionId,
            decisionDigest,
            invocationId: invocation.invocationId,
            outcome: normalized.outcome,
            canonicalToolId: normalized.canonicalToolId,
            toolRevision: normalized.toolRevision,
            effect: normalized.effect,
            normalizedArgumentsDigest: normalized.normalizedArgumentsDigest,
            proposedRevision: normalized.proposedRevision,
            summary: invocation.terminal.summary,
            resultRefs: invocation.terminal.resultRefs,
            ...(invocation.terminal.durableSummary === undefined
              ? {}
              : { durableSummary: invocation.terminal.durableSummary }),
            ...(invocation.terminal.modelProjection === undefined
              ? {}
              : { modelProjection: invocation.terminal.modelProjection }),
            ...(invocation.terminal.userProjection === undefined
              ? {}
              : { userProjection: invocation.terminal.userProjection }),
            ...(invocation.terminal.error === undefined
              ? {}
              : { error: invocation.terminal.error }),
          });
          const observation = invocation.observation;
          database.prepare(
            `UPDATE agent_observations SET payload_json = ?
             WHERE observation_id = ? AND invocation_id = ?`,
          ).run(
            JSON.stringify({
              ...observation,
              projectId: invocation.projectId,
              runId: invocation.runId,
              createdAt: observation.occurredAt,
            }),
            observation.observationId,
            invocation.invocationId,
          );
          break;
        }
        case 'reject-validation': {
          requireInvocationState(invocation, ['proposed', 'authorized']);
          if (invocation.state === 'proposed') {
            append('tool.validated', {
              invocationId: invocation.invocationId,
              validationError: normalized.error,
            });
          }
          invocation.state = 'failed';
          invocation.terminal = {
            kind: 'failed',
            summary: boundedText(normalized.summary, 4_096),
            resultRefs: [],
            error: structuredClone(normalized.error),
            occurredAt,
          };
          append('tool.failed', {
            summary: invocation.terminal.summary,
            resultRefs: [],
            error: invocation.terminal.error,
          });
          break;
        }
        case 'validate': {
          requireInvocationState(invocation, ['proposed']);
          let authorization = normalized.authorization;
          const riskyPredecessor = normalized.effect === 'non_idempotent'
            ? findEquivalentUnknownInvocation(database, invocation, normalized)
            : undefined;
          const availablePermit = riskyPredecessor === undefined
            ? undefined
            : findUnconsumedRetryPermit(database, riskyPredecessor);
          if (riskyPredecessor !== undefined && availablePermit === undefined) {
            authorization = 'deny';
          }
          invocation.canonicalToolId = structuredClone(normalized.canonicalToolId);
          invocation.toolRevision = normalized.toolRevision;
          invocation.effect = normalized.effect;
          invocation.normalizedArgumentsDigest = normalized.normalizedArgumentsDigest;
          invocation.proposedRevision = invocation.revision;
          if (availablePermit !== undefined && riskyPredecessor !== undefined) {
            invocation.retryOf = riskyPredecessor.invocationId;
            invocation.retryPermitId = availablePermit.permitId;
          }
          invocation.state = 'validated';
          append('tool.validated', {
            invocationId: invocation.invocationId,
            canonicalToolId: invocation.canonicalToolId,
            toolRevision: invocation.toolRevision,
            effect: invocation.effect,
            normalizedArgumentsDigest: invocation.normalizedArgumentsDigest,
            proposedRevision: invocation.proposedRevision,
            ...(invocation.retryOf === undefined ? {} : { retryOf: invocation.retryOf }),
            ...(invocation.retryPermitId === undefined
              ? {}
              : { retryPermitId: invocation.retryPermitId }),
          });
          if (authorization === 'allow') {
            const approvalId = `automatic_${stableToolIdentity(invocation.invocationId)}`;
            invocation.approvalId = approvalId;
            invocation.state = 'authorized';
            append('tool.authorized', { approvalId, invocationId: invocation.invocationId });
          } else if (authorization === 'deny') {
            const approvalId = `policy_${stableToolIdentity(invocation.invocationId)}`;
            const reason = riskyPredecessor !== undefined && availablePermit === undefined
              ? 'An exact single-use retry permit is required for this unknown outcome.'
              : 'The tool invocation was denied.';
            invocation.approvalId = approvalId;
            invocation.state = 'denied';
            invocation.terminal = {
              kind: 'denied', summary: reason, resultRefs: [], occurredAt,
            };
            append('tool.denied', { approvalId, invocationId: invocation.invocationId, reason });
          } else {
            const approvalId = `approval_${stableToolIdentity(invocation.invocationId)}`;
            approval = {
              approvalId,
              projectId: invocation.projectId,
              sessionId: invocation.sessionId,
              runId: invocation.runId,
              turnId: invocation.turnId,
              invocationId: invocation.invocationId,
              canonicalToolId: structuredClone(normalized.canonicalToolId),
              toolRevision: normalized.toolRevision,
              effect: normalized.effect,
              normalizedArgumentsDigest: normalized.normalizedArgumentsDigest,
              proposedRevision: invocation.proposedRevision,
              status: 'pending',
            };
            invocation.approvalId = approvalId;
            invocation.state = 'awaiting_approval';
            append('tool.approval_requested', {
              approval,
              summary: boundedText(normalized.approvalSummary, 2_000),
            });
            database.prepare(
              `INSERT INTO agent_approvals (
                approval_id, project_id, run_id, invocation_id, tool_revision,
                arguments_digest, effect, status, payload_json, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
            ).run(
              approvalId, invocation.projectId, invocation.runId, invocation.invocationId,
              normalized.toolRevision, normalized.normalizedArgumentsDigest,
              normalized.effect, JSON.stringify(approval), occurredAt,
            );
          }
          break;
        }
        case 'decide-approval': {
          const storedApproval = readApprovalProjection(database, normalized.approvalId);
          if (storedApproval === null) {
            throw new AgentJournalError('APPROVAL_NOT_FOUND', 'Approval request was not found.');
          }
          approval = storedApproval;
          assertApprovalBinding(approval, normalized);
          if (approval.status !== 'pending') {
            const prior = approval.status === 'approved' ? 'approve' : 'deny';
            if (prior !== normalized.decision) {
              throw new AgentJournalError(
                'APPROVAL_DECISION_CONFLICT', 'Approval already has a conflicting decision.',
              );
            }
            const result: ToolInvocationCommitResult = { events, invocation, approval };
            writeCommandResult(
              database, normalized.projectId, normalized.commandId,
              'tool.decide-approval', requestDigest, result, occurredAt,
            );
            return result;
          }
          requireInvocationState(invocation, ['awaiting_approval']);
          approval.status = normalized.decision === 'approve' ? 'approved' : 'denied';
          approval.decidedAt = occurredAt;
          if (normalized.decidedBy !== undefined) approval.decidedBy = normalized.decidedBy;
          if (normalized.reason !== undefined) approval.reason = normalized.reason;
          if (normalized.decision === 'approve') {
            invocation.state = 'authorized';
            append('tool.authorized', {
              approvalId: approval.approvalId, invocationId: invocation.invocationId,
            });
          } else {
            const reason = boundedText(
              normalized.reason ?? 'The tool invocation was denied.', 2_000,
            );
            invocation.state = 'denied';
            invocation.terminal = {
              kind: 'denied', summary: reason, resultRefs: [], occurredAt,
            };
            append('tool.denied', {
              approvalId: approval.approvalId, invocationId: invocation.invocationId, reason,
            });
          }
          database.prepare(
            `UPDATE agent_approvals SET status = ?, payload_json = ?
             WHERE approval_id = ? AND status = 'pending'`,
          ).run(approval.status, JSON.stringify(approval), approval.approvalId);
          break;
        }
        case 'start': {
          if (normalized.recoveryOfFencingToken === undefined) {
            requireInvocationState(invocation, ['authorized']);
          } else {
            requireInvocationState(invocation, ['started']);
            const priorStart = invocation.started;
            if (
              priorStart === undefined ||
              priorStart.fencingToken !== normalized.recoveryOfFencingToken ||
              normalized.lease.fencingToken <= priorStart.fencingToken ||
              normalized.idempotencyKey !== priorStart.idempotencyKey ||
              normalized.attempt !== priorStart.attempt + 1
            ) {
              throw new AgentJournalError(
                'INVOCATION_STATE_CONFLICT',
                'Recovery start must atomically supersede the exact stale start fact.',
              );
            }
          }
          invocation.state = 'started';
          invocation.started = {
            idempotencyKey: normalized.idempotencyKey,
            fencingToken: normalized.lease.fencingToken,
            attempt: normalized.attempt,
            startedAt: occurredAt,
          };
          append('tool.started', {
            invocationId: invocation.invocationId,
            idempotencyKey: normalized.idempotencyKey,
            fencingToken: normalized.lease.fencingToken,
            attempt: normalized.attempt,
          });
          break;
        }
        case 'finish': {
          requireInvocationState(invocation, ['started']);
          if (invocation.started?.fencingToken !== normalized.lease.fencingToken) {
            if (
              normalized.outcome !== 'outcome_unknown' ||
              normalized.interruptedFencingToken !== invocation.started?.fencingToken
            ) {
              throw new AgentJournalError(
                'FENCING_TOKEN_STALE', 'Invocation was started under another fencing token.',
              );
            }
          }
          invocation.state = normalized.outcome;
          invocation.terminal = {
            kind: normalized.outcome,
            summary: boundedText(normalized.summary, 4_096),
            resultRefs: [...normalized.resultRefs],
            ...(normalized.durableSummary === undefined
              ? {}
              : { durableSummary: structuredClone(normalized.durableSummary) }),
            ...(normalized.modelProjection === undefined
              ? {}
              : { modelProjection: structuredClone(normalized.modelProjection) }),
            ...(normalized.userProjection === undefined
              ? {}
              : { userProjection: structuredClone(normalized.userProjection) }),
            ...(normalized.error === undefined ? {} : { error: structuredClone(normalized.error) }),
            occurredAt,
          };
          append(`tool.${normalized.outcome}`, {
            summary: invocation.terminal.summary,
            resultRefs: invocation.terminal.resultRefs,
            ...(invocation.terminal.durableSummary === undefined
              ? {}
              : { durableSummary: invocation.terminal.durableSummary }),
            ...(invocation.terminal.modelProjection === undefined
              ? {}
              : { modelProjection: invocation.terminal.modelProjection }),
            ...(invocation.terminal.userProjection === undefined
              ? {}
              : { userProjection: invocation.terminal.userProjection }),
            ...(invocation.terminal.error === undefined
              ? {}
              : { error: invocation.terminal.error }),
          });
          break;
        }
        case 'observe': {
          requireInvocationState(invocation, [
            'succeeded', 'failed', 'cancelled', 'outcome_unknown', 'denied',
          ]);
          if (normalized.observation.invocationId !== invocation.invocationId) {
            throw new AgentJournalError(
              'INVOCATION_STATE_CONFLICT', 'Observation is bound to another Invocation.',
            );
          }
          invocation.state = 'observed';
          invocation.observation = {
            ...structuredClone(normalized.observation), occurredAt,
          };
          append('tool.observed', normalized.observation);
          database.prepare(
            `INSERT INTO agent_observations (
              observation_id, project_id, run_id, invocation_id, payload_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(
            normalized.observation.observationId, invocation.projectId, invocation.runId,
            invocation.invocationId,
            JSON.stringify({
              ...normalized.observation,
              projectId: invocation.projectId, runId: invocation.runId, createdAt: occurredAt,
            }),
            occurredAt,
          );
          break;
        }
        case 'authorize-retry': {
          requireInvocationState(invocation, ['observed']);
          if (
            invocation.terminal?.kind !== 'outcome_unknown' ||
            invocation.toolRevision !== normalized.toolRevision ||
            invocation.effect !== normalized.effect ||
            invocation.normalizedArgumentsDigest !== normalized.normalizedArgumentsDigest
          ) {
            throw new AgentJournalError(
              'INVOCATION_STATE_CONFLICT',
              'Risky retry authorization does not match an unknown Invocation outcome.',
            );
          }
          if (invocation.retryPermit !== undefined &&
            invocation.retryPermit.permitId !== normalized.permitId) {
            throw new AgentJournalError(
              'IDEMPOTENCY_CONFLICT', 'Invocation already has another retry permit.',
            );
          }
          invocation.retryPermit = {
            permitId: normalized.permitId,
            toolRevision: normalized.toolRevision,
            effect: normalized.effect,
            normalizedArgumentsDigest: normalized.normalizedArgumentsDigest,
            reason: boundedText(normalized.reason, 2_000),
          };
          retryPermit = { invocationId: invocation.invocationId, ...invocation.retryPermit };
          append('tool.retry_authorized', {
            invocationId: invocation.invocationId,
            ...invocation.retryPermit,
          });
          break;
        }
        default:
          return assertNever(normalized);
      }

      const cas = database.prepare(
        `UPDATE agent_invocations
         SET state = ?, revision = ?, payload_json = ?, updated_at = ?
         WHERE invocation_id = ? AND revision = ?`,
      ).run(
        invocation.state, invocation.revision, JSON.stringify(invocation), occurredAt,
        invocation.invocationId, normalized.expectedInvocationRevision,
      );
      if (Number(cas.changes) !== 1) {
        throw new AgentJournalError(
          'REVISION_CONFLICT', 'Concurrent Invocation transition won the revision race.',
        );
      }
      if (normalized.action === 'observe' || normalized.action === 'resolve-outcome') {
        const evidenceEvent = events.find((event) =>
          event.type === 'tool.observed' || event.type === 'tool.outcome_resolved');
        if (evidenceEvent !== undefined) {
          advanceOnlineKernelEvidence(database, invocation.runId, evidenceEvent);
        }
      }
      projectToolRunState(
        database, invocation.runId, invocation.turnId, occurredAt, normalized.action,
      );
      const result: ToolInvocationCommitResult = {
        events,
        invocation: structuredClone(invocation),
        ...(approval === undefined ? {} : { approval: structuredClone(approval) }),
        ...(retryPermit === undefined ? {} : { retryPermit: structuredClone(retryPermit) }),
      };
      writeCommandResult(
        database, normalized.projectId, normalized.commandId,
        `tool.${normalized.action}`, requestDigest, result, occurredAt,
      );
      return result;
    }));
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

  async #commitKernelCommand(command: KernelJournalCommand): Promise<KernelJournalCommitResult> {
    const snapshot = snapshotKernelJournalCommand(command);
    await Promise.resolve();
    const normalized = validateKernelJournalCommand(snapshot);
    const requestDigest = digestValue(normalized);
    return this.#withDatabase((database) => transaction(database, () => {
      const replay = readCommandResult<KernelJournalCommitResult>(
        database, normalized.projectId, normalized.commandId, requestDigest,
      );
      if (replay !== undefined) return replay;
      this.#assertRun(
        database, normalized.projectId, normalized.sessionId, normalized.runId,
      );
      this.#assertLease(database, normalized.projectId, normalized.runId, normalized.lease);
      this.#assertRunRevision(
        database, normalized.projectId, normalized.runId, normalized.expectedRunRevision,
      );
      switch (normalized.action) {
        case 'prepare-turn':
          return this.#commitPrepareTurn(database, normalized, requestDigest);
        case 'start-model-attempt':
          return this.#commitStartModelAttempt(database, normalized, requestDigest);
        case 'discard-model-attempt':
          return this.#commitDiscardModelAttempt(database, normalized, requestDigest);
        case 'request-cancel':
          return this.#commitRequestCancel(database, normalized, requestDigest);
        case 'settle-cancellation':
          return this.#commitSettleCancellation(database, normalized, requestDigest);
        case 'record-no-progress':
          return this.#commitRecordNoProgress(database, normalized, requestDigest);
        case 'finalize-run':
          return this.#commitFinalizeRun(database, normalized, requestDigest);
        default:
          return assertNeverKernelCommand(normalized);
      }
    }));
  }

  #commitStartModelAttempt(
    database: NodeDatabaseSync,
    command: Extract<KernelJournalCommand, { action: 'start-model-attempt' }>,
    requestDigest: string,
  ): KernelJournalCommitResult {
    const current = readKernelRunProjection(database, command.runId);
    if (
      current.state !== 'CallingModel' || current.currentTurnId !== command.turnId ||
      current.currentAttemptId !== null
    ) {
      throw new AgentJournalError('COMMAND_CONFLICT', 'Run is not ready to start this model Attempt.');
    }
    const lifecycle = database.prepare(
      `SELECT revision, status FROM agent_turn_lifecycles WHERE turn_id = ?`,
    ).get(command.turnId) as { revision: number; status: string } | undefined;
    if (
      lifecycle === undefined || lifecycle.revision !== command.expectedTurnRevision ||
      lifecycle.status !== 'started'
    ) {
      throw new AgentJournalError('REVISION_CONFLICT', 'Turn revision does not match.');
    }
    const environmentRow = readEnvironmentBindingRow(database, command.runId);
    if (environmentRow === null) {
      throw new AgentJournalError('PROJECTION_CORRUPT', 'Run has no Environment Binding.');
    }
    const environment = environmentBindingFromRow(environmentRow);
    const routes = [environment.payload.modelRoute.primary, ...environment.payload.modelRoute.fallbacks];
    if (!routes.some((route) =>
      route.connectionId === command.origin.connectionId &&
      route.modelId === command.origin.model && route.protocol === command.origin.protocol)) {
      throw new AgentJournalError('COMMAND_CONFLICT', 'Attempt origin is outside the persisted Model Route.');
    }
    const occurredAt = this.#now();
    const event = this.#appendEvent(database, {
      projectId: command.projectId, sessionId: command.sessionId, runId: command.runId,
      turnId: command.turnId, attemptId: command.attemptId,
      type: 'model_attempt_started', payload: { origin: command.origin }, occurredAt,
    });
    this.#injectKernel('after-events-before-projection');
    persistKernelRunProjectionCas(
      database, current, projectKernelRunEvent(current, event),
      command.expectedRunRevision, 'Concurrent model Attempt start won the race.',
    );
    const result: KernelJournalCommitResult = {
      events: [event], run: readKernelRunProjection(database, command.runId),
    };
    writeCommandResult(
      database, command.projectId, command.commandId, 'kernel.start-model-attempt',
      requestDigest, result, occurredAt,
    );
    return result;
  }

  #commitDiscardModelAttempt(
    database: NodeDatabaseSync,
    command: Extract<KernelJournalCommand, { action: 'discard-model-attempt' }>,
    requestDigest: string,
  ): KernelJournalCommitResult {
    const current = readKernelRunProjection(database, command.runId);
    if (
      !['ReceivingModel', 'Cancelling'].includes(current.state) ||
      current.currentTurnId !== command.turnId ||
      current.currentAttemptId !== command.attemptId
    ) {
      throw new AgentJournalError('MODEL_COMMIT_CONFLICT', 'Discard does not match active Attempt.');
    }
    const lifecycle = database.prepare(
      'SELECT revision, status FROM agent_turn_lifecycles WHERE turn_id = ?',
    ).get(command.turnId) as { revision: number; status: string } | undefined;
    if (lifecycle?.revision !== command.expectedTurnRevision || lifecycle.status !== 'started') {
      throw new AgentJournalError('REVISION_CONFLICT', 'Turn revision does not match discard.');
    }
    const occurredAt = this.#now();
    const events: AgentEvent[] = [];
    if (command.failure !== undefined) {
      events.push(this.#appendEvent(database, {
        projectId: command.projectId, sessionId: command.sessionId, runId: command.runId,
        turnId: command.turnId, attemptId: command.attemptId,
        type: 'model_failed', payload: command.failure, occurredAt,
      }));
    }
    events.push(this.#appendEvent(database, {
      projectId: command.projectId, sessionId: command.sessionId, runId: command.runId,
      turnId: command.turnId, attemptId: command.attemptId,
      type: 'model_attempt_discarded', payload: { reason: command.reason }, occurredAt,
    }));
    this.#injectKernel('after-events-before-projection');
    persistKernelRunProjectionCas(
      database, current, projectKernelRunEvents(current, events),
      command.expectedRunRevision, 'Concurrent model Attempt discard won the race.',
    );
    const result: KernelJournalCommitResult = {
      events, run: readKernelRunProjection(database, command.runId),
    };
    writeCommandResult(
      database, command.projectId, command.commandId, 'kernel.discard-model-attempt',
      requestDigest, result, occurredAt,
    );
    return result;
  }

  #commitRequestCancel(
    database: NodeDatabaseSync,
    command: Extract<KernelJournalCommand, { action: 'request-cancel' }>,
    requestDigest: string,
  ): KernelJournalCommitResult {
    const current = readKernelRunProjection(database, command.runId);
    if (['Completed', 'Failed', 'Cancelled', 'Cancelling'].includes(current.state)) {
      throw new AgentJournalError(
        'COMMAND_CONFLICT', `Run cannot request cancellation from ${current.state}.`,
      );
    }
    const occurredAt = this.#now();
    const event = this.#appendEvent(database, {
      projectId: command.projectId, sessionId: command.sessionId, runId: command.runId,
      type: 'run.cancel_requested',
      payload: command.reason === undefined ? {} : { reason: command.reason }, occurredAt,
    });
    this.#injectKernel('after-events-before-projection');
    persistKernelRunProjectionCas(
      database, current, projectKernelRunEvent(current, event),
      command.expectedRunRevision, 'Concurrent cancellation request won the race.',
    );
    const result: KernelJournalCommitResult = {
      events: [event], run: readKernelRunProjection(database, command.runId),
    };
    writeCommandResult(
      database, command.projectId, command.commandId, 'kernel.request-cancel',
      requestDigest, result, occurredAt,
    );
    return result;
  }

  #commitSettleCancellation(
    database: NodeDatabaseSync,
    command: Extract<KernelJournalCommand, { action: 'settle-cancellation' }>,
    requestDigest: string,
  ): KernelJournalCommitResult {
    const current = readKernelRunProjection(database, command.runId);
    if (current.state !== 'Cancelling') {
      throw new AgentJournalError('COMMAND_CONFLICT', 'Only a Cancelling Run can settle cancellation.');
    }
    if (current.currentAttemptId !== null) {
      throw new AgentJournalError(
        'COMMAND_CONFLICT', 'Cancellation cannot settle while a model Attempt is active.',
      );
    }
    const unresolvedInvocations = database.prepare(
      `SELECT COUNT(*) AS count FROM agent_invocations
       WHERE project_id = ? AND run_id = ? AND state <> 'observed'`,
    ).get(command.projectId, command.runId) as { count: number };
    const pendingApprovals = database.prepare(
      `SELECT COUNT(*) AS count FROM agent_approvals
       WHERE project_id = ? AND run_id = ? AND status = 'pending'`,
    ).get(command.projectId, command.runId) as { count: number };
    if (Number(unresolvedInvocations.count) > 0 || Number(pendingApprovals.count) > 0) {
      throw new AgentJournalError(
        'COMMAND_CONFLICT', 'Cancellation cannot settle before all Tool protocol facts are observed.',
      );
    }
    const occurredAt = this.#now();
    const reason = readLatestCancellationReason(database, command.runId);
    const events: AgentEvent[] = [];
    let parentEventId: string | undefined;
    if (current.currentTurnId !== null) {
      const lifecycle = database.prepare(
        'SELECT revision, status FROM agent_turn_lifecycles WHERE turn_id = ?',
      ).get(current.currentTurnId) as { revision: number; status: string } | undefined;
      if (lifecycle === undefined || !['started', 'committed'].includes(lifecycle.status)) {
        throw new AgentJournalError(
          'PROJECTION_CORRUPT', 'Cancellation has an invalid open Turn lifecycle.',
        );
      }
      const close = this.#appendEvent(database, {
        projectId: command.projectId, sessionId: command.sessionId, runId: command.runId,
        turnId: current.currentTurnId, type: 'turn.closed', payload: { reason: 'cancelled' }, occurredAt,
      });
      events.push(close);
      parentEventId = close.eventId;
      const closed = database.prepare(
        `UPDATE agent_turn_lifecycles SET revision = revision + 1, status = 'closed'
         WHERE turn_id = ? AND revision = ? AND status = ?`,
      ).run(current.currentTurnId, lifecycle.revision, lifecycle.status);
      if (Number(closed.changes) !== 1) {
        throw new AgentJournalError('REVISION_CONFLICT', 'Open Turn changed while cancelling.');
      }
    }
    const cancelled = this.#appendEvent(database, {
      projectId: command.projectId, sessionId: command.sessionId, runId: command.runId,
      ...(current.currentTurnId === null ? {} : { turnId: current.currentTurnId }),
      ...(parentEventId === undefined ? {} : { parentEventId }),
      type: 'run.cancelled', payload: reason === undefined ? {} : { reason }, occurredAt,
    });
    events.push(cancelled);
    this.#injectKernel('after-events-before-projection');
    persistKernelRunProjectionCas(
      database, current, projectKernelRunEvents(current, events),
      command.expectedRunRevision, 'Concurrent cancellation settlement won the race.',
    );
    const result: KernelJournalCommitResult = {
      events, run: readKernelRunProjection(database, command.runId),
    };
    writeCommandResult(
      database, command.projectId, command.commandId, 'kernel.settle-cancellation',
      requestDigest, result, occurredAt,
    );
    return result;
  }

  #commitRecordNoProgress(
    database: NodeDatabaseSync,
    command: Extract<KernelJournalCommand, { action: 'record-no-progress' }>,
    requestDigest: string,
  ): KernelJournalCommitResult {
    const current = readKernelRunProjection(database, command.runId);
    if (current.state !== 'Preparing') {
      throw new AgentJournalError(
        'COMMAND_CONFLICT', 'No-progress evidence may be committed only at a Preparing boundary.',
      );
    }
    const occurredAt = this.#now();
    const event = this.#appendEvent(database, {
      projectId: command.projectId, sessionId: command.sessionId, runId: command.runId,
      ...(current.currentTurnId === null ? {} : { turnId: current.currentTurnId }),
      type: 'turn.no_progress', payload: { fingerprint: command.fingerprint }, occurredAt,
    });
    this.#injectKernel('after-events-before-projection');
    persistKernelRunProjectionCas(
      database, current, projectKernelRunEvent(current, event),
      command.expectedRunRevision, 'Concurrent no-progress commit won the race.',
    );
    const result: KernelJournalCommitResult = {
      events: [event], run: readKernelRunProjection(database, command.runId),
    };
    writeCommandResult(
      database, command.projectId, command.commandId, 'kernel.record-no-progress',
      requestDigest, result, occurredAt,
    );
    return result;
  }

  #commitPrepareTurn(
    database: NodeDatabaseSync,
    command: Extract<KernelJournalCommand, { action: 'prepare-turn' }>,
    requestDigest: string,
  ): KernelJournalCommitResult {
    const current = readKernelRunProjection(database, command.runId);
    const runRow = database.prepare(
      `SELECT state FROM agent_runs
       WHERE project_id = ? AND session_id = ? AND run_id = ?`,
    ).get(command.projectId, command.sessionId, command.runId) as { state: string };
    const allowed = command.resume
      ? ['AwaitingUser', 'Interrupted', 'LimitReached', 'Preparing']
      : ['created', 'Preparing'];
    if (!allowed.includes(runRow.state)) {
      throw new AgentJournalError(
        'COMMAND_CONFLICT', `Run cannot prepare a Turn from ${runRow.state}.`,
      );
    }
    const occurredAt = this.#now();
    const environmentDigest = digestValue(command.environment);
    const existingEnvironment = readEnvironmentBindingRow(database, command.runId);
    let environment: PersistedEnvironmentBinding;
    const events: AgentEvent[] = [];
    if (existingEnvironment === null) {
      environment = freezeEnvironmentBinding({
        schemaVersion: 1,
        environmentBindingId: command.environment.environmentBindingId,
        projectId: command.projectId,
        sessionId: command.sessionId,
        runId: command.runId,
        digest: environmentDigest,
        payload: command.environment,
        createdAt: occurredAt,
      });
      database.prepare(
        `INSERT INTO agent_environment_bindings (
          environment_binding_id, project_id, session_id, run_id, schema_version,
          digest, payload_json, created_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
      ).run(
        environment.environmentBindingId, command.projectId, command.sessionId,
        command.runId, environment.digest, JSON.stringify(environment.payload), occurredAt,
      );
      events.push(this.#appendEvent(database, {
        projectId: command.projectId, sessionId: command.sessionId, runId: command.runId,
        type: 'run.environment_bound',
        payload: {
          environmentBindingId: environment.environmentBindingId,
          digest: environment.digest,
          binding: command.environment,
        },
        occurredAt,
      }));
    } else {
      environment = environmentBindingFromRow(existingEnvironment);
      if (
        environment.environmentBindingId !== command.environment.environmentBindingId ||
        environment.digest !== environmentDigest
      ) {
        throw new AgentJournalError(
          'COMMAND_CONFLICT', 'A Run Environment Binding is immutable after its first Turn.',
        );
      }
    }
    const snapshotDigest = digestValue({
      payload: command.snapshot,
      turnId: command.turnId,
      environmentBindingId: environment.environmentBindingId,
    });
    if (database.prepare('SELECT 1 AS present FROM agent_snapshots WHERE snapshot_id = ?')
      .get(command.snapshot.turnSnapshotId) !== undefined) {
      throw new AgentJournalError('COMMAND_CONFLICT', 'Turn Snapshot identity already exists.');
    }
    const persistedSnapshot = freezeTurnSnapshot({
      schemaVersion: 1,
      turnSnapshotId: command.snapshot.turnSnapshotId,
      projectId: command.projectId,
      sessionId: command.sessionId,
      runId: command.runId,
      turnId: command.turnId,
      environmentBindingId: environment.environmentBindingId,
      digest: snapshotDigest,
      payload: command.snapshot,
      createdAt: occurredAt,
    });
    database.prepare(
      `INSERT INTO agent_snapshots (
        snapshot_id, project_id, session_id, run_id, turn_id, environment_binding_id,
        schema_version, snapshot_type, revision, digest, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 'turn', ?, ?, ?, ?)`,
    ).run(
      persistedSnapshot.turnSnapshotId, command.projectId, command.sessionId, command.runId,
      command.turnId, environment.environmentBindingId, command.snapshot.capability.revision,
      snapshotDigest, JSON.stringify(command.snapshot), occurredAt,
    );
    const runEvent = this.#appendEvent(database, {
      projectId: command.projectId, sessionId: command.sessionId, runId: command.runId,
      type: command.resume ? 'run.resumed' : 'run.started',
      payload: command.resume ? { reason: 'turn-prepare' } : {}, occurredAt,
    });
    events.push(runEvent);
    events.push(this.#appendEvent(database, {
      projectId: command.projectId, sessionId: command.sessionId, runId: command.runId,
      turnId: command.turnId,
      type: 'capability.snapshot_captured',
      payload: {
        snapshotId: command.snapshot.capability.snapshotId,
        revision: command.snapshot.capability.revision,
      }, occurredAt,
    }));
    events.push(this.#appendEvent(database, {
      projectId: command.projectId, sessionId: command.sessionId, runId: command.runId,
      turnId: command.turnId,
      type: 'turn.started',
      payload: {
        turnSnapshotId: persistedSnapshot.turnSnapshotId,
        environmentBindingId: environment.environmentBindingId,
        digest: persistedSnapshot.digest,
        snapshot: command.snapshot,
      },
      occurredAt,
    }));
    this.#injectKernel('after-events-before-projection');
    database.prepare(
      `INSERT INTO agent_turn_lifecycles (
        project_id, session_id, run_id, turn_id, revision, status, started_at
      ) VALUES (?, ?, ?, ?, 1, 'started', ?)`,
    ).run(command.projectId, command.sessionId, command.runId, command.turnId, occurredAt);
    persistKernelRunProjectionCas(
      database, current, projectKernelRunEvents(current, events),
      command.expectedRunRevision, 'Concurrent Run preparation won the race.',
    );
    const run = readKernelRunProjection(database, command.runId);
    const result: KernelJournalCommitResult = {
      events, run, environment, snapshot: persistedSnapshot,
    };
    writeCommandResult(
      database, command.projectId, command.commandId, 'kernel.prepare-turn',
      requestDigest, result, occurredAt,
    );
    return result;
  }

  #commitFinalizeRun(
    database: NodeDatabaseSync,
    command: Extract<KernelJournalCommand, { action: 'finalize-run' }>,
    requestDigest: string,
  ): KernelJournalCommitResult {
    const lifecycle = database.prepare(
      `SELECT revision, status FROM agent_turn_lifecycles
       WHERE project_id = ? AND session_id = ? AND run_id = ? AND turn_id = ?`,
    ).get(command.projectId, command.sessionId, command.runId, command.turnId) as
      { revision: number; status: string } | undefined;
    if (lifecycle === undefined) throw new AgentJournalError('TURN_NOT_FOUND', 'Turn not found.');
    if (lifecycle.revision !== command.expectedTurnRevision || lifecycle.status !== 'committed') {
      throw new AgentJournalError('REVISION_CONFLICT', 'Final Turn revision does not match.');
    }
    const current = readKernelRunProjection(database, command.runId);
    if (current.state !== 'Finalizing' || current.currentTurnId !== command.turnId) {
      throw new AgentJournalError('COMMAND_CONFLICT', 'Run is not ready for final delivery.');
    }
    if (current.currentAttemptId !== null) {
      throw new AgentJournalError(
        'COMMAND_CONFLICT', 'Run cannot finalize while a model Attempt remains active.',
      );
    }
    const unresolvedInvocations = database.prepare(
      `SELECT COUNT(*) AS count FROM agent_invocations
       WHERE project_id = ? AND run_id = ? AND state <> 'observed'`,
    ).get(command.projectId, command.runId) as { count: number };
    const pendingApprovals = database.prepare(
      `SELECT COUNT(*) AS count FROM agent_approvals
       WHERE project_id = ? AND run_id = ? AND status = 'pending'`,
    ).get(command.projectId, command.runId) as { count: number };
    if (Number(unresolvedInvocations.count) > 0 || Number(pendingApprovals.count) > 0) {
      throw new AgentJournalError(
        'COMMAND_CONFLICT', 'Run cannot finalize with unresolved Tool or approval protocol facts.',
      );
    }
    if (command.decision.evidenceRevision !== current.evidenceRevision) {
      throw new AgentJournalError(
        'COMMAND_CONFLICT', 'Delivery decision does not match the current Evidence Revision.',
      );
    }
    const occurredAt = this.#now();
    const delivery = this.#appendEvent(database, {
      projectId: command.projectId, sessionId: command.sessionId, runId: command.runId,
      turnId: command.turnId, type: 'delivery.decided',
      payload: { ...command.decision, evidenceRefs: [...command.decision.evidenceRefs] }, occurredAt,
    });
    const close = this.#appendEvent(database, {
      projectId: command.projectId, sessionId: command.sessionId, runId: command.runId,
      turnId: command.turnId, parentEventId: delivery.eventId,
      type: 'turn.closed', payload: { reason: command.decision.outcome }, occurredAt,
    });
    const terminalType = command.decision.outcome === 'accepted' ? 'run.completed' : 'run.failed';
    const terminal = this.#appendEvent(database, {
      projectId: command.projectId, sessionId: command.sessionId, runId: command.runId,
      turnId: command.turnId, parentEventId: close.eventId,
      type: terminalType,
      payload: terminalType === 'run.completed' ? {
        finalContentRef: command.finalContentRef,
        deliveryStatus: command.decision.status,
        evidenceRefs: [...command.decision.evidenceRefs],
      } : { code: 'DELIVERY_UNVERIFIED', detail: command.decision.reason ?? null },
      occurredAt,
    });
    this.#injectKernel('after-events-before-projection');
    database.prepare(
      `UPDATE agent_turn_lifecycles SET revision = revision + 1, status = 'closed'
       WHERE turn_id = ? AND revision = ? AND status = 'committed'`,
    ).run(command.turnId, command.expectedTurnRevision);
    persistKernelRunProjectionCas(
      database, current, projectKernelRunEvents(current, [delivery, close, terminal]),
      command.expectedRunRevision, 'Concurrent Run finalization won the race.',
    );
    const result: KernelJournalCommitResult = {
      events: [delivery, close, terminal], run: readKernelRunProjection(database, command.runId),
    };
    writeCommandResult(
      database, command.projectId, command.commandId, 'kernel.finalize-run',
      requestDigest, result, occurredAt,
    );
    return result;
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

  async readRunEvents(input: Readonly<{
    projectId: string; sessionId: string; runId: string; afterSequence: number; limit: number;
  }>): Promise<Readonly<{ events: readonly AgentEvent[]; nextSequence: number | null }>> {
    await Promise.resolve();
    const projectId = requireText(input.projectId, 'projectId');
    const sessionId = requireText(input.sessionId, 'sessionId');
    const runId = requireText(input.runId, 'runId');
    if (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0) {
      throw new AgentJournalError('INVALID_ARGUMENT', 'afterSequence must be non-negative.');
    }
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
      throw new AgentJournalError('INVALID_ARGUMENT', 'Run event limit must be between 1 and 1000.');
    }
    return this.#withDatabase((database) => {
      this.#assertRun(database, projectId, sessionId, runId);
      const rows = database.prepare(
        `SELECT * FROM agent_events
         WHERE project_id = ? AND session_id = ? AND run_id = ? AND sequence > ?
         ORDER BY sequence ASC LIMIT ?`,
      ).all(projectId, sessionId, runId, input.afterSequence, input.limit) as unknown as EventRow[];
      const events = rows.map((row) => {
        assertStoredParentCausality(database, row);
        return eventFromRow(row);
      });
      return Object.freeze({
        events: Object.freeze(events),
        nextSequence: events.at(-1)?.sequence ?? null,
      });
    });
  }

  async getKernelRunProjection(input: Readonly<{
    projectId: string; sessionId: string; runId: string;
  }>): Promise<KernelRunProjection | null> {
    await Promise.resolve();
    const projectId = requireText(input.projectId, 'projectId');
    const sessionId = requireText(input.sessionId, 'sessionId');
    const runId = requireText(input.runId, 'runId');
    return this.#withDatabase((database) => {
      this.#assertRun(database, projectId, sessionId, runId);
      return readKernelRunProjection(database, runId);
    });
  }

  async getEnvironmentBinding(input: Readonly<{
    projectId: string; sessionId: string; runId: string;
  }>): Promise<PersistedEnvironmentBinding | null> {
    await Promise.resolve();
    const projectId = requireText(input.projectId, 'projectId');
    const sessionId = requireText(input.sessionId, 'sessionId');
    const runId = requireText(input.runId, 'runId');
    return this.#withDatabase((database) => {
      this.#assertRun(database, projectId, sessionId, runId);
      const row = readEnvironmentBindingRow(database, runId);
      return row === null ? null : environmentBindingFromRow(row);
    });
  }

  async getTurnSnapshot(input: Readonly<{
    projectId: string; sessionId: string; runId: string; turnId: string;
  }>): Promise<PersistedTurnSnapshot | null> {
    await Promise.resolve();
    const projectId = requireText(input.projectId, 'projectId');
    const sessionId = requireText(input.sessionId, 'sessionId');
    const runId = requireText(input.runId, 'runId');
    const turnId = requireText(input.turnId, 'turnId');
    return this.#withDatabase((database) => {
      this.#assertRun(database, projectId, sessionId, runId);
      const row = database.prepare(
        `SELECT snapshot_id, project_id, session_id, run_id, turn_id,
          environment_binding_id, schema_version, digest, payload_json, created_at
         FROM agent_snapshots
         WHERE project_id = ? AND session_id = ? AND run_id = ? AND turn_id = ?`,
      ).get(projectId, sessionId, runId, turnId) as KernelSnapshotRow | undefined;
      if (row === undefined) return null;
      return turnSnapshotFromRow(row);
    });
  }

  async getSessionModelBinding(
    projectId: string,
    sessionId: string,
  ): Promise<SessionModelBinding | null> {
    await Promise.resolve();
    requireText(projectId, 'projectId');
    requireText(sessionId, 'sessionId');
    return this.#withDatabase((database) => {
      const row = database.prepare(
        `SELECT payload_json FROM agent_session_model_bindings
         WHERE project_id = ? AND session_id = ?`,
      ).get(projectId, sessionId) as { payload_json: string } | undefined;
      if (row === undefined) return null;
      const binding = parsePortableJson(row.payload_json) as unknown as SessionModelBinding;
      return deepFreezeKernelValue(binding);
    });
  }

  async readSessionEvents(input: Readonly<{
    projectId: string; sessionId: string; afterSequence: number; limit: number;
  }>): Promise<Readonly<{
    events: readonly Readonly<{
      sequence: number; eventId: string; type: 'session.model_bound';
      binding: SessionModelBinding; occurredAt: string;
    }>[];
    nextSequence: number | null;
  }>> {
    await Promise.resolve();
    requireText(input.projectId, 'projectId');
    requireText(input.sessionId, 'sessionId');
    if (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0 ||
      !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
      throw new AgentJournalError('INVALID_ARGUMENT', 'Session event cursor or limit is invalid.');
    }
    return this.#withDatabase((database) => {
      const rows = database.prepare(
        `SELECT sequence, event_id, event_type, payload_json, occurred_at
         FROM agent_session_events
         WHERE project_id = ? AND session_id = ? AND sequence > ?
         ORDER BY sequence ASC LIMIT ?`,
      ).all(input.projectId, input.sessionId, input.afterSequence, input.limit) as unknown as Array<{
        sequence: number; event_id: string; event_type: string;
        payload_json: string; occurred_at: string;
      }>;
      const events = rows.map((row) => deepFreezeKernelValue({
        sequence: row.sequence, eventId: row.event_id, type: 'session.model_bound' as const,
        binding: parsePortableJson(row.payload_json) as unknown as SessionModelBinding,
        occurredAt: row.occurred_at,
      }));
      return deepFreezeKernelValue({
        events, nextSequence: events.at(-1)?.sequence ?? null,
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
      const kernelReplay = replayKernelJournalFacts(events, replay.invocations);
      database.prepare('DELETE FROM agent_observations WHERE project_id = ?').run(projectId);
      database.prepare('DELETE FROM agent_approvals WHERE project_id = ?').run(projectId);
      database.prepare('DELETE FROM agent_invocations WHERE project_id = ?').run(projectId);
      database.prepare('DELETE FROM agent_protocol_envelopes WHERE project_id = ?').run(projectId);
      database.prepare('DELETE FROM agent_turns WHERE project_id = ?').run(projectId);
      database.prepare('DELETE FROM agent_attempts WHERE project_id = ?').run(projectId);
      database.prepare('DELETE FROM agent_turn_lifecycles WHERE project_id = ?').run(projectId);
      database.prepare('DELETE FROM agent_kernel_runs WHERE project_id = ?').run(projectId);
      database.prepare('DELETE FROM agent_snapshots WHERE project_id = ?').run(projectId);
      database.prepare('DELETE FROM agent_environment_bindings WHERE project_id = ?').run(projectId);
      database.prepare('DELETE FROM agent_run_leases WHERE project_id = ?').run(projectId);
      database.prepare('DELETE FROM agent_runs WHERE project_id = ?').run(projectId);

      for (const run of replay.runs) {
        const kernel = kernelReplay.runs.get(run.runId);
        database.prepare(
          `INSERT INTO agent_runs (
            run_id, project_id, session_id, client_request_id, state, revision,
            input_json, created_at, updated_at, hidden
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          run.runId, run.projectId, run.sessionId, run.clientRequestId,
          kernel?.state ?? run.state, kernel?.revision ?? run.revision,
          JSON.stringify(run.input ?? null), run.createdAt, kernel?.updatedAt ?? run.updatedAt,
          run.visibility === 'legacy-import-carrier' ? 1 : 0,
        );
      }
      for (const environment of kernelReplay.environments.values()) {
        database.prepare(
          `INSERT INTO agent_environment_bindings (
            environment_binding_id, project_id, session_id, run_id, schema_version,
            digest, payload_json, created_at
          ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
        ).run(
          environment.environmentBindingId, environment.projectId, environment.sessionId,
          environment.runId, environment.digest, JSON.stringify(environment.payload),
          environment.createdAt,
        );
      }
      for (const snapshot of kernelReplay.snapshots.values()) {
        database.prepare(
          `INSERT INTO agent_snapshots (
            snapshot_id, project_id, session_id, run_id, turn_id, environment_binding_id,
            schema_version, snapshot_type, revision, digest, payload_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 1, 'turn', ?, ?, ?, ?)`,
        ).run(
          snapshot.turnSnapshotId, snapshot.projectId, snapshot.sessionId, snapshot.runId,
          snapshot.turnId, snapshot.environmentBindingId, snapshot.payload.capability.revision,
          snapshot.digest, JSON.stringify(snapshot.payload), snapshot.createdAt,
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
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(invocation.invocationId, invocation.projectId, invocation.sessionId,
          invocation.runId, invocation.turnId, invocation.attemptId, invocation.callId,
          invocation.actionOrdinal, invocation.name, JSON.stringify(invocation.arguments),
          invocation.state, invocation.revision, JSON.stringify(invocation),
          invocation.createdAt, invocation.updatedAt);
      }
      for (const approval of replay.approvals) {
        const invocation = replay.invocations.find(
          (candidate) => candidate.invocationId === approval.invocationId,
        );
        if (invocation === undefined) {
          throw new AgentJournalError('PROJECTION_CORRUPT', 'Approval Invocation is missing.');
        }
        database.prepare(
          `INSERT INTO agent_approvals (
            approval_id, project_id, run_id, invocation_id, tool_revision,
            arguments_digest, effect, status, payload_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          approval.approvalId, approval.projectId, approval.runId, approval.invocationId,
          approval.toolRevision, approval.normalizedArgumentsDigest, approval.effect,
          approval.status, JSON.stringify(approval), invocation.updatedAt,
        );
      }
      for (const observation of replay.observations) {
        database.prepare(
          `INSERT INTO agent_observations (
            observation_id, project_id, run_id, invocation_id, payload_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          observation.observationId, observation.projectId, observation.runId,
          observation.invocationId, JSON.stringify(observation), observation.createdAt,
        );
      }
      for (const run of kernelReplay.runs.values()) {
        database.prepare(
          `INSERT INTO agent_kernel_runs (
            run_id, project_id, session_id, environment_binding_id, current_turn_id,
            turn_snapshot_id, current_attempt_id, wait_reason, evidence_revision,
            evidence_digest, no_progress_count, final_content_ref, delivery_status, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          run.runId, run.projectId, run.sessionId, run.environmentBindingId,
          run.currentTurnId, run.turnSnapshotId, run.currentAttemptId, run.waitReason,
          run.evidenceRevision, run.evidenceDigest, run.noProgressCount,
          run.finalContentRef, run.deliveryStatus, run.updatedAt,
        );
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

  async getRunLease(projectIdInput: string, runIdInput: string): Promise<RunLease | null> {
    await Promise.resolve();
    const projectId = requireText(projectIdInput, 'projectId');
    const runId = requireText(runIdInput, 'runId');
    return this.#withDatabase((database) => {
      this.#assertRun(database, projectId, undefined, runId);
      const row = database.prepare(
        `SELECT owner_id, expires_at_ms, fencing_token
         FROM agent_run_leases WHERE project_id = ? AND run_id = ?`,
      ).get(projectId, runId) as LeaseRow | undefined;
      return row === undefined ? null : leaseResult(projectId, runId, row);
    });
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

  async listTurnInvocations(
    input: ListTurnInvocationsInput,
  ): Promise<AgentInvocationProjection[]> {
    const snapshot = snapshotListTurnInvocationsInput(input);
    await Promise.resolve();
    const projectId = requireText(snapshot.projectId, 'projectId');
    const sessionId = requireText(snapshot.sessionId, 'sessionId');
    const runId = requireText(snapshot.runId, 'runId');
    const turnId = requireText(snapshot.turnId, 'turnId');
    const afterActionOrdinal = snapshot.afterActionOrdinal ?? -1;
    if (!Number.isSafeInteger(afterActionOrdinal) || afterActionOrdinal < -1) {
      throw new AgentJournalError(
        'INVALID_ARGUMENT',
        'afterActionOrdinal must be a safe integer greater than or equal to -1.',
      );
    }
    if (!Number.isSafeInteger(snapshot.limit) || snapshot.limit < 1 || snapshot.limit > 1_000) {
      throw new AgentJournalError('INVALID_ARGUMENT', 'Invocation page limit must be 1..1000.');
    }
    return this.#withDatabase((database) => {
      this.#assertRun(database, projectId, sessionId, runId);
      const rows = database.prepare(
        `SELECT invocation_id FROM agent_invocations
         WHERE project_id = ? AND session_id = ? AND run_id = ? AND turn_id = ?
           AND action_ordinal > ?
         ORDER BY action_ordinal ASC LIMIT ?`,
      ).all(
        projectId, sessionId, runId, turnId, afterActionOrdinal, snapshot.limit,
      ) as unknown as Array<{ invocation_id: string }>;
      return rows.map(({ invocation_id }) => {
        const invocation = readInvocationProjection(database, invocation_id);
        if (invocation === null) {
          throw new AgentJournalError(
            'PROJECTION_CORRUPT',
            `Invocation projection is missing: ${invocation_id}.`,
          );
        }
        return invocation;
      });
    });
  }

  async getInvocation(invocationIdInput: string): Promise<AgentInvocationProjection | null> {
    await Promise.resolve();
    const invocationId = requireText(invocationIdInput, 'invocationId');
    return this.#withDatabase((database) => readInvocationProjection(database, invocationId));
  }

  /** @deprecated Legacy projection query; unified Runtime uses scoped getApproval(). */
  async getApprovalForInvocation(invocationIdInput: string): Promise<ToolApprovalFact | null> {
    await Promise.resolve();
    const invocationId = requireText(invocationIdInput, 'invocationId');
    return this.#withDatabase((database) => {
      const row = database.prepare(
        `SELECT approval_id FROM agent_approvals
         WHERE invocation_id = ? ORDER BY created_at DESC LIMIT 1`,
      ).get(invocationId) as { approval_id: string } | undefined;
      return row === undefined ? null : readApprovalProjection(database, row.approval_id);
    });
  }

  async getApproval(input: GetToolApprovalInput): Promise<ToolApprovalFact | null> {
    const snapshot = snapshotGetToolApprovalInput(input);
    await Promise.resolve();
    const projectId = requireText(snapshot.projectId, 'projectId');
    const sessionId = requireText(snapshot.sessionId, 'sessionId');
    const runId = requireText(snapshot.runId, 'runId');
    const invocationId = requireText(snapshot.invocationId, 'invocationId');
    return this.#withDatabase((database) => {
      this.#assertRun(database, projectId, sessionId, runId);
      const row = database.prepare(
        `SELECT approval_id FROM agent_approvals
         WHERE project_id = ? AND run_id = ? AND invocation_id = ?
         ORDER BY approval_id DESC LIMIT 1`,
      ).get(projectId, runId, invocationId) as { approval_id: string } | undefined;
      return row === undefined ? null : readApprovalProjection(database, row.approval_id);
    });
  }

  async listApprovals(input: ListToolApprovalsInput): Promise<ToolApprovalPage> {
    const snapshot = snapshotListToolApprovalsInput(input);
    await Promise.resolve();
    const projectId = requireText(snapshot.projectId, 'projectId');
    const sessionId = requireText(snapshot.sessionId, 'sessionId');
    const runId = requireText(snapshot.runId, 'runId');
    const cursor = snapshot.cursor === undefined
      ? { createdAt: '', approvalId: '' }
      : decodeApprovalCursor(requireText(snapshot.cursor, 'cursor'));
    if (!Number.isSafeInteger(snapshot.limit) || snapshot.limit < 1 || snapshot.limit > 1_000) {
      throw new AgentJournalError('INVALID_ARGUMENT', 'Approval page limit must be 1..1000.');
    }
    if (
      snapshot.status !== undefined &&
      !['pending', 'approved', 'denied'].includes(snapshot.status)
    ) {
      throw new AgentJournalError('INVALID_ARGUMENT', 'Approval status filter is invalid.');
    }
    return this.#withDatabase((database) => {
      this.#assertRun(database, projectId, sessionId, runId);
      const rows = (snapshot.status === undefined
        ? database.prepare(
          `SELECT approval_id, created_at FROM agent_approvals
           WHERE project_id = ? AND run_id = ?
             AND (created_at > ? OR (created_at = ? AND approval_id > ?))
           ORDER BY created_at ASC, approval_id ASC LIMIT ?`,
        ).all(
          projectId, runId, cursor.createdAt, cursor.createdAt,
          cursor.approvalId, snapshot.limit + 1,
        )
        : database.prepare(
          `SELECT approval_id, created_at FROM agent_approvals
           WHERE project_id = ? AND run_id = ? AND status = ?
             AND (created_at > ? OR (created_at = ? AND approval_id > ?))
           ORDER BY created_at ASC, approval_id ASC LIMIT ?`,
        ).all(
          projectId, runId, snapshot.status, cursor.createdAt, cursor.createdAt,
          cursor.approvalId, snapshot.limit + 1,
        )) as unknown as Array<{ approval_id: string; created_at: string }>;
      const hasMore = rows.length > snapshot.limit;
      const pageRows = rows.slice(0, snapshot.limit);
      const items = pageRows.map(({ approval_id }) => {
        const approval = readApprovalProjection(database, approval_id);
        if (approval === null) {
          throw new AgentJournalError(
            'PROJECTION_CORRUPT',
            `Approval projection is missing: ${approval_id}.`,
          );
        }
        return approval;
      });
      const last = pageRows.at(-1);
      const nextCursor = hasMore && last !== undefined
        ? encodeApprovalCursor(last.created_at, last.approval_id)
        : undefined;
      return {
        items,
        hasMore,
        ...(nextCursor === undefined ? {} : { nextCursor }),
      };
    });
  }

  async listObservations(runIdInput: string): Promise<AgentObservationProjection[]> {
    await Promise.resolve();
    const runId = requireText(runIdInput, 'runId');
    return this.#withDatabase((database) => {
      const rows = database.prepare(
        `SELECT payload_json FROM agent_observations
         WHERE run_id = ? ORDER BY created_at ASC, observation_id ASC`,
      ).all(runId) as unknown as Array<{ payload_json: string }>;
      return rows.map(({ payload_json }) => {
        const value = parseProjectionJson(
          payload_json,
          'Agent Observation',
          (candidate): asserts candidate is AgentObservationProjection => {
            assertObservationProjection(candidate);
          },
        );
        return value;
      });
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
    const normalized = snapshotValidatedAttemptCommand(command);
    await Promise.resolve();
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
        const kernelRun = database.prepare(
          'SELECT current_turn_id, current_attempt_id, turn_snapshot_id FROM agent_kernel_runs WHERE run_id = ?',
        ).get(runId) as {
          current_turn_id: string | null; current_attempt_id: string | null;
          turn_snapshot_id: string | null;
        } | undefined;
        let kernelCurrent: KernelRunProjection | null = null;
        if (kernelRun !== undefined) {
          const current = readKernelRunProjection(database, runId);
          kernelCurrent = current;
          if (
            current.state !== 'ReceivingModel' || current.currentTurnId !== turnId ||
            current.currentAttemptId !== attempt.attemptId
          ) {
            throw new AgentJournalError(
              'MODEL_COMMIT_CONFLICT', 'Validated Attempt is not the exact active Run Attempt.',
            );
          }
          const snapshotRow = database.prepare(
            `SELECT snapshot_id, project_id, session_id, run_id, turn_id,
              environment_binding_id, schema_version, digest, payload_json, created_at
             FROM agent_snapshots WHERE snapshot_id = ? AND turn_id = ?`,
          ).get(kernelRun.turn_snapshot_id, turnId) as KernelSnapshotRow | undefined;
          if (snapshotRow === undefined) {
            throw new AgentJournalError('PROJECTION_CORRUPT', 'Active Turn Snapshot is missing.');
          }
          const turnSnapshot = turnSnapshotFromRow(snapshotRow);
          const environmentRow = readEnvironmentBindingRow(database, runId);
          if (
            environmentRow === null ||
            turnSnapshot.environmentBindingId !== environmentRow.environment_binding_id
          ) {
            throw new AgentJournalError(
              'PROJECTION_CORRUPT', 'Turn Snapshot and Environment Binding disagree.',
            );
          }
          const environment = environmentBindingFromRow(environmentRow);
          const routes = [
            environment.payload.modelRoute.primary, ...environment.payload.modelRoute.fallbacks,
          ];
          if (!routes.some((route) =>
            route.connectionId === attempt.origin.connectionId &&
            route.modelId === attempt.origin.model && route.protocol === attempt.origin.protocol)) {
            throw new AgentJournalError(
              'MODEL_COMMIT_CONFLICT', 'Attempt origin disagrees with the immutable Model Route.',
            );
          }
        }
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
        updatedAt: occurredAt,
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
        if (kernelCurrent === null) {
          const runCas = database.prepare(
            `UPDATE agent_runs SET revision = revision + 1, updated_at = ?
             WHERE project_id = ? AND session_id = ? AND run_id = ? AND revision = ?`,
          ).run(occurredAt, projectId, sessionId, runId, expectedRunRevision);
          if (Number(runCas.changes) !== 1) {
            throw new AgentJournalError(
              'REVISION_CONFLICT', 'Concurrent Run commit won the revision race.',
            );
          }
          projectToolRunState(database, runId, turnId, occurredAt, 'model-commit');
        } else {
          persistKernelRunProjectionCas(
            database, kernelCurrent, projectKernelRunEvent(kernelCurrent, modelEvent),
            expectedRunRevision, 'Concurrent Run commit won the revision race.',
          );
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

  #injectKernel(point: KernelCommitFaultPoint): void {
    if (this.#kernelFaultPoint !== point) return;
    this.#kernelFaultPoint = undefined;
    throw new Error(`INJECTED_KERNEL_FAILURE:${point}`);
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
    let database: NodeDatabaseSync | undefined;
    try {
      database = new DatabaseSync(this.filePath);
      initializeDatabaseWithBusyRetry(database, this.busyTimeoutMs);
      return operation(database);
    } catch (error) {
      if (isSqliteBusy(error)) {
        throw new AgentJournalError(
          'JOURNAL_BUSY',
          `Agent Journal remained busy for ${this.busyTimeoutMs}ms.`,
        );
      }
      throw error;
    } finally {
      database?.close();
    }
  }
}

function initializeDatabaseWithBusyRetry(
  database: NodeDatabaseSync,
  busyTimeoutMs: number,
): void {
  const deadline = Date.now() + busyTimeoutMs;
  while (true) {
    try {
      initializeDatabase(database, Math.max(1, deadline - Date.now()));
      return;
    } catch (error) {
      if (!isSqliteBusy(error) || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(8, deadline - Date.now()));
    }
  }
}

function isSqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = 'code' in error ? String((error as { code?: unknown }).code) : '';
  return /SQLITE_(?:BUSY|LOCKED)/iu.test(code) ||
    /database(?: table)? is (?:locked|busy)|SQLITE_(?:BUSY|LOCKED)/iu.test(error.message);
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

function snapshotToolInvocationCommand(
  command: ToolInvocationJournalCommand,
): ToolInvocationJournalCommand {
  const allActionKeys = [...new Set(Object.values(TOOL_INVOCATION_ACTION_KEYS).flat())];
  const captured = snapshotDataRecord(
    command,
    TOOL_INVOCATION_COMMON_KEYS,
    allActionKeys,
    'Tool Invocation command',
  );
  const action = captured.action;
  if (
    typeof action !== 'string' ||
    !Object.hasOwn(TOOL_INVOCATION_ACTION_KEYS, action)
  ) {
    throw new AgentJournalError('INVALID_ARGUMENT', 'Tool Invocation action is invalid.');
  }
  const typedAction = action as ToolInvocationJournalCommand['action'];
  const optionalActionKeys = TOOL_INVOCATION_OPTIONAL_ACTION_KEYS[typedAction];
  const requiredActionKeys = TOOL_INVOCATION_ACTION_KEYS[typedAction]
    .filter((key) => !optionalActionKeys.includes(key));
  const exact = snapshotDataRecord(
    captured,
    [...TOOL_INVOCATION_COMMON_KEYS, ...requiredActionKeys],
    optionalActionKeys,
    'Tool Invocation command',
  );
  const output = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(exact)) {
    let snapshotted = value;
    if (key === 'lease') {
      snapshotted = snapshotRunLeaseReference(value, 'Tool Invocation command lease');
    } else if (key === 'resultRefs') {
      snapshotted = snapshotDataArray(value, 'Tool Invocation command resultRefs',
        (item, label) => snapshotPortableData(item, label));
    } else if (
      key === 'canonicalToolId' || key === 'error' || key === 'observation' ||
      key === 'durableSummary' || key === 'modelProjection' || key === 'userProjection'
    ) {
      snapshotted = snapshotPortableData(value, `Tool Invocation command ${key}`);
    }
    Object.defineProperty(output, key, {
      value: snapshotted,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(output) as ToolInvocationJournalCommand;
}

function snapshotGetToolApprovalInput(input: GetToolApprovalInput): GetToolApprovalInput {
  const record = snapshotDataRecord(input, [
    'projectId', 'sessionId', 'runId', 'invocationId',
  ], [], 'Get Tool Approval input');
  return Object.freeze({
    projectId: record.projectId,
    sessionId: record.sessionId,
    runId: record.runId,
    invocationId: record.invocationId,
  }) as GetToolApprovalInput;
}

function snapshotListToolApprovalsInput(
  input: ListToolApprovalsInput,
): ListToolApprovalsInput {
  const record = snapshotDataRecord(input, [
    'projectId', 'sessionId', 'runId', 'limit',
  ], ['cursor', 'status'], 'List Tool Approvals input');
  return Object.freeze({
    projectId: record.projectId,
    sessionId: record.sessionId,
    runId: record.runId,
    limit: record.limit,
    ...(Object.hasOwn(record, 'cursor') ? { cursor: record.cursor } : {}),
    ...(Object.hasOwn(record, 'status') ? { status: record.status } : {}),
  }) as ListToolApprovalsInput;
}

function snapshotListTurnInvocationsInput(
  input: ListTurnInvocationsInput,
): ListTurnInvocationsInput {
  const record = snapshotDataRecord(input, [
    'projectId', 'sessionId', 'runId', 'turnId', 'limit',
  ], ['afterActionOrdinal'], 'List Turn Invocations input');
  return Object.freeze({
    projectId: record.projectId,
    sessionId: record.sessionId,
    runId: record.runId,
    turnId: record.turnId,
    limit: record.limit,
    ...(Object.hasOwn(record, 'afterActionOrdinal')
      ? { afterActionOrdinal: record.afterActionOrdinal }
      : {}),
  }) as ListTurnInvocationsInput;
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
      (value.type.startsWith('run.') && !(allowLegacyImport && value.type === 'run.cancelled')) ||
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
    const validated = validateAndRedactEventPayload(type, payload);
    validatePortable(validated, `${type} payload`);
    return validated;
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

function normalizeToolInvocationCommand(
  command: ToolInvocationJournalCommand,
): ToolInvocationJournalCommand {
  if (command === null || typeof command !== 'object' || Array.isArray(command)) {
    throw new AgentJournalError('INVALID_ARGUMENT', 'Tool Invocation command must be an object.');
  }
  const common = [
    'action', 'projectId', 'sessionId', 'runId', 'turnId', 'invocationId',
    'commandId', 'lease', 'expectedRunRevision', 'expectedInvocationRevision',
  ];
  const actionKeys: Record<ToolInvocationJournalCommand['action'], string[]> = {
    validate: [
      'canonicalToolId', 'toolRevision', 'effect', 'normalizedArgumentsDigest',
      'authorization', 'approvalSummary',
    ],
    'reject-validation': ['summary', 'error'],
    'decide-approval': [
      'approvalId', 'canonicalToolId', 'toolRevision', 'effect',
      'normalizedArgumentsDigest', 'proposedRevision', 'decision', 'decidedBy', 'reason',
    ],
    start: ['idempotencyKey', 'attempt', 'recoveryOfFencingToken'],
    finish: [
      'outcome', 'summary', 'resultRefs', 'durableSummary', 'modelProjection',
      'userProjection', 'error',
      'interruptedFencingToken',
    ],
    observe: ['observation'],
    'authorize-retry': [
      'permitId', 'toolRevision', 'effect', 'normalizedArgumentsDigest', 'reason',
    ],
    'resolve-outcome': [
      'resolutionId', 'outcome', 'canonicalToolId', 'toolRevision', 'effect',
      'normalizedArgumentsDigest', 'proposedRevision', 'summary',
    ],
  };
  if (!Object.hasOwn(actionKeys, command.action)) {
    throw new AgentJournalError('INVALID_ARGUMENT', 'Tool Invocation action is invalid.');
  }
  assertExactKeys(
    command,
    [...common, ...actionKeys[command.action]],
    'Tool Invocation command',
  );
  [
    ['projectId', command.projectId], ['sessionId', command.sessionId],
    ['runId', command.runId], ['turnId', command.turnId],
    ['invocationId', command.invocationId], ['commandId', command.commandId],
  ].forEach(([label, value]) => requireText(value, String(label)));
  if (command.lease === null || typeof command.lease !== 'object') {
    throw new AgentJournalError('INVALID_ARGUMENT', 'Tool Invocation lease is required.');
  }
  requireText(command.lease.ownerId, 'lease.ownerId');
  requireRevision(command.lease.fencingToken, 'lease.fencingToken');
  requireRevision(command.expectedRunRevision, 'expectedRunRevision');
  requireRevision(command.expectedInvocationRevision, 'expectedInvocationRevision');
  assertToolInvocationIngressBounds(command);
  validatePortable(command, 'Tool Invocation command');
  if ('canonicalToolId' in command) {
    requireCanonicalToolId(command.canonicalToolId);
  }
  if ('toolRevision' in command) requireText(command.toolRevision, 'toolRevision');
  if ('effect' in command) requireToolEffect(command.effect);
  if ('normalizedArgumentsDigest' in command) {
    requireSha256(command.normalizedArgumentsDigest, 'normalizedArgumentsDigest');
  }
  if (command.action === 'validate') {
    if (!['allow', 'ask', 'deny'].includes(command.authorization)) {
      throw new AgentJournalError('INVALID_ARGUMENT', 'authorization is invalid.');
    }
    requireText(command.approvalSummary, 'approvalSummary');
  } else if (command.action === 'reject-validation') {
    requireText(command.summary, 'summary');
    requireToolExecutionErrorFact(command.error);
  } else if (command.action === 'decide-approval') {
    requireText(command.approvalId, 'approvalId');
    requireRevision(command.proposedRevision, 'proposedRevision');
    if (!['approve', 'deny'].includes(command.decision)) {
      throw new AgentJournalError('INVALID_ARGUMENT', 'Approval decision is invalid.');
    }
    if (command.decidedBy !== undefined) requireText(command.decidedBy, 'decidedBy');
    if (command.reason !== undefined) requireText(command.reason, 'reason');
  } else if (command.action === 'start') {
    requireText(command.idempotencyKey, 'idempotencyKey');
    requireRevision(command.attempt, 'attempt');
    if (command.recoveryOfFencingToken !== undefined) {
      requireRevision(command.recoveryOfFencingToken, 'recoveryOfFencingToken');
    }
  } else if (command.action === 'finish') {
    if (!['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(command.outcome)) {
      throw new AgentJournalError('INVALID_ARGUMENT', 'Tool outcome is invalid.');
    }
    requireText(command.summary, 'summary');
    if (!Array.isArray(command.resultRefs) || command.resultRefs.some(
      (reference) => typeof reference !== 'string' || reference.length === 0,
    )) {
      throw new AgentJournalError('INVALID_ARGUMENT', 'resultRefs must contain strings.');
    }
    if (command.interruptedFencingToken !== undefined) {
      requireRevision(command.interruptedFencingToken, 'interruptedFencingToken');
      if (command.outcome !== 'outcome_unknown') {
        throw new AgentJournalError(
          'INVALID_ARGUMENT', 'interruptedFencingToken requires outcome_unknown.',
        );
      }
    }
  } else if (command.action === 'observe') {
    requireText(command.observation.observationId, 'observation.observationId');
    requireText(command.observation.invocationId, 'observation.invocationId');
  } else if (command.action === 'authorize-retry') {
    requireText(command.permitId, 'permitId');
    requireText(command.reason, 'reason');
  } else {
    requireText(command.resolutionId, 'resolutionId');
    if (!['succeeded', 'failed'].includes(command.outcome)) {
      throw new AgentJournalError('INVALID_ARGUMENT', 'Outcome resolution is invalid.');
    }
    requireRevision(command.proposedRevision, 'proposedRevision');
    requireText(command.summary, 'summary');
  }
  return structuredClone(command);
}

function assertToolInvocationIngressBounds(command: ToolInvocationJournalCommand): void {
  if (command.action === 'validate') {
    requireBoundedText(
      command.approvalSummary,
      'approvalSummary',
      MAX_APPROVAL_SUMMARY_CHARS,
    );
    return;
  }
  if (command.action === 'reject-validation' || command.action === 'resolve-outcome') {
    requireBoundedText(command.summary, 'summary', MAX_TOOL_SUMMARY_CHARS);
    return;
  }
  if (command.action === 'decide-approval') {
    if (command.decidedBy !== undefined) {
      requireBoundedText(command.decidedBy, 'decidedBy', MAX_DECIDED_BY_CHARS);
    }
    if (command.reason !== undefined) {
      requireBoundedText(command.reason, 'reason', MAX_APPROVAL_REASON_CHARS);
    }
    return;
  }
  if (command.action === 'finish') {
    requireBoundedText(command.summary, 'summary', MAX_TOOL_SUMMARY_CHARS);
    requireArtifactHandles(command.resultRefs, 'resultRefs');
    return;
  }
  if (command.action === 'observe') {
    requireBoundedText(
      command.observation.summary,
      'observation.summary',
      MAX_TOOL_SUMMARY_CHARS,
    );
    requireArtifactHandles(command.observation.evidenceRefs, 'observation.evidenceRefs');
    return;
  }
  if (command.action === 'authorize-retry') {
    requireBoundedText(command.reason, 'reason', MAX_APPROVAL_REASON_CHARS);
  }
}

function requireBoundedText(value: unknown, name: string, maximum: number): string {
  const text = requireText(value, name);
  if (text.length > maximum) {
    throw new AgentJournalError(
      'INVALID_ARGUMENT',
      `${name} exceeds the ${maximum}-character limit.`,
    );
  }
  return text;
}

function requireArtifactHandles(value: unknown, name: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length > MAX_TOOL_RESULT_REFS) {
    throw new AgentJournalError(
      'INVALID_ARGUMENT',
      `${name} must contain at most ${MAX_TOOL_RESULT_REFS} Artifact handles.`,
    );
  }
  for (const handle of value) {
    if (typeof handle !== 'string' || !PROJECT_ARTIFACT_HANDLE.test(handle)) {
      throw new AgentJournalError(
        'INVALID_ARGUMENT',
        `${name} contains an unsupported Artifact handle.`,
      );
    }
  }
}

function toolInvocationCommandIdentity(command: ToolInvocationJournalCommand): PortableValue {
  const {
    lease, expectedRunRevision, expectedInvocationRevision, commandId, ...identity
  } = command;
  void lease;
  void expectedRunRevision;
  void expectedInvocationRevision;
  void commandId;
  return identity;
}

function outcomeResolutionIdentity(
  command: Extract<ToolInvocationJournalCommand, { action: 'resolve-outcome' }>,
): PortableValue {
  return {
    resolutionId: command.resolutionId,
    outcome: command.outcome,
    canonicalToolId: command.canonicalToolId,
    toolRevision: command.toolRevision,
    effect: command.effect,
    normalizedArgumentsDigest: command.normalizedArgumentsDigest,
    proposedRevision: command.proposedRevision,
    summary: command.summary,
  };
}

function requireCanonicalToolId(value: unknown): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentJournalError('INVALID_ARGUMENT', 'canonicalToolId must be an object.');
  }
  const record = value as Record<string, unknown>;
  assertExactKeys(record, ['namespace', 'name'], 'canonicalToolId');
  requireText(record.name, 'canonicalToolId.name');
  if (record.namespace !== undefined) requireText(record.namespace, 'canonicalToolId.namespace');
}

function requireToolEffect(value: unknown): asserts value is ToolEffectFact {
  if (!['read', 'idempotent', 'transactional', 'non_idempotent'].includes(String(value))) {
    throw new AgentJournalError('INVALID_ARGUMENT', 'Tool effect is invalid.');
  }
}

function requireToolExecutionErrorFact(value: unknown): asserts value is ToolExecutionErrorFact {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentJournalError('INVALID_ARGUMENT', 'Tool error fact must be an object.');
  }
  const record = value as Record<string, unknown>;
  assertExactKeys(record, ['code', 'category', 'retryable', 'outcome'], 'Tool error fact');
  if (![
    'HANDLER_FAILED', 'TOOL_TIMEOUT', 'TOOL_CANCELLED', 'INVALID_TOOL_RESULT',
    'TOOL_NOT_FOUND', 'TOOL_REVISION_MISMATCH', 'TOOL_INPUT_INVALID',
    'OUTCOME_RESOLVED_FAILED',
  ].includes(String(record.code))) {
    throw new AgentJournalError('INVALID_ARGUMENT', 'Tool error code is invalid.');
  }
  if (![
    'internal', 'timeout', 'cancelled', 'contract', 'unavailable', 'conflict', 'validation',
    'resolution',
  ].includes(String(record.category))) {
    throw new AgentJournalError('INVALID_ARGUMENT', 'Tool error category is invalid.');
  }
  if (typeof record.retryable !== 'boolean' || !['not_applied', 'unknown'].includes(String(record.outcome))) {
    throw new AgentJournalError('INVALID_ARGUMENT', 'Tool error retry/outcome fact is invalid.');
  }
}

function requireSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new AgentJournalError('INVALID_ARGUMENT', `${label} must be lowercase SHA-256.`);
  }
}

function readInvocationProjection(
  database: NodeDatabaseSync,
  invocationId: string,
): AgentInvocationProjection | null {
  const row = database.prepare(
    `SELECT invocation_id, project_id, session_id, run_id, turn_id, attempt_id,
            call_id, action_ordinal, name, arguments_json, state, revision,
            created_at, updated_at, payload_json
     FROM agent_invocations WHERE invocation_id = ?`,
  ).get(invocationId) as {
    invocation_id: string; project_id: string; session_id: string; run_id: string;
    turn_id: string; attempt_id: string; call_id: string; action_ordinal: number;
    name: string; arguments_json: string; state: string; revision: number;
    created_at: string; updated_at: string; payload_json: string;
  } | undefined;
  if (row === undefined) return null;
  return parseProjectionJson(
    row.payload_json, 'Agent Invocation',
    (value): asserts value is AgentInvocationProjection => {
      assertInvocationProjection(value);
      assertProjectionIdentity(value.projectId === row.project_id, 'Agent Invocation projectId');
      assertProjectionIdentity(value.sessionId === row.session_id, 'Agent Invocation sessionId');
      assertProjectionIdentity(value.runId === row.run_id, 'Agent Invocation runId');
      assertProjectionIdentity(value.turnId === row.turn_id, 'Agent Invocation turnId');
      assertProjectionIdentity(value.attemptId === row.attempt_id, 'Agent Invocation attemptId');
      assertProjectionIdentity(value.invocationId === row.invocation_id, 'Agent Invocation id');
      assertProjectionIdentity(value.callId === row.call_id, 'Agent Invocation callId');
      assertProjectionIdentity(value.actionOrdinal === Number(row.action_ordinal), 'Agent Invocation ordinal');
      assertProjectionIdentity(value.name === row.name, 'Agent Invocation name');
      assertProjectionIdentity(value.state === row.state, 'Agent Invocation state');
      assertProjectionIdentity(value.revision === Number(row.revision), 'Agent Invocation revision');
      assertProjectionIdentity(value.createdAt === row.created_at, 'Agent Invocation createdAt');
      assertProjectionIdentity(value.updatedAt === row.updated_at, 'Agent Invocation updatedAt');
      assertProjectionIdentity(
        canonicalJson(value.arguments) === canonicalJson(
          parseProjectionPortableJson(row.arguments_json, 'Agent Invocation arguments'),
        ),
        'Agent Invocation arguments',
      );
    },
  );
}

function projectToolRunState(
  database: NodeDatabaseSync,
  runId: string,
  turnId: string,
  occurredAt: string,
  transition: ToolInvocationJournalCommand['action'] | 'model-commit',
): void {
  const current = database.prepare(
    'SELECT state FROM agent_runs WHERE run_id = ?',
  ).get(runId) as { state: AgentRunState } | undefined;
  if (current === undefined) {
    throw new AgentJournalError('RUN_NOT_FOUND', `Run not found: ${runId}`);
  }
  if (isProtectedToolProjectionState(current.state, transition)) return;
  const rows = database.prepare(
    `SELECT invocation_id FROM agent_invocations
     WHERE run_id = ? AND turn_id = ? ORDER BY action_ordinal ASC, invocation_id ASC`,
  ).all(runId, turnId) as unknown as Array<{ invocation_id: string }>;
  const invocations = rows.map(({ invocation_id }) => {
    const invocation = readInvocationProjection(database, invocation_id);
    if (invocation === null) {
      throw new AgentJournalError(
        'PROJECTION_CORRUPT',
        `Run aggregate references a missing Invocation: ${invocation_id}.`,
      );
    }
    return invocation;
  });
  const facts: ScheduledToolInvocation[] = invocations.map((invocation) => {
    if (invocation.state === 'validated') {
      throw new AgentJournalError(
        'PROJECTION_CORRUPT',
        'A transient validated Tool state cannot be projected independently.',
      );
    }
    return {
      invocationId: invocation.invocationId,
      actionOrdinal: invocation.actionOrdinal,
      effect: invocation.effect ?? 'unresolved',
      state: invocation.state,
    };
  });
  const decision = decideSchedule({
    invocations: facts,
    maxConcurrency: Number.MAX_SAFE_INTEGER,
  });
  const kernelProjectionExists = database.prepare(
    'SELECT 1 AS present FROM agent_kernel_runs WHERE run_id = ?',
  ).get(runId) !== undefined;
  const kernel = readKernelRunProjection(database, runId);
  const projected = projectKernelSchedule(kernel, decision, occurredAt);
  const result = database.prepare(
    'UPDATE agent_runs SET state = ?, updated_at = ? WHERE run_id = ?',
  ).run(projected.state, occurredAt, runId);
  if (Number(result.changes) !== 1) {
    throw new AgentJournalError('RUN_NOT_FOUND', `Run not found: ${runId}`);
  }
  if (kernelProjectionExists) persistKernelRunProjection(database, projected);
}

function advanceOnlineKernelEvidence(
  database: NodeDatabaseSync,
  runId: string,
  event: AgentEvent,
): void {
  const present = database.prepare(
    'SELECT 1 AS present FROM agent_kernel_runs WHERE run_id = ?',
  ).get(runId);
  if (present === undefined) return;
  const current = readKernelRunProjection(database, runId);
  const next = projectKernelRunEvent(current, event);
  persistKernelRunProjection(database, next);
}

function isProtectedToolProjectionState(
  state: AgentRunState,
  transition: ToolInvocationJournalCommand['action'] | 'model-commit',
): boolean {
  if (state === 'AwaitingUser') {
    return transition !== 'decide-approval' && transition !== 'resolve-outcome';
  }
  return state === 'Finalizing' || state === 'Cancelling' || state === 'LimitReached' ||
    state === 'Interrupted' || state === 'Completed' || state === 'Failed' ||
    state === 'Cancelled';
}

function readApprovalProjection(
  database: NodeDatabaseSync,
  approvalId: string,
): ToolApprovalFact | null {
  const row = database.prepare(
    `SELECT project_id, run_id, invocation_id, tool_revision,
            arguments_digest, effect, status, payload_json
     FROM agent_approvals WHERE approval_id = ?`,
  ).get(approvalId) as {
    project_id: string; run_id: string; invocation_id: string; tool_revision: string;
    arguments_digest: string; effect: string; status: string; payload_json: string;
  } | undefined;
  if (row === undefined) return null;
  return parseProjectionJson(
    row.payload_json, 'Tool Approval',
    (value): asserts value is ToolApprovalFact => {
      assertApprovalProjection(value);
      assertProjectionIdentity(value.projectId === row.project_id, 'Tool Approval projectId');
      assertProjectionIdentity(value.runId === row.run_id, 'Tool Approval runId');
      assertProjectionIdentity(value.invocationId === row.invocation_id, 'Tool Approval invocationId');
      assertProjectionIdentity(value.toolRevision === row.tool_revision, 'Tool Approval revision');
      assertProjectionIdentity(
        value.normalizedArgumentsDigest === row.arguments_digest, 'Tool Approval digest',
      );
      assertProjectionIdentity(value.effect === row.effect, 'Tool Approval effect');
      assertProjectionIdentity(value.status === row.status, 'Tool Approval status');
    },
  );
}

function assertInvocationBinding(
  invocation: AgentInvocationProjection,
  command: ToolInvocationJournalCommand,
): void {
  if (
    invocation.projectId !== command.projectId || invocation.sessionId !== command.sessionId ||
    invocation.runId !== command.runId || invocation.turnId !== command.turnId ||
    invocation.invocationId !== command.invocationId
  ) {
    throw new AgentJournalError(
      'RUN_IDENTITY_CONFLICT', 'Invocation does not belong to this Project/Session/Run/Turn.',
    );
  }
}

function requireInvocationState(
  invocation: AgentInvocationProjection,
  expected: readonly AgentInvocationProjection['state'][],
): void {
  if (!expected.includes(invocation.state)) {
    throw new AgentJournalError(
      'INVOCATION_STATE_CONFLICT',
      `Invocation state ${invocation.state} cannot perform this transition.`,
    );
  }
}

function assertApprovalBinding(
  approval: ToolApprovalFact,
  command: Extract<ToolInvocationJournalCommand, { action: 'decide-approval' }>,
): void {
  if (
    approval.projectId !== command.projectId || approval.sessionId !== command.sessionId ||
    approval.runId !== command.runId || approval.turnId !== command.turnId ||
    approval.invocationId !== command.invocationId ||
    canonicalJson(approval.canonicalToolId) !== canonicalJson(command.canonicalToolId) ||
    approval.toolRevision !== command.toolRevision || approval.effect !== command.effect ||
    approval.normalizedArgumentsDigest !== command.normalizedArgumentsDigest ||
    approval.proposedRevision !== command.proposedRevision
  ) {
    throw new AgentJournalError(
      'APPROVAL_BINDING_MISMATCH', 'Approval binding does not match the committed request.',
    );
  }
}

function findEquivalentUnknownInvocation(
  database: NodeDatabaseSync,
  current: AgentInvocationProjection,
  command: Extract<ToolInvocationJournalCommand, { action: 'validate' }>,
): AgentInvocationProjection | undefined {
  const row = database.prepare(
    `SELECT invocation_id FROM agent_invocations
     WHERE project_id = ? AND run_id = ? AND name = ? AND invocation_id <> ?
       AND state = 'observed'
       AND json_extract(payload_json, '$.toolRevision') = ?
       AND json_extract(payload_json, '$.effect') = ?
       AND json_extract(payload_json, '$.normalizedArgumentsDigest') = ?
       AND json_extract(payload_json, '$.terminal.kind') = 'outcome_unknown'
     ORDER BY updated_at DESC LIMIT 1`,
  ).get(
    current.projectId,
    current.runId,
    current.name,
    current.invocationId,
    command.toolRevision,
    command.effect,
    command.normalizedArgumentsDigest,
  ) as { invocation_id: string } | undefined;
  if (row === undefined) return undefined;
  const predecessor = readInvocationProjection(database, row.invocation_id);
  if (predecessor === null) {
    throw new AgentJournalError(
      'PROJECTION_CORRUPT',
      `Unknown-outcome predecessor is missing: ${row.invocation_id}.`,
    );
  }
  return predecessor;
}

function findUnconsumedRetryPermit(
  database: NodeDatabaseSync,
  invocation: AgentInvocationProjection,
): AgentInvocationProjection['retryPermit'] | undefined {
  const permit = invocation.retryPermit;
  if (permit === undefined) return undefined;
  const used = database.prepare(
    `SELECT 1 AS present FROM agent_invocations
     WHERE project_id = ? AND run_id = ?
       AND json_extract(payload_json, '$.retryPermitId') = ?
     LIMIT 1`,
  ).get(invocation.projectId, invocation.runId, permit.permitId);
  return used === undefined ? permit : undefined;
}

function boundedText(value: string, maximum: number): string {
  return value.length <= maximum ? value : value.slice(0, maximum);
}

function encodeApprovalCursor(createdAt: string, approvalId: string): string {
  return Buffer.from(JSON.stringify({ createdAt, approvalId }), 'utf8').toString('base64url');
}

function decodeApprovalCursor(cursor: string): { createdAt: string; approvalId: string } {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('Cursor payload must be an object.');
    }
    const record = value as Record<string, unknown>;
    assertExactKeys(record, ['createdAt', 'approvalId'], 'Approval cursor');
    if (!isIsoTimestamp(record.createdAt)) {
      throw new TypeError('Approval cursor timestamp is invalid.');
    }
    const approvalId = requireBoundedText(record.approvalId, 'cursor.approvalId', 256);
    return { createdAt: record.createdAt, approvalId };
  } catch (error) {
    if (error instanceof AgentJournalError) throw error;
    throw new AgentJournalError(
      'INVALID_ARGUMENT',
      `Approval cursor is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function stableToolIdentity(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function assertNever(value: never): never {
  throw new AgentJournalError('INVALID_ARGUMENT', `Unsupported transition: ${String(value)}`);
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

function assertEventOuterPayloadConsistency(row: EventRow, payload: unknown): void {
  validatePortable(payload, `${row.event_type} stored payload`);
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
    'actionOrdinal', 'name', 'arguments', 'state', 'revision', 'canonicalToolId',
    'toolRevision', 'effect', 'normalizedArgumentsDigest', 'proposedRevision',
    'approvalId', 'retryOf', 'retryPermitId', 'retryPermit', 'outcomeResolution',
    'started', 'terminal',
    'observation', 'createdAt', 'updatedAt',
  ], 'Agent Invocation');
  ['projectId', 'sessionId', 'runId', 'turnId', 'attemptId', 'invocationId', 'callId', 'name']
    .forEach((key) => projectionText(record[key], `Agent Invocation ${key}`));
  projectionNonNegativeInteger(record.actionOrdinal, 'Agent Invocation actionOrdinal');
  assertPortableValue(record.arguments);
  if (![
    'proposed', 'validated', 'awaiting_approval', 'authorized', 'denied', 'started',
    'succeeded', 'failed', 'cancelled', 'outcome_unknown', 'observed',
  ].includes(String(record.state))) throw new TypeError('Agent Invocation state is invalid.');
  projectionPositiveInteger(record.revision, 'Agent Invocation revision');
  projectionIso(record.createdAt, 'Agent Invocation createdAt');
  projectionIso(record.updatedAt, 'Agent Invocation updatedAt');
  assertPortableValue(record);
}

function assertApprovalProjection(value: unknown): asserts value is ToolApprovalFact {
  const record = projectionRecord(value, 'Tool Approval');
  projectionExactKeys(record, [
    'approvalId', 'projectId', 'sessionId', 'runId', 'turnId', 'invocationId',
    'canonicalToolId', 'toolRevision', 'effect', 'normalizedArgumentsDigest',
    'proposedRevision', 'status', 'decidedAt', 'decidedBy', 'reason',
  ], 'Tool Approval');
  [
    'approvalId', 'projectId', 'sessionId', 'runId', 'turnId', 'invocationId', 'toolRevision',
  ].forEach((key) => projectionText(record[key], `Tool Approval ${key}`));
  projectionPositiveInteger(record.proposedRevision, 'Tool Approval proposedRevision');
  if (!['pending', 'approved', 'denied'].includes(String(record.status))) {
    throw new TypeError('Tool Approval status is invalid.');
  }
  assertPortableValue(record);
}

function assertObservationProjection(value: unknown): asserts value is AgentObservationProjection {
  const record = projectionRecord(value, 'Agent Observation');
  projectionExactKeys(record, [
    'observationId', 'invocationId', 'summary', 'evidenceRefs', 'outcome',
    'modelProjection', 'errorCode', 'projectId', 'runId', 'createdAt',
  ], 'Agent Observation');
  ['observationId', 'invocationId', 'summary', 'projectId', 'runId'].forEach((key) =>
    projectionText(record[key], `Agent Observation ${key}`));
  projectionIso(record.createdAt, 'Agent Observation createdAt');
  assertPortableValue(record);
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
    CREATE TABLE IF NOT EXISTS agent_session_events (
      project_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      event_id TEXT NOT NULL UNIQUE,
      schema_version INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      PRIMARY KEY (project_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_session_events_scope_sequence
      ON agent_session_events(project_id, session_id, sequence);
    CREATE TABLE IF NOT EXISTS agent_session_model_bindings (
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      connection_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, session_id)
    );
    CREATE TABLE IF NOT EXISTS agent_runs (
      run_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      client_request_id TEXT NOT NULL,
      state TEXT NOT NULL,
      revision INTEGER NOT NULL,
      hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
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
      session_id TEXT NOT NULL,
      run_id TEXT NOT NULL UNIQUE,
      schema_version INTEGER NOT NULL,
      digest TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES agent_runs(run_id)
    );
    CREATE TABLE IF NOT EXISTS agent_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      turn_id TEXT NOT NULL UNIQUE,
      environment_binding_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      snapshot_type TEXT NOT NULL,
      revision TEXT NOT NULL,
      digest TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES agent_runs(run_id)
    );
    CREATE TABLE IF NOT EXISTS agent_kernel_runs (
      run_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      environment_binding_id TEXT,
      current_turn_id TEXT,
      turn_snapshot_id TEXT,
      current_attempt_id TEXT,
      wait_reason TEXT,
      evidence_revision INTEGER NOT NULL DEFAULT 0,
      evidence_digest TEXT,
      no_progress_count INTEGER NOT NULL DEFAULT 0,
      final_content_ref TEXT,
      delivery_status TEXT,
      updated_at TEXT NOT NULL,
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
    CREATE INDEX IF NOT EXISTS idx_agent_invocations_unknown_equivalent
      ON agent_invocations (
        project_id,
        run_id,
        name,
        state,
        json_extract(payload_json, '$.toolRevision'),
        json_extract(payload_json, '$.effect'),
        json_extract(payload_json, '$.normalizedArgumentsDigest'),
        json_extract(payload_json, '$.terminal.kind'),
        updated_at DESC
      );
    CREATE INDEX IF NOT EXISTS idx_agent_invocations_retry_permit
      ON agent_invocations (
        project_id,
        run_id,
        json_extract(payload_json, '$.retryPermitId')
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
    CREATE INDEX IF NOT EXISTS idx_agent_approvals_scope_status_id
      ON agent_approvals(project_id, run_id, status, created_at, approval_id);
    CREATE INDEX IF NOT EXISTS idx_agent_approvals_scope_id
      ON agent_approvals(project_id, run_id, created_at, approval_id);
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
  migrateHiddenRuns(database);
  migrateArtifactReferenceUniqueness(database);
  migrateLegacyRunLeaseForeignKey(database);
  migrateKernelJournalTables(database);
}

function migrateKernelJournalTables(database: NodeDatabaseSync): void {
  const addMissing = (table: string, columns: Readonly<Record<string, string>>): void => {
    const present = new Set((database.prepare(`PRAGMA table_info(${table})`).all() as unknown as
      Array<{ name: string }>).map(({ name }) => name));
    for (const [name, definition] of Object.entries(columns)) {
      if (!present.has(name)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  };
  addMissing('agent_environment_bindings', {
    session_id: "TEXT NOT NULL DEFAULT ''",
    schema_version: 'INTEGER NOT NULL DEFAULT 1',
    digest: "TEXT NOT NULL DEFAULT ''",
  });
  addMissing('agent_snapshots', {
    session_id: "TEXT NOT NULL DEFAULT ''",
    turn_id: "TEXT NOT NULL DEFAULT ''",
    environment_binding_id: "TEXT NOT NULL DEFAULT ''",
    schema_version: 'INTEGER NOT NULL DEFAULT 1',
    digest: "TEXT NOT NULL DEFAULT ''",
  });
  addMissing('agent_kernel_runs', {
    evidence_digest: 'TEXT',
    no_progress_count: 'INTEGER NOT NULL DEFAULT 0',
  });
  database.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_snapshots_turn_id
     ON agent_snapshots(turn_id) WHERE turn_id <> ''`,
  );
}

function migrateHiddenRuns(database: NodeDatabaseSync): void {
  const columns = database.prepare('PRAGMA table_info(agent_runs)').all() as unknown as Array<{
    name: string;
  }>;
  if (!columns.some(({ name }) => name === 'hidden')) {
    database.exec(
      'ALTER TABLE agent_runs ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1))',
    );
  }
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
      updatedAt: committedAt,
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

function snapshotKernelJournalCommand(command: KernelJournalCommand): KernelJournalCommand {
  try {
    return structuredClone(command);
  } catch {
    throw new AgentJournalError(
      'INVALID_ARGUMENT', 'Kernel Journal command must be structured-cloneable.',
    );
  }
}

function snapshotSessionBindingCommand(
  command: BindSessionModelCommand,
): BindSessionModelCommand {
  let snapshot: BindSessionModelCommand;
  try {
    snapshot = structuredClone(command);
    const candidate: unknown = snapshot;
    assertPortableValue(candidate);
    assertNoSecretMaterial(candidate);
  } catch (error) {
    throw new AgentJournalError(
      'INVALID_ARGUMENT', `Session binding command is not portable: ${errorMessage(error)}`,
    );
  }
  assertExactObjectKeys(snapshot, [
    'projectId', 'sessionId', 'commandId', 'expectedRevision', 'connectionId', 'modelId',
  ]);
  requireText(snapshot.projectId, 'projectId');
  requireText(snapshot.sessionId, 'sessionId');
  requireText(snapshot.commandId, 'commandId');
  requireText(snapshot.connectionId, 'connectionId');
  requireText(snapshot.modelId, 'modelId');
  if (!Number.isSafeInteger(snapshot.expectedRevision) || snapshot.expectedRevision < 0) {
    throw new AgentJournalError('INVALID_ARGUMENT', 'expectedRevision is invalid.');
  }
  return deepFreezeKernelValue(snapshot);
}

function validateKernelJournalCommand(command: KernelJournalCommand): KernelJournalCommand {
  try {
    const portableCandidate: unknown = command;
    assertPortableValue(portableCandidate);
    assertNoSecretMaterial(portableCandidate);
  } catch (error) {
    throw new AgentJournalError(
      'INVALID_ARGUMENT', `Kernel Journal command is not portable: ${errorMessage(error)}`,
    );
  }
  requireText(command.projectId, 'projectId');
  requireText(command.sessionId, 'sessionId');
  requireText(command.runId, 'runId');
  requireText(command.commandId, 'commandId');
  requireText(command.lease.ownerId, 'lease.ownerId');
  if (!Number.isSafeInteger(command.lease.fencingToken) || command.lease.fencingToken < 1) {
    throw new AgentJournalError('INVALID_ARGUMENT', 'lease.fencingToken is invalid.');
  }
  if (!Number.isSafeInteger(command.expectedRunRevision) || command.expectedRunRevision < 1) {
    throw new AgentJournalError('INVALID_ARGUMENT', 'expectedRunRevision is invalid.');
  }
  switch (command.action) {
    case 'prepare-turn':
      assertExactObjectKeys(command, [
        'action', 'projectId', 'sessionId', 'runId', 'commandId', 'lease',
        'expectedRunRevision', 'turnId', 'resume', 'environment', 'snapshot',
      ]);
      requireText(command.turnId, 'turnId');
      validateEnvironmentBindingInput(command.environment);
      validateTurnSnapshotInput(command.snapshot);
      return command;
    case 'start-model-attempt':
      assertExactObjectKeys(command, [
        'action', 'projectId', 'sessionId', 'runId', 'commandId', 'lease',
        'expectedRunRevision', 'turnId', 'expectedTurnRevision', 'attemptId', 'origin',
      ]);
      requireText(command.turnId, 'turnId');
      requireText(command.attemptId, 'attemptId');
      if (!Number.isSafeInteger(command.expectedTurnRevision) || command.expectedTurnRevision < 1) {
        throw new AgentJournalError('INVALID_ARGUMENT', 'expectedTurnRevision is invalid.');
      }
      assertExactObjectKeys(command.origin, ['connectionId', 'model', 'protocol']);
      requireText(command.origin.connectionId, 'origin.connectionId');
      requireText(command.origin.model, 'origin.model');
      requireText(command.origin.protocol, 'origin.protocol');
      return command;
    case 'discard-model-attempt':
      assertExactObjectKeys(command, [
        'action', 'projectId', 'sessionId', 'runId', 'commandId', 'lease',
        'expectedRunRevision', 'turnId', 'expectedTurnRevision', 'attemptId',
        'reason',
      ], ['failure']);
      requireText(command.turnId, 'turnId');
      requireText(command.attemptId, 'attemptId');
      requireText(command.reason, 'reason');
      if (!Number.isSafeInteger(command.expectedTurnRevision) || command.expectedTurnRevision < 1) {
        throw new AgentJournalError('INVALID_ARGUMENT', 'expectedTurnRevision is invalid.');
      }
      if (command.failure !== undefined) {
        assertExactObjectKeys(command.failure, ['code', 'retryable']);
        requireText(command.failure.code, 'failure.code');
        if (typeof command.failure.retryable !== 'boolean') {
          throw new AgentJournalError('INVALID_ARGUMENT', 'failure.retryable is invalid.');
        }
      }
      return command;
    case 'request-cancel':
      assertExactObjectKeys(command, [
        'action', 'projectId', 'sessionId', 'runId', 'commandId', 'lease',
        'expectedRunRevision',
      ], ['reason']);
      if (command.reason !== undefined) requireText(command.reason, 'reason');
      return command;
    case 'settle-cancellation':
      assertExactObjectKeys(command, [
        'action', 'projectId', 'sessionId', 'runId', 'commandId', 'lease',
        'expectedRunRevision',
      ]);
      return command;
    case 'record-no-progress':
      assertExactObjectKeys(command, [
        'action', 'projectId', 'sessionId', 'runId', 'commandId', 'lease',
        'expectedRunRevision', 'fingerprint',
      ]);
      if (!/^[a-f0-9]{64}$/u.test(command.fingerprint)) {
        throw new AgentJournalError('INVALID_ARGUMENT', 'fingerprint must be a SHA-256 digest.');
      }
      return command;
    case 'finalize-run':
      assertExactObjectKeys(command, [
        'action', 'projectId', 'sessionId', 'runId', 'commandId', 'lease',
        'expectedRunRevision', 'turnId', 'expectedTurnRevision', 'finalContentRef', 'decision',
      ]);
      requireText(command.turnId, 'turnId');
      requireText(command.finalContentRef, 'finalContentRef');
      if (!Number.isSafeInteger(command.expectedTurnRevision) || command.expectedTurnRevision < 1) {
        throw new AgentJournalError('INVALID_ARGUMENT', 'expectedTurnRevision is invalid.');
      }
      validateFinalizeDecision(command.decision);
      return command;
    default:
      throw new AgentJournalError('INVALID_ARGUMENT', 'Unknown Kernel Journal command action.');
  }
}

function validateFinalizeDecision(value: FinalizeRunKernelCommand['decision']): void {
  assertExactObjectKeys(value, [
    'evidenceRevision', 'status', 'outcome', 'evidenceRefs',
  ], ['verifierId', 'verifierRevision', 'reason']);
  if (!Number.isSafeInteger(value.evidenceRevision) || value.evidenceRevision < 0) {
    throw new AgentJournalError('INVALID_ARGUMENT', 'decision.evidenceRevision is invalid.');
  }
  if (!['not-required', 'verified', 'unverified'].includes(value.status)) {
    throw new AgentJournalError('INVALID_ARGUMENT', 'decision.status is invalid.');
  }
  if (!['accepted', 'failed'].includes(value.outcome)) {
    throw new AgentJournalError('INVALID_ARGUMENT', 'decision.outcome is invalid.');
  }
  if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.length > 1_024) {
    throw new AgentJournalError('INVALID_ARGUMENT', 'decision.evidenceRefs is invalid.');
  }
  for (const ref of value.evidenceRefs) requireText(ref, 'decision.evidenceRefs[]');
  if (new Set(value.evidenceRefs).size !== value.evidenceRefs.length) {
    throw new AgentJournalError('INVALID_ARGUMENT', 'decision.evidenceRefs must be unique.');
  }
  if ((value.verifierId === undefined) !== (value.verifierRevision === undefined)) {
    throw new AgentJournalError(
      'INVALID_ARGUMENT', 'Verifier identity and revision must be supplied together.',
    );
  }
  if (value.verifierId !== undefined) requireText(value.verifierId, 'decision.verifierId');
  if (value.verifierRevision !== undefined) {
    requireText(value.verifierRevision, 'decision.verifierRevision');
  }
  if (value.reason !== undefined) requireText(value.reason, 'decision.reason');
  if (value.status === 'not-required' && value.verifierId !== undefined) {
    throw new AgentJournalError(
      'INVALID_ARGUMENT', 'A not-required delivery cannot claim a verifier decision.',
    );
  }
  if (value.status === 'verified' && value.verifierId === undefined) {
    throw new AgentJournalError(
      'INVALID_ARGUMENT', 'A verified delivery requires a versioned verifier identity.',
    );
  }
  if (value.outcome === 'failed' && value.status !== 'unverified') {
    throw new AgentJournalError(
      'INVALID_ARGUMENT', 'A failed delivery must be explicitly unverified.',
    );
  }
}

function validateEnvironmentBindingInput(value: EnvironmentBindingInput): void {
  assertExactObjectKeys(value, [
    'environmentBindingId', 'settingsRevision', 'permissionPolicyRevision', 'modelRoute',
  ]);
  requireText(value.environmentBindingId, 'environmentBindingId');
  requireText(value.settingsRevision, 'settingsRevision');
  requireText(value.permissionPolicyRevision, 'permissionPolicyRevision');
  assertExactObjectKeys(value.modelRoute, ['routeRevision', 'primary', 'fallbacks']);
  requireText(value.modelRoute.routeRevision, 'routeRevision');
  validateModelRouteCandidate(value.modelRoute.primary);
  if (!Array.isArray(value.modelRoute.fallbacks) || value.modelRoute.fallbacks.length > 16) {
    throw new AgentJournalError('INVALID_ARGUMENT', 'Model fallback snapshot is invalid.');
  }
  value.modelRoute.fallbacks.forEach(validateModelRouteCandidate);
}

function validateModelRouteCandidate(
  value: EnvironmentBindingInput['modelRoute']['primary'],
): void {
  assertExactObjectKeys(value, [
    'connectionId', 'modelId', 'protocol', 'codecRevision', 'maxInputTokens',
    'maxOutputTokens', 'generation',
  ]);
  ['connectionId', 'modelId', 'protocol', 'codecRevision'].forEach((key) =>
    requireText(value[key as keyof typeof value], key));
  for (const item of [value.maxInputTokens, value.maxOutputTokens]) {
    if (item !== null && (!Number.isSafeInteger(item) || item < 1)) {
      throw new AgentJournalError('INVALID_ARGUMENT', 'Model context limits are invalid.');
    }
  }
  if (value.generation === null || typeof value.generation !== 'object' ||
    Array.isArray(value.generation)) {
    throw new AgentJournalError('INVALID_ARGUMENT', 'Generation snapshot is invalid.');
  }
}

function validateTurnSnapshotInput(value: TurnSnapshotInput): void {
  assertExactObjectKeys(value, [
    'turnSnapshotId', 'capability', 'promptRevision', 'tools', 'skills', 'verifiers',
  ]);
  requireText(value.turnSnapshotId, 'turnSnapshotId');
  requireText(value.promptRevision, 'promptRevision');
  assertExactObjectKeys(value.capability, ['snapshotId', 'revision']);
  requireText(value.capability.snapshotId, 'capability.snapshotId');
  requireText(value.capability.revision, 'capability.revision');
  if (value.tools.length > 1_024 || value.skills.length > 256 || value.verifiers.length > 64) {
    throw new AgentJournalError('INVALID_ARGUMENT', 'Turn Snapshot contribution list is unbounded.');
  }
}

function assertExactObjectKeys(
  value: object,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const actual = Object.keys(value).sort();
  const allowed = [...required, ...optional];
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    actual.some((key) => !allowed.includes(key))
  ) {
    throw new AgentJournalError(
      'INVALID_ARGUMENT', `Kernel command keys are not closed: ${actual.join(',')}.`,
    );
  }
}

function readEnvironmentBindingRow(
  database: NodeDatabaseSync,
  runId: string,
): KernelEnvironmentRow | null {
  return (database.prepare(
    `SELECT environment_binding_id, project_id, session_id, run_id, schema_version,
      digest, payload_json, created_at
     FROM agent_environment_bindings WHERE run_id = ?`,
  ).get(runId) as KernelEnvironmentRow | undefined) ?? null;
}

function environmentBindingFromRow(row: KernelEnvironmentRow): PersistedEnvironmentBinding {
  const payload = parsePortableJson(row.payload_json) as unknown as EnvironmentBindingInput;
  const actualDigest = digestValue(payload);
  if (actualDigest !== row.digest || row.schema_version !== 1) {
    throw new AgentJournalError('PROJECTION_CORRUPT', 'Environment Binding digest disagrees.');
  }
  return freezeEnvironmentBinding({
    schemaVersion: 1,
    environmentBindingId: row.environment_binding_id,
    projectId: row.project_id,
    sessionId: row.session_id,
    runId: row.run_id,
    digest: row.digest,
    payload,
    createdAt: row.created_at,
  });
}

function turnSnapshotFromRow(row: KernelSnapshotRow): PersistedTurnSnapshot {
  const payload = parsePortableJson(row.payload_json) as unknown as TurnSnapshotInput;
  const actualDigest = digestValue({
    payload, turnId: row.turn_id, environmentBindingId: row.environment_binding_id,
  });
  if (actualDigest !== row.digest || row.schema_version !== 1) {
    throw new AgentJournalError('PROJECTION_CORRUPT', 'Turn Snapshot digest disagrees.');
  }
  return freezeTurnSnapshot({
    schemaVersion: 1,
    turnSnapshotId: row.snapshot_id,
    projectId: row.project_id,
    sessionId: row.session_id,
    runId: row.run_id,
    turnId: row.turn_id,
    environmentBindingId: row.environment_binding_id,
    digest: row.digest,
    payload,
    createdAt: row.created_at,
  });
}

function readKernelRunProjection(
  database: NodeDatabaseSync,
  runId: string,
): KernelRunProjection {
  const row = database.prepare(
    `SELECT r.project_id, r.session_id, r.run_id, r.state, r.revision, r.updated_at,
      k.environment_binding_id, k.current_turn_id, k.turn_snapshot_id,
      k.current_attempt_id, k.wait_reason, k.evidence_revision,
      k.evidence_digest, k.no_progress_count, k.final_content_ref, k.delivery_status
     FROM agent_runs r LEFT JOIN agent_kernel_runs k ON k.run_id = r.run_id
     WHERE r.run_id = ?`,
  ).get(runId) as Record<string, unknown> | undefined;
  if (row === undefined) throw new AgentJournalError('RUN_NOT_FOUND', `Run not found: ${runId}`);
  return deepFreezeKernelValue({
    schemaVersion: 1,
    projectId: String(row.project_id),
    sessionId: String(row.session_id),
    runId: String(row.run_id),
    state: String(row.state) as AgentRunState,
    revision: Number(row.revision),
    environmentBindingId: nullableText(row.environment_binding_id),
    currentTurnId: nullableText(row.current_turn_id),
    turnSnapshotId: nullableText(row.turn_snapshot_id),
    currentAttemptId: nullableText(row.current_attempt_id),
    waitReason: nullableText(row.wait_reason),
    evidenceRevision: row.evidence_revision === null || row.evidence_revision === undefined
      ? 0 : Number(row.evidence_revision),
    evidenceDigest: nullableText(row.evidence_digest),
    noProgressCount: row.no_progress_count === null || row.no_progress_count === undefined
      ? 0 : Number(row.no_progress_count),
    finalContentRef: nullableText(row.final_content_ref),
    deliveryStatus: nullableText(row.delivery_status) as KernelRunProjection['deliveryStatus'],
    updatedAt: String(row.updated_at),
  });
}

function projectKernelRunEvents(
  current: KernelRunProjection,
  events: readonly AgentEvent[],
): KernelRunProjection {
  return events.reduce(projectKernelRunEvent, current);
}

/** Persists the shared pure Kernel projection with the Run revision as its fencing CAS. */
function persistKernelRunProjectionCas(
  database: NodeDatabaseSync,
  current: KernelRunProjection,
  next: KernelRunProjection,
  expectedRevision: number,
  conflictMessage: string,
): void {
  if (
    current.projectId !== next.projectId || current.sessionId !== next.sessionId ||
    current.runId !== next.runId || current.revision !== expectedRevision ||
    next.revision !== expectedRevision + 1
  ) {
    throw new AgentJournalError(
      'PROJECTION_CORRUPT', 'Kernel event reduction produced an invalid identity or revision.',
    );
  }
  const changed = database.prepare(
    `UPDATE agent_runs SET state = ?, revision = ?, updated_at = ?
     WHERE project_id = ? AND session_id = ? AND run_id = ? AND revision = ?`,
  ).run(
    next.state, next.revision, next.updatedAt,
    next.projectId, next.sessionId, next.runId, expectedRevision,
  );
  if (Number(changed.changes) !== 1) {
    throw new AgentJournalError('REVISION_CONFLICT', conflictMessage);
  }
  persistKernelRunProjection(database, next);
}

function persistKernelRunProjection(
  database: NodeDatabaseSync,
  projection: KernelRunProjection,
): void {
  database.prepare(
    `INSERT INTO agent_kernel_runs (
      run_id, project_id, session_id, environment_binding_id, current_turn_id,
      turn_snapshot_id, current_attempt_id, wait_reason, evidence_revision,
      evidence_digest, no_progress_count, final_content_ref, delivery_status, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      project_id = excluded.project_id,
      session_id = excluded.session_id,
      environment_binding_id = excluded.environment_binding_id,
      current_turn_id = excluded.current_turn_id,
      turn_snapshot_id = excluded.turn_snapshot_id,
      current_attempt_id = excluded.current_attempt_id,
      wait_reason = excluded.wait_reason,
      evidence_revision = excluded.evidence_revision,
      evidence_digest = excluded.evidence_digest,
      no_progress_count = excluded.no_progress_count,
      final_content_ref = excluded.final_content_ref,
      delivery_status = excluded.delivery_status,
      updated_at = excluded.updated_at`,
  ).run(
    projection.runId, projection.projectId, projection.sessionId,
    projection.environmentBindingId, projection.currentTurnId, projection.turnSnapshotId,
    projection.currentAttemptId, projection.waitReason, projection.evidenceRevision,
    projection.evidenceDigest, projection.noProgressCount, projection.finalContentRef,
    projection.deliveryStatus, projection.updatedAt,
  );
}

function readLatestCancellationReason(
  database: NodeDatabaseSync,
  runId: string,
): string | undefined {
  const row = database.prepare(
    `SELECT payload_json FROM agent_events
     WHERE run_id = ? AND event_type = 'run.cancel_requested'
     ORDER BY sequence DESC LIMIT 1`,
  ).get(runId) as { payload_json: string } | undefined;
  if (row === undefined) return undefined;
  const payload = parsePortableJson(row.payload_json) as { reason?: unknown };
  return typeof payload.reason === 'string' ? payload.reason : undefined;
}

type KernelReplayProjection = Readonly<{
  runs: Map<string, KernelRunProjection>;
  environments: Map<string, PersistedEnvironmentBinding>;
  snapshots: Map<string, PersistedTurnSnapshot>;
}>;

/** Rebuilds all Kernel-only tables from immutable Journal facts; no projection table is read. */
function replayKernelJournalFacts(
  events: readonly AgentEvent[],
  invocations: readonly AgentInvocationProjection[],
): KernelReplayProjection {
  const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
  const created = new Map(ordered.filter((event) => event.type === 'run.created')
    .map((event) => [event.runId, event] as const));
  const runs = new Map<string, KernelRunProjection>();
  const environments = new Map<string, PersistedEnvironmentBinding>();
  const snapshots = new Map<string, PersistedTurnSnapshot>();

  for (const event of ordered) {
    if (event.type !== 'run.environment_bound') continue;
    const createdEvent = created.get(event.runId);
    if (createdEvent === undefined || event.payload.binding === undefined) {
      throw new AgentJournalError(
        'PROJECTION_CORRUPT', 'Kernel Environment Binding is not reconstructible from Journal facts.',
      );
    }
    const payload = structuredClone(event.payload.binding) as unknown as EnvironmentBindingInput;
    validateEnvironmentBindingInput(payload);
    if (digestValue(payload) !== event.payload.digest) {
      throw new AgentJournalError(
        'PROJECTION_CORRUPT', 'Kernel Environment Binding fact digest disagrees.',
      );
    }
    const existing = environments.get(event.runId);
    if (existing !== undefined && (
      existing.environmentBindingId !== event.payload.environmentBindingId ||
      existing.digest !== event.payload.digest
    )) {
      throw new AgentJournalError(
        'PROJECTION_CORRUPT', 'A Run has conflicting Environment Binding facts.',
      );
    }
    environments.set(event.runId, freezeEnvironmentBinding({
      schemaVersion: 1, environmentBindingId: event.payload.environmentBindingId,
      projectId: event.projectId, sessionId: event.sessionId, runId: event.runId,
      digest: event.payload.digest, payload, createdAt: event.occurredAt,
    }));
    if (!runs.has(event.runId)) {
      runs.set(event.runId, createKernelRunProjection({
        projectId: event.projectId, sessionId: event.sessionId, runId: event.runId,
        environmentBindingId: event.payload.environmentBindingId,
        createdAt: createdEvent.occurredAt,
      }));
    }
  }

  for (const event of ordered) {
    const current = runs.get(event.runId);
    if (current === undefined) continue;
    if (event.type === 'turn.started') {
      if (
        event.turnId === undefined || event.payload.turnSnapshotId === undefined ||
        event.payload.environmentBindingId === undefined || event.payload.digest === undefined ||
        event.payload.snapshot === undefined
      ) {
        throw new AgentJournalError(
          'PROJECTION_CORRUPT', 'Kernel Turn Snapshot is not reconstructible from Journal facts.',
        );
      }
      const payload = structuredClone(event.payload.snapshot) as unknown as TurnSnapshotInput;
      validateTurnSnapshotInput(payload);
      const digest = digestValue({
        payload, turnId: event.turnId,
        environmentBindingId: event.payload.environmentBindingId,
      });
      if (digest !== event.payload.digest) {
        throw new AgentJournalError('PROJECTION_CORRUPT', 'Kernel Turn Snapshot fact digest disagrees.');
      }
      snapshots.set(event.turnId, freezeTurnSnapshot({
        schemaVersion: 1, turnSnapshotId: event.payload.turnSnapshotId,
        projectId: event.projectId, sessionId: event.sessionId, runId: event.runId,
        turnId: event.turnId, environmentBindingId: event.payload.environmentBindingId,
        digest, payload, createdAt: event.occurredAt,
      }));
    }
    runs.set(event.runId, projectKernelRunEvent(current, event));
  }

  for (const [runId, current] of runs) {
    if (
      current.currentTurnId === null ||
      !['ResolvingActions', 'ExecutingTools', 'ApplyingObservations', 'AwaitingUser'].includes(
        current.state,
      ) || (current.state === 'AwaitingUser' && current.waitReason !== 'approval')
    ) continue;
    const scheduled: ScheduledToolInvocation[] = invocations.filter(
      (invocation) => invocation.runId === runId && invocation.turnId === current.currentTurnId,
    ).map((invocation) => {
      if (invocation.state === 'validated') {
        throw new AgentJournalError(
          'PROJECTION_CORRUPT', 'Replay contains a transient validated Invocation projection.',
        );
      }
      return {
        invocationId: invocation.invocationId, actionOrdinal: invocation.actionOrdinal,
        effect: invocation.effect ?? 'unresolved', state: invocation.state,
      };
    });
    if (scheduled.length === 0) continue;
    const decision = decideSchedule({ invocations: scheduled, maxConcurrency: Number.MAX_SAFE_INTEGER });
    runs.set(runId, projectKernelSchedule(current, decision, current.updatedAt));
  }
  return { runs, environments, snapshots };
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function freezeEnvironmentBinding(value: PersistedEnvironmentBinding): PersistedEnvironmentBinding {
  return deepFreezeKernelValue(structuredClone(value));
}

function freezeTurnSnapshot(value: PersistedTurnSnapshot): PersistedTurnSnapshot {
  return deepFreezeKernelValue(structuredClone(value));
}

function deepFreezeKernelValue<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  Object.values(value).forEach((item) => deepFreezeKernelValue(item, seen));
  return Object.freeze(value);
}

function assertNeverKernelCommand(value: never): never {
  throw new AgentJournalError('INVALID_ARGUMENT', `Unknown Kernel command: ${String(value)}`);
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

function digestValue(value: unknown): string {
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
