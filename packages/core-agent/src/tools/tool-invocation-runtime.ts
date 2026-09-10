import { ToolInvocationPreparer, type ToolPreparationInterruption } from './tool-invocation-preparer.js';
import { readToolQuestionWaitRequest, validateToolQuestionBundle, normalizeQuestionCommand, questionCommandDigest, type ToolQuestionBundle, type QuestionRuntimeCommand } from './tool-question.js';
import { assertPreparedLifecycleRepresentable } from './prepared-journal-preflight.js';
import {
  startToolHandlerExecution,
  startToolResultRetention,
  ToolHandlerAbort,
} from './tool-invocation-executor.js';
import { decideInvocationRecovery } from './tool-invocation-recovery.js';
import { validatePreparedIntent, preparedIntentDigest, assertPreparedDigest, validateInvocationInput } from './prepared-invocation.js';
import { RunToolResourceLeases, ToolExecutionBoundary, ToolExecutionDrain, type ToolResourceLease, type ToolResourceLeaseProvider, type ToolTargetRevalidator } from './tool-resource-leases.js';
import type { PreparedToolIntent, ToolExecuteContext } from './tool-protocol.js';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { PortableValue } from '@dbagent/shared';
import type { ProjectArtifactStore } from '../artifacts/project-artifact-store.js';
import { ArtifactIoInterruption } from '../artifacts/artifact-store.js';
import type {
  ToolApprovalFact,
  ToolRecoveryClassFact,
  ToolExecutionErrorFact,
  ToolObservationFact,
  ToolPermissionAuditFact,
} from '../events/agent-event.js';
import {
  AgentJournalError,
  type AgentJournal,
  type RunLease,
} from '../events/agent-journal.js';
import type { AgentInvocationProjection, AgentRunProjection } from '../events/event-projectors.js';
import {
  type PermissionManager,
  type ToolPermissionEvaluation,
} from '../permission-manager.js';
import type {
  ToolCatalogSnapshot,
  ToolInvocationAuthorization,
  ToolInvocationExecutionContext,
  ToolInvocationHandlerRuntime,
  ToolRetainedResultContent,
} from '../tool-registry.js';
import { resolveInvocationHandler } from '../internal/tool-invocation-authority.js';
import {
  createRuntimeCommandIssuer,
  openRuntimeCommandApplication,
} from '../internal/runtime-command-authority.js';
import { readSealedRuntimeCommandToolResult } from '../internal/runtime-command-tool-result-authority.js';
import { isRuntimeCommandKindOwnedByTool } from '../runtime-command-ownership.js';
import {
  openToolLifecycleCommitter,
  type ToolLifecycleCommitter,
} from '../internal/tool-lifecycle-authority.js';
import {
  openToolArtifactCommitter,
  type PreparedToolArtifactCommit,
  type ToolArtifactCommitter,
} from '../internal/prepared-tool-artifact-authority.js';
import {
  materializeNormalizedToolResult,
  normalizeAgentToolResult,
  type ToolResultProjectionBudget,
} from '../tool-result.js';
import { normalizeAgentEvidenceRefs } from '../evidence-reference.js';
import type {
  AgentMode,
  AgentToolAuditEvidence,
  AgentToolCompletionEvidence,
  AgentToolDescriptor,
} from '../types.js';
import type {
  AgentCapabilityDiscoveryManifestEntry,
  AgentInvocationHookContribution,
  AgentInvocationHookInput,
} from '../capability-types.js';
import { snapshotCapabilityDiscoveryManifest } from '../capability-discovery-manifest.js';
import type {
  RuntimeCommand,
  RuntimeCommandApplicationResult,
  RuntimeCommandProjection,
} from '../kernel/runtime-command.js';
import {
  adaptToolHandlerFailure,
  ToolExecutionError,
  ToolInvocationError,
  invalidToolResultError,
} from './tool-errors.js';
import {
  decideSchedule,
  type ToolScheduleDecision,
  type ToolInvocationScheduleState,
} from './tool-scheduler.js';
import { createToolActionSummary } from './tool-action-summary.js';
import { redactPersistedAgentString } from '../redaction.js';

const sharedResourceLeases = new RunToolResourceLeases();
const DEFAULT_MAX_CONCURRENCY = 4;
const COMPETING_EXECUTION_WAIT_MS = 5_000;
const COMPETING_EXECUTION_POLL_MS = 5;
const DEFAULT_ACTIVE_LEASE_POLL_MS = 250;
const INVOCATION_PAGE_SIZE = 256;
const MAX_TOOL_RUN_CAS_RETRIES = 128;
const TOOL_PROGRESS_MAX_DELAY_MS = 40;
const TOOL_PROGRESS_MAX_BATCH_BYTES = 4 * 1024;
const TOOL_PROGRESS_MAX_ITEM_BYTES = 1024;

export type ToolInvocationRuntimeBinding = Readonly<{
  projectId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  lease: RunLease;
  mode: AgentMode;
}>;

export type ToolInvocationRuntimeOptions = Readonly<{
  hostId?: string;
  resourceLeases?: ToolResourceLeaseProvider;
  revalidateTarget?: ToolTargetRevalidator;
  journal: AgentJournal;
  registry: ToolCatalogSnapshot;
  /** Exact Tool identities exposed to the model for this persisted Turn. */
  allowedTools: readonly Readonly<{ name: string; revision: string }>[];
  /** Exact full discoverable catalog captured for this persisted Turn. */
  discoverableTools?: readonly Readonly<{ name: string; revision: string }>[];
  /** Static semantic Capability manifest captured for this persisted Turn. */
  discoverableCapabilities?: readonly AgentCapabilityDiscoveryManifestEntry[];
  permissionManager: PermissionManager;
  artifactStore?: ProjectArtifactStore | undefined;
  binding: ToolInvocationRuntimeBinding;
  maxConcurrency?: number;
  /** Fallback cadence when the Journal has no push lease-loss notification. */
  leasePollIntervalMs?: number;
  /** Authoritative clock paired with the Journal clock; injectable for deterministic recovery. */
  now?: () => number;
  onCrashPoint?: (point: ToolInvocationCrashPoint) => void | Promise<void>;
  runtimeCommandExecutor?: RuntimeCommandPostCommitExecutor;
  /** Exact revisioned Hook generation captured for this Turn. */
  invocationHooks?: readonly AgentInvocationHookContribution[];
  resultProjectionBudget?: ToolResultProjectionBudget;
}>;

export type RuntimeCommandPostCommitInput = Readonly<{
  command: RuntimeCommand;
  application: RuntimeCommandApplicationResult;
  handlerResult: PortableValue;
  context: ToolExecuteContext;
}>;

export type RuntimeCommandPostCommitExecutor = (
  input: RuntimeCommandPostCommitInput,
) => PortableValue | void | Promise<PortableValue | void>;

export type ToolInvocationCrashPoint =
  | 'after-started-before-handler'
  | 'after-external-recoveryClass-before-terminal'
  | 'after-terminal-before-observation';

export type ToolApprovalDecision = Readonly<{
  commandId: string;
  approvalId: string;
  projectId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  invocationId: string;
  canonicalToolId: { namespace?: string; name: string };
  toolRevision: string;
  recoveryClass: ToolRecoveryClassFact;
  intentDigest: string;
  proposedRevision: number;
  decision: 'approve' | 'deny';
  decidedBy?: string;
  reason?: string;
}>;

export type RiskyRetryAuthorization = Readonly<{
  commandId: string;
  invocationId: string;
  toolRevision: string;
  recoveryClass: 'non_idempotent';
  intentDigest: string;
  reason: string;
}>;

export type UnknownOutcomeResolution = Readonly<{
  commandId: string;
  invocationId: string;
  canonicalToolId: { namespace?: string; name: string };
  toolRevision: string;
  recoveryClass: ToolRecoveryClassFact;
  intentDigest: string;
  proposedRevision: number;
  outcome: 'succeeded' | 'failed';
  summary: string;
  retryAuthorization?: Readonly<{ permitId: string; reason: string }>;
}>;

/**
 * The sole Tool Handler execution boundary.
 *
 * The Runtime owns no authoritative lifecycle state. Its only in-memory state
 * coalesces duplicate calls inside this process; every decision and recovery
 * fact is reconstructed from the Journal.
 */
export class ToolInvocationRuntime {
  readonly #preparer = new ToolInvocationPreparer();
  readonly #hostId: string;
  readonly #boundary: ToolExecutionBoundary;
  readonly #journal: AgentJournal;
  readonly #toolLifecycle: ToolLifecycleCommitter;
  readonly #registry: ToolCatalogSnapshot;
  readonly #allowedTools: ReadonlyMap<string, string>;
  readonly #discoverableTools: ToolInvocationExecutionContext['discoverableTools'];
  readonly #discoverableCapabilities: ToolInvocationExecutionContext['discoverableCapabilities'];
  readonly #permissionManager: PermissionManager;
  readonly #artifactStore: ProjectArtifactStore | undefined;
  readonly #artifactCommitter: ToolArtifactCommitter | undefined;
  readonly #binding: ToolInvocationRuntimeBinding;
  readonly #maxConcurrency: number;
  readonly #runtimeId = randomUUID();
  readonly #leasePollIntervalMs: number;
  readonly #now: () => number;
  readonly #terminalInflight = new Map<string, Promise<AgentInvocationProjection>>();
  readonly #onCrashPoint: ToolInvocationRuntimeOptions['onCrashPoint'];
  readonly #runtimeCommandExecutor: RuntimeCommandPostCommitExecutor | undefined;
  readonly #invocationHooks: readonly AgentInvocationHookContribution[];
  readonly #resultProjectionBudget: ToolResultProjectionBudget | undefined;

