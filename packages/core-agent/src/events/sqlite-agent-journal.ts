import { validatePreparedIntent, assertPreparedDigest } from '../tools/prepared-invocation.js';
import { validateToolQuestionBundle, validateQuestionCommand, questionCommandDigest } from '../tools/tool-question.js';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, linkSync, unlinkSync, rmdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { types as nodeUtilTypes } from 'node:util';
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';
import {
  assertAuthenticValidatedModelAttempt,
  type ModelContentBlock,
  type ModelProtocolEnvelope,
  type PersistedModelSessionDescriptor,
} from '@dbagent/core-llm';
import {
  assertPortableValue,
  type PortableValue,
  type UsageMode,
} from '@dbagent/shared';
import { snapshotPromptSection } from '../context/prompt-runtime.js';
import { snapshotCapabilityDiscoveryManifest } from '../capability-discovery-manifest.js';
import {
  isAgentEvidenceRef,
  MAX_AGENT_EVIDENCE_REFS,
} from '../evidence-reference.js';
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
  type ReleaseRunLeaseInput,
  type GetTurnLifecycleInput,
  type TurnLifecycleProjection,
  type GetPendingContextCompactionInput,
  type GetRuntimeCommandProjectionInput,
  type PendingContextCompaction,
  type PendingSteering,
  type SteeringRequest,
  type RunLease,
  type RunLeaseReference,
  type RunAncestryProjection,
  type ToolInvocationCommitResult,
  type ToolInvocationJournalCommand,
  type AgentObservationProjection,
  type StartRunCommand,
  type StartTurnCommand,
  type WaitRunEventsInput,
  type WaitRunEventsResult,
} from './agent-journal.js';
import type {
  AgentEvent,
  AgentEventDraft,
  AgentEventPayloadMap,
  AgentEventType,
  AgentResumableState,
  AgentRunState,
  ToolApprovalFact,
  ToolRecoveryClassFact,
  ToolExecutionErrorFact,
  ToolObservationFact,
  ToolPermissionAuditFact,
} from './agent-event.js';
import {
  AGENT_EVENT_SCHEMA_REGISTRY,
  isAgentEventType,
  validateAndSnapshotEventPayload,
  validatePersistedAttempt,
} from './event-schema-registry.js';
import {
  replayAgentEvents,
  type AgentInvocationProjection,
  type AgentRunProjection,
  type AgentTurnProjection,
} from './event-projectors.js';
import { isRuntimeCommandKindOwnedByTool } from '../runtime-command-ownership.js';
import { upcastAgentEvent } from './event-upcasters.js';
import type {
  CommitValidatedAttemptCommand,
  ModelTurnCommitResult,
} from './run-event-committer.js';
import { activeLegacyMigrationIdentity } from '../internal/legacy-migration-writer.js';
import { bindToolLifecycleCommitter } from '../internal/tool-lifecycle-authority.js';
import {
  inspectPreparedToolArtifact,
  type PreparedToolArtifactCommit,
  type PreparedToolArtifactRecord,
} from '../internal/prepared-tool-artifact-authority.js';
import { bindKernelJournalCommitter } from '../internal/kernel-journal-authority.js';
import { bindSessionBindingCommitter } from '../internal/session-binding-authority.js';
import { bindSessionStateCommitter } from '../internal/session-state-authority.js';
import {
  bindSubagentOutcomeCommitter,
  type DurableSubagentOutcomeRecovery,
} from '../internal/subagent-outcome-authority.js';
import { deriveChildAgentIdentity } from '../subagent-pool.js';
import type { AgentSubagentObservation } from '../subagent-pool.js';
import {
  assertAuthenticRuntimeCommand,
  bindRuntimeCommandApplication,
} from '../internal/runtime-command-authority.js';
import {
  bindModelLifecycleJournalApplication,
  type DurableModelLifecycleJournalFact,
  type DurableModelLifecycleJournalCommand,
  type ModelLifecycleJournalCommand,
  type ModelLifecycleJournalResult,
} from '../internal/model-lifecycle-authority.js';

import type {
  RuntimeCommand,
  RuntimeCapabilityActivationBinding,
  RuntimeCommandApplicationResult,
  RuntimeCommandProjection,
  RuntimeSkillActivation,
  RuntimeToolActivation,
} from '../kernel/runtime-command.js';

export type ProjectUsageTotal = Readonly<{
  billingMode: UsageMode;
  windowStartedAt: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}>;

type DurableSubagentOutcomeIdentity = Readonly<{
  commandId: string;
  origin: Readonly<{ runId: string; turnId: string; invocationId: string }>;
  childRunId: string;
  childSessionId: string;
  task: string;
  context: PortableValue;
}>;
import type {
  BindPersistedSessionModelCommand,
  SessionModelBinding,
} from '../kernel/session-model-binding.js';
import type {
  EnvironmentBindingInput,
  FinalizeRunKernelCommand,
  KernelJournalCommand,
  KernelJournalCommitResult,
  KernelRunProjection,
  PersistedContextCheckpoint,
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
import {
  upcastSessionJournalEvent,
  validateSessionJournalPayload,
  type BootstrapSessionCommand,
  type ConfigureSessionSkillsCommand,
  type ListSessionIndexesInput,
  type SessionArchiveProjection,
  type SessionBootstrapProjection,
  type SessionIndexProjection,
  type SessionJournalEvent,
  type SessionJournalEventPayloadMap,
  type SessionJournalEventType,
  type SessionStateProjection,
  type SessionSkillConfiguration,
  type SetSessionArchivedCommand,
} from '../session/session-journal.js';

type NodeDatabaseSyncConstructor = new (location: string, options?: { readOnly?: boolean }) => NodeDatabaseSync;

export type ModelCommitFaultPoint =
  | 'after-model-event-before-attempt'
  | 'after-model-attempt-before-turn'
  | 'after-turn-before-envelope'
  | 'after-envelope-before-invocations'
  | 'after-first-invocation';

export type KernelCommitFaultPoint = 'after-events-before-projection';
export type RuntimeCommandCommitFaultPoint =
  'after-runtime-command-commit-before-response';

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

type SessionIndexRow = {
  project_id: string;
  session_id: string;
  session_kind: 'root' | 'delegated';
  visibility: 'public' | 'internal';
  parent_run_id: string | null;
  parent_session_id: string | null;
  archive_revision: number;
  archived: number;
  title: string | null;
  created_at: string;
  updated_at: string;
  last_activity_sequence: number;
  run_count: number;
};

type CommandRow = { request_digest: string; result_json: string };
type RuntimeCommandRow = CommandRow & { command_kind: string };
type RuntimeCommandReceipt = Readonly<{
  schemaVersion: 1;
  receiptType: 'runtime-command';
  projectId: string;
  sessionId: string;
  runId: string;
  commandId: string;
  commandKind: RuntimeCommand['kind'];
  firstSequence: number;
  lastSequence: number;
  eventCount: number;
  appliedEventId: string;
  runRevision: number;
  projectionRevision: number;
}>;
type ModelLifecycleReceipt = Readonly<{
  schemaVersion: 1;
  receiptType: 'model-lifecycle';
  projectId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  attemptId: string;
  commandId: string;
  factType: ModelLifecycleJournalCommand['fact']['type'];
  eventIds: readonly string[];
  eventSequences: readonly number[];
  runRevision: number;
}>;
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
const MAX_APPROVAL_SUMMARY_CHARS = MAX_TOOL_SUMMARY_CHARS;
const MAX_APPROVAL_REASON_CHARS = 2_000;
const MAX_DECIDED_BY_CHARS = 256;
const MAX_TOOL_RESULT_REFS = 32;
const MAX_SESSION_SKILL_DEFINITIONS = 32;
const MAX_SESSION_SKILL_BYTES = 256 * 1024;
const MAX_SESSION_SKILL_TOTAL_BYTES = 1024 * 1024;
const MAX_SESSION_SKILL_SOURCE_PATH_CHARS = 1_024;
const MAX_RUN_EVENT_WAIT_MS = 300_000;
const RUN_EVENT_POLL_INTERVAL_MS = 100;
const RUNTIME_COMMAND_MAX_ACTIVE_TOOLS = 256;
const RUNTIME_COMMAND_MAX_ACTIVE_SKILLS = 256;
const RUNTIME_COMMAND_MAX_CHILDREN = 256;
const RUNTIME_COMMAND_PROJECTION_MAX_BYTES = 4 * 1024 * 1024;
type JournalWaitListener = () => void;
type JournalWaitBus = { readonly listeners: Set<JournalWaitListener> };
const JOURNAL_WAIT_BUSES = new Map<string, JournalWaitBus>();
const DATABASE_COMMIT_NOTIFIERS = new WeakMap<NodeDatabaseSync, () => void>();
const KERNEL_RESERVED_EVENT_TYPES = new Set<AgentEventType>([
  'run.environment_bound', 'run.started', 'run.resumed', 'run.steered',
  'run.input_requested', 'run.cancel_requested', 'run.limit_reached',
  'run.completed', 'run.failed', 'run.cancelled', 'run.interrupted',
  'turn.started', 'turn.context_compiled', 'turn.no_progress', 'turn.closed',
  'model_attempt_started', 'model_delta_batch', 'model_block_completed',
  'model_attempt_committed', 'model_attempt_discarded', 'model_failed',
  'tool.outcome_resolution_requested',
  'tool.hook_rejected', 'tool.hook_warning',
  'delivery.decided', 'plan.created', 'plan.updated',
  'tool.activated', 'capability.discovered', 'runtime.command_applied',
  'tool.transition_committed',
  'context.compaction_requested', 'context.compaction_started',
  'context.compacted', 'context.compaction_failed',
  'usage.recorded', 'skill.activated', 'capability.snapshot_captured',
  'subagent.started', 'subagent.steered', 'subagent.completed',
  'subagent.failed', 'subagent.cancelled',
]);
const PROJECT_ARTIFACT_HANDLE = /^agent-artifact:[a-f0-9]{24}:[a-f0-9]{40}$/u;
const TOOL_INVOCATION_COMMON_KEYS = [
  'action', 'projectId', 'sessionId', 'runId', 'turnId', 'invocationId',
  'commandId', 'lease', 'expectedRunRevision', 'expectedInvocationRevision',
] as const;
const TOOL_INVOCATION_ACTION_KEYS: Record<ToolInvocationJournalCommand['action'], readonly string[]> = {
  'wait-for-user': ['intentDigest', 'bundle'],
  'settle-question': ['intentDigest', 'questionCommand', 'observation', 'outcome', 'summary', 'resultRefs', 'evidenceRefs', 'durableSummary', 'modelProjection', 'userProjection', 'auditEvidence', 'completionEvidence', 'error', 'interruptedFencingToken', 'hookWarnings'],
  prepare: ['canonicalToolId', 'catalogRevision', 'intent', 'intentDigest', 'deadline'],
  validate: [
    'canonicalToolId', 'toolRevision', 'recoveryClass', 'intentDigest',
    'authorization', 'permissionAudit', 'actionSummary', 'approvalSummary',
  ],
  'reject-validation': ['actionSummary', 'summary', 'error', 'hookRejection'],
  'decide-approval': [
    'approvalId', 'canonicalToolId', 'toolRevision', 'recoveryClass',
    'intentDigest', 'proposedRevision', 'decision', 'decidedBy', 'reason',
  ],
  start: ['intentDigest', 'idempotencyKey', 'attempt', 'permissionAudit', 'recoveryOfFencingToken'],
  progress: ['idempotencyKey', 'attempt', 'summary'],
  finish: [
    'intentDigest',
    'outcome', 'summary', 'resultRefs', 'evidenceRefs', 'durableSummary', 'modelProjection',
    'userProjection', 'auditEvidence', 'completionEvidence', 'error', 'interruptedFencingToken',
    'hookWarnings',
  ],
  observe: ['observation'],
  'authorize-retry': [
    'permitId', 'toolRevision', 'recoveryClass', 'intentDigest', 'reason',
  ],
  'resolve-outcome': [
    'resolutionId', 'outcome', 'canonicalToolId', 'toolRevision', 'recoveryClass',
    'intentDigest', 'proposedRevision', 'summary', 'retryAuthorization',
  ],
};
const TOOL_INVOCATION_OPTIONAL_ACTION_KEYS: Record<
  ToolInvocationJournalCommand['action'], readonly string[]
> = {
  'wait-for-user': [],
  'settle-question': ['evidenceRefs', 'durableSummary', 'modelProjection', 'userProjection', 'auditEvidence', 'completionEvidence', 'error', 'interruptedFencingToken', 'hookWarnings'],
  prepare: [],
  validate: [],
  'reject-validation': ['hookRejection'],
  'decide-approval': ['decidedBy', 'reason'],
  start: ['recoveryOfFencingToken'],
  progress: [],
  finish: [
    'evidenceRefs', 'durableSummary', 'modelProjection', 'userProjection', 'auditEvidence',
    'completionEvidence', 'error',
    'interruptedFencingToken',
    'hookWarnings',
  ],
  observe: [],
  'authorize-retry': [],
  'resolve-outcome': ['retryAuthorization'],
};

export class SqliteAgentJournal implements AgentJournal {
  readonly filePath: string;
  readonly busyTimeoutMs: number;
  readonly #now: () => string;
  readonly #createId: () => string;
  #faultPoint: ModelCommitFaultPoint | undefined;
  #kernelFaultPoint: KernelCommitFaultPoint | undefined;
  #runtimeCommandFaultPoint: RuntimeCommandCommitFaultPoint | undefined;

  constructor(options: SqliteAgentJournalOptions) {
    this.filePath = requireText(options.filePath, 'filePath');
    this.busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    if (!Number.isInteger(this.busyTimeoutMs) || this.busyTimeoutMs < 1 || this.busyTimeoutMs > 60_000) {
      throw new AgentJournalError('INVALID_ARGUMENT', 'busyTimeoutMs must be between 1 and 60000.');
    }
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#createId = options.createId ?? randomUUID;
    bindToolLifecycleCommitter(this, (command, options) =>
      this.#commitToolInvocation(
        command,
        options?.preparedArtifacts,
        options?.runtimeCommand,
      ));
    bindKernelJournalCommitter(this, (command) => this.#commitKernelCommand(command));
    bindSessionBindingCommitter(this, (command) => this.#commitSessionModelBinding(command));
    bindSessionStateCommitter(this, {
      bootstrap: (command) => this.#commitSessionBootstrap(command),
      setArchived: (command) => this.#commitSessionArchive(command),
      configureSkills: (command) => this.#commitSessionSkills(command),
    });
    bindRuntimeCommandApplication(this, (command) => this.#commitRuntimeCommand(command));
    bindSubagentOutcomeCommitter(
      this,
      {
        commitFresh: (command, observation) => this.#commitSubagentOutcome({
          commandId: command.commandId,
          origin: command.origin,
          childRunId: observation.childRunId,
          childSessionId: observation.childSessionId,
          task: command.payload.task,
          context: command.payload.context,
        }, observation),
        commitRecovery: (recovery, observation) => this.#commitSubagentOutcome(recovery, observation),
      },
    );
    bindModelLifecycleJournalApplication(
      this,
      (command) => this.#commitModelLifecycle(command),
    );
  }

  failAt(point: ModelCommitFaultPoint): void {
    this.#faultPoint = point;
  }

  failKernelAt(point: KernelCommitFaultPoint): void {
    this.#kernelFaultPoint = point;
  }

  failRuntimeCommandAt(point: RuntimeCommandCommitFaultPoint): void {
    this.#runtimeCommandFaultPoint = point;
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
    let configuration = snapshot.configuration;
    const requestedRunId = snapshot.runId;
    const parent = snapshot.parent;
    let environment = snapshot.environment;
    if (environment !== undefined) validateEnvironmentBindingInput(environment);
    if (parent !== undefined && requestedRunId === undefined) {
      throw new AgentJournalError(
        'INVALID_ARGUMENT',
        'An explicit child runId must be supplied with parent causality.',
      );
    }
    if (parent !== undefined && !/^child_[a-f0-9]{32}$/u.test(requestedRunId!)) {
      throw new AgentJournalError('INVALID_ARGUMENT', 'Trusted child runId is invalid.');
    }
    if (parent !== undefined && environment !== undefined) {
      throw new AgentJournalError(
        'INVALID_ARGUMENT',
        'A child Run inherits its parent Environment and cannot supply another binding.',
      );
    }
    if (
      parent === undefined && requestedRunId !== undefined && environment === undefined
    ) {
      throw new AgentJournalError(
        'INVALID_ARGUMENT',
        'An explicit top-level runId requires an atomically committed Environment.',
      );
    }
    const digest = digestValue({
      input,
      childRunId: parent === undefined ? null : requestedRunId,
      parent: parent ?? null,
      environment: environment === undefined ? null : {
        settingsRevision: environment.settingsRevision,
        permissionPolicyRevision: environment.permissionPolicyRevision,
        modelSession: environment.modelSession,
      },
      configuration: configuration ?? null,
    });
    return this.#withDatabase((database) =>
      transaction(database, () => {
        if (parent === undefined) {
          const session = readSessionIndexRow(database, projectId, sessionId);
          if (session !== undefined) {
            assertPublicRootSession(session, 'Top-level Run creation');
          }
        }
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

        if (parent === undefined && environment !== undefined) {
          const active = database.prepare(
            `SELECT run_id, state FROM agent_runs
             WHERE project_id = ? AND session_id = ? AND hidden = 0
               AND state NOT IN ('Completed', 'Failed', 'Cancelled')
             ORDER BY created_at ASC, run_id ASC LIMIT 1`,
          ).get(projectId, sessionId) as Readonly<{ run_id: string; state: string }> | undefined;
          if (active !== undefined) {
            throw new AgentJournalError(
              'SESSION_RUN_ACTIVE',
              'A top-level Run is already active for this Session; steer, resume, or finish it first.',
              { activeRunId: active.run_id, state: active.state },
            );
          }
        }

        const runId = requestedRunId ?? `run_${this.#createId()}`;
        const occurredAt = this.#now();
        if (parent !== undefined) requireChildParentEvent(database, projectId, runId, parent);
        const parentSession = parent === undefined ? undefined : database.prepare(
          `SELECT session_id FROM agent_runs WHERE project_id = ? AND run_id = ?`,
        ).get(projectId, parent.runId) as { session_id: string } | undefined;
        if (parent !== undefined && parentSession === undefined) {
          throw new AgentJournalError(
            'PROJECTION_CORRUPT', 'Child Run parent Session is unavailable.',
          );
        }
        if (parent !== undefined) {
          ensureSessionIndex(database, projectId, sessionId, occurredAt, undefined, {
            kind: 'delegated',
            visibility: 'internal',
            parentRunId: parent.runId,
            parentSessionId: parentSession!.session_id,
          });
        }
        if (parent !== undefined) {
          // A child is a new Session with an independent context, but it must
          // inherit the exact persisted ingress and Environment of its parent.
          // Never consult current Runtime settings during this durable splice.
          const parentCreated = database.prepare(
            `SELECT payload_json FROM agent_events
             WHERE project_id = ? AND run_id = ? AND event_type = 'run.created'
             ORDER BY sequence ASC LIMIT 1`,
          ).get(projectId, parent.runId) as { payload_json: string } | undefined;
          const parentBinding = database.prepare(
            `SELECT payload_json FROM agent_environment_bindings
             WHERE project_id = ? AND run_id = ? ORDER BY created_at ASC LIMIT 1`,
          ).get(projectId, parent.runId) as { payload_json: string } | undefined;
          if (parentCreated === undefined || parentBinding === undefined) {
            throw new AgentJournalError(
              'PROJECTION_CORRUPT', 'Child Run parent has no durable ingress Environment.',
            );
          }
          const parentPayload = JSON.parse(parentCreated.payload_json) as { configuration?: CreateRunCommand['configuration'] };
          if (parentPayload.configuration === undefined) {
            configuration = undefined;
          } else {
            // The parent's public ingress request digest is not a child fact.
            // Preserve only the frozen policy/prompt layers; child.start and
            // its causal identity remain the child's durable ingress identity.
            const { clientRequestDigest, ...inheritedConfiguration } =
              structuredClone(parentPayload.configuration);
            void clientRequestDigest;
            configuration = inheritedConfiguration;
          }
          const inherited = JSON.parse(parentBinding.payload_json) as EnvironmentBindingInput;
          environment = {
            ...structuredClone(inherited),
            environmentBindingId: `environment_${runId}`,
          };
        }
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
            ...(configuration === undefined ? {} : { configuration }),
            ...(migrationIdentity === undefined ? {} : {
              visibility: 'legacy-import-carrier' as const,
            }),
            ...(parent === undefined ? {} : { parent: structuredClone(parent) }),
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
        const parentAncestry = parent === undefined ? undefined : database.prepare(
          `SELECT root_run_id, depth FROM agent_run_ancestry
           WHERE project_id = ? AND run_id = ?`,
        ).get(projectId, parent.runId) as { root_run_id: string; depth: number } | undefined;
        if (parent !== undefined && parentAncestry === undefined) {
          throw new AgentJournalError('PROJECTION_CORRUPT', 'Parent Run ancestry is unavailable.');
        }
        database.prepare(
          `INSERT INTO agent_run_ancestry
             (project_id, run_id, parent_run_id, root_run_id, depth, root_child_ordinal)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          projectId, runId, parent?.runId ?? null, parentAncestry?.root_run_id ?? runId,
          parentAncestry === undefined ? 0 : Number(parentAncestry.depth) + 1,
          parentAncestry === undefined ? 0 : Number((database.prepare(
            `SELECT COUNT(*) AS count FROM agent_run_ancestry
             WHERE project_id = ? AND root_run_id = ? AND run_id <> ?`,
          ).get(projectId, parentAncestry.root_run_id, parentAncestry.root_run_id) as { count: number }).count) + 1,
        );
        if (environment !== undefined) {
          const environmentDigest = digestValue(environment);
          const persistedEnvironment = freezeEnvironmentBinding({
            schemaVersion: 1,
            environmentBindingId: environment.environmentBindingId,
            projectId,
            sessionId,
            runId,
            digest: environmentDigest,
            payload: environment,
            createdAt: occurredAt,
          });
          database.prepare(
            `INSERT INTO agent_environment_bindings (
              environment_binding_id, project_id, session_id, run_id, schema_version,
              digest, payload_json, created_at
            ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
          ).run(
            persistedEnvironment.environmentBindingId, projectId, sessionId, runId,
            persistedEnvironment.digest, JSON.stringify(persistedEnvironment.payload), occurredAt,
          );
          this.#appendEvent(database, {
            projectId,
            sessionId,
            runId,
            type: 'run.environment_bound',
            payload: {
              environmentBindingId: persistedEnvironment.environmentBindingId,
              digest: persistedEnvironment.digest,
              binding: persistedEnvironment.payload,
            },
            parentEventId: createdEvent.eventId,
            occurredAt,
          });
          persistKernelRunProjection(database, createKernelRunProjection({
            projectId,
            sessionId,
            runId,
            environmentBindingId: persistedEnvironment.environmentBindingId,
            createdAt: occurredAt,
          }));
        }
        if (parent !== undefined) {
          const parentSkills = parentSession === undefined ? undefined : database.prepare(
            `SELECT payload_json FROM agent_session_skill_configurations
             WHERE project_id = ? AND session_id = ?`,
          ).get(projectId, parentSession.session_id) as { payload_json: string } | undefined;
          const inheritedSkills = parentSkills === undefined
            ? { schemaVersion: 1 as const, projectId, sessionId: parentSession!.session_id,
                revision: 1, definitions: [], updatedAt: occurredAt }
            : parsePortableJson(parentSkills.payload_json) as unknown as SessionSkillConfiguration;
          const childSkills: SessionSkillConfiguration = deepFreezeKernelValue({
            ...structuredClone(inheritedSkills), projectId, sessionId, updatedAt: occurredAt,
          });
          ensureSessionIndex(database, projectId, sessionId, occurredAt);
          this.#appendSessionEvent(database, {
            projectId, sessionId, type: 'session.skills_configured',
            payload: { revision: childSkills.revision, definitions: structuredClone(childSkills.definitions) },
            occurredAt,
          });
          database.prepare(
            `INSERT INTO agent_session_skill_configurations (
               project_id, session_id, revision, payload_json, updated_at
             ) VALUES (?, ?, ?, ?, ?)`,
          ).run(projectId, sessionId, childSkills.revision, JSON.stringify(childSkills), occurredAt);
        }
        if (migrationIdentity !== undefined) {
          database.prepare(
            `DELETE FROM agent_sessions
             WHERE project_id = ? AND session_id = ? AND run_count = 0
               AND NOT EXISTS (
                 SELECT 1 FROM agent_session_model_bindings AS binding
                 WHERE binding.project_id = agent_sessions.project_id
                   AND binding.session_id = agent_sessions.session_id
               )`,
          ).run(projectId, sessionId);
        }
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
    command: BindPersistedSessionModelCommand,
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
      const session = readSessionIndexRow(database, snapshot.projectId, snapshot.sessionId);
      if (session !== undefined) {
        assertPublicRootSession(session, 'Session model binding');
      }
      const currentRevision = current?.revision ?? 0;
      if (currentRevision !== snapshot.expectedRevision) {
        throw new AgentJournalError('REVISION_CONFLICT', 'Session model binding revision changed.');
      }
      const nextRevision = currentRevision + 1;
      const occurredAt = this.#now();
      const binding: SessionModelBinding = deepFreezeKernelValue({
        schemaVersion: 1, projectId: snapshot.projectId, sessionId: snapshot.sessionId,
        revision: nextRevision, model: snapshot.model, updatedAt: occurredAt,
      });
      const primary = snapshot.model.descriptor.primary;
      this.#appendSessionEvent(database, {
        projectId: snapshot.projectId,
        sessionId: snapshot.sessionId,
        type: 'session.model_bound',
        payload: binding,
        occurredAt,
      });
      ensureSessionIndex(database, snapshot.projectId, snapshot.sessionId, occurredAt);
      database.prepare(
        `INSERT INTO agent_session_model_bindings (
          project_id, session_id, revision, connection_id, model_id, payload_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, session_id) DO UPDATE SET
          revision = excluded.revision, connection_id = excluded.connection_id,
          model_id = excluded.model_id, payload_json = excluded.payload_json,
          updated_at = excluded.updated_at`,
      ).run(
        snapshot.projectId, snapshot.sessionId, nextRevision, primary.route.connectionId,
        primary.route.modelId, JSON.stringify(binding), occurredAt,
      );
      touchSessionIndex(database, snapshot.projectId, snapshot.sessionId, occurredAt, 0);
      writeCommandResult(
        database, snapshot.projectId, snapshot.commandId, 'session.model-bind',
        requestDigest, binding, occurredAt,
      );
      return binding;
    }));
  }

  async #commitSessionBootstrap(
    command: BootstrapSessionCommand,
  ): Promise<SessionBootstrapProjection> {
    const bindingCommand = snapshotSessionBindingCommand({
      projectId: command.projectId,
      sessionId: command.sessionId,
      commandId: command.commandId,
      expectedRevision: command.expectedModelRevision,
      model: command.model,
    });
    const skillsCommand = snapshotSessionSkillsCommand({
      projectId: command.projectId,
      sessionId: command.sessionId,
      commandId: command.commandId,
      expectedRevision: command.expectedSkillRevision,
      definitions: command.definitions,
    });
    if (bindingCommand.expectedRevision !== 0 || skillsCommand.expectedRevision !== 0) {
      throw new AgentJournalError(
        'INVALID_ARGUMENT', 'Session bootstrap only creates a previously unbound Session.',
      );
    }
    const snapshot = deepFreezeKernelValue({
      projectId: bindingCommand.projectId,
      sessionId: bindingCommand.sessionId,
      commandId: bindingCommand.commandId,
      expectedModelRevision: 0 as const,
      expectedSkillRevision: 0 as const,
      model: bindingCommand.model,
      definitions: skillsCommand.definitions,
    });
    const requestDigest = digestValue(snapshot);
    await Promise.resolve();
    return this.#withDatabase((database) => transaction(database, () => {
      const replay = readSessionCommandResult<SessionBootstrapProjection>(
        database, snapshot.projectId, snapshot.commandId, requestDigest,
      );
      if (replay !== undefined) return deepFreezeKernelValue(replay);
      const session = readSessionIndexRow(database, snapshot.projectId, snapshot.sessionId);
      if (session !== undefined) {
        assertPublicRootSession(session, 'Session bootstrap');
      }
      const existingModel = database.prepare(
        `SELECT 1 FROM agent_session_model_bindings WHERE project_id = ? AND session_id = ?`,
      ).get(snapshot.projectId, snapshot.sessionId);
      const existingSkills = database.prepare(
        `SELECT 1 FROM agent_session_skill_configurations WHERE project_id = ? AND session_id = ?`,
      ).get(snapshot.projectId, snapshot.sessionId);
      if (existingModel !== undefined || existingSkills !== undefined) {
        throw new AgentJournalError(
          'REVISION_CONFLICT', 'Session bootstrap lost a concurrent creation race.',
        );
      }
      const occurredAt = this.#now();
      const modelBinding: SessionModelBinding = deepFreezeKernelValue({
        schemaVersion: 1,
        projectId: snapshot.projectId,
        sessionId: snapshot.sessionId,
        revision: 1,
        model: snapshot.model,
        updatedAt: occurredAt,
      });
      const skillConfiguration: SessionSkillConfiguration = deepFreezeKernelValue({
        schemaVersion: 1,
        projectId: snapshot.projectId,
        sessionId: snapshot.sessionId,
        revision: 1,
        definitions: structuredClone(snapshot.definitions),
        updatedAt: occurredAt,
      });
      const primary = snapshot.model.descriptor.primary;
      this.#appendSessionEvent(database, {
        projectId: snapshot.projectId,
        sessionId: snapshot.sessionId,
        type: 'session.model_bound',
        payload: modelBinding,
        occurredAt,
      });
      this.#appendSessionEvent(database, {
        projectId: snapshot.projectId,
        sessionId: snapshot.sessionId,
        type: 'session.skills_configured',
        payload: { revision: 1, definitions: structuredClone(snapshot.definitions) },
        occurredAt,
      });
      ensureSessionIndex(database, snapshot.projectId, snapshot.sessionId, occurredAt);
      database.prepare(
        `INSERT INTO agent_session_model_bindings (
          project_id, session_id, revision, connection_id, model_id, payload_json, updated_at
        ) VALUES (?, ?, 1, ?, ?, ?, ?)`,
      ).run(
        snapshot.projectId,
        snapshot.sessionId,
        primary.route.connectionId,
        primary.route.modelId,
        JSON.stringify(modelBinding),
        occurredAt,
      );
      database.prepare(
        `INSERT INTO agent_session_skill_configurations (
          project_id, session_id, revision, payload_json, updated_at
        ) VALUES (?, ?, 1, ?, ?)`,
      ).run(
        snapshot.projectId,
        snapshot.sessionId,
        JSON.stringify(skillConfiguration),
        occurredAt,
      );
      touchSessionIndex(database, snapshot.projectId, snapshot.sessionId, occurredAt, 0);
      const result = deepFreezeKernelValue({ modelBinding, skillConfiguration });
      writeCommandResult(
        database,
        snapshot.projectId,
        snapshot.commandId,
        'session.bootstrap',
        requestDigest,
        result,
        occurredAt,
      );
      return result;
    }));
  }

  async #commitSessionArchive(
    command: SetSessionArchivedCommand,
  ): Promise<SessionArchiveProjection> {
    const snapshot = snapshotSessionArchiveCommand(command);
    await Promise.resolve();
    const requestDigest = digestValue(snapshot);
    return this.#withDatabase((database) => transaction(database, () => {
      const replay = readSessionCommandResult<SessionArchiveProjection>(
        database, snapshot.projectId, snapshot.commandId, requestDigest,
      );
      if (replay !== undefined) return deepFreezeKernelValue(replay);
      const current = readSessionIndexRow(database, snapshot.projectId, snapshot.sessionId);
      if (current === undefined) {
        throw new AgentJournalError('SESSION_NOT_FOUND', `Session not found: ${snapshot.sessionId}`);
      }
      assertPublicRootSession(current, 'Session archive update');
      if (current.archive_revision !== snapshot.expectedRevision) {
        throw new AgentJournalError('REVISION_CONFLICT', 'Session archive revision changed.');
      }
      const revision = current.archive_revision + 1;
      const occurredAt = this.#now();
      this.#appendSessionEvent(database, {
        projectId: snapshot.projectId,
        sessionId: snapshot.sessionId,
        type: 'session.archive_set',
        payload: { revision, archived: snapshot.archived },
        occurredAt,
      });
      const update = database.prepare(
        `UPDATE agent_sessions
         SET archive_revision = ?, archived = ?, updated_at = ?
         WHERE project_id = ? AND session_id = ? AND archive_revision = ?`,
      ).run(
        revision, snapshot.archived ? 1 : 0, occurredAt,
        snapshot.projectId, snapshot.sessionId, snapshot.expectedRevision,
      );
      if (Number(update.changes) !== 1) {
        throw new AgentJournalError('REVISION_CONFLICT', 'Concurrent Session archive update won.');
      }
      const result: SessionArchiveProjection = deepFreezeKernelValue({
        schemaVersion: 1,
        projectId: snapshot.projectId,
        sessionId: snapshot.sessionId,
        revision,
        archived: snapshot.archived,
        updatedAt: occurredAt,
      });
      writeCommandResult(
        database, snapshot.projectId, snapshot.commandId, 'session.archive-set',
        requestDigest, result, occurredAt,
      );
      return result;
    }));
  }

  async #commitSessionSkills(
    command: ConfigureSessionSkillsCommand,
  ): Promise<SessionSkillConfiguration> {
    const snapshot = snapshotSessionSkillsCommand(command);
    await Promise.resolve();
    const requestDigest = digestValue(snapshot);
    return this.#withDatabase((database) => transaction(database, () => {
      const replay = readSessionCommandResult<SessionSkillConfiguration>(
        database, snapshot.projectId, snapshot.commandId, requestDigest,
      );
      if (replay !== undefined) return deepFreezeKernelValue(replay);
      const session = readSessionIndexRow(database, snapshot.projectId, snapshot.sessionId);
      if (session === undefined) {
        throw new AgentJournalError('SESSION_NOT_FOUND', `Session not found: ${snapshot.sessionId}`);
      }
      assertPublicRootSession(session, 'Session Skill configuration');
      const current = database.prepare(
        `SELECT revision FROM agent_session_skill_configurations
         WHERE project_id = ? AND session_id = ?`,
      ).get(snapshot.projectId, snapshot.sessionId) as { revision: number } | undefined;
      const currentRevision = current?.revision ?? 0;
      if (currentRevision !== snapshot.expectedRevision) {
        throw new AgentJournalError('REVISION_CONFLICT', 'Session Skill revision changed.');
      }
      const revision = currentRevision + 1;
      const occurredAt = this.#now();
      const result: SessionSkillConfiguration = deepFreezeKernelValue({
        schemaVersion: 1,
        projectId: snapshot.projectId,
        sessionId: snapshot.sessionId,
        revision,
        definitions: structuredClone(snapshot.definitions),
        updatedAt: occurredAt,
      });
      this.#appendSessionEvent(database, {
        projectId: snapshot.projectId,
        sessionId: snapshot.sessionId,
        type: 'session.skills_configured',
        payload: { revision, definitions: structuredClone(snapshot.definitions) },
        occurredAt,
      });
      database.prepare(
        `INSERT INTO agent_session_skill_configurations (
           project_id, session_id, revision, payload_json, updated_at
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id, session_id) DO UPDATE SET
           revision = excluded.revision,
           payload_json = excluded.payload_json,
           updated_at = excluded.updated_at`,
      ).run(
        snapshot.projectId, snapshot.sessionId, revision, JSON.stringify(result), occurredAt,
      );
      touchSessionIndex(database, snapshot.projectId, snapshot.sessionId, occurredAt, 0);
      writeCommandResult(
        database, snapshot.projectId, snapshot.commandId, 'session.skills-configure',
        requestDigest, result, occurredAt,
      );
      return result;
    }));
  }

  async #commitRuntimeCommand(
    command: RuntimeCommand,
  ): Promise<RuntimeCommandApplicationResult> {
    const snapshot = structuredClone(command);
    await Promise.resolve();
    const result = this.#withDatabase((database) => transaction(database, () =>
      this.#applyRuntimeCommandInTransaction(database, snapshot).result));
    this.#injectRuntimeCommand('after-runtime-command-commit-before-response');
    return result;
  }

  #applyRuntimeCommandInTransaction(
    database: NodeDatabaseSync,
    snapshot: RuntimeCommand,
  ): Readonly<{ result: RuntimeCommandApplicationResult; replayed: boolean }> {
    const requestDigest = digestValue(snapshot);
    const invocation = readInvocationProjection(database, snapshot.origin.invocationId);
    if (invocation === null) {
      throw new AgentJournalError(
        'INVOCATION_NOT_FOUND',
        `Invocation not found: ${snapshot.origin.invocationId}`,
      );
    }
    let replay: RuntimeCommandApplicationResult | undefined;
    try {
      replay = readRuntimeCommandApplicationResult(
        database,
        invocation,
        snapshot,
        requestDigest,
      );
    } catch (error) {
      if (error instanceof AgentJournalError && error.code === 'COMMAND_CONFLICT') {
        throw new AgentJournalError(
          'IDEMPOTENCY_CONFLICT',
          'Runtime commandId was already applied with a different command digest.',
        );
      }
      throw error;
    }
    if (replay !== undefined) {
      return Object.freeze({
        result: freezeRuntimeCommandApplicationResult(replay),
        replayed: true,
      });
    }
    if (
      invocation.runId !== snapshot.origin.runId ||
      invocation.turnId !== snapshot.origin.turnId
    ) {
      throw new AgentJournalError(
        'COMMAND_CONFLICT',
        'Runtime Command origin does not match its Invocation Run and Turn.',
      );
    }
    if (invocation.state !== 'started' || invocation.started === undefined) {
      throw new AgentJournalError(
        'INVOCATION_STATE_CONFLICT',
        'Runtime Commands can be applied only by an actively started Invocation.',
      );
    }
    this.#assertRun(
      database, invocation.projectId, invocation.sessionId, invocation.runId,
    );
    assertRuntimeCommandFence(database, invocation, snapshot, Date.parse(this.#now()));
    const runRevision = resolveRuntimeCommandRunRevision(database, invocation, snapshot);
    const currentRun = readKernelRunProjection(database, invocation.runId);
    if (currentRun.revision !== runRevision) {
      throw new AgentJournalError(
        'PROJECTION_CORRUPT', 'Runtime Command Run revision resolution disagrees.',
      );
    }
    const currentProjection = readRuntimeCommandProjection(database, {
        projectId: invocation.projectId,
        sessionId: invocation.sessionId,
        runId: invocation.runId,
    }) ?? createRuntimeCommandProjection(invocation);
    const applied = applyRuntimeCommandProjection(currentProjection, snapshot);
    assertRuntimeCommandProjectionAdmission(applied.projection);
    const occurredAt = this.#now();
    const events: AgentEvent[] = [];
    let parentEventId: string | undefined;
    for (const fact of runtimeCommandDomainFacts(snapshot, applied.effect)) {
      const event = this.#appendEvent(database, {
        projectId: invocation.projectId,
        sessionId: invocation.sessionId,
        runId: invocation.runId,
        turnId: invocation.turnId,
        attemptId: invocation.attemptId,
        invocationId: invocation.invocationId,
        ...(parentEventId === undefined ? {} : { parentEventId }),
        type: fact.type,
        payload: fact.payload,
        occurredAt,
      });
      events.push(event);
      parentEventId = event.eventId;
    }
    const appliedEvent = this.#appendEvent(database, {
      projectId: invocation.projectId,
      sessionId: invocation.sessionId,
      runId: invocation.runId,
      turnId: invocation.turnId,
      attemptId: invocation.attemptId,
      invocationId: invocation.invocationId,
      ...(parentEventId === undefined ? {} : { parentEventId }),
      type: 'runtime.command_applied',
      payload: {
        commandId: snapshot.commandId,
        kind: snapshot.kind,
        origin: snapshot.origin,
        expectedRunRevision: snapshot.expectedRunRevision,
        fencingToken: snapshot.fencingToken,
        projectionRevision: applied.projection.revision,
        effect: applied.effect,
      },
      occurredAt,
    });
    events.push(appliedEvent);
    const nextRun = projectKernelRunEvent(currentRun, appliedEvent);
    persistKernelRunProjectionCas(
      database,
      currentRun,
      nextRun,
      runRevision,
      'Concurrent Runtime Command won the Run revision race.',
    );
    advanceToolRunWindow(database, invocation.runId, invocation.turnId, runRevision);
    persistRuntimeCommandProjection(database, applied.projection, occurredAt);
    const committed = freezeRuntimeCommandApplicationResult({
      events,
      run: readKernelRunProjection(database, invocation.runId),
      projection: applied.projection,
    });
    const receipt = createRuntimeCommandReceipt(snapshot, invocation, committed);
    // The API result and every later replay come from the same immutable facts.
    const result = rebuildRuntimeCommandApplicationResult(database, receipt, snapshot);
    writeCommandResult(
      database,
      invocation.projectId,
      snapshot.commandId,
      `runtime.${snapshot.kind}`,
      requestDigest,
      receipt,
      occurredAt,
    );
    return Object.freeze({ result, replayed: false });
  }

  async #commitSubagentOutcome(
    identity: DurableSubagentOutcomeIdentity | DurableSubagentOutcomeRecovery,
    observation: AgentSubagentObservation,
  ): Promise<AgentEvent<'subagent.completed' | 'subagent.failed' | 'subagent.cancelled'>> {
    const snapshot = structuredClone(observation);
    await Promise.resolve();
    return this.#withDatabase((database) => transaction(database, () => {
      const invocation = readInvocationProjection(database, identity.origin.invocationId);
      if (
        invocation === null || invocation.runId !== identity.origin.runId ||
        invocation.turnId !== identity.origin.turnId ||
        (invocation.state !== 'started' && invocation.state !== 'succeeded' && invocation.state !== 'observed')
      ) {
        throw new AgentJournalError(
          'INVOCATION_STATE_CONFLICT',
          'Subagent outcome does not belong to its successful parent Invocation.',
        );
      }
      if (
        snapshot.parentRunId !== identity.origin.runId ||
        snapshot.parentInvocationId !== identity.origin.invocationId ||
        snapshot.childRunId !== identity.childRunId ||
        snapshot.childSessionId !== identity.childSessionId
      ) {
        throw new AgentJournalError('COMMAND_CONFLICT', 'Subagent outcome causality is invalid.');
      }
      const child = readKernelRunProjection(database, snapshot.childRunId);
      if (child.projectId !== invocation.projectId || child.sessionId !== snapshot.childSessionId) {
        throw new AgentJournalError('COMMAND_CONFLICT', 'Subagent outcome child scope is invalid.');
      }
      const expectedStatus = childOutcomeStatus(child.state);
      if (snapshot.status !== expectedStatus) {
        throw new AgentJournalError('COMMAND_CONFLICT', 'Subagent outcome disagrees with child state.');
      }
      const existing = database.prepare(
        `SELECT * FROM agent_events
         WHERE project_id = ? AND run_id = ? AND invocation_id = ?
           AND event_type IN ('subagent.completed', 'subagent.failed', 'subagent.cancelled')
         ORDER BY sequence ASC LIMIT 1`,
      ).get(invocation.projectId, invocation.runId, invocation.invocationId) as EventRow | undefined;
      const type = childOutcomeEventType(snapshot.status);
      const payload = childOutcomePayload(snapshot);
      const projection = readRuntimeCommandProjection(database, {
        projectId: invocation.projectId, sessionId: invocation.sessionId, runId: invocation.runId,
      });
      if (projection === null) throw new AgentJournalError('PROJECTION_CORRUPT', 'Subagent parent projection is missing.');
      const childIndex = projection.children.findIndex((entry) => entry.childRunId === snapshot.childRunId);
      if (childIndex < 0) throw new AgentJournalError('PROJECTION_CORRUPT', 'Subagent child projection is missing.');
      const currentChild = projection.children[childIndex]!;
      if (
        currentChild.parentRunId !== identity.origin.runId ||
        currentChild.parentInvocationId !== identity.origin.invocationId ||
        currentChild.task !== identity.task ||
        canonicalJson(currentChild.context) !== canonicalJson(identity.context)
      ) {
        throw new AgentJournalError(
          'COMMAND_CONFLICT', 'Subagent outcome command does not match durable child facts.',
        );
      }
      if (
        currentChild.startCommandId !== undefined &&
        currentChild.startCommandId !== identity.commandId
      ) {
        throw new AgentJournalError(
          'COMMAND_CONFLICT', 'Subagent outcome command does not own this child projection.',
        );
      }
      const terminalProjection = currentChild.status === snapshot.status
        ? projection
        : {
            ...projection,
            revision: projection.revision + 1,
            children: projection.children.map((entry, index) => index === childIndex
              ? {
                  ...entry,
                  revision: entry.revision + 1,
                  status: snapshot.status,
                  ...(snapshot.status === 'cancelled'
                    ? { reason: entry.reason ?? snapshot.summary }
                    : {}),
                }
              : entry),
          } as RuntimeCommandProjection;
      if (existing !== undefined) {
        const event = eventFromRow(existing);
        if (event.type !== type || canonicalJson(event.payload) !== canonicalJson(payload)) {
          throw new AgentJournalError('IDEMPOTENCY_CONFLICT', 'Subagent terminal fact conflicts.');
        }
        // A crash may have persisted the immutable outcome before its derived
        // Runtime Command projection. Reconcile only that projection; never
        // create another terminal fact or advance the child Run.
        if (terminalProjection !== projection) {
          persistRuntimeCommandProjection(database, terminalProjection, this.#now());
        }
        return event;
      }
      if (terminalProjection !== projection) {
        persistRuntimeCommandProjection(database, terminalProjection, this.#now());
      }
      const candidates = database.prepare(
        `SELECT * FROM agent_events
         WHERE project_id = ? AND run_id = ? AND invocation_id = ?
           AND event_type = 'runtime.command_applied'
         ORDER BY sequence ASC`,
      ).all(invocation.projectId, invocation.runId, invocation.invocationId) as EventRow[];
      const parent = candidates.map(eventFromRow).find((event) =>
        event.type === 'runtime.command_applied' &&
        event.payload.commandId === identity.commandId && event.payload.kind === 'child.start',
      );
      if (parent === undefined) {
        throw new AgentJournalError('PROJECTION_CORRUPT', 'Subagent start command fact is missing.');
      }
      return this.#appendEvent(database, {
        projectId: invocation.projectId,
        sessionId: invocation.sessionId,
        runId: invocation.runId,
        turnId: invocation.turnId,
        attemptId: invocation.attemptId,
        invocationId: invocation.invocationId,
        parentEventId: parent.eventId,
        type,
        payload,
        occurredAt: this.#now(),
      }) as AgentEvent<'subagent.completed' | 'subagent.failed' | 'subagent.cancelled'>;
    }));
  }

  async #commitModelLifecycle(
    command: DurableModelLifecycleJournalCommand,
  ): Promise<ModelLifecycleJournalResult> {
    const snapshot = snapshotModelLifecycleCommand(command);
    await Promise.resolve();
    const requestDigest = digestValue(snapshot);
    return this.#withDatabase((database) => transaction(database, () => {
      const replay = readModelLifecycleResult(database, snapshot, requestDigest);
      if (replay !== undefined) return replay;
      this.#assertRun(database, snapshot.projectId, snapshot.sessionId, snapshot.runId);
      this.#assertLease(database, snapshot.projectId, snapshot.runId, snapshot.lease);
      const contextUsage = snapshot.fact.type === 'usage-observed' &&
        snapshot.fact.purpose === 'context-compaction';
      const runRevision = contextUsage
        ? resolveContextCompactionRunRevision(
            database,
            snapshot as Extract<
              DurableModelLifecycleJournalCommand,
              { fact: { type: 'usage-observed'; purpose: 'context-compaction' } }
            >,
          )
        : resolveModelRunWindowRevision(database, {
            projectId: snapshot.projectId,
            sessionId: snapshot.sessionId,
            runId: snapshot.runId,
            turnId: snapshot.turnId,
            attemptId: snapshot.attemptId,
            expectedRunRevision: snapshot.expectedRunRevision,
          }, false);
      const lifecycle = database.prepare(
        `SELECT project_id, session_id, run_id, status
         FROM agent_turn_lifecycles WHERE turn_id = ?`,
      ).get(snapshot.turnId) as Readonly<{
        project_id: string;
        session_id: string;
        run_id: string;
        status: string;
      }> | undefined;
      if (
        lifecycle === undefined || lifecycle.project_id !== snapshot.projectId ||
        lifecycle.session_id !== snapshot.sessionId || lifecycle.run_id !== snapshot.runId ||
        lifecycle.status !== 'started'
      ) {
        throw new AgentJournalError(
          'MODEL_COMMIT_CONFLICT',
          'Model lifecycle fact does not belong to the exact active Turn.',
        );
      }
      const started = contextUsage ? undefined : database.prepare(
        `SELECT event_id FROM agent_events
         WHERE project_id = ? AND session_id = ? AND run_id = ? AND turn_id = ?
           AND attempt_id = ? AND event_type = 'model_attempt_started'
         ORDER BY sequence DESC LIMIT 1`,
      ).get(
        snapshot.projectId,
        snapshot.sessionId,
        snapshot.runId,
        snapshot.turnId,
        snapshot.attemptId,
      ) as { event_id: string } | undefined;
      if (!contextUsage && started === undefined) {
        throw new AgentJournalError(
          'PROJECTION_CORRUPT',
          'Active Model Attempt has no durable start fact.',
        );
      }
      // Provider clocks are diagnostic input only; Journal commit time owns durable ordering.
      const occurredAt = this.#now();
      const events: AgentEvent[] = [];
      if (snapshot.fact.type === 'model-delta-batch') {
        events.push(this.#appendEvent(database, {
          projectId: snapshot.projectId,
          sessionId: snapshot.sessionId,
          runId: snapshot.runId,
          turnId: snapshot.turnId,
          attemptId: snapshot.attemptId,
          parentEventId: started!.event_id,
          type: 'model_delta_batch',
          payload: modelDeltaBatchPayload(snapshot.fact),
          occurredAt,
        }));
      } else if (snapshot.fact.type === 'block-completed') {
        events.push(this.#appendEvent(database, {
          projectId: snapshot.projectId,
          sessionId: snapshot.sessionId,
          runId: snapshot.runId,
          turnId: snapshot.turnId,
          attemptId: snapshot.attemptId,
          parentEventId: started!.event_id,
          type: 'model_block_completed',
          payload: {
            block: structuredClone(snapshot.fact.block),
            ...(snapshot.fact.block.type === 'tool-call-draft'
              ? { draftCallKey: snapshot.fact.block.draftCallKey }
              : {}),
          },
          occurredAt,
        }));
      } else {
        const payload = modelUsagePayload(snapshot);
        if (!usageAlreadyPersisted(database, payload)) {
          const event = this.#appendEvent(database, {
            projectId: snapshot.projectId,
            sessionId: snapshot.sessionId,
            runId: snapshot.runId,
            turnId: snapshot.turnId,
            attemptId: snapshot.attemptId,
            ...(started === undefined ? {} : { parentEventId: started.event_id }),
            type: 'usage.recorded',
            payload,
            occurredAt,
          });
          persistUsageEvents(database, [event]);
          events.push(event);
        }
      }
      const result = deepFreezeKernelValue({
        events: Object.freeze(events),
        runRevision,
      });
      writeCommandResult(
        database,
        snapshot.projectId,
        snapshot.commandId,
        `model-lifecycle.${snapshot.fact.type}`,
        requestDigest,
        modelLifecycleReceipt(snapshot, result),
        occurredAt,
      );
      return result;
    }));
  }

  async commit(command: JournalCommand): Promise<JournalCommitResult> {
    await Promise.resolve();
    const identity = activeLegacyMigrationIdentity(this);
    const snapshot = snapshotJournalCommand(command);
    if (
      identity === undefined &&
      snapshot.events.some(({ type }) => KERNEL_RESERVED_EVENT_TYPES.has(type))
    ) {
      throw new AgentJournalError(
        'COMMITTER_REQUIRED',
        'Kernel lifecycle facts require the sealed RunController committer.',
      );
    }
    const normalized = validateJournalCommand(snapshot, identity !== undefined);
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
    preparedCapabilities: readonly PreparedToolArtifactCommit[] | undefined,
    runtimeCommandCapability: RuntimeCommand | undefined,
  ): Promise<ToolInvocationCommitResult> {
    const preparedArtifacts = snapshotPreparedToolArtifacts(preparedCapabilities);
    if (runtimeCommandCapability !== undefined) {
      assertAuthenticRuntimeCommand(runtimeCommandCapability);
    }
    const runtimeCommand = runtimeCommandCapability === undefined
      ? undefined
      : structuredClone(runtimeCommandCapability);
    const snapshot = snapshotToolInvocationCommand(command);
    await Promise.resolve();
    const normalized = normalizeToolInvocationCommand(snapshot);
    if (
      runtimeCommand !== undefined && (
        normalized.action !== 'finish' || normalized.outcome !== 'succeeded' ||
        runtimeCommand.commandId !== `runtime-command:${normalized.invocationId}` ||
        runtimeCommand.origin.runId !== normalized.runId ||
        runtimeCommand.origin.turnId !== normalized.turnId ||
        runtimeCommand.origin.invocationId !== normalized.invocationId ||
        runtimeCommand.fencingToken !== normalized.lease.fencingToken
      )
    ) {
      throw new AgentJournalError(
        'INVALID_ARGUMENT',
        'Atomic Runtime Command must match an exact successful Tool finish.',
      );
    }
    validatePreparedToolArtifacts(normalized, preparedArtifacts, this);
    const requestDigest = digestValue({
      command: toolInvocationCommandIdentity(normalized),
      artifacts: preparedArtifacts.map(preparedToolArtifactIdentity),
      runtimeCommand: runtimeCommand ?? null,
    });
    return this.#withDatabase((database) => transaction(database, () => {
      const replay = readCommandResult<ToolInvocationCommitResult>(
        database, normalized.projectId, normalized.commandId, requestDigest,
      );
      if (replay !== undefined) return replay;
      this.#assertRun(
        database, normalized.projectId, normalized.sessionId, normalized.runId,
      );
      this.#assertLease(database, normalized.projectId, normalized.runId, normalized.lease);
      const invocation = readInvocationProjection(database, normalized.invocationId);
      if (invocation === null) {
        throw new AgentJournalError(
          'INVOCATION_NOT_FOUND', `Invocation not found: ${normalized.invocationId}`,
        );
      }
      assertInvocationBinding(invocation, normalized);
      if (runtimeCommand !== undefined && !isRuntimeCommandKindOwnedByTool(invocation.name, runtimeCommand.kind)) {
        throw new AgentJournalError(
          'INVALID_ARGUMENT',
          `Tool ${invocation.name} is not authorized to commit Runtime Command ${runtimeCommand.kind}.`,
        );
      }
      if (invocation.revision !== normalized.expectedInvocationRevision) {
        throw new AgentJournalError(
          'REVISION_CONFLICT', 'Invocation revision does not match.',
        );
      }
      const toolRunRevision = resolveToolRunWindowRevision(database, normalized);
      let transitionRunRevision = toolRunRevision;
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

      // Progress is a diagnostic append inside the sealed Tool authority, not
      // a lifecycle transition. It therefore neither changes Invocation state
      // nor advances the Run/Tool scheduling revision. This keeps concurrent
      // progress from competing with sibling Invocations while the exact
      // lease, start fence and Handler attempt are still verified atomically.
      if (normalized.action === 'progress') {
        requireInvocationState(invocation, ['started']);
        if (
          invocation.started === undefined ||
          invocation.started.fencingToken !== normalized.lease.fencingToken ||
          invocation.started.idempotencyKey !== normalized.idempotencyKey ||
          invocation.started.attempt !== normalized.attempt
        ) {
          throw new AgentJournalError(
            'FENCING_TOKEN_STALE',
            'Tool progress does not match the active Handler attempt.',
          );
        }
        events.push(this.#appendEvent(database, {
          projectId: invocation.projectId,
          sessionId: invocation.sessionId,
          runId: invocation.runId,
          turnId: invocation.turnId,
          attemptId: invocation.attemptId,
          invocationId: invocation.invocationId,
          type: 'tool.progress',
          payload: {
            invocationId: invocation.invocationId,
            summary: normalized.summary,
          },
          occurredAt,
        }));
        const result: ToolInvocationCommitResult = {
          events,
          invocation: structuredClone(invocation),
        };
        writeCommandResult(
          database,
          normalized.projectId,
          normalized.commandId,
          'tool.progress',
          requestDigest,
          result,
          occurredAt,
        );
        return result;
      }

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
            invocation.terminal?.kind !== 'unknown' ||
            invocation.observation === undefined ||
            invocation.canonicalToolId === undefined ||
            canonicalJson(invocation.canonicalToolId) !==
              canonicalJson(normalized.canonicalToolId) ||
            invocation.toolRevision !== normalized.toolRevision ||
            invocation.recoveryClass !== normalized.recoveryClass ||
            invocation.intentDigest !== normalized.intentDigest ||
            invocation.proposedRevision !== normalized.proposedRevision
          ) {
            throw new AgentJournalError(
              'INVOCATION_STATE_CONFLICT',
              'Outcome resolution does not match the exact unknown Invocation.',
            );
          }
          invocation.state = 'observed';
          const priorTerminal = invocation.terminal;
          if (normalized.retryAuthorization !== undefined) {
            if (normalized.outcome !== 'failed' || normalized.recoveryClass !== 'non_idempotent') {
              throw new AgentJournalError(
                'INVALID_ARGUMENT',
                'Risky retry authorization requires a failed non-idempotent outcome resolution.',
              );
            }
            if (
              invocation.retryPermit !== undefined &&
              invocation.retryPermit.permitId !== normalized.retryAuthorization.permitId
            ) {
              throw new AgentJournalError(
                'IDEMPOTENCY_CONFLICT', 'Invocation already has another retry permit.',
              );
            }
            invocation.retryPermit = {
              permitId: normalized.retryAuthorization.permitId,
              toolRevision: normalized.toolRevision,
              recoveryClass: 'non_idempotent',
              intentDigest: normalized.intentDigest,
              reason: boundedText(normalized.retryAuthorization.reason, 2_000),
            };
            retryPermit = { invocationId: invocation.invocationId, ...invocation.retryPermit };
            append('tool.retry_authorized', {
              invocationId: invocation.invocationId,
              ...invocation.retryPermit,
            });
          }
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
            evidenceRefs: [...priorTerminal.evidenceRefs],
            ...(priorTerminal.durableSummary === undefined
              ? {}
              : { durableSummary: structuredClone(priorTerminal.durableSummary) }),
            ...(priorTerminal.modelProjection === undefined
              ? {}
              : { modelProjection: structuredClone(priorTerminal.modelProjection) }),
            ...(priorTerminal.userProjection === undefined
              ? {}
              : { userProjection: structuredClone(priorTerminal.userProjection) }),
            ...(priorTerminal.auditEvidence === undefined
              ? {}
              : { auditEvidence: structuredClone(priorTerminal.auditEvidence) }),
            ...(priorTerminal.completionEvidence === undefined
              ? {}
              : { completionEvidence: structuredClone(priorTerminal.completionEvidence) }),
            ...(resolutionError === undefined ? {} : { error: resolutionError }),
            occurredAt,
          };
          invocation.observation = {
            observationId: invocation.observation.observationId,
            invocationId: invocation.observation.invocationId,
            summary: invocation.terminal.summary,
            evidenceRefs: mergedEvidenceRefs(invocation.terminal),
            outcome: normalized.outcome,
            ...(invocation.terminal.modelProjection === undefined
              ? {}
              : { modelProjection: structuredClone(invocation.terminal.modelProjection) }),
            ...(invocation.terminal.auditEvidence === undefined
              ? {}
              : { auditEvidence: structuredClone(invocation.terminal.auditEvidence) }),
            ...(invocation.terminal.completionEvidence === undefined
              ? {}
              : { completionEvidence: structuredClone(invocation.terminal.completionEvidence) }),
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
            recoveryClass: normalized.recoveryClass,
            intentDigest: normalized.intentDigest,
            proposedRevision: normalized.proposedRevision,
            summary: invocation.terminal.summary,
            resultRefs: invocation.terminal.resultRefs,
            evidenceRefs: invocation.terminal.evidenceRefs,
            ...(invocation.terminal.durableSummary === undefined
              ? {}
              : { durableSummary: invocation.terminal.durableSummary }),
            ...(invocation.terminal.modelProjection === undefined
              ? {}
              : { modelProjection: invocation.terminal.modelProjection }),
            ...(invocation.terminal.userProjection === undefined
              ? {}
              : { userProjection: invocation.terminal.userProjection }),
            ...(invocation.terminal.auditEvidence === undefined
              ? {}
              : { auditEvidence: invocation.terminal.auditEvidence }),
            ...(invocation.terminal.completionEvidence === undefined
              ? {}
              : { completionEvidence: invocation.terminal.completionEvidence }),
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
          requireInvocationState(invocation, ['proposed', 'prepared', 'authorized']);
          if (invocation.state === 'proposed') {
            append('tool.prepared', {
              invocationId: invocation.invocationId,
              actionSummary: normalized.actionSummary,
              validationError: normalized.error,
            });
          }
          const rejectedOutcome = normalized.error.code === 'TOOL_REVISION_MISMATCH'
            ? 'unsupported_revision'
            : normalized.error.code === 'TOOL_CANCELLED'
              ? 'cancelled'
              : normalized.error.code === 'TOOL_TIMEOUT'
                ? 'timed_out'
                : 'failed';
          invocation.state = rejectedOutcome;
          invocation.terminal = {
            kind: rejectedOutcome,
            summary: boundedText(normalized.summary, 4_096),
            resultRefs: [],
            evidenceRefs: [],
            error: structuredClone(normalized.error),
            occurredAt,
          };
          if (normalized.hookRejection !== undefined) {
            append('tool.hook_rejected', {
              invocationId: invocation.invocationId,
              ...structuredClone(normalized.hookRejection),
            });
          }
          append(
            rejectedOutcome === 'unsupported_revision'
              ? 'tool.unsupported_revision'
              : rejectedOutcome === 'cancelled'
                ? 'tool.cancelled'
                : rejectedOutcome === 'timed_out'
                  ? 'tool.timed_out'
                  : 'tool.failed',
            {
            ...(invocation.intentDigest === undefined ? {} : { intentDigest: invocation.intentDigest }),
            summary: invocation.terminal.summary,
            resultRefs: [],
            evidenceRefs: [],
            error: invocation.terminal.error,
            },
          );
          break;
        }
        case 'prepare': {
          requireInvocationState(invocation, ['proposed']);
          const intent = validatePreparedIntent(normalized.intent);
          assertPreparedDigest(intent, normalized.intentDigest);
          invocation.intent = structuredClone(intent);
          invocation.intentDigest = normalized.intentDigest;
          invocation.deadline = normalized.deadline;
          invocation.catalogRevision = normalized.catalogRevision;
          invocation.canonicalToolId = structuredClone(normalized.canonicalToolId);
          invocation.toolRevision = intent.toolRevision;
          invocation.recoveryClass = intent.recoveryClass;
          invocation.proposedRevision = invocation.revision;
          invocation.state = 'prepared';
          append('tool.prepared', {
            invocationId: invocation.invocationId, actionSummary: intent.action.summary,
            intent: structuredClone(intent), intentDigest: normalized.intentDigest,
            deadline: normalized.deadline, catalogRevision: normalized.catalogRevision,
            canonicalToolId: structuredClone(normalized.canonicalToolId),
            toolRevision: intent.toolRevision, recoveryClass: intent.recoveryClass,
            proposedRevision: invocation.proposedRevision,
          });
          break;
        }
        case 'validate': {
          requireInvocationState(invocation, ['prepared']);
          if (normalized.intentDigest !== invocation.intentDigest || normalized.toolRevision !== invocation.toolRevision || normalized.recoveryClass !== invocation.recoveryClass || canonicalJson(normalized.permissionAudit.facts) !== canonicalJson(invocation.intent?.permission as unknown as PortableValue)) throw new AgentJournalError('INVOCATION_STATE_CONFLICT', 'Authorization must consume the persisted intent facts.');
          let authorization = normalized.authorization;
          const riskyPredecessor = normalized.recoveryClass === 'non_idempotent'
            ? findEquivalentUnknownInvocation(database, invocation, normalized)
            : undefined;
          const availablePermit = riskyPredecessor === undefined
            ? undefined
            : findUnconsumedRetryPermit(database, riskyPredecessor);
          if (riskyPredecessor !== undefined && availablePermit === undefined) {
            authorization = 'deny';
          }
          if (availablePermit !== undefined && riskyPredecessor !== undefined) {
            invocation.retryOf = riskyPredecessor.invocationId;
            invocation.retryPermitId = availablePermit.permitId;
          }
          append('tool.permission_evaluated', {
            invocationId: invocation.invocationId, intentDigest: invocation.intentDigest,
            permissionAudit: { ...structuredClone(normalized.permissionAudit), decision: authorization },
            ...(invocation.retryOf === undefined ? {} : { retryOf: invocation.retryOf }),
            ...(invocation.retryPermitId === undefined ? {} : { retryPermitId: invocation.retryPermitId }),
          });
          if (authorization === 'allow') {
            const approvalId = `automatic_${stableToolIdentity(invocation.invocationId)}`;
            invocation.approvalId = approvalId;
            invocation.state = 'authorized';
            append('tool.authorized', { intentDigest: invocation.intentDigest, approvalId, invocationId: invocation.invocationId });
          } else if (authorization === 'deny') {
            const approvalId = `policy_${stableToolIdentity(invocation.invocationId)}`;
            const reason = riskyPredecessor !== undefined && availablePermit === undefined
              ? 'An exact single-use retry permit is required for this unknown outcome.'
              : 'The tool invocation was denied.';
            invocation.approvalId = approvalId;
            invocation.state = 'denied';
            invocation.terminal = {
              kind: 'denied', summary: reason, resultRefs: [], evidenceRefs: [], occurredAt,
            };
            append('tool.denied', { intentDigest: invocation.intentDigest, approvalId, invocationId: invocation.invocationId, reason });
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
              recoveryClass: normalized.recoveryClass,
              intentDigest: normalized.intentDigest,
              proposedRevision: invocation.proposedRevision!,
              status: 'pending',
            };
            invocation.approvalId = approvalId;
            invocation.state = 'awaiting_approval';
            append('tool.approval_requested', {
              approval,
              summary: boundedText(normalized.approvalSummary, MAX_APPROVAL_SUMMARY_CHARS),
            });
            database.prepare(
              `INSERT INTO agent_approvals (
                approval_id, project_id, run_id, invocation_id, tool_revision,
                intent_digest, recovery_class, status, payload_json, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
            ).run(
              approvalId, invocation.projectId, invocation.runId, invocation.invocationId,
              normalized.toolRevision, normalized.intentDigest,
              normalized.recoveryClass, JSON.stringify(approval), occurredAt,
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
          const actionSummary = approvalActionSummary(database, approval);
          approval.status = normalized.decision === 'approve' ? 'approved' : 'denied';
          approval.decidedAt = occurredAt;
          if (normalized.decidedBy !== undefined) approval.decidedBy = normalized.decidedBy;
          if (normalized.reason !== undefined) approval.reason = normalized.reason;
          if (normalized.decision === 'approve') {
            invocation.state = 'authorized';
            append('tool.authorized', { intentDigest: invocation.intentDigest!,
              approvalId: approval.approvalId,
              invocationId: invocation.invocationId,
              actionSummary,
              decision: approvalDecisionEvent(approval, 'approved'),
            });
          } else {
            const reason = boundedText(
              normalized.reason ?? 'The tool invocation was denied.', 2_000,
            );
            // The Approval projection and its authoritative Event must describe
            // the same decision.  Resolve the default inside this sealed
            // transaction before either representation is persisted so a
            // rebuild cannot manufacture metadata that the online projection
            // never contained.
            approval.reason = reason;
            invocation.state = 'denied';
            invocation.terminal = {
              kind: 'denied', summary: reason, resultRefs: [], evidenceRefs: [], occurredAt,
            };
            append('tool.denied', { intentDigest: invocation.intentDigest!,
              approvalId: approval.approvalId,
              invocationId: invocation.invocationId,
              actionSummary,
              reason,
              decision: approvalDecisionEvent(approval, 'denied'),
            });
          }
          database.prepare(
            `UPDATE agent_approvals SET status = ?, payload_json = ?
             WHERE approval_id = ? AND status = 'pending'`,
          ).run(approval.status, JSON.stringify(approval), approval.approvalId);
          break;
        }
        case 'start': {
          if (normalized.intentDigest !== invocation.intentDigest || invocation.intent === undefined) throw new AgentJournalError('INVOCATION_STATE_CONFLICT', 'Start intent digest mismatch.');
          assertPreparedDigest(invocation.intent, normalized.intentDigest);
          if (canonicalJson(normalized.permissionAudit.facts) !== canonicalJson(invocation.intent.permission as unknown as PortableValue)) throw new AgentJournalError('INVOCATION_STATE_CONFLICT', 'Start permission facts differ from the prepared intent.');
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
            intentDigest: normalized.intentDigest,
            idempotencyKey: normalized.idempotencyKey,
            fencingToken: normalized.lease.fencingToken,
            attempt: normalized.attempt,
            runRevision: toolRunRevision + 1,
            startedAt: occurredAt,
          };
          append('tool.started', {
            intentDigest: normalized.intentDigest,
            access: invocation.intent.access, concurrency: invocation.intent.concurrency,
            resourceKeys: [...invocation.intent.resourceKeys],
            invocationId: invocation.invocationId,
            idempotencyKey: normalized.idempotencyKey,
            fencingToken: normalized.lease.fencingToken,
            attempt: normalized.attempt,
            runRevision: toolRunRevision + 1,
            permissionAudit: structuredClone(normalized.permissionAudit),
          });
          break;
        }
        case 'wait-for-user': {
          requireInvocationState(invocation, ['started']);
          const bundle = normalized.bundle;
          if (invocation.name !== 'ask_user' || invocation.intentDigest !== normalized.intentDigest ||
              invocation.started?.fencingToken !== normalized.lease.fencingToken ||
              canonicalJson(invocation.intent?.input.bundle as PortableValue) !== canonicalJson(bundle) ||
              bundle.owner.projectId !== invocation.projectId || bundle.owner.sessionId !== invocation.sessionId ||
              bundle.owner.runId !== invocation.runId || bundle.owner.turnId !== invocation.turnId || bundle.owner.invocationId !== invocation.invocationId ||
              bundle.idempotencyKey !== invocation.started?.idempotencyKey) {
            throw new AgentJournalError('INVOCATION_STATE_CONFLICT', 'Question does not match the exact prepared ask_user attempt.');
          }
          invocation.state = 'waiting_for_user';
          invocation.question = structuredClone(bundle);
          append('tool.waiting_for_user', { invocationId: invocation.invocationId, intentDigest: normalized.intentDigest, questionId: bundle.questionId, questionRevision: bundle.questionRevision, bundle });
          break;
        }
        case 'settle-question':
        case 'finish': {
          if (normalized.intentDigest !== invocation.intentDigest) throw new AgentJournalError('INVOCATION_STATE_CONFLICT', 'Terminal intent digest mismatch.');
          if (normalized.action === 'settle-question') {
            requireInvocationState(invocation, ['waiting_for_user']);
            const bundle = invocation.question;
            if (!bundle) throw new AgentJournalError('INVOCATION_STATE_CONFLICT', 'Pending question is missing.');
            validateQuestionCommand(normalized.questionCommand, bundle);
            const kind = normalized.questionCommand.kind;
            const current = readKernelRunProjection(database, normalized.runId);
            if ((current.state !== 'AwaitingUser' || current.waitReason !== 'tool_input') && !(current.state === 'Cancelling' && kind === 'question.cancel')) throw new AgentJournalError('COMMAND_CONFLICT', 'Run is not waiting for this question.');
            const expired = bundle.deadline !== null && Date.parse(occurredAt) >= Date.parse(bundle.deadline);
            if (kind === 'question.answer' && expired) throw new AgentJournalError('COMMAND_CONFLICT', 'Question deadline expired.');
            if (kind === 'question.timeout' && !expired) throw new AgentJournalError('COMMAND_CONFLICT', 'Question deadline has not expired.');
            const expectedOutcome = kind === 'question.answer' ? normalized.outcome === 'unsupported_revision' && normalized.error?.code === 'TOOL_REVISION_MISMATCH' ? 'unsupported_revision' : 'succeeded' : kind === 'question.timeout' ? 'timed_out' : 'cancelled';
            if (normalized.outcome !== expectedOutcome || normalized.observation.outcome !== expectedOutcome || normalized.observation.invocationId !== invocation.invocationId || normalized.interruptedFencingToken !== undefined || normalized.resultRefs.length || (normalized.evidenceRefs?.length ?? 0)) throw new AgentJournalError('INVALID_ARGUMENT', 'Question settlement does not match the Host command.');
            const summary = normalized.durableSummary as Record<string, PortableValue> | undefined;
            if (summary?.questionCommandDigest !== questionCommandDigest(normalized.questionCommand)) throw new AgentJournalError('INVALID_ARGUMENT', 'Question command identity is not bound to its result.');
          } else requireInvocationState(invocation, ['started']);
          if (preparedArtifacts.some((artifact) =>
            artifact.startedAttempt !== invocation.started?.attempt ||
            artifact.idempotencyKey !== invocation.started?.idempotencyKey ||
            artifact.fencingToken !== invocation.started?.fencingToken)) {
            throw new AgentJournalError(
              'INVOCATION_STATE_CONFLICT',
              'Prepared Tool Artifact belongs to another Handler attempt.',
            );
          }
          const startedFence = invocation.started?.fencingToken;
          if (normalized.action === 'settle-question') {
            // Waiting has no active Handler: the current Run lease owns this durable question.
          } else if (normalized.interruptedFencingToken !== undefined) {
            // An interrupted start carries no confirmed cancellation boundary. Neither
            // read access nor replayability permits downgrading its unknown outcome.
            if (
              normalized.interruptedFencingToken !== startedFence ||
              normalized.lease.fencingToken <= normalized.interruptedFencingToken ||
              (normalized.outcome !== 'unknown' && normalized.outcome !== 'unsupported_revision')
            ) {
              throw new AgentJournalError(
                'FENCING_TOKEN_STALE',
                'Interrupted Tool settlement does not match the exact stale start fact.',
              );
            }
          } else if (startedFence !== normalized.lease.fencingToken) {
            throw new AgentJournalError(
              'FENCING_TOKEN_STALE', 'Invocation was started under another fencing token.',
            );
          }
          if (normalized.action === 'finish' && normalized.outcome === 'succeeded' && invocation.deadline !== undefined &&
              Date.parse(this.#now()) >= Date.parse(invocation.deadline)) {
            throw new AgentJournalError('COMMAND_CONFLICT', 'The Tool deadline elapsed before atomic result publication.',
              { reason: 'tool_deadline_exceeded' });
          }
          if (runtimeCommand !== undefined) {
            const appliedCommand = this.#applyRuntimeCommandInTransaction(database, runtimeCommand);
            if (!appliedCommand.replayed) {
              events.push(...appliedCommand.result.events);
              transitionRunRevision = appliedCommand.result.run.revision;
            }
          }
          for (const artifact of preparedArtifacts) {
            append('artifact.created', artifact.payload);
          }
          for (const warning of normalized.hookWarnings ?? []) {
            append('tool.hook_warning', {
              invocationId: invocation.invocationId,
              ...structuredClone(warning),
            });
          }
          invocation.state = normalized.outcome;
          invocation.terminal = {
            kind: normalized.outcome,
            summary: boundedText(normalized.summary, 4_096),
            resultRefs: [...normalized.resultRefs],
            evidenceRefs: [...(normalized.evidenceRefs ?? [])],
            ...(normalized.durableSummary === undefined
              ? {}
              : { durableSummary: structuredClone(normalized.durableSummary) }),
            ...(normalized.modelProjection === undefined
              ? {}
              : { modelProjection: structuredClone(normalized.modelProjection) }),
            ...(normalized.userProjection === undefined
              ? {}
              : { userProjection: structuredClone(normalized.userProjection) }),
            ...(normalized.auditEvidence === undefined
              ? {}
              : { auditEvidence: structuredClone(normalized.auditEvidence) }),
            ...(normalized.completionEvidence === undefined
              ? {}
              : { completionEvidence: structuredClone(normalized.completionEvidence) }),
            ...(normalized.error === undefined ? {} : { error: structuredClone(normalized.error) }),
            occurredAt,
          };
          append(`tool.${normalized.outcome}`, {
            intentDigest: normalized.intentDigest,
            summary: invocation.terminal.summary,
            resultRefs: invocation.terminal.resultRefs,
            evidenceRefs: invocation.terminal.evidenceRefs,
            ...(invocation.terminal.durableSummary === undefined
              ? {}
              : { durableSummary: invocation.terminal.durableSummary }),
            ...(invocation.terminal.modelProjection === undefined
              ? {}
              : { modelProjection: invocation.terminal.modelProjection }),
            ...(invocation.terminal.userProjection === undefined
              ? {}
              : { userProjection: invocation.terminal.userProjection }),
            ...(invocation.terminal.auditEvidence === undefined
              ? {}
              : { auditEvidence: invocation.terminal.auditEvidence }),
            ...(invocation.terminal.completionEvidence === undefined
              ? {}
              : { completionEvidence: invocation.terminal.completionEvidence }),
            ...(invocation.terminal.error === undefined
              ? {}
              : { error: invocation.terminal.error }),
          });
          if (normalized.action === 'settle-question') {
            invocation.state = 'observed';
            invocation.observation = { ...structuredClone(normalized.observation), occurredAt };
            append('tool.observed', normalized.observation);
            database.prepare(`INSERT INTO agent_observations (observation_id, project_id, run_id, invocation_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
              normalized.observation.observationId, invocation.projectId, invocation.runId, invocation.invocationId,
              JSON.stringify({ ...normalized.observation, projectId: invocation.projectId, runId: invocation.runId, createdAt: occurredAt }), occurredAt,
            );
          }
          break;
        }
        case 'observe': {
          requireInvocationState(invocation, [
            'succeeded', 'failed', 'cancelled', 'unknown', 'denied', 'timed_out', 'unsupported_revision',
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
            invocation.terminal?.kind !== 'unknown' ||
            invocation.toolRevision !== normalized.toolRevision ||
            invocation.recoveryClass !== normalized.recoveryClass ||
            invocation.intentDigest !== normalized.intentDigest
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
            recoveryClass: normalized.recoveryClass,
            intentDigest: normalized.intentDigest,
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
      const schedule = decidePersistedToolSchedule(
        database, invocation.runId, invocation.turnId,
      );
      const transitionEvent = this.#appendEvent(database, {
        projectId: invocation.projectId,
        sessionId: invocation.sessionId,
        runId: invocation.runId,
        turnId: invocation.turnId,
        attemptId: invocation.attemptId,
        invocationId: invocation.invocationId,
        type: 'tool.transition_committed',
        payload: { action: normalized.action, schedule },
        occurredAt,
      });
      events.push(transitionEvent);
      if (normalized.action === 'observe' || normalized.action === 'resolve-outcome' || normalized.action === 'settle-question') {
        const evidenceEvent = events.find((event) =>
          event.type === 'tool.observed' || event.type === 'tool.outcome_resolved');
        if (evidenceEvent !== undefined) {
          advanceOnlineKernelEvidence(database, invocation.runId, evidenceEvent);
        }
      }
      const currentKernel = readKernelRunProjection(database, invocation.runId);
      persistKernelRunProjectionCas(
        database,
        currentKernel,
        projectKernelRunEvent(currentKernel, transitionEvent),
        transitionRunRevision,
        'Concurrent Tool transition won the Run revision race.',
      );
      advanceToolRunWindow(
        database,
        normalized.runId,
        normalized.turnId,
        transitionRunRevision,
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
    const requestDigest = (
      normalized.action === 'steer-run' || normalized.action === 'queue-steering' ||
      normalized.action === 'consume-steering'
    )
      ? digestValue({
          action: normalized.action,
          projectId: normalized.projectId,
          sessionId: normalized.sessionId,
          runId: normalized.runId,
          clientRequestId: normalized.clientRequestId,
          input: normalized.input,
        })
      : digestValue(normalized);
    return this.#withDatabase((database) => transaction(database, () => {
      const replay = readCommandResult<KernelJournalCommitResult>(
        database, normalized.projectId, normalized.commandId, requestDigest,
      );
      if (replay !== undefined) return replay;
      this.#assertRun(
        database, normalized.projectId, normalized.sessionId, normalized.runId,
      );
      this.#assertLease(database, normalized.projectId, normalized.runId, normalized.lease);
      const kernelCommandRevision = normalized.action === 'discard-model-attempt'
        ? resolveModelRunWindowRevision(database, {
            projectId: normalized.projectId,
            sessionId: normalized.sessionId,
            runId: normalized.runId,
            turnId: normalized.turnId,
            attemptId: normalized.attemptId,
            expectedRunRevision: normalized.expectedRunRevision,
          })
        : normalized.expectedRunRevision;
      if (normalized.action !== 'queue-steering') {
        this.#assertRunRevision(
          database, normalized.projectId, normalized.runId, kernelCommandRevision,
        );
      }
      switch (normalized.action) {
        case 'capture-turn':
          return this.#commitCaptureTurn(database, normalized, requestDigest);
        case 'commit-context-ready':
          return this.#commitContextReady(database, normalized, requestDigest);
        case 'close-observed-turn':
          return this.#commitCloseObservedTurn(database, normalized, requestDigest);
        case 'block-outcome-resolution':
          return this.#commitBlockOutcomeResolution(database, normalized, requestDigest);
        case 'complete-outcome-resolution':
          return this.#commitCompleteOutcomeResolution(database, normalized, requestDigest);
        case 'steer-run':
        case 'request-input':
        case 'resume-run':
        case 'reach-limit':
        case 'interrupt-run':
        case 'fail-run':
          return this.#commitRunControlFact(database, normalized, requestDigest);
        case 'queue-steering':
          return this.#commitQueueSteering(database, normalized, requestDigest);
        case 'consume-steering':
          return this.#commitConsumeSteering(database, normalized, requestDigest);
        case 'queue-context-compaction':
          return this.#commitQueueContextCompaction(database, normalized, requestDigest);
        case 'start-context-compaction':
          return this.#commitStartContextCompaction(database, normalized, requestDigest);
        case 'complete-context-compaction':
          return this.#commitCompleteContextCompaction(database, normalized, requestDigest);
        case 'fail-context-compaction':
          return this.#commitFailContextCompaction(database, normalized, requestDigest);
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
    const routes = [
      environment.payload.modelSession.primary,
      ...environment.payload.modelSession.fallbacks,
    ];
    if (!routes.some((route) =>
      route.route.connectionId === command.origin.connectionId &&
      route.route.modelId === command.origin.model &&
      route.route.protocol === command.origin.protocol)) {
      throw new AgentJournalError('COMMAND_CONFLICT', 'Attempt origin is outside the persisted Model Route.');
    }
    const occurredAt = this.#now();
    const event = this.#appendEvent(database, {
      projectId: command.projectId, sessionId: command.sessionId, runId: command.runId,
      turnId: command.turnId, attemptId: command.attemptId,
      type: 'model_attempt_started', payload: { origin: command.origin }, occurredAt,
    });
    this.#injectKernel('after-events-before-projection');
    const next = projectKernelRunEvent(current, event);
    persistKernelRunProjectionCas(
      database, current, next,
      command.expectedRunRevision, 'Concurrent model Attempt start won the race.',
    );
    openModelRunWindow(database, next, command.turnId, command.attemptId);
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
    const effectiveRunRevision = resolveModelRunWindowRevision(database, {
      projectId: command.projectId,
      sessionId: command.sessionId,
      runId: command.runId,
      turnId: command.turnId,
      attemptId: command.attemptId,
      expectedRunRevision: command.expectedRunRevision,
    });
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
      effectiveRunRevision, 'Concurrent model Attempt discard won the race.',
    );
    deleteModelRunWindow(database, command.runId, command.turnId, command.attemptId);
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
    const events = [
      event,
      ...this.#settleUnstartedInvocationsForCancellation(database, current, occurredAt),
    ];
    this.#injectKernel('after-events-before-projection');
    const next = projectKernelRunEvents(current, events);
    persistKernelRunProjectionCas(
      database, current, next,
      command.expectedRunRevision, 'Concurrent cancellation request won the race.',
    );
    const started = database.prepare(
      `SELECT COUNT(*) AS count FROM agent_invocations
       WHERE project_id = ? AND run_id = ? AND state = 'started'`,
    ).get(command.projectId, command.runId) as { count: number };
    if (Number(started.count) > 0) {
      openCancellationToolRunWindow(database, current, next);
    } else {
      database.prepare('DELETE FROM agent_tool_run_windows WHERE run_id = ?').run(command.runId);
    }
    const result: KernelJournalCommitResult = {
      events, run: readKernelRunProjection(database, command.runId),
    };
    writeCommandResult(
      database, command.projectId, command.commandId, 'kernel.request-cancel',
      requestDigest, result, occurredAt,
    );
    return result;
  }

  #settleUnstartedInvocationsForCancellation(
    database: NodeDatabaseSync,
    current: KernelRunProjection,
    occurredAt: string,
  ): AgentEvent[] {
    const rows = database.prepare(
      `SELECT invocation_id FROM agent_invocations
       WHERE project_id = ? AND run_id = ? AND state NOT IN ('started', 'observed')
       ORDER BY action_ordinal ASC, invocation_id ASC`,
    ).all(current.projectId, current.runId) as { invocation_id: string }[];
    const events: AgentEvent[] = [];
    for (const row of rows) {
      const invocation = readInvocationProjection(database, row.invocation_id);
      if (invocation === null || invocation.state === 'started' || invocation.state === 'observed') {
        continue;
      }
      let parentEventId: string | undefined;
      if (invocation.terminal === undefined) {
        if (invocation.state === 'awaiting_approval' && invocation.approvalId !== undefined) {
          const approval = readApprovalProjection(database, invocation.approvalId);
          if (approval === null || approval.status !== 'pending') {
            throw new AgentJournalError(
              'PROJECTION_CORRUPT', 'Pending Tool approval is unavailable during cancellation.',
            );
          }
          const reason = 'The Run was cancelled before this Tool was approved.';
          approval.status = 'denied';
          approval.decidedAt = occurredAt;
          approval.reason = reason;
          invocation.state = 'denied';
          invocation.terminal = {
            kind: 'denied', summary: reason, resultRefs: [], evidenceRefs: [], occurredAt,
          };
          const denied = this.#appendEvent(database, {
            projectId: invocation.projectId,
            sessionId: invocation.sessionId,
            runId: invocation.runId,
            turnId: invocation.turnId,
            attemptId: invocation.attemptId,
            invocationId: invocation.invocationId,
            ...(parentEventId === undefined ? {} : { parentEventId }),
            type: 'tool.denied',
            payload: {
              intentDigest: invocation.intentDigest!,
              approvalId: approval.approvalId,
              invocationId: invocation.invocationId,
              actionSummary: approvalActionSummary(database, approval),
              reason,
              decision: approvalDecisionEvent(approval, 'denied'),
            },
            occurredAt,
          });
          events.push(denied);
          parentEventId = denied.eventId;
          invocation.revision += 1;
          database.prepare(
            `UPDATE agent_approvals SET status = 'denied', payload_json = ?
             WHERE approval_id = ? AND status = 'pending'`,
          ).run(JSON.stringify(approval), approval.approvalId);
        } else {
          const summary = 'The Run was cancelled before this Tool was dispatched.';
          const error: ToolExecutionErrorFact = {
            code: 'TOOL_CANCELLED', category: 'cancelled', retryable: false,
            outcome: 'not_applied',
          };
          invocation.state = 'cancelled';
          invocation.terminal = {
            kind: 'cancelled', summary, resultRefs: [], evidenceRefs: [], error, occurredAt,
          };
          const cancelled = this.#appendEvent(database, {
            projectId: invocation.projectId,
            sessionId: invocation.sessionId,
            runId: invocation.runId,
            turnId: invocation.turnId,
            attemptId: invocation.attemptId,
            invocationId: invocation.invocationId,
            ...(parentEventId === undefined ? {} : { parentEventId }),
            type: 'tool.cancelled',
            payload: { summary, resultRefs: [], evidenceRefs: [], error },
            occurredAt,
          });
          events.push(cancelled);
          parentEventId = cancelled.eventId;
          invocation.revision += 1;
        }
      }
      const terminal = invocation.terminal;
      if (terminal === undefined) {
        throw new AgentJournalError('PROJECTION_CORRUPT', 'Cancellation terminal fact is missing.');
      }
      const observation: ToolObservationFact = {
        observationId: `observation_${createHash('sha256').update(invocation.invocationId).digest('hex')}`,
        invocationId: invocation.invocationId,
        summary: terminal.summary,
        evidenceRefs: mergedEvidenceRefs(terminal),
        outcome: terminal.kind,
        ...(terminal.modelProjection === undefined
          ? {}
          : { modelProjection: structuredClone(terminal.modelProjection) }),
        ...(terminal.auditEvidence === undefined
          ? {}
          : { auditEvidence: structuredClone(terminal.auditEvidence) }),
        ...(terminal.completionEvidence === undefined
          ? {}
          : { completionEvidence: structuredClone(terminal.completionEvidence) }),
        ...(terminal.error === undefined ? {} : { errorCode: terminal.error.code }),
      };
      const observed = this.#appendEvent(database, {
        projectId: invocation.projectId,
        sessionId: invocation.sessionId,
        runId: invocation.runId,
        turnId: invocation.turnId,
        attemptId: invocation.attemptId,
        invocationId: invocation.invocationId,
        ...(parentEventId === undefined ? {} : { parentEventId }),
        type: 'tool.observed',
        payload: observation,
        occurredAt,
      });
      events.push(observed);
      invocation.state = 'observed';
      invocation.observation = { ...structuredClone(observation), occurredAt };
      invocation.revision += 1;
      invocation.updatedAt = occurredAt;
      database.prepare(
        `UPDATE agent_invocations SET state = 'observed', revision = ?, payload_json = ?, updated_at = ?
         WHERE invocation_id = ?`,
      ).run(
        invocation.revision, JSON.stringify(invocation), occurredAt, invocation.invocationId,
      );
      database.prepare(
        `INSERT INTO agent_observations (
          observation_id, project_id, run_id, invocation_id, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        observation.observationId,
        invocation.projectId,
        invocation.runId,
        invocation.invocationId,
        JSON.stringify({
          ...observation, projectId: invocation.projectId,
          runId: invocation.runId, createdAt: occurredAt,
        }),
        occurredAt,
      );
    }
    return events;
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
      if (lifecycle === undefined || !['started', 'committed', 'closed'].includes(lifecycle.status)) {
        throw new AgentJournalError(
          'PROJECTION_CORRUPT', 'Cancellation has an invalid open Turn lifecycle.',
        );
      }
      if (lifecycle.status !== 'closed') {
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
    const sourceTurn = database.prepare(
      `SELECT e.turn_id, lifecycle.status
       FROM agent_events AS e
       JOIN agent_turn_lifecycles AS lifecycle
         ON lifecycle.project_id = e.project_id
        AND lifecycle.session_id = e.session_id
        AND lifecycle.run_id = e.run_id
        AND lifecycle.turn_id = e.turn_id
       WHERE e.project_id = ? AND e.session_id = ? AND e.run_id = ?
         AND e.event_type = 'turn.closed'
       ORDER BY e.sequence DESC LIMIT 1`,
    ).get(command.projectId, command.sessionId, command.runId) as {
      turn_id: string; status: string;
    } | undefined;
    if (sourceTurn === undefined || sourceTurn.status !== 'closed') {
      throw new AgentJournalError(
        'COMMAND_CONFLICT', 'No-progress evidence requires the latest Turn to be closed.',
      );
    }
    if (sourceTurn.turn_id !== command.turnId) {
      throw new AgentJournalError(
        'COMMAND_CONFLICT', 'No-progress evidence does not identify the latest closed Turn.',
      );
    }
    const occurredAt = this.#now();
    const event = this.#appendEvent(database, {
      projectId: command.projectId, sessionId: command.sessionId, runId: command.runId,
      turnId: command.turnId,
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

  #commitContextReady(
    database: NodeDatabaseSync,
    command: Extract<KernelJournalCommand, { action: 'commit-context-ready' }>,
    requestDigest: string,
  ): KernelJournalCommitResult {
    const current = readKernelRunProjection(database, command.runId);
    if (current.state !== 'Preparing' || current.currentTurnId !== command.turnId) {
      throw new AgentJournalError(
        'COMMAND_CONFLICT', 'Context may become ready only for the captured Preparing Turn.',
      );
    }
    const lifecycle = database.prepare(
      'SELECT revision, status FROM agent_turn_lifecycles WHERE turn_id = ?',
    ).get(command.turnId) as { revision: number; status: string } | undefined;
    if (
      lifecycle?.revision !== command.expectedTurnRevision || lifecycle.status !== 'started'
    ) {
      throw new AgentJournalError('REVISION_CONFLICT', 'Captured Turn revision changed.');
    }
    const occurredAt = this.#now();
    const event = this.#appendEvent(database, {
      projectId: command.projectId,
      sessionId: command.sessionId,
      runId: command.runId,
      turnId: command.turnId,
      type: 'turn.context_compiled',
      payload: {
        ...(command.contextRef === undefined ? {} : { contextRef: command.contextRef }),
        ...(command.tokenEstimate === undefined ? {} : { tokenEstimate: command.tokenEstimate }),
      },
      occurredAt,
    });
    this.#injectKernel('after-events-before-projection');
    persistKernelRunProjectionCas(
      database,
      current,
      projectKernelRunEvent(current, event),
      command.expectedRunRevision,
      'Concurrent Context readiness won the race.',
    );
    const result: KernelJournalCommitResult = {
      events: [event],
      run: readKernelRunProjection(database, command.runId),
    };
    writeCommandResult(
      database, command.projectId, command.commandId, 'kernel.context-ready',
      requestDigest, result, occurredAt,
    );
    return result;
  }

  #commitCloseObservedTurn(
    database: NodeDatabaseSync,
    command: Extract<KernelJournalCommand, { action: 'close-observed-turn' }>,
    requestDigest: string,
  ): KernelJournalCommitResult {
    const current = readKernelRunProjection(database, command.runId);
    if (
      current.state !== 'ApplyingObservations' || current.currentTurnId !== command.turnId ||
      current.currentAttemptId !== null
    ) {
      throw new AgentJournalError(
        'COMMAND_CONFLICT', 'Only a fully observed Tool Turn may be closed.',
      );
    }
    const lifecycle = database.prepare(
      'SELECT revision, status FROM agent_turn_lifecycles WHERE turn_id = ?',
    ).get(command.turnId) as { revision: number; status: string } | undefined;
    if (
      lifecycle?.revision !== command.expectedTurnRevision || lifecycle.status !== 'committed'
    ) {
      throw new AgentJournalError('REVISION_CONFLICT', 'Observed Turn revision changed.');
    }
    const unresolved = database.prepare(
      `SELECT COUNT(*) AS count FROM agent_invocations
       WHERE project_id = ? AND run_id = ? AND turn_id = ? AND state <> 'observed'`,
    ).get(command.projectId, command.runId, command.turnId) as { count: number };
    if (Number(unresolved.count) !== 0) {
      throw new AgentJournalError(
        'COMMAND_CONFLICT', 'Turn still has Tool Invocations without committed Observations.',
      );
    }
    const occurredAt = this.#now();
    const event = this.#appendEvent(database, {
      projectId: command.projectId,
      sessionId: command.sessionId,
      runId: command.runId,
      turnId: command.turnId,
      type: 'turn.closed',
      payload: { reason: 'observed' },
      occurredAt,
    });
    const closed = database.prepare(
      `UPDATE agent_turn_lifecycles SET revision = revision + 1, status = 'closed'
       WHERE turn_id = ? AND revision = ? AND status = 'committed'`,
    ).run(command.turnId, command.expectedTurnRevision);
    if (Number(closed.changes) !== 1) {
      throw new AgentJournalError('REVISION_CONFLICT', 'Observed Turn close lost the revision race.');
    }
    this.#injectKernel('after-events-before-projection');
    persistKernelRunProjectionCas(
      database,
      current,
      projectKernelRunEvent(current, event),
      command.expectedRunRevision,
      'Concurrent observed Turn close won the race.',
    );
    database.prepare('DELETE FROM agent_tool_run_windows WHERE run_id = ?').run(command.runId);
    const result: KernelJournalCommitResult = {
      events: [event],
      run: readKernelRunProjection(database, command.runId),
    };
    writeCommandResult(
      database, command.projectId, command.commandId, 'kernel.close-observed-turn',
      requestDigest, result, occurredAt,
    );
    return result;
  }

  #commitBlockOutcomeResolution(
    database: NodeDatabaseSync,
    command: Extract<KernelJournalCommand, { action: 'block-outcome-resolution' }>,
    requestDigest: string,
  ): KernelJournalCommitResult {
    const current = readKernelRunProjection(database, command.runId);
    if (
      !['ApplyingObservations', 'Finalizing'].includes(current.state) ||
      current.currentTurnId !== command.turnId || current.currentAttemptId !== null
    ) {
      throw new AgentJournalError(
        'COMMAND_CONFLICT', 'Outcome resolution may be requested only at a stable Turn boundary.',
      );
    }
    const lifecycle = database.prepare(
      'SELECT revision, status FROM agent_turn_lifecycles WHERE turn_id = ?',
    ).get(command.turnId) as { revision: number; status: string } | undefined;
    if (
      lifecycle?.revision !== command.expectedTurnRevision || lifecycle.status !== 'committed'
    ) {
      throw new AgentJournalError('REVISION_CONFLICT', 'Outcome-blocked Turn revision changed.');
    }
    if (command.requests.length < 1) {
      throw new AgentJournalError(
        'INVALID_ARGUMENT', 'Outcome resolution requires at least one Invocation.',
      );
    }
    const persisted = database.prepare(
      `SELECT invocation_id FROM agent_invocations
       WHERE project_id = ? AND session_id = ? AND run_id = ? AND turn_id = ?
         AND state = 'observed' AND json_extract(payload_json, '$.terminal.kind') = 'unknown'
         AND json_type(payload_json, '$.outcomeResolution') IS NULL
       ORDER BY action_ordinal ASC, invocation_id ASC`,
    ).all(
      command.projectId, command.sessionId, command.runId, command.turnId,
    ) as Array<{ invocation_id: string }>;
    const expectedIds = persisted.map(({ invocation_id }) => invocation_id);
    const requestedIds = command.requests.map(({ invocationId }) => invocationId);
    if (
      new Set(requestedIds).size !== requestedIds.length ||
      canonicalJson([...requestedIds].sort()) !== canonicalJson([...expectedIds].sort())
    ) {
      throw new AgentJournalError(
        'COMMAND_CONFLICT', 'Outcome resolution requests do not match the unresolved Invocations.',
      );
    }
    const occurredAt = this.#now();
    const requests: AgentEvent[] = [];
    let parentEventId: string | undefined;
    for (const request of command.requests) {
      const invocation = readInvocationProjection(database, request.invocationId);
      if (invocation === null) {
        throw new AgentJournalError('PROJECTION_CORRUPT', 'Outcome Invocation disappeared.');
      }
      const event = this.#appendEvent(database, {
        projectId: command.projectId,
        sessionId: command.sessionId,
        runId: command.runId,
        turnId: command.turnId,
        attemptId: invocation.attemptId,
        invocationId: request.invocationId,
        ...(parentEventId === undefined ? {} : { parentEventId }),
        type: 'tool.outcome_resolution_requested',
        payload: { invocationId: request.invocationId, summary: request.summary },
        occurredAt,
      });
      requests.push(event);
      parentEventId = event.eventId;
    }
    const closed = this.#appendEvent(database, {
      projectId: command.projectId,
      sessionId: command.sessionId,
      runId: command.runId,
      turnId: command.turnId,
      ...(parentEventId === undefined ? {} : { parentEventId }),
      type: 'turn.closed',
      payload: { reason: 'blocked_by_outcome' },
      occurredAt,
    });
    const input = this.#appendEvent(database, {
      projectId: command.projectId,
      sessionId: command.sessionId,
      runId: command.runId,
      turnId: command.turnId,
      parentEventId: closed.eventId,
      type: 'run.input_requested',
      payload: { reason: 'outcome_resolution' },
      occurredAt,
    });
    const closedLifecycle = database.prepare(
      `UPDATE agent_turn_lifecycles SET revision = revision + 1, status = 'closed'
       WHERE turn_id = ? AND revision = ? AND status = 'committed'`,
    ).run(command.turnId, command.expectedTurnRevision);
    if (Number(closedLifecycle.changes) !== 1) {
      throw new AgentJournalError('REVISION_CONFLICT', 'Outcome-blocked Turn close lost its race.');
    }
    const events = [...requests, closed, input];
    this.#injectKernel('after-events-before-projection');
    const next = projectKernelRunEvents(current, events);
    persistKernelRunProjectionCas(
      database, current, next, command.expectedRunRevision,
      'Concurrent outcome resolution request won the race.',
    );
    advanceCompatibleRunWindowsForContextRequest(database, current, next);
    const result: KernelJournalCommitResult = {
      events, run: readKernelRunProjection(database, command.runId),
    };
    writeCommandResult(
      database, command.projectId, command.commandId, 'kernel.block-outcome-resolution',
      requestDigest, result, occurredAt,
    );
    return result;
  }

  #commitCompleteOutcomeResolution(
    database: NodeDatabaseSync,
    command: Extract<KernelJournalCommand, { action: 'complete-outcome-resolution' }>,
    requestDigest: string,
  ): KernelJournalCommitResult {
    const current = readKernelRunProjection(database, command.runId);
    if (
      current.state !== 'ApplyingObservations' || current.currentTurnId !== command.turnId ||
      current.currentAttemptId !== null
    ) {
      throw new AgentJournalError(
        'COMMAND_CONFLICT', 'Outcome resolution is not at its exact completion boundary.',
      );
    }
    const lifecycle = database.prepare(
      'SELECT status FROM agent_turn_lifecycles WHERE turn_id = ?',
    ).get(command.turnId) as { status: string } | undefined;
    if (lifecycle?.status !== 'closed') {
      throw new AgentJournalError(
        'COMMAND_CONFLICT', 'Outcome resolution requires its blocked Turn to be closed.',
      );
    }
    const unresolved = database.prepare(
      `SELECT COUNT(*) AS count FROM agent_invocations
       WHERE project_id = ? AND session_id = ? AND run_id = ? AND turn_id = ?
         AND state = 'observed' AND json_extract(payload_json, '$.terminal.kind') = 'unknown'
         AND json_type(payload_json, '$.outcomeResolution') IS NULL`,
    ).get(
      command.projectId, command.sessionId, command.runId, command.turnId,
    ) as { count: number };
    if (Number(unresolved.count) !== 0) {
      throw new AgentJournalError(
        'COMMAND_CONFLICT', 'All unknown Tool outcomes must be resolved before continuing.',
      );
    }
    const occurredAt = this.#now();
    const event = this.#appendEvent(database, {
      projectId: command.projectId,
      sessionId: command.sessionId,
      runId: command.runId,
      turnId: command.turnId,
      type: 'run.resumed',
      payload: {
        resumeState: 'Preparing',
        reason: 'outcome-resolved',
        clearTurn: true,
      },
      occurredAt,
    });
    this.#injectKernel('after-events-before-projection');
    const next = projectKernelRunEvent(current, event);
    persistKernelRunProjectionCas(
      database, current, next, command.expectedRunRevision,
      'Concurrent outcome completion won the race.',
    );
    database.prepare('DELETE FROM agent_tool_run_windows WHERE run_id = ?').run(command.runId);
    const result: KernelJournalCommitResult = {
      events: [event], run: readKernelRunProjection(database, command.runId),
    };
    writeCommandResult(
      database, command.projectId, command.commandId, 'kernel.complete-outcome-resolution',
      requestDigest, result, occurredAt,
    );
    return result;
  }

  #commitQueueSteering(
    database: NodeDatabaseSync,
    command: Extract<KernelJournalCommand, { action: 'queue-steering' }>,
    requestDigest: string,
  ): KernelJournalCommitResult {
    const current = readKernelRunProjection(database, command.runId);
    if (['Completed', 'Failed', 'Cancelled'].includes(current.state)) {
      throw new AgentJournalError('COMMAND_CONFLICT', 'A terminal Run cannot accept steering.');
    }
    const occurredAt = this.#now();
    database.prepare(
      `INSERT INTO agent_pending_steering (
         project_id, session_id, run_id, client_request_id, input_json, queued_at, consumed_at
       ) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      command.projectId, command.sessionId, command.runId, command.clientRequestId,
      JSON.stringify(command.input), occurredAt,
    );
    const result: KernelJournalCommitResult = { events: [], run: current };
    writeCommandResult(
      database, command.projectId, command.commandId, 'kernel.queue-steering',
      requestDigest, result, occurredAt,
    );
    return result;
  }

  #commitConsumeSteering(
    database: NodeDatabaseSync,
    command: Extract<KernelJournalCommand, { action: 'consume-steering' }>,
    requestDigest: string,
  ): KernelJournalCommitResult {
    const current = readKernelRunProjection(database, command.runId);
    if (!['Preparing', 'Finalizing'].includes(current.state)) {
      throw new AgentJournalError(
        'COMMAND_CONFLICT', 'Queued steering may be consumed only at a safe Run boundary.',
      );
    }
    const row = database.prepare(
      `SELECT input_json FROM agent_pending_steering
       WHERE project_id = ? AND session_id = ? AND run_id = ?
         AND client_request_id = ? AND consumed_at IS NULL`,
    ).get(
      command.projectId, command.sessionId, command.runId, command.clientRequestId,
    ) as { input_json: string } | undefined;
    if (row === undefined || canonicalJson(parsePortableJson(row.input_json)) !== canonicalJson(command.input)) {
      throw new AgentJournalError(
        'COMMAND_CONFLICT', 'Queued steering identity or content changed before consumption.',
      );
    }
    const occurredAt = this.#now();
    const event = this.#appendEvent(database, {
      projectId: command.projectId, sessionId: command.sessionId, runId: command.runId,
      type: 'run.steered',
      payload: { clientRequestId: command.clientRequestId, content: command.input },
      occurredAt,
    });
    const next = projectKernelRunEvent(current, event);
    persistKernelRunProjectionCas(
      database, current, next, command.expectedRunRevision,
      'Concurrent queued Steering consumption won the race.',
    );
    database.prepare(
      `UPDATE agent_pending_steering SET consumed_at = ?
       WHERE project_id = ? AND run_id = ? AND client_request_id = ? AND consumed_at IS NULL`,
    ).run(occurredAt, command.projectId, command.runId, command.clientRequestId);
    const result: KernelJournalCommitResult = {
      events: [event], run: readKernelRunProjection(database, command.runId),
    };
    writeCommandResult(
      database, command.projectId, command.commandId, 'kernel.consume-steering',
      requestDigest, result, occurredAt,
    );
    return result;
  }

  #commitRunControlFact(
    database: NodeDatabaseSync,
    command: Extract<KernelJournalCommand, {
      action:
        | 'steer-run'
        | 'request-input'
        | 'resume-run'
        | 'reach-limit'
        | 'interrupt-run'
        | 'fail-run';
    }>,
    requestDigest: string,
  ): KernelJournalCommitResult {
    const current = readKernelRunProjection(database, command.runId);
    const terminal = ['Completed', 'Failed', 'Cancelled'].includes(current.state);
    if (terminal) {
      throw new AgentJournalError('COMMAND_CONFLICT', 'A terminal Run cannot accept control input.');
    }
    let draft: AgentEventDraft;
    switch (command.action) {
      case 'steer-run':
        if (!['Preparing', 'AwaitingUser', 'Interrupted', 'LimitReached'].includes(current.state)) {
          throw new AgentJournalError(
            'COMMAND_CONFLICT', 'Steering requires a stable Run boundary.',
          );
        }
        draft = {
          type: 'run.steered',
          payload: { clientRequestId: command.clientRequestId, content: command.input },
        };
        break;
      case 'request-input':
        if (
          !['Preparing', 'Finalizing'].includes(current.state) &&
          !(current.state === 'ApplyingObservations' && command.reason === 'outcome_resolution')
        ) {
          throw new AgentJournalError(
            'COMMAND_CONFLICT', 'Input may be requested only at a stable reasoning boundary.',
          );
        }
        draft = {
          type: 'run.input_requested',
          payload: {
            reason: command.reason,
            ...(command.connectionId === undefined ? {} : { connectionId: command.connectionId }),
          },
        };
        break;
      case 'resume-run':
        if (!['Interrupted', 'LimitReached'].includes(current.state)) {
          throw new AgentJournalError('COMMAND_CONFLICT', 'Run is not resumable from its current state.');
        }
        {
          const suspension = database.prepare(
            `SELECT event_type, schema_version, payload_json
             FROM agent_events
             WHERE project_id = ? AND session_id = ? AND run_id = ?
               AND event_type IN ('run.limit_reached', 'run.interrupted')
             ORDER BY sequence DESC LIMIT 1`,
          ).get(command.projectId, command.sessionId, command.runId) as Readonly<{
            event_type: 'run.limit_reached' | 'run.interrupted';
            schema_version: number;
            payload_json: string;
          }> | undefined;
          if (suspension === undefined) {
            throw new AgentJournalError(
              'PROJECTION_CORRUPT', 'Resumable Run has no persisted suspension state.',
            );
          }
          const payload = suspension.event_type === 'run.limit_reached'
            ? upcastAgentEvent<'run.limit_reached'>({
                eventId: 'resume-source', projectId: command.projectId, sequence: 1,
                schemaVersion: Number(suspension.schema_version), sessionId: command.sessionId,
                runId: command.runId, type: 'run.limit_reached',
                occurredAt: '1970-01-01T00:00:00.000Z',
                payload: parsePortableJson(suspension.payload_json),
              }).payload
            : upcastAgentEvent<'run.interrupted'>({
                eventId: 'resume-source', projectId: command.projectId, sequence: 1,
                schemaVersion: Number(suspension.schema_version), sessionId: command.sessionId,
                runId: command.runId, type: 'run.interrupted',
                occurredAt: '1970-01-01T00:00:00.000Z',
                payload: parsePortableJson(suspension.payload_json),
              }).payload;
          draft = {
            type: 'run.resumed',
            payload: {
              resumeState: payload.resumeState,
              ...(command.reason === undefined ? {} : { reason: command.reason }),
            },
          };
        }
        break;
      case 'reach-limit':
        draft = {
          type: 'run.limit_reached',
          payload: {
            limit: command.limit,
            ...(command.value === undefined ? {} : { value: command.value }),
            resumeState: resumableState(current.state),
          },
        };
        break;
      case 'interrupt-run':
        draft = {
          type: 'run.interrupted',
          payload: {
            code: command.code,
            ...(command.detail === undefined ? {} : { detail: command.detail }),
            resumeState: resumableState(current.state),
          },
        };
        break;
      case 'fail-run':
        draft = {
          type: 'run.failed',
          payload: {
            code: command.code,
            ...(command.detail === undefined ? {} : { detail: command.detail }),
          },
        };
        break;
      default:
        return assertNeverKernelCommand(command);
    }
    const occurredAt = this.#now();
    const events: AgentEvent[] = [];
    let parentEventId: string | undefined;
    if (command.action === 'fail-run' && current.currentTurnId !== null) {
      if (current.currentAttemptId !== null) {
        throw new AgentJournalError(
          'COMMAND_CONFLICT', 'A Run cannot fail while a model Attempt remains active.',
        );
      }
      const lifecycle = database.prepare(
        'SELECT revision, status FROM agent_turn_lifecycles WHERE turn_id = ?',
      ).get(current.currentTurnId) as { revision: number; status: string } | undefined;
      if (lifecycle === undefined || !['started', 'committed'].includes(lifecycle.status)) {
        throw new AgentJournalError(
          'PROJECTION_CORRUPT', 'Run failure has an invalid open Turn lifecycle.',
        );
      }
      const close = this.#appendEvent(database, {
        projectId: command.projectId,
        sessionId: command.sessionId,
        runId: command.runId,
        turnId: current.currentTurnId,
        type: 'turn.closed',
        payload: { reason: 'failed' },
        occurredAt,
      });
      const closed = database.prepare(
        `UPDATE agent_turn_lifecycles SET revision = revision + 1, status = 'closed'
         WHERE turn_id = ? AND revision = ? AND status = ?`,
      ).run(current.currentTurnId, lifecycle.revision, lifecycle.status);
      if (Number(closed.changes) !== 1) {
        throw new AgentJournalError('REVISION_CONFLICT', 'Open Turn changed while failing.');
      }
      events.push(close);
      parentEventId = close.eventId;
    }
    const event = this.#appendEvent(database, {
      projectId: command.projectId,
      sessionId: command.sessionId,
      runId: command.runId,
      ...(current.currentTurnId === null ? {} : { turnId: current.currentTurnId }),
      ...(parentEventId === undefined ? {} : { parentEventId }),
      ...draft,
      occurredAt,
    });
    events.push(event);
    this.#injectKernel('after-events-before-projection');
    persistKernelRunProjectionCas(
      database,
      current,
      projectKernelRunEvents(current, events),
      command.expectedRunRevision,
      'Concurrent Run control command won the race.',
    );
    const next = readKernelRunProjection(database, command.runId);
    if (
      command.action === 'resume-run' || command.action === 'reach-limit' ||
      command.action === 'interrupt-run' ||
      (command.action === 'request-input' && command.reason === 'outcome_resolution')
    ) {
      rebaseActiveRunWindows(database, current, next, command.action === 'resume-run');
    }
    const result: KernelJournalCommitResult = {
      events,
      run: next,
    };
    writeCommandResult(
      database, command.projectId, command.commandId, `kernel.${command.action}`,
      requestDigest, result, occurredAt,
    );
    return result;
  }

  #commitStartContextCompaction(
    database: NodeDatabaseSync,
    command: Extract<KernelJournalCommand, { action: 'start-context-compaction' }>,
    requestDigest: string,
  ): KernelJournalCommitResult {
    const current = readKernelRunProjection(database, command.runId);
    if (current.state !== 'Preparing' || current.currentTurnId === null) {
      throw new AgentJournalError(
        'COMMAND_CONFLICT', 'Context compaction requires a captured Preparing Turn.',
      );
    }
    const existing = readContextCheckpointProjection(database, command.checkpointId);
    if (existing !== null) {
      throw new AgentJournalError('COMMAND_CONFLICT', 'Context checkpoint identity already exists.');
    }
    const pending = readPendingContextCompaction(database, command.runId);
    if (
      pending !== null &&
      (command.reason !== 'manual' || pending.decisionId !== command.decisionId)
    ) {
      throw new AgentJournalError(
        'COMMAND_CONFLICT', 'A pending manual Context request must be consumed first.',
      );
    }
    const occurredAt = this.#now();
    const event = this.#appendEvent(database, {
      projectId: command.projectId,
      sessionId: command.sessionId,
      runId: command.runId,
      turnId: current.currentTurnId,
      type: 'context.compaction_started',
      payload: {
        checkpointId: command.checkpointId,
        decisionId: command.decisionId,
        reason: command.reason,
        coveredSequence: command.coveredSequence,
      },
      occurredAt,
    });
    const checkpoint = freezeContextCheckpoint({
      schemaVersion: 1,
      checkpointId: command.checkpointId,
      projectId: command.projectId,
      sessionId: command.sessionId,
      runId: command.runId,
      decisionId: command.decisionId,
      reason: command.reason,
      status: 'started',
      coveredSequence: command.coveredSequence,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    });
    this.#injectKernel('after-events-before-projection');
    persistContextCheckpointProjection(database, checkpoint);
    if (pending !== null) {
      const consumed = database.prepare(
        `DELETE FROM agent_context_compaction_requests
         WHERE run_id = ? AND decision_id = ?`,
      ).run(command.runId, command.decisionId);
      if (Number(consumed.changes) !== 1) {
        throw new AgentJournalError(
          'PROJECTION_CORRUPT', 'Pending manual Context request could not be consumed.',
        );
      }
    }
    persistKernelRunProjectionCas(
      database,
      current,
      projectKernelRunEvent(current, event),
      command.expectedRunRevision,
      'Concurrent Context compaction start won the race.',
    );
    const result: KernelJournalCommitResult = {
      events: [event],
      run: readKernelRunProjection(database, command.runId),
      checkpoint,
    };
    writeCommandResult(
      database, command.projectId, command.commandId, 'kernel.context-start',
      requestDigest, result, occurredAt,
    );
    return result;
  }

  #commitQueueContextCompaction(
    database: NodeDatabaseSync,
    command: Extract<KernelJournalCommand, { action: 'queue-context-compaction' }>,
    requestDigest: string,
  ): KernelJournalCommitResult {
    const current = readKernelRunProjection(database, command.runId);
    if (![
      'CallingModel', 'ReceivingModel', 'ResolvingActions', 'AwaitingUser',
      'ExecutingTools', 'ApplyingObservations', 'Finalizing',
    ].includes(current.state)) {
      throw new AgentJournalError(
        'COMMAND_CONFLICT', 'Manual Context compaction can be queued only during active work.',
      );
    }
    if (readPendingContextCompaction(database, command.runId) !== null) {
      throw new AgentJournalError(
        'COMMAND_CONFLICT', 'This Run already has a pending manual Context request.',
      );
    }
    const occurredAt = this.#now();
    const event = this.#appendEvent(database, {
      projectId: command.projectId,
      sessionId: command.sessionId,
      runId: command.runId,
      ...(current.currentTurnId === null ? {} : { turnId: current.currentTurnId }),
      type: 'context.compaction_requested',
      payload: { decisionId: command.decisionId },
      occurredAt,
    });
    const pending: PendingContextCompaction = deepFreezeKernelValue({
      schemaVersion: 1,
      projectId: command.projectId,
      sessionId: command.sessionId,
      runId: command.runId,
      decisionId: command.decisionId,
      requestedAt: occurredAt,
    });
    this.#injectKernel('after-events-before-projection');
    persistPendingContextCompaction(database, pending);
    const next = projectKernelRunEvent(current, event);
    persistKernelRunProjectionCas(
      database,
      current,
      next,
      command.expectedRunRevision,
      'Concurrent manual Context request won the race.',
    );
    advanceCompatibleRunWindowsForContextRequest(database, current, next);
    const result: KernelJournalCommitResult = {
      events: [event],
      run: readKernelRunProjection(database, command.runId),
    };
    writeCommandResult(
      database, command.projectId, command.commandId, 'kernel.context-queue',
      requestDigest, result, occurredAt,
    );
    return result;
  }

  #commitCompleteContextCompaction(
    database: NodeDatabaseSync,
    command: Extract<KernelJournalCommand, { action: 'complete-context-compaction' }>,
    requestDigest: string,
  ): KernelJournalCommitResult {
    const current = readKernelRunProjection(database, command.runId);
    const checkpoint = readContextCheckpointProjection(database, command.checkpointId);
    if (
      current.state !== 'Compacting' || checkpoint === null || checkpoint.status !== 'started' ||
      checkpoint.decisionId !== command.decisionId ||
      checkpoint.coveredSequence !== command.coveredSequence
    ) {
      throw new AgentJournalError(
        'COMMAND_CONFLICT', 'Context completion does not match the active checkpoint.',
      );
    }
    const occurredAt = this.#now();
    const events: AgentEvent[] = [this.#appendEvent(database, {
      projectId: command.projectId,
      sessionId: command.sessionId,
      runId: command.runId,
      ...(current.currentTurnId === null ? {} : { turnId: current.currentTurnId }),
      attemptId: command.attemptId,
      type: 'context.compacted',
      payload: {
        checkpointId: command.checkpointId,
        decisionId: command.decisionId,
        summaryRef: command.summaryRef,
        summary: command.summary,
        coveredSequence: command.coveredSequence,
        attemptId: command.attemptId,
        ...(command.usage === undefined ? {} : { usage: command.usage }),
      },
      occurredAt,
    })];
    if (command.usage !== undefined) {
      if (command.billingMode === undefined) {
        throw new AgentJournalError(
          'INVALID_ARGUMENT',
          'Context compaction usage requires its immutable billing mode.',
        );
      }
      const usagePayload: AgentEventPayloadMap['usage.recorded'] = {
        scope: 'attempt',
        usageId: usageIdentity(command.runId, command.attemptId, 'context-compaction'),
        purpose: 'context-compaction',
        billingMode: command.billingMode,
        ...(current.currentTurnId === null ? {} : { turnId: current.currentTurnId }),
        attemptId: command.attemptId,
        inputTokens: command.usage.inputTokens,
        outputTokens: command.usage.outputTokens,
        totalTokens: command.usage.totalTokens,
      };
      if (!usageAlreadyPersisted(database, usagePayload)) events.push(this.#appendEvent(database, {
        projectId: command.projectId,
        sessionId: command.sessionId,
        runId: command.runId,
        ...(current.currentTurnId === null ? {} : { turnId: current.currentTurnId }),
        attemptId: command.attemptId,
        type: 'usage.recorded',
        payload: usagePayload,
        occurredAt,
      }));
    }
    const completed = freezeContextCheckpoint({
      ...checkpoint,
      status: 'compacted',
      summaryRef: command.summaryRef,
      summary: command.summary,
      attemptId: command.attemptId,
      ...(command.usage === undefined ? {} : { usage: command.usage }),
      updatedAt: occurredAt,
    });
    this.#injectKernel('after-events-before-projection');
    persistContextCheckpointProjection(database, completed);
    persistUsageEvents(database, events);
    persistKernelRunProjectionCas(
      database,
      current,
      projectKernelRunEvents(current, events),
      command.expectedRunRevision,
      'Concurrent Context completion won the race.',
    );
    const result: KernelJournalCommitResult = {
      events,
      run: readKernelRunProjection(database, command.runId),
      checkpoint: completed,
    };
    writeCommandResult(
      database, command.projectId, command.commandId, 'kernel.context-complete',
      requestDigest, result, occurredAt,
    );
    return result;
  }

  #commitFailContextCompaction(
    database: NodeDatabaseSync,
    command: Extract<KernelJournalCommand, { action: 'fail-context-compaction' }>,
    requestDigest: string,
  ): KernelJournalCommitResult {
    const current = readKernelRunProjection(database, command.runId);
    const checkpoint = readContextCheckpointProjection(database, command.checkpointId);
    if (
      current.state !== 'Compacting' || checkpoint === null || checkpoint.status !== 'started' ||
      checkpoint.decisionId !== command.decisionId
    ) {
      throw new AgentJournalError(
        'COMMAND_CONFLICT', 'Context failure does not match the active checkpoint.',
      );
    }
    const occurredAt = this.#now();
    const event = this.#appendEvent(database, {
      projectId: command.projectId,
      sessionId: command.sessionId,
      runId: command.runId,
      ...(current.currentTurnId === null ? {} : { turnId: current.currentTurnId }),
      type: 'context.compaction_failed',
      payload: {
        checkpointId: command.checkpointId,
        decisionId: command.decisionId,
        code: command.code,
      },
      occurredAt,
    });
    const failed = freezeContextCheckpoint({
      ...checkpoint,
      status: 'failed',
      failureCode: command.code,
      updatedAt: occurredAt,
    });
    this.#injectKernel('after-events-before-projection');
    persistContextCheckpointProjection(database, failed);
    persistKernelRunProjectionCas(
      database,
      current,
      projectKernelRunEvent(current, event),
      command.expectedRunRevision,
      'Concurrent Context failure won the race.',
    );
    const result: KernelJournalCommitResult = {
      events: [event],
      run: readKernelRunProjection(database, command.runId),
      checkpoint: failed,
    };
    writeCommandResult(
      database, command.projectId, command.commandId, 'kernel.context-fail',
      requestDigest, result, occurredAt,
    );
    return result;
  }

  #commitCaptureTurn(
    database: NodeDatabaseSync,
    command: Extract<KernelJournalCommand, { action: 'capture-turn' }>,
    requestDigest: string,
  ): KernelJournalCommitResult {
    const current = readKernelRunProjection(database, command.runId);
    const runRow = database.prepare(
      `SELECT state FROM agent_runs
       WHERE project_id = ? AND session_id = ? AND run_id = ?`,
    ).get(command.projectId, command.sessionId, command.runId) as { state: string };
    const allowed = ['created', 'Preparing'];
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
    if (runRow.state === 'created') {
      events.push(this.#appendEvent(database, {
        projectId: command.projectId, sessionId: command.sessionId, runId: command.runId,
        type: 'run.started', payload: {}, occurredAt,
      }));
    }
    const turnStarted = this.#appendEvent(database, {
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
    });
    events.push(turnStarted);
    events.push(this.#appendEvent(database, {
      projectId: command.projectId, sessionId: command.sessionId, runId: command.runId,
      turnId: command.turnId,
      parentEventId: turnStarted.eventId,
      type: 'capability.snapshot_captured',
      payload: {
        snapshotId: command.snapshot.capability.snapshotId,
        revision: command.snapshot.capability.revision,
      }, occurredAt,
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
      database, command.projectId, command.commandId, 'kernel.capture-turn',
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
    const terminal = command.decision.outcome === 'revision-requested'
      ? undefined
      : this.#appendEvent(database, {
          projectId: command.projectId, sessionId: command.sessionId, runId: command.runId,
          turnId: command.turnId, parentEventId: close.eventId,
          type: command.decision.outcome === 'accepted' ? 'run.completed' : 'run.failed',
          payload: command.decision.outcome === 'accepted' ? {
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
      database, current, projectKernelRunEvents(
        current,
        terminal === undefined ? [delivery, close] : [delivery, close, terminal],
      ),
      command.expectedRunRevision, 'Concurrent Run finalization won the race.',
    );
    const result: KernelJournalCommitResult = {
      events: terminal === undefined ? [delivery, close] : [delivery, close, terminal],
      run: readKernelRunProjection(database, command.runId),
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

  async readSession(input: Readonly<{
    projectId: string;
    sessionId: string;
    afterSequence: number;
    limit: number;
    throughSequence?: number;
    eventTypes?: readonly AgentEventType[];
  }>): Promise<AgentEvent[]> {
    await Promise.resolve();
    const projectId = requireText(input.projectId, 'projectId');
    const sessionId = requireText(input.sessionId, 'sessionId');
    if (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0) {
      throw new AgentJournalError('INVALID_ARGUMENT', 'afterSequence must be non-negative.');
    }
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 10_000) {
      throw new AgentJournalError('INVALID_ARGUMENT', 'Session event limit must be between 1 and 10000.');
    }
    if (
      input.throughSequence !== undefined && (
        !Number.isSafeInteger(input.throughSequence) ||
        input.throughSequence < input.afterSequence
      )
    ) {
      throw new AgentJournalError(
        'INVALID_ARGUMENT', 'Session event upper sequence must follow the cursor.',
      );
    }
    const eventTypes = input.eventTypes === undefined
      ? undefined
      : [...new Set(input.eventTypes)];
    if (eventTypes?.some((eventType) => !isAgentEventType(eventType)) === true) {
      throw new AgentJournalError('INVALID_ARGUMENT', 'Session event type filter is invalid.');
    }
    if (eventTypes?.length === 0) return [];
    return this.#withDatabase((database) => {
      const throughClause = input.throughSequence === undefined ? '' : ' AND sequence <= ?';
      const typeClause = eventTypes === undefined
        ? ''
        : ` AND event_type IN (${eventTypes.map(() => '?').join(', ')})`;
      const parameters: Array<string | number> = [
        projectId,
        sessionId,
        input.afterSequence,
        ...(input.throughSequence === undefined ? [] : [input.throughSequence]),
        ...(eventTypes ?? []),
        input.limit,
      ];
      const rows = database.prepare(
        `SELECT * FROM agent_events
         WHERE project_id = ? AND session_id = ? AND sequence > ?
           ${throughClause}${typeClause}
         ORDER BY sequence ASC LIMIT ?`,
      ).all(...parameters) as unknown as EventRow[];
      return rows.map((row) => {
        assertStoredParentCausality(database, row);
        return eventFromRow(row);
      });
    });
  }

  async getSessionIndex(projectIdInput: string, sessionIdInput: string): Promise<SessionIndexProjection | null> {
    await Promise.resolve();
    const projectId = requireText(projectIdInput, 'projectId');
    const sessionId = requireText(sessionIdInput, 'sessionId');
    return this.#withDatabase((database) => {
      const row = readSessionIndexRow(database, projectId, sessionId);
      return row === undefined ? null : sessionIndexFromRow(row);
    });
  }

  async getSessionState(
    projectIdInput: string,
    sessionIdInput: string,
  ): Promise<SessionStateProjection | null> {
    await Promise.resolve();
    const projectId = requireText(projectIdInput, 'projectId');
    const sessionId = requireText(sessionIdInput, 'sessionId');
    return this.#withDatabase((database) => {
      const indexRow = readSessionIndexRow(database, projectId, sessionId);
      if (indexRow === undefined) return null;
      const bindingRow = database.prepare(
        `SELECT payload_json FROM agent_session_model_bindings
         WHERE project_id = ? AND session_id = ?`,
      ).get(projectId, sessionId) as { payload_json: string } | undefined;
      const skillRow = database.prepare(
        `SELECT payload_json FROM agent_session_skill_configurations
         WHERE project_id = ? AND session_id = ?`,
      ).get(projectId, sessionId) as { payload_json: string } | undefined;
      return deepFreezeKernelValue({
        index: sessionIndexFromRow(indexRow),
        modelBinding: bindingRow === undefined
          ? null
          : parsePortableJson(bindingRow.payload_json) as unknown as SessionModelBinding,
        skillConfiguration: skillRow === undefined
          ? null
          : parsePortableJson(skillRow.payload_json) as unknown as SessionSkillConfiguration,
      });
    });
  }

  async listSessionIndexes(input: ListSessionIndexesInput): Promise<SessionIndexProjection[]> {
    await Promise.resolve();
    const projectId = requireText(input.projectId, 'projectId');
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_001) {
      throw new AgentJournalError('INVALID_ARGUMENT', 'Session list limit must be between 1 and 1001.');
    }
    if (input.archived !== undefined && typeof input.archived !== 'boolean') {
      throw new AgentJournalError('INVALID_ARGUMENT', 'Session archived filter must be boolean.');
    }
    if (input.visibility !== undefined && input.visibility !== 'public' && input.visibility !== 'internal') {
      throw new AgentJournalError('INVALID_ARGUMENT', 'Session visibility filter is invalid.');
    }
    const before = input.before;
    if (before !== undefined) {
      requireText(before.updatedAt, 'before.updatedAt');
      requireText(before.sessionId, 'before.sessionId');
      if (!Number.isSafeInteger(before.lastActivitySequence) || before.lastActivitySequence < 0) {
        throw new AgentJournalError('INVALID_ARGUMENT', 'Session cursor sequence is invalid.');
      }
    }
    return this.#withDatabase((database) => {
      const filters = ['project_id = ?'];
      const parameters: Array<string | number> = [projectId];
      if (input.archived !== undefined) {
        filters.push('archived = ?');
        parameters.push(input.archived ? 1 : 0);
      }
      if (input.visibility !== undefined) {
        filters.push('visibility = ?');
        parameters.push(input.visibility);
      }
      if (before !== undefined) {
        filters.push(`(
          updated_at < ? OR
          (updated_at = ? AND last_activity_sequence < ?) OR
          (updated_at = ? AND last_activity_sequence = ? AND session_id > ?)
        )`);
        parameters.push(
          before.updatedAt, before.updatedAt, before.lastActivitySequence,
          before.updatedAt, before.lastActivitySequence, before.sessionId,
        );
      }
      parameters.push(input.limit);
      const rows = database.prepare(
        `SELECT project_id, session_id, session_kind, visibility, parent_run_id, parent_session_id,
                archive_revision, archived, title,
                created_at, updated_at, last_activity_sequence, run_count
         FROM agent_sessions
         WHERE ${filters.join(' AND ')}
         ORDER BY updated_at DESC, last_activity_sequence DESC, session_id ASC
         LIMIT ?`,
      ).all(...parameters) as unknown as SessionIndexRow[];
      return rows.map(sessionIndexFromRow);
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

  /** Read the single authoritative terminal delivery fact without replaying Run history. */
  async getRunCompletion(input: Readonly<{
    projectId: string;
    sessionId: string;
    runId: string;
  }>): Promise<Readonly<{
    sourceSequence: number;
    finalContentRef: string;
    deliveryStatus: 'not-required' | 'verified' | 'unverified';
    evidenceRefs: readonly string[];
  }> | null> {
    await Promise.resolve();
    const projectId = requireText(input.projectId, 'projectId');
    const sessionId = requireText(input.sessionId, 'sessionId');
    const runId = requireText(input.runId, 'runId');
    return this.#withDatabase((database) => {
      const row = database.prepare(
        `SELECT * FROM agent_events
         WHERE project_id = ? AND session_id = ? AND run_id = ?
           AND event_type = 'run.completed'
         ORDER BY sequence DESC LIMIT 1`,
      ).get(projectId, sessionId, runId) as EventRow | undefined;
      if (row === undefined) return null;
      const event = eventFromRow(row);
      if (event.type !== 'run.completed') {
        throw new AgentJournalError('PROJECTION_CORRUPT', 'Run completion fact is invalid.');
      }
      return Object.freeze({
        sourceSequence: event.sequence,
        finalContentRef: event.payload.finalContentRef,
        deliveryStatus: event.payload.deliveryStatus,
        evidenceRefs: Object.freeze([...event.payload.evidenceRefs]),
      });
    });
  }

  /** Read the authoritative terminal failure without scanning unrelated Run history. */
  async getRunTerminalFailure(input: Readonly<{
    projectId: string;
    sessionId: string;
    runId: string;
  }>): Promise<Readonly<{
    sourceSequence: number;
    status: 'failed' | 'interrupted';
    code: string;
    detail?: PortableValue;
  }> | null> {
    await Promise.resolve();
    const projectId = requireText(input.projectId, 'projectId');
    const sessionId = requireText(input.sessionId, 'sessionId');
    const runId = requireText(input.runId, 'runId');
    return this.#withDatabase((database) => {
      const row = database.prepare(
        `SELECT * FROM agent_events
         WHERE project_id = ? AND session_id = ? AND run_id = ?
           AND event_type IN ('run.failed', 'run.interrupted')
         ORDER BY sequence DESC LIMIT 1`,
      ).get(projectId, sessionId, runId) as EventRow | undefined;
      if (row === undefined) return null;
      const event = eventFromRow(row);
      if (event.type !== 'run.failed' && event.type !== 'run.interrupted') {
        throw new AgentJournalError('PROJECTION_CORRUPT', 'Run terminal failure fact is invalid.');
      }
      return Object.freeze({
        sourceSequence: event.sequence,
        status: event.type === 'run.failed' ? 'failed' as const : 'interrupted' as const,
        code: event.payload.code,
        ...(event.payload.detail === undefined
          ? {}
          : { detail: structuredClone(event.payload.detail) }),
      });
    });
  }

  async waitRunEvents(input: WaitRunEventsInput): Promise<WaitRunEventsResult> {
    await Promise.resolve();
    assertExactObjectKeys(input, [
      'projectId', 'sessionId', 'runId', 'afterSequence', 'limit', 'timeoutMs',
    ], ['signal']);
    const projectId = requireText(input.projectId, 'projectId');
    const sessionId = requireText(input.sessionId, 'sessionId');
    const runId = requireText(input.runId, 'runId');
    if (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0) {
      throw new AgentJournalError('INVALID_ARGUMENT', 'afterSequence must be non-negative.');
    }
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
      throw new AgentJournalError('INVALID_ARGUMENT', 'Run event limit must be between 1 and 1000.');
    }
    if (
      !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 0 ||
      input.timeoutMs > MAX_RUN_EVENT_WAIT_MS
    ) {
      throw new AgentJournalError(
        'INVALID_ARGUMENT', `timeoutMs must be between 0 and ${MAX_RUN_EVENT_WAIT_MS}.`,
      );
    }
    const signal = input.signal;
    if (signal !== undefined && !isAbortSignal(signal)) {
      throw new AgentJournalError('INVALID_ARGUMENT', 'signal must be an AbortSignal.');
    }
    if (signal?.aborted === true) throw abortError();

    const cursor = Object.freeze({
      projectId, sessionId, runId,
      afterSequence: input.afterSequence,
      limit: input.limit,
    });
    const initial = this.#readRunWaitSnapshot(cursor);
    if (initial.events.length > 0 || initial.closed || input.timeoutMs === 0) return initial;

    return await new Promise<WaitRunEventsResult>((resolveWait, rejectWait) => {
      let settled = false;
      const busKey = resolve(this.filePath);
      const bus = getJournalWaitBus(busKey);

      const cleanup = (): void => {
        clearTimeout(timeout);
        clearInterval(poll);
        bus.listeners.delete(onJournalCommit);
        releaseJournalWaitBus(busKey, bus);
        signal?.removeEventListener('abort', onAbort);
      };
      const settle = (page: WaitRunEventsResult): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolveWait(page);
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectWait(error instanceof Error ? error : new Error(String(error)));
      };
      const inspect = (): void => {
        if (settled) return;
        try {
          const page = this.#readRunWaitSnapshot(cursor);
          if (page.events.length > 0 || page.closed) settle(page);
        } catch (error) {
          fail(error);
        }
      };
      const onJournalCommit = (): void => inspect();
      const onAbort = (): void => fail(abortError());

      bus.listeners.add(onJournalCommit);
      signal?.addEventListener('abort', onAbort, { once: true });
      const poll = setInterval(inspect, RUN_EVENT_POLL_INTERVAL_MS);
      const timeout = setTimeout(() => {
        if (settled) return;
        try {
          settle(this.#readRunWaitSnapshot(cursor));
        } catch (error) {
          fail(error);
        }
      }, input.timeoutMs);
      // Registration precedes this second read, closing the read/subscribe race.
      inspect();
    });
  }

  #readRunWaitSnapshot(input: Readonly<{
    projectId: string; sessionId: string; runId: string; afterSequence: number; limit: number;
  }>): WaitRunEventsResult {
    return this.#withDatabase((database) => {
      this.#assertRun(database, input.projectId, input.sessionId, input.runId);
      const rows = database.prepare(
        `SELECT * FROM agent_events
         WHERE project_id = ? AND session_id = ? AND run_id = ? AND sequence > ?
         ORDER BY sequence ASC LIMIT ?`,
      ).all(
        input.projectId, input.sessionId, input.runId, input.afterSequence, input.limit + 1,
      ) as unknown as EventRow[];
      const hasUnread = rows.length > input.limit;
      const events = rows.slice(0, input.limit).map((row) => {
        assertStoredParentCausality(database, row);
        return eventFromRow(row);
      });
      const terminal = database.prepare(
        `SELECT 1 AS present FROM agent_events
         WHERE project_id = ? AND session_id = ? AND run_id = ?
           AND event_type IN ('run.completed', 'run.failed', 'run.cancelled')
         LIMIT 1`,
      ).get(input.projectId, input.sessionId, input.runId) !== undefined;
      return Object.freeze({
        events: Object.freeze(events),
        nextSequence: events.at(-1)?.sequence ?? null,
        closed: terminal && !hasUnread,
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

  async getPendingContextCompaction(
    input: GetPendingContextCompactionInput,
  ): Promise<PendingContextCompaction | null> {
    await Promise.resolve();
    assertExactObjectKeys(input, ['projectId', 'sessionId', 'runId']);
    const projectId = requireText(input.projectId, 'projectId');
    const sessionId = requireText(input.sessionId, 'sessionId');
    const runId = requireText(input.runId, 'runId');
    return this.#withDatabase((database) => {
      this.#assertRun(database, projectId, sessionId, runId);
      return readPendingContextCompaction(database, runId);
    });
  }

  async getRuntimeCommandProjection(
    input: GetRuntimeCommandProjectionInput,
  ): Promise<RuntimeCommandProjection | null> {
    await Promise.resolve();
    assertExactObjectKeys(input, ['projectId', 'sessionId', 'runId']);
    const projectId = requireText(input.projectId, 'projectId');
    const sessionId = requireText(input.sessionId, 'sessionId');
    const runId = requireText(input.runId, 'runId');
    return this.#withDatabase((database) => {
      this.#assertRun(database, projectId, sessionId, runId);
      return readRuntimeCommandProjection(database, { projectId, sessionId, runId });
    });
  }

  async getPendingSteering(input: Readonly<{
    projectId: string; sessionId: string; runId: string;
  }>): Promise<PendingSteering | null> {
    await Promise.resolve();
    assertExactObjectKeys(input, ['projectId', 'sessionId', 'runId']);
    const projectId = requireText(input.projectId, 'projectId');
    const sessionId = requireText(input.sessionId, 'sessionId');
    const runId = requireText(input.runId, 'runId');
    return this.#withDatabase((database) => {
      this.#assertRun(database, projectId, sessionId, runId);
      const row = database.prepare(
        `SELECT client_request_id, input_json, queued_at
         FROM agent_pending_steering
         WHERE project_id = ? AND session_id = ? AND run_id = ? AND consumed_at IS NULL
         ORDER BY queue_sequence ASC LIMIT 1`,
      ).get(projectId, sessionId, runId) as {
        client_request_id: string; input_json: string; queued_at: string;
      } | undefined;
      return row === undefined ? null : {
        clientRequestId: row.client_request_id,
        input: parsePortableJson(row.input_json),
        queuedAt: row.queued_at,
      };
    });
  }

  async getSteeringRequest(input: Readonly<{
    projectId: string; sessionId: string; runId: string; clientRequestId: string;
  }>): Promise<SteeringRequest | null> {
    await Promise.resolve();
    assertExactObjectKeys(input, ['projectId', 'sessionId', 'runId', 'clientRequestId']);
    const projectId = requireText(input.projectId, 'projectId');
    const sessionId = requireText(input.sessionId, 'sessionId');
    const runId = requireText(input.runId, 'runId');
    const clientRequestId = requireText(input.clientRequestId, 'clientRequestId');
    return this.#withDatabase((database) => {
      this.#assertRun(database, projectId, sessionId, runId);
      const row = database.prepare(
        `SELECT input_json, queued_at, consumed_at FROM agent_pending_steering
         WHERE project_id = ? AND session_id = ? AND run_id = ? AND client_request_id = ?`,
      ).get(projectId, sessionId, runId, clientRequestId) as {
        input_json: string; queued_at: string; consumed_at: string | null;
      } | undefined;
      return row === undefined ? null : {
        clientRequestId, input: parsePortableJson(row.input_json), queuedAt: row.queued_at,
        ...(row.consumed_at === null ? {} : { consumedAt: row.consumed_at }),
      };
    });
  }

  async getContextCheckpoint(input: Readonly<{
    projectId: string; sessionId: string; runId: string; checkpointId: string;
  }>): Promise<PersistedContextCheckpoint | null> {
    await Promise.resolve();
    const projectId = requireText(input.projectId, 'projectId');
    const sessionId = requireText(input.sessionId, 'sessionId');
    const runId = requireText(input.runId, 'runId');
    const checkpointId = requireText(input.checkpointId, 'checkpointId');
    return this.#withDatabase((database) => {
      this.#assertRun(database, projectId, sessionId, runId);
      const checkpoint = readContextCheckpointProjection(database, checkpointId);
      if (checkpoint === null) return null;
      if (
        checkpoint.projectId !== projectId || checkpoint.sessionId !== sessionId ||
        checkpoint.runId !== runId
      ) {
        throw new AgentJournalError(
          'RUN_IDENTITY_CONFLICT', 'Context checkpoint does not belong to this Run.',
        );
      }
      return checkpoint;
    });
  }

  async getLatestContextCheckpoint(input: Readonly<{
    projectId: string; sessionId: string; runId: string;
    status?: PersistedContextCheckpoint['status'];
  }>): Promise<PersistedContextCheckpoint | null> {
    await Promise.resolve();
    const projectId = requireText(input.projectId, 'projectId');
    const sessionId = requireText(input.sessionId, 'sessionId');
    const runId = requireText(input.runId, 'runId');
    return this.#withDatabase((database) => {
      this.#assertRun(database, projectId, sessionId, runId);
      const rows = database.prepare(
        `SELECT payload_json FROM agent_context_checkpoints
         WHERE project_id = ? AND run_id = ? ORDER BY created_at DESC, checkpoint_id DESC`,
      ).all(projectId, runId) as unknown as Array<{ payload_json: string }>;
      for (const row of rows) {
        const checkpoint = freezeContextCheckpoint(
          parsePortableJson(row.payload_json) as unknown as PersistedContextCheckpoint,
        );
        if (checkpoint.sessionId !== sessionId) {
          throw new AgentJournalError(
            'PROJECTION_CORRUPT', 'Context checkpoint Session identity disagrees.',
          );
        }
        if (input.status === undefined || checkpoint.status === input.status) return checkpoint;
      }
      return null;
    });
  }

  async getLatestSessionContextCheckpoint(input: Readonly<{
    projectId: string;
    sessionId: string;
    throughSequence: number;
    status?: PersistedContextCheckpoint['status'];
  }>): Promise<PersistedContextCheckpoint | null> {
    await Promise.resolve();
    const projectId = requireText(input.projectId, 'projectId');
    const sessionId = requireText(input.sessionId, 'sessionId');
    if (!Number.isSafeInteger(input.throughSequence) || input.throughSequence < 0) {
      throw new AgentJournalError(
        'INVALID_ARGUMENT', 'Session Context checkpoint boundary must be non-negative.',
      );
    }
    return this.#withDatabase((database) => {
      const statusClause = input.status === undefined
        ? ''
        : ` AND json_extract(checkpoint.payload_json, '$.status') = ?`;
      const row = database.prepare(
        `SELECT checkpoint.payload_json
         FROM agent_context_checkpoints AS checkpoint
         INNER JOIN agent_runs AS run
           ON run.project_id = checkpoint.project_id AND run.run_id = checkpoint.run_id
         WHERE checkpoint.project_id = ? AND run.session_id = ?
           AND checkpoint.covered_sequence <= ?
           ${statusClause}
         ORDER BY checkpoint.covered_sequence DESC,
                  checkpoint.created_at DESC,
                  checkpoint.checkpoint_id DESC
         LIMIT 1`,
      ).get(
        projectId,
        sessionId,
        input.throughSequence,
        ...(input.status === undefined ? [] : [input.status]),
      ) as { payload_json: string } | undefined;
      if (row === undefined) return null;
      const checkpoint = freezeContextCheckpoint(
        parsePortableJson(row.payload_json) as unknown as PersistedContextCheckpoint,
      );
      if (
        checkpoint.projectId !== projectId || checkpoint.sessionId !== sessionId ||
        (input.status !== undefined && checkpoint.status !== input.status)
      ) {
        throw new AgentJournalError(
          'PROJECTION_CORRUPT', 'Session Context checkpoint identity or status disagrees.',
        );
      }
      return checkpoint;
    });
  }

  async getScopedCommittedTurn(input: Readonly<{
    projectId: string; sessionId: string; runId: string; turnId: string;
  }>): Promise<AgentTurnProjection | null> {
    await Promise.resolve();
    const projectId = requireText(input.projectId, 'projectId');
    const sessionId = requireText(input.sessionId, 'sessionId');
    const runId = requireText(input.runId, 'runId');
    const turnId = requireText(input.turnId, 'turnId');
    return this.#withDatabase((database) => {
      this.#assertRun(database, projectId, sessionId, runId);
      const row = database.prepare(
        `SELECT payload_json FROM agent_turns
         WHERE project_id = ? AND session_id = ? AND run_id = ? AND turn_id = ?`,
      ).get(projectId, sessionId, runId, turnId) as { payload_json: string } | undefined;
      return row === undefined
        ? null
        : deepFreezeKernelValue(
            parsePortableJson(row.payload_json) as unknown as AgentTurnProjection,
          );
    });
  }

  async getRunUsage(input: Readonly<{
    projectId: string; sessionId: string; runId: string;
  }>): Promise<Readonly<{
    records: readonly AgentEventPayloadMap['usage.recorded'][];
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  }>> {
    await Promise.resolve();
    const projectId = requireText(input.projectId, 'projectId');
    const sessionId = requireText(input.sessionId, 'sessionId');
    const runId = requireText(input.runId, 'runId');
    return this.#withDatabase((database) => {
      this.#assertRun(database, projectId, sessionId, runId);
      const rows = database.prepare(
        `SELECT payload_json FROM agent_usage
         WHERE project_id = ? AND session_id = ? AND run_id = ?
         ORDER BY created_at ASC, usage_id ASC`,
      ).all(projectId, sessionId, runId) as unknown as Array<{ payload_json: string }>;
      const records = rows.map((row) => normalizeUsagePayload(parsePortableJson(row.payload_json)));
      return deepFreezeKernelValue({
        records,
        inputTokens: records.reduce((sum, record) => sum + record.inputTokens, 0),
        outputTokens: records.reduce((sum, record) => sum + record.outputTokens, 0),
        totalTokens: records.reduce((sum, record) => sum + record.totalTokens, 0),
      });
    });
  }

  /** Absolute, idempotent project totals from durable usage facts, grouped by billing mode. */
  async getProjectUsageTotals(projectId: string): Promise<readonly ProjectUsageTotal[]> {
    await Promise.resolve();
    const normalizedProjectId = requireText(projectId, 'projectId');
    return this.#withDatabase((database) => {
      const rows = database.prepare(
        `SELECT billing_mode,
          MIN(created_at) AS window_started_at,
          SUM(input_tokens) AS input_tokens,
          SUM(output_tokens) AS output_tokens,
          SUM(total_tokens) AS total_tokens
         FROM agent_usage WHERE project_id = ? GROUP BY billing_mode`,
      ).all(normalizedProjectId) as Array<{
        billing_mode: unknown;
        window_started_at: unknown;
        input_tokens: unknown;
        output_tokens: unknown;
        total_tokens: unknown;
      }>;
      return Object.freeze(rows.map((row) => {
        const billingMode = requireUsageBillingMode(row.billing_mode, 'agent_usage.billing_mode');
        return Object.freeze({
          billingMode,
          windowStartedAt: requireIsoTimestamp(
            row.window_started_at,
            'agent_usage.created_at',
          ),
          inputTokens: requireUsageAggregate(row.input_tokens, 'inputTokens'),
          outputTokens: requireUsageAggregate(row.output_tokens, 'outputTokens'),
          totalTokens: requireUsageAggregate(row.total_tokens, 'totalTokens'),
        });
      }));
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

  async getSessionSkillConfiguration(
    projectIdInput: string,
    sessionIdInput: string,
  ): Promise<SessionSkillConfiguration | null> {
    await Promise.resolve();
    const projectId = requireText(projectIdInput, 'projectId');
    const sessionId = requireText(sessionIdInput, 'sessionId');
    return this.#withDatabase((database) => {
      const row = database.prepare(
        `SELECT payload_json FROM agent_session_skill_configurations
         WHERE project_id = ? AND session_id = ?`,
      ).get(projectId, sessionId) as { payload_json: string } | undefined;
      if (row === undefined) return null;
      return deepFreezeKernelValue(
        parsePortableJson(row.payload_json) as unknown as SessionSkillConfiguration,
      );
    });
  }

  async readSessionEvents(input: Readonly<{
    projectId: string; sessionId: string; afterSequence: number; limit: number;
  }>): Promise<Readonly<{ events: readonly SessionJournalEvent[]; nextSequence: number | null }>> {
    await Promise.resolve();
    requireText(input.projectId, 'projectId');
    requireText(input.sessionId, 'sessionId');
    if (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0 ||
      !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
      throw new AgentJournalError('INVALID_ARGUMENT', 'Session event cursor or limit is invalid.');
    }
    return this.#withDatabase((database) => {
      const rows = database.prepare(
        `SELECT sequence, event_id, schema_version, event_type, payload_json, occurred_at
         FROM agent_session_events
         WHERE project_id = ? AND session_id = ? AND sequence > ?
         ORDER BY sequence ASC LIMIT ?`,
      ).all(input.projectId, input.sessionId, input.afterSequence, input.limit) as unknown as Array<{
        sequence: number; event_id: string; schema_version: number; event_type: string;
        payload_json: string; occurred_at: string;
      }>;
      const events = rows.map((row) => deepFreezeKernelValue(upcastSessionJournalEvent({
        schemaVersion: row.schema_version,
        projectId: input.projectId,
        sessionId: input.sessionId,
        sequence: row.sequence,
        eventId: row.event_id,
        type: row.event_type,
        payload: parsePortableJson(row.payload_json),
        occurredAt: row.occurred_at,
      })));
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
      const contextReplay = replayContextCheckpointFacts(events);
      const runtimeCommandReplay = replayRuntimeCommandFacts(events);
      database.prepare('DELETE FROM agent_observations WHERE project_id = ?').run(projectId);
      database.prepare('DELETE FROM agent_approvals WHERE project_id = ?').run(projectId);
      database.prepare('DELETE FROM agent_invocations WHERE project_id = ?').run(projectId);
      database.prepare('DELETE FROM agent_protocol_envelopes WHERE project_id = ?').run(projectId);
      database.prepare('DELETE FROM agent_turns WHERE project_id = ?').run(projectId);
      database.prepare('DELETE FROM agent_attempts WHERE project_id = ?').run(projectId);
      database.prepare('DELETE FROM agent_turn_lifecycles WHERE project_id = ?').run(projectId);
      database.prepare('DELETE FROM agent_context_checkpoints WHERE project_id = ?').run(projectId);
      database.prepare(
        'DELETE FROM agent_context_compaction_requests WHERE project_id = ?',
      ).run(projectId);
      database.prepare('DELETE FROM agent_usage WHERE project_id = ?').run(projectId);
      database.prepare('DELETE FROM agent_model_run_windows WHERE project_id = ?').run(projectId);
      database.prepare('DELETE FROM agent_tool_run_windows WHERE project_id = ?').run(projectId);
      database.prepare('DELETE FROM agent_pending_steering WHERE project_id = ?').run(projectId);
      database.prepare(
        'DELETE FROM agent_runtime_command_projections WHERE project_id = ?',
      ).run(projectId);
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
      rebuildSessionProjectionTables(database, projectId);
      for (const replayed of runtimeCommandReplay.values()) {
        persistRuntimeCommandProjection(
          database, replayed.projection, replayed.updatedAt, true,
        );
      }
      for (const checkpoint of contextReplay.checkpoints) {
        persistContextCheckpointProjection(database, checkpoint);
      }
      for (const pending of contextReplay.pending) {
        persistPendingContextCompaction(database, pending);
      }
      persistUsageEvents(database, events);
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
      const committedTurnIds = new Set(replay.turns.map((turn) => turn.turnId));
      const closedTurns = new Map<string, Extract<AgentEvent, { type: 'turn.closed' }>>();
      for (const closed of events.filter(
        (event): event is Extract<AgentEvent, { type: 'turn.closed' }> =>
          event.type === 'turn.closed',
      )) {
        if (closed.turnId === undefined || closedTurns.has(closed.turnId)) {
          throw new AgentJournalError(
            'PROJECTION_CORRUPT', 'Turn closure facts must identify one Turn exactly once.',
          );
        }
        closedTurns.set(closed.turnId, closed);
      }
      for (const started of events.filter((event) => event.type === 'turn.started')) {
        if (started.turnId === undefined) continue;
        const committed = committedTurnIds.has(started.turnId);
        const closed = closedTurns.get(started.turnId);
        if (closed !== undefined && closed.sequence <= started.sequence) {
          throw new AgentJournalError(
            'PROJECTION_CORRUPT', 'Turn closure precedes its start fact.',
          );
        }
        const status = closed === undefined ? (committed ? 'committed' : 'started') : 'closed';
        const revision = 1 + (committed ? 1 : 0) + (closed === undefined ? 0 : 1);
        database.prepare(
          `INSERT INTO agent_turn_lifecycles
            (project_id, session_id, run_id, turn_id, revision, status, started_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          started.projectId, started.sessionId, started.runId, started.turnId,
          revision, status, started.occurredAt,
        );
      }
      for (const turnId of closedTurns.keys()) {
        if (!events.some((event) => event.type === 'turn.started' && event.turnId === turnId)) {
          throw new AgentJournalError(
            'PROJECTION_CORRUPT', 'Turn closure has no matching start fact.',
          );
        }
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
            intent_digest, recovery_class, status, payload_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          approval.approvalId, approval.projectId, approval.runId, approval.invocationId,
          approval.toolRevision, approval.intentDigest, approval.recoveryClass,
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
      for (const window of kernelReplay.toolWindows.values()) {
        database.prepare(
          `INSERT INTO agent_tool_run_windows (
            run_id, project_id, session_id, turn_id, base_revision, current_revision
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          window.runId, window.projectId, window.sessionId, window.turnId,
          window.baseRevision, window.currentRevision,
        );
      }
      for (const window of kernelReplay.modelWindows.values()) {
        database.prepare(
          `INSERT INTO agent_model_run_windows (
            run_id, project_id, session_id, turn_id, attempt_id,
            base_revision, current_revision
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          window.runId, window.projectId, window.sessionId, window.turnId,
          window.attemptId, window.baseRevision, window.currentRevision,
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
        const fence = database
          .prepare(
            `SELECT last_fencing_token FROM agent_run_lease_fences
             WHERE project_id = ? AND run_id = ?`,
          )
          .get(normalized.projectId, normalized.runId) as
          | { last_fencing_token: number }
          | undefined;
        const lastFencingToken = Math.max(
          Number(current?.fencing_token ?? 0),
          Number(fence?.last_fencing_token ?? 0),
        );
        if (!Number.isSafeInteger(lastFencingToken) || lastFencingToken < 0) {
          throw new AgentJournalError(
            'PROJECTION_CORRUPT',
            'Run lease fencing counter is invalid.',
          );
        }
        const fencingToken = lastFencingToken + 1;
        if (!Number.isSafeInteger(fencingToken)) {
          throw new AgentJournalError(
            'PROJECTION_CORRUPT',
            'Run lease fencing counter is exhausted.',
          );
        }
        const expiresAtMs = nowMs + normalized.ttlMs;
        database
          .prepare(
            `INSERT INTO agent_run_lease_fences (project_id, run_id, last_fencing_token)
             VALUES (?, ?, ?)
             ON CONFLICT(project_id, run_id) DO UPDATE SET
               last_fencing_token = excluded.last_fencing_token`,
          )
          .run(normalized.projectId, normalized.runId, fencingToken);
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

  async releaseRunLease(input: ReleaseRunLeaseInput): Promise<boolean> {
    await Promise.resolve();
    const normalized = snapshotReleaseRunLeaseCommand(input);
    requireText(normalized.projectId, 'projectId');
    requireText(normalized.runId, 'runId');
    requireText(normalized.ownerId, 'ownerId');
    if (!Number.isSafeInteger(normalized.fencingToken) || normalized.fencingToken < 1) {
      throw new AgentJournalError('INVALID_ARGUMENT', 'fencingToken must be a positive integer.');
    }
    return this.#withDatabase((database) =>
      transaction(database, () => {
        this.#assertRun(database, normalized.projectId, undefined, normalized.runId);
        const result = database.prepare(
          `DELETE FROM agent_run_leases
           WHERE project_id = ? AND run_id = ? AND owner_id = ? AND fencing_token = ?`,
        ).run(
          normalized.projectId,
          normalized.runId,
          normalized.ownerId,
          normalized.fencingToken,
        );
        return Number(result.changes) === 1;
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

  async getTurnLifecycle(input: GetTurnLifecycleInput): Promise<TurnLifecycleProjection | null> {
    await Promise.resolve();
    const normalized = snapshotGetTurnLifecycleInput(input);
    const projectId = requireText(normalized.projectId, 'projectId');
    const sessionId = requireText(normalized.sessionId, 'sessionId');
    const runId = requireText(normalized.runId, 'runId');
    const turnId = requireText(normalized.turnId, 'turnId');
    return this.#withDatabase((database) => {
      this.#assertRun(database, projectId, sessionId, runId);
      const row = database.prepare(
        `SELECT project_id, session_id, run_id, revision, status
         FROM agent_turn_lifecycles WHERE turn_id = ?`,
      ).get(turnId) as {
        project_id: string;
        session_id: string;
        run_id: string;
        revision: number;
        status: string;
      } | undefined;
      if (row === undefined) return null;
      if (
        row.project_id !== projectId || row.session_id !== sessionId || row.run_id !== runId
      ) {
        throw new AgentJournalError(
          'RUN_IDENTITY_CONFLICT',
          'Turn does not belong to this Project/Session/Run.',
        );
      }
      const revision = Number(row.revision);
      if (
        !Number.isSafeInteger(revision) || revision < 1 ||
        (row.status !== 'started' && row.status !== 'committed' && row.status !== 'closed')
      ) {
        throw new AgentJournalError('PROJECTION_CORRUPT', 'Turn lifecycle projection is invalid.');
      }
      return Object.freeze({ revision, status: row.status });
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
      const createdRow = database.prepare(
        `SELECT * FROM agent_events
         WHERE project_id = ? AND run_id = ? AND event_type = 'run.created'
         ORDER BY sequence ASC LIMIT 1`,
      ).get(row.project_id, row.run_id) as EventRow | undefined;
      const created = createdRow === undefined ? undefined : eventFromRow(createdRow);
      if (created === undefined || created.type !== 'run.created') {
        throw new AgentJournalError('PROJECTION_CORRUPT', 'Run has no durable creation fact.');
      }
      const projection = {
        projectId: row.project_id,
        sessionId: row.session_id,
        runId: row.run_id,
        clientRequestId: row.client_request_id,
        ...(created.payload.parent === undefined
          ? {}
          : { parent: structuredClone(created.payload.parent) }),
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

  /** Exact durable ingress lookup used by host idempotent start before side effects. */
  async getRunAncestry(
    runId: string,
  ): Promise<RunAncestryProjection | null> {
    await Promise.resolve();
    return this.#withDatabase((database) => {
      const row = database.prepare(
        `SELECT project_id, run_id, parent_run_id, root_run_id, depth, root_child_ordinal
         FROM agent_run_ancestry WHERE run_id = ?`,
      ).get(requireText(runId, 'runId')) as {
        project_id: string; run_id: string; parent_run_id: string | null; root_run_id: string; depth: number; root_child_ordinal: number;
      } | undefined;
      return row === undefined ? null : Object.freeze({
        projectId: row.project_id, runId: row.run_id, parentRunId: row.parent_run_id,
        rootRunId: row.root_run_id, depth: Number(row.depth), rootChildOrdinal: Number(row.root_child_ordinal),
      });
    });
  }

  async countRootChildren(input: Readonly<{ projectId: string; rootRunId: string }>): Promise<number> {
    await Promise.resolve();
    return this.#withDatabase((database) => Number((database.prepare(
      `SELECT COUNT(*) AS count FROM agent_run_ancestry
       WHERE project_id = ? AND root_run_id = ? AND run_id <> ?`,
    ).get(requireText(input.projectId, 'projectId'), requireText(input.rootRunId, 'rootRunId'), input.rootRunId) as { count: number }).count));
  }

  async listRunDescendants(
    input: Readonly<{ projectId: string; rootRunId: string }>,
  ): Promise<RunAncestryProjection[]> {
    await Promise.resolve();
    return this.#withDatabase((database) => (database.prepare(
      `SELECT project_id, run_id, parent_run_id, root_run_id, depth, root_child_ordinal
       FROM agent_run_ancestry WHERE project_id = ? AND root_run_id = ? AND run_id <> ?
       ORDER BY depth ASC, run_id ASC`,
    ).all(requireText(input.projectId, 'projectId'), requireText(input.rootRunId, 'rootRunId'), input.rootRunId) as Array<{
      project_id: string; run_id: string; parent_run_id: string | null; root_run_id: string; depth: number; root_child_ordinal: number;
    }>).map((row) => Object.freeze({
      projectId: row.project_id, runId: row.run_id, parentRunId: row.parent_run_id,
      rootRunId: row.root_run_id, depth: Number(row.depth), rootChildOrdinal: Number(row.root_child_ordinal),
    })));
  }

  async findRunByClientRequest(input: Readonly<{
    projectId: string; sessionId: string; clientRequestId: string;
  }>): Promise<AgentRunProjection | null> {
    const projectId = requireText(input.projectId, 'projectId');
    const sessionId = requireText(input.sessionId, 'sessionId');
    const clientRequestId = requireText(input.clientRequestId, 'clientRequestId');
    const runId = this.#withDatabase((database) => {
      const row = database.prepare(
        `SELECT run_id FROM agent_runs
         WHERE project_id = ? AND session_id = ? AND client_request_id = ?`,
      ).get(projectId, sessionId, clientRequestId) as { run_id: string } | undefined;
      return row?.run_id ?? null;
    });
    return runId === null ? null : await this.getRunProjection(runId);
  }

  async getRunIngressConfiguration(input: Readonly<{
    projectId: string; sessionId: string; runId: string;
  }>): Promise<NonNullable<AgentEventPayloadMap['run.created']['configuration']> | null> {
    const projectId = requireText(input.projectId, 'projectId');
    const sessionId = requireText(input.sessionId, 'sessionId');
    const runId = requireText(input.runId, 'runId');
    return await Promise.resolve(this.#withDatabase((database) => {
      this.#assertRun(database, projectId, sessionId, runId);
      const row = database.prepare(
        `SELECT payload_json FROM agent_events
         WHERE project_id = ? AND session_id = ? AND run_id = ? AND event_type = 'run.created'
         ORDER BY sequence ASC LIMIT 1`,
      ).get(projectId, sessionId, runId) as { payload_json: string } | undefined;
      if (row === undefined) {
        throw new AgentJournalError('PROJECTION_CORRUPT', 'Run creation metadata is unavailable.');
      }
      const payload = parsePortableJson(row.payload_json) as unknown as
        AgentEventPayloadMap['run.created'];
      validateAndSnapshotEventPayload('run.created', payload);
      return payload.configuration === undefined ? null : structuredClone(payload.configuration);
    }));
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
      projectId, sessionId, runId, turnId, commandId, billingMode, attempt,
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
      billingMode,
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
        const kernelRun = database.prepare(
          `SELECT environment_binding_id, current_turn_id, current_attempt_id, turn_snapshot_id
           FROM agent_kernel_runs WHERE run_id = ?`,
        ).get(runId) as {
          environment_binding_id: string | null;
          current_turn_id: string | null; current_attempt_id: string | null;
          turn_snapshot_id: string | null;
        } | undefined;
        const effectiveRunRevision = kernelRun !== undefined &&
          kernelRun.environment_binding_id !== null
          ? resolveModelRunWindowRevision(database, {
              projectId, sessionId, runId, turnId,
              attemptId: attempt.attemptId, expectedRunRevision,
            }, false)
          : expectedRunRevision;
        this.#assertRunRevision(database, projectId, runId, effectiveRunRevision);
        let kernelCurrent: KernelRunProjection | null = null;
        if (kernelRun !== undefined && kernelRun.environment_binding_id !== null) {
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
            environment.payload.modelSession.primary,
            ...environment.payload.modelSession.fallbacks,
          ];
          if (!routes.some((route) =>
            route.route.connectionId === attempt.origin.connectionId &&
            route.route.modelId === attempt.origin.model &&
            route.route.protocol === attempt.origin.protocol)) {
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
        const committedUsagePayload: AgentEventPayloadMap['usage.recorded'] | undefined =
          attempt.usage === undefined
            ? undefined
            : {
                scope: 'attempt',
                usageId: usageIdentity(runId, attempt.attemptId, 'agent-turn'),
                purpose: 'agent-turn',
                billingMode,
                turnId,
                attemptId: attempt.attemptId,
                inputTokens: attempt.usage.inputTokens,
                outputTokens: attempt.usage.outputTokens,
                totalTokens: attempt.usage.totalTokens,
              };
        const usageEvent = committedUsagePayload === undefined ||
          usageAlreadyPersisted(database, committedUsagePayload)
          ? undefined
          : this.#appendEvent(database, {
              projectId,
              sessionId,
              runId,
              turnId,
              attemptId: attempt.attemptId,
              parentEventId: modelEvent.eventId,
              type: 'usage.recorded',
              payload: committedUsagePayload,
              occurredAt,
            });
        persistUsageEvents(database, usageEvent === undefined ? [] : [usageEvent]);
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
        const current = kernelCurrent ?? readKernelRunProjection(database, runId);
        const next = projectKernelRunEvent(current, modelEvent);
        persistKernelRunProjectionCas(
          database, current, next,
          effectiveRunRevision, 'Concurrent Run commit won the revision race.',
        );
        if (kernelCurrent !== null) {
          deleteModelRunWindow(database, runId, turnId, attempt.attemptId);
        }
        if (invocations.length > 0) {
          openToolRunWindow(database, next, turnId);
        } else {
          database.prepare('DELETE FROM agent_tool_run_windows WHERE run_id = ?').run(runId);
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

  #injectRuntimeCommand(point: RuntimeCommandCommitFaultPoint): void {
    if (this.#runtimeCommandFaultPoint !== point) return;
    this.#runtimeCommandFaultPoint = undefined;
    throw new Error(`INJECTED_RUNTIME_COMMAND_FAILURE:${point}`);
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

  #appendSessionEvent<T extends SessionJournalEventType>(
    database: NodeDatabaseSync,
    input: Readonly<{
      projectId: string;
      sessionId: string;
      type: T;
      payload: SessionJournalEventPayloadMap[T];
      occurredAt: string;
    }>,
  ): SessionJournalEvent<T> {
    validateSessionJournalPayload(input.type, input.payload as PortableValue);
    const sequenceRow = database.prepare(
      `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
       FROM agent_session_events WHERE project_id = ?`,
    ).get(input.projectId) as { next_sequence: number };
    const event = deepFreezeKernelValue({
      schemaVersion: 1,
      projectId: input.projectId,
      sessionId: input.sessionId,
      sequence: sequenceRow.next_sequence,
      eventId: `session_event_${this.#createId()}`,
      type: input.type,
      payload: structuredClone(input.payload),
      occurredAt: input.occurredAt,
    }) as unknown as SessionJournalEvent<T>;
    database.prepare(
      `INSERT INTO agent_session_events (
        project_id, sequence, event_id, schema_version, session_id,
        event_type, payload_json, occurred_at
      ) VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
    ).run(
      event.projectId, event.sequence, event.eventId, event.sessionId,
      event.type, JSON.stringify(event.payload), event.occurredAt,
    );
    return event;
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
    const event = {
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
    applySessionIndexAgentEvent(database, event);
    return event;
  }

  #applyRunProjection(database: NodeDatabaseSync, event: AgentEvent, expectedRevision?: number): void {
    const states: Partial<Record<AgentEventType, AgentRunProjection['state']>> = {
      'run.started': 'Preparing',
      'run.input_requested': 'AwaitingUser',
      'run.cancel_requested': 'Cancelling',
      'run.limit_reached': 'LimitReached',
      'run.completed': 'Completed',
      'run.failed': 'Failed',
      'run.cancelled': 'Cancelled',
      'run.interrupted': 'Interrupted',
    };
    const state = event.type === 'run.resumed' ? event.payload.resumeState : states[event.type];
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
    const sqliteModuleId = ['node', 'sqlite'].join(':');
    const { DatabaseSync } = createRequire(import.meta.url)(sqliteModuleId) as {
      DatabaseSync: NodeDatabaseSyncConstructor;
    };
    if (!existsSync(this.filePath)) {
      publishNewJournalAtomically(this.filePath, DatabaseSync, this.busyTimeoutMs);
    }
    let check: NodeDatabaseSync | undefined;
    try {
      check = new DatabaseSync(this.filePath, { readOnly: true });
      check.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs}`);
      try {
        const table = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_runtime_protocol'").get();
        const version = table === undefined ? undefined : check.prepare("SELECT version FROM agent_runtime_protocol WHERE singleton = 1").get() as { version: string } | undefined;
        if (version?.version !== RUNTIME_PROTOCOL_VERSION) throw new AgentJournalError('incompatible_state_store', 'The state store runtimeProtocolVersion is missing or incompatible. Select a fresh state root; this store was not modified.');
      } finally {
        check.close();
        check = undefined;
      }
    } catch (error) {
      try { check?.close(); } catch { /* Preserve the protocol-read failure. */ }
      if (isSqliteBusy(error)) {
        throw new AgentJournalError(
          'JOURNAL_BUSY',
          `Agent Journal remained busy for ${this.busyTimeoutMs}ms.`,
        );
      }
      throw error;
    }
    mkdirSync(dirname(this.filePath), { recursive: true });
    let database: NodeDatabaseSync | undefined;
    try {
      database = new DatabaseSync(this.filePath);
      initializeDatabaseWithBusyRetry(database, this.busyTimeoutMs);
      DATABASE_COMMIT_NOTIFIERS.set(database, () => notifyJournalWaiters(resolve(this.filePath)));
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
      if (database !== undefined) DATABASE_COMMIT_NOTIFIERS.delete(database);
      database?.close();
    }
  }
}

/** Publish only a fully initialized, checkpointed database; competing initializers never overwrite. */
function publishNewJournalAtomically(filePath: string, DatabaseSync: NodeDatabaseSyncConstructor, busyTimeoutMs: number): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryDirectory = mkdtempSync(resolve(dirname(filePath), '.journal-init-'));
  const temporaryDatabase = resolve(temporaryDirectory, 'journal.sqlite');
  let database: NodeDatabaseSync | undefined;
  try {
    database = new DatabaseSync(temporaryDatabase);
    initializeDatabaseWithBusyRetry(database, busyTimeoutMs);
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    database.close();
    database = undefined;
    try {
      // Hard-link creation is an atomic no-replace publication on the same volume.
      linkSync(temporaryDatabase, filePath);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
      // Another initializer won; the caller still verifies its published protocol read-only.
    }
  } finally {
    try { database?.close(); } catch { /* Preserve the initialization failure. */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { unlinkSync(temporaryDatabase + suffix); } catch { /* Only our unique temporary files. */ }
    }
    try { rmdirSync(temporaryDirectory); } catch { /* A crash residue does not become a published store. */ }
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
  ], ['runId', 'parent', 'environment', 'configuration'], 'Create Run command');
  const parent = record.parent === undefined
    ? undefined
    : snapshotDataRecord(
        record.parent,
        ['runId', 'turnId', 'invocationId'],
        [],
        'Create Run parent causality',
      );
  return Object.freeze({
    projectId: record.projectId,
    sessionId: record.sessionId,
    ...(record.runId === undefined ? {} : { runId: record.runId }),
    clientRequestId: record.clientRequestId,
    input: snapshotPortableData(record.input, 'Create Run input'),
    ...(record.configuration === undefined ? {} : {
      configuration: structuredClone(record.configuration) as CreateRunCommand['configuration'],
    }),
    ...(record.environment === undefined ? {} : {
      environment: structuredClone(record.environment) as EnvironmentBindingInput,
    }),
    ...(parent === undefined ? {} : {
      parent: Object.freeze({
        runId: parent.runId,
        turnId: parent.turnId,
        invocationId: parent.invocationId,
      }),
    }),
  }) as CreateRunCommand;
}

function requireChildParentEvent(
  database: NodeDatabaseSync,
  projectId: string,
  childRunId: string,
  parent: NonNullable<CreateRunCommand['parent']>,
): string {
  const parentRunId = requireText(parent.runId, 'parent.runId');
  const parentTurnId = requireText(parent.turnId, 'parent.turnId');
  const parentInvocationId = requireText(parent.invocationId, 'parent.invocationId');
  const row = database.prepare(
    `SELECT event_id, payload_json FROM agent_events
     WHERE project_id = ? AND run_id = ? AND turn_id = ? AND invocation_id = ?
       AND event_type = 'subagent.started'
     ORDER BY sequence DESC LIMIT 1`,
  ).get(
    projectId,
    parentRunId,
    parentTurnId,
    parentInvocationId,
  ) as { event_id: string; payload_json: string } | undefined;
  if (row === undefined) {
    throw new AgentJournalError(
      'COMMAND_CONFLICT',
      'Child Run parent causality has no committed subagent.started fact.',
    );
  }
  const payload = parsePortableJson(row.payload_json) as Record<string, PortableValue>;
  if (payload.subagentId !== childRunId) {
    throw new AgentJournalError(
      'COMMAND_CONFLICT',
      'Child Run identity disagrees with its committed parent fact.',
    );
  }
  return row.event_id;
}

function childOutcomeStatus(
  state: KernelRunProjection['state'],
): AgentSubagentObservation['status'] {
  switch (state) {
    case 'Completed': return 'completed';
    case 'Failed': return 'failed';
    case 'Cancelled': return 'cancelled';
    case 'LimitReached': return 'limit_reached';
    case 'Interrupted': return 'interrupted';
    default:
      throw new AgentJournalError('COMMAND_CONFLICT', 'Child Run is not terminal.');
  }
}

function childOutcomeEventType(
  status: AgentSubagentObservation['status'],
): 'subagent.completed' | 'subagent.failed' | 'subagent.cancelled' {
  if (status === 'completed') return 'subagent.completed';
  if (status === 'cancelled') return 'subagent.cancelled';
  return 'subagent.failed';
}

function childOutcomePayload(
  observation: AgentSubagentObservation,
): AgentEventPayloadMap[
  'subagent.completed' | 'subagent.failed' | 'subagent.cancelled'
] {
  if (observation.status === 'completed') {
    return {
      subagentId: observation.childRunId,
      summary: observation.summary,
      refs: [...observation.evidenceRefs, ...observation.artifactRefs],
    };
  }
  if (observation.status === 'cancelled') {
    return { subagentId: observation.childRunId, reason: observation.summary };
  }
  return {
    subagentId: observation.childRunId,
    code: `CHILD_${observation.status.toUpperCase()}`,
    summary: observation.summary,
  };
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

function snapshotReleaseRunLeaseCommand(input: ReleaseRunLeaseInput): ReleaseRunLeaseInput {
  const record = snapshotDataRecord(input, [
    'projectId', 'runId', 'ownerId', 'fencingToken',
  ], [], 'Release Run lease command');
  return Object.freeze({
    projectId: record.projectId,
    runId: record.runId,
    ownerId: record.ownerId,
    fencingToken: record.fencingToken,
  }) as ReleaseRunLeaseInput;
}

function snapshotGetTurnLifecycleInput(input: GetTurnLifecycleInput): GetTurnLifecycleInput {
  const record = snapshotDataRecord(input, [
    'projectId', 'sessionId', 'runId', 'turnId',
  ], [], 'Get Turn lifecycle input');
  return Object.freeze({
    projectId: record.projectId,
    sessionId: record.sessionId,
    runId: record.runId,
    turnId: record.turnId,
  }) as GetTurnLifecycleInput;
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
    } else if (key === 'resultRefs' || key === 'evidenceRefs') {
      snapshotted = snapshotDataArray(value, `Tool Invocation command ${key}`,
        (item, label) => snapshotPortableData(item, label));
    } else if (key === 'hookWarnings') {
      snapshotted = snapshotDataArray(value, 'Tool Invocation command hookWarnings',
        (item, label) => snapshotPortableData(item, label));
    } else if (
      key === 'canonicalToolId' || key === 'error' || key === 'observation' ||
      key === 'durableSummary' || key === 'modelProjection' || key === 'userProjection' ||
      key === 'auditEvidence' || key === 'completionEvidence' || key === 'hookRejection' || key === 'intent' || key === 'permissionAudit' || key === 'bundle' || key === 'questionCommand'
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

function snapshotPreparedToolArtifacts(
  capabilities: readonly PreparedToolArtifactCommit[] | undefined,
): readonly PreparedToolArtifactRecord[] {
  if (capabilities === undefined) return Object.freeze([]);
  const capabilitiesValue: unknown = capabilities;
  if (
    !Array.isArray(capabilitiesValue) ||
    capabilities.length > MAX_TOOL_RESULT_REFS
  ) {
    throw new AgentJournalError(
      'INVALID_ARGUMENT',
      `Prepared Tool Artifacts must contain at most ${MAX_TOOL_RESULT_REFS} capabilities.`,
    );
  }
  try {
    return Object.freeze(capabilities.map((capability) => inspectPreparedToolArtifact(capability)));
  } catch {
    throw new AgentJournalError(
      'INVALID_ARGUMENT', 'Prepared Tool Artifact authority is invalid.',
    );
  }
}

function validatePreparedToolArtifacts(
  command: ToolInvocationJournalCommand,
  artifacts: readonly PreparedToolArtifactRecord[],
  journalOwner: object,
): void {
  if (artifacts.length === 0) {
    if (command.action === 'finish' && command.resultRefs.length > 0) {
      throw new AgentJournalError(
        'INVALID_ARGUMENT',
        'Tool result references require prepared Artifact authority in the atomic finish commit.',
      );
    }
    return;
  }
  if (command.action !== 'finish' || command.outcome !== 'succeeded') {
    throw new AgentJournalError(
      'INVALID_ARGUMENT', 'Prepared Tool Artifacts require a successful Tool finish command.',
    );
  }
  const handles = new Set<string>();
  for (const artifact of artifacts) {
    if (artifact.journalOwner !== journalOwner) {
      throw new AgentJournalError(
        'COMMITTER_REQUIRED', 'Prepared Tool Artifact belongs to another Journal owner.',
      );
    }
    if (
      artifact.projectId !== command.projectId || artifact.sessionId !== command.sessionId ||
      artifact.runId !== command.runId || artifact.turnId !== command.turnId ||
      artifact.invocationId !== command.invocationId
    ) {
      throw new AgentJournalError(
        'RUN_IDENTITY_CONFLICT', 'Prepared Tool Artifact belongs to another Tool Invocation.',
      );
    }
    if (handles.has(artifact.payload.handle)) {
      throw new AgentJournalError(
        'INVALID_ARGUMENT', 'Prepared Tool Artifact handles must be unique.',
      );
    }
    handles.add(artifact.payload.handle);
  }
  if (
    command.resultRefs.length !== artifacts.length ||
    command.resultRefs.some((handle, index) => handle !== artifacts[index]?.payload.handle)
  ) {
    throw new AgentJournalError(
      'INVALID_ARGUMENT',
      'Tool result references must exactly match the prepared Artifacts in commit order.',
    );
  }
}

function preparedToolArtifactIdentity(record: PreparedToolArtifactRecord): PortableValue {
  return {
    projectId: record.projectId,
    sessionId: record.sessionId,
    runId: record.runId,
    turnId: record.turnId,
    invocationId: record.invocationId,
    startedAttempt: record.startedAttempt,
    idempotencyKey: record.idempotencyKey,
    fencingToken: record.fencingToken,
    payload: record.payload,
  };
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
    const validated = validateAndSnapshotEventPayload(type, payload);
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
  } catch (error) {
    throw new AgentJournalError(
      'INVALID_EVENT_PAYLOAD',
      `${label} is not safe portable data: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function validateHookFact(
  value: Readonly<{ hookId: string; hookRevision: string; summary: string }>,
): void {
  assertExactKeys(value, ['hookId', 'hookRevision', 'summary'], 'Invocation Hook fact');
  requireText(value.hookId, 'hookId');
  requireText(value.hookRevision, 'hookRevision');
  requireBoundedText(value.summary, 'hook summary', MAX_TOOL_SUMMARY_CHARS);
}

function requirePermissionAuditInput(
  value:
    | Extract<ToolInvocationJournalCommand, { action: 'validate' }>['permissionAudit']
    | ToolPermissionAuditFact,
  includeDecision = false,
): void {
  assertExactKeys(
    value,
    [
      'mode',
      ...(includeDecision ? ['decision'] : []),
      'policyRevision',
      'matchedRuleIds',
      'facts',
    ],
    'Tool permission audit',
  );
  if (!['default', 'auto', 'full-access'].includes(value.mode)) {
    throw new AgentJournalError('INVALID_ARGUMENT', 'permissionAudit.mode is invalid.');
  }
  if (
    includeDecision &&
    (!('decision' in value) || !['allow', 'ask', 'deny'].includes(value.decision))
  ) {
    throw new AgentJournalError('INVALID_ARGUMENT', 'permissionAudit.decision is invalid.');
  }
  requireText(value.policyRevision, 'permissionAudit.policyRevision');
  for (const ruleId of value.matchedRuleIds) requireText(ruleId, 'permissionAudit.matchedRuleIds[]');
  const facts = value.facts;
  assertExactKeys(facts, [
    'toolName', 'dangerLevel', 'readonly', 'recoveryClass', 'access', 'unknownRisk', 'resolvedAddresses', 'targets', 'actions', 'paths', 'hosts',
    'network', 'externalWrite', 'destructive', 'credentials', 'admin',
  ], 'Tool permission facts');
  requireText(facts.toolName, 'permissionAudit.facts.toolName');
  if (!['safe', 'medium', 'high', 'critical'].includes(facts.dangerLevel)) {
    throw new AgentJournalError('INVALID_ARGUMENT', 'permissionAudit.facts.dangerLevel is invalid.');
  }
  requireToolRecoveryClass(facts.recoveryClass);
  const actions = new Set([
    'read', 'write', 'execute', 'network', 'delete', 'database-query',
    'database-mutation', 'database-schema', 'credential', 'admin', 'unknown',
  ]);
  for (const action of facts.actions) {
    if (!actions.has(action)) {
      throw new AgentJournalError('INVALID_ARGUMENT', 'permissionAudit.facts.actions contains an invalid action.');
    }
  }
  for (const path of facts.paths) requireText(path, 'permissionAudit.facts.paths[]');
  for (const host of facts.hosts) requireText(host, 'permissionAudit.facts.hosts[]');
  for (const [name, flag] of [
    ['readonly', facts.readonly], ['network', facts.network],
    ['externalWrite', facts.externalWrite], ['destructive', facts.destructive],
    ['credentials', facts.credentials], ['admin', facts.admin],
  ] as const) {
    if (typeof flag !== 'boolean') {
      throw new AgentJournalError('INVALID_ARGUMENT', `permissionAudit.facts.${name} must be boolean.`);
    }
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
    'wait-for-user': ['intentDigest', 'bundle'],
    'settle-question': [...TOOL_INVOCATION_ACTION_KEYS['settle-question']],
    prepare: ['canonicalToolId', 'catalogRevision', 'intent', 'intentDigest', 'deadline'],
  validate: [
      'canonicalToolId', 'toolRevision', 'recoveryClass', 'intentDigest',
      'authorization', 'permissionAudit', 'actionSummary', 'approvalSummary',
    ],
    'reject-validation': ['actionSummary', 'summary', 'error', 'hookRejection'],
    'decide-approval': [
      'approvalId', 'canonicalToolId', 'toolRevision', 'recoveryClass',
      'intentDigest', 'proposedRevision', 'decision', 'decidedBy', 'reason',
    ],
    start: ['intentDigest', 'idempotencyKey', 'attempt', 'permissionAudit', 'recoveryOfFencingToken'],
    progress: ['idempotencyKey', 'attempt', 'summary'],
    finish: [
    'intentDigest',
      'outcome', 'summary', 'resultRefs', 'evidenceRefs', 'durableSummary', 'modelProjection',
      'userProjection', 'auditEvidence', 'completionEvidence', 'error',
      'interruptedFencingToken', 'hookWarnings',
    ],
    observe: ['observation'],
    'authorize-retry': [
      'permitId', 'toolRevision', 'recoveryClass', 'intentDigest', 'reason',
    ],
    'resolve-outcome': [
      'resolutionId', 'outcome', 'canonicalToolId', 'toolRevision', 'recoveryClass',
      'intentDigest', 'proposedRevision', 'summary', 'retryAuthorization',
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
  const portableCommand: unknown = command;
  validatePortable(portableCommand, 'Tool Invocation command');
  if ('canonicalToolId' in command) {
    requireCanonicalToolId(command.canonicalToolId);
  }
  if ('toolRevision' in command) requireText(command.toolRevision, 'toolRevision');
  if ('recoveryClass' in command) requireToolRecoveryClass(command.recoveryClass);
  if ('intentDigest' in command) {
    requireSha256(command.intentDigest, 'intentDigest');
  }
  if (command.action === 'wait-for-user') {
    validateToolQuestionBundle(command.bundle);
  } else if (command.action === 'prepare') {
    validatePreparedIntent(command.intent);
    assertPreparedDigest(command.intent, command.intentDigest);
    requireText(command.catalogRevision, 'catalogRevision');
    if (!Number.isFinite(Date.parse(command.deadline))) throw new AgentJournalError('INVALID_ARGUMENT', 'Prepared deadline is invalid.');
  } else if (command.action === 'validate') {
    if (!['allow', 'ask', 'deny'].includes(command.authorization)) {
      throw new AgentJournalError('INVALID_ARGUMENT', 'authorization is invalid.');
    }
    requirePermissionAuditInput(command.permissionAudit);
    requireText(command.actionSummary, 'actionSummary');
    requireText(command.approvalSummary, 'approvalSummary');
  } else if (command.action === 'start') {
    requirePermissionAuditInput(command.permissionAudit, true);
    requireText(command.idempotencyKey, 'idempotencyKey');
    requireRevision(command.attempt, 'attempt');
    if (command.recoveryOfFencingToken !== undefined) {
      requireRevision(command.recoveryOfFencingToken, 'recoveryOfFencingToken');
    }
  } else if (command.action === 'reject-validation') {
    requireText(command.actionSummary, 'actionSummary');
    requireText(command.summary, 'summary');
    requireToolExecutionErrorFact(command.error);
    if (command.hookRejection !== undefined) validateHookFact(command.hookRejection);
  } else if (command.action === 'decide-approval') {
    requireText(command.approvalId, 'approvalId');
    requireRevision(command.proposedRevision, 'proposedRevision');
    if (!['approve', 'deny'].includes(command.decision)) {
      throw new AgentJournalError('INVALID_ARGUMENT', 'Approval decision is invalid.');
    }
    if (command.decidedBy !== undefined) requireText(command.decidedBy, 'decidedBy');
    if (command.reason !== undefined) requireText(command.reason, 'reason');
  } else if (command.action === 'progress') {
    requireText(command.idempotencyKey, 'idempotencyKey');
    requireRevision(command.attempt, 'attempt');
    requireText(command.summary, 'summary');
  } else if (command.action === 'finish' || command.action === 'settle-question') {
    if (!['succeeded', 'failed', 'cancelled', 'unknown', 'timed_out', 'unsupported_revision'].includes(command.outcome)) {
      throw new AgentJournalError('INVALID_ARGUMENT', 'Tool outcome is invalid.');
    }
    requireText(command.summary, 'summary');
    if (!Array.isArray(command.resultRefs) || command.resultRefs.some(
      (reference) => typeof reference !== 'string' || reference.length === 0,
    )) {
      throw new AgentJournalError('INVALID_ARGUMENT', 'resultRefs must contain strings.');
    }
    requireEvidenceRefs(command.evidenceRefs ?? [], 'evidenceRefs');
    if (command.interruptedFencingToken !== undefined) {
      requireRevision(command.interruptedFencingToken, 'interruptedFencingToken');
      if (command.outcome !== 'unknown' && command.outcome !== 'cancelled' && command.outcome !== 'unsupported_revision') {
        throw new AgentJournalError(
          'INVALID_ARGUMENT',
          'interruptedFencingToken requires a cancelled or unknown settlement.',
        );
      }
    }
    if ((command.hookWarnings?.length ?? 0) > 64) {
      throw new AgentJournalError('INVALID_ARGUMENT', 'hookWarnings is unbounded.');
    }
    for (const warning of command.hookWarnings ?? []) validateHookFact(warning);
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
    if (command.retryAuthorization !== undefined) {
      assertExactKeys(
        command.retryAuthorization,
        ['permitId', 'reason'],
        'retryAuthorization',
      );
      requireText(command.retryAuthorization.permitId, 'retryAuthorization.permitId');
      requireText(command.retryAuthorization.reason, 'retryAuthorization.reason');
      requireBoundedText(
        command.retryAuthorization.reason,
        'retryAuthorization.reason',
        MAX_APPROVAL_REASON_CHARS,
      );
    }
  }
  return structuredClone(command);
}

function assertToolInvocationIngressBounds(command: ToolInvocationJournalCommand): void {
  if (command.action === 'validate') {
    requireBoundedText(
      command.actionSummary,
      'actionSummary',
      MAX_TOOL_SUMMARY_CHARS,
    );
    requireBoundedText(
      command.approvalSummary,
      'approvalSummary',
      MAX_APPROVAL_SUMMARY_CHARS,
    );
    return;
  }
  if (command.action === 'reject-validation' || command.action === 'resolve-outcome') {
    if (command.action === 'reject-validation') {
      requireBoundedText(command.actionSummary, 'actionSummary', MAX_TOOL_SUMMARY_CHARS);
    }
    requireBoundedText(command.summary, 'summary', MAX_TOOL_SUMMARY_CHARS);
    return;
  }
  if (command.action === 'progress') {
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
  if (command.action === 'finish' || command.action === 'settle-question') {
    requireBoundedText(command.summary, 'summary', MAX_TOOL_SUMMARY_CHARS);
    requireArtifactHandles(command.resultRefs, 'resultRefs');
    requireEvidenceRefs(command.evidenceRefs ?? [], 'evidenceRefs');
    return;
  }
  if (command.action === 'observe') {
    requireBoundedText(
      command.observation.summary,
      'observation.summary',
      MAX_TOOL_SUMMARY_CHARS,
    );
    requireEvidenceRefs(command.observation.evidenceRefs, 'observation.evidenceRefs');
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

function requireEvidenceRefs(value: unknown, name: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length > MAX_AGENT_EVIDENCE_REFS) {
    throw new AgentJournalError(
      'INVALID_ARGUMENT',
      `${name} must contain at most ${MAX_AGENT_EVIDENCE_REFS} evidence refs.`,
    );
  }
  const seen = new Set<string>();
  for (const reference of value) {
    if (!isAgentEvidenceRef(reference)) {
      throw new AgentJournalError('INVALID_ARGUMENT', `${name} contains an invalid evidence ref.`);
    }
    if (seen.has(reference)) {
      throw new AgentJournalError('INVALID_ARGUMENT', `${name} contains a duplicate evidence ref.`);
    }
    seen.add(reference);
  }
}

function mergedEvidenceRefs(
  terminal: Readonly<{ resultRefs: readonly string[]; evidenceRefs: readonly string[] }>,
): string[] {
  return [...new Set(terminal.evidenceRefs)];
}

function toolInvocationCommandIdentity(command: ToolInvocationJournalCommand): PortableValue {
  const {
    lease, expectedRunRevision, expectedInvocationRevision, commandId, ...identity
  } = command;
  void lease;
  void expectedRunRevision;
  void expectedInvocationRevision;
  void commandId;
  return identity as unknown as PortableValue;
}

function outcomeResolutionIdentity(
  command: Extract<ToolInvocationJournalCommand, { action: 'resolve-outcome' }>,
): PortableValue {
  return {
    resolutionId: command.resolutionId,
    outcome: command.outcome,
    canonicalToolId: command.canonicalToolId,
    toolRevision: command.toolRevision,
    recoveryClass: command.recoveryClass,
    intentDigest: command.intentDigest,
    proposedRevision: command.proposedRevision,
    summary: command.summary,
    ...(command.retryAuthorization === undefined
      ? {}
      : { retryAuthorization: command.retryAuthorization }),
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

function requireToolRecoveryClass(value: unknown): asserts value is ToolRecoveryClassFact {
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
    'TOOL_NOT_FOUND', 'TOOL_REVISION_MISMATCH', 'TOOL_INPUT_INVALID', 'invalid_cursor',
    'target_changed', 'conflict', 'TOOL_RESOURCE_NOT_FOUND', 'TOOL_CONFLICT', 'TOOL_PRECONDITION_FAILED',
    'TOOL_EXTERNAL_FAILED', 'TOOL_LIMIT_EXCEEDED', 'TOOL_PERMISSION_DENIED',
    'OUTCOME_RESOLVED_FAILED',
  ].includes(String(record.code))) {
    throw new AgentJournalError('INVALID_ARGUMENT', 'Tool error code is invalid.');
  }
  if (![
    'internal', 'timeout', 'cancelled', 'contract', 'unavailable', 'conflict', 'validation',
    'authorization', 'external', 'precondition', 'limit', 'resolution',
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
  const projection = parseProjectionJson(
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
  const terminal = projection.terminal as
    | (AgentInvocationProjection['terminal'] & { evidenceRefs?: string[] })
    | undefined;
  if (terminal !== undefined && !Array.isArray(terminal.evidenceRefs)) {
    terminal.evidenceRefs = [];
  }
  return projection;
}

function decidePersistedToolSchedule(
  database: NodeDatabaseSync,
  runId: string,
  turnId: string,
): ReturnType<typeof decideSchedule> {
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

    return {
      invocationId: invocation.invocationId,
      actionOrdinal: invocation.actionOrdinal,
      recoveryClass: invocation.recoveryClass ?? 'unresolved',
      access: invocation.intent?.access ?? 'external', concurrency: invocation.intent?.concurrency ?? 'exclusive', resourceKeys: invocation.intent?.resourceKeys ?? [],
      state: invocation.state,
    };
  });
  return decideSchedule({
    invocations: facts,
    maxConcurrency: Number.MAX_SAFE_INTEGER,
  });
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


function readApprovalProjection(
  database: NodeDatabaseSync,
  approvalId: string,
): ToolApprovalFact | null {
  const row = database.prepare(
    `SELECT project_id, run_id, invocation_id, tool_revision,
            intent_digest, recovery_class, status, payload_json
     FROM agent_approvals WHERE approval_id = ?`,
  ).get(approvalId) as {
    project_id: string; run_id: string; invocation_id: string; tool_revision: string;
    intent_digest: string; recovery_class: string; status: string; payload_json: string;
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
        value.intentDigest === row.intent_digest, 'Tool Approval digest',
      );
      assertProjectionIdentity(value.recoveryClass === row.recovery_class, 'Tool Approval effect');
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
    approval.toolRevision !== command.toolRevision || approval.recoveryClass !== command.recoveryClass ||
    approval.intentDigest !== command.intentDigest ||
    approval.proposedRevision !== command.proposedRevision
  ) {
    throw new AgentJournalError(
      'APPROVAL_BINDING_MISMATCH', 'Approval binding does not match the committed request.',
    );
  }
}

function approvalDecisionEvent(
  approval: ToolApprovalFact,
  status: 'approved' | 'denied',
): NonNullable<
  AgentEventPayloadMap['tool.authorized']['decision'] |
  AgentEventPayloadMap['tool.denied']['decision']
> {
  if (approval.status !== status || approval.decidedAt === undefined) {
    throw new AgentJournalError(
      'PROJECTION_CORRUPT',
      'Committed Approval decision is missing its exact status or timestamp.',
    );
  }
  return {
    status,
    decidedAt: approval.decidedAt,
    ...(approval.decidedBy === undefined ? {} : { decidedBy: approval.decidedBy }),
    ...(approval.reason === undefined ? {} : { reason: approval.reason }),
  };
}

function approvalActionSummary(
  database: NodeDatabaseSync,
  approval: ToolApprovalFact,
): string {
  const row = database.prepare(
    `SELECT * FROM agent_events
     WHERE project_id = ? AND session_id = ? AND run_id = ? AND invocation_id = ?
       AND event_type = 'tool.approval_requested'
     ORDER BY sequence DESC LIMIT 1`,
  ).get(
    approval.projectId,
    approval.sessionId,
    approval.runId,
    approval.invocationId,
  ) as EventRow | undefined;
  if (row === undefined) {
    throw new AgentJournalError(
      'PROJECTION_CORRUPT',
      'Committed Approval request is missing its user-facing action summary.',
    );
  }
  const event = eventFromRow(row);
  if (
    event.type !== 'tool.approval_requested' ||
    event.payload.approval.approvalId !== approval.approvalId
  ) {
    throw new AgentJournalError(
      'PROJECTION_CORRUPT',
      'Committed Approval request does not match its decision.',
    );
  }
  return event.payload.summary;
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
       AND json_extract(payload_json, '$.recoveryClass') = ?
       AND json_extract(payload_json, '$.intentDigest') = ?
       AND json_extract(payload_json, '$.terminal.kind') = 'unknown'
     ORDER BY updated_at DESC LIMIT 1`,
  ).get(
    current.projectId,
    current.runId,
    current.name,
    current.invocationId,
    command.toolRevision,
    command.recoveryClass,
    command.intentDigest,
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
      'IDEMPOTENCY_CONFLICT',
      'commandId was already committed with a different normalized command.',
    );
  }
  return JSON.parse(row.result_json) as T;
}

function readSessionCommandResult<T>(
  database: NodeDatabaseSync,
  projectId: string,
  commandId: string,
  requestDigest: string,
): T | undefined {
  try {
    return readCommandResult<T>(database, projectId, commandId, requestDigest);
  } catch (error) {
    if (error instanceof AgentJournalError && error.code === 'COMMAND_CONFLICT') {
      throw new AgentJournalError(
        'IDEMPOTENCY_CONFLICT',
        'Session commandId was already committed with a different command.',
      );
    }
    throw error;
  }
}

function readRuntimeCommandApplicationResult(
  database: NodeDatabaseSync,
  invocation: AgentInvocationProjection,
  command: RuntimeCommand,
  requestDigest: string,
): RuntimeCommandApplicationResult | undefined {
  const row = database.prepare(
    `SELECT command_kind, request_digest, result_json
     FROM agent_commands WHERE project_id = ? AND command_id = ?`,
  ).get(invocation.projectId, command.commandId) as RuntimeCommandRow | undefined;
  if (row === undefined) return undefined;
  if (row.request_digest !== requestDigest) {
    throw new AgentJournalError(
      'COMMAND_CONFLICT',
      'commandId was already committed with a different normalized command.',
    );
  }
  if (row.command_kind !== `runtime.${command.kind}`) {
    throw runtimeCommandReceiptCorrupt('Runtime Command receipt kind does not match its row.');
  }
  const receipt = parseRuntimeCommandReceipt(row.result_json, command);
  if (
    receipt.projectId !== invocation.projectId ||
    receipt.sessionId !== invocation.sessionId ||
    receipt.runId !== invocation.runId ||
    receipt.commandId !== command.commandId ||
    receipt.commandKind !== command.kind
  ) {
    throw runtimeCommandReceiptCorrupt(
      'Runtime Command receipt identity does not match its durable Invocation.',
    );
  }
  return rebuildRuntimeCommandApplicationResult(database, receipt, command);
}

function createRuntimeCommandReceipt(
  command: RuntimeCommand,
  invocation: AgentInvocationProjection,
  result: RuntimeCommandApplicationResult,
): RuntimeCommandReceipt {
  const first = result.events[0];
  const last = result.events.at(-1);
  if (first === undefined || last === undefined || last.type !== 'runtime.command_applied') {
    throw runtimeCommandReceiptCorrupt('Runtime Command result has no terminal applied fact.');
  }
  result.events.forEach((event, index) => {
    if (event.sequence !== first.sequence + index) {
      throw runtimeCommandReceiptCorrupt('Runtime Command result events are not contiguous.');
    }
  });
  return deepFreezeKernelValue({
    schemaVersion: 1,
    receiptType: 'runtime-command',
    projectId: invocation.projectId,
    sessionId: invocation.sessionId,
    runId: invocation.runId,
    commandId: command.commandId,
    commandKind: command.kind,
    firstSequence: first.sequence,
    lastSequence: last.sequence,
    eventCount: result.events.length,
    appliedEventId: last.eventId,
    runRevision: result.run.revision,
    projectionRevision: result.projection.revision,
  });
}

function parseRuntimeCommandReceipt(
  encoded: string,
  command: RuntimeCommand,
): RuntimeCommandReceipt {
  let value: unknown;
  try {
    value = JSON.parse(encoded) as unknown;
    assertPortableValue(value);
  } catch (error) {
    throw runtimeCommandReceiptCorrupt(
      'Runtime Command receipt JSON is invalid.',
      error,
    );
  }
  try {
    const record = runtimeReceiptRecord(value, 'receipt');
    if (Object.hasOwn(record, 'schemaVersion')) {
      if (record.schemaVersion !== 1) {
        throw new AgentJournalError(
          'UNSUPPORTED_EVENT_SCHEMA',
          `Unsupported Runtime Command receipt schema: ${String(record.schemaVersion)}.`,
        );
      }
      return validateRuntimeCommandReceiptV1(record);
    }
    return upcastLegacyRuntimeCommandResult(record, command);
  } catch (error) {
    if (error instanceof AgentJournalError) throw error;
    throw runtimeCommandReceiptCorrupt('Runtime Command receipt is structurally invalid.', error);
  }
}

function validateRuntimeCommandReceiptV1(
  record: Record<string, unknown>,
): RuntimeCommandReceipt {
  runtimeReceiptExactKeys(record, [
    'schemaVersion', 'receiptType', 'projectId', 'sessionId', 'runId', 'commandId',
    'commandKind', 'firstSequence', 'lastSequence', 'eventCount', 'appliedEventId',
    'runRevision', 'projectionRevision',
  ], 'receipt');
  if (record.schemaVersion !== 1 || record.receiptType !== 'runtime-command') {
    throw new TypeError('Unsupported Runtime Command receipt version or type.');
  }
  for (const key of [
    'projectId', 'sessionId', 'runId', 'commandId', 'appliedEventId',
  ] as const) runtimeReceiptText(record[key], key);
  if (!isRuntimeCommandKind(record.commandKind)) {
    throw new TypeError('Runtime Command receipt commandKind is invalid.');
  }
  for (const key of [
    'firstSequence', 'lastSequence', 'eventCount', 'runRevision', 'projectionRevision',
  ] as const) runtimeReceiptPositiveInteger(record[key], key);
  if (
    Number(record.lastSequence) < Number(record.firstSequence) ||
    Number(record.eventCount) !==
      Number(record.lastSequence) - Number(record.firstSequence) + 1
  ) {
    throw new TypeError('Runtime Command receipt event interval is invalid.');
  }
  return deepFreezeKernelValue(structuredClone(record) as RuntimeCommandReceipt);
}

/** Strictly upgrades pre-receipt rows without ever returning their embedded projections. */
function upcastLegacyRuntimeCommandResult(
  record: Record<string, unknown>,
  command: RuntimeCommand,
): RuntimeCommandReceipt {
  runtimeReceiptExactKeys(record, ['events', 'run', 'projection'], 'legacy result');
  if (!Array.isArray(record.events) || record.events.length < 1) {
    throw new TypeError('Legacy Runtime Command result events are invalid.');
  }
  const events = record.events.map((value, index) => {
    const event = runtimeReceiptRecord(value, `legacy events[${index}]`);
    runtimeReceiptExactKeys(event, [
      'eventId', 'projectId', 'sequence', 'schemaVersion', 'sessionId', 'runId',
      'turnId', 'parentEventId', 'invocationId', 'attemptId', 'type', 'occurredAt', 'payload',
    ], `legacy events[${index}]`, [
      'turnId', 'parentEventId', 'invocationId', 'attemptId',
    ]);
    for (const key of ['eventId', 'projectId', 'sessionId', 'runId', 'type', 'occurredAt'] as const) {
      runtimeReceiptText(event[key], `legacy events[${index}].${key}`);
    }
    runtimeReceiptPositiveInteger(event.sequence, `legacy events[${index}].sequence`);
    runtimeReceiptPositiveInteger(event.schemaVersion, `legacy events[${index}].schemaVersion`);
    return event;
  });
  const first = events[0]!;
  const last = events.at(-1)!;
  events.forEach((event, index) => {
    if (Number(event.sequence) !== Number(first.sequence) + index) {
      throw new TypeError('Legacy Runtime Command result events are not contiguous.');
    }
  });
  if (last.type !== 'runtime.command_applied') {
    throw new TypeError('Legacy Runtime Command result has no terminal applied fact.');
  }
  const payload = runtimeReceiptRecord(last.payload, 'legacy applied payload');
  if (payload.commandId !== command.commandId || payload.kind !== command.kind) {
    throw new TypeError('Legacy Runtime Command result command identity is invalid.');
  }
  const run = runtimeReceiptRecord(record.run, 'legacy run');
  const projection = runtimeReceiptRecord(record.projection, 'legacy projection');
  runtimeReceiptPositiveInteger(run.revision, 'legacy run.revision');
  runtimeReceiptPositiveInteger(projection.revision, 'legacy projection.revision');
  for (const key of ['projectId', 'sessionId', 'runId'] as const) {
    runtimeReceiptText(projection[key], `legacy projection.${key}`);
  }
  return validateRuntimeCommandReceiptV1({
    schemaVersion: 1,
    receiptType: 'runtime-command',
    projectId: projection.projectId,
    sessionId: projection.sessionId,
    runId: projection.runId,
    commandId: command.commandId,
    commandKind: command.kind,
    firstSequence: first.sequence,
    lastSequence: last.sequence,
    eventCount: events.length,
    appliedEventId: last.eventId,
    runRevision: run.revision,
    projectionRevision: projection.revision,
  });
}

function rebuildRuntimeCommandApplicationResult(
  database: NodeDatabaseSync,
  receipt: RuntimeCommandReceipt,
  command: RuntimeCommand,
): RuntimeCommandApplicationResult {
  const rows = database.prepare(
    `SELECT * FROM agent_events
     WHERE project_id = ? AND sequence BETWEEN ? AND ?
     ORDER BY sequence ASC`,
  ).all(
    receipt.projectId,
    receipt.firstSequence,
    receipt.lastSequence,
  ) as unknown as EventRow[];
  if (rows.length !== receipt.eventCount) {
    throw runtimeCommandReceiptCorrupt('Runtime Command receipt event interval is incomplete.');
  }
  const events = rows.map((row) => {
    assertStoredParentCausality(database, row);
    return eventFromRow(row);
  });
  const applied = events.at(-1);
  if (
    applied === undefined || applied.type !== 'runtime.command_applied' ||
    applied.eventId !== receipt.appliedEventId ||
    applied.projectId !== receipt.projectId ||
    applied.sessionId !== receipt.sessionId ||
    applied.runId !== receipt.runId ||
    applied.payload.commandId !== command.commandId ||
    applied.payload.kind !== command.kind ||
    applied.payload.origin.runId !== command.origin.runId ||
    applied.payload.origin.turnId !== command.origin.turnId ||
    applied.payload.origin.invocationId !== command.origin.invocationId ||
    applied.payload.projectionRevision !== receipt.projectionRevision
  ) {
    throw runtimeCommandReceiptCorrupt('Runtime Command receipt terminal fact does not match.');
  }
  const expectedFacts = runtimeCommandDomainFacts(command, applied.payload.effect);
  if (
    receipt.eventCount !== expectedFacts.length + 1 ||
    receipt.firstSequence !== receipt.lastSequence - expectedFacts.length
  ) {
    throw runtimeCommandReceiptCorrupt(
      'Runtime Command receipt interval does not match its authenticated domain facts.',
    );
  }
  if (events.some((event) =>
    event.projectId !== receipt.projectId || event.sessionId !== receipt.sessionId ||
    event.runId !== receipt.runId || event.turnId !== command.origin.turnId ||
    event.invocationId !== command.origin.invocationId ||
    event.attemptId !== applied.attemptId)) {
    throw runtimeCommandReceiptCorrupt('Runtime Command receipt crosses a durable event scope.');
  }
  for (const [index, expected] of expectedFacts.entries()) {
    const actual = events[index];
    if (
      actual === undefined || actual.type !== expected.type ||
      canonicalJson(actual.payload) !== canonicalJson(expected.payload) ||
      actual.parentEventId !== (index === 0 ? undefined : events[index - 1]?.eventId)
    ) {
      throw runtimeCommandReceiptCorrupt(
        'Runtime Command receipt domain facts do not match the authenticated command.',
      );
    }
  }
  const expectedAppliedParent = expectedFacts.length === 0
    ? undefined
    : events[expectedFacts.length - 1]?.eventId;
  if (applied.parentEventId !== expectedAppliedParent) {
    throw runtimeCommandReceiptCorrupt('Runtime Command receipt causal parent chain is invalid.');
  }

  const historyRows = database.prepare(
    `SELECT * FROM agent_events
     WHERE project_id = ? AND run_id = ? AND sequence <= ?
     ORDER BY sequence ASC`,
  ).all(
    receipt.projectId,
    receipt.runId,
    receipt.lastSequence,
  ) as unknown as EventRow[];
  const history = historyRows.map((row) => {
    assertStoredParentCausality(database, row);
    return eventFromRow(row);
  });
  const projection = replayRuntimeCommandFacts(history).get(receipt.runId)?.projection;
  const run = replayKernelJournalFacts(history, []).runs.get(receipt.runId);
  if (
    projection === undefined || projection.revision !== receipt.projectionRevision ||
    run === undefined || run.revision !== receipt.runRevision
  ) {
    throw runtimeCommandReceiptCorrupt(
      'Runtime Command receipt revisions cannot be rebuilt from immutable facts.',
    );
  }
  return freezeRuntimeCommandApplicationResult({ events, run, projection });
}

function runtimeReceiptRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Runtime Command ${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function runtimeReceiptExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  optional: readonly string[] = [],
): void {
  const required = allowed.filter((key) => !optional.includes(key));
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new TypeError(`Runtime Command ${label} keys are invalid.`);
  }
}

function runtimeReceiptText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4_096) {
    throw new TypeError(`Runtime Command ${label} must be bounded text.`);
  }
}

function runtimeReceiptPositiveInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`Runtime Command ${label} must be a positive integer.`);
  }
}

function isRuntimeCommandKind(value: unknown): value is RuntimeCommand['kind'] {
  return value === 'plan.create' || value === 'plan.update' ||
    value === 'discovery.activate' || value === 'skill.activate' ||
    value === 'child.start' || value === 'child.list' || value === 'child.wait' ||
    value === 'child.steer' || value === 'child.cancel';
}

function runtimeCommandReceiptCorrupt(message: string, cause?: unknown): AgentJournalError {
  return new AgentJournalError(
    'PROJECTION_CORRUPT',
    message,
    cause === undefined
      ? undefined
      : { cause: errorMessage(cause) },
  );
}

function snapshotModelLifecycleCommand(
  input: DurableModelLifecycleJournalCommand,
): DurableModelLifecycleJournalCommand {
  let command: DurableModelLifecycleJournalCommand;
  try {
    command = structuredClone(input);
    assertPortableValue(command);
  } catch (error) {
    throw new AgentJournalError(
      'INVALID_ARGUMENT',
      'Model lifecycle command must be portable.',
      { cause: errorMessage(error) },
    );
  }
  assertExactObjectKeys(command, [
    'schemaVersion', 'projectId', 'sessionId', 'runId', 'turnId', 'attemptId',
    'commandId', 'lease', 'expectedRunRevision', 'fact',
  ], ['checkpointId', 'decisionId']);
  if (command.schemaVersion !== 1) {
    throw new AgentJournalError(
      'UNSUPPORTED_EVENT_SCHEMA',
      `Unsupported Model lifecycle command schema: ${String(command.schemaVersion)}.`,
    );
  }
  [
    command.projectId,
    command.sessionId,
    command.runId,
    command.turnId,
    command.attemptId,
    command.commandId,
  ].forEach((value, index) => requireText(value, `Model lifecycle identity[${index}]`));
  if (!Number.isSafeInteger(command.expectedRunRevision) || command.expectedRunRevision < 1) {
    throw new AgentJournalError('INVALID_ARGUMENT', 'Model lifecycle Run revision is invalid.');
  }
  assertExactObjectKeys(command.lease, ['ownerId', 'fencingToken']);
  requireText(command.lease.ownerId, 'Model lifecycle lease ownerId');
  if (!Number.isSafeInteger(command.lease.fencingToken) || command.lease.fencingToken < 1) {
    throw new AgentJournalError('INVALID_ARGUMENT', 'Model lifecycle fence is invalid.');
  }
  if (command.fact.attemptId !== command.attemptId) {
    throw new AgentJournalError(
      'INVALID_ARGUMENT',
      'Model lifecycle fact Attempt identity does not match its command.',
    );
  }
  const fact = command.fact as unknown as DurableModelLifecycleJournalFact;
  const hasContextIdentity = 'checkpointId' in command || 'decisionId' in command;
  switch (fact.type) {
    case 'model-delta-batch': {
      assertExactObjectKeys(fact, [
        'type', 'attemptId', 'routeId', 'batchOrdinal', 'idempotencyKey', 'events',
      ]);
      if (!Number.isSafeInteger(fact.batchOrdinal) || fact.batchOrdinal < 0) {
        throw new AgentJournalError('INVALID_ARGUMENT', 'Model delta batch ordinal is invalid.');
      }
      requireText(fact.idempotencyKey, 'Model delta batch idempotencyKey');
      requireText(fact.routeId, 'Model lifecycle routeId');
      if (fact.events.length < 1 || fact.events.length > 1_000) {
        throw new AgentJournalError('INVALID_ARGUMENT', 'Model delta batch size is invalid.');
      }
      const batchRouteId = fact.routeId;
      if (fact.events.some((event) =>
        event.type !== 'decoded-delta' || event.attemptId !== command.attemptId ||
        event.routeId !== batchRouteId)) {
        throw new AgentJournalError(
          'INVALID_ARGUMENT',
          'Model delta batch contains a foreign lifecycle event.',
        );
      }
      requireText(batchRouteId, 'Model lifecycle routeId');
      break;
    }
    case 'block-completed':
      assertExactObjectKeys(fact, [
        'type', 'attemptId', 'routeId', 'blockOrdinal', 'block', 'occurredAt',
      ]);
      if (!Number.isSafeInteger(fact.blockOrdinal) || fact.blockOrdinal < 0) {
        throw new AgentJournalError('INVALID_ARGUMENT', 'Model block ordinal is invalid.');
      }
      requireText(fact.routeId, 'Model lifecycle routeId');
      break;
    case 'usage-observed':
      assertExactObjectKeys(fact, [
        'type', 'attemptId', 'routeId', 'purpose', 'billingMode', 'usage', 'occurredAt',
      ]);
      if (fact.purpose === 'context-compaction') {
        if (!('checkpointId' in command) || !('decisionId' in command)) {
          throw new AgentJournalError(
            'INVALID_ARGUMENT',
            'Context usage requires the exact checkpoint and decision identities.',
          );
        }
        requireText(command.checkpointId, 'Context usage checkpointId');
        requireText(command.decisionId, 'Context usage decisionId');
      } else if (fact.purpose !== 'agent-turn') {
        throw new AgentJournalError(
          'INVALID_ARGUMENT',
          'Model lifecycle usage purpose is invalid.',
        );
      } else if (hasContextIdentity) {
        throw new AgentJournalError(
          'INVALID_ARGUMENT',
          'Agent Turn usage cannot carry Context checkpoint identities.',
        );
      }
      requireText(fact.routeId, 'Model lifecycle routeId');
      requireUsageBillingMode(fact.billingMode, 'Model lifecycle billingMode');
      validateModelTokenUsage(fact.usage);
      break;
  }
  if (fact.type !== 'usage-observed' && hasContextIdentity) {
    throw new AgentJournalError(
      'INVALID_ARGUMENT',
      'Only Context compaction usage can carry checkpoint identities.',
    );
  }
  const occurredAt = modelLifecycleOccurredAt(fact);
  if (!Number.isFinite(occurredAt) || occurredAt < 0) {
    throw new AgentJournalError('INVALID_ARGUMENT', 'Model lifecycle timestamp is invalid.');
  }
  return deepFreezeKernelValue(command);
}

function modelLifecycleOccurredAt(fact: DurableModelLifecycleJournalCommand['fact']): number {
  return fact.type === 'model-delta-batch'
    ? Math.max(...fact.events.map(({ occurredAt }) => occurredAt))
    : fact.occurredAt;
}

function modelDeltaBatchPayload(
  fact: Extract<ModelLifecycleJournalCommand['fact'], { type: 'model-delta-batch' }>,
): AgentEventPayloadMap['model_delta_batch'] {
  return {
    blocks: fact.events.map(({ event }) => {
      switch (event.type) {
        case 'text-delta':
          return { type: 'text', text: event.text };
        case 'reasoning-summary-delta':
          return { type: 'reasoning-summary', text: event.text };
        case 'provider-opaque-delta':
          return {
            type: 'provider-opaque-delta',
            opaqueRef: event.opaqueRef,
            protocol: event.protocol,
            fragment: structuredClone(event.fragment),
          };
        case 'tool-call-delta':
          return {
            type: 'tool-call-delta',
            blockOrdinal: event.blockOrdinal,
            draftCallKey: event.draftCallKey,
            ...(event.wireIdentity === undefined
              ? {}
              : { wireIdentity: structuredClone(event.wireIdentity) }),
            ...(event.name === undefined ? {} : { name: event.name }),
            ...(event.argumentsDelta === undefined
              ? {}
              : { argumentsDelta: event.argumentsDelta }),
          };
      }
    }),
  };
}

function modelUsagePayload(
  command: DurableModelLifecycleJournalCommand,
): AgentEventPayloadMap['usage.recorded'] {
  if (command.fact.type !== 'usage-observed') {
    throw new AgentJournalError('INVALID_ARGUMENT', 'Expected a Model usage lifecycle fact.');
  }
  const purpose = command.fact.purpose;
  if (purpose !== 'agent-turn' && purpose !== 'context-compaction') {
    throw new AgentJournalError('INVALID_ARGUMENT', 'Model lifecycle usage purpose is invalid.');
  }
  return {
    scope: 'attempt',
    usageId: usageIdentity(command.runId, command.attemptId, purpose),
    purpose,
    turnId: command.turnId,
    attemptId: command.attemptId,
    inputTokens: command.fact.usage.inputTokens,
    outputTokens: command.fact.usage.outputTokens,
    totalTokens: command.fact.usage.totalTokens,
    billingMode: command.fact.billingMode,
  };
}

function usageAlreadyPersisted(
  database: NodeDatabaseSync,
  payload: AgentEventPayloadMap['usage.recorded'],
): boolean {
  const existing = database.prepare(
    'SELECT payload_json FROM agent_usage WHERE usage_id = ?',
  ).get(payload.usageId) as { payload_json: string } | undefined;
  if (existing === undefined) return false;
  let prior: PortableValue;
  try {
    prior = parsePortableJson(existing.payload_json);
  } catch (error) {
    throw new AgentJournalError(
      'PROJECTION_CORRUPT',
      'Stored Model usage payload is invalid.',
      { cause: errorMessage(error) },
    );
  }
  if (canonicalJson(normalizeUsagePayload(prior)) !== canonicalJson(payload)) {
    throw new AgentJournalError(
      'IDEMPOTENCY_CONFLICT',
      'Model Attempt usage identity was already recorded with different values.',
    );
  }
  return true;
}

function resolveContextCompactionRunRevision(
  database: NodeDatabaseSync,
  command: Extract<
    DurableModelLifecycleJournalCommand,
    { fact: { type: 'usage-observed'; purpose: 'context-compaction' } }
  >,
): number {
  const current = readKernelRunProjection(database, command.runId);
  const checkpoint = readContextCheckpointProjection(database, command.checkpointId);
  if (
    current.projectId !== command.projectId || current.sessionId !== command.sessionId ||
    current.state !== 'Compacting' || current.currentTurnId !== command.turnId ||
    current.revision !== command.expectedRunRevision || checkpoint === null ||
    checkpoint.projectId !== command.projectId || checkpoint.sessionId !== command.sessionId ||
    checkpoint.runId !== command.runId || checkpoint.status !== 'started' ||
    checkpoint.decisionId !== command.decisionId
  ) {
    throw new AgentJournalError(
      'MODEL_COMMIT_CONFLICT',
      'Context usage does not belong to the exact active compaction checkpoint.',
    );
  }
  return current.revision;
}

function modelLifecycleReceipt(
  command: DurableModelLifecycleJournalCommand,
  result: ModelLifecycleJournalResult,
): ModelLifecycleReceipt {
  return deepFreezeKernelValue({
    schemaVersion: 1,
    receiptType: 'model-lifecycle',
    projectId: command.projectId,
    sessionId: command.sessionId,
    runId: command.runId,
    turnId: command.turnId,
    attemptId: command.attemptId,
    commandId: command.commandId,
    factType: command.fact.type,
    eventIds: result.events.map(({ eventId }) => eventId),
    eventSequences: result.events.map(({ sequence }) => sequence),
    runRevision: result.runRevision,
  });
}

function readModelLifecycleResult(
  database: NodeDatabaseSync,
  command: DurableModelLifecycleJournalCommand,
  requestDigest: string,
): ModelLifecycleJournalResult | undefined {
  const row = database.prepare(
    `SELECT command_kind, request_digest, result_json
     FROM agent_commands WHERE project_id = ? AND command_id = ?`,
  ).get(command.projectId, command.commandId) as RuntimeCommandRow | undefined;
  if (row === undefined) return undefined;
  if (row.request_digest !== requestDigest) {
    throw new AgentJournalError(
      'IDEMPOTENCY_CONFLICT',
      'Model lifecycle commandId was reused with different input.',
    );
  }
  if (row.command_kind !== `model-lifecycle.${command.fact.type}`) {
    throw new AgentJournalError(
      'PROJECTION_CORRUPT',
      'Model lifecycle receipt kind disagrees with its command row.',
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(row.result_json) as unknown;
  } catch (error) {
    throw new AgentJournalError(
      'PROJECTION_CORRUPT',
      'Model lifecycle receipt JSON is invalid.',
      { cause: errorMessage(error) },
    );
  }
  const receipt = runtimeReceiptRecord(value, 'Model lifecycle receipt');
  runtimeReceiptExactKeys(receipt, [
    'schemaVersion', 'receiptType', 'projectId', 'sessionId', 'runId', 'turnId',
    'attemptId', 'commandId', 'factType', 'eventIds', 'eventSequences', 'runRevision',
  ], 'Model lifecycle receipt');
  if (receipt.schemaVersion !== 1) {
    throw new AgentJournalError(
      'UNSUPPORTED_EVENT_SCHEMA',
      `Unsupported Model lifecycle receipt schema: ${String(receipt.schemaVersion)}.`,
    );
  }
  if (
    receipt.receiptType !== 'model-lifecycle' || receipt.projectId !== command.projectId ||
    receipt.sessionId !== command.sessionId || receipt.runId !== command.runId ||
    receipt.turnId !== command.turnId || receipt.attemptId !== command.attemptId ||
    receipt.commandId !== command.commandId || receipt.factType !== command.fact.type
  ) {
    throw new AgentJournalError('PROJECTION_CORRUPT', 'Model lifecycle receipt identity is invalid.');
  }
  runtimeReceiptPositiveInteger(receipt.runRevision, 'Model lifecycle runRevision');
  if (
    !Array.isArray(receipt.eventIds) || receipt.eventIds.length > 1 ||
    !receipt.eventIds.every((eventId) => typeof eventId === 'string' && eventId.length > 0)
  ) {
    throw new AgentJournalError('PROJECTION_CORRUPT', 'Model lifecycle receipt events are invalid.');
  }
  const eventSequences = receipt.eventSequences;
  if (
    !Array.isArray(eventSequences) ||
    eventSequences.length !== receipt.eventIds.length ||
    !eventSequences.every((sequence) =>
      Number.isSafeInteger(sequence) && Number(sequence) > 0)
  ) {
    throw new AgentJournalError(
      'PROJECTION_CORRUPT',
      'Model lifecycle receipt event sequences are invalid.',
    );
  }
  const eventIds = receipt.eventIds as string[];
  const events = eventIds.map((eventId, index) => {
    const stored = database.prepare(
      'SELECT * FROM agent_events WHERE project_id = ? AND event_id = ?',
    ).get(command.projectId, eventId) as EventRow | undefined;
    if (stored === undefined) {
      throw new AgentJournalError('PROJECTION_CORRUPT', 'Model lifecycle receipt event is missing.');
    }
    assertStoredParentCausality(database, stored);
    const event = eventFromRow(stored);
    if (event.sequence !== eventSequences[index]) {
      throw new AgentJournalError(
        'PROJECTION_CORRUPT',
        'Model lifecycle receipt event sequence does not match its identity.',
      );
    }
    return event;
  });
  assertModelLifecycleReplay(events, database, command);
  return deepFreezeKernelValue({
    events: Object.freeze(events),
    runRevision: Number(receipt.runRevision),
  });
}

function assertModelLifecycleReplay(
  events: readonly AgentEvent[],
  database: NodeDatabaseSync,
  command: DurableModelLifecycleJournalCommand,
): void {
  if (command.fact.type === 'usage-observed' && events.length === 0) {
    if (!usageAlreadyPersisted(database, modelUsagePayload(command))) {
      throw new AgentJournalError('PROJECTION_CORRUPT', 'Model usage receipt lost its durable fact.');
    }
    return;
  }
  if (events.length !== 1) {
    throw new AgentJournalError('PROJECTION_CORRUPT', 'Model lifecycle receipt event count is invalid.');
  }
  const event = events[0]!;
  const expected = command.fact.type === 'model-delta-batch'
    ? { type: 'model_delta_batch' as const, payload: modelDeltaBatchPayload(command.fact) }
    : command.fact.type === 'block-completed'
      ? {
          type: 'model_block_completed' as const,
          payload: {
            block: structuredClone(command.fact.block),
            ...(command.fact.block.type === 'tool-call-draft'
              ? { draftCallKey: command.fact.block.draftCallKey }
              : {}),
          },
        }
      : { type: 'usage.recorded' as const, payload: modelUsagePayload(command) };
  if (
    event.projectId !== command.projectId || event.sessionId !== command.sessionId ||
    event.runId !== command.runId || event.turnId !== command.turnId ||
    event.attemptId !== command.attemptId || event.type !== expected.type ||
    canonicalJson(event.payload) !== canonicalJson(expected.payload)
  ) {
    throw new AgentJournalError(
      'PROJECTION_CORRUPT',
      'Model lifecycle receipt does not match its authenticated fact.',
    );
  }
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
    'parent', 'createdAt', 'updatedAt',
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
  if (record.parent !== undefined) {
    const parent = projectionRecord(record.parent, 'Agent Run parent');
    projectionExactKeys(parent, ['runId', 'turnId', 'invocationId'], 'Agent Run parent');
    ['runId', 'turnId', 'invocationId'].forEach((key) =>
      projectionText(parent[key], `Agent Run parent ${key}`));
  }
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
    'toolRevision', 'catalogRevision', 'intent', 'deadline', 'recoveryClass', 'intentDigest', 'proposedRevision',
    'approvalId', 'retryOf', 'retryPermitId', 'retryPermit', 'outcomeResolution',
    'started', 'terminal', 'question',
    'observation', 'createdAt', 'updatedAt',
  ], 'Agent Invocation');
  ['projectId', 'sessionId', 'runId', 'turnId', 'attemptId', 'invocationId', 'callId', 'name']
    .forEach((key) => projectionText(record[key], `Agent Invocation ${key}`));
  projectionNonNegativeInteger(record.actionOrdinal, 'Agent Invocation actionOrdinal');
  if (record.question !== undefined) validateToolQuestionBundle(record.question);
  assertPortableValue(record.arguments);
  if (![
    'proposed', 'prepared', 'waiting_for_user', 'timed_out', 'unsupported_revision', 'awaiting_approval', 'authorized', 'denied', 'started',
    'succeeded', 'failed', 'cancelled', 'unknown', 'observed',
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
    'canonicalToolId', 'toolRevision', 'recoveryClass', 'intentDigest',
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
    'modelProjection', 'auditEvidence', 'completionEvidence', 'errorCode',
    'projectId', 'runId', 'createdAt',
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
    DATABASE_COMMIT_NOTIFIERS.get(database)?.();
    return value;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function getJournalWaitBus(key: string): JournalWaitBus {
  const existing = JOURNAL_WAIT_BUSES.get(key);
  if (existing !== undefined) return existing;
  const created: JournalWaitBus = { listeners: new Set() };
  JOURNAL_WAIT_BUSES.set(key, created);
  return created;
}

function releaseJournalWaitBus(key: string, bus: JournalWaitBus): void {
  if (bus.listeners.size === 0 && JOURNAL_WAIT_BUSES.get(key) === bus) {
    JOURNAL_WAIT_BUSES.delete(key);
  }
}

function notifyJournalWaiters(key: string): void {
  const bus = JOURNAL_WAIT_BUSES.get(key);
  if (bus === undefined) return;
  for (const listener of [...bus.listeners]) queueMicrotask(listener);
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof AbortSignal !== 'undefined' && value instanceof AbortSignal;
}

function abortError(): Error {
  const error = new Error('The Run event wait was aborted.');
  error.name = 'AbortError';
  return error;
}

export const RUNTIME_PROTOCOL_VERSION = 'base-tools-runtime.v2';

function initializeDatabase(database: NodeDatabaseSync, busyTimeoutMs: number): void {
  database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  database.exec("CREATE TABLE IF NOT EXISTS agent_runtime_protocol (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), version TEXT NOT NULL)");
  database.prepare('INSERT OR IGNORE INTO agent_runtime_protocol(singleton, version) VALUES (1, ?)').run(RUNTIME_PROTOCOL_VERSION);
  const sessionIndexExisted = database.prepare(
    `SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'agent_sessions'`,
  ).get() !== undefined;
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
    CREATE INDEX IF NOT EXISTS idx_agent_events_session_sequence
      ON agent_events(project_id, session_id, sequence);
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
    CREATE TABLE IF NOT EXISTS agent_pending_steering (
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      client_request_id TEXT NOT NULL,
      queue_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      input_json TEXT NOT NULL,
      queued_at TEXT NOT NULL,
      consumed_at TEXT,
      UNIQUE (project_id, run_id, client_request_id),
      FOREIGN KEY (project_id, run_id) REFERENCES agent_runs(project_id, run_id)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_pending_steering_run
      ON agent_pending_steering(project_id, session_id, run_id, consumed_at, queue_sequence);
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
    CREATE TABLE IF NOT EXISTS agent_sessions (
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      session_kind TEXT NOT NULL DEFAULT 'root' CHECK (session_kind IN ('root', 'delegated')),
      visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'internal')),
      parent_run_id TEXT,
      parent_session_id TEXT,
      archive_revision INTEGER NOT NULL DEFAULT 0 CHECK (archive_revision >= 0),
      archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
      title TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_activity_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_activity_sequence >= 0),
      run_count INTEGER NOT NULL DEFAULT 0 CHECK (run_count >= 0),
      PRIMARY KEY (project_id, session_id)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_project_archive_activity
      ON agent_sessions(
        project_id, archived, updated_at DESC, last_activity_sequence DESC, session_id ASC
      );
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_project_activity
      ON agent_sessions(project_id, updated_at DESC, last_activity_sequence DESC, session_id ASC);
    CREATE TABLE IF NOT EXISTS agent_session_skill_configurations (
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, session_id),
      FOREIGN KEY (project_id, session_id) REFERENCES agent_sessions(project_id, session_id)
    );
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
    CREATE TABLE IF NOT EXISTS agent_run_ancestry (
      project_id TEXT NOT NULL,
      run_id TEXT NOT NULL PRIMARY KEY,
      parent_run_id TEXT,
      root_run_id TEXT NOT NULL,
      depth INTEGER NOT NULL CHECK (depth >= 0),
      root_child_ordinal INTEGER NOT NULL DEFAULT 0 CHECK (root_child_ordinal >= 0),
      UNIQUE (project_id, run_id)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_run_ancestry_root
      ON agent_run_ancestry(project_id, root_run_id, depth);
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
    CREATE TABLE IF NOT EXISTS agent_runtime_command_projections (
      run_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (project_id, session_id, run_id),
      FOREIGN KEY (project_id, session_id, run_id)
        REFERENCES agent_runs(project_id, session_id, run_id)
    );
    CREATE TABLE IF NOT EXISTS agent_tool_run_windows (
      run_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      base_revision INTEGER NOT NULL CHECK (base_revision > 0),
      current_revision INTEGER NOT NULL CHECK (current_revision >= base_revision),
      FOREIGN KEY (project_id, session_id, run_id)
        REFERENCES agent_runs(project_id, session_id, run_id)
    );
    CREATE TABLE IF NOT EXISTS agent_model_run_windows (
      run_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL UNIQUE,
      base_revision INTEGER NOT NULL CHECK (base_revision > 0),
      current_revision INTEGER NOT NULL CHECK (current_revision >= base_revision),
      FOREIGN KEY (project_id, session_id, run_id)
        REFERENCES agent_runs(project_id, session_id, run_id)
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
        json_extract(payload_json, '$.recoveryClass'),
        json_extract(payload_json, '$.intentDigest'),
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
      intent_digest TEXT NOT NULL,
      recovery_class TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (invocation_id, tool_revision, intent_digest, recovery_class),
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
    CREATE TABLE IF NOT EXISTS agent_context_compaction_requests (
      run_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      decision_id TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      FOREIGN KEY (project_id, session_id, run_id)
        REFERENCES agent_runs(project_id, session_id, run_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_context_request_decision
      ON agent_context_compaction_requests(project_id, decision_id);
    CREATE TABLE IF NOT EXISTS agent_usage (
      usage_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      turn_id TEXT,
      attempt_id TEXT,
      invocation_id TEXT,
      purpose TEXT NOT NULL,
      billing_mode TEXT NOT NULL DEFAULT 'byok' CHECK (billing_mode IN ('byok', 'managed')),
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (run_id, attempt_id, purpose)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_usage_run
      ON agent_usage(project_id, session_id, run_id, created_at, usage_id);
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
    CREATE TABLE IF NOT EXISTS agent_run_lease_fences (
      project_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      last_fencing_token INTEGER NOT NULL CHECK (last_fencing_token > 0),
      PRIMARY KEY (project_id, run_id)
    );
  `);
  migrateHiddenRuns(database);
  migrateArtifactReferenceUniqueness(database);
  migrateLegacyRunLeaseForeignKey(database);
  backfillRunLeaseFences(database);
  migrateKernelJournalTables(database);
  migrateUsageBillingMode(database);
  backfillRunAncestry(database);
  if (!sessionIndexExisted) backfillSessionIndexes(database);
  migrateSessionVisibility(database);
}

function readSessionIndexRow(
  database: NodeDatabaseSync,
  projectId: string,
  sessionId: string,
): SessionIndexRow | undefined {
  return database.prepare(
    `SELECT project_id, session_id, session_kind, visibility, parent_run_id, parent_session_id,
            archive_revision, archived, title,
            created_at, updated_at, last_activity_sequence, run_count
     FROM agent_sessions WHERE project_id = ? AND session_id = ?`,
  ).get(projectId, sessionId) as SessionIndexRow | undefined;
}

function sessionIndexFromRow(row: SessionIndexRow): SessionIndexProjection {
  if (row.archived !== 0 && row.archived !== 1) {
    throw new AgentJournalError('PROJECTION_CORRUPT', 'Session archive projection is invalid.');
  }
  if ((row.session_kind !== 'root' && row.session_kind !== 'delegated') ||
      (row.visibility !== 'public' && row.visibility !== 'internal')) {
    throw new AgentJournalError('PROJECTION_CORRUPT', 'Session identity projection is invalid.');
  }
  if (row.session_kind === 'root' &&
      (row.visibility !== 'public' || row.parent_run_id !== null || row.parent_session_id !== null)) {
    throw new AgentJournalError('PROJECTION_CORRUPT', 'Root Session identity is invalid.');
  }
  if (row.session_kind === 'delegated' &&
      (row.visibility !== 'internal' || row.parent_run_id === null || row.parent_session_id === null)) {
    throw new AgentJournalError('PROJECTION_CORRUPT', 'Delegated Session identity is invalid.');
  }
  return deepFreezeKernelValue({
    projectId: row.project_id,
    sessionId: row.session_id,
    kind: row.session_kind,
    visibility: row.visibility,
    ...(row.parent_run_id === null ? {} : { parentRunId: row.parent_run_id }),
    ...(row.parent_session_id === null ? {} : { parentSessionId: row.parent_session_id }),
    archiveRevision: row.archive_revision,
    archived: row.archived === 1,
    ...(row.title === null ? {} : { title: row.title }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivitySequence: row.last_activity_sequence,
    runCount: row.run_count,
  });
}

/**
 * Delegated Sessions are durable child-runtime contexts, not user-configurable
 * top-level Sessions. Their identity is established atomically with child
 * ingress and must remain immutable for the life of the projection.
 */
function assertPublicRootSession(row: SessionIndexRow, operation: string): void {
  if (row.session_kind !== 'root' || row.visibility !== 'public') {
    throw new AgentJournalError(
      'COMMAND_CONFLICT',
      `${operation} is not permitted for a delegated Session.`,
    );
  }
}

function ensureSessionIndex(
  database: NodeDatabaseSync,
  projectId: string,
  sessionId: string,
  occurredAt: string,
  title?: string,
  identity: Readonly<{
    kind: 'root' | 'delegated';
    visibility: 'public' | 'internal';
    parentRunId?: string;
    parentSessionId?: string;
  }> = { kind: 'root', visibility: 'public' },
): void {
  if (
    (identity.kind === 'root' &&
      (identity.visibility !== 'public' || identity.parentRunId !== undefined || identity.parentSessionId !== undefined)) ||
    (identity.kind === 'delegated' &&
      (identity.visibility !== 'internal' || identity.parentRunId === undefined || identity.parentSessionId === undefined))
  ) {
    throw new AgentJournalError('INVALID_ARGUMENT', 'Session identity is invalid.');
  }
  const existing = database.prepare(
    `SELECT session_kind, visibility, parent_run_id, parent_session_id
     FROM agent_sessions WHERE project_id = ? AND session_id = ?`,
  ).get(projectId, sessionId) as Pick<
    SessionIndexRow,
    'session_kind' | 'visibility' | 'parent_run_id' | 'parent_session_id'
  > | undefined;
  if (existing !== undefined) {
    if (
      identity.kind === 'delegated' &&
      (
        existing.session_kind !== identity.kind ||
        existing.visibility !== identity.visibility ||
        existing.parent_run_id !== identity.parentRunId ||
        existing.parent_session_id !== identity.parentSessionId
      )
    ) {
      throw new AgentJournalError(
        'COMMAND_CONFLICT', 'Delegated Session identity conflicts with an existing Session.',
      );
    }
    return;
  }
  database.prepare(
    `INSERT INTO agent_sessions (
       project_id, session_id, session_kind, visibility, parent_run_id, parent_session_id,
       archive_revision, archived, title,
       created_at, updated_at, last_activity_sequence, run_count
     ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, 0, 0)`,
  ).run(
    projectId, sessionId, identity.kind, identity.visibility,
    identity.parentRunId ?? null, identity.parentSessionId ?? null,
    title ?? null, occurredAt, occurredAt,
  );
}

function touchSessionIndex(
  database: NodeDatabaseSync,
  projectId: string,
  sessionId: string,
  occurredAt: string,
  sourceSequence: number,
  title?: string,
  runDelta = 0,
): void {
  ensureSessionIndex(database, projectId, sessionId, occurredAt, title);
  database.prepare(
    `UPDATE agent_sessions SET
       title = COALESCE(title, ?),
       created_at = CASE WHEN created_at > ? THEN ? ELSE created_at END,
       updated_at = CASE WHEN updated_at < ? THEN ? ELSE updated_at END,
       last_activity_sequence = CASE
         WHEN last_activity_sequence < ? THEN ? ELSE last_activity_sequence END,
       run_count = run_count + ?
     WHERE project_id = ? AND session_id = ?`,
  ).run(
    title ?? null,
    occurredAt, occurredAt,
    occurredAt, occurredAt,
    sourceSequence, sourceSequence,
    runDelta,
    projectId, sessionId,
  );
}

function applySessionIndexAgentEvent(database: NodeDatabaseSync, event: AgentEvent): void {
  if (event.type === 'legacy.imported') {
    if (event.payload.entityType !== 'session') return;
    const imported = event.payload.record;
    database.prepare(
      `INSERT INTO agent_sessions (
         project_id, session_id, archive_revision, archived, title,
         created_at, updated_at, last_activity_sequence, run_count
       ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(project_id, session_id) DO UPDATE SET
         archive_revision = CASE
           WHEN agent_sessions.archive_revision < 1 THEN 1 ELSE agent_sessions.archive_revision END,
         archived = CASE
           WHEN agent_sessions.archive_revision < 1 THEN excluded.archived ELSE agent_sessions.archived END,
         title = excluded.title,
         created_at = excluded.created_at,
         updated_at = CASE
           WHEN agent_sessions.updated_at < excluded.updated_at
             THEN excluded.updated_at ELSE agent_sessions.updated_at END,
         last_activity_sequence = CASE
           WHEN agent_sessions.last_activity_sequence < excluded.last_activity_sequence
             THEN excluded.last_activity_sequence ELSE agent_sessions.last_activity_sequence END`,
    ).run(
      event.projectId, event.sessionId, imported.archived ? 1 : 0,
      imported.session.title, imported.createdAt, imported.updatedAt, event.sequence,
    );
    return;
  }
  if (event.type === 'run.created' && event.payload.visibility === 'legacy-import-carrier') return;
  const hidden = database.prepare(
    'SELECT hidden FROM agent_runs WHERE project_id = ? AND run_id = ?',
  ).get(event.projectId, event.runId) as { hidden: number } | undefined;
  if (hidden?.hidden === 1) return;
  const title = event.type === 'input.received' ? sessionTitleFromInput(event.payload.content) : undefined;
  touchSessionIndex(
    database,
    event.projectId,
    event.sessionId,
    event.occurredAt,
    event.sequence,
    title,
    event.type === 'run.created' ? 1 : 0,
  );
}

function sessionTitleFromInput(input: PortableValue): string | undefined {
  const record = input !== null && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, PortableValue>
    : undefined;
  const text = typeof input === 'string'
    ? input
    : typeof record?.['text'] === 'string'
      ? record['text']
      : undefined;
  if (text === undefined) return undefined;
  const normalized = text.replace(/\s+/gu, ' ').trim();
  if (normalized.length === 0) return undefined;
  return [...normalized].slice(0, 80).join('');
}

function backfillSessionIndexes(database: NodeDatabaseSync): void {
  const projects = database.prepare(`
    SELECT project_id FROM agent_runs
    UNION SELECT project_id FROM agent_session_events
    UNION SELECT project_id FROM agent_session_model_bindings
  `).all() as unknown as Array<{ project_id: string }>;
  for (const { project_id: projectId } of projects) rebuildSessionProjectionTables(database, projectId);
}

function rebuildSessionProjectionTables(database: NodeDatabaseSync, projectId: string): void {
  database.prepare('DELETE FROM agent_session_skill_configurations WHERE project_id = ?').run(projectId);
  database.prepare('DELETE FROM agent_session_model_bindings WHERE project_id = ?').run(projectId);
  database.prepare('DELETE FROM agent_sessions WHERE project_id = ?').run(projectId);
  const agentRows = database.prepare(
    'SELECT * FROM agent_events WHERE project_id = ? ORDER BY sequence ASC',
  ).all(projectId) as unknown as EventRow[];
  for (const row of agentRows) applySessionIndexAgentEvent(database, eventFromRow(row));

  const sessionRows = database.prepare(
    `SELECT project_id, session_id, sequence, event_id, schema_version,
            event_type, payload_json, occurred_at
     FROM agent_session_events WHERE project_id = ? ORDER BY sequence ASC`,
  ).all(projectId) as unknown as Array<{
    project_id: string; session_id: string; sequence: number; event_id: string;
    schema_version: number; event_type: string; payload_json: string; occurred_at: string;
  }>;
  for (const row of sessionRows) {
    const event = upcastSessionJournalEvent({
      schemaVersion: row.schema_version,
      projectId: row.project_id,
      sessionId: row.session_id,
      sequence: row.sequence,
      eventId: row.event_id,
      type: row.event_type,
      payload: parsePortableJson(row.payload_json),
      occurredAt: row.occurred_at,
    });
    ensureSessionIndex(database, event.projectId, event.sessionId, event.occurredAt);
    if (event.type === 'session.model_bound') {
      const primary = event.payload.model.descriptor.primary;
      database.prepare(
        `INSERT INTO agent_session_model_bindings (
           project_id, session_id, revision, connection_id, model_id, payload_json, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, session_id) DO UPDATE SET
           revision = excluded.revision, connection_id = excluded.connection_id,
           model_id = excluded.model_id, payload_json = excluded.payload_json,
           updated_at = excluded.updated_at`,
      ).run(
        event.projectId, event.sessionId, event.payload.revision,
        primary.route.connectionId, primary.route.modelId,
        JSON.stringify(event.payload), event.occurredAt,
      );
    } else if (event.type === 'session.archive_set') {
      database.prepare(
        `UPDATE agent_sessions SET archive_revision = ?, archived = ?, updated_at = ?
         WHERE project_id = ? AND session_id = ?`,
      ).run(
        event.payload.revision, event.payload.archived ? 1 : 0, event.occurredAt,
        event.projectId, event.sessionId,
      );
    } else {
      const configuration: SessionSkillConfiguration = {
        schemaVersion: 1,
        projectId: event.projectId,
        sessionId: event.sessionId,
        revision: event.payload.revision,
        definitions: structuredClone(event.payload.definitions),
        updatedAt: event.occurredAt,
      };
      database.prepare(
        `INSERT INTO agent_session_skill_configurations (
           project_id, session_id, revision, payload_json, updated_at
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id, session_id) DO UPDATE SET
           revision = excluded.revision, payload_json = excluded.payload_json,
           updated_at = excluded.updated_at`,
      ).run(
        event.projectId, event.sessionId, configuration.revision,
        JSON.stringify(configuration), event.occurredAt,
      );
    }
    touchSessionIndex(database, event.projectId, event.sessionId, event.occurredAt, 0);
  }
  migrateSessionVisibility(database);
}

function backfillRunLeaseFences(database: NodeDatabaseSync): void {
  database.exec(`
    INSERT INTO agent_run_lease_fences (project_id, run_id, last_fencing_token)
    SELECT project_id, run_id, fencing_token FROM agent_run_leases
    WHERE true
    ON CONFLICT(project_id, run_id) DO UPDATE SET
      last_fencing_token = CASE
        WHEN excluded.last_fencing_token > agent_run_lease_fences.last_fencing_token
          THEN excluded.last_fencing_token
        ELSE agent_run_lease_fences.last_fencing_token
      END;
  `);
}

function backfillRunAncestry(database: NodeDatabaseSync): void {
  const columns = database.prepare('PRAGMA table_info(agent_run_ancestry)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'root_child_ordinal')) {
    database.exec(
      'ALTER TABLE agent_run_ancestry ADD COLUMN root_child_ordinal INTEGER NOT NULL DEFAULT 0 CHECK (root_child_ordinal >= 0)',
    );
  }
  const rows = database.prepare(
    `SELECT project_id, run_id, payload_json FROM agent_events
     WHERE event_type = 'run.created' ORDER BY project_id ASC, sequence ASC`,
  ).all() as Array<{ project_id: string; run_id: string; payload_json: string }>;
  const lookup = database.prepare(
    `SELECT root_run_id, depth FROM agent_run_ancestry WHERE project_id = ? AND run_id = ?`,
  );
  const insert = database.prepare(
    `INSERT OR IGNORE INTO agent_run_ancestry
       (project_id, run_id, parent_run_id, root_run_id, depth, root_child_ordinal) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    const payload = parsePortableJson(row.payload_json) as { parent?: { runId?: unknown } };
    const parentRunId = typeof payload.parent?.runId === 'string' ? payload.parent.runId : null;
    const parent = parentRunId === null ? undefined : lookup.get(row.project_id, parentRunId) as
      | { root_run_id: string; depth: number }
      | undefined;
    if (parentRunId !== null && parent === undefined) {
      throw new AgentJournalError('PROJECTION_CORRUPT', 'Cannot backfill child Run ancestry before parent.');
    }
    insert.run(
      row.project_id, row.run_id, parentRunId,
      parent?.root_run_id ?? row.run_id,
      parent === undefined ? 0 : Number(parent.depth) + 1,
      parent === undefined ? 0 : Number((database.prepare(
        `SELECT COUNT(*) AS count FROM agent_run_ancestry
         WHERE project_id = ? AND root_run_id = ? AND run_id <> ?`,
      ).get(row.project_id, parent.root_run_id, parent.root_run_id) as { count: number }).count) + 1,
    );
  }
}

/**
 * Session identity is a persisted access boundary, never an ID-prefix convention.
 * Older stores are changed only when their Run ancestry proves one delegated parent;
 * any ambiguous or top-level Session remains public.
 */
function migrateSessionVisibility(database: NodeDatabaseSync): void {
  const columns = new Set((database.prepare('PRAGMA table_info(agent_sessions)').all() as
    Array<{ name: string }>).map(({ name }) => name));
  const addColumn = (name: string, definition: string): void => {
    if (!columns.has(name)) database.exec(`ALTER TABLE agent_sessions ADD COLUMN ${name} ${definition}`);
  };
  addColumn('session_kind', "TEXT NOT NULL DEFAULT 'root'");
  addColumn('visibility', "TEXT NOT NULL DEFAULT 'public'");
  addColumn('parent_run_id', 'TEXT');
  addColumn('parent_session_id', 'TEXT');
  database.exec(
    `CREATE INDEX IF NOT EXISTS idx_agent_sessions_project_visibility_activity
     ON agent_sessions(project_id, visibility, updated_at DESC, last_activity_sequence DESC, session_id ASC)`,
  );

  const roots = new Map<string, Set<string>>();
  for (const row of database.prepare(`
    SELECT run.project_id, run.session_id
    FROM agent_runs AS run
    JOIN agent_run_ancestry AS ancestry
      ON ancestry.project_id = run.project_id AND ancestry.run_id = run.run_id
    WHERE ancestry.parent_run_id IS NULL
  `).all() as Array<{ project_id: string; session_id: string }>) {
    const sessions = roots.get(row.project_id) ?? new Set<string>();
    sessions.add(row.session_id);
    roots.set(row.project_id, sessions);
  }
  const candidates = new Map<string, Map<string, Map<string, Readonly<{
    parentRunId: string;
    parentSessionId: string;
  }>>>>();
  const childRows = database.prepare(`
    SELECT child.project_id, child.session_id, ancestry.parent_run_id, parent.session_id AS parent_session_id
    FROM agent_runs AS child
    JOIN agent_run_ancestry AS ancestry
      ON ancestry.project_id = child.project_id AND ancestry.run_id = child.run_id
    JOIN agent_runs AS parent
      ON parent.project_id = child.project_id AND parent.run_id = ancestry.parent_run_id
    WHERE ancestry.parent_run_id IS NOT NULL
  `).all() as Array<{
    project_id: string;
    session_id: string;
    parent_run_id: string;
    parent_session_id: string;
  }>;
  for (const row of childRows) {
    const sessions = candidates.get(row.project_id) ?? new Map<string, Map<string, Readonly<{
      parentRunId: string;
      parentSessionId: string;
    }>>>();
    const parents = sessions.get(row.session_id) ?? new Map<string, Readonly<{
      parentRunId: string;
      parentSessionId: string;
    }>>();
    parents.set(JSON.stringify([row.parent_run_id, row.parent_session_id]), {
      parentRunId: row.parent_run_id,
      parentSessionId: row.parent_session_id,
    });
    sessions.set(row.session_id, parents);
    candidates.set(row.project_id, sessions);
  }
  const update = database.prepare(`
    UPDATE agent_sessions
    SET session_kind = 'delegated', visibility = 'internal',
        parent_run_id = ?, parent_session_id = ?
    WHERE project_id = ? AND session_id = ?
      AND session_kind = 'root' AND visibility = 'public'
      AND parent_run_id IS NULL AND parent_session_id IS NULL
  `);
  for (const [projectId, sessions] of candidates) {
    for (const [sessionId, parents] of sessions) {
      if (roots.get(projectId)?.has(sessionId) || parents.size !== 1) continue;
      const parent = parents.values().next().value as Readonly<{
        parentRunId: string;
        parentSessionId: string;
      }>;
      update.run(parent.parentRunId, parent.parentSessionId, projectId, sessionId);
    }
  }
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

/** Older projections have no billing column; their event schema is explicitly byok. */
function migrateUsageBillingMode(database: NodeDatabaseSync): void {
  const columns = database.prepare('PRAGMA table_info(agent_usage)').all() as Array<{ name: string }>;
  if (!columns.some(({ name }) => name === 'billing_mode')) {
    database.exec(
      "ALTER TABLE agent_usage ADD COLUMN billing_mode TEXT NOT NULL DEFAULT 'byok' CHECK (billing_mode IN ('byok', 'managed'))",
    );
  }
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
    'expectedRunRevision', 'expectedTurnRevision', 'billingMode', 'attempt',
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
    billingMode: requireUsageBillingMode(values.billingMode, 'billingMode'),
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
  command: BindPersistedSessionModelCommand,
): BindPersistedSessionModelCommand {
  let snapshot: BindPersistedSessionModelCommand;
  try {
    snapshot = structuredClone(command);
    const candidate: unknown = snapshot;
    assertPortableValue(candidate);
  } catch (error) {
    throw new AgentJournalError(
      'INVALID_ARGUMENT', `Session binding command is not portable: ${errorMessage(error)}`,
    );
  }
  assertExactObjectKeys(snapshot, [
    'projectId', 'sessionId', 'commandId', 'expectedRevision', 'model',
  ]);
  requireText(snapshot.projectId, 'projectId');
  requireText(snapshot.sessionId, 'sessionId');
  requireText(snapshot.commandId, 'commandId');
  if (!Number.isSafeInteger(snapshot.expectedRevision) || snapshot.expectedRevision < 0) {
    throw new AgentJournalError('INVALID_ARGUMENT', 'expectedRevision is invalid.');
  }
  validatePersistedModelRuntimeBinding(snapshot.model);
  return deepFreezeKernelValue(snapshot);
}

function snapshotSessionArchiveCommand(
  command: SetSessionArchivedCommand,
): SetSessionArchivedCommand {
  const values = snapshotDataRecord(command, [
    'projectId', 'sessionId', 'commandId', 'expectedRevision', 'archived',
  ], [], 'Session archive command');
  if (typeof values.archived !== 'boolean') {
    throw new AgentJournalError('INVALID_ARGUMENT', 'Session archived must be boolean.');
  }
  return deepFreezeKernelValue({
    projectId: requireText(values.projectId, 'projectId'),
    sessionId: requireText(values.sessionId, 'sessionId'),
    commandId: requireText(values.commandId, 'commandId'),
    expectedRevision: requireNonNegativeRevision(values.expectedRevision, 'expectedRevision'),
    archived: values.archived,
  });
}

function snapshotSessionSkillsCommand(
  command: ConfigureSessionSkillsCommand,
): ConfigureSessionSkillsCommand {
  const values = snapshotDataRecord(command, [
    'projectId', 'sessionId', 'commandId', 'expectedRevision', 'definitions',
  ], [], 'Session Skills command');
  if (!Array.isArray(values.definitions) || values.definitions.length > MAX_SESSION_SKILL_DEFINITIONS) {
    throw new AgentJournalError(
      'INVALID_ARGUMENT',
      `Session Skills must contain at most ${MAX_SESSION_SKILL_DEFINITIONS} definitions.`,
    );
  }
  let totalBytes = 0;
  const definitions = values.definitions.map((value, index) => {
    const definition = snapshotDataRecord(
      value,
      ['content'],
      ['sourcePath'],
      `Session Skill definition ${index}`,
    );
    const content = requireText(definition.content, `definitions[${index}].content`);
    const contentBytes = Buffer.byteLength(content, 'utf8');
    if (contentBytes > MAX_SESSION_SKILL_BYTES) {
      throw new AgentJournalError(
        'INVALID_ARGUMENT',
        `Session Skill definition ${index} exceeds ${MAX_SESSION_SKILL_BYTES} bytes.`,
      );
    }
    totalBytes += contentBytes;
    const sourcePath = definition.sourcePath === undefined
      ? undefined
      : requireText(definition.sourcePath, `definitions[${index}].sourcePath`);
    if (sourcePath !== undefined && sourcePath.length > MAX_SESSION_SKILL_SOURCE_PATH_CHARS) {
      throw new AgentJournalError(
        'INVALID_ARGUMENT',
        `Session Skill sourcePath exceeds ${MAX_SESSION_SKILL_SOURCE_PATH_CHARS} characters.`,
      );
    }
    return Object.freeze({ content, ...(sourcePath === undefined ? {} : { sourcePath }) });
  });
  if (totalBytes > MAX_SESSION_SKILL_TOTAL_BYTES) {
    throw new AgentJournalError(
      'INVALID_ARGUMENT',
      `Session Skills exceed ${MAX_SESSION_SKILL_TOTAL_BYTES} total bytes.`,
    );
  }
  return deepFreezeKernelValue({
    projectId: requireText(values.projectId, 'projectId'),
    sessionId: requireText(values.sessionId, 'sessionId'),
    commandId: requireText(values.commandId, 'commandId'),
    expectedRevision: requireNonNegativeRevision(values.expectedRevision, 'expectedRevision'),
    definitions,
  });
}

function requireNonNegativeRevision(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new AgentJournalError('INVALID_ARGUMENT', `${name} must be a non-negative integer.`);
  }
  return Number(value);
}

function validatePersistedModelRuntimeBinding(
  model: BindPersistedSessionModelCommand['model'],
): void {
  assertExactObjectKeys(model, ['descriptor', 'bindingDigest']);
  requireText(model.bindingDigest, 'model.bindingDigest');
  if (model.descriptor.bindingDigest !== model.bindingDigest) {
    throw new AgentJournalError(
      'INVALID_ARGUMENT', 'Persisted ModelSessionBundle digest disagrees with its descriptor.',
    );
  }
  validatePersistedModelSessionDescriptor(model.descriptor.primary);
  const fallbackValue: unknown = model.descriptor.fallbacks;
  if (!Array.isArray(fallbackValue)) {
    throw new AgentJournalError('INVALID_ARGUMENT', 'Persisted fallback descriptors are invalid.');
  }
  for (const fallback of model.descriptor.fallbacks) {
    validatePersistedModelSessionDescriptor(fallback);
  }
}

function validatePersistedModelSessionDescriptor(
  descriptor: PersistedModelSessionDescriptor,
): void {
  requireText(descriptor.bindingDigest, 'descriptor.bindingDigest');
  requireText(descriptor.route.routeId, 'descriptor.route.routeId');
  requireText(descriptor.route.connectionId, 'descriptor.route.connectionId');
  requireText(descriptor.route.providerId, 'descriptor.route.providerId');
  requireText(descriptor.route.modelId, 'descriptor.route.modelId');
  requireText(descriptor.route.protocol, 'descriptor.route.protocol');
  requireText(descriptor.route.codecRevision, 'descriptor.route.codecRevision');
  requireText(descriptor.route.metadata.source, 'descriptor.route.metadata.source');
  requireText(descriptor.route.metadata.revision, 'descriptor.route.metadata.revision');
  requireText(descriptor.route.metadata.digest, 'descriptor.route.metadata.digest');
  requireText(
    descriptor.clientBinding.connectionResolutionRevision,
    'descriptor.clientBinding.connectionResolutionRevision',
  );
  requireText(
    descriptor.clientBinding.connectionConfigurationRevision,
    'descriptor.clientBinding.connectionConfigurationRevision',
  );
  requireText(
    descriptor.clientBinding.credentialRevision,
    'descriptor.clientBinding.credentialRevision',
  );
  if (
    descriptor.route.metadata.revision !==
      descriptor.clientBinding.connectionResolutionRevision ||
    descriptor.route.metadata.connectionConfigurationRevision !==
      descriptor.clientBinding.connectionConfigurationRevision ||
    descriptor.route.metadata.credentialRevision !== descriptor.clientBinding.credentialRevision
  ) {
    throw new AgentJournalError(
      'INVALID_ARGUMENT', 'Persisted Model descriptor metadata and client binding disagree.',
    );
  }
}

function validateKernelJournalCommand(command: KernelJournalCommand): KernelJournalCommand {
  try {
    const portableCandidate: unknown = command;
    assertPortableValue(portableCandidate);
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
    case 'capture-turn':
      assertExactObjectKeys(command, [
        'action', 'projectId', 'sessionId', 'runId', 'commandId', 'lease',
        'expectedRunRevision', 'turnId', 'environment', 'snapshot',
      ]);
      requireText(command.turnId, 'turnId');
      validateEnvironmentBindingInput(command.environment);
      validateTurnSnapshotInput(command.snapshot);
      return command;
    case 'commit-context-ready':
      assertExactObjectKeys(command, [
        'action', 'projectId', 'sessionId', 'runId', 'commandId', 'lease',
        'expectedRunRevision', 'turnId', 'expectedTurnRevision',
      ], ['contextRef', 'tokenEstimate']);
      requireText(command.turnId, 'turnId');
      if (!Number.isSafeInteger(command.expectedTurnRevision) || command.expectedTurnRevision < 1) {
        throw new AgentJournalError('INVALID_ARGUMENT', 'expectedTurnRevision is invalid.');
      }
      if (command.contextRef !== undefined) requireText(command.contextRef, 'contextRef');
      if (
        command.tokenEstimate !== undefined &&
        (!Number.isSafeInteger(command.tokenEstimate) || command.tokenEstimate < 0)
      ) {
        throw new AgentJournalError('INVALID_ARGUMENT', 'tokenEstimate is invalid.');
      }
      return command;
    case 'close-observed-turn':
      assertExactObjectKeys(command, [
        'action', 'projectId', 'sessionId', 'runId', 'commandId', 'lease',
        'expectedRunRevision', 'turnId', 'expectedTurnRevision',
      ]);
      requireText(command.turnId, 'turnId');
      if (!Number.isSafeInteger(command.expectedTurnRevision) || command.expectedTurnRevision < 1) {
        throw new AgentJournalError('INVALID_ARGUMENT', 'expectedTurnRevision is invalid.');
      }
      return command;
    case 'block-outcome-resolution':
      assertExactObjectKeys(command, [
        'action', 'projectId', 'sessionId', 'runId', 'commandId', 'lease',
        'expectedRunRevision', 'turnId', 'expectedTurnRevision', 'requests',
      ]);
      requireText(command.turnId, 'turnId');
      if (!Number.isSafeInteger(command.expectedTurnRevision) || command.expectedTurnRevision < 1) {
        throw new AgentJournalError('INVALID_ARGUMENT', 'expectedTurnRevision is invalid.');
      }
      if (!Array.isArray(command.requests)) {
        throw new AgentJournalError('INVALID_ARGUMENT', 'requests must be an array.');
      }
      for (const request of command.requests) {
        const requestRecord = snapshotDataRecord(
          request,
          ['invocationId', 'summary'],
          [],
          'outcome resolution request',
        );
        requireText(requestRecord.invocationId, 'requests.invocationId');
        requireText(requestRecord.summary, 'requests.summary');
      }
      return command;
    case 'complete-outcome-resolution':
      assertExactObjectKeys(command, [
        'action', 'projectId', 'sessionId', 'runId', 'commandId', 'lease',
        'expectedRunRevision', 'turnId',
      ]);
      requireText(command.turnId, 'turnId');
      return command;
    case 'steer-run':
    case 'queue-steering':
    case 'consume-steering':
      assertExactObjectKeys(command, [
        'action', 'projectId', 'sessionId', 'runId', 'commandId', 'lease',
        'expectedRunRevision', 'clientRequestId', 'input',
      ]);
      requireText(command.clientRequestId, 'clientRequestId');
      return command;
    case 'request-input':
      assertExactObjectKeys(command, [
        'action', 'projectId', 'sessionId', 'runId', 'commandId', 'lease',
        'expectedRunRevision', 'reason',
      ], ['connectionId']);
      requireText(command.reason, 'reason');
      if (command.connectionId !== undefined) requireText(command.connectionId, 'connectionId');
      return command;
    case 'resume-run':
      assertExactObjectKeys(command, [
        'action', 'projectId', 'sessionId', 'runId', 'commandId', 'lease',
        'expectedRunRevision',
      ], ['reason']);
      if (command.reason !== undefined) requireText(command.reason, 'reason');
      return command;
    case 'reach-limit':
      assertExactObjectKeys(command, [
        'action', 'projectId', 'sessionId', 'runId', 'commandId', 'lease',
        'expectedRunRevision', 'limit',
      ], ['value']);
      requireText(command.limit, 'limit');
      if (
        command.value !== undefined &&
        (!Number.isFinite(command.value) || command.value < 0)
      ) {
        throw new AgentJournalError('INVALID_ARGUMENT', 'limit value is invalid.');
      }
      return command;
    case 'interrupt-run':
    case 'fail-run':
      assertExactObjectKeys(command, [
        'action', 'projectId', 'sessionId', 'runId', 'commandId', 'lease',
        'expectedRunRevision', 'code',
      ], ['detail']);
      requireText(command.code, 'code');
      return command;
    case 'queue-context-compaction':
      assertExactObjectKeys(command, [
        'action', 'projectId', 'sessionId', 'runId', 'commandId', 'lease',
        'expectedRunRevision', 'decisionId',
      ]);
      requireText(command.decisionId, 'decisionId');
      return command;
    case 'start-context-compaction':
      assertExactObjectKeys(command, [
        'action', 'projectId', 'sessionId', 'runId', 'commandId', 'lease',
        'expectedRunRevision', 'checkpointId', 'decisionId', 'reason', 'coveredSequence',
      ]);
      requireText(command.checkpointId, 'checkpointId');
      requireText(command.decisionId, 'decisionId');
      if (!['automatic', 'manual'].includes(command.reason)) {
        throw new AgentJournalError('INVALID_ARGUMENT', 'Context compaction reason is invalid.');
      }
      if (!Number.isSafeInteger(command.coveredSequence) || command.coveredSequence < 0) {
        throw new AgentJournalError('INVALID_ARGUMENT', 'coveredSequence is invalid.');
      }
      return command;
    case 'complete-context-compaction':
      assertExactObjectKeys(command, [
        'action', 'projectId', 'sessionId', 'runId', 'commandId', 'lease',
        'expectedRunRevision', 'checkpointId', 'decisionId', 'summaryRef', 'summary',
        'coveredSequence', 'attemptId',
      ], ['usage', 'billingMode']);
      requireText(command.checkpointId, 'checkpointId');
      requireText(command.decisionId, 'decisionId');
      requireText(command.summaryRef, 'summaryRef');
      requireText(command.summary, 'summary');
      requireText(command.attemptId, 'attemptId');
      if (!Number.isSafeInteger(command.coveredSequence) || command.coveredSequence < 0) {
        throw new AgentJournalError('INVALID_ARGUMENT', 'coveredSequence is invalid.');
      }
      if (command.usage !== undefined) validateModelTokenUsage(command.usage);
      if ((command.usage === undefined) !== (command.billingMode === undefined)) {
        throw new AgentJournalError(
          'INVALID_ARGUMENT',
          'Context compaction usage and billingMode must be present together.',
        );
      }
      if (command.billingMode !== undefined) requireUsageBillingMode(command.billingMode, 'billingMode');
      return command;
    case 'fail-context-compaction':
      assertExactObjectKeys(command, [
        'action', 'projectId', 'sessionId', 'runId', 'commandId', 'lease',
        'expectedRunRevision', 'checkpointId', 'decisionId', 'code',
      ]);
      requireText(command.checkpointId, 'checkpointId');
      requireText(command.decisionId, 'decisionId');
      requireText(command.code, 'code');
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
        'expectedRunRevision', 'turnId', 'fingerprint',
      ]);
      requireText(command.turnId, 'turnId');
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
  ], ['verifierId', 'verifierRevision', 'reason', 'observation']);
  if (!Number.isSafeInteger(value.evidenceRevision) || value.evidenceRevision < 0) {
    throw new AgentJournalError('INVALID_ARGUMENT', 'decision.evidenceRevision is invalid.');
  }
  if (!['not-required', 'verified', 'unverified'].includes(value.status)) {
    throw new AgentJournalError('INVALID_ARGUMENT', 'decision.status is invalid.');
  }
  if (!['accepted', 'revision-requested', 'failed'].includes(value.outcome)) {
    throw new AgentJournalError('INVALID_ARGUMENT', 'decision.outcome is invalid.');
  }
  if (
    !Array.isArray(value.evidenceRefs) ||
    value.evidenceRefs.length > MAX_AGENT_EVIDENCE_REFS
  ) {
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
  if (value.outcome === 'revision-requested') {
    if (value.observation === undefined) {
      throw new AgentJournalError(
        'INVALID_ARGUMENT', 'A delivery revision request requires a semantic observation.',
      );
    }
    assertPortableValue(value.observation);
    if (Buffer.byteLength(JSON.stringify(value.observation), 'utf8') > 64 * 1024) {
      throw new AgentJournalError(
        'INVALID_ARGUMENT', 'decision.observation exceeds the bounded delivery contract.',
      );
    }
  } else if (value.observation !== undefined) {
    throw new AgentJournalError(
      'INVALID_ARGUMENT', 'Only a delivery revision request may carry an observation.',
    );
  }
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
  if (value.outcome === 'revision-requested' && value.status !== 'unverified') {
    throw new AgentJournalError(
      'INVALID_ARGUMENT', 'A delivery revision request must be explicitly unverified.',
    );
  }
}

function validateModelTokenUsage(
  usage: Readonly<{ inputTokens: number; outputTokens: number; totalTokens: number }>,
): void {
  if (
    !Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0 ||
    !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 0 ||
    !Number.isSafeInteger(usage.totalTokens) || usage.totalTokens < 0 ||
    usage.totalTokens < usage.inputTokens + usage.outputTokens
  ) {
    throw new AgentJournalError('INVALID_ARGUMENT', 'Model token usage is invalid.');
  }
}

function validateEnvironmentBindingInput(value: EnvironmentBindingInput): void {
  assertExactObjectKeys(value, [
    'environmentBindingId', 'settingsRevision', 'permissionPolicyRevision', 'modelSession',
  ]);
  requireText(value.environmentBindingId, 'environmentBindingId');
  requireText(value.settingsRevision, 'settingsRevision');
  requireText(value.permissionPolicyRevision, 'permissionPolicyRevision');
  validatePersistedModelRuntimeBinding({
    descriptor: value.modelSession,
    bindingDigest: value.modelSession.bindingDigest,
  });
}

function validateTurnSnapshotInput(value: TurnSnapshotInput): void {
  assertExactObjectKeys(value, [
    'turnSnapshotId', 'capability', 'promptRevision', 'tools', 'skills', 'verifiers',
  ], ['discoverableTools', 'discoverableCapabilities', 'hooks', 'runtimeProtocol', 'promptSections']);
  requireText(value.turnSnapshotId, 'turnSnapshotId');
  requireText(value.promptRevision, 'promptRevision');
  if ((value.runtimeProtocol === undefined) !== (value.promptSections === undefined)) {
    throw new AgentJournalError('INVALID_ARGUMENT', 'Turn Snapshot prompt content must be complete.');
  }
  if (value.runtimeProtocol !== undefined && value.promptSections !== undefined) {
    if (value.promptSections.length > 256) {
      throw new AgentJournalError('INVALID_ARGUMENT', 'Turn Snapshot prompt section count is unbounded.');
    }
    try {
      snapshotPromptSection(value.runtimeProtocol);
      for (const section of value.promptSections) snapshotPromptSection(section);
    } catch {
      throw new AgentJournalError('INVALID_ARGUMENT', 'Turn Snapshot prompt content is invalid.');
    }
    if (Buffer.byteLength(JSON.stringify({ runtimeProtocol: value.runtimeProtocol, promptSections: value.promptSections }), 'utf8') > 1_048_576) {
      throw new AgentJournalError('INVALID_ARGUMENT', 'Turn Snapshot prompt content is too large.');
    }
  }
  assertExactObjectKeys(value.capability, ['snapshotId', 'revision']);
  requireText(value.capability.snapshotId, 'capability.snapshotId');
  requireText(value.capability.revision, 'capability.revision');
  if (
    value.tools.length > 1_024 || (value.discoverableTools?.length ?? 0) > 4_096 ||
    (value.discoverableCapabilities?.length ?? 0) > 1_024 ||
    value.skills.length > 256 || value.verifiers.length > 64
  ) {
    throw new AgentJournalError('INVALID_ARGUMENT', 'Turn Snapshot contribution list is unbounded.');
  }
  for (const tool of [...value.tools, ...(value.discoverableTools ?? [])]) {
    assertExactObjectKeys(tool, ['name', 'revision']);
    requireText(tool.name, 'tool.name');
    requireText(tool.revision, 'tool.revision');
  }
  try {
    snapshotCapabilityDiscoveryManifest(value.discoverableCapabilities ?? []);
  } catch {
    throw new AgentJournalError('INVALID_ARGUMENT', 'Turn Snapshot discoverable Capability manifest is invalid.');
  }
  for (const skill of value.skills) {
    assertExactObjectKeys(skill, ['id', 'revision'], ['allowedTools']);
    requireText(skill.id, 'skill.id');
    requireText(skill.revision, 'skill.revision');
    if ((skill.allowedTools?.length ?? 0) > 1_024) {
      throw new AgentJournalError('INVALID_ARGUMENT', 'Skill Tool allowlist is unbounded.');
    }
    for (const name of skill.allowedTools ?? []) requireText(name, 'skill.allowedTools');
  }
  if ((value.hooks?.length ?? 0) > 256) {
    throw new AgentJournalError('INVALID_ARGUMENT', 'Turn Snapshot Hook list is unbounded.');
  }
  for (const hook of value.hooks ?? []) {
    assertExactObjectKeys(hook, ['id', 'revision']);
    requireText(hook.id, 'hook.id');
    requireText(hook.revision, 'hook.revision');
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

function readContextCheckpointProjection(
  database: NodeDatabaseSync,
  checkpointId: string,
): PersistedContextCheckpoint | null {
  const row = database.prepare(
    `SELECT payload_json FROM agent_context_checkpoints WHERE checkpoint_id = ?`,
  ).get(checkpointId) as { payload_json: string } | undefined;
  if (row === undefined) return null;
  return freezeContextCheckpoint(
    parsePortableJson(row.payload_json) as unknown as PersistedContextCheckpoint,
  );
}

function readPendingContextCompaction(
  database: NodeDatabaseSync,
  runId: string,
): PendingContextCompaction | null {
  const row = database.prepare(
    `SELECT project_id, session_id, run_id, decision_id, requested_at
     FROM agent_context_compaction_requests WHERE run_id = ?`,
  ).get(runId) as Readonly<{
    project_id: string;
    session_id: string;
    run_id: string;
    decision_id: string;
    requested_at: string;
  }> | undefined;
  if (row === undefined) return null;
  return deepFreezeKernelValue({
    schemaVersion: 1,
    projectId: row.project_id,
    sessionId: row.session_id,
    runId: row.run_id,
    decisionId: row.decision_id,
    requestedAt: row.requested_at,
  });
}

function persistPendingContextCompaction(
  database: NodeDatabaseSync,
  pending: PendingContextCompaction,
): void {
  database.prepare(
    `INSERT INTO agent_context_compaction_requests (
      run_id, project_id, session_id, decision_id, requested_at
    ) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    pending.runId, pending.projectId, pending.sessionId,
    pending.decisionId, pending.requestedAt,
  );
}

function persistContextCheckpointProjection(
  database: NodeDatabaseSync,
  checkpoint: PersistedContextCheckpoint,
): void {
  database.prepare(
    `INSERT INTO agent_context_checkpoints (
      checkpoint_id, project_id, run_id, covered_sequence, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(checkpoint_id) DO UPDATE SET
      covered_sequence = excluded.covered_sequence,
      payload_json = excluded.payload_json`,
  ).run(
    checkpoint.checkpointId,
    checkpoint.projectId,
    checkpoint.runId,
    checkpoint.coveredSequence,
    JSON.stringify(checkpoint),
    checkpoint.createdAt,
  );
}

function freezeContextCheckpoint(
  checkpoint: PersistedContextCheckpoint,
): PersistedContextCheckpoint {
  return deepFreezeKernelValue(structuredClone(checkpoint));
}

/** Replays Context checkpoints exclusively from immutable Journal facts. */
function replayContextCheckpointFacts(
  events: readonly AgentEvent[],
): Readonly<{
  checkpoints: readonly PersistedContextCheckpoint[];
  pending: readonly PendingContextCompaction[];
}> {
  const usageByAttempt = new Map<string, AgentEventPayloadMap['usage.recorded']>();
  for (const event of events) {
    if (
      event.type !== 'usage.recorded' || event.payload.purpose !== 'context-compaction' ||
      event.payload.attemptId === undefined
    ) continue;
    const key = contextUsageKey(event.runId, event.payload.attemptId);
    const existing = usageByAttempt.get(key);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(event.payload)) {
      throw new AgentJournalError(
        'PROJECTION_CORRUPT', 'Context compaction usage facts disagree for one attempt.',
      );
    }
    usageByAttempt.set(key, event.payload);
  }

  const checkpoints = new Map<string, PersistedContextCheckpoint>();
  const pendingByRun = new Map<string, PendingContextCompaction>();
  for (const event of events) {
    if (event.type === 'context.compaction_requested') {
      if (pendingByRun.has(event.runId)) {
        throw new AgentJournalError(
          'PROJECTION_CORRUPT', 'Run queued more than one manual Context request.',
        );
      }
      pendingByRun.set(event.runId, deepFreezeKernelValue({
        schemaVersion: 1,
        projectId: event.projectId,
        sessionId: event.sessionId,
        runId: event.runId,
        decisionId: event.payload.decisionId,
        requestedAt: event.occurredAt,
      }));
      continue;
    }
    if (event.type === 'context.compaction_started') {
      const pending = pendingByRun.get(event.runId);
      if (
        pending !== undefined &&
        (event.payload.reason !== 'manual' || pending.decisionId !== event.payload.decisionId)
      ) {
        throw new AgentJournalError(
          'PROJECTION_CORRUPT', 'Context start bypassed a pending manual request.',
        );
      }
      if (pending !== undefined) pendingByRun.delete(event.runId);
      if (checkpoints.has(event.payload.checkpointId)) {
        throw new AgentJournalError(
          'PROJECTION_CORRUPT', 'Context checkpoint was started more than once.',
        );
      }
      checkpoints.set(event.payload.checkpointId, freezeContextCheckpoint({
        schemaVersion: 1,
        checkpointId: event.payload.checkpointId,
        projectId: event.projectId,
        sessionId: event.sessionId,
        runId: event.runId,
        decisionId: event.payload.decisionId,
        reason: event.payload.reason,
        status: 'started',
        coveredSequence: event.payload.coveredSequence,
        createdAt: event.occurredAt,
        updatedAt: event.occurredAt,
      }));
      continue;
    }
    if (event.type !== 'context.compacted' && event.type !== 'context.compaction_failed') {
      continue;
    }
    const current = checkpoints.get(event.payload.checkpointId);
    if (
      current === undefined || current.status !== 'started' ||
      current.projectId !== event.projectId || current.sessionId !== event.sessionId ||
      current.runId !== event.runId || current.decisionId !== event.payload.decisionId
    ) {
      throw new AgentJournalError(
        'PROJECTION_CORRUPT', 'Context terminal fact does not match one active checkpoint.',
      );
    }
    if (event.type === 'context.compaction_failed') {
      checkpoints.set(current.checkpointId, freezeContextCheckpoint({
        ...current,
        status: 'failed',
        failureCode: event.payload.code,
        updatedAt: event.occurredAt,
      }));
      continue;
    }
    if (current.coveredSequence !== event.payload.coveredSequence) {
      throw new AgentJournalError(
        'PROJECTION_CORRUPT', 'Context completion covered sequence disagrees with its start.',
      );
    }
    const recordedUsage = usageByAttempt.get(contextUsageKey(event.runId, event.payload.attemptId));
    const reconstructedUsage = event.payload.usage ?? (recordedUsage === undefined
      ? undefined
      : {
          inputTokens: recordedUsage.inputTokens,
          outputTokens: recordedUsage.outputTokens,
          totalTokens: recordedUsage.totalTokens,
        });
    if (
      event.payload.usage !== undefined && recordedUsage !== undefined &&
      (
        event.payload.usage.inputTokens !== recordedUsage.inputTokens ||
        event.payload.usage.outputTokens !== recordedUsage.outputTokens ||
        event.payload.usage.totalTokens !== recordedUsage.totalTokens
      )
    ) {
      throw new AgentJournalError(
        'PROJECTION_CORRUPT', 'Context checkpoint and usage facts disagree.',
      );
    }
    checkpoints.set(current.checkpointId, freezeContextCheckpoint({
      ...current,
      status: 'compacted',
      summaryRef: event.payload.summaryRef,
      summary: event.payload.summary,
      attemptId: event.payload.attemptId,
      ...(reconstructedUsage === undefined ? {} : { usage: reconstructedUsage }),
      updatedAt: event.occurredAt,
    }));
  }
  return deepFreezeKernelValue({
    checkpoints: [...checkpoints.values()],
    pending: [...pendingByRun.values()],
  });
}

function contextUsageKey(runId: string, attemptId: string): string {
  return `${runId}\0${attemptId}`;
}

function usageIdentity(
  runId: string,
  attemptId: string,
  purpose: 'agent-turn' | 'context-compaction' | 'tool',
): string {
  return `usage_${createHash('sha256')
    .update(`${runId}\0${attemptId}\0${purpose}`)
    .digest('hex')}`;
}

function normalizeUsagePayload(value: PortableValue): AgentEventPayloadMap['usage.recorded'] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentJournalError('PROJECTION_CORRUPT', 'Stored usage payload is not an object.');
  }
  const record = value as Record<string, unknown>;
  const withBillingMode = {
    ...record,
    billingMode: record.billingMode ?? 'byok',
  };
  try {
    return validateAndSnapshotEventPayload('usage.recorded', withBillingMode);
  } catch (error) {
    throw new AgentJournalError(
      'PROJECTION_CORRUPT',
      `Stored usage payload is invalid: ${errorMessage(error)}`,
    );
  }
}

function requireUsageBillingMode(value: unknown, name: string): UsageMode {
  if (value === 'byok' || value === 'managed') return value;
  throw new AgentJournalError('PROJECTION_CORRUPT', `${name} must be byok or managed.`);
}

function requireIsoTimestamp(value: unknown, name: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new AgentJournalError('PROJECTION_CORRUPT', `${name} must be an ISO timestamp.`);
  }
  return value;
}

function requireUsageAggregate(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new AgentJournalError('PROJECTION_CORRUPT', `Project usage ${name} is invalid or unsafe.`);
  }
  return value;
}

function persistUsageEvents(database: NodeDatabaseSync, events: readonly AgentEvent[]): void {
  for (const event of events) {
    if (event.type !== 'usage.recorded') continue;
    const existing = database.prepare(
      'SELECT payload_json FROM agent_usage WHERE usage_id = ?',
    ).get(event.payload.usageId) as { payload_json: string } | undefined;
    const payloadJson = JSON.stringify(event.payload);
    if (existing !== undefined) {
      if (canonicalJson(normalizeUsagePayload(parsePortableJson(existing.payload_json))) !==
        canonicalJson(event.payload)) {
        throw new AgentJournalError(
          'IDEMPOTENCY_CONFLICT', 'Usage identity was already recorded with different values.',
        );
      }
      continue;
    }
    database.prepare(
      `INSERT INTO agent_usage (
        usage_id, project_id, session_id, run_id, turn_id, attempt_id,
        invocation_id, purpose, billing_mode, input_tokens, output_tokens, total_tokens,
        payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.payload.usageId,
      event.projectId,
      event.sessionId,
      event.runId,
      event.payload.turnId ?? event.turnId ?? null,
      event.payload.attemptId ?? event.attemptId ?? null,
      event.payload.invocationId ?? event.invocationId ?? null,
      event.payload.purpose,
      event.payload.billingMode,
      event.payload.inputTokens,
      event.payload.outputTokens,
      event.payload.totalTokens,
      payloadJson,
      event.occurredAt,
    );
  }
}

type RuntimeCommandDomainFact = Readonly<{
  type:
    | 'plan.created'
    | 'plan.updated'
    | 'tool.activated'
    | 'capability.discovered'
    | 'skill.activated'
    | 'subagent.started'
    | 'subagent.steered'
    | 'subagent.cancelled';
  payload: PortableValue;
}>;

type RuntimeCommandProjectionReplay = Readonly<{
  projection: RuntimeCommandProjection;
  updatedAt: string;
}>;

function createRuntimeCommandProjection(
  invocation: AgentInvocationProjection,
): RuntimeCommandProjection {
  return deepFreezeKernelValue({
    schemaVersion: 2,
    projectId: invocation.projectId,
    sessionId: invocation.sessionId,
    runId: invocation.runId,
    revision: 0,
    plan: null,
    activeTools: [],
    discoveredCapabilities: [],
    activationBindings: [],
    activeSkills: [],
    children: [],
  });
}

function assertRuntimeCommandFence(
  database: NodeDatabaseSync,
  invocation: AgentInvocationProjection,
  command: RuntimeCommand,
  nowMs: number,
): void {
  const lease = database.prepare(
    `SELECT owner_id, expires_at_ms, fencing_token FROM agent_run_leases
     WHERE project_id = ? AND run_id = ?`,
  ).get(invocation.projectId, invocation.runId) as LeaseRow | undefined;
  if (
    invocation.started?.fencingToken !== command.fencingToken ||
    lease === undefined || lease.fencing_token !== command.fencingToken ||
    lease.expires_at_ms <= nowMs
  ) {
    throw new AgentJournalError(
      'FENCING_TOKEN_STALE',
      'Runtime Command does not hold the exact active Invocation fence.',
    );
  }
}

function resolveRuntimeCommandRunRevision(
  database: NodeDatabaseSync,
  invocation: AgentInvocationProjection,
  command: RuntimeCommand,
): number {
  const current = readKernelRunProjection(database, invocation.runId);
  if (current.state !== 'ExecutingTools') {
    throw new AgentJournalError(
      'COMMAND_CONFLICT',
      `Runtime Commands cannot apply while the Run is ${current.state}.`,
    );
  }
  const window = database.prepare(
    `SELECT project_id, session_id, turn_id, base_revision, current_revision
     FROM agent_tool_run_windows WHERE run_id = ?`,
  ).get(invocation.runId) as Readonly<{
    project_id: string;
    session_id: string;
    turn_id: string;
    base_revision: number;
    current_revision: number;
  }> | undefined;
  if (
    window === undefined || window.project_id !== invocation.projectId ||
    window.session_id !== invocation.sessionId || window.turn_id !== invocation.turnId ||
    (current.currentTurnId !== null && current.currentTurnId !== invocation.turnId)
  ) {
    throw new AgentJournalError(
      'COMMAND_CONFLICT',
      'Runtime Command does not belong to the active durable Tool window.',
    );
  }
  if (current.revision !== Number(window.current_revision)) {
    throw new AgentJournalError(
      'COMMAND_CONFLICT',
      'Runtime Command Tool window was superseded by another Run transition.',
    );
  }
  const startedRunRevision = invocation.started?.runRevision;
  const baseRevision = Number(window.base_revision);
  if (
    startedRunRevision === undefined || startedRunRevision < 1 ||
    command.expectedRunRevision < baseRevision ||
    command.expectedRunRevision < startedRunRevision ||
    command.expectedRunRevision > current.revision
  ) {
    throw new AgentJournalError(
      'REVISION_CONFLICT',
      'Runtime Command Run revision is outside its originating Invocation window.',
    );
  }
  return current.revision;
}

function applyRuntimeCommandProjection(
  current: RuntimeCommandProjection,
  command: RuntimeCommand,
): Readonly<{ projection: RuntimeCommandProjection; effect: PortableValue }> {
  let effect: PortableValue;
  switch (command.kind) {
    case 'plan.create':
      if (current.plan !== null) {
        throw new AgentJournalError('COMMAND_CONFLICT', 'A Runtime task plan already exists.');
      }
      effect = {
        planId: command.payload.planId,
        revision: 1,
        plan: structuredClone(command.payload.plan),
      };
      break;
    case 'plan.update':
      if (current.plan === null || current.plan.planId !== command.payload.planId) {
        throw new AgentJournalError('COMMAND_CONFLICT', 'Runtime task plan identity does not match.');
      }
      if (current.plan.revision !== command.payload.expectedPlanRevision) {
        throw new AgentJournalError('REVISION_CONFLICT', 'Runtime task plan revision changed.');
      }
      effect = {
        planId: command.payload.planId,
        revision: current.plan.revision + 1,
        plan: structuredClone(command.payload.plan),
      };
      break;
    case 'discovery.activate':
      effect = {
        tools: orderedUniqueToolActivations(command.payload.tools),
        targets: orderedUniqueCapabilityTargets(command.payload.targets),
        bindings: orderedUniqueCapabilityBindings(command.payload.bindings),
      };
      break;
    case 'skill.activate':
      effect = { activations: orderedUniqueSkillActivations(command.payload.activations) };
      break;
    case 'child.start':
      {
      const identity = deriveChildAgentIdentity({
        projectId: current.projectId,
        parentRunId: command.origin.runId,
        parentTurnId: command.origin.turnId,
        parentInvocationId: command.origin.invocationId,
        commandId: command.commandId,
      });
      effect = {
        childRunId: identity.childRunId,
        childSessionId: identity.childSessionId,
        parentRunId: command.origin.runId,
        parentInvocationId: command.origin.invocationId,
        startCommandId: command.commandId,
        revision: 1,
        task: command.payload.task,
        context: structuredClone(command.payload.context),
        status: 'running',
      };
      break;
      }
    case 'child.list':
      effect = { children: current.children.map((child) => ({
        childRunId: child.childRunId,
        childSessionId: child.childSessionId,
        revision: child.revision,
        status: child.status,
      })) };
      break;
    case 'child.wait': {
      const child = current.children.find((candidate) => candidate.childRunId === command.payload.childRunId);
      if (child === undefined) throw new AgentJournalError('COMMAND_CONFLICT', 'Child Run was not found.');
      if (child.revision !== command.payload.expectedChildRevision) {
        throw new AgentJournalError('REVISION_CONFLICT', 'Runtime child revision changed before wait.');
      }
      effect = { childRunId: child.childRunId, revision: child.revision, status: child.status };
      break;
    }
    case 'child.steer': {
      const child = current.children.find(
        (candidate) => candidate.childRunId === command.payload.childRunId,
      );
      if (child === undefined || child.status !== 'running') {
        throw new AgentJournalError(
          'COMMAND_CONFLICT', 'Only a running child can receive steering input.',
        );
      }
      if (child.revision !== command.payload.expectedChildRevision) {
        throw new AgentJournalError(
          'REVISION_CONFLICT', 'Runtime child revision changed before steering.',
        );
      }
      effect = {
        childRunId: command.payload.childRunId,
        revision: child.revision + 1,
        input: structuredClone(command.payload.input),
      };
      break;
    }
    case 'child.cancel': {
      const child = current.children.find(
        (candidate) => candidate.childRunId === command.payload.childRunId,
      );
      if (child === undefined || child.status !== 'running') {
        throw new AgentJournalError(
          'COMMAND_CONFLICT', 'Only a running child can be cancelled.',
        );
      }
      if (child.revision !== command.payload.expectedChildRevision) {
        throw new AgentJournalError(
          'REVISION_CONFLICT', 'Runtime child revision changed before cancellation.',
        );
      }
      effect = {
        childRunId: command.payload.childRunId,
        revision: child.revision + 1,
        reason: command.payload.reason ?? 'Cancelled by the parent Runtime.',
      };
      break;
    }
    default:
      return assertNeverRuntimeCommand(command);
  }
  return {
    effect,
    projection: applyRuntimeCommandEffect(
      current, command.kind, effect, current.revision + 1,
    ),
  };
}

function applyRuntimeCommandEffect(
  current: RuntimeCommandProjection,
  kind: RuntimeCommand['kind'],
  effect: PortableValue,
  revision: number,
): RuntimeCommandProjection {
  if (revision !== current.revision + 1) {
    throw new AgentJournalError(
      'REVISION_CONFLICT', 'Runtime Command projection revision is not monotonic.',
    );
  }
  const value = runtimeCommandEffectRecord(effect);
  let next: RuntimeCommandProjection;
  switch (kind) {
    case 'plan.create':
    case 'plan.update':
      next = {
        ...current,
        revision,
        plan: {
          planId: requireRuntimeEffectText(value.planId, 'planId'),
          revision: requireRuntimeEffectRevision(value.revision, 'plan revision'),
          plan: cloneRuntimeEffectValue(value.plan, 'plan'),
        },
      };
      break;
    case 'discovery.activate':
      next = {
        ...current,
        revision,
        activeTools: orderedUniqueToolActivations([
          ...current.activeTools,
          ...requireRuntimeToolActivations(value.tools),
        ]),
        discoveredCapabilities: orderedUniqueCapabilityTargets([
          ...current.discoveredCapabilities,
          ...requireRuntimeCapabilityTargets(value.targets),
        ]),
        activationBindings: orderedUniqueCapabilityBindings([
          ...current.activationBindings,
          ...requireRuntimeCapabilityBindings(value.bindings),
        ]),
      };
      break;
    case 'skill.activate':
      next = {
        ...current,
        revision,
        activeSkills: orderedUniqueSkillActivations([
          ...current.activeSkills,
          ...requireRuntimeSkillActivations(value.activations),
        ]),
      };
      break;
    case 'child.start': {
      const childRunId = requireRuntimeEffectText(value.childRunId, 'childRunId');
      const childRevision = requireRuntimeEffectRevision(value.revision, 'child revision');
      if (childRevision !== 1) {
        throw new AgentJournalError(
          'PROJECTION_CORRUPT', 'A Runtime child must begin at revision one.',
        );
      }
      if (current.children.some((child) => child.childRunId === childRunId)) {
        throw new AgentJournalError('COMMAND_CONFLICT', 'Child Run identity already exists.');
      }
      next = {
        ...current,
        revision,
        children: [...current.children, {
          childRunId,
          childSessionId: requireRuntimeEffectText(value.childSessionId, 'childSessionId'),
          parentRunId: requireRuntimeEffectText(value.parentRunId, 'parentRunId'),
          parentInvocationId: requireRuntimeEffectText(
            value.parentInvocationId,
            'parentInvocationId',
          ),
          startCommandId: requireRuntimeEffectText(value.startCommandId, 'child start commandId'),
          revision: childRevision,
          status: 'running',
          task: requireRuntimeEffectText(value.task, 'child task'),
          context: cloneRuntimeEffectValue(value.context, 'child context'),
        }],
      };
      break;
    }
    case 'child.list':
    case 'child.wait':
      next = { ...current, revision };
      break;
    case 'child.steer': {
      const childRunId = requireRuntimeEffectText(value.childRunId, 'childRunId');
      const index = current.children.findIndex((child) => child.childRunId === childRunId);
      if (index < 0 || current.children[index]?.status !== 'running') {
        throw new AgentJournalError('COMMAND_CONFLICT', 'Child steering projection conflicts.');
      }
      const currentChild = current.children[index];
      const storedRevision = requireRuntimeEffectNonNegativeRevision(
        value.revision,
        'child revision',
      );
      const childRevision = storedRevision === 0
        ? currentChild.revision + 1
        : storedRevision;
      if (childRevision !== currentChild.revision + 1) {
        throw new AgentJournalError(
          'PROJECTION_CORRUPT', 'Runtime child steering revision is not monotonic.',
        );
      }
      const children = current.children.map((child, childIndex) => childIndex === index
        ? {
            ...child,
            revision: childRevision,
            lastInput: cloneRuntimeEffectValue(value.input, 'child input'),
          }
        : child);
      next = { ...current, revision, children };
      break;
    }
    case 'child.cancel': {
      const childRunId = requireRuntimeEffectText(value.childRunId, 'childRunId');
      const index = current.children.findIndex((child) => child.childRunId === childRunId);
      if (index < 0 || current.children[index]?.status !== 'running') {
        throw new AgentJournalError('COMMAND_CONFLICT', 'Child cancellation projection conflicts.');
      }
      const currentChild = current.children[index];
      const storedRevision = requireRuntimeEffectNonNegativeRevision(
        value.revision,
        'child revision',
      );
      const childRevision = storedRevision === 0
        ? currentChild.revision + 1
        : storedRevision;
      if (childRevision !== currentChild.revision + 1) {
        throw new AgentJournalError(
          'PROJECTION_CORRUPT', 'Runtime child cancellation revision is not monotonic.',
        );
      }
      const reason = requireRuntimeEffectText(value.reason, 'child cancellation reason');
      const children = current.children.map((child, childIndex) => childIndex === index
        ? { ...child, revision: childRevision, status: 'cancelled' as const, reason }
        : child);
      next = { ...current, revision, children };
      break;
    }
    default:
      return assertNeverRuntimeCommandKind(kind);
  }
  return deepFreezeKernelValue(structuredClone(next));
}

function runtimeCommandDomainFacts(
  command: RuntimeCommand,
  effect: PortableValue,
): readonly RuntimeCommandDomainFact[] {
  const value = runtimeCommandEffectRecord(effect);
  switch (command.kind) {
    case 'plan.create':
      return [{ type: 'plan.created', payload: effect }];
    case 'plan.update':
      return [{ type: 'plan.updated', payload: effect }];
    case 'discovery.activate': {
      const tools = requireRuntimeToolActivations(value.tools);
      const targets = requireRuntimeCapabilityTargets(value.targets);
      requireRuntimeCapabilityBindings(value.bindings);
      return [
        ...(tools.length === 0
          ? []
          : [{ type: 'tool.activated' as const, payload: { tools } }]),
        ...(targets.length === 0
          ? []
          : [{ type: 'capability.discovered' as const, payload: { targets } }]),
      ];
    }
    case 'skill.activate':
      return requireRuntimeSkillActivations(value.activations).map((activation) => ({
        type: 'skill.activated' as const,
        payload: { skillId: activation.id, revision: activation.revision.revisionId },
      }));
    case 'child.start':
      return [{
        type: 'subagent.started',
        payload: {
          subagentId: requireRuntimeEffectText(value.childRunId, 'childRunId'),
          summary: requireRuntimeEffectText(value.task, 'child task'),
        },
      }];
    case 'child.list':
    case 'child.wait':
      return [];
    case 'child.steer':
      return [{
        type: 'subagent.steered',
        payload: {
          subagentId: requireRuntimeEffectText(value.childRunId, 'childRunId'),
          summary: 'Child Runtime input updated.',
        },
      }];
    case 'child.cancel':
      // The command records cancellation intent in runtime.command_applied.
      // subagent.cancelled is committed only after the child Run is terminal.
      return [];
    default:
      return assertNeverRuntimeCommand(command);
  }
}

function orderedUniqueToolActivations(
  values: readonly RuntimeToolActivation[],
): RuntimeToolActivation[] {
  const byName = new Map<string, RuntimeToolActivation>();
  for (const value of values) {
    const activation = normalizeRuntimeToolActivation(value);
    byName.set(activation.name, activation);
  }
  return [...byName.values()];
}

function requireRuntimeToolActivations(
  value: PortableValue | undefined,
): RuntimeToolActivation[] {
  if (!Array.isArray(value) || value.length > RUNTIME_COMMAND_MAX_ACTIVE_TOOLS) {
    throw new AgentJournalError('PROJECTION_CORRUPT', 'Tool activations are invalid.');
  }
  const names = new Set<string>();
  return value.map((entry) => {
    const activation = normalizeRuntimeToolActivation(runtimeCommandEffectRecord(entry));
    if (names.has(activation.name)) {
      throw new AgentJournalError('PROJECTION_CORRUPT', 'Tool activations contain duplicate names.');
    }
    names.add(activation.name);
    return activation;
  });
}

function normalizeRuntimeToolActivation(
  value: Readonly<Record<string, PortableValue>> | RuntimeToolActivation,
): RuntimeToolActivation {
  const record = value as Readonly<Record<string, PortableValue>>;
  if (
    Object.keys(record).length !== 3 ||
    !Object.hasOwn(record, 'name') ||
    !Object.hasOwn(record, 'toolRevision') ||
    !Object.hasOwn(record, 'handlerRevision')
  ) {
    throw new AgentJournalError('PROJECTION_CORRUPT', 'Tool activation shape is invalid.');
  }
  return {
    name: requireRuntimeEffectText(record.name, 'Tool activation name'),
    toolRevision: requireRuntimeEffectText(record.toolRevision, 'Tool schema revision'),
    handlerRevision: requireRuntimeEffectText(record.handlerRevision, 'Tool handler revision'),
  };
}

function orderedUniqueCapabilityTargets(
  values: readonly Readonly<{ moduleId: string; instanceId: string }>[],
): Array<{ moduleId: string; instanceId: string }> {
  const identities = new Set<string>();
  const targets: Array<{ moduleId: string; instanceId: string }> = [];
  for (const value of values) {
    const moduleId = requireRuntimeEffectText(value.moduleId, 'Capability module id');
    const instanceId = requireRuntimeEffectText(value.instanceId, 'Capability instance id');
    const identity = `${moduleId}\0${instanceId}`;
    if (identities.has(identity)) continue;
    identities.add(identity);
    targets.push({ moduleId, instanceId });
  }
  return targets;
}

function orderedUniqueCapabilityBindings(
  values: readonly RuntimeCapabilityActivationBinding[],
): RuntimeCapabilityActivationBinding[] {
  const byTarget = new Map<string, RuntimeCapabilityActivationBinding>();
  for (const value of values) {
    const [binding] = requireRuntimeCapabilityBindings([value] as PortableValue);
    const identity = `${binding!.target.moduleId}\0${binding!.target.instanceId}`;
    byTarget.set(identity, binding!);
  }
  return [...byTarget.values()];
}

function requireRuntimeCapabilityBindings(
  value: PortableValue | undefined,
): RuntimeCapabilityActivationBinding[] {
  if (!Array.isArray(value) || value.length > 256) {
    throw new AgentJournalError('PROJECTION_CORRUPT', 'Capability activation bindings are invalid.');
  }
  const targets = new Set<string>();
  return value.map((entry) => {
    const record = runtimeCommandEffectRecord(entry);
    if (Object.keys(record).length !== 2 || !Object.hasOwn(record, 'target') || !Object.hasOwn(record, 'binding')) {
      throw new AgentJournalError('PROJECTION_CORRUPT', 'Capability activation binding shape is invalid.');
    }
    const [target] = requireRuntimeCapabilityTargets([record.target] as PortableValue);
    const identity = `${target!.moduleId}\0${target!.instanceId}`;
    if (targets.has(identity)) {
      throw new AgentJournalError('PROJECTION_CORRUPT', 'Capability activation bindings repeat a target.');
    }
    targets.add(identity);
    const binding = runtimeCommandEffectRecord(record.binding!);
    if (
      Object.keys(binding).length !== 4 ||
      !Object.hasOwn(binding, 'providerId') ||
      !Object.hasOwn(binding, 'candidateId') ||
      !Object.hasOwn(binding, 'fingerprint') ||
      !Object.hasOwn(binding, 'capabilityGeneration')
    ) {
      throw new AgentJournalError('PROJECTION_CORRUPT', 'Capability activation binding value is invalid.');
    }
    return {
      target: target!,
      binding: {
        providerId: requireRuntimeEffectText(binding.providerId, 'binding provider id'),
        candidateId: requireRuntimeEffectText(binding.candidateId, 'binding candidate id'),
        fingerprint: requireRuntimeEffectText(binding.fingerprint, 'binding fingerprint'),
        capabilityGeneration: requireRuntimeEffectText(
          binding.capabilityGeneration,
          'binding capability generation',
        ),
      },
    };
  });
}

function orderedUniqueSkillActivations(
  values: readonly RuntimeSkillActivation[],
): RuntimeSkillActivation[] {
  const ids = new Set<string>();
  return values.flatMap((value) => {
    if (ids.has(value.id)) return [];
    ids.add(value.id);
    return [structuredClone(value)];
  });
}

function requireRuntimeSkillActivations(value: PortableValue | undefined): RuntimeSkillActivation[] {
  if (!Array.isArray(value) || value.length > RUNTIME_COMMAND_MAX_ACTIVE_SKILLS) {
    throw new AgentJournalError('PROJECTION_CORRUPT', 'Skill activations are invalid.');
  }
  return value.map((entry) => {
    const activation = runtimeCommandEffectRecord(entry);
    if (!Object.hasOwn(activation, 'id') || !Object.hasOwn(activation, 'revision')) {
      throw new AgentJournalError('PROJECTION_CORRUPT', 'Skill activation shape is invalid.');
    }
    const revision = runtimeCommandEffectRecord(activation.revision!);
    const required = [
      'schemaVersion', 'revisionId', 'scope', 'sourceId', 'sourcePath', 'bundleRoot',
      'sourceOrder', 'name', 'contentDigest', 'bundleDigest',
    ];
    if (Object.keys(activation).some((key) => key !== 'id' && key !== 'revision' && key !== 'allowedTools') ||
        required.some((key) => !Object.hasOwn(revision, key)) || Object.keys(revision).length !== required.length ||
        revision.schemaVersion !== 1 || typeof revision.scope !== 'string' ||
        !['system', 'user', 'project', 'session'].includes(revision.scope) ||
        !Number.isSafeInteger(revision.sourceOrder) || Number(revision.sourceOrder) < 0) {
      throw new AgentJournalError('PROJECTION_CORRUPT', 'Skill activation revision is invalid.');
    }
    const text = (item: PortableValue | undefined, label: string) =>
      requireRuntimeEffectText(item, `Skill ${label}`);
    const allowed = activation.allowedTools === undefined
      ? undefined
      : requireRuntimeEffectTexts(activation.allowedTools, 'Skill allowed Tools');
    return {
      id: text(activation.id, 'id'),
      revision: {
        schemaVersion: 1,
        revisionId: text(revision.revisionId, 'revisionId'),
        scope: revision.scope as RuntimeSkillActivation['revision']['scope'],
        sourceId: text(revision.sourceId, 'sourceId'),
        sourcePath: text(revision.sourcePath, 'sourcePath'),
        bundleRoot: text(revision.bundleRoot, 'bundleRoot'),
        sourceOrder: Number(revision.sourceOrder),
        name: text(revision.name, 'name'),
        contentDigest: text(revision.contentDigest, 'contentDigest'),
        bundleDigest: text(revision.bundleDigest, 'bundleDigest'),
      },
      ...(allowed === undefined ? {} : { allowedTools: allowed }),
    };
  });
}

function requireRuntimeCapabilityTargets(
  value: PortableValue | undefined,
): Array<{ moduleId: string; instanceId: string }> {
  if (!Array.isArray(value) || value.length > 256) {
    throw new AgentJournalError('PROJECTION_CORRUPT', 'Capability discovery targets are invalid.');
  }
  return value.map((target) => {
    const record = runtimeCommandEffectRecord(target);
    const keys = Object.keys(record);
    if (keys.length !== 2 || !Object.hasOwn(record, 'moduleId') || !Object.hasOwn(record, 'instanceId')) {
      throw new AgentJournalError('PROJECTION_CORRUPT', 'Capability discovery target shape is invalid.');
    }
    return {
      moduleId: requireRuntimeEffectText(record.moduleId, 'Capability module id'),
      instanceId: requireRuntimeEffectText(record.instanceId, 'Capability instance id'),
    };
  });
}

function runtimeCommandEffectRecord(value: PortableValue): Record<string, PortableValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentJournalError('PROJECTION_CORRUPT', 'Runtime Command effect is not an object.');
  }
  return value;
}

function requireRuntimeEffectText(value: PortableValue | undefined, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AgentJournalError('PROJECTION_CORRUPT', `Runtime Command ${label} is invalid.`);
  }
  return value;
}

function requireRuntimeEffectTexts(value: PortableValue | undefined, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.length > 0)) {
    throw new AgentJournalError('PROJECTION_CORRUPT', `Runtime Command ${label} are invalid.`);
  }
  return value.map((item) => item as string);
}

function requireRuntimeEffectRevision(value: PortableValue | undefined, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new AgentJournalError('PROJECTION_CORRUPT', `Runtime Command ${label} is invalid.`);
  }
  return Number(value);
}

function requireRuntimeEffectNonNegativeRevision(
  value: PortableValue | undefined,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new AgentJournalError('PROJECTION_CORRUPT', `Runtime Command ${label} is invalid.`);
  }
  return Number(value);
}

function cloneRuntimeEffectValue(
  value: PortableValue | undefined,
  label: string,
): PortableValue {
  if (value === undefined) {
    throw new AgentJournalError('PROJECTION_CORRUPT', `Runtime Command ${label} is missing.`);
  }
  return structuredClone(value);
}

function persistRuntimeCommandProjection(
  database: NodeDatabaseSync,
  projection: RuntimeCommandProjection,
  updatedAt: string,
  rebuilding = false,
): void {
  assertRuntimeCommandProjection(projection);
  const current = database.prepare(
    'SELECT revision FROM agent_runtime_command_projections WHERE run_id = ?',
  ).get(projection.runId) as { revision: number } | undefined;
  if (current === undefined) {
    if (!rebuilding && projection.revision !== 1) {
      throw new AgentJournalError(
        'PROJECTION_CORRUPT', 'Runtime Command projection did not begin at revision one.',
      );
    }
    database.prepare(
      `INSERT INTO agent_runtime_command_projections (
        run_id, project_id, session_id, revision, payload_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      projection.runId,
      projection.projectId,
      projection.sessionId,
      projection.revision,
      JSON.stringify(projection),
      updatedAt,
    );
    return;
  }
  const changed = database.prepare(
    `UPDATE agent_runtime_command_projections
     SET revision = ?, payload_json = ?, updated_at = ?
     WHERE run_id = ? AND project_id = ? AND session_id = ? AND revision = ?`,
  ).run(
    projection.revision,
    JSON.stringify(projection),
    updatedAt,
    projection.runId,
    projection.projectId,
    projection.sessionId,
    projection.revision - 1,
  );
  if (Number(changed.changes) !== 1) {
    throw new AgentJournalError(
      'REVISION_CONFLICT', 'Runtime Command projection revision changed.',
    );
  }
}

function readRuntimeCommandProjection(
  database: NodeDatabaseSync,
  scope: GetRuntimeCommandProjectionInput,
): RuntimeCommandProjection | null {
  const row = database.prepare(
    `SELECT project_id, session_id, run_id, revision, payload_json
     FROM agent_runtime_command_projections WHERE run_id = ?`,
  ).get(scope.runId) as Readonly<{
    project_id: string;
    session_id: string;
    run_id: string;
    revision: number;
    payload_json: string;
  }> | undefined;
  if (row === undefined) return null;
  if (
    row.project_id !== scope.projectId || row.session_id !== scope.sessionId ||
    row.run_id !== scope.runId
  ) {
    throw new AgentJournalError(
      'RUN_IDENTITY_CONFLICT', 'Runtime Command projection belongs to another scope.',
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(row.payload_json) as unknown;
  } catch (error) {
    throw new AgentJournalError(
      'PROJECTION_CORRUPT',
      'Runtime Command projection JSON is invalid.',
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  if (
    raw !== null && typeof raw === 'object' && !Array.isArray(raw) &&
    (raw as Record<string, unknown>).schemaVersion === 1
  ) {
    const rows = database.prepare(
      `SELECT * FROM agent_events
       WHERE project_id = ? AND session_id = ? AND run_id = ?
         AND event_type = 'runtime.command_applied'
       ORDER BY sequence ASC`,
    ).all(scope.projectId, scope.sessionId, scope.runId) as unknown as EventRow[];
    const replay = replayRuntimeCommandFacts(rows.map((eventRow) => eventFromRow(eventRow)))
      .get(scope.runId)?.projection;
    if (replay === undefined || replay.revision !== Number(row.revision)) {
      throw new AgentJournalError(
        'PROJECTION_CORRUPT',
        'Legacy Runtime Command projection cannot be upcast from immutable facts.',
      );
    }
    return replay;
  }
  return parseProjectionJson(
    row.payload_json,
    'Runtime Command projection',
    (value): asserts value is RuntimeCommandProjection => {
      assertRuntimeCommandProjection(value);
      if (
        value.projectId !== row.project_id || value.sessionId !== row.session_id ||
        value.runId !== row.run_id || value.revision !== Number(row.revision)
      ) {
        throw new TypeError('Runtime Command projection columns disagree with its payload.');
      }
    },
  );
}

function assertRuntimeCommandProjection(
  value: unknown,
): asserts value is RuntimeCommandProjection {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Runtime Command projection must be an object.');
  }
  const projection = value as Record<string, unknown>;
  const keys = [
    'schemaVersion', 'projectId', 'sessionId', 'runId', 'revision', 'plan',
    'activeTools', 'discoveredCapabilities', 'activationBindings', 'activeSkills', 'children',
  ];
  if (
    Object.keys(projection).some((key) => !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(projection, key)) ||
    projection.schemaVersion !== 2
  ) {
    throw new TypeError('Runtime Command projection shape is invalid.');
  }
  ['projectId', 'sessionId', 'runId'].forEach((key) => projectionText(
    projection[key], `Runtime Command projection ${key}`,
  ));
  projectionPositiveInteger(projection.revision, 'Runtime Command projection revision');
  const activeTools = requireRuntimeToolActivations(projection.activeTools as PortableValue);
  const discoveredCapabilities = requireRuntimeCapabilityTargets(
    projection.discoveredCapabilities as PortableValue,
  );
  const activationBindings = requireRuntimeCapabilityBindings(
    projection.activationBindings as PortableValue,
  );
  const activeSkills = requireRuntimeSkillActivations(projection.activeSkills as PortableValue);
  requireUniqueProjectionValues(activeTools.map(({ name }) => name), 'activeTools');
  if (orderedUniqueCapabilityTargets(discoveredCapabilities).length !== discoveredCapabilities.length) {
    throw new TypeError('Runtime Command projection discoveredCapabilities contains duplicates.');
  }
  if (activationBindings.some(({ target }) => !discoveredCapabilities.some((candidate) =>
    candidate.moduleId === target.moduleId && candidate.instanceId === target.instanceId))) {
    throw new TypeError('Runtime Command activation binding target is not discovered.');
  }
  requireUniqueProjectionValues(activeSkills.map(({ id }) => id), 'activeSkills');
  if (projection.plan !== null) {
    const plan = runtimeProjectionRecord(projection.plan, 'plan');
    runtimeProjectionExactKeys(plan, ['planId', 'revision', 'plan'], 'plan');
    projectionText(plan.planId, 'Runtime Command projection planId');
    projectionPositiveInteger(plan.revision, 'Runtime Command projection plan revision');
    if (Number(plan.revision) > Number(projection.revision)) {
      throw new TypeError('Runtime Command plan revision exceeds the projection revision.');
    }
    if (!Object.hasOwn(plan, 'plan')) {
      throw new TypeError('Runtime Command projection plan value is missing.');
    }
  }
  if (
    !Array.isArray(projection.children) ||
    projection.children.length > RUNTIME_COMMAND_MAX_CHILDREN
  ) {
    throw new TypeError('Runtime Command projection children must be an array.');
  }
  const childIds = new Set<string>();
  for (const [index, childValue] of projection.children.entries()) {
    const child = runtimeProjectionRecord(childValue, `children[${index}]`);
    runtimeProjectionExactKeys(
      child,
      [
        'childRunId', 'childSessionId', 'parentRunId', 'parentInvocationId',
        'startCommandId', 'revision', 'status', 'task', 'context', 'lastInput', 'reason',
      ],
      `children[${index}]`,
      ['startCommandId', 'lastInput', 'reason'],
    );
    projectionText(child.childRunId, `Runtime Command projection children[${index}].childRunId`);
    projectionText(
      child.childSessionId,
      `Runtime Command projection children[${index}].childSessionId`,
    );
    projectionText(child.parentRunId, `Runtime Command projection children[${index}].parentRunId`);
    projectionText(
      child.parentInvocationId,
      `Runtime Command projection children[${index}].parentInvocationId`,
    );
    if (child.startCommandId !== undefined) {
      projectionText(child.startCommandId, `Runtime Command projection children[${index}].startCommandId`);
    }
    projectionPositiveInteger(
      child.revision,
      `Runtime Command projection children[${index}].revision`,
    );
    projectionText(child.task, `Runtime Command projection children[${index}].task`);
    if (childIds.has(child.childRunId as string)) {
      throw new TypeError('Runtime Command projection contains a duplicate childRunId.');
    }
    childIds.add(child.childRunId as string);
    if (typeof child.status !== 'string' || ![
      'running', 'completed', 'failed', 'cancelled', 'limit_reached', 'interrupted',
    ].includes(child.status)) {
      throw new TypeError('Runtime Command child status is invalid.');
    }
    if (!Object.hasOwn(child, 'context')) {
      throw new TypeError('Runtime Command child context is missing.');
    }
    if (child.reason !== undefined) {
      projectionText(child.reason, `Runtime Command projection children[${index}].reason`);
    }
    if (child.status === 'cancelled' && child.reason === undefined) {
      throw new TypeError('A cancelled Runtime Command child requires a reason.');
    }
  }
  assertPortableValue(value);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > RUNTIME_COMMAND_PROJECTION_MAX_BYTES) {
    throw new TypeError(
      `Runtime Command projection exceeds ${RUNTIME_COMMAND_PROJECTION_MAX_BYTES} bytes.`,
    );
  }
}

function assertRuntimeCommandProjectionAdmission(
  value: RuntimeCommandProjection,
): void {
  try {
    assertRuntimeCommandProjection(value);
  } catch (error) {
    throw new AgentJournalError(
      'INVALID_ARGUMENT',
      'Runtime Command would exceed the bounded cumulative projection contract.',
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
}

function requireUniqueProjectionValues(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new TypeError(`Runtime Command projection ${label} contains duplicate values.`);
  }
}

function runtimeProjectionRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Runtime Command projection ${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function runtimeProjectionExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  optional: readonly string[] = [],
): void {
  const required = allowed.filter((key) => !optional.includes(key));
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new TypeError(`Runtime Command projection ${label} shape is invalid.`);
  }
}

function replayRuntimeCommandFacts(
  events: readonly AgentEvent[],
): Map<string, RuntimeCommandProjectionReplay> {
  const projections = new Map<string, RuntimeCommandProjectionReplay>();
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    if (event.type !== 'runtime.command_applied') continue;
    if (
      event.payload.origin.runId !== event.runId ||
      event.payload.origin.turnId !== event.turnId ||
      event.payload.origin.invocationId !== event.invocationId
    ) {
      throw new AgentJournalError(
        'PROJECTION_CORRUPT', 'Runtime Command fact origin disagrees with event identity.',
      );
    }
    const current = projections.get(event.runId)?.projection ?? deepFreezeKernelValue({
      schemaVersion: 2 as const,
      projectId: event.projectId,
      sessionId: event.sessionId,
      runId: event.runId,
      revision: 0,
      plan: null,
      activeTools: [],
      discoveredCapabilities: [],
      activationBindings: [],
      activeSkills: [],
      children: [],
    });
    try {
      const projection = applyRuntimeCommandEffect(
        current,
        event.payload.kind,
        event.payload.effect,
        event.payload.projectionRevision,
      );
      projections.set(event.runId, { projection, updatedAt: event.occurredAt });
    } catch (error) {
      throw new AgentJournalError(
        'PROJECTION_CORRUPT',
        'Runtime Command facts cannot rebuild their projection.',
        { cause: error instanceof Error ? error.message : String(error) },
      );
    }
  }
  return projections;
}

function freezeRuntimeCommandApplicationResult(
  result: RuntimeCommandApplicationResult,
): RuntimeCommandApplicationResult {
  return deepFreezeKernelValue(structuredClone(result));
}

function assertNeverRuntimeCommand(command: never): never {
  throw new AgentJournalError(
    'INVALID_ARGUMENT', `Unsupported Runtime Command ${String(command)}.`,
  );
}

function assertNeverRuntimeCommandKind(kind: never): never {
  throw new AgentJournalError(
    'PROJECTION_CORRUPT', `Unsupported Runtime Command kind ${String(kind)}.`,
  );
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

type ModelRunWindowIdentity = Readonly<{
  projectId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  attemptId: string;
  expectedRunRevision: number;
}>;

function openModelRunWindow(
  database: NodeDatabaseSync,
  projection: KernelRunProjection,
  turnId: string,
  attemptId: string,
): void {
  if (
    projection.state !== 'ReceivingModel' || projection.currentTurnId !== turnId ||
    projection.currentAttemptId !== attemptId
  ) {
    throw new AgentJournalError(
      'PROJECTION_CORRUPT', 'A Model window can open only for its exact active Attempt.',
    );
  }
  database.prepare(
    `INSERT INTO agent_model_run_windows (
      run_id, project_id, session_id, turn_id, attempt_id, base_revision, current_revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    projection.runId, projection.projectId, projection.sessionId,
    turnId, attemptId, projection.revision, projection.revision,
  );
}

function resolveModelRunWindowRevision(
  database: NodeDatabaseSync,
  identity: ModelRunWindowIdentity,
  allowCancelling = true,
): number {
  const current = readKernelRunProjection(database, identity.runId);
  const window = database.prepare(
    `SELECT project_id, session_id, turn_id, attempt_id, base_revision, current_revision
     FROM agent_model_run_windows WHERE run_id = ?`,
  ).get(identity.runId) as Readonly<{
    project_id: string;
    session_id: string;
    turn_id: string;
    attempt_id: string;
    base_revision: number;
    current_revision: number;
  }> | undefined;
  if (
    window === undefined || window.project_id !== identity.projectId ||
    window.session_id !== identity.sessionId || window.turn_id !== identity.turnId ||
    window.attempt_id !== identity.attemptId || current.currentTurnId !== identity.turnId ||
    current.currentAttemptId !== identity.attemptId
  ) {
    throw new AgentJournalError(
      'MODEL_COMMIT_CONFLICT', 'Model command is outside its exact active Attempt window.',
    );
  }
  const baseRevision = Number(window.base_revision);
  const currentRevision = Number(window.current_revision);
  const receiving = current.state === 'ReceivingModel' && current.revision === currentRevision;
  const cancelling = allowCancelling && current.state === 'Cancelling' &&
    current.revision > currentRevision;
  if (
    (!receiving && !cancelling) || identity.expectedRunRevision < baseRevision ||
    identity.expectedRunRevision > (cancelling ? current.revision : currentRevision)
  ) {
    throw new AgentJournalError(
      'REVISION_CONFLICT', 'Model command Run revision is outside its active Attempt window.',
    );
  }
  return current.revision;
}

function deleteModelRunWindow(
  database: NodeDatabaseSync,
  runId: string,
  turnId: string,
  attemptId: string,
): void {
  const deleted = database.prepare(
    `DELETE FROM agent_model_run_windows
     WHERE run_id = ? AND turn_id = ? AND attempt_id = ?`,
  ).run(runId, turnId, attemptId);
  if (Number(deleted.changes) !== 1) {
    throw new AgentJournalError('PROJECTION_CORRUPT', 'Active Model window was not closed exactly once.');
  }
}

function advanceCompatibleRunWindowsForContextRequest(
  database: NodeDatabaseSync,
  current: KernelRunProjection,
  next: KernelRunProjection,
): void {
  if (next.revision !== current.revision + 1) {
    throw new AgentJournalError(
      'PROJECTION_CORRUPT', 'Context request did not advance one exact Run revision.',
    );
  }
  if (current.state === 'ReceivingModel') {
    const changed = database.prepare(
      `UPDATE agent_model_run_windows SET current_revision = ?
       WHERE run_id = ? AND turn_id = ? AND attempt_id = ? AND current_revision = ?`,
    ).run(
      next.revision, current.runId, current.currentTurnId,
      current.currentAttemptId, current.revision,
    );
    if (Number(changed.changes) !== 1) {
      throw new AgentJournalError(
        'PROJECTION_CORRUPT', 'Manual Context request could not rebase the active Model window.',
      );
    }
    return;
  }
  const toolWindow = database.prepare(
    `SELECT turn_id, current_revision FROM agent_tool_run_windows WHERE run_id = ?`,
  ).get(current.runId) as { turn_id: string; current_revision: number } | undefined;
  if (toolWindow === undefined) return;
  if (
    current.currentTurnId !== null && toolWindow.turn_id !== current.currentTurnId ||
    Number(toolWindow.current_revision) !== current.revision
  ) {
    throw new AgentJournalError(
      'PROJECTION_CORRUPT', 'Manual Context request found an incompatible Tool window.',
    );
  }
  advanceToolRunWindow(database, current.runId, toolWindow.turn_id, current.revision);
}

function rebaseActiveRunWindows(
  database: NodeDatabaseSync,
  current: KernelRunProjection,
  next: KernelRunProjection,
  rotateEpoch = false,
): void {
  if (next.revision !== current.revision + 1) {
    throw new AgentJournalError(
      'PROJECTION_CORRUPT', 'Run window rebase requires one exact committed revision.',
    );
  }
  const modelWindow = database.prepare(
    `SELECT turn_id, attempt_id, base_revision, current_revision
     FROM agent_model_run_windows WHERE run_id = ?`,
  ).get(current.runId) as Readonly<{
    turn_id: string; attempt_id: string; base_revision: number; current_revision: number;
  }> | undefined;
  if (modelWindow !== undefined) {
    if (
      current.currentTurnId !== modelWindow.turn_id ||
      current.currentAttemptId !== modelWindow.attempt_id ||
      Number(modelWindow.current_revision) !== current.revision
    ) {
      throw new AgentJournalError(
        'PROJECTION_CORRUPT', 'Run control found an incompatible Model window.',
      );
    }
    const changed = rotateEpoch
      ? database.prepare(
          `UPDATE agent_model_run_windows SET base_revision = ?, current_revision = ?
           WHERE run_id = ? AND turn_id = ? AND attempt_id = ? AND current_revision = ?`,
        ).run(
          next.revision, next.revision, current.runId,
          modelWindow.turn_id, modelWindow.attempt_id, current.revision,
        )
      : database.prepare(
          `UPDATE agent_model_run_windows SET current_revision = ?
           WHERE run_id = ? AND turn_id = ? AND attempt_id = ? AND current_revision = ?`,
        ).run(
          next.revision, current.runId,
          modelWindow.turn_id, modelWindow.attempt_id, current.revision,
        );
    if (Number(changed.changes) !== 1) {
      throw new AgentJournalError(
        'REVISION_CONFLICT', 'Concurrent Run control changed the active Model window.',
      );
    }
  }
  const toolWindow = database.prepare(
    `SELECT turn_id, current_revision FROM agent_tool_run_windows WHERE run_id = ?`,
  ).get(current.runId) as Readonly<{ turn_id: string; current_revision: number }> | undefined;
  if (toolWindow !== undefined) {
    if (
      (current.currentTurnId !== null && current.currentTurnId !== toolWindow.turn_id) ||
      Number(toolWindow.current_revision) !== current.revision
    ) {
      throw new AgentJournalError(
        'PROJECTION_CORRUPT', 'Run control found an incompatible Tool window.',
      );
    }
    const changed = rotateEpoch
      ? database.prepare(
          `UPDATE agent_tool_run_windows SET base_revision = ?, current_revision = ?
           WHERE run_id = ? AND turn_id = ? AND current_revision = ?`,
        ).run(
          next.revision, next.revision, current.runId,
          toolWindow.turn_id, current.revision,
        )
      : database.prepare(
          `UPDATE agent_tool_run_windows SET current_revision = ?
           WHERE run_id = ? AND turn_id = ? AND current_revision = ?`,
        ).run(
          next.revision, current.runId, toolWindow.turn_id, current.revision,
        );
    if (Number(changed.changes) !== 1) {
      throw new AgentJournalError(
        'REVISION_CONFLICT', 'Concurrent Run control changed the active Tool window.',
      );
    }
  }
}

/**
 * Resolves a Tool command against the durable Tool window rather than blindly
 * accepting any newer Run revision. Run-control facts advance the window so
 * replay remains exact, while suspended states reject work and resume rotates
 * `base_revision` so commands issued in the prior epoch cannot cross it.
 */
function resolveToolRunWindowRevision(
  database: NodeDatabaseSync,
  command: ToolInvocationJournalCommand,
): number {
  const current = readKernelRunProjection(database, command.runId);
  const window = database.prepare(
    `SELECT project_id, session_id, turn_id, base_revision, current_revision
     FROM agent_tool_run_windows WHERE run_id = ?`,
  ).get(command.runId) as Readonly<{
    project_id: string;
    session_id: string;
    turn_id: string;
    base_revision: number;
    current_revision: number;
  }> | undefined;
  if (
    window === undefined || window.project_id !== command.projectId ||
    window.session_id !== command.sessionId || window.turn_id !== command.turnId ||
    (current.currentTurnId !== null && current.currentTurnId !== command.turnId)
  ) {
    throw new AgentJournalError(
      'COMMAND_CONFLICT', 'Tool command does not belong to the active durable Tool window.',
    );
  }
  if (current.revision !== Number(window.current_revision)) {
    throw new AgentJournalError(
      'COMMAND_CONFLICT',
      'Tool window was superseded by a non-Tool Run transition.',
    );
  }
  if (
    !['ResolvingActions', 'ExecutingTools', 'ApplyingObservations', 'AwaitingUser', 'Cancelling']
      .includes(current.state)
  ) {
    throw new AgentJournalError(
      'COMMAND_CONFLICT',
      'Tool execution is suspended until the Run returns to its durable Tool state.',
    );
  }
  if (
    current.state === 'Cancelling' && command.action !== 'finish' && command.action !== 'observe' && command.action !== 'settle-question'
  ) {
    throw new AgentJournalError(
      'COMMAND_CONFLICT',
      'A cancelling Tool window accepts only terminal settlement and Observation commands.',
    );
  }
  const baseRevision = Number(window.base_revision);
  const currentRevision = Number(window.current_revision);
  if (
    command.expectedRunRevision < baseRevision ||
    command.expectedRunRevision > currentRevision
  ) {
    throw new AgentJournalError(
      'REVISION_CONFLICT', 'Tool command Run revision is outside the active Tool window.',
    );
  }
  return currentRevision;
}

function openCancellationToolRunWindow(
  database: NodeDatabaseSync,
  previous: KernelRunProjection,
  cancelling: KernelRunProjection,
): void {
  const prior = database.prepare(
    `SELECT project_id, session_id, turn_id, base_revision, current_revision
     FROM agent_tool_run_windows WHERE run_id = ?`,
  ).get(cancelling.runId) as Readonly<{
    project_id: string;
    session_id: string;
    turn_id: string;
    base_revision: number;
    current_revision: number;
  }> | undefined;
  const turnId = cancelling.currentTurnId ?? prior?.turn_id;
  if (
    cancelling.state !== 'Cancelling' || turnId === undefined ||
    cancelling.revision !== previous.revision + 1
  ) {
    throw new AgentJournalError(
      'PROJECTION_CORRUPT', 'Cancellation settlement requires an exact open Tool Turn.',
    );
  }
  if (
    prior !== undefined && (
      prior.project_id !== cancelling.projectId || prior.session_id !== cancelling.sessionId ||
      prior.turn_id !== turnId || Number(prior.current_revision) !== previous.revision
    )
  ) {
    throw new AgentJournalError(
      'COMMAND_CONFLICT', 'Cancellation cannot rebase an incompatible Tool window.',
    );
  }
  const baseRevision = prior === undefined ? previous.revision : Number(prior.base_revision);
  database.prepare(
    `INSERT INTO agent_tool_run_windows (
      run_id, project_id, session_id, turn_id, base_revision, current_revision
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      project_id = excluded.project_id,
      session_id = excluded.session_id,
      turn_id = excluded.turn_id,
      base_revision = excluded.base_revision,
      current_revision = excluded.current_revision`,
  ).run(
    cancelling.runId, cancelling.projectId, cancelling.sessionId,
    turnId, baseRevision, cancelling.revision,
  );
}

function openToolRunWindow(
  database: NodeDatabaseSync,
  projection: KernelRunProjection,
  turnId: string,
): void {
  if (
    (projection.currentTurnId !== null && projection.currentTurnId !== turnId) ||
    projection.state !== 'ResolvingActions'
  ) {
    throw new AgentJournalError(
      'PROJECTION_CORRUPT', 'A Tool window can open only for its committed Tool Turn.',
    );
  }
  database.prepare(
    `INSERT INTO agent_tool_run_windows (
      run_id, project_id, session_id, turn_id, base_revision, current_revision
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      project_id = excluded.project_id,
      session_id = excluded.session_id,
      turn_id = excluded.turn_id,
      base_revision = excluded.base_revision,
      current_revision = excluded.current_revision`,
  ).run(
    projection.runId, projection.projectId, projection.sessionId,
    turnId, projection.revision, projection.revision,
  );
}

function advanceToolRunWindow(
  database: NodeDatabaseSync,
  runId: string,
  turnId: string,
  expectedRevision: number,
): void {
  const changed = database.prepare(
    `UPDATE agent_tool_run_windows SET current_revision = current_revision + 1
     WHERE run_id = ? AND turn_id = ? AND current_revision = ?`,
  ).run(runId, turnId, expectedRevision);
  if (Number(changed.changes) !== 1) {
    throw new AgentJournalError(
      'REVISION_CONFLICT', 'Concurrent Tool window transition won the revision race.',
    );
  }
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
  toolWindows: Map<string, PersistedToolRunWindow>;
  modelWindows: Map<string, PersistedModelRunWindow>;
}>;

type PersistedToolRunWindow = Readonly<{
  runId: string;
  projectId: string;
  sessionId: string;
  turnId: string;
  baseRevision: number;
  currentRevision: number;
}>;

type PersistedModelRunWindow = PersistedToolRunWindow & Readonly<{
  attemptId: string;
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
  const toolWindows = new Map<string, PersistedToolRunWindow>();
  const modelWindows = new Map<string, PersistedModelRunWindow>();

  for (const event of created.values()) {
    runs.set(event.runId, createKernelRunProjection({
      projectId: event.projectId,
      sessionId: event.sessionId,
      runId: event.runId,
      environmentBindingId: null,
      createdAt: event.occurredAt,
    }));
  }

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
  }

  for (const event of ordered) {
    const current = runs.get(event.runId);
    if (current === undefined) continue;
    if (event.type === 'turn.started' && current.environmentBindingId !== null) {
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
    const next = projectKernelRunEvent(current, event);
    if (event.type === 'model_attempt_started') {
      if (
        event.turnId === undefined || event.attemptId === undefined ||
        next.state !== 'ReceivingModel' || next.currentTurnId !== event.turnId ||
        next.currentAttemptId !== event.attemptId
      ) {
        throw new AgentJournalError(
          'PROJECTION_CORRUPT', 'Model window start fact has invalid active identities.',
        );
      }
      modelWindows.set(event.runId, {
        runId: event.runId,
        projectId: event.projectId,
        sessionId: event.sessionId,
        turnId: event.turnId,
        attemptId: event.attemptId,
        baseRevision: next.revision,
        currentRevision: next.revision,
      });
    } else if (
      event.type === 'context.compaction_requested' || event.type === 'run.limit_reached' ||
      event.type === 'run.interrupted' ||
      (event.type === 'run.resumed' && event.payload.clearTurn !== true) ||
      (event.type === 'run.input_requested' && event.payload.reason === 'outcome_resolution')
    ) {
      const modelWindow = modelWindows.get(event.runId);
      if (modelWindow !== undefined) {
        if (
          current.revision !== modelWindow.currentRevision ||
          current.currentTurnId !== modelWindow.turnId ||
          current.currentAttemptId !== modelWindow.attemptId
        ) {
          throw new AgentJournalError(
            'PROJECTION_CORRUPT', 'Run control cannot replay the active Model window.',
          );
        }
        modelWindows.set(event.runId, {
          ...modelWindow,
          ...(event.type === 'run.resumed'
            ? { baseRevision: next.revision }
            : {}),
          currentRevision: next.revision,
        });
      }
      const toolWindow = toolWindows.get(event.runId);
      if (toolWindow !== undefined) {
        if (
          current.revision !== toolWindow.currentRevision ||
          (current.currentTurnId !== null && current.currentTurnId !== toolWindow.turnId)
        ) {
          throw new AgentJournalError(
            'PROJECTION_CORRUPT', 'Run control cannot replay the active Tool window.',
          );
        }
        toolWindows.set(event.runId, {
          ...toolWindow,
          ...(event.type === 'run.resumed'
            ? { baseRevision: next.revision }
            : {}),
          currentRevision: next.revision,
        });
      }
    } else if (
      event.type === 'model_attempt_discarded' || event.type === 'model_attempt_committed'
    ) {
      modelWindows.delete(event.runId);
    }
    if (
      event.type === 'model_attempt_committed' && event.turnId !== undefined &&
      event.payload.validatedAttempt.blocks.some((block) => block.type === 'tool-call-draft')
    ) {
      toolWindows.set(event.runId, {
        runId: event.runId,
        projectId: event.projectId,
        sessionId: event.sessionId,
        turnId: event.turnId,
        baseRevision: next.revision,
        currentRevision: next.revision,
      });
    } else if (event.type === 'model_attempt_committed') {
      toolWindows.delete(event.runId);
    } else if (event.type === 'run.cancel_requested' && current.currentTurnId !== null) {
      const prior = toolWindows.get(event.runId);
      toolWindows.set(event.runId, {
        runId: event.runId,
        projectId: event.projectId,
        sessionId: event.sessionId,
        turnId: current.currentTurnId,
        baseRevision: prior?.turnId === current.currentTurnId
          ? prior.baseRevision
          : current.revision,
        currentRevision: next.revision,
      });
    } else if (event.type === 'tool.transition_committed') {
      const window = toolWindows.get(event.runId);
      if (
        window === undefined || event.turnId !== window.turnId ||
        current.revision !== window.currentRevision || next.revision !== current.revision + 1
      ) {
        throw new AgentJournalError(
          'PROJECTION_CORRUPT', 'Tool window cannot replay its exact Run revision.',
        );
      }
      toolWindows.set(event.runId, { ...window, currentRevision: next.revision });
    } else if (event.type === 'runtime.command_applied') {
      const window = toolWindows.get(event.runId);
      if (
        window === undefined || event.turnId !== window.turnId ||
        current.revision !== window.currentRevision || next.revision !== current.revision + 1
      ) {
        throw new AgentJournalError(
          'PROJECTION_CORRUPT', 'Runtime Command cannot replay its exact Tool window.',
        );
      }
      toolWindows.set(event.runId, { ...window, currentRevision: next.revision });
    } else if (
      event.type === 'turn.closed' && event.payload.reason !== 'blocked_by_outcome'
    ) {
      toolWindows.delete(event.runId);
    } else if (event.type === 'run.resumed' && event.payload.clearTurn === true) {
      toolWindows.delete(event.runId);
    } else if (event.type === 'run.cancelled') {
      toolWindows.delete(event.runId);
    }
    runs.set(event.runId, next);
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

      return {
        invocationId: invocation.invocationId, actionOrdinal: invocation.actionOrdinal,
        recoveryClass: invocation.recoveryClass ?? 'unresolved', state: invocation.state,
        access: invocation.intent?.access ?? 'external', concurrency: invocation.intent?.concurrency ?? 'exclusive', resourceKeys: invocation.intent?.resourceKeys ?? [],
      };
    });
    if (scheduled.length === 0) continue;
    const decision = decideSchedule({ invocations: scheduled, maxConcurrency: Number.MAX_SAFE_INTEGER });
    runs.set(runId, projectKernelSchedule(current, decision, current.updatedAt));
  }
  return { runs, environments, snapshots, toolWindows, modelWindows };
}

function nullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new AgentJournalError('PROJECTION_CORRUPT', 'Expected a nullable text projection value.');
  }
  return value;
}

function resumableState(state: AgentRunState): AgentResumableState {
  switch (state) {
    case 'created':
    case 'Preparing':
    case 'Compacting':
    case 'CallingModel':
    case 'ReceivingModel':
    case 'ResolvingActions':
    case 'ExecutingTools':
    case 'ApplyingObservations':
    case 'Finalizing':
      return state;
    default:
      throw new AgentJournalError(
        'COMMAND_CONFLICT', `Run state ${state} is not a resumable execution boundary.`,
      );
  }
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
  for (const nested of Object.values(value)) deepFreezeKernelValue(nested, seen);
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