  constructor(options: ToolInvocationRuntimeOptions) {
    this.#hostId = options.hostId ?? 'local';
    this.#boundary = new ToolExecutionBoundary(options.resourceLeases ?? sharedResourceLeases, options.revalidateTarget, options.now ?? Date.now);
    this.#journal = options.journal;
    this.#toolLifecycle = openToolLifecycleCommitter(options.journal);
    this.#registry = options.registry;
    this.#allowedTools = allowedToolMap(options.allowedTools);
    this.#discoverableTools = capturedDiscoverableTools(
      options.registry,
      options.discoverableTools ?? options.registry.listDescriptors()
        .filter(({ exposure }) => exposure !== 'hidden' && exposure !== 'disabled')
        .map(({ flatName }) => ({
          name: flatName,
          revision: options.registry.invocationRevision(flatName) ?? '',
        })),
    );
    this.#discoverableCapabilities = capturedDiscoverableCapabilities(
      options.discoverableCapabilities ?? [],
    );
    this.#permissionManager = options.permissionManager;
    this.#artifactStore = options.artifactStore;
    this.#artifactCommitter = options.artifactStore === undefined
      ? undefined
      : openToolArtifactCommitter(options.artifactStore);
    if (
      this.#artifactCommitter !== undefined &&
      this.#artifactCommitter.journalOwner !== options.journal
    ) {
      throw new TypeError('Artifact Store and Tool Runtime must share the exact Journal owner.');
    }
    this.#binding = Object.freeze(structuredCloneBinding(options.binding));
    this.#maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    if (!Number.isSafeInteger(this.#maxConcurrency) || this.#maxConcurrency < 1) {
      throw new TypeError('Tool maxConcurrency must be a positive safe integer.');
    }
    this.#leasePollIntervalMs = options.leasePollIntervalMs ?? DEFAULT_ACTIVE_LEASE_POLL_MS;
    if (
      !Number.isSafeInteger(this.#leasePollIntervalMs) ||
      this.#leasePollIntervalMs < 5 || this.#leasePollIntervalMs > 60_000
    ) {
      throw new TypeError('leasePollIntervalMs must be between 5 and 60000.');
    }
    this.#now = options.now ?? Date.now;
    if (!Number.isFinite(this.#now())) throw new TypeError('Tool Runtime clock must be finite.');
    this.#onCrashPoint = options.onCrashPoint;
    this.#runtimeCommandExecutor = options.runtimeCommandExecutor;
    this.#invocationHooks = captureInvocationHooks(options.invocationHooks ?? []);
    this.#resultProjectionBudget = options.resultProjectionBudget;
  }

  async resolve(options: { signal?: AbortSignal } = {}): Promise<ToolScheduleDecision> {
    const preparationInterruptions = new Map<string, ToolPreparationInterruption>();
    for (const invocation of await this.#boundInvocations()) {
      if (invocation.state === 'waiting_for_user' && invocation.question?.deadline !== null && invocation.question?.deadline !== undefined && this.#now() >= Date.parse(invocation.question.deadline)) {
        await this.submitQuestion(invocation.invocationId, { kind: 'question.timeout', commandId: `timeout:${invocation.question.questionId}`, questionId: invocation.question.questionId, questionRevision: invocation.question.questionRevision });
      }
    }
    if (await this.#runState() !== 'AwaitingUser') {
      for (const invocation of await this.#boundInvocations()) {
        if (invocation.state === 'proposed') {
          const interruption = await this.#validateInvocation(invocation.invocationId, true, options.signal);
          if (interruption !== undefined) preparationInterruptions.set(invocation.invocationId, interruption);
        }
      }
    }
    let decision = await this.#currentDecision();
    while (decision.state === 'ResolvingActions') {
      for (const invocationId of decision.invocationIds) {
        const interruption = await this.#validateInvocation(
          invocationId,
          false,
          options.signal,
          preparationInterruptions.get(invocationId),
        );
        if (interruption !== undefined) preparationInterruptions.set(invocationId, interruption);
      }
      decision = await this.#currentDecision();
    }
    return decision;
  }

  async execute(
    invocationId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ToolObservationFact | undefined> {
    const current = await this.#requireBoundInvocation(invocationId);
    if (current.observation !== undefined) return publicObservation(current.observation);
    const decision = await this.resolve(options);
    if (
      (decision.state !== 'ExecutingTools' && decision.state !== 'ApplyingObservations') ||
      decision.invocationIds[0] !== invocationId
    ) {
      throw new ToolInvocationError(
        'INVOCATION_CONFLICT',
        'Invocation is not in the current scheduler decision.',
      );
    }
    if (decision.state === 'ExecutingTools') {
      const result = await this.#terminalForQualifiedInvocation(invocationId, options.signal);
      if (result.state === 'waiting_for_user') return undefined;
    }
    const observation = await this.#applyUntilObserved(invocationId, undefined);
    await this.resolve();
    return observation;
  }

  async executeEligible(
    options: { signal?: AbortSignal } = {},
  ): Promise<ToolObservationFact[]> {
    const observations: ToolObservationFact[] = [];
    while (true) {
      const decision = await this.resolve(options);
      if (options.signal?.aborted && decision.state !== 'ApplyingObservations') break;
      if (decision.state === 'AwaitingUser' || decision.state === 'TurnReadyToClose') break;
      if (decision.state === 'ResolvingActions') continue;
      if (decision.invocationIds.length === 0) break;
      if (decision.state === 'ExecutingTools') {
        await Promise.all(decision.invocationIds.map(async (invocationId) =>
          await this.#terminalForQualifiedInvocation(invocationId, options.signal)));
        continue;
      }
      observations.push(...await this.#applyObservationDecision(decision.invocationIds));
    }
    return observations;
  }

  async decideApproval(decision: ToolApprovalDecision): Promise<ToolScheduleDecision> {
    const approval = await this.#journal.getApproval({
      projectId: this.#binding.projectId,
      sessionId: this.#binding.sessionId,
      runId: this.#binding.runId,
      invocationId: decision.invocationId,
    });
    if (approval === null) {
      throw new ToolInvocationError('APPROVAL_BINDING_MISMATCH', 'Approval request was not found.');
    }
    assertApprovalDecisionBinding(approval, decision);
    const invocation = await this.#requireBoundInvocation(decision.invocationId);
    const runRevision = await this.#runRevision();
    try {
      await this.#toolLifecycle.commit({
        action: 'decide-approval',
        projectId: decision.projectId,
        sessionId: decision.sessionId,
        runId: decision.runId,
        turnId: decision.turnId,
        invocationId: decision.invocationId,
        commandId: decision.commandId,
        lease: leaseReference(this.#binding.lease),
        expectedRunRevision: runRevision,
        expectedInvocationRevision: invocation.revision,
        approvalId: decision.approvalId,
        canonicalToolId: structuredClone(decision.canonicalToolId),
        toolRevision: decision.toolRevision,
        recoveryClass: decision.recoveryClass,
        intentDigest: decision.intentDigest,
        proposedRevision: decision.proposedRevision,
        decision: decision.decision,
        ...(decision.decidedBy === undefined ? {} : { decidedBy: decision.decidedBy }),
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
      });
    } catch (error) {
      throw mapJournalError(error);
    }
    return await this.resolve();
  }

  async authorizeRiskyRetry(input: RiskyRetryAuthorization): Promise<{
    permitId: string;
    invocationId: string;
    toolRevision: string;
    recoveryClass: ToolRecoveryClassFact;
    intentDigest: string;
    reason: string;
  }> {
    const invocation = await this.#requireBoundInvocation(input.invocationId, false);
    const permitId = `retry_${sha256(`${input.invocationId}\0${input.commandId}`)}`;
    try {
      const result = await this.#toolLifecycle.commit({
        action: 'authorize-retry',
        projectId: invocation.projectId,
        sessionId: invocation.sessionId,
        runId: invocation.runId,
        turnId: invocation.turnId,
        invocationId: invocation.invocationId,
        commandId: input.commandId,
        lease: leaseReference(this.#binding.lease),
        expectedRunRevision: await this.#runRevision(),
        expectedInvocationRevision: invocation.revision,
        permitId,
        toolRevision: input.toolRevision,
        recoveryClass: input.recoveryClass,
        intentDigest: input.intentDigest,
        reason: input.reason,
      });
      if (result.retryPermit === undefined) {
        throw new ToolInvocationError('INVOCATION_CONFLICT', 'Retry permit was not committed.');
      }
      return result.retryPermit;
    } catch (error) {
      throw mapJournalError(error);
    }
  }

  async resolveUnknownOutcome(input: UnknownOutcomeResolution): Promise<ToolObservationFact> {
    const invocation = await this.#requireBoundInvocation(input.invocationId, false);
    if (
      invocation.canonicalToolId === undefined ||
      canonicalUnknownJson(invocation.canonicalToolId) !== canonicalUnknownJson(input.canonicalToolId) ||
      invocation.toolRevision !== input.toolRevision || invocation.recoveryClass !== input.recoveryClass ||
      invocation.intentDigest !== input.intentDigest ||
      invocation.proposedRevision !== input.proposedRevision
    ) {
      throw new ToolInvocationError(
        'INVOCATION_CONFLICT', 'Outcome resolution does not match the exact Invocation.',
      );
    }
    const resolutionIdentity: PortableValue = {
      invocationId: input.invocationId,
      canonicalToolId: input.canonicalToolId,
      toolRevision: input.toolRevision,
      recoveryClass: input.recoveryClass,
      intentDigest: input.intentDigest,
      proposedRevision: input.proposedRevision,
      outcome: input.outcome,
      summary: input.summary,
      ...(input.retryAuthorization === undefined
        ? {}
        : { retryAuthorization: input.retryAuthorization }),
    };
    const resolutionId = `resolution_${sha256(canonicalJson(resolutionIdentity))}`;
    try {
      const result = await this.#toolLifecycle.commit({
        action: 'resolve-outcome',
        projectId: invocation.projectId,
        sessionId: invocation.sessionId,
        runId: invocation.runId,
        turnId: invocation.turnId,
        invocationId: invocation.invocationId,
        commandId: input.commandId,
        lease: leaseReference(this.#binding.lease),
        expectedRunRevision: await this.#runRevision(),
        expectedInvocationRevision: invocation.revision,
        resolutionId,
        outcome: input.outcome,
        canonicalToolId: structuredClone(input.canonicalToolId),
        toolRevision: input.toolRevision,
        recoveryClass: input.recoveryClass,
        intentDigest: input.intentDigest,
        proposedRevision: input.proposedRevision,
        summary: input.summary,
        ...(input.retryAuthorization === undefined
          ? {}
          : { retryAuthorization: structuredClone(input.retryAuthorization) }),
      });
      if (result.invocation.observation === undefined) {
        throw new ToolInvocationError('INVOCATION_CONFLICT', 'Resolved Observation is missing.');
      }
      return publicObservation(result.invocation.observation);
    } catch (errorValue) {
      throw mapJournalError(errorValue);
    }
  }

  async recover(invocationId: string): Promise<ToolObservationFact | undefined> {
    let invocation = await this.#requireBoundInvocation(invocationId);
    if (invocation.observation !== undefined) return publicObservation(invocation.observation);
    if (invocation.terminal !== undefined) return await this.#convergeRecoveredObservation(invocation);
    if (invocation.state === 'waiting_for_user') {
      const bundle = invocation.question;
      if (!bundle) throw new ToolInvocationError('INVOCATION_CONFLICT', 'Pending question is missing.');
      if (await this.#runState() === 'Cancelling') return await this.submitQuestion(invocationId, { kind: 'question.cancel', commandId: `cancel:${bundle.questionId}`, questionId: bundle.questionId, questionRevision: bundle.questionRevision, reason: 'run-cancelled' });
      if (bundle.deadline !== null && this.#now() >= Date.parse(bundle.deadline)) return await this.submitQuestion(invocationId, { kind: 'question.timeout', commandId: `timeout:${bundle.questionId}`, questionId: bundle.questionId, questionRevision: bundle.questionRevision });
      return undefined;
    }
    if (invocation.state === 'authorized') return await this.execute(invocationId);
    if (invocation.state !== 'started' || invocation.started === undefined) {
      throw new ToolInvocationError('INVOCATION_CONFLICT', 'Invocation cannot be recovered.');
    }
    invocation = await this.#recoverStartedToTerminal(invocation, undefined);
    if (invocation.state === 'waiting_for_user') return undefined;
    return await this.#convergeRecoveredObservation(invocation);
  }

  async #recoverStartedToTerminal(
    invocation: AgentInvocationProjection,
    signal: AbortSignal | undefined,
  ): Promise<AgentInvocationProjection> {
    const started = invocation.started;
    if (invocation.state !== 'started' || started === undefined) {
      throw new ToolInvocationError('INVOCATION_CONFLICT', 'Invocation start fact is missing.');
    }
    if (await this.#runState() === 'Cancelling') {
      return await this.#finishInterruptedCancellation(invocation);
    }
    if (this.#binding.lease.fencingToken <= started.fencingToken) {
      return await this.#waitForCompetingTerminal(invocation.invocationId, signal);
    }
    const recoveryDecision = invocation.intent === undefined ? 'unsupported_revision' : decideInvocationRecovery(invocation.intent, invocation.name, this.#registry);
    if (recoveryDecision === 'unsupported_revision') return await this.#finishUnsupportedRevision(invocation);
    this.#prepared(invocation);
    if (recoveryDecision === 'replay') {
      const claimed = await this.#claimReplayRecovery(invocation);
      invocation = claimed.invocation;
      if (invocation.terminal !== undefined || invocation.observation !== undefined) {
        return invocation;
      }
      if (claimed.authorization === undefined) {
        throw new ToolInvocationError(
          'INVOCATION_CONFLICT',
          'Recovered execution authorization was not captured.',
        );
      }
      return await this.#resumeStarted(invocation, claimed.authorization);
    }
    if (recoveryDecision === 'recover') {
      const runtime = resolveInvocationHandler(this.#registry, invocation.name);
      if (runtime?.recover !== undefined) {
        const claimed = await this.#claimReplayRecovery(invocation);
        invocation = claimed.invocation;
        if (invocation.terminal !== undefined || invocation.observation !== undefined) {
          return invocation;
        }
        if (claimed.authorization === undefined) {
          throw new ToolInvocationError(
            'INVOCATION_CONFLICT',
            'Recovered execution authorization was not captured.',
          );
        }
        return await this.#resumeStarted(invocation, claimed.authorization, true);
      }
    }
    return await this.#finishUnknown(invocation);
  }

  async #claimReplayRecovery(
    invocation: AgentInvocationProjection,
  ): Promise<Readonly<{
    invocation: AgentInvocationProjection;
    authorization?: ToolInvocationAuthorization;
  }>> {
    const priorStart = invocation.started;
    if (invocation.state !== 'started' || priorStart === undefined) {
      throw new ToolInvocationError('INVOCATION_CONFLICT', 'Invocation start fact is missing.');
    }
    if (this.#binding.lease.fencingToken <= priorStart.fencingToken) {
      return {
        invocation: await this.#waitForCompetingTerminal(invocation.invocationId, undefined),
      };
    }
    const authorization = await this.#authorization(invocation);
    try {
      const claimed = await this.#toolLifecycle.commit({
        action: 'start',
        intentDigest: invocation.intentDigest!,
        projectId: invocation.projectId,
        sessionId: invocation.sessionId,
        runId: invocation.runId,
        turnId: invocation.turnId,
        invocationId: invocation.invocationId,
        commandId: `tool-recovery-claim:${invocation.invocationId}:${this.#runtimeId}`,
        lease: leaseReference(this.#binding.lease),
        expectedRunRevision: await this.#runRevision(),
        expectedInvocationRevision: invocation.revision,
        idempotencyKey: priorStart.idempotencyKey,
        attempt: priorStart.attempt + 1,
        permissionAudit: authorizationAudit(authorization),
        recoveryOfFencingToken: priorStart.fencingToken,
      });
      return { invocation: claimed.invocation, authorization };
    } catch (error) {
      const mapped = mapJournalError(error);
      if (mapped.code === 'INVOCATION_CONFLICT') {
        return {
          invocation: await this.#waitForCompetingTerminal(invocation.invocationId, undefined),
        };
      }
      throw mapped;
    }
  }

  async #terminalForQualifiedInvocation(
    invocationId: string,
    callerSignal: AbortSignal | undefined,
    preparationInterruption: ToolPreparationInterruption | undefined = undefined,
  ): Promise<AgentInvocationProjection> {
    const existing = this.#terminalInflight.get(invocationId);
    if (existing !== undefined) return await existing;
    const execution = this.#executeToTerminal(invocationId, callerSignal, preparationInterruption);
    this.#terminalInflight.set(invocationId, execution);
    try {
      return await execution;
    } finally {
      if (this.#terminalInflight.get(invocationId) === execution) {
        this.#terminalInflight.delete(invocationId);
      }
    }
  }

  async #executeToTerminal(
    invocationId: string,
    callerSignal: AbortSignal | undefined,
    preparationInterruption: ToolPreparationInterruption | undefined = undefined,
  ): Promise<AgentInvocationProjection> {
    let invocation = await this.#requireBoundInvocation(invocationId);
    if (invocation.observation !== undefined || invocation.terminal !== undefined) return invocation;
    if (invocation.state === 'started') {
      return await this.#recoverStartedToTerminal(invocation, callerSignal);
    }
    if (invocation.state !== 'authorized') {
      throw new ToolInvocationError('INVOCATION_CONFLICT', 'Invocation is not authorized.');
    }
    let descriptor: AgentToolDescriptor;
    let runtime: ToolInvocationHandlerRuntime;
    try {
      descriptor = this.#requireDescriptor(invocation);
      runtime = this.#requireHandlerRuntime(invocation);
    } catch (error) {
      if (error instanceof ToolInvocationError && isPreStartResolutionError(error)) {
        return await this.#rejectBeforeStart(invocation, error);
      }
      throw error;
    }
    const argumentsRecord = this.#prepared(invocation).input;
    const preliminaryAuthorization = await this.#authorization(invocation);
    const hookRejection = preparationInterruption === undefined && effectiveAuthorization(preliminaryAuthorization)
      ? await this.#runBeforeHooks(
          invocation,
          descriptor,
          argumentsRecord,
          preliminaryAuthorization,
          callerSignal ?? new AbortController().signal,
        )
      : undefined;
    if (hookRejection !== undefined) {
      return await this.#rejectBeforeStart(
        invocation,
        new ToolInvocationError('TOOL_INPUT_INVALID', hookRejection.summary),
        hookRejection,
      );
    }
    const attempt = (invocation.started?.attempt ?? 0) + 1;
    const idempotencyKey = stableIdempotencyKey(invocation);
    const commandId = `tool-start:${invocation.invocationId}:${this.#runtimeId}`;
    let startedByThisRuntime = false;
    let executionAuthorization: ToolInvocationAuthorization | undefined;
    for (let retry = 0; retry < MAX_TOOL_RUN_CAS_RETRIES; retry += 1) {
      try {
        executionAuthorization = await this.#authorization(invocation);
        const started = await this.#toolLifecycle.commit({
          action: 'start',
        intentDigest: invocation.intentDigest!,
          projectId: invocation.projectId,
          sessionId: invocation.sessionId,
          runId: invocation.runId,
          turnId: invocation.turnId,
          invocationId: invocation.invocationId,
          commandId,
          lease: leaseReference(this.#binding.lease),
          expectedRunRevision: await this.#runRevision(),
          expectedInvocationRevision: invocation.revision,
          idempotencyKey,
          attempt,
          permissionAudit: authorizationAudit(executionAuthorization),
        });
        invocation = started.invocation;
        startedByThisRuntime = true;
        break;
      } catch (error) {
        if (!isToolRunRevisionConflict(error)) throw mapJournalError(error);
        const current = await this.#requireBoundInvocation(invocationId, false);
        if (current.observation !== undefined || current.terminal !== undefined) return current;
        if (current.state === 'started') {
          // Another executor won this Invocation.  It alone owns the Handler;
          // a Run-CAS collision from a different Invocation never reaches here
          // because that transaction leaves this Invocation authorized.
          return await this.#waitForCompetingTerminal(invocationId, callerSignal);
        }
        if (current.state !== 'authorized') throw mapJournalError(error);
        invocation = current;
        await Promise.resolve();
      }
    }
    if (!startedByThisRuntime) {
      throw new ToolInvocationError(
        'INVOCATION_CONFLICT',
        'Tool start could not converge after concurrent Run transitions.',
      );
    }
    if (executionAuthorization === undefined) {
      throw new ToolInvocationError(
        'INVOCATION_CONFLICT',
        'Tool execution authorization was not captured.',
      );
    }
    await this.#crashPoint('after-started-before-handler');
    return await this.#invokeStarted(
      invocation,
      runtime,
      descriptor,
      executionAuthorization,
      callerSignal,
      false,
      false,
      preparationInterruption,
    );
  }

  async #resumeStarted(
    invocation: AgentInvocationProjection,
    authorization: ToolInvocationAuthorization,
    recoverHandler = false,
  ): Promise<AgentInvocationProjection> {
    const descriptor = this.#requireDescriptor(invocation);
    const runtime = this.#requireHandlerRuntime(invocation);
    return await this.#invokeStarted(
      invocation,
      runtime,
      descriptor,
      authorization,
      undefined,
      recoverHandler,
      true,
    );
  }

  async #invokeStarted(
    invocation: AgentInvocationProjection,
    runtime: ToolInvocationHandlerRuntime,
    descriptor: AgentToolDescriptor,
    authorization: ToolInvocationAuthorization,
    callerSignal: AbortSignal | undefined,
    useRecoveryHandler: boolean,
    recoveringAttempt = false,
    preparationInterruption: ToolPreparationInterruption | undefined = undefined,
  ): Promise<AgentInvocationProjection> {
    if (invocation.started === undefined) {
      throw new ToolInvocationError('INVOCATION_CONFLICT', 'Invocation start fact is missing.');
    }
    const committedStart = invocation.started;
    const intent = this.#prepared(invocation);
    const attemptPolicy = Object.freeze({ mode: authorization.policyMode, revision: authorization.policyRevision });
    const assertAttemptPolicy = () => {
      const current = this.#permissionManager.snapshot(this.#binding.mode);
      if (attemptPolicy.mode !== current.mode || attemptPolicy.revision !== current.revision ||
          intent.runPolicy && (intent.runPolicy.mode !== attemptPolicy.mode || intent.runPolicy.revision !== attemptPolicy.revision)) {
        throw new ToolExecutionError({ code: 'target_changed', category: 'precondition', retryable: true, outcome: 'not_applied' }, 'The prepared Run policy changed; prepare the action again.');
      }
    };
    const remainingMs = Date.parse(invocation.deadline!) - this.#now();
    const linked = linkedAbortController(
      callerSignal,
      Math.max(0, remainingMs),
      preparationInterruption,
    );
    const stopLeaseWatch = watchLease(
      this.#journal,
      this.#binding,
      this.#leasePollIntervalMs,
      () => linked.loseLease(),
      this.#now,
    );
    const argumentsRecord = this.#prepared(invocation).input;
    const runtimeState = await this.#runtimeState();
    const progress = new ToolProgressPublisher({
      signal: linked.controller.signal,
      publish: async (batchOrdinal, summary) => {
        try {
          await this.#toolLifecycle.commit({
            action: 'progress',
            projectId: invocation.projectId,
            sessionId: invocation.sessionId,
            runId: invocation.runId,
            turnId: invocation.turnId,
            invocationId: invocation.invocationId,
            commandId:
              `tool-progress:${invocation.invocationId}:${committedStart.attempt}:${batchOrdinal}`,
            lease: leaseReference(this.#binding.lease),
            expectedRunRevision: committedStart.runRevision,
            expectedInvocationRevision: invocation.revision,
            idempotencyKey: committedStart.idempotencyKey,
            attempt: committedStart.attempt,
            summary,
          });
        } catch {
          // Progress is diagnostic. A rejected/stale/busy progress append must
          // never reinterpret the Handler's external outcome. The terminal
          // commit remains the authoritative success/failure boundary.
        }
      },
    });
    const context = Object.freeze<ToolExecuteContext>({
      hostId: this.#hostId,
      intent,
      deadline: invocation.deadline!,
      projectId: invocation.projectId,
      sessionId: invocation.sessionId,
      runId: invocation.runId,
      turnId: invocation.turnId,
      invocationId: invocation.invocationId,
      idempotencyKey: invocation.started.idempotencyKey,
      fencingToken: this.#binding.lease.fencingToken,
      startedAt: invocation.started.startedAt,
      runtimeState,
      ...(callerSignal === undefined ? {} : { runSignal: callerSignal }),
      authorization,
      discoverableTools: this.#discoverableTools,
      discoverableCapabilities: this.#discoverableCapabilities,
      reportProgress: (summary) => progress.report(summary),
      signal: linked.controller.signal,
    });
    const handler = useRecoveryHandler ? runtime.recover : runtime.execute;
    if (handler === undefined) return await this.#finishUnknown(invocation);
    const releaseGeneration = this.#registry.retainExecution();
    const drain = new ToolExecutionDrain();
    let execution: ReturnType<typeof startToolHandlerExecution> | undefined;
    let resourceLease: ToolResourceLease | undefined;
    let handlerCompleted = false;
    let preparedArtifact: PreparedToolArtifactCommit | undefined;
    let retainedContent: Readonly<{ contentType: string; totalBytes: number }> | undefined;
    let retainedIdentity: string | undefined;
    let atomicRuntimeCommand: RuntimeCommand | undefined;
    let needsTerminalCommit = true;
    let terminal:
      | { outcome: 'succeeded'; summary: string; resultRefs: string[]; durableSummary: PortableValue;
          evidenceRefs: string[]; modelProjection: PortableValue; userProjection?: PortableValue;
          auditEvidence?: AgentToolAuditEvidence;
          completionEvidence?: AgentToolCompletionEvidence }
      | { outcome: 'failed' | 'cancelled' | 'unknown' | 'timed_out' | 'unsupported_revision'; summary: string;
          resultRefs: []; evidenceRefs: []; error: ToolExecutionErrorFact };
    try {
      assertAttemptPolicy();
      if (!effectiveAuthorization(authorization)) {
        throw new ToolExecutionError(
          {
            code: 'TOOL_PERMISSION_DENIED',
            category: 'authorization',
            retryable: true,
            outcome: 'not_applied',
          },
          'Tool authorization changed before execution. Reissue the action to apply the current permission policy.',
        );
      }
      if (remainingMs <= 0) throw new ToolExecutionError({ code: 'TOOL_TIMEOUT', category: 'timeout', retryable: true, outcome: 'not_applied' }, 'The prepared invocation deadline expired.');
      resourceLease = await this.#boundary.acquire(intent, context, drain);
      assertAttemptPolicy();
      execution = startToolHandlerExecution(handler, argumentsRecord, context);
      void drain.track(execution.settled);
      const value = await execution.result;
      handlerCompleted = true;
      const question = readToolQuestionWaitRequest(value);
      if (question !== undefined) {
        const waiting = await this.#waitForUser(invocation, descriptor, question);
        needsTerminalCommit = false;
        return waiting;
      }
      const sealedCommand = readSealedRuntimeCommandToolResult(value);
      const normalizeResult = (candidate: unknown) => normalizeAgentToolResult(candidate, {
        outputSchema: descriptor.outputSchema,
        limits: intent.limits,
        provenance: {
          issuer: 'runtime',
          hostId: this.#hostId,
          sessionId: invocation.sessionId,
          runId: invocation.runId,
          invocationId: invocation.invocationId,
          toolName: invocation.name,
          toolRevision: intent.toolRevision,
          handlerRevision: intent.handlerRevision,
          intentRevision: intent.intentRevision,
          source: descriptor.source,
          ...(descriptor.sourceId === undefined ? {} : { sourceId: descriptor.sourceId }),
          generation: intent.generation,
        },
        ...(this.#resultProjectionBudget === undefined
          ? {}
          : { projectionBudget: this.#resultProjectionBudget }),
        signal: context.signal,
        deadline: context.deadline,
        now: this.#now,
      });
      const resultRefs: string[] = [];
      let contentRef: string | undefined;
      let evidenceRef: string | undefined;
      let sealedResult: PortableValue | undefined;
      if (sealedCommand !== undefined) {
        sealedResult = sealedCommand.result;
        if (sealedCommand.content !== undefined) {
          if (requiresPostCommitExecutor(sealedCommand.command.kind)) {
            throw invalidToolResultError();
          }
          if (
            sealedResult === null || typeof sealedResult !== 'object' || Array.isArray(sealedResult) ||
            !/^[A-Za-z][A-Za-z0-9_]{0,127}$/u.test(sealedCommand.content.referenceField) ||
            Object.hasOwn(sealedResult, sealedCommand.content.referenceField)
          ) {
            throw invalidToolResultError();
          }
          const contentBytes = new TextEncoder().encode(sealedCommand.content.body);
          if (contentBytes.byteLength > intent.limits.maxArtifactBytes) {
            throw invalidToolResultError();
          }
          if (this.#artifactStore === undefined || this.#artifactCommitter === undefined) {
            throw invalidToolResultError();
          }
          const staged = await this.#artifactStore.stage({
            mediaType: sealedCommand.content.contentType,
            source: bytesSource(contentBytes),
            expectedByteSize: contentBytes.byteLength,
            owner: {
              hostId: this.#hostId,
              projectId: invocation.projectId,
              sessionId: invocation.sessionId,
              runId: invocation.runId,
              invocationId: invocation.invocationId,
            },
            signal: context.signal,
            deadline: context.deadline,
          });
          assertExecutionContextActive(context, this.#now);
          if (staged.contentRef === undefined || staged.evidence === undefined) {
            throw invalidToolResultError();
          }
          contentRef = staged.contentRef;
          evidenceRef = staged.evidence.evidenceRef;
          preparedArtifact = await this.#artifactCommitter.prepare({
            staged,
            summary: 'Runtime Tool content.',
            sessionId: invocation.sessionId,
            runId: invocation.runId,
            turnId: invocation.turnId,
            invocationId: invocation.invocationId,
            startedAttempt: committedStart.attempt,
            idempotencyKey: committedStart.idempotencyKey,
            fencingToken: committedStart.fencingToken,
            signal: context.signal,
            deadline: context.deadline,
          });
          resultRefs.push(staged.handle);
          retainedContent = Object.freeze({
            contentType: sealedCommand.content.contentType,
            totalBytes: contentBytes.byteLength,
          });
          sealedResult = {
            ...sealedResult,
            [sealedCommand.content.referenceField]: contentRef,
          };
        }
        // A durable Runtime command must never commit behind an invalid result.
        // For retained content this validates the Runtime-issued reference,
        // never a Handler-supplied placeholder.
        const candidate = normalizeResult(sealedResult);
        if (candidate.artifactBytes !== undefined) throw invalidToolResultError();
      }
      let resultValue: unknown = value;
      if (sealedCommand !== undefined) {
        const command = await this.#issueRuntimeCommand(invocation, sealedCommand.command);
        if (requiresPostCommitExecutor(command.kind)) {
          resultValue = await this.#applyIssuedRuntimeCommand(command, sealedResult!, context);
        } else {
          atomicRuntimeCommand = command;
          resultValue = sealedResult!;
        }
      }
      assertExecutionContextActive(context, this.#now);
      await this.#crashPoint('after-external-recoveryClass-before-terminal');
      const normalized = normalizeResult(resultValue);
      assertExecutionContextActive(context, this.#now);
      let domainContent: ToolRetainedResultContent | undefined;
      if (runtime.retainResult !== undefined) {
        const retention = startToolResultRetention(runtime.retainResult, normalized.payload, context);
        void drain.track(retention.settled);
        domainContent = normalizeRetainedResultContent(
          await retention.result,
          intent.limits.maxArtifactBytes,
        );
        assertExecutionContextActive(context, this.#now);
      }
      if (domainContent !== undefined) {
        if (
          normalized.artifactBytes !== undefined || preparedArtifact !== undefined ||
          retainedContent !== undefined || this.#artifactStore === undefined ||
          this.#artifactCommitter === undefined
        ) {
          throw invalidToolResultError();
        }
        const staged = await this.#artifactStore.stage({
          mediaType: domainContent.mediaType,
          source: boundedRetainedResultSource(
            domainContent.source,
            intent.limits.maxArtifactBytes,
            context,
            this.#now,
          ),
          ...(domainContent.expectedByteSize === undefined
            ? {}
            : { expectedByteSize: domainContent.expectedByteSize }),
          ...(domainContent.expectedChecksum === undefined
            ? {}
            : { expectedChecksum: domainContent.expectedChecksum }),
          owner: {
            hostId: this.#hostId,
            projectId: invocation.projectId,
            sessionId: invocation.sessionId,
            runId: invocation.runId,
            invocationId: invocation.invocationId,
          },
          signal: context.signal,
          deadline: context.deadline,
        });
        assertExecutionContextActive(context, this.#now);
        if (staged.contentRef === undefined || staged.evidence === undefined) {
          throw invalidToolResultError();
        }
        contentRef = staged.contentRef;
        evidenceRef = staged.evidence.evidenceRef;
        preparedArtifact = await this.#artifactCommitter.prepare({
          staged,
          summary: 'Retained Tool result content.',
          sessionId: invocation.sessionId,
          runId: invocation.runId,
          turnId: invocation.turnId,
          invocationId: invocation.invocationId,
          startedAttempt: committedStart.attempt,
          idempotencyKey: committedStart.idempotencyKey,
          fencingToken: committedStart.fencingToken,
          signal: context.signal,
          deadline: context.deadline,
        });
        resultRefs.push(staged.handle);
        retainedContent = Object.freeze({
          contentType: staged.mediaType,
          totalBytes: staged.byteSize,
        });
        retainedIdentity = domainContent.identity;
      }
      if (normalized.artifactBytes !== undefined) {
        if (preparedArtifact !== undefined || retainedContent !== undefined) {
          throw invalidToolResultError();
        }
        if (this.#artifactStore === undefined) throw invalidToolResultError();
        const staged = await this.#artifactStore.stage({
          mediaType: normalized.contentType,
          source: bytesSource(normalized.artifactBytes),
          expectedByteSize: normalized.totalBytes,
          owner: {
            hostId: this.#hostId,
            projectId: invocation.projectId,
            sessionId: invocation.sessionId,
            runId: invocation.runId,
            invocationId: invocation.invocationId,
          },
          signal: context.signal,
          deadline: context.deadline,
        });
        assertExecutionContextActive(context, this.#now);
        if (staged.contentRef === undefined || staged.evidence === undefined) {
          throw invalidToolResultError();
        }
        contentRef = staged.contentRef;
        evidenceRef = staged.evidence.evidenceRef;
        if (this.#artifactCommitter === undefined) throw invalidToolResultError();
        preparedArtifact = await this.#artifactCommitter.prepare({
          staged,
          summary: 'Tool result artifact.',
          sessionId: invocation.sessionId,
          runId: invocation.runId,
          turnId: invocation.turnId,
          invocationId: invocation.invocationId,
          startedAttempt: committedStart.attempt,
          idempotencyKey: committedStart.idempotencyKey,
          fencingToken: committedStart.fencingToken,
          signal: context.signal,
          deadline: context.deadline,
        });
        resultRefs.push(staged.handle);
      }
      const projected = materializeNormalizedToolResult(normalized, {
        ...(contentRef === undefined ? {} : { contentRef }),
        ...(evidenceRef === undefined ? {} : { evidenceRef }),
        ...(retainedContent === undefined ? {} : { retainedContent }),
      });
      assertExecutionContextActive(context, this.#now);
      const completionReady = descriptor.completion?.role === 'deliverable' &&
        retainedIdentity !== undefined && projected.evidenceRefs.length > 0;
      const toolOwnerId = this.#registry.ownerId(invocation.name);
      let completionEvidence: AgentToolCompletionEvidence | undefined;
      if (completionReady) {
        if (
          descriptor.completion === undefined || retainedIdentity === undefined ||
          toolOwnerId === undefined
        ) throw invalidToolResultError();
        completionEvidence = Object.freeze({
          kind: descriptor.completion.group ?? descriptor.flatName,
          deliveryReady: true,
          outcome: 'succeeded' as const,
          provenance: Object.freeze({
            issuer: 'runtime' as const,
            ownerId: toolOwnerId,
            toolName: invocation.name,
            toolRevision: intent.toolRevision,
            handlerRevision: intent.handlerRevision,
            intentRevision: intent.intentRevision,
            toolSource: descriptor.source,
            ...(descriptor.sourceId === undefined ? {} : { sourceId: descriptor.sourceId }),
            generation: intent.generation,
          }),
          executionId: retainedIdentity,
          ...(retainedContent === undefined
            ? {}
            : { metrics: Object.freeze({ totalBytes: retainedContent.totalBytes }) }),
        });
      }
      terminal = {
        outcome: 'succeeded',
        summary: normalized.summary,
        resultRefs,
        evidenceRefs: [...projected.evidenceRefs],
        durableSummary: projected.durableSummary,
        modelProjection: projected.modelProjection,
        userProjection: projected.userProjection,
        ...(completionEvidence === undefined ? {} : { completionEvidence }),
      };
    } catch (error) {
      if (error instanceof ArtifactIoInterruption) void drain.track(error.cleanup);
      if (linked.leaseLost()) {
        needsTerminalCommit = false;
        throw new ToolInvocationError('LEASE_LOST', 'Run lease is no longer current.');
      }
      const mapped = adaptToolHandlerFailure({
        error,
        timedOut: linked.timedOut(),
        cancelled: !linked.timedOut() && linked.cancelled(),
      });
      const handlerStarted = execution?.hasStarted() === true;
      // Failure to replay/recover cannot establish that the interrupted attempt did
      // nothing, even if this attempt never reached its handler or reports not_applied.
      const outcomeUnknown = recoveringAttempt || (handlerStarted &&
        (handlerCompleted || error instanceof ToolHandlerAbort || mapped.fact.outcome === 'unknown'));
      const executionError: ToolExecutionErrorFact = outcomeUnknown
        ? { ...mapped.fact, outcome: 'unknown' }
        : !handlerStarted
          ? { ...mapped.fact, outcome: 'not_applied' }
          : mapped.fact;
      terminal = {
        outcome: outcomeUnknown
          ? 'unknown'
          : executionError.code === 'TOOL_TIMEOUT' ? 'timed_out' : executionError.code === 'TOOL_CANCELLED' ? 'cancelled' : 'failed',
        summary: mapped.message,
        resultRefs: [],
        evidenceRefs: [],
        error: executionError,
      };
      if (preparedArtifact !== undefined) {
        this.#artifactCommitter?.release(preparedArtifact);
        preparedArtifact = undefined;
      }
    } finally {
      if (resourceLease !== undefined) void this.#boundary.releaseAfterDrain(resourceLease, execution?.settled ?? Promise.resolve(), drain);
      try { await waitForResultBoundary(drain.track(progress.close()), context, this.#now); }
      catch { /* Diagnostic cleanup remains tracked; terminal publication must proceed. */ }
      if (!needsTerminalCommit) {
        drain.close(releaseGeneration);
        stopLeaseWatch();
        linked.close();
      }
    }
    try {
      const hookWarnings = await this.#runAfterHooks(invocation, descriptor, argumentsRecord, context, {
        outcome: terminal.outcome,
        summary: terminal.summary,
      }, drain);
      let committed: AgentInvocationProjection | undefined;
      const finishCommandId =
        `tool-finish:${invocation.invocationId}:${committedStart.attempt}:${this.#runtimeId}`;
      for (let retry = 0; retry < MAX_TOOL_RUN_CAS_RETRIES; retry += 1) {
        if (terminal.outcome === 'succeeded' && (this.#now() >= Date.parse(context.deadline) || context.signal.aborted)) {
          if (preparedArtifact !== undefined) this.#artifactCommitter?.release(preparedArtifact);
          preparedArtifact = undefined;
          terminal = {
            outcome: 'unknown', summary: 'The result deadline or cancellation boundary passed before durable completion.',
            resultRefs: [], evidenceRefs: [], error: { code: context.signal.aborted && !linked.timedOut() ? 'TOOL_CANCELLED' : 'TOOL_TIMEOUT',
              category: context.signal.aborted && !linked.timedOut() ? 'cancelled' : 'timeout', retryable: false, outcome: 'unknown' },
          };
        }
        try {
          const result = await this.#toolLifecycle.commit({
          action: 'finish',
        intentDigest: invocation.intentDigest!,
          projectId: invocation.projectId,
          sessionId: invocation.sessionId,
          runId: invocation.runId,
          turnId: invocation.turnId,
          invocationId: invocation.invocationId,
          commandId: finishCommandId,
          lease: leaseReference(this.#binding.lease),
          expectedRunRevision: await this.#runRevision(),
          expectedInvocationRevision: invocation.revision,
          outcome: terminal.outcome,
          summary: terminal.summary,
          resultRefs: terminal.resultRefs,
          evidenceRefs: terminal.evidenceRefs,
          ...('durableSummary' in terminal ? { durableSummary: terminal.durableSummary } : {}),
          ...('modelProjection' in terminal ? { modelProjection: terminal.modelProjection } : {}),
          ...('userProjection' in terminal && terminal.userProjection !== undefined
            ? { userProjection: terminal.userProjection }
            : {}),
          ...('auditEvidence' in terminal && terminal.auditEvidence !== undefined
            ? { auditEvidence: terminal.auditEvidence }
            : {}),
          ...('completionEvidence' in terminal && terminal.completionEvidence !== undefined
            ? { completionEvidence: terminal.completionEvidence }
            : {}),
          ...('error' in terminal ? { error: terminal.error } : {}),
          ...(hookWarnings.length === 0
            ? {}
            : { hookWarnings: hookWarnings.map((warning) => ({ ...warning })) }),
        }, preparedArtifact === undefined && (
          atomicRuntimeCommand === undefined || terminal.outcome !== 'succeeded'
        ) ? undefined : {
          ...(preparedArtifact === undefined ? {} : { preparedArtifacts: [preparedArtifact] }),
          ...(atomicRuntimeCommand === undefined || terminal.outcome !== 'succeeded'
            ? {}
            : { runtimeCommand: atomicRuntimeCommand }),
        });
          committed = result.invocation;
          break;
        } catch (error) {
          if (error instanceof AgentJournalError && error.code === 'COMMAND_CONFLICT' &&
              error.detail !== null && typeof error.detail === 'object' && !Array.isArray(error.detail) &&
              'reason' in error.detail && error.detail.reason === 'tool_deadline_exceeded') {
            if (preparedArtifact !== undefined) this.#artifactCommitter?.release(preparedArtifact);
            preparedArtifact = undefined;
            terminal = { outcome: 'unknown', summary: 'The persistent Tool deadline elapsed before the atomic result commit.',
              resultRefs: [], evidenceRefs: [], error: { code: 'TOOL_TIMEOUT', category: 'timeout', retryable: false, outcome: 'unknown' } };
            retry -= 1; // No transaction committed; retry once as a terminal fact without artifact authority.
            continue;
          }
          if (!isToolRunRevisionConflict(error)) throw mapJournalError(error);
          const current = await this.#requireBoundInvocation(invocation.invocationId, false);
          if (current.terminal !== undefined || current.observation !== undefined) {
            committed = current;
            break;
          }
          if (
            current.state !== 'started' || current.started === undefined ||
            current.started.idempotencyKey !== committedStart.idempotencyKey ||
            current.started.attempt !== committedStart.attempt
          ) {
            throw mapJournalError(error);
          }
          invocation = current;
          await Promise.resolve();
        }
      }
      if (committed === undefined) {
        throw new ToolInvocationError(
          'INVOCATION_CONFLICT',
          'Tool terminal commit could not converge after concurrent Run transitions.',
        );
      }
      await this.#crashPoint('after-terminal-before-observation');
      if (
        preparedArtifact !== undefined && this.#artifactCommitter !== undefined &&
        committed.terminal?.kind === 'succeeded'
      ) {
        try { await this.#artifactCommitter.complete(preparedArtifact); }
        catch (error) {
          if (!(error instanceof ArtifactIoInterruption)) throw error;
          // Success already committed atomically. Promotion remains owned and
          // recoverable; an expired foreground deadline cannot undo that fact.
          void drain.track(error.cleanup);
        }
      }
      return committed;
    } finally {
      if (preparedArtifact !== undefined) this.#artifactCommitter?.release(preparedArtifact);
      drain.close(releaseGeneration);
      stopLeaseWatch();
      linked.close();
    }
  }

  async #issueRuntimeCommand(
    invocation: AgentInvocationProjection,
    intent: Readonly<Pick<RuntimeCommand, 'kind' | 'payload'>>,
  ): Promise<RuntimeCommand> {
    if (!isRuntimeCommandKindOwnedByTool(invocation.name, intent.kind)) {
      throw invalidToolResultError();
    }
    const prior = invocation.started !== undefined && invocation.started.attempt > 1
      ? await this.#priorRuntimeCommandHeaders(
          invocation,
          `runtime-command:${invocation.invocationId}`,
        )
      : undefined;
    return createRuntimeCommandIssuer().issue({
      schemaVersion: 2,
      commandId: `runtime-command:${invocation.invocationId}`,
      origin: {
        runId: invocation.runId,
        turnId: invocation.turnId,
        invocationId: invocation.invocationId,
      },
      expectedRunRevision: prior?.expectedRunRevision ?? await this.#runRevision(),
      fencingToken: prior?.fencingToken ?? this.#binding.lease.fencingToken,
      kind: intent.kind,
      payload: intent.payload,
    } as RuntimeCommand);
  }

  async #applyIssuedRuntimeCommand(
    command: RuntimeCommand,
    result: PortableValue,
    context: ToolExecuteContext,
  ): Promise<PortableValue> {
    if (!requiresPostCommitExecutor(command.kind)) {
      throw new Error(`Runtime Command ${command.kind} does not use a post-commit executor.`);
    }
    if (this.#runtimeCommandExecutor === undefined) {
      throw new Error(`Runtime Command ${command.kind} requires a post-commit executor.`);
    }
    const application = await openRuntimeCommandApplication(this.#journal).apply(command);
    const resolved = await this.#runtimeCommandExecutor({
      command,
      application,
      handlerResult: result,
      context,
    });
    return resolved === undefined ? result : resolved;
  }

  async #runBeforeHooks(
    invocation: AgentInvocationProjection,
    descriptor: AgentToolDescriptor,
    argumentsRecord: Readonly<Record<string, unknown>>,
    authorization: ToolInvocationAuthorization,
    signal: AbortSignal,
  ): Promise<Readonly<{ hookId: string; hookRevision: string; summary: string }> | undefined> {
    if (this.#invocationHooks.length === 0) return undefined;
    const input = hookInput(invocation, descriptor, argumentsRecord, authorization, signal);
    for (const hook of this.#invocationHooks) {
      if (hook.before === undefined) continue;
      try {
        const result = await hook.before(input);
        if (result !== undefined) {
          const summary = boundedHookSummary(result.reject, 'Invocation rejected by policy.');
          return { hookId: hook.id, hookRevision: hook.revision, summary };
        }
      } catch {
        return {
          hookId: hook.id,
          hookRevision: hook.revision,
          summary: 'Invocation policy could not be evaluated.',
        };
      }
    }
    return undefined;
  }

  async #runAfterHooks(
    invocation: AgentInvocationProjection,
    descriptor: AgentToolDescriptor,
    argumentsRecord: Readonly<Record<string, unknown>>,
    context: ToolInvocationExecutionContext & Pick<ToolExecuteContext, 'deadline'>,
    terminal: Readonly<{
      outcome: 'succeeded' | 'failed' | 'cancelled' | 'unknown' | 'timed_out' | 'unsupported_revision';
      summary: string;
    }>,
    drain: ToolExecutionDrain,
  ): Promise<ReadonlyArray<Readonly<{
    hookId: string;
    hookRevision: string;
    summary: string;
  }>>> {
    const warnings: Array<{ hookId: string; hookRevision: string; summary: string }> = [];
    const input = {
      ...hookInput(
        invocation,
        descriptor,
        argumentsRecord,
        context.authorization,
        context.signal,
      ),
      ...terminal,
    };
    for (const hook of this.#invocationHooks) {
      if (hook.after === undefined) continue;
      try {
        assertExecutionContextActive(context, this.#now);
        await waitForResultBoundary(drain.track(Promise.resolve().then(() => hook.after!(Object.freeze(input)))), context, this.#now);
      } catch {
        warnings.push({
          hookId: hook.id,
          hookRevision: hook.revision,
          summary: 'A post-execution observer could not record its result.',
        });
      }
    }
    return Object.freeze(warnings.map((warning) => Object.freeze(warning)));
  }

  async #priorRuntimeCommandHeaders(
    invocation: AgentInvocationProjection,
    commandId: string,
  ): Promise<Readonly<{ expectedRunRevision: number; fencingToken: number }> | undefined> {
    let afterSequence = 0;
    while (true) {
      const events = await this.#journal.readProject(invocation.projectId, afterSequence, 10_000);
      for (const event of events) {
        if (
          event.type === 'runtime.command_applied' &&
          event.runId === invocation.runId &&
          event.invocationId === invocation.invocationId &&
          event.payload.commandId === commandId
        ) {
          return Object.freeze({
            expectedRunRevision: event.payload.expectedRunRevision,
            fencingToken: event.payload.fencingToken,
          });
        }
      }
      if (events.length < 10_000) return undefined;
      afterSequence = events.at(-1)?.sequence ?? afterSequence;
    }
  }

  async #finishUnsupportedRevision(invocation: AgentInvocationProjection): Promise<AgentInvocationProjection> {
    const started = invocation.started!;
    const result = await this.#toolLifecycle.commit({
      action: 'finish', intentDigest: invocation.intentDigest!,
      projectId: invocation.projectId, sessionId: invocation.sessionId, runId: invocation.runId,
      turnId: invocation.turnId, invocationId: invocation.invocationId,
      commandId: `tool-unsupported:${invocation.invocationId}:${started.attempt}`,
      lease: leaseReference(this.#binding.lease), expectedRunRevision: await this.#runRevision(),
      expectedInvocationRevision: invocation.revision, outcome: 'unsupported_revision',
      summary: 'The exact persisted Tool, handler or intent revision is unavailable.',
      resultRefs: [], evidenceRefs: [],
      error: { code: 'TOOL_REVISION_MISMATCH', category: 'contract', retryable: false, outcome: 'unknown' },
      ...(started.fencingToken === this.#binding.lease.fencingToken ? {} : { interruptedFencingToken: started.fencingToken }),
    });
    return result.invocation;
  }

  async #finishUnknown(invocation: AgentInvocationProjection): Promise<AgentInvocationProjection> {
    if (invocation.started === undefined) {
      throw new ToolInvocationError('INVOCATION_CONFLICT', 'Invocation start fact is missing.');
    }
    try {
      const result = await this.#toolLifecycle.commit({
        action: 'finish',
        intentDigest: invocation.intentDigest!,
        projectId: invocation.projectId,
        sessionId: invocation.sessionId,
        runId: invocation.runId,
        turnId: invocation.turnId,
        invocationId: invocation.invocationId,
        commandId: `tool-unknown:${invocation.invocationId}:${invocation.started.attempt}:${this.#runtimeId}`,
        lease: leaseReference(this.#binding.lease),
        expectedRunRevision: await this.#runRevision(),
        expectedInvocationRevision: invocation.revision,
        outcome: 'unknown',
        summary: 'The tool outcome is unknown after interruption.',
        resultRefs: [],
        evidenceRefs: [],
        error: {
          code: 'HANDLER_FAILED', category: 'internal', retryable: false, outcome: 'unknown',
        },
        ...(invocation.started.fencingToken === this.#binding.lease.fencingToken
          ? {}
          : { interruptedFencingToken: invocation.started.fencingToken }),
      });
      return result.invocation;
    } catch (error) {
      throw mapJournalError(error);
    }
  }

  async #finishInterruptedCancellation(
    invocation: AgentInvocationProjection,
  ): Promise<AgentInvocationProjection> {
    const started = invocation.started;
    if (invocation.state !== 'started' || started === undefined) {
      throw new ToolInvocationError('INVOCATION_CONFLICT', 'Invocation start fact is missing.');
    }
    // A durable start without a terminal fact proves neither cancellation nor not_applied.
    // Recovery class controls replay/recover eligibility, not the outcome of that lost attempt.
    // Even a replayable read has no confirmed cancellation boundary here.
    const error: ToolExecutionErrorFact = {
      code: 'TOOL_CANCELLED',
      category: 'cancelled',
      retryable: false,
      outcome: 'unknown',
    };
    try {
      const result = await this.#toolLifecycle.commit({
        action: 'finish',
        intentDigest: invocation.intentDigest!,
        projectId: invocation.projectId,
        sessionId: invocation.sessionId,
        runId: invocation.runId,
        turnId: invocation.turnId,
        invocationId: invocation.invocationId,
        commandId:
          `tool-cancel-recovery:${invocation.invocationId}:${started.attempt}:${this.#runtimeId}`,
        lease: leaseReference(this.#binding.lease),
        expectedRunRevision: await this.#runRevision(),
        expectedInvocationRevision: invocation.revision,
        outcome: 'unknown',
        summary: 'The Run was cancelled and the interrupted Tool outcome is unknown.',
        resultRefs: [],
        evidenceRefs: [],
        error,
        ...(started.fencingToken === this.#binding.lease.fencingToken
          ? {}
          : { interruptedFencingToken: started.fencingToken }),
      });
      return result.invocation;
    } catch (errorValue) {
      throw mapJournalError(errorValue);
    }
  }

  async #waitForUser(invocation: AgentInvocationProjection, descriptor: AgentToolDescriptor, bundle: ToolQuestionBundle): Promise<AgentInvocationProjection> {
    validateToolQuestionBundle(bundle);
    if (invocation.name !== 'ask_user' || descriptor.source !== 'runtime' || descriptor.toolRevision !== 'ask_user.v1' || bundle.owner.hostId !== this.#hostId || JSON.stringify(bundle) !== JSON.stringify(this.#prepared(invocation).input.bundle)) throw invalidToolResultError();
    const result = await this.#toolLifecycle.commit({
      action: 'wait-for-user', projectId: invocation.projectId, sessionId: invocation.sessionId,
      runId: invocation.runId, turnId: invocation.turnId, invocationId: invocation.invocationId,
      commandId: `question-wait:${invocation.invocationId}`, lease: leaseReference(this.#binding.lease),
      expectedRunRevision: await this.#runRevision(), expectedInvocationRevision: invocation.revision,
      intentDigest: invocation.intentDigest!, bundle,
    });
    return result.invocation;
  }

  /** Host-only ingress. Never included in a Handler context or model command issuer. */
  async submitQuestion(invocationId: string, command: QuestionRuntimeCommand): Promise<ToolObservationFact> {
    const invocation = await this.#requireBoundInvocation(invocationId, false);
    const bundle = invocation.question;
    if (!bundle || bundle.owner.hostId !== this.#hostId || bundle.owner.projectId !== invocation.projectId || bundle.owner.sessionId !== invocation.sessionId || bundle.owner.runId !== invocation.runId || bundle.owner.turnId !== invocation.turnId || bundle.owner.invocationId !== invocationId) throw new ToolInvocationError('INVOCATION_CONFLICT', 'Question owner does not match this Host/Run.');
    command = normalizeQuestionCommand(command, bundle);
    const digest = questionCommandDigest(command);
    if (invocation.observation) {
      const summary = invocation.terminal?.durableSummary;
      if (summary && typeof summary === 'object' && !Array.isArray(summary) && (summary as Record<string, PortableValue>).questionCommandDigest === digest) return publicObservation(invocation.observation);
      throw new ToolInvocationError('INVOCATION_CONFLICT', 'Question already has a different resolution.');
    }
    if (invocation.state !== 'waiting_for_user') throw new ToolInvocationError('INVOCATION_CONFLICT', 'Question is not pending.');
    let descriptor: AgentToolDescriptor | undefined;
    if (command.kind === 'question.answer') {
      try { descriptor = this.#requireDescriptor(invocation); }
      catch (error) {
        if (!(error instanceof ToolInvocationError) || !isPreStartResolutionError(error)) throw error;
      }
    }
    const outcome = command.kind === 'question.answer' ? descriptor === undefined ? 'unsupported_revision' : 'succeeded' : command.kind === 'question.timeout' ? 'timed_out' : 'cancelled';
    const summary = outcome === 'unsupported_revision' ? 'The captured question Tool revision is unavailable.' : outcome === 'succeeded' ? 'The user answered the questions.' : outcome === 'timed_out' ? 'The user question deadline expired.' : 'The user question was cancelled.';
    let modelProjection: PortableValue | undefined;
    let userProjection: PortableValue | undefined;
    let durableSummary: Record<string, PortableValue> = { questionCommandDigest: digest };
    if (command.kind === 'question.answer' && descriptor !== undefined) {
      const normalized = normalizeAgentToolResult({ status: 'ok', summary, questionId: bundle.questionId, questionRevision: bundle.questionRevision, answers: command.answers }, {
        outputSchema: descriptor.outputSchema, limits: this.#prepared(invocation).limits,
        provenance: { issuer: 'runtime', hostId: this.#hostId, sessionId: invocation.sessionId, runId: invocation.runId, invocationId, toolName: invocation.name, toolRevision: descriptor.toolRevision, handlerRevision: descriptor.handlerRevision, intentRevision: descriptor.intentRevision, source: descriptor.source, ...(descriptor.sourceId === undefined ? {} : { sourceId: descriptor.sourceId }), generation: this.#prepared(invocation).generation },
        ...(this.#resultProjectionBudget === undefined
          ? {}
          : { projectionBudget: this.#resultProjectionBudget }),
        deadline: invocation.deadline!,
        now: this.#now,
      });
      const projected = materializeNormalizedToolResult(normalized);
      modelProjection = projected.modelProjection;
      userProjection = projected.userProjection;
      durableSummary = { ...(projected.durableSummary as Record<string, PortableValue>), questionCommandDigest: digest };
    }
    const error: ToolExecutionErrorFact | undefined = outcome === 'succeeded' ? undefined : { code: outcome === 'unsupported_revision' ? 'TOOL_REVISION_MISMATCH' : outcome === 'timed_out' ? 'TOOL_TIMEOUT' : 'TOOL_CANCELLED', category: outcome === 'unsupported_revision' ? 'unavailable' : outcome === 'timed_out' ? 'timeout' : 'cancelled', retryable: false, outcome: 'not_applied' };
    const observation: ToolObservationFact = { observationId: `observation_${sha256(invocationId)}`, invocationId, summary, evidenceRefs: [], outcome, ...(modelProjection === undefined ? {} : { modelProjection }), ...(error === undefined ? {} : { errorCode: error.code }) };
    const result = await this.#toolLifecycle.commit({
      action: 'settle-question', projectId: invocation.projectId, sessionId: invocation.sessionId, runId: invocation.runId, turnId: invocation.turnId, invocationId,
      commandId: `question-settle:${sha256(`${invocationId}:${command.commandId}`)}`, lease: leaseReference(this.#binding.lease),
      expectedRunRevision: await this.#runRevision(), expectedInvocationRevision: invocation.revision,
      intentDigest: invocation.intentDigest!, questionCommand: command, observation, outcome, summary, resultRefs: [], evidenceRefs: [], durableSummary,
      ...(modelProjection === undefined ? {} : { modelProjection }), ...(userProjection === undefined ? {} : { userProjection }), ...(error === undefined ? {} : { error }),
    });
    return publicObservation(result.invocation.observation!);
  }

  async #observe(
    invocation: AgentInvocationProjection,
    modelProjection?: PortableValue,
  ): Promise<ToolObservationFact> {
    if (invocation.observation !== undefined) return publicObservation(invocation.observation);
    const terminal = invocation.terminal;
    if (terminal === undefined) {
      throw new ToolInvocationError('INVOCATION_CONFLICT', 'Invocation has no terminal fact.');
    }
    const effectiveModelProjection = modelProjection ?? terminal.modelProjection;
    const observation: ToolObservationFact = {
      observationId: `observation_${sha256(invocation.invocationId)}`,
      invocationId: invocation.invocationId,
      summary: terminal.summary,
      evidenceRefs: normalizeAgentEvidenceRefs(terminal.evidenceRefs),
      outcome: terminal.kind,
      ...(effectiveModelProjection === undefined
        ? {}
        : { modelProjection: structuredClone(effectiveModelProjection) }),
      ...(terminal.auditEvidence === undefined
        ? {}
        : { auditEvidence: structuredClone(terminal.auditEvidence) }),
      ...(terminal.completionEvidence === undefined
        ? {}
        : { completionEvidence: structuredClone(terminal.completionEvidence) }),
      ...(terminal.error === undefined ? {} : { errorCode: terminal.error.code }),
    };
    for (let retry = 0; retry < MAX_TOOL_RUN_CAS_RETRIES; retry += 1) {
      try {
        const result = await this.#toolLifecycle.commit({
          action: 'observe',
          projectId: invocation.projectId,
          sessionId: invocation.sessionId,
          runId: invocation.runId,
          turnId: invocation.turnId,
          invocationId: invocation.invocationId,
          commandId: `tool-observe:${invocation.invocationId}`,
          lease: leaseReference(this.#binding.lease),
          expectedRunRevision: await this.#runRevision(),
          expectedInvocationRevision: invocation.revision,
          observation,
        });
        return publicObservation(result.invocation.observation ?? observation);
      } catch (error) {
        if (!isToolRunRevisionConflict(error)) throw mapJournalError(error);
        const current = await this.#requireBoundInvocation(invocation.invocationId, false);
        if (current.observation !== undefined) return publicObservation(current.observation);
        if (current.terminal === undefined) throw mapJournalError(error);
        invocation = current;
        await Promise.resolve();
      }
    }
    throw new ToolInvocationError(
      'INVOCATION_CONFLICT',
      'Tool Observation commit could not converge after concurrent Run transitions.',
    );
  }

  async #applyObservationDecision(
    invocationIds: readonly string[],
  ): Promise<ToolObservationFact[]> {
    const observations: ToolObservationFact[] = [];
    for (const invocationId of invocationIds) {
      const invocation = await this.#requireBoundInvocation(invocationId);
      observations.push(await this.#observe(invocation));
    }
    return observations;
  }

  async #applyUntilObserved(
    invocationId: string,
    signal: AbortSignal | undefined,
  ): Promise<ToolObservationFact> {
    const deadline = Date.now() + COMPETING_EXECUTION_WAIT_MS;
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        throw new ToolInvocationError('INVOCATION_CONFLICT', 'Observation wait was cancelled.');
      }
      const current = await this.#requireBoundInvocation(invocationId);
      if (current.observation !== undefined) return publicObservation(current.observation);
      const decision = await this.#currentDecision();
      if (decision.state === 'ApplyingObservations') {
        await this.#applyObservationDecision(decision.invocationIds);
        continue;
      }
      await delay(COMPETING_EXECUTION_POLL_MS, signal);
    }
    throw new ToolInvocationError(
      'INVOCATION_CONFLICT',
      'Invocation did not reach its ordered Observation phase.',
    );
  }

  async #convergeRecoveredObservation(
    invocation: AgentInvocationProjection,
  ): Promise<ToolObservationFact> {
    return await this.#applyUntilObserved(invocation.invocationId, undefined);
  }

  async #validateInvocation(
    invocationId: string,
    prepareOnly = false,
    callerSignal: AbortSignal | undefined = undefined,
    priorInterruption: ToolPreparationInterruption | undefined = undefined,
  ): Promise<ToolPreparationInterruption | undefined> {
    let invocation = await this.#requireBoundInvocation(invocationId);
    if (invocation.state !== 'proposed' && invocation.state !== 'prepared') return undefined;
    let descriptor: AgentToolDescriptor;
    let interruption = priorInterruption;
    try {
      descriptor = this.#requireDescriptor(invocation);
      if (invocation.state === 'proposed') {
        const runtime = this.#requireHandlerRuntime(invocation);
        validateInvocationInput(invocation.arguments, descriptor.limits);
        const args = frozenArguments(invocation.arguments) as Readonly<Record<string, PortableValue>>;
        const prepareDrain = new ToolExecutionDrain();
        const releasePrepareGeneration = this.#registry.retainExecution();
        let prepared: Awaited<ReturnType<ToolInvocationPreparer['prepare']>>;
        try {
          prepared = await this.#preparer.prepare(runtime, args, {
            hostId: this.#hostId,
            runPolicy: this.#permissionManager.snapshot(this.#binding.mode),
            projectId: invocation.projectId, sessionId: invocation.sessionId,
            runId: invocation.runId, turnId: invocation.turnId, invocationId: invocation.invocationId,
            idempotencyKey: stableIdempotencyKey(invocation),
            generation: String(this.#registry.toolGeneration(invocation.name)),
            descriptor, toolRevision: descriptor.toolRevision, handlerRevision: descriptor.handlerRevision,
            intentRevision: 'prepared-tool-intent.v1' as const, limits: descriptor.limits,
            runtimeState: await this.#runtimeState(),
            discoverableTools: this.#discoverableTools, discoverableCapabilities: this.#discoverableCapabilities,
            signal: callerSignal ?? new AbortController().signal,
          }, prepareDrain);
        } finally {
          // This follows the actual prepare Promise, not its abort/timeout race.
          prepareDrain.close(releasePrepareGeneration);
        }
        interruption ??= prepared.interruption;
        if (prepared.intent === undefined) {
          if (interruption === undefined) {
            throw new ToolInvocationError('INVOCATION_CONFLICT', 'Tool preparation ended without an intent.');
          }
          await this.#rejectBeforeStart(invocation, preparationInterruptionError(interruption));
          return interruption;
        }
        const intent = prepared.intent;
        const deadline = new Date(this.#now() + intent.limits.timeoutMs).toISOString();
        const catalogRevision = this.#registry.invocationRevision(invocation.name)!;
        assertPreparedLifecycleRepresentable(invocation, intent, descriptor.id, catalogRevision, deadline);
        const result = await this.#toolLifecycle.commit({
          action: 'prepare', projectId: invocation.projectId, sessionId: invocation.sessionId,
          runId: invocation.runId, turnId: invocation.turnId, invocationId: invocation.invocationId,
          commandId: `tool-prepare:${invocation.invocationId}:${invocation.revision}`,
          lease: leaseReference(this.#binding.lease), expectedRunRevision: await this.#runRevision(),
          expectedInvocationRevision: invocation.revision,
          canonicalToolId: structuredClone(descriptor.id),
          catalogRevision,
          intent, intentDigest: preparedIntentDigest(intent),
          deadline,
        });
        invocation = result.invocation;
      }
    } catch (error) {
      if (error instanceof AgentJournalError) throw mapJournalError(error);
      await this.#rejectBeforeStart(invocation, error instanceof ToolInvocationError ? error :
        new ToolInvocationError('TOOL_INPUT_INVALID', error instanceof Error ? error.message : 'Tool preparation failed.'));
      return undefined;
    }
    if (prepareOnly) return interruption;
    const intent = this.#prepared(invocation);
    const evaluation = this.#permissionManager.evaluate(this.#binding.mode, intent.permission);
    const completePermissionAudit = authorizationAudit({
      policyMode: evaluation.mode, policyDecision: evaluation.decision, policyRevision: evaluation.policyRevision,
      matchedRuleIds: evaluation.matchedRuleIds, permission: evaluation.facts,
    });
    const permissionAudit = {
      mode: completePermissionAudit.mode,
      policyRevision: completePermissionAudit.policyRevision,
      matchedRuleIds: completePermissionAudit.matchedRuleIds,
      facts: completePermissionAudit.facts,
    };
    await this.#toolLifecycle.commit({
      action: 'validate', projectId: invocation.projectId, sessionId: invocation.sessionId,
      runId: invocation.runId, turnId: invocation.turnId, invocationId: invocation.invocationId,
      commandId: `tool-authorize:${invocation.invocationId}:${invocation.revision}`,
      lease: leaseReference(this.#binding.lease), expectedRunRevision: await this.#runRevision(),
      expectedInvocationRevision: invocation.revision, canonicalToolId: structuredClone(descriptor.id),
      toolRevision: intent.toolRevision, recoveryClass: intent.recoveryClass,
      intentDigest: invocation.intentDigest!, authorization: evaluation.decision,
      permissionAudit,
      actionSummary: intent.action.summary,
      approvalSummary: permissionApprovalSummary(intent.action.summary, evaluation),
    });
    if (interruption !== undefined) {
      await this.#terminalForQualifiedInvocation(invocationId, callerSignal, interruption);
    }
    return interruption;
  }

  #prepared(invocation: AgentInvocationProjection): PreparedToolIntent {
    if (invocation.intent === undefined || invocation.intentDigest === undefined || invocation.deadline === undefined) {
      throw new ToolInvocationError('TOOL_REVISION_MISMATCH', 'Persisted prepared intent is unavailable.');
    }
    assertPreparedDigest(invocation.intent, invocation.intentDigest);
    return validatePreparedIntent(invocation.intent);
  }

  async #rejectBeforeStart(
    invocation: AgentInvocationProjection,
    error: ToolInvocationError,
    hookRejection?: Readonly<{ hookId: string; hookRevision: string; summary: string }>,
  ): Promise<AgentInvocationProjection> {
    const fact = resolutionErrorFact(error);
    const actionSummary = createToolActionSummary(
      this.#registry.get(invocation.name)?.descriptor,
      invocation.name,
      invocation.arguments,
    );
    try {
      const result = await this.#toolLifecycle.commit({
        action: 'reject-validation',
        projectId: invocation.projectId,
        sessionId: invocation.sessionId,
        runId: invocation.runId,
        turnId: invocation.turnId,
        invocationId: invocation.invocationId,
        commandId: `tool-reject:${invocation.invocationId}:${invocation.revision}:${fact.code}`,
        lease: leaseReference(this.#binding.lease),
        expectedRunRevision: await this.#runRevision(),
        expectedInvocationRevision: invocation.revision,
        actionSummary,
        summary: error.message,
        error: fact,
        ...(hookRejection === undefined ? {} : { hookRejection }),
      });
      return result.invocation;
    } catch (commitError) {
      throw mapJournalError(commitError);
    }
  }

  #requireDescriptor(invocation: AgentInvocationProjection): AgentToolDescriptor {
    const allowedRevision = this.#allowedTools.get(invocation.name);
    if (allowedRevision === undefined) {
      throw new ToolInvocationError(
        'TOOL_NOT_FOUND',
        `Tool ${invocation.name} was not exposed in this Turn.`,
      );
    }
    const tool = this.#registry.get(invocation.name);
    if (tool === undefined) {
      throw new ToolInvocationError(invocation.intent === undefined ? 'TOOL_NOT_FOUND' : 'TOOL_REVISION_MISMATCH', 'Tool is unavailable in this exact snapshot.');
    }
    const revision = this.#registry.invocationRevision(invocation.name);
    if (revision !== allowedRevision ||
      invocation.catalogRevision !== undefined && revision !== invocation.catalogRevision
    ) {
      throw new ToolInvocationError('TOOL_REVISION_MISMATCH', 'Tool revision does not match.');
    }
    if (invocation.intent !== undefined && !this.#registry.supportsRevision({ toolName: invocation.name, toolRevision: invocation.intent.toolRevision, handlerRevision: invocation.intent.handlerRevision, intentRevision: invocation.intent.intentRevision })) throw new ToolInvocationError('TOOL_REVISION_MISMATCH', 'Prepared handler revision is unavailable.');
    return tool.descriptor;
  }

  async #authorization(
    invocation: AgentInvocationProjection,
  ): Promise<ToolInvocationAuthorization> {
    const permission = this.#prepared(invocation).permission;
    const approval = await this.#journal.getApproval({
      projectId: invocation.projectId,
      sessionId: invocation.sessionId,
      runId: invocation.runId,
      invocationId: invocation.invocationId,
    });
    const manuallyApproved = approval?.status === 'approved' && approval.intentDigest === invocation.intentDigest;
    const evaluation = this.#permissionManager.evaluate(this.#binding.mode, permission);
    return Object.freeze({
      policyMode: this.#binding.mode,
      policyDecision: evaluation.decision,
      policyRevision: evaluation.policyRevision,
      permission: evaluation.facts,
      matchedRuleIds: evaluation.matchedRuleIds,
      ...(manuallyApproved ? { approvalId: approval.approvalId } : {}),
    });
  }

  #requireHandlerRuntime(invocation: AgentInvocationProjection): ToolInvocationHandlerRuntime {
    const runtime = resolveInvocationHandler(this.#registry, invocation.name);
    if (runtime === undefined) {
      throw new ToolInvocationError(
        'TOOL_NOT_FOUND', `Tool ${invocation.name} has no Invocation Handler.`,
      );
    }
    return runtime;
  }

  async #waitForCompetingTerminal(
    invocationId: string,
    signal: AbortSignal | undefined,
  ): Promise<AgentInvocationProjection> {
    const deadline = Date.now() + COMPETING_EXECUTION_WAIT_MS;
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        throw new ToolInvocationError('INVOCATION_CONFLICT', 'Waiting execution was cancelled.');
      }
      const invocation = await this.#requireBoundInvocation(invocationId, false);
      if (invocation.observation !== undefined || invocation.terminal !== undefined) {
        return invocation;
      }
      await delay(COMPETING_EXECUTION_POLL_MS, signal);
    }
    throw new ToolInvocationError('INVOCATION_CONFLICT', 'Invocation is owned by another executor.');
  }

  async #boundInvocations(): Promise<AgentInvocationProjection[]> {
    const invocations: AgentInvocationProjection[] = [];
    let afterActionOrdinal = -1;
    for (;;) {
      const page = await this.#journal.listTurnInvocations({
        projectId: this.#binding.projectId,
        sessionId: this.#binding.sessionId,
        runId: this.#binding.runId,
        turnId: this.#binding.turnId,
        afterActionOrdinal,
        limit: INVOCATION_PAGE_SIZE,
      });
      invocations.push(...page);
      if (page.length < INVOCATION_PAGE_SIZE) return invocations;
      const last = page.at(-1);
      if (last === undefined || last.actionOrdinal <= afterActionOrdinal) {
        throw new ToolInvocationError(
          'INVOCATION_CONFLICT',
          'Invocation paging did not advance.',
        );
      }
      afterActionOrdinal = last.actionOrdinal;
    }
  }

  async #currentDecision(): Promise<ToolScheduleDecision> {
    const invocations = await this.#boundInvocations();
    return decideSchedule({
      maxConcurrency: this.#maxConcurrency,
      invocations: invocations.map((invocation) => ({
        invocationId: invocation.invocationId,
        actionOrdinal: invocation.actionOrdinal,
        state: scheduleState(invocation),
        recoveryClass: invocation.intent?.recoveryClass ?? 'unresolved',
        access: invocation.intent?.access ?? 'external',
        concurrency: invocation.intent?.concurrency ?? 'exclusive',
        resourceKeys: invocation.intent?.resourceKeys ?? [],
      })),
    });
  }

  async #requireBoundInvocation(
    invocationId: string,
    requireTurn = true,
  ): Promise<AgentInvocationProjection> {
    const invocation = await this.#journal.getInvocation(invocationId);
    if (
      invocation === null || invocation.projectId !== this.#binding.projectId ||
      invocation.sessionId !== this.#binding.sessionId || invocation.runId !== this.#binding.runId ||
      (requireTurn && invocation.turnId !== this.#binding.turnId)
    ) {
      throw new ToolInvocationError('INVOCATION_CONFLICT', 'Invocation scope does not match.');
    }
    return invocation;
  }

  async #runRevision(): Promise<number> {
    return (await this.#boundRunProjection()).revision;
  }

  async #runtimeState(): Promise<RuntimeCommandProjection> {
    const projection = await this.#journal.getRuntimeCommandProjection({
      projectId: this.#binding.projectId,
      sessionId: this.#binding.sessionId,
      runId: this.#binding.runId,
    });
    return projection ?? deepFreeze({
      schemaVersion: 2,
      projectId: this.#binding.projectId,
      sessionId: this.#binding.sessionId,
      runId: this.#binding.runId,
      revision: 0,
      plan: null,
      activeTools: [],
      discoveredCapabilities: [],
      activationBindings: [],
      activeSkills: [],
      children: [],
    });
  }

  async #runState(): Promise<AgentRunProjection['state']> {
    return (await this.#boundRunProjection()).state;
  }

  async #boundRunProjection(): Promise<AgentRunProjection> {
    const run = await this.#journal.getRunProjection(this.#binding.runId);
    if (
      run === null || run.projectId !== this.#binding.projectId ||
      run.sessionId !== this.#binding.sessionId
    ) {
      throw new ToolInvocationError('INVOCATION_CONFLICT', 'Run scope does not match.');
    }
    return run;
  }

  async #crashPoint(point: ToolInvocationCrashPoint): Promise<void> {
    await this.#onCrashPoint?.(point);
  }
}

function effectiveAuthorization(authorization: ToolInvocationAuthorization): boolean {
  return authorization.policyDecision === 'allow' ||
    (authorization.policyDecision === 'ask' && authorization.approvalId !== undefined);
}

function assertApprovalDecisionBinding(
  approval: ToolApprovalFact,
  decision: ToolApprovalDecision,
): void {
  if (
    approval.approvalId !== decision.approvalId ||
    approval.projectId !== decision.projectId ||
    approval.sessionId !== decision.sessionId ||
    approval.runId !== decision.runId ||
    approval.turnId !== decision.turnId ||
    approval.invocationId !== decision.invocationId ||
    canonicalUnknownJson(approval.canonicalToolId) !== canonicalUnknownJson(decision.canonicalToolId) ||
    approval.toolRevision !== decision.toolRevision ||
    approval.recoveryClass !== decision.recoveryClass ||
    approval.intentDigest !== decision.intentDigest ||
    approval.proposedRevision !== decision.proposedRevision
  ) {
    throw new ToolInvocationError(
      'APPROVAL_BINDING_MISMATCH', 'Approval decision does not match the exact request.',
    );
  }
}

function mapJournalError(error: unknown): ToolInvocationError {
  if (error instanceof ToolInvocationError) return error;
  if (!(error instanceof AgentJournalError)) {
    return new ToolInvocationError('INVOCATION_CONFLICT', 'Tool lifecycle commit failed.');
  }
  if (error.code === 'APPROVAL_BINDING_MISMATCH' || error.code === 'APPROVAL_NOT_FOUND') {
    return new ToolInvocationError('APPROVAL_BINDING_MISMATCH', 'Approval binding does not match.');
  }
  if (error.code === 'APPROVAL_DECISION_CONFLICT') {
    return new ToolInvocationError(
      'APPROVAL_DECISION_CONFLICT', 'Approval already has another decision.',
    );
  }
  if (error.code === 'OUTCOME_RESOLUTION_CONFLICT') {
    return new ToolInvocationError(
      'OUTCOME_RESOLUTION_CONFLICT', 'Unknown outcome already has another resolution.',
    );
  }
  if (
    error.code === 'STALE_LEASE' || error.code === 'FENCING_TOKEN_STALE' ||
    error.code === 'LEASE_HELD'
  ) {
    return new ToolInvocationError('LEASE_LOST', 'Run lease is no longer current.');
  }
  return new ToolInvocationError('INVOCATION_CONFLICT', 'Invocation lifecycle changed concurrently.');
}

function isToolRunRevisionConflict(error: unknown): error is AgentJournalError {
  return error instanceof AgentJournalError && error.code === 'REVISION_CONFLICT';
}

function isPreStartResolutionError(error: ToolInvocationError): boolean {
  return error.code === 'TOOL_NOT_FOUND' || error.code === 'TOOL_REVISION_MISMATCH' ||
    error.code === 'TOOL_INPUT_INVALID';
}

function resolutionErrorFact(error: ToolInvocationError): ToolExecutionErrorFact {
  switch (error.code) {
    case 'TOOL_CANCELLED':
      return {
        code: 'TOOL_CANCELLED', category: 'cancelled', retryable: false,
        outcome: 'not_applied',
      };
    case 'TOOL_TIMEOUT':
      return {
        code: 'TOOL_TIMEOUT', category: 'timeout', retryable: true,
        outcome: 'not_applied',
      };
    case 'TOOL_NOT_FOUND':
      return {
        code: 'TOOL_NOT_FOUND', category: 'unavailable', retryable: false, outcome: 'not_applied',
      };
    case 'TOOL_REVISION_MISMATCH':
      return {
        code: 'TOOL_REVISION_MISMATCH', category: 'conflict', retryable: false,
        outcome: 'not_applied',
      };
    case 'TOOL_INPUT_INVALID':
      return {
        code: 'TOOL_INPUT_INVALID', category: 'validation', retryable: false,
        outcome: 'not_applied',
      };
    default:
      throw error;
  }
}

function preparationInterruptionError(
  interruption: ToolPreparationInterruption,
): ToolInvocationError {
  return interruption === 'cancelled'
    ? new ToolInvocationError('TOOL_CANCELLED', 'Tool preparation was cancelled.')
    : new ToolInvocationError('TOOL_TIMEOUT', 'Tool preparation timed out.');
}

function scheduleState(invocation: AgentInvocationProjection): ToolInvocationScheduleState {

  return invocation.state;
}

function portableArguments(value: PortableValue): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ToolInvocationError('TOOL_INPUT_INVALID', 'Tool arguments must be an object.');
  }
  return structuredClone(value);
}

function frozenArguments(value: PortableValue): Readonly<Record<string, unknown>> {
  return deepFreeze(portableArguments(value));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function assertExecutionContextActive(
  context: Pick<ToolExecuteContext, 'signal' | 'deadline'>,
  now: () => number,
): void {
  if (now() >= Date.parse(context.deadline)) {
    throw new ToolExecutionError(
      { code: 'TOOL_TIMEOUT', category: 'timeout', retryable: true, outcome: 'not_applied' },
      'The prepared invocation deadline expired while processing the Tool result.',
    );
  }
  if (context.signal.aborted) {
    throw new ToolExecutionError(
      { code: 'TOOL_CANCELLED', category: 'cancelled', retryable: false, outcome: 'not_applied' },
      'The Tool result processing was cancelled.',
    );
  }
}

function requiresPostCommitExecutor(kind: RuntimeCommand['kind']): boolean {
  return kind === 'discovery.activate' ||
    kind === 'child.start' || kind === 'child.list' || kind === 'child.wait' ||
    kind === 'child.steer' || kind === 'child.cancel';
}

function stableIdempotencyKey(invocation: AgentInvocationProjection): string {
  return `tool_${sha256([
    invocation.projectId,
    invocation.sessionId,
    invocation.runId,
    invocation.turnId,
    invocation.invocationId,
    String((invocation.started?.attempt ?? 0) + 1),
  ].join('\0'))}`;
}

function leaseReference(lease: RunLease): { ownerId: string; fencingToken: number } {
  return { ownerId: lease.ownerId, fencingToken: lease.fencingToken };
}

function structuredCloneBinding(binding: ToolInvocationRuntimeBinding): ToolInvocationRuntimeBinding {
  return {
    projectId: binding.projectId,
    sessionId: binding.sessionId,
    runId: binding.runId,
    turnId: binding.turnId,
    lease: structuredClone(binding.lease),
    mode: binding.mode,
  };
}

function allowedToolMap(
  identities: readonly Readonly<{ name: string; revision: string }>[],
): ReadonlyMap<string, string> {
  const rawIdentities: unknown = identities;
  if (!Array.isArray(rawIdentities)) {
    throw new TypeError('Tool Runtime allowedTools must be an array.');
  }
  const result = new Map<string, string>();
  for (const candidate of rawIdentities as readonly unknown[]) {
    const { name, revision } = runtimeIdentity(candidate);
    if (result.has(name)) {
      throw new TypeError(`Duplicate allowed Tool identity: ${name}.`);
    }
    result.set(name, revision);
  }
  return result;
}

function capturedDiscoverableTools(
  registry: ToolCatalogSnapshot,
  identities: readonly Readonly<{ name: string; revision: string }>[],
): ToolInvocationExecutionContext['discoverableTools'] {
  const exact = allowedToolMap(identities);
  const tools: AgentToolDescriptor[] = [];
  for (const [name, revision] of exact) {
    const registered = registry.get(name);
    if (
      registered === undefined ||
      registry.invocationRevision(name) !== revision ||
      registered.descriptor.exposure === 'hidden' ||
      registered.descriptor.exposure === 'disabled'
    ) {
      throw new TypeError(`Discoverable Tool identity is unavailable in the exact snapshot: ${name}.`);
    }
    const descriptor = registered.descriptor;
    tools.push(deepFreeze(structuredClone({
      id: descriptor.id,
      flatName: descriptor.flatName,
      ...(descriptor.title === undefined ? {} : { title: descriptor.title }),
      description: descriptor.description,
      aliases: descriptor.aliases,
      tags: descriptor.tags,
      inputSchema: descriptor.inputSchema,
      outputSchema: descriptor.outputSchema,
      dangerLevel: descriptor.dangerLevel,
      readonly: descriptor.readonly,
      source: descriptor.source,
      exposure: descriptor.exposure,
      ...(descriptor.permission === undefined
        ? {}
        : { permission: descriptor.permission }),
      recoveryClass: descriptor.recoveryClass,
      access: descriptor.access, toolRevision: descriptor.toolRevision,
      handlerRevision: descriptor.handlerRevision, intentRevision: descriptor.intentRevision, limits: descriptor.limits,
      execution: descriptor.execution,
      failurePolicy: descriptor.failurePolicy,
      ...(descriptor.completion === undefined ? {} : { completion: descriptor.completion }),
      ...(descriptor.presentation === undefined ? {} : { presentation: descriptor.presentation }),
      ...(descriptor.protocolMetadata === undefined
        ? {}
        : { protocolMetadata: descriptor.protocolMetadata }),
    })));
  }
  return Object.freeze(tools);
}

function capturedDiscoverableCapabilities(
  entries: readonly AgentCapabilityDiscoveryManifestEntry[],
): ToolInvocationExecutionContext['discoverableCapabilities'] {
  return snapshotCapabilityDiscoveryManifest(entries);
}

function captureInvocationHooks(
  hooks: readonly AgentInvocationHookContribution[],
): readonly AgentInvocationHookContribution[] {
  const rawHooks: unknown = hooks;
  if (!Array.isArray(rawHooks)) throw new TypeError('Invocation Hooks must be an array.');
  const ids = new Set<string>();
  return Object.freeze((rawHooks as readonly unknown[]).map((candidate) => {
    if (!isPlainRecord(candidate)) throw invalidInvocationHook();
    const id = nonEmptyRuntimeText(candidate.id);
    const revision = nonEmptyRuntimeText(candidate.revision);
    const before = candidate.before;
    const after = candidate.after;
    if (
      id === null || revision === null ||
      before !== undefined && typeof before !== 'function' ||
      after !== undefined && typeof after !== 'function' ||
      before === undefined && after === undefined
    ) {
      throw invalidInvocationHook();
    }
    if (ids.has(id)) {
      throw new TypeError('Invocation Hooks require unique id and revision values.');
    }
    ids.add(id);
    return Object.freeze({
      id,
      revision,
      ...(before === undefined ? {} : {
        before: before as NonNullable<AgentInvocationHookContribution['before']>,
      }),
      ...(after === undefined ? {} : {
        after: after as NonNullable<AgentInvocationHookContribution['after']>,
      }),
    });
  }));
}

function runtimeIdentity(value: unknown): Readonly<{ name: string; revision: string }> {
  if (!isPlainRecord(value)) throw invalidRuntimeIdentity();
  const name = nonEmptyRuntimeText(value.name);
  const revision = nonEmptyRuntimeText(value.revision);
  if (name === null || revision === null) throw invalidRuntimeIdentity();
  return Object.freeze({ name, revision });
}

function invalidRuntimeIdentity(): TypeError {
  return new TypeError(
    'Tool Runtime allowed Tool identities require non-empty name and revision.',
  );
}

function invalidInvocationHook(): TypeError {
  return new TypeError(
    'Invocation Hook entries require id, revision, and callable phases.',
  );
}

function nonEmptyRuntimeText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hookInput(
  invocation: AgentInvocationProjection,
  descriptor: AgentToolDescriptor,
  argumentsRecord: Readonly<Record<string, unknown>>,
  authorization: ToolInvocationExecutionContext['authorization'],
  signal: AbortSignal,
): AgentInvocationHookInput {
  return Object.freeze({
    projectId: invocation.projectId,
    sessionId: invocation.sessionId,
    runId: invocation.runId,
    turnId: invocation.turnId,
    invocationId: invocation.invocationId,
    tool: deepFreeze(structuredClone(descriptor)),
    arguments: argumentsRecord,
    authorization,
    signal,
  });
}

function boundedHookSummary(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  return value.trim().slice(0, 4_096);
}

function publicObservation(
  observation: ToolObservationFact & { occurredAt?: string },
): ToolObservationFact {
  return deepFreeze({
    observationId: observation.observationId,
    invocationId: observation.invocationId,
    summary: observation.summary,
    evidenceRefs: [...observation.evidenceRefs],
    outcome: observation.outcome,
    ...(observation.modelProjection === undefined
      ? {}
      : { modelProjection: structuredClone(observation.modelProjection) }),
    ...(observation.auditEvidence === undefined
      ? {}
      : { auditEvidence: structuredClone(observation.auditEvidence) }),
    ...(observation.completionEvidence === undefined
      ? {}
      : { completionEvidence: structuredClone(observation.completionEvidence) }),
    ...(observation.errorCode === undefined ? {} : { errorCode: observation.errorCode }),
  });
}

/** Bounded foreground wait; callers retain the actual Promise in their drain. */
async function waitForResultBoundary<T>(actual: Promise<T>, context: Pick<ToolExecuteContext, 'signal' | 'deadline'>, now: () => number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let detach = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    const abort = () => {
      try { assertExecutionContextActive(context, now); }
      catch (error) { reject(error instanceof Error ? error : new Error('The result execution boundary ended.')); }
    };
    detach = () => context.signal.removeEventListener('abort', abort);
    context.signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(abort, Math.max(0, Date.parse(context.deadline) - now()));
    timer.unref?.();
    abort();
  });
  try { return await Promise.race([actual, interrupted]); }
  finally { if (timer !== undefined) clearTimeout(timer); detach(); }
}

function linkedAbortController(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
  preparationInterruption: ToolPreparationInterruption | undefined = undefined,
): {
  controller: AbortController;
  timedOut(): boolean;
  cancelled(): boolean;
  leaseLost(): boolean;
  loseLease(): void;
  close(): void;
} {
  const controller = new AbortController();
  let timeout = false;
  let leaseLost = false;
  const abortFromCaller = () => controller.abort();
  if (preparationInterruption === 'timed_out') timeout = true;
  if (preparationInterruption !== undefined || callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
    timeout = true;
    controller.abort();
  }, timeoutMs);
  timer?.unref?.();
  return {
    controller,
    timedOut: () => timeout,
    cancelled: () => preparationInterruption === 'cancelled' || callerSignal?.aborted === true,
    leaseLost: () => leaseLost,
    loseLease: () => {
      leaseLost = true;
      controller.abort();
    },
    close: () => {
      if (timer !== undefined) clearTimeout(timer);
      callerSignal?.removeEventListener('abort', abortFromCaller);
    },
  };
}

type ToolProgressPublisherOptions = Readonly<{
  signal: AbortSignal;
  publish(batchOrdinal: number, summary: string): Promise<void>;
}>;

/**
 * Invocation-local diagnostic coalescer. Reporting is synchronous for the
 * Handler, while durable writes are serialized behind the sealed Tool
 * lifecycle and drained before the terminal fact is committed.
 */
class ToolProgressPublisher {
  readonly #signal: AbortSignal;
  #publish: ToolProgressPublisherOptions['publish'] | undefined;
  #pending: string[] = [];
  #pendingBytes = 0;
  #batchOrdinal = 0;
  #accepting = true;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #writes: Promise<void> = Promise.resolve();

  constructor(options: ToolProgressPublisherOptions) {
    this.#signal = options.signal;
    this.#publish = options.publish;
  }

  report(value: string): void {
    if (!this.#accepting || this.#signal.aborted) return;
    let summary: string | undefined;
    try {
      summary = normalizeToolProgressSummary(value);
    } catch {
      // Progress is best-effort diagnostic input. Even a pathological value
      // must not escape into the Handler or reinterpret its business outcome.
      return;
    }
    if (summary === undefined) return;
    const separatorBytes = this.#pending.length === 0 ? 0 : 1;
    const summaryBytes = Buffer.byteLength(summary, 'utf8');
    if (
      this.#pending.length > 0 &&
      this.#pendingBytes + separatorBytes + summaryBytes > TOOL_PROGRESS_MAX_BATCH_BYTES
    ) {
      this.#enqueuePending();
    }
    this.#pending.push(summary);
    this.#pendingBytes += (this.#pending.length === 1 ? 0 : 1) + summaryBytes;
    if (this.#pendingBytes >= TOOL_PROGRESS_MAX_BATCH_BYTES) {
      this.#enqueuePending();
    } else if (this.#timer === undefined) {
      this.#timer = setTimeout(() => this.#enqueuePending(), TOOL_PROGRESS_MAX_DELAY_MS);
      this.#timer.unref?.();
    }
  }

  async close(): Promise<void> {
    if (!this.#accepting) return await this.#writes;
    this.#accepting = false;
    this.#clearTimer();
    this.#enqueuePending();
    await this.#writes;
    this.#publish = undefined;
  }

  #enqueuePending(): void {
    this.#clearTimer();
    if (this.#pending.length === 0) return;
    const summary = this.#pending.join('\n');
    const batchOrdinal = this.#batchOrdinal++;
    const publish = this.#publish;
    this.#pending = [];
    this.#pendingBytes = 0;
    if (publish === undefined) return;
    this.#writes = this.#writes.then(async () => {
      await publish(batchOrdinal, summary);
    }).catch(() => {
      // The publisher itself is defensive, but keep a rejected diagnostic
      // sink from poisoning later batches or the terminal Tool outcome.
    });
  }

  #clearTimer(): void {
    if (this.#timer === undefined) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}

function permissionApprovalSummary(
  actionSummary: string,
  evaluation: ToolPermissionEvaluation,
): string {
  const facts = evaluation.facts;
  const targets = [...facts.paths, ...facts.hosts].slice(0, 4);
  const parts = [
    actionSummary,
    `Mode: ${evaluation.mode}.`,
    `Actions: ${facts.actions.join(', ') || 'unknown'}.`,
    ...(targets.length === 0 ? [] : [`Targets: ${targets.join(', ')}.`]),
    ...(evaluation.matchedRuleIds.length === 0
      ? []
      : [`Enterprise rules: ${evaluation.matchedRuleIds.join(', ')}.`]),
  ];
  return parts.join(' ').slice(0, 4_096);
}

function authorizationAudit(
  authorization: ToolInvocationAuthorization,
): ToolPermissionAuditFact {
  return {
    mode: authorization.policyMode,
    decision: authorization.policyDecision,
    policyRevision: authorization.policyRevision,
    matchedRuleIds: [...authorization.matchedRuleIds],
    facts: {
      ...authorization.permission,
      actions: [...authorization.permission.actions],
      paths: [...authorization.permission.paths],
      hosts: [...authorization.permission.hosts],
      resolvedAddresses: [...authorization.permission.resolvedAddresses],
      targets: structuredClone([...authorization.permission.targets]),
    },
  };
}

function normalizeToolProgressSummary(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const summary = redactPersistedAgentString(value).trim();
  if (summary.length === 0) return undefined;
  if (Buffer.byteLength(summary, 'utf8') > TOOL_PROGRESS_MAX_ITEM_BYTES) return undefined;
  return summary;
}

function watchLease(
  journal: AgentJournal,
  binding: ToolInvocationRuntimeBinding,
  pollIntervalMs: number,
  onLost: () => void,
  now: () => number,
): () => void {
  let closed = false;
  let checking = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const lose = () => {
    if (closed) return;
    closed = true;
    if (timer !== undefined) clearTimeout(timer);
    onLost();
  };
  const schedule = (milliseconds: number) => {
    if (closed) return;
    timer = setTimeout(() => { void check(); }, milliseconds);
    timer.unref?.();
  };
  const check = async () => {
    if (closed || checking) return;
    checking = true;
    try {
      const current = await journal.getRunLease(binding.projectId, binding.runId);
      const nowMs = now();
      const expiresAtMs = current === null ? Number.NaN : Date.parse(current.expiresAt);
      if (
        current === null || current.ownerId !== binding.lease.ownerId ||
        current.fencingToken !== binding.lease.fencingToken ||
        !Number.isFinite(nowMs) || !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs
      ) {
        lose();
        return;
      }
      schedule(Math.max(1, Math.min(pollIntervalMs, expiresAtMs - nowMs)));
    } catch {
      lose();
    } finally {
      checking = false;
    }
  };
  void check();
  return () => {
    closed = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

function normalizeRetainedResultContent(
  value: unknown,
  maxArtifactBytes: number,
): ToolRetainedResultContent | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidToolResultError();
  }
  const prototype: unknown = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalidToolResultError();
  const record = value as Record<string, unknown>;
  const allowedKeys = new Set([
    'mediaType',
    'source',
    'expectedByteSize',
    'expectedChecksum',
    'identity',
  ]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) throw invalidToolResultError();
  if (
    typeof record.mediaType !== 'string' || record.mediaType.trim() === '' ||
    record.mediaType.length > 255 ||
    !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:\s*;\s*[^\0\r\n]+)?$/u.test(
      record.mediaType,
    )
  ) {
    throw invalidToolResultError();
  }
  if (
    record.source === null || typeof record.source !== 'object' ||
    typeof (record.source as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== 'function'
  ) {
    throw invalidToolResultError();
  }
  if (
    record.expectedByteSize !== undefined && (
      typeof record.expectedByteSize !== 'number' ||
      !Number.isSafeInteger(record.expectedByteSize) || record.expectedByteSize < 0 ||
      record.expectedByteSize > maxArtifactBytes
    )
  ) {
    throw invalidToolResultError();
  }
  if (
    record.expectedChecksum !== undefined && (
      typeof record.expectedChecksum !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(record.expectedChecksum)
    )
  ) {
    throw invalidToolResultError();
  }
  if (
    record.identity !== undefined && (
      typeof record.identity !== 'string' || record.identity.trim() === '' ||
      record.identity.length > 512 || hasControlCharacters(record.identity)
    )
  ) {
    throw invalidToolResultError();
  }
  return Object.freeze({
    mediaType: record.mediaType,
    source: record.source as AsyncIterable<Uint8Array>,
    ...(record.expectedByteSize === undefined
      ? {}
      : { expectedByteSize: record.expectedByteSize }),
    ...(record.expectedChecksum === undefined
      ? {}
      : { expectedChecksum: record.expectedChecksum }),
    ...(record.identity === undefined ? {} : { identity: record.identity }),
  });
}

async function* boundedRetainedResultSource(
  source: AsyncIterable<Uint8Array>,
  maxBytes: number,
  context: Pick<ToolExecuteContext, 'signal' | 'deadline'>,
  now: () => number,
): AsyncIterable<Uint8Array> {
  let totalBytes = 0;
  for await (const chunk of source) {
    assertExecutionContextActive(context, now);
    if (!(chunk instanceof Uint8Array)) throw invalidToolResultError();
    totalBytes += chunk.byteLength;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > maxBytes) {
      throw invalidToolResultError();
    }
    yield new Uint8Array(chunk);
  }
  assertExecutionContextActive(context, now);
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function bytesSource(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  return Readable.from([bytes]);
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    const abort = () => {
      cleanup();
      reject(new ToolInvocationError('INVOCATION_CONFLICT', 'Wait was cancelled.'));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalUnknownJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalUnknownJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalUnknownJson(record[key])}`,
  ).join(',')}}`;
}

function canonicalJson(value: PortableValue): string {
  return canonicalUnknownJson(value);
}
