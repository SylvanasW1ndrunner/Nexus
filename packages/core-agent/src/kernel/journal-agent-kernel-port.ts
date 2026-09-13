import type { ToolResourceLeaseProvider, ToolTargetRevalidator } from '../tools/tool-resource-leases.js';
import { questionCommandDigest, validateQuestionCommand } from '../tools/tool-question.js';
import type { SubmitQuestionInput } from './agent-kernel.js';
import { createHash, randomUUID } from 'node:crypto';
import type {
  CanonicalModelTool,
  ModelContentBlock,
  ModelExecutionGateway,
  ModelMessage,
  ModelProtocolEnvelope,
  ModelSession,
  ModelSessionBundle,
} from '@dbagent/core-llm';
import {
  ModelGatewayError,
  createModelSession,
  createModelSessionBundle,
} from '@dbagent/core-llm';
import { assertPortableValue, type PortableValue, type UsageMode } from '@dbagent/shared';
import type { ProjectArtifactStore } from '../artifacts/project-artifact-store.js';
import {
  ContextLifecycle,
  ContextLifecycleError,
  decideContextLifecycle,
  readBoundedContextItems,
  type ContextModelGateway,
} from '../context/context-lifecycle.js';
import {
  latestSafeModelHistorySequence,
  MODEL_HISTORY_EVENT_TYPES,
  projectAgentHistoryForModel,
} from '../context/model-event-projection.js';
import {
  PromptRuntime,
  snapshotPromptSection,
  type CompiledPrompt,
  type PromptSection,
} from '../context/prompt-runtime.js';
import {
  DeliveryVerificationError,
  evaluateDelivery,
  validateDeliveryEvidenceReferences,
  type DeliveryEvidenceSnapshot,
  type DeliveryVerifier,
  type PersistedDeliveryDecision,
} from '../delivery/delivery-verifier.js';
import {
  createDeliveryEvidenceSnapshot,
  isDeliverableFinalText,
  isPendingActionFinalText,
} from '../delivery/delivery-evidence.js';
import type { AgentEvent, ToolApprovalFact } from '../events/agent-event.js';
import { AgentJournalError } from '../events/agent-journal.js';
import type {
  AgentInvocationProjection,
  AgentRunProjection,
} from '../events/event-projectors.js';
import { RunEventCommitter } from '../events/run-event-committer.js';
import type { SqliteAgentJournal } from '../events/sqlite-agent-journal.js';
import {
  openModelLifecycleJournalApplication,
  type AgentModelLifecycleJournalCommand,
} from '../internal/model-lifecycle-authority.js';
import type { PermissionManager } from '../permission-manager.js';
import { ToolCatalogSnapshot, ToolRegistry } from '../tool-registry.js';
import { ToolExposurePlanner } from '../tool-exposure-planner.js';
import {
  ToolInvocationRuntime,
  type RuntimeCommandPostCommitExecutor,
} from '../tools/tool-invocation-runtime.js';
import type { ToolScheduleDecision } from '../tools/tool-scheduler.js';
import type { AgentMode } from '../types.js';
import type { ToolResultProjectionBudget } from '../tool-result.js';
import type {
  AgentCapabilityDiscoveryManifestEntry,
  AgentInvocationHookContribution,
} from '../capability-types.js';
import { snapshotCapabilityDiscoveryManifest } from '../capability-discovery-manifest.js';
import type {
  AgentPendingRequest,
  AgentRunLimits,
  ApproveRunInput,
  AuthorizeRiskyRetryInput,
  CancelRunInput,
  InterruptExecutionInput,
  ManualCompactionInput,
  ResolveOutcomeInput,
  ResumeRunInput,
  StartRunInput,
  SteerRunInput,
} from './agent-kernel.js';
import type { AgentStateSignal, AgentWaitReason } from './agent-state-machine.js';
import { ModelTurnCoordinator, type ModelTurnGateway } from './model-turn-coordinator.js';
import {
  RunController,
  RunLeaseLostError,
  type KernelRunProjection,
  type PersistedEnvironmentBinding,
  type PersistedTurnSnapshot,
} from './run-controller.js';
import {
  SessionModelBindingError,
  SessionModelBindingStore,
  describeRuntimeBinding,
  rehydrateExactRuntimeBinding,
  type PersistedModelRuntimeBinding,
  type SessionModelBinding,
} from './session-model-binding.js';

const EVENT_PAGE_SIZE = 500;
const DEFAULT_MAX_CONTEXT_EVENTS = 10_000;
const DEFAULT_MAX_CACHED_RUNS = 128;
const DEFAULT_MAX_CACHED_SESSIONS = 64;
const DEFAULT_MAX_CACHED_TOOL_CATALOGS = 128;

export type JournalAgentPersistedModelBinding =
  | Readonly<{
      source: 'session';
      projectId: string;
      sessionId: string;
      revision: number;
      model: PersistedModelRuntimeBinding;
    }>
  | Readonly<{
      source: 'run-environment';
      projectId: string;
      sessionId: string;
      runId: string;
      environmentBindingId: string;
      model: PersistedModelRuntimeBinding;
    }>;

export type JournalAgentModelResolver = (input: Readonly<{
  projectId: string;
  sessionId: string;
  runId: string;
  parent?: NonNullable<AgentRunProjection['parent']>;
  binding: JournalAgentPersistedModelBinding | null;
}>) => Promise<ModelSession | ModelSessionBundle> | ModelSession | ModelSessionBundle;

export type JournalAgentRunModelResolver = (input: Readonly<{
  projectId: string;
  sessionId: string;
  runId: string;
  request: StartRunInput;
  session: ModelSession | ModelSessionBundle;
  binding: SessionModelBinding;
}>) => Promise<ModelSession | ModelSessionBundle> | ModelSession | ModelSessionBundle;

/** Resolves the immutable billing classification for the exact route that emitted usage. */
export type JournalAgentUsageBillingModeResolver = (input: Readonly<{
  session: ModelSession | ModelSessionBundle;
  routeId: string;
}>) => UsageMode;

export type JournalAgentModelResolutionErrorCode =
  | 'MODEL_CONNECTION_REQUIRED'
  | 'MODEL_BINDING_UNAVAILABLE';

export class JournalAgentModelResolutionError extends Error {
  constructor(
    readonly code: JournalAgentModelResolutionErrorCode,
    message: string,
    readonly detail?: Readonly<{ connectionId?: string }>,
    override readonly cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'JournalAgentModelResolutionError';
  }
}

export type JournalAgentToolCatalogLease = Readonly<{
  snapshot: ToolCatalogSnapshot;
  release(): void;
}>;

export type JournalAgentToolCatalogResolver = (input: Readonly<{
  projectId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  turnSnapshotId: string;
  tools: readonly Readonly<{ name: string; revision: string }>[];
}>) => Promise<JournalAgentToolCatalogLease> | JournalAgentToolCatalogLease;

export type JournalAgentPromptSnapshotLease = Readonly<{
  revision: string;
  runtimeProtocol: PromptSection;
  sections: readonly PromptSection[];
  release(): void;
}>;

export type JournalAgentPromptSnapshotResolver = (input: Readonly<{
  projectId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  turnSnapshotId: string;
  promptRevision: string;
  capability: Readonly<{ snapshotId: string; revision: string }>;
  skills: readonly Readonly<{
    id: string;
    revision: string;
    allowedTools?: readonly string[];
  }>[];
}>) => Promise<JournalAgentPromptSnapshotLease> | JournalAgentPromptSnapshotLease;

export type JournalAgentPermissionPolicyLease = Readonly<{
  revision: string;
  permissionManager: PermissionManager;
  mode: AgentMode;
  release(): void;
}>;

export type JournalAgentPermissionPolicyResolver = (input: Readonly<{
  projectId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  turnSnapshotId: string;
  permissionPolicyRevision: string;
}>) => Promise<JournalAgentPermissionPolicyLease> | JournalAgentPermissionPolicyLease;

export type JournalAgentVerifierLease = Readonly<{
  verifier: DeliveryVerifier;
  release(): void;
}>;

export type JournalAgentVerifierResolver = (input: Readonly<{
  projectId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  turnSnapshotId: string;
  verifier: Readonly<{ id: string; revision: string; required: boolean }>;
}>) => Promise<JournalAgentVerifierLease> | JournalAgentVerifierLease;

/**
 * One complete executable dependency generation captured for a single Turn.
 * The owner must keep every function-bearing contribution alive until release.
 */
export type JournalAgentTurnRuntimeLease = Readonly<{
  capability: Readonly<{ snapshotId: string; revision: string }>;
  toolCatalog: ToolCatalogSnapshot;
  promptRevision: string;
  runtimeProtocol: PromptSection;
  promptSections: readonly PromptSection[];
  discoverableCapabilities?: readonly AgentCapabilityDiscoveryManifestEntry[];
  skills: readonly Readonly<{
    id: string;
    revision: string;
    allowedTools?: readonly string[];
  }>[];
  invocationHooks?: readonly AgentInvocationHookContribution[];
  verifier?: DeliveryVerifier;
  release(): void;
}>;

export type JournalAgentTurnRuntimeCapture = (input: Readonly<{
  projectId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  /** Durable ordinal derived from committed `turn.started` facts. */
  turnIndex: number;
  /** Exact current user/steering text selected from durable Run facts. */
  query: string;
  /** Cancelled when the owning preparation operation is interrupted. */
  signal: AbortSignal;
}>) => Promise<JournalAgentTurnRuntimeLease> | JournalAgentTurnRuntimeLease;

export type JournalAgentInvocationHookResolver = (input: Readonly<{
  projectId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  turnSnapshotId: string;
  hooks: readonly Readonly<{ id: string; revision: string }>[];
}>) => Promise<readonly AgentInvocationHookContribution[]> |
  readonly AgentInvocationHookContribution[];

export type JournalAgentCostMeter = (input: Readonly<{
  projectId: string;
  sessionId: string;
  runId: string;
  environment: PersistedEnvironmentBinding;
  usage: Readonly<{
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  }>;
}>) => Promise<number> | number;

export type JournalAgentKernelPortOptions = Readonly<{
  journal: SqliteAgentJournal;
  gateway: ModelExecutionGateway & ModelTurnGateway & ContextModelGateway;
  resolveModelSession: JournalAgentModelResolver;
  resolveUsageBillingMode: JournalAgentUsageBillingModeResolver;
  /** Optional request-layer Model binding applied only to a newly-created top-level Run. */
  resolveRunModelSession?: JournalAgentRunModelResolver;
  toolCatalog: ToolCatalogSnapshot;
  resolveToolCatalogSnapshot?: JournalAgentToolCatalogResolver;
  resolvePromptSnapshot?: JournalAgentPromptSnapshotResolver;
  resolvePermissionPolicy?: JournalAgentPermissionPolicyResolver;
  resolveVerifier?: JournalAgentVerifierResolver;
  captureTurnRuntime?: JournalAgentTurnRuntimeCapture;
  invocationHooks?: readonly AgentInvocationHookContribution[];
  resolveInvocationHooks?: JournalAgentInvocationHookResolver;
  costMeter?: JournalAgentCostMeter;
  permissionManager: PermissionManager;
  runtimeProtocol: PromptSection;
  promptSections?: readonly PromptSection[];
  capability: Readonly<{ snapshotId: string; revision: string }>;
  promptRevision: string;
  settingsRevision: string;
  permissionPolicyRevision: string;
  skills?: readonly Readonly<{
    id: string;
    revision: string;
    allowedTools?: readonly string[];
  }>[];
  /** Optional project policy applied before immutable per-Turn Tool exposure. */
  allowedTools?: readonly string[];
  verifier?: DeliveryVerifier;
  mode?: AgentMode;
  artifactStore?: ProjectArtifactStore;
  /** Executes durable Runtime Commands that require an external post-commit effect. */
  runtimeCommandExecutor?: RuntimeCommandPostCommitExecutor;
  ownerId?: string;
  leaseTtlMs?: number;
  maxToolConcurrency?: number;
  toolHostId?: string;
  toolResourceLeases?: ToolResourceLeaseProvider;
  revalidateToolTarget?: ToolTargetRevalidator;
  protocolReserveTokens?: number;
  createId?: () => string;
  now?: () => number;
  maxCachedRuns?: number;
  maxCachedSessions?: number;
  maxCachedToolCatalogs?: number;
  /** Bounded Session history page traversal before an incremental checkpoint is required. */
  maxContextEvents?: number;
}>;

type KernelEffect = Readonly<{ run: KernelRunProjection; signal: AgentStateSignal }>;

/** Concrete production effect owner. It can return only Journal readbacks. */
export class JournalAgentKernelPort {
  readonly #options: JournalAgentKernelPortOptions;
  readonly #bindingStore: SessionModelBindingStore;
  readonly #controllers = new Map<string, RunController>();
  readonly #liveSessions = new Map<string, ModelSession | ModelSessionBundle>();
  readonly #toolCatalogLeases = new Map<string, JournalAgentToolCatalogLease>();
  readonly #promptSnapshotLeases = new Map<string, JournalAgentPromptSnapshotLease>();
  readonly #permissionPolicyLeases = new Map<string, JournalAgentPermissionPolicyLease>();
  readonly #verifierLeases = new Map<string, JournalAgentVerifierLease>();
  readonly #turnRuntimeLeases = new Map<string, JournalAgentTurnRuntimeLease>();
  readonly #ownerId: string;
  readonly #leaseTtlMs: number;
  readonly #maxCachedRuns: number;
  readonly #maxCachedSessions: number;
  readonly #maxCachedToolCatalogs: number;
  readonly #maxContextEvents: number;
  readonly #createId: () => string;
  readonly #now: () => number;

  constructor(options: JournalAgentKernelPortOptions) {
    this.#options = options;
    this.#bindingStore = new SessionModelBindingStore(options.journal);
    this.#ownerId = requireText(options.ownerId ?? `agent-kernel-${randomUUID()}`, 'ownerId');
    this.#leaseTtlMs = options.leaseTtlMs ?? 60_000;
    if (!Number.isSafeInteger(this.#leaseTtlMs) || this.#leaseTtlMs < 1) {
      throw new TypeError('leaseTtlMs must be a positive integer.');
    }
    this.#maxCachedRuns = positiveBound(
      options.maxCachedRuns ?? DEFAULT_MAX_CACHED_RUNS,
      'maxCachedRuns',
    );
    this.#maxCachedSessions = positiveBound(
      options.maxCachedSessions ?? DEFAULT_MAX_CACHED_SESSIONS,
      'maxCachedSessions',
    );
    this.#maxCachedToolCatalogs = positiveBound(
      options.maxCachedToolCatalogs ?? DEFAULT_MAX_CACHED_TOOL_CATALOGS,
      'maxCachedToolCatalogs',
    );
    this.#maxContextEvents = positiveBound(
      options.maxContextEvents ?? DEFAULT_MAX_CONTEXT_EVENTS,
      'maxContextEvents',
    );
    if (this.#maxContextEvents > DEFAULT_MAX_CONTEXT_EVENTS) {
      throw new TypeError(`maxContextEvents cannot exceed ${DEFAULT_MAX_CONTEXT_EVENTS}.`);
    }
    this.#createId = options.createId ?? randomUUID;
    this.#now = options.now ?? Date.now;
  }

  async start(input: StartRunInput): Promise<KernelRunProjection> {
    const runId = `run_${this.#createId()}`;
    const initial = await this.#initialTopLevelSession(
      input.projectId,
      input.sessionId,
      runId,
    );
    const session = this.#options.resolveRunModelSession === undefined
      ? initial.session
      : await this.#options.resolveRunModelSession({
          projectId: input.projectId,
          sessionId: input.sessionId,
          runId,
          request: structuredClone(input),
          session: initial.session,
          binding: initial.binding,
        });
    const model = describeRuntimeBinding(session);
    assertSameRunModelRoute(initial.binding.model, model);
    const environment = {
      environmentBindingId: `environment_${runId}`,
      settingsRevision: requireText(this.#options.settingsRevision, 'settingsRevision'),
      permissionPolicyRevision: requireText(
        this.#options.permissionPolicyRevision,
        'permissionPolicyRevision',
      ),
      modelSession: model.descriptor,
    };
    const ingress = await this.#options.journal.createRun({
      ...structuredClone(input),
      runId,
      environment,
    });
    if (ingress.runId === runId) {
      this.#cacheLiveSession(
        runSessionCacheKey(runId, environment.environmentBindingId, model.bindingDigest),
        session,
      );
    }
    return await this.#readScoped(input.projectId, input.sessionId, ingress.runId);
  }

  async read(runId: string): Promise<KernelRunProjection> {
    const scope = await this.#scope(runId);
    return await this.#readScoped(scope.projectId, scope.sessionId, runId);
  }

  async prepare(run: KernelRunProjection): Promise<KernelEffect> {
    const controller = await this.#controller(run);
    if (run.state === 'Preparing') {
      const steered = await this.#consumePendingSteering(run, controller);
      if (steered !== null) return steered;
    }
    return await controller.runWork(async (signal) => {
      try {
        return await this.#prepare(run, controller, signal);
      } catch (error) {
        controller.assertLeaseActive();
        const cancelled = await this.#cancellationEffect(run);
        if (cancelled !== null) return cancelled;
        const handled = await this.#dependencyFailure(run, controller, error);
        if (handled !== null) return handled;
        throw error;
      }
    });
  }

  async #prepare(
    run: KernelRunProjection,
    controller: RunController,
    signal: AbortSignal,
  ): Promise<KernelEffect> {
    if (run.state === 'Compacting') return await this.#compact(run, controller, signal);
    if (run.currentTurnId === null) {
      const persistedEnvironment = run.environmentBindingId === null
        ? null
        : await this.#options.journal.getEnvironmentBinding({
            projectId: run.projectId,
            sessionId: run.sessionId,
            runId: run.runId,
          });
      if (
        run.environmentBindingId !== null &&
        (persistedEnvironment === null ||
          persistedEnvironment.environmentBindingId !== run.environmentBindingId)
      ) {
        throw new TypeError('Run Environment binding is unavailable or disagrees with the Run.');
      }
      const inherited = persistedEnvironment === null
        ? await this.#inheritedChildEnvironment(run)
        : undefined;
      const session = persistedEnvironment === null
        ? (await this.#currentSession(run.projectId, run.sessionId, run.runId)).session
        : await this.#exactRunSession(run);
      const binding = persistedEnvironment === null
        ? describeRuntimeBinding(session)
        : undefined;
      const turnId = `turn_${this.#createId()}`;
      const runtime = await this.#captureTurnRuntime(run, turnId, signal);
      try {
        const result = await controller.captureTurn({
          commandId: `capture_${this.#createId()}`,
          expectedRunRevision: run.revision,
          turnId,
          environment: persistedEnvironment?.payload ?? (inherited === undefined ? undefined : {
            ...inherited.environment.payload,
            environmentBindingId: `environment_${run.runId}`,
          }) ?? {
            environmentBindingId: `environment_${run.runId}`,
            settingsRevision: requireText(this.#options.settingsRevision, 'settingsRevision'),
            permissionPolicyRevision: requireText(
              this.#options.permissionPolicyRevision,
              'permissionPolicyRevision',
            ),
            modelSession: binding!.descriptor,
          },
          snapshot: await this.#turnSnapshot(session, run, turnId, runtime),
        });
        return effect(result.run, run.state === 'created'
          ? { type: 'run-started' }
          : { type: 'turn-captured' });
      } catch (error) {
        if (runtime !== undefined) {
          this.#turnRuntimeLeases.delete(toolCatalogCacheKey(run, turnId));
          runtime.release();
        }
        throw error;
      }
    }
    if (run.state === 'Preparing') {
      const pending = await this.#options.journal.getPendingContextCompaction({
        projectId: run.projectId,
        sessionId: run.sessionId,
        runId: run.runId,
      });
      if (pending !== null) {
        const throughSequence = (await this.#compilePrompt(run)).throughSequence;
        const started = await controller.startContextCompaction({
          commandId: `manual_context_start_${pending.decisionId}`,
          expectedRunRevision: run.revision,
          checkpointId: `checkpoint_${this.#createId()}`,
          decisionId: pending.decisionId,
          reason: 'manual',
          coveredSequence: throughSequence,
        });
        return effect(started.run, {
          type: 'context-compaction-required', coveredSequence: throughSequence,
        });
      }
    }
    await controller.ensureLeaseFresh();
    const prepared = await this.#compilePrompt(run);
    const session = await this.#exactRunSession(run);
    const route = primarySession(session).route;
    const configuredOutputReserve = primarySession(session).generation.maxOutputTokens;
    const decision = decideContextLifecycle({
      maxInputTokens: route.maxInputTokens,
      estimatedInputTokens: prepared.prompt.tokenEstimate,
      outputReserveTokens: configuredOutputReserve ?? route.maxOutputTokens ?? 0,
      protocolReserveTokens: this.#options.protocolReserveTokens ?? 256,
      toolReserveTokens: estimateTokens(prepared.prompt.tools),
      compactedForDecision: prepared.checkpoint !== null,
      manualRequested: false,
      safeBoundary: true,
    });
    if (prepared.truncated) {
      const checkpointId = `checkpoint_${this.#createId()}`;
      const started = await controller.startContextCompaction({
        commandId: `context_batch_${this.#createId()}`,
        expectedRunRevision: run.revision,
        checkpointId,
        decisionId: `decision_${this.#createId()}`,
        reason: 'automatic',
        coveredSequence: prepared.throughSequence,
      });
      return effect(started.run, {
        type: 'context-compaction-required', coveredSequence: prepared.throughSequence,
      });
    }
    if (decision.action === 'compact') {
      const checkpointId = `checkpoint_${this.#createId()}`;
      const started = await controller.startContextCompaction({
        commandId: `context_start_${this.#createId()}`,
        expectedRunRevision: run.revision,
        checkpointId,
        decisionId: `decision_${this.#createId()}`,
        reason: decision.reason,
        coveredSequence: prepared.throughSequence,
      });
      return effect(started.run, {
        type: 'context-compaction-required', coveredSequence: prepared.throughSequence,
      });
    }
    if (decision.action === 'over-limit') {
      const interrupted = await controller.interrupt({
        commandId: `context_limit_${this.#createId()}`,
        expectedRunRevision: run.revision,
        code: decision.code,
        detail: { inputBudgetTokens: decision.inputBudgetTokens },
      });
      return effect(interrupted.run, { type: 'interrupted' });
    }
    if (decision.action === 'queue-manual-compaction') {
      throw new TypeError('Manual compaction cannot be queued while preparing a Turn.');
    }
    const turn = await this.#turnLifecycle(run, 'started');
    const ready = await controller.commitContextReady({
      commandId: `context_ready_${this.#createId()}`,
      expectedRunRevision: run.revision,
      turnId: run.currentTurnId,
      expectedTurnRevision: turn.revision,
      ...(prepared.checkpoint === null ? {} : { contextRef: prepared.checkpoint.summaryRef }),
      tokenEstimate: prepared.prompt.tokenEstimate,
    });
    return effect(ready.run, { type: 'context-ready' });
  }

  async callModel(run: KernelRunProjection): Promise<KernelEffect> {
    if (run.currentTurnId === null) throw new TypeError('CallingModel requires an active Turn.');
    const controller = await this.#controller(run);
    return await controller.runWork(async (signal) => {
      try {
        return await this.#callModel(run, controller, run.currentTurnId!, signal);
      } catch (error) {
        controller.assertLeaseActive();
        const cancelled = await this.#cancellationEffect(run);
        if (cancelled !== null) return cancelled;
        const handled = await this.#dependencyFailure(run, controller, error);
        if (handled !== null) return handled;
        throw error;
      }
    });
  }

  async #callModel(
    run: KernelRunProjection,
    controller: RunController,
    turnId: string,
    signal: AbortSignal,
  ): Promise<KernelEffect> {
    const preparedPrompt = await this.#compilePrompt(run);
    const prompt = preparedPrompt.prompt;
    const session = modelSessionWithReplay(
      await this.#exactRunSession(run),
      preparedPrompt.protocolEnvelopes,
    );
    const turn = await this.#turnLifecycle(run, 'started');
    let revision = run.revision;
    if (run.currentAttemptId !== null) {
      const recovered = await controller.discardModelAttempt({
        commandId: `model_recover_${run.currentAttemptId}`,
        expectedRunRevision: run.revision,
        turnId,
        expectedTurnRevision: turn.revision,
        attemptId: run.currentAttemptId,
        reason: 'executor-lease-recovered',
        failure: { code: 'MODEL_ATTEMPT_ABANDONED', retryable: true },
      });
      if (recovered.run.currentAttemptId !== null || recovered.run.state !== 'CallingModel') {
        throw new TypeError('Recovered Model Attempt did not reach the CallingModel boundary.');
      }
      return effect(recovered.run, { type: 'model-attempt-discarded' });
    }
    await controller.ensureLeaseFresh();
    const failures = new Map<string, { code: string; retryable: boolean }>();
    const modelLifecycle = openModelLifecycleJournalApplication(this.#options.journal);
    const coordinator = new ModelTurnCoordinator({
      gateway: this.#options.gateway,
      session,
      committer: new RunEventCommitter(this.#options.journal),
      resolveUsageBillingMode: (routeId) => this.#usageBillingMode(session, routeId),
      lifecycleSink: {
        publish: async (fact) => {
          if (fact.type === 'attempt-started') {
            const started = await controller.startModelAttempt({
              commandId: `model_start_${fact.attemptId}`,
              expectedRunRevision: revision,
              turnId,
              expectedTurnRevision: turn.revision,
              attemptId: fact.attemptId,
              origin: fact.origin,
            });
            revision = started.run.revision;
            return { runRevision: revision };
          }
          if (
            fact.type === 'model-delta-batch' || fact.type === 'block-completed' ||
            fact.type === 'usage-observed'
          ) {
            if (fact.type === 'usage-observed' && fact.purpose !== 'agent-turn') {
              throw new TypeError('Agent Turn emitted usage with a foreign purpose.');
            }
            const commandId = fact.type === 'model-delta-batch'
              ? `${run.runId}:${fact.idempotencyKey}`
              : fact.type === 'block-completed'
                ? `${run.runId}:model-block:${fact.attemptId}:${fact.blockOrdinal}`
                : `${run.runId}:model-usage:${fact.attemptId}`;
            const lifecycleCommand = {
              schemaVersion: 1,
              projectId: run.projectId,
              sessionId: run.sessionId,
              runId: run.runId,
              turnId,
              attemptId: fact.attemptId,
              commandId,
              lease: leaseReference(controller),
              expectedRunRevision: revision,
              fact: fact.type === 'usage-observed'
                ? {
                    ...fact,
                    purpose: 'agent-turn' as const,
                    billingMode: this.#usageBillingMode(session, fact.routeId),
                  }
                : fact,
            } as AgentModelLifecycleJournalCommand;
            const persisted = await modelLifecycle.commit(lifecycleCommand);
            revision = persisted.runRevision;
            return { runRevision: revision };
          }
          if (fact.type === 'attempt-failed') {
            failures.set(fact.attemptId, { code: fact.code, retryable: fact.retryable });
          } else if (fact.type === 'attempt-discarded') {
            const failure = failures.get(fact.attemptId);
            const discarded = await controller.discardModelAttempt({
              commandId: `model_discard_${fact.attemptId}`,
              expectedRunRevision: revision,
              turnId,
              expectedTurnRevision: turn.revision,
              attemptId: fact.attemptId,
              reason: fact.reason,
              ...(failure === undefined ? {} : { failure }),
            });
            revision = discarded.run.revision;
          }
        },
      },
    });
    try {
      const coordinated = await coordinator.execute({
          projectId: run.projectId,
          sessionId: run.sessionId,
          runId: run.runId,
          turnId,
          commandId: `model_commit_${this.#createId()}`,
          lease: leaseReference(controller),
          expectedTurnRevision: turn.revision,
          prompt,
          signal,
        });
      const current = await this.#readScoped(run.projectId, run.sessionId, run.runId);
      return effect(current, {
        type: 'model-turn-completed',
        hasActions: coordinated.committed.invocations.length > 0,
      });
    } catch (error) {
      controller.assertLeaseActive();
      let active = await this.#readScoped(run.projectId, run.sessionId, run.runId);
      if (active.state === 'Cancelling' || active.state === 'Cancelled') {
        return effect(active, active.state === 'Cancelled'
          ? { type: 'cancellation-settled' }
          : { type: 'cancel-requested' });
      }
      if (active.currentAttemptId !== null) {
        try {
          const discarded = await controller.discardModelAttempt({
            commandId: `model_abort_${active.currentAttemptId}`,
            expectedRunRevision: active.revision,
            turnId,
            expectedTurnRevision: turn.revision,
            attemptId: active.currentAttemptId,
            reason: 'model-turn-failed',
            failure: failures.get(active.currentAttemptId) ?? {
              code: 'MODEL_GATEWAY_FAILED', retryable: false,
            },
          });
          revision = discarded.run.revision;
        } catch (discardError) {
          if (!isConcurrentKernelTransition(discardError)) throw discardError;
          active = await this.#readScoped(run.projectId, run.sessionId, run.runId);
          if (active.state === 'Cancelling' || active.state === 'Cancelled') {
            return effect(active, active.state === 'Cancelled'
              ? { type: 'cancellation-settled' }
              : { type: 'cancel-requested' });
          }
          throw discardError;
        }
      } else {
        revision = active.revision;
      }
      try {
        const detail = modelFailureDiagnostic(error);
        if (isTerminalModelFailure(error)) {
          const failed = await controller.fail({
            commandId: `model_failed_${this.#createId()}`,
            expectedRunRevision: revision,
            code: error.code,
            detail,
          });
          return effect(failed.run, { type: 'failed' });
        }
        const interrupted = await controller.interrupt({
          commandId: `model_interrupted_${this.#createId()}`,
          expectedRunRevision: revision,
          code: 'MODEL_GATEWAY_FAILED',
          detail,
        });
        return effect(interrupted.run, { type: 'interrupted' });
      } catch (interruptError) {
        if (!isConcurrentKernelTransition(interruptError)) throw interruptError;
        active = await this.#readScoped(run.projectId, run.sessionId, run.runId);
        if (active.state === 'Cancelling' || active.state === 'Cancelled') {
          return effect(active, active.state === 'Cancelled'
            ? { type: 'cancellation-settled' }
            : { type: 'cancel-requested' });
        }
        throw interruptError;
      }
    }
  }

  async runTools(run: KernelRunProjection): Promise<KernelEffect> {
    if (run.currentTurnId === null) throw new TypeError('Tool scheduling requires an active Turn.');
    const controller = await this.#controller(run);
    return await controller.runWork(async (signal) => {
      try {
        return await this.#runTools(run, controller, run.currentTurnId!, signal);
      } catch (error) {
        controller.assertLeaseActive();
        const cancelled = await this.#cancellationEffect(run);
        if (cancelled !== null) return cancelled;
        const handled = await this.#dependencyFailure(run, controller, error);
        if (handled !== null) return handled;
        throw error;
      }
    });
  }

  async #runTools(
    run: KernelRunProjection,
    controller: RunController,
    turnId: string,
    signal: AbortSignal,
  ): Promise<KernelEffect> {
    const runtime = await this.#toolRuntime(run, controller);
    await controller.ensureLeaseFresh();
    let decision: ToolScheduleDecision;
    if (run.state === 'ResolvingActions') {
      decision = await runtime.resolve({ signal });
    } else if (run.state === 'ExecutingTools') {
      await runtime.executeEligible({ signal });
      decision = await runtime.resolve({ signal });
    } else {
      await runtime.executeEligible({ signal });
      decision = await runtime.resolve({ signal });
      if (decision.state === 'TurnReadyToClose') {
        const current = await this.#readScoped(run.projectId, run.sessionId, run.runId);
        const invocations = await this.#options.journal.listTurnInvocations({
          projectId: current.projectId,
          sessionId: current.sessionId,
          runId: current.runId,
          turnId,
          limit: 1_000,
        });
        const unknown = unresolvedOutcomeRequests(invocations);
        if (unknown.length > 0) {
          const turn = await this.#turnLifecycle(current, 'committed');
          const requested = await controller.blockOutcomeResolution({
            commandId: `outcome_input_${this.#createId()}`,
            expectedRunRevision: current.revision,
            turnId,
            expectedTurnRevision: turn.revision,
            requests: unknown,
          });
          return effect(requested.run, { type: 'outcome-resolution-required' });
        }
        const turn = await this.#turnLifecycle(current, 'committed');
        const closed = await controller.closeObservedTurn({
          commandId: `turn_close_${this.#createId()}`,
          expectedRunRevision: current.revision,
          turnId,
          expectedTurnRevision: turn.revision,
        });
        this.#releaseTurnDependencies(run, turnId);
        return effect(closed.run, { type: 'turn-observed' });
      }
    }
    const current = await this.#readScoped(run.projectId, run.sessionId, run.runId);
    if (current.state === 'Cancelling') return effect(current, { type: 'cancel-requested' });
    return effect(current, { type: 'schedule-decided', decision });
  }

  async finalize(run: KernelRunProjection): Promise<KernelEffect> {
    if (run.currentTurnId === null) throw new TypeError('Finalizing requires a committed Turn.');
    const controller = await this.#controller(run);
    const steered = await this.#consumePendingSteering(run, controller);
    if (steered !== null) return steered;
    const invocations = await this.#options.journal.listTurnInvocations({
      projectId: run.projectId,
      sessionId: run.sessionId,
      runId: run.runId,
      turnId: run.currentTurnId,
      limit: 1_000,
    });
    const unknown = unresolvedOutcomeRequests(invocations);
    if (unknown.length > 0) {
      const turn = await this.#turnLifecycle(run, 'committed');
      const requested = await controller.blockOutcomeResolution({
        commandId: `outcome_input_${this.#createId()}`,
        expectedRunRevision: run.revision,
        turnId: run.currentTurnId,
        expectedTurnRevision: turn.revision,
        requests: unknown,
      });
      return effect(requested.run, { type: 'outcome-resolution-required' });
    }
    const turn = await this.#options.journal.getScopedCommittedTurn({
      projectId: run.projectId,
      sessionId: run.sessionId,
      runId: run.runId,
      turnId: run.currentTurnId,
    });
    if (turn === null) throw new TypeError('Finalizing Turn has no committed model result.');
    const finalContentRef = `turn:${turn.turnId}:content`;
    const events = await this.#runEvents(run.projectId, run.sessionId, run.runId, 0);
    const priorDecisions = persistedDeliveryDecisions(events);
    const visibleText = turn.blocks
      .filter((block): block is Extract<ModelContentBlock, { type: 'text' }> =>
        block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();
    if (turn.finishReason !== 'stop' || !isDeliverableFinalText(visibleText)) {
      const lifecycle = await this.#turnLifecycle(run, 'committed');
      const failed = await controller.finalize({
        commandId: `delivery_incomplete_${this.#createId()}`,
        expectedRunRevision: run.revision,
        turnId: run.currentTurnId,
        expectedTurnRevision: lifecycle.revision,
        finalContentRef,
        decision: {
          evidenceRevision: run.evidenceRevision,
          status: 'unverified',
          outcome: 'failed',
          evidenceRefs: [],
          reason: turn.finishReason === 'stop'
            ? visibleText === ''
              ? 'MODEL_DELIVERY_EMPTY'
              : 'MODEL_DELIVERY_NON_SEMANTIC'
            : `MODEL_DELIVERY_${turn.finishReason.toUpperCase().replaceAll('-', '_')}`,
        },
      });
      this.#releaseTurnDependencies(run, run.currentTurnId);
      return effect(failed.run, { type: 'failed' });
    }
    if (isPendingActionFinalText(visibleText)) {
      const verifierId = 'runtime.pending-action-final';
      const verifierRevision = 'v1';
      const priorRevisionCount = priorDecisions.filter((decision) =>
        decision.verifierId === verifierId &&
        decision.verifierRevision === verifierRevision &&
        decision.evidenceRevision === run.evidenceRevision &&
        decision.decision === 'revise').length;
      const revisionLimitReached = priorRevisionCount >= 3;
      const lifecycle = await this.#turnLifecycle(run, 'committed');
      const finalized = await controller.finalize({
        commandId: `delivery_pending_action_${this.#createId()}`,
        expectedRunRevision: run.revision,
        turnId: run.currentTurnId,
        expectedTurnRevision: lifecycle.revision,
        finalContentRef,
        decision: {
          evidenceRevision: run.evidenceRevision,
          status: 'unverified',
          outcome: revisionLimitReached ? 'failed' : 'revision-requested',
          verifierId,
          verifierRevision,
          evidenceRefs: [],
          ...(revisionLimitReached
            ? { reason: 'MODEL_DELIVERY_PENDING_ACTION_REPEATED' }
            : {
                observation: {
                  issue: 'pending-action-final',
                  attempt: priorRevisionCount + 1,
                  instruction: 'Continue the Run and perform the announced action with tools. Provide a final answer only after the action and its requested verification are complete.',
                },
              }),
        },
      });
      this.#releaseTurnDependencies(run, run.currentTurnId);
      return effect(finalized.run, revisionLimitReached
        ? { type: 'failed' }
        : { type: 'delivery-revision-requested' });
    }
    const turnSnapshot = await this.#options.journal.getTurnSnapshot({
      projectId: run.projectId,
      sessionId: run.sessionId,
      runId: run.runId,
      turnId: run.currentTurnId,
    });
    if (turnSnapshot === null || turnSnapshot.environmentBindingId !== run.environmentBindingId) {
      throw new TypeError('Finalization requires the exact captured Turn Snapshot.');
    }
    let verifier: DeliveryVerifier | undefined;
    try {
      verifier = await this.#exactVerifier(run, turnSnapshot);
    } catch (error) {
      if (!(error instanceof ExactTurnDependencyError)) throw error;
      const requested = await controller.requestInput({
        commandId: `verifier_dependency_${this.#createId()}`,
        expectedRunRevision: run.revision,
        reason: 'capability_revision_required',
      });
      return effect(requested.run, {
        type: 'input-required',
        reason: 'capability_revision_required',
      });
    }
    let evidence: DeliveryEvidenceSnapshot;
    try {
      evidence = createDeliveryEvidenceSnapshot({
        events,
        evidenceRevision: run.evidenceRevision,
        finalContentRef,
        finalText: visibleText,
      });
      if (evidence.evidenceRefs.length > 0) {
        if (this.#options.artifactStore === undefined) {
          throw new DeliveryVerificationError(
            'EVIDENCE_REFERENCE_INVALID',
            'Delivery evidence cannot be resolved without Runtime artifact storage.',
          );
        }
        const pinnedUntil = new Date(this.#now() + 30 * 24 * 60 * 60 * 1_000).toISOString();
        await validateDeliveryEvidenceReferences({
          evidence,
          resolver: this.#options.artifactStore,
          access: {
            hostId: this.#options.toolHostId ?? 'local',
            projectId: run.projectId,
            sessionId: run.sessionId,
            runId: run.runId,
          },
          resolverContext: {
            deadline: new Date(this.#now() + 30_000).toISOString(),
            pinUntil: pinnedUntil,
          },
        });
      }
    } catch {
      const lifecycle = await this.#turnLifecycle(run, 'committed');
      const failed = await controller.finalize({
        commandId: `delivery_evidence_invalid_${this.#createId()}`,
        expectedRunRevision: run.revision,
        turnId: run.currentTurnId,
        expectedTurnRevision: lifecycle.revision,
        finalContentRef,
        decision: {
          evidenceRevision: run.evidenceRevision,
          status: 'unverified',
          outcome: 'failed',
          evidenceRefs: [],
          reason: 'DELIVERY_EVIDENCE_INVALID',
        },
      });
      this.#releaseTurnDependencies(run, run.currentTurnId);
      return effect(failed.run, { type: 'failed' });
    }
    let evaluation: ReturnType<typeof evaluateDelivery>;
    try {
      evaluation = evaluateDelivery({
        evidence,
        ...(verifier === undefined ? {} : { verifier }),
        ...(priorDecisions.length === 0 ? {} : { priorDecisions }),
      });
    } catch (error) {
      if (
        !(error instanceof DeliveryVerificationError) ||
        error.code !== 'DELIVERY_UNVERIFIED' ||
        verifier === undefined
      ) {
        throw error;
      }
      const lifecycle = await this.#turnLifecycle(run, 'committed');
      const failed = await controller.finalize({
        commandId: `delivery_${this.#createId()}`,
        expectedRunRevision: run.revision,
        turnId: run.currentTurnId,
        expectedTurnRevision: lifecycle.revision,
        finalContentRef,
        decision: {
          evidenceRevision: run.evidenceRevision,
          status: 'unverified',
          outcome: 'failed',
          verifierId: verifier.verifierId,
          verifierRevision: verifier.revision,
          evidenceRefs: evidence.evidenceRefs,
          reason: error.code,
        },
      });
      this.#releaseTurnDependencies(run, run.currentTurnId);
      return effect(failed.run, { type: 'failed' });
    }
    const verifierDecision = evaluation.verifier;
    const outcome = evaluation.action === 'complete'
      ? 'accepted'
      : evaluation.action === 'revise'
        ? 'revision-requested'
        : 'failed';
    const lifecycle = await this.#turnLifecycle(run, 'committed');
    const finalized = await controller.finalize({
      commandId: `delivery_${this.#createId()}`,
      expectedRunRevision: run.revision,
      turnId: run.currentTurnId,
      expectedTurnRevision: lifecycle.revision,
      finalContentRef,
      decision: {
        evidenceRevision: evaluation.evidenceRevision,
        status: evaluation.deliveryStatus,
        outcome,
        ...(verifierDecision === undefined ? {} : {
          verifierId: verifierDecision.verifierId,
          verifierRevision: verifierDecision.revision,
        }),
        evidenceRefs: evidence.evidenceRefs,
        ...(evaluation.action === 'revise'
          ? { observation: evaluation.observation }
          : {}),
        ...(evaluation.action === 'fail' ? { reason: evaluation.code } : {}),
      },
    });
    this.#releaseTurnDependencies(run, run.currentTurnId);
    return effect(finalized.run, evaluation.action === 'revise'
      ? { type: 'delivery-revision-requested' }
      : evaluation.action === 'fail'
        ? { type: 'failed' }
        : { type: 'delivery-accepted' });
  }

  async settleCancellation(run: KernelRunProjection): Promise<KernelEffect> {
    const controller = await this.#controller(run);
    controller.abortWork('The Agent Run was cancelled.');
    await controller.waitForWork();
    for (let retry = 0; retry < 32; retry += 1) {
      let current = await this.#readScoped(run.projectId, run.sessionId, run.runId);
      if (current.state === 'Cancelled') {
        return effect(current, { type: 'cancellation-settled' });
      }
      if (current.state !== 'Cancelling') {
        throw new TypeError(`Cancellation recovery found Run state ${current.state}.`);
      }
      if (current.currentAttemptId !== null) {
        if (current.currentTurnId === null) {
          throw new TypeError('Cancelling Model Attempt has no active Turn.');
        }
        const lifecycle = await this.#turnLifecycle(current, 'started');
        try {
          await controller.discardModelAttempt({
            commandId: `cancel_model_${current.currentAttemptId}`,
            expectedRunRevision: current.revision,
            turnId: current.currentTurnId,
            expectedTurnRevision: lifecycle.revision,
            attemptId: current.currentAttemptId,
            reason: 'run-cancelled',
            failure: { code: 'MODEL_ATTEMPT_CANCELLED', retryable: false },
          });
        } catch (error) {
          if (!isConcurrentKernelTransition(error)) throw error;
        }
        continue;
      }
      if (current.currentTurnId !== null) {
        const runtime = await this.#toolRuntime(current, controller);
        const invocations = await this.#turnInvocations(current, current.currentTurnId);
        const unresolved = invocations.find((invocation) => invocation.state !== 'observed');
        if (unresolved !== undefined) {
          try {
            await runtime.recover(unresolved.invocationId);
          } catch (error) {
            if (!isConcurrentKernelTransition(error) && !isInvocationConcurrency(error)) throw error;
          }
          continue;
        }
      }
      try {
        const settled = await controller.settleCancellation({
          commandId: `cancel_settle_${this.#createId()}`,
          expectedRunRevision: current.revision,
        });
        return effect(settled.run, { type: 'cancellation-settled' });
      } catch (error) {
        if (!isConcurrentKernelTransition(error)) throw error;
        current = await this.#readScoped(run.projectId, run.sessionId, run.runId);
        if (current.state === 'Cancelled') {
          return effect(current, { type: 'cancellation-settled' });
        }
      }
    }
    throw new TypeError('Cancellation recovery could not converge after concurrent transitions.');
  }

  async steer(input: SteerRunInput, run: KernelRunProjection): Promise<KernelEffect | null> {
    const prior = await this.#options.journal.getSteeringRequest({
      projectId: run.projectId, sessionId: run.sessionId, runId: run.runId,
      clientRequestId: input.clientRequestId,
    });
    if (prior !== null) {
      if (canonicalPortableJson(prior.input) !== canonicalPortableJson(input.input)) {
        throw new AgentJournalError(
          'IDEMPOTENCY_CONFLICT',
          'clientRequestId was already used for different Steering content.',
        );
      }
      return null;
    }
    const controller = await this.#controller(run);
    const commandId = `steer_${sha256(`${run.runId}\0${input.clientRequestId}`)}`;
    const pending = await this.#options.journal.getPendingSteering({
      projectId: run.projectId, sessionId: run.sessionId, runId: run.runId,
    });
    const stable = pending === null &&
      ['Preparing', 'AwaitingUser', 'Interrupted', 'LimitReached'].includes(run.state);
    const steered = await (stable ? controller.steer({
      commandId,
      expectedRunRevision: run.revision,
      clientRequestId: input.clientRequestId,
      value: input.input,
    }) : controller.queueSteering({
      commandId,
      expectedRunRevision: run.revision,
      clientRequestId: input.clientRequestId,
      value: input.input,
    }));
    return steered.run.revision <= run.revision
      ? null
      : effect(steered.run, { type: 'run-steered' });
  }

  async #consumePendingSteering(
    run: KernelRunProjection,
    controller: RunController,
  ): Promise<KernelEffect | null> {
    const pending = await this.#options.journal.getPendingSteering({
      projectId: run.projectId, sessionId: run.sessionId, runId: run.runId,
    });
    if (pending === null) return null;
    const consumed = await controller.consumeSteering({
      commandId: `consume_steer_${sha256(`${run.runId}\0${pending.clientRequestId}`)}`,
      expectedRunRevision: run.revision,
      clientRequestId: pending.clientRequestId,
      value: pending.input,
    });
    return effect(consumed.run, { type: 'run-steered' });
  }

  async approve(input: ApproveRunInput, run: KernelRunProjection): Promise<KernelEffect | null> {
    const approval = await this.#approvalById(run, input.approvalId);
    if (approval === undefined) throw new TypeError(`Approval not found: ${input.approvalId}`);
    if (approval.status !== 'pending') {
      const priorDecision = approval.status === 'approved' ? 'approve' : 'deny';
      const expectedReason = input.decision === 'deny'
        ? input.reason ?? 'The tool invocation was denied.'
        : input.reason;
      if (priorDecision !== input.decision || approval.reason !== expectedReason) {
        throw new AgentJournalError(
          'APPROVAL_DECISION_CONFLICT', 'Approval already has a conflicting decision.',
        );
      }
      return null;
    }
    if (
      run.state !== 'AwaitingUser' || run.waitReason !== 'approval' ||
      run.currentTurnId === null
    ) {
      throw new AgentJournalError(
        'COMMAND_CONFLICT', 'Run is not waiting for a Tool approval.',
      );
    }
    const controller = await this.#controller(run);
    const runtime = await this.#toolRuntime(run, controller);
    const decision = await runtime.decideApproval({
      commandId: `approval_${this.#createId()}`,
      approvalId: approval.approvalId,
      projectId: run.projectId,
      sessionId: run.sessionId,
      runId: run.runId,
      turnId: run.currentTurnId,
      invocationId: approval.invocationId,
      canonicalToolId: approval.canonicalToolId,
      toolRevision: approval.toolRevision,
      recoveryClass: approval.recoveryClass,
      intentDigest: approval.intentDigest,
      proposedRevision: approval.proposedRevision,
      decision: input.decision,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    });
    return effect(
      await this.#readScoped(run.projectId, run.sessionId, run.runId),
      { type: 'schedule-decided', decision },
    );
  }

  async submitQuestion(input: SubmitQuestionInput, run: KernelRunProjection): Promise<KernelEffect | null> {
    const invocation = await this.#options.journal.getInvocation(input.invocationId);
    if (!invocation || invocation.projectId !== run.projectId || invocation.sessionId !== run.sessionId || invocation.runId !== run.runId || !invocation.question || invocation.question.owner.hostId !== (this.#options.toolHostId ?? 'local')) throw new AgentJournalError('COMMAND_CONFLICT', 'Question does not belong to this Host/Run.');
    validateQuestionCommand(input.command, invocation.question);
    if (invocation.observation) {
      const summary = invocation.terminal?.durableSummary as Record<string, PortableValue> | undefined;
      if (summary?.questionCommandDigest === questionCommandDigest(input.command)) return null;
      throw new AgentJournalError('IDEMPOTENCY_CONFLICT', 'Question already has another resolution.');
    }
    if (run.currentTurnId !== invocation.turnId) throw new AgentJournalError('COMMAND_CONFLICT', 'Question belongs to another Turn.');
    const controller = await this.#controller(run);
    const runtime = await this.#toolRuntime(run, controller);
    await runtime.submitQuestion(input.invocationId, input.command);
    return effect(await this.#readScoped(run.projectId, run.sessionId, run.runId), { type: 'schedule-decided', decision: await runtime.resolve() });
  }

  async resolveOutcome(
    input: ResolveOutcomeInput,
    run: KernelRunProjection,
  ): Promise<KernelEffect | null> {
    const invocation = await this.#options.journal.getInvocation(input.invocationId);
    if (
      invocation !== null && invocation.projectId === run.projectId &&
      invocation.sessionId === run.sessionId && invocation.runId === run.runId &&
      invocation.outcomeResolution !== undefined
    ) {
      if (
        invocation.outcomeResolution.outcome !== input.outcome ||
        invocation.terminal?.summary !== requireText(input.summary, 'summary')
      ) {
        throw new AgentJournalError(
          'OUTCOME_RESOLUTION_CONFLICT',
          'Unknown outcome already has a conflicting resolution.',
        );
      }
      if (run.state !== 'AwaitingUser' || run.waitReason !== 'outcome_resolution') return null;
      return await this.#completeResolvedOutcome(run, invocation.turnId);
    }
    if (
      run.state !== 'AwaitingUser' || run.waitReason !== 'outcome_resolution' ||
      run.currentTurnId === null
    ) {
      throw new AgentJournalError(
        'COMMAND_CONFLICT', 'Run is not waiting for an unknown Tool outcome.',
      );
    }
    if (
      invocation === null || invocation.projectId !== run.projectId ||
      invocation.sessionId !== run.sessionId || invocation.runId !== run.runId ||
      invocation.turnId !== run.currentTurnId || invocation.state !== 'observed' ||
      invocation.terminal?.kind !== 'unknown' || invocation.outcomeResolution !== undefined ||
      invocation.canonicalToolId === undefined || invocation.toolRevision === undefined ||
      invocation.recoveryClass === undefined || invocation.intentDigest === undefined ||
      invocation.proposedRevision === undefined
    ) {
      throw new AgentJournalError(
        'COMMAND_CONFLICT', 'Outcome decision does not match an unresolved Invocation.',
      );
    }
    const controller = await this.#controller(run);
    const runtime = await this.#toolRuntime(run, controller);
    await runtime.resolveUnknownOutcome({
      commandId: `resolve_outcome_${this.#createId()}`,
      invocationId: invocation.invocationId,
      canonicalToolId: invocation.canonicalToolId,
      toolRevision: invocation.toolRevision,
      recoveryClass: invocation.recoveryClass,
      intentDigest: invocation.intentDigest,
      proposedRevision: invocation.proposedRevision,
      outcome: input.outcome,
      summary: requireText(input.summary, 'summary'),
    });
    return await this.#completeResolvedOutcome(run, run.currentTurnId);
  }

  async authorizeRiskyRetry(
    input: AuthorizeRiskyRetryInput,
    run: KernelRunProjection,
  ): Promise<KernelEffect | null> {
    const invocation = await this.#options.journal.getInvocation(input.invocationId);
    const reason = requireText(input.reason, 'reason');
    const clientRequestId = requireText(input.clientRequestId, 'clientRequestId');
    const commandId = `risky_retry_${sha256(`${input.invocationId}\0${clientRequestId}`)}`;
    const permitId = `retry_${sha256(`${input.invocationId}\0${commandId}`)}`;
    if (
      invocation === null || invocation.projectId !== run.projectId ||
      invocation.sessionId !== run.sessionId || invocation.runId !== run.runId ||
      invocation.canonicalToolId === undefined || invocation.toolRevision === undefined ||
      invocation.recoveryClass !== 'non_idempotent' ||
      invocation.intentDigest === undefined || invocation.proposedRevision === undefined
    ) {
      throw new AgentJournalError(
        'COMMAND_CONFLICT', 'Risky retry does not match a non-idempotent unknown Invocation.',
      );
    }
    if (invocation.outcomeResolution !== undefined) {
      if (
        invocation.outcomeResolution.outcome !== 'failed' ||
        invocation.retryPermit?.permitId !== permitId || invocation.retryPermit.reason !== reason
      ) {
        throw new AgentJournalError(
          'RISKY_RETRY_AUTHORIZATION_CONFLICT',
          'Unknown outcome already has a conflicting retry decision.',
        );
      }
      if (run.state !== 'AwaitingUser' || run.waitReason !== 'outcome_resolution') return null;
      return await this.#completeResolvedOutcome(run, invocation.turnId);
    }
    if (
      invocation.terminal?.kind !== 'unknown' ||
      run.state !== 'AwaitingUser' || run.waitReason !== 'outcome_resolution' ||
      run.currentTurnId === null || invocation.turnId !== run.currentTurnId ||
      invocation.state !== 'observed'
    ) {
      throw new AgentJournalError(
        'COMMAND_CONFLICT', 'Run is not waiting for this unknown Tool outcome.',
      );
    }
    const controller = await this.#controller(run);
    const runtime = await this.#toolRuntime(run, controller);
    try {
      await runtime.resolveUnknownOutcome({
        commandId,
        invocationId: invocation.invocationId,
        canonicalToolId: invocation.canonicalToolId,
        toolRevision: invocation.toolRevision,
        recoveryClass: invocation.recoveryClass,
        intentDigest: invocation.intentDigest,
        proposedRevision: invocation.proposedRevision,
        outcome: 'failed',
        summary: 'The unknown outcome was settled for an explicitly authorized retry.',
        retryAuthorization: { permitId, reason },
      });
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error && error.code === 'OUTCOME_RESOLUTION_CONFLICT'
      ) {
        throw new AgentJournalError(
          'RISKY_RETRY_AUTHORIZATION_CONFLICT',
          'Unknown outcome already has a conflicting retry decision.',
        );
      }
      throw error;
    }
    return await this.#completeResolvedOutcome(run, run.currentTurnId);
  }

  async #completeResolvedOutcome(
    run: KernelRunProjection,
    turnId: string,
  ): Promise<KernelEffect> {
    const controller = await this.#controller(run);
    const current = await this.#readScoped(run.projectId, run.sessionId, run.runId);
    const unresolved = unresolvedOutcomeRequests(await this.#turnInvocations(current, turnId));
    if (unresolved.length > 0) {
      return effect(current, { type: 'outcome-resolution-required' });
    }
    const completed = await controller.completeOutcomeResolution({
      commandId: `outcome_complete_${this.#createId()}`,
      expectedRunRevision: current.revision,
      turnId,
    });
    this.#releaseTurnDependencies(run, turnId);
    return effect(completed.run, { type: 'run-resumed', resumeState: 'Preparing' });
  }

  async #approvalById(
    run: KernelRunProjection,
    approvalId: string,
  ): Promise<ToolApprovalFact | undefined> {
    let cursor: string | undefined;
    do {
      const page = await this.#options.journal.listApprovals({
        projectId: run.projectId,
        sessionId: run.sessionId,
        runId: run.runId,
        limit: 1_000,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const found = page.items.find((item) => item.approvalId === approvalId);
      if (found !== undefined) return found;
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return undefined;
  }

  async cancel(input: CancelRunInput, run: KernelRunProjection): Promise<KernelEffect> {
    const controller = await this.#controller(run);
    const cancelled = await controller.requestCancel({
      commandId: `cancel_${this.#createId()}`,
      expectedRunRevision: run.revision,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    });
    controller.abortWork(input.reason);
    return effect(cancelled.run, { type: 'cancel-requested' });
  }

  async resume(input: ResumeRunInput, run: KernelRunProjection): Promise<KernelEffect> {
    const controller = await this.#controller(run);
    let resumed = await controller.resume({
      commandId: `resume_${this.#createId()}`,
      expectedRunRevision: run.revision,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    });
    if (resumed.run.currentAttemptId !== null) {
      if (resumed.run.currentTurnId === null) {
        throw new TypeError('A resumed Model Attempt requires its persisted Turn identity.');
      }
      const turn = await this.#turnLifecycle(resumed.run, 'started');
      resumed = await controller.discardModelAttempt({
        commandId: `resume_discard_${resumed.run.currentAttemptId}`,
        expectedRunRevision: resumed.run.revision,
        turnId: resumed.run.currentTurnId,
        expectedTurnRevision: turn.revision,
        attemptId: resumed.run.currentAttemptId,
        reason: 'explicit-resume-after-interruption',
        failure: { code: 'MODEL_ATTEMPT_ABANDONED', retryable: true },
      });
    }
    return effect(resumed.run, {
      type: 'run-resumed',
      resumeState: requireResumedState(resumed.run.state),
    });
  }

  async interruptExecution(
    input: InterruptExecutionInput,
    run: KernelRunProjection,
  ): Promise<KernelEffect> {
    const controller = await this.#controller(run);
    const interrupted = await controller.interrupt({
      commandId: `executor_interrupted_${this.#createId()}`,
      expectedRunRevision: run.revision,
      code: requireText(input.code, 'code'),
      ...(input.detail === undefined ? {} : { detail: structuredClone(input.detail) }),
    });
    return effect(interrupted.run, { type: 'interrupted' });
  }

  async requestManualCompaction(
    _input: ManualCompactionInput,
    run: KernelRunProjection,
    mode: 'queue' | 'start',
  ): Promise<KernelEffect> {
    if (mode === 'queue') {
      const controller = await this.#controller(run);
      const decisionId = `decision_${this.#createId()}`;
      const queued = await controller.queueContextCompaction({
        commandId: `manual_context_queue_${decisionId}`,
        expectedRunRevision: run.revision,
        decisionId,
      });
      return effect(queued.run, { type: 'manual-compaction-queued' });
    }
    const controller = await this.#controller(run);
    const throughSequence = (await this.#compilePrompt(run)).throughSequence;
    const started = await controller.startContextCompaction({
      commandId: `manual_context_${this.#createId()}`,
      expectedRunRevision: run.revision,
      checkpointId: `checkpoint_${this.#createId()}`,
      decisionId: `decision_${this.#createId()}`,
      reason: 'manual',
      coveredSequence: throughSequence,
    });
    return effect(started.run, {
      type: 'context-compaction-required', coveredSequence: throughSequence,
    });
  }

  async recordNoProgress(
    run: KernelRunProjection,
    input: Readonly<{ fingerprint: string; turnId: string }>,
  ): Promise<KernelEffect> {
    const controller = await this.#controller(run);
    const recorded = await controller.recordNoProgress({
      commandId: `no_progress_${this.#createId()}`,
      expectedRunRevision: run.revision,
      fingerprint: input.fingerprint,
      turnId: input.turnId,
    });
    return effect(recorded.run, { type: 'no-progress-recorded' });
  }

  async listPending(run: KernelRunProjection): Promise<readonly AgentPendingRequest[]> {
    if (run.state !== 'AwaitingUser') return [];
    if (run.waitReason === 'tool_input') {
      if (run.currentTurnId === null) throw new TypeError('Pending question requires its original Turn.');
      return (await this.#turnInvocations(run, run.currentTurnId))
        .filter(invocation => invocation.state === 'waiting_for_user' && invocation.question !== undefined)
        .map(invocation => ({ kind: 'tool-question' as const, requestId: invocation.question!.questionId, invocationId: invocation.invocationId, bundle: structuredClone(invocation.question!) }));
    }
    if (run.waitReason === 'outcome_resolution') {
      if (run.currentTurnId === null) {
        throw new TypeError('Outcome resolution requires the blocked Turn identity.');
      }
      const invocations = await this.#turnInvocations(run, run.currentTurnId);
      return unresolvedOutcomeRequests(invocations).map((request) => ({
        kind: 'outcome-resolution',
        requestId: `outcome:${request.invocationId}`,
        invocationId: request.invocationId,
        summary: request.summary,
      }));
    }
    if (run.waitReason !== 'approval') {
      if (!isAgentWaitReason(run.waitReason)) {
        throw new TypeError('AwaitingUser Run has an invalid wait reason.');
      }
      return [{
        kind: 'input',
        requestId: `input:${run.runId}:${run.revision}`,
        reason: run.waitReason,
      }];
    }
    const page = await this.#options.journal.listApprovals({
      projectId: run.projectId,
      sessionId: run.sessionId,
      runId: run.runId,
      status: 'pending',
      limit: 1_000,
    });
    return page.items.map<AgentPendingRequest>((approval) => ({
      kind: 'approval',
      requestId: approval.approvalId,
      invocationId: approval.invocationId,
    }));
  }

  async checkLimits(
    run: KernelRunProjection,
    limits: AgentRunLimits,
  ): Promise<KernelEffect | null> {
    if (limits.maxCostMicrounits !== undefined && this.#options.costMeter === undefined) {
      throw new TypeError(
        'maxCostMicrounits requires an explicit durable cost meter configuration.',
      );
    }
    let limit: string | undefined;
    let value: number | undefined;
    if (limits.deadlineAt !== undefined && this.#now() >= Date.parse(limits.deadlineAt)) {
      limit = 'deadlineAt';
      value = Date.parse(limits.deadlineAt);
    }
    if (limit === undefined && limits.maxTurns !== undefined) {
      const events = await this.#runEvents(
        run.projectId,
        run.sessionId,
        run.runId,
        0,
      );
      const turns = events.filter((event) => event.type === 'turn.started').length;
      if (turns >= limits.maxTurns) {
        limit = 'maxTurns';
        value = limits.maxTurns;
      }
    }
    if (
      limit === undefined && limits.maxCostMicrounits !== undefined &&
      this.#options.costMeter !== undefined
    ) {
      const environment = await this.#options.journal.getEnvironmentBinding({
        projectId: run.projectId,
        sessionId: run.sessionId,
        runId: run.runId,
      });
      if (environment !== null) {
        const usage = await this.#options.journal.getRunUsage({
          projectId: run.projectId,
          sessionId: run.sessionId,
          runId: run.runId,
        });
        const cost = await this.#options.costMeter({
          projectId: run.projectId,
          sessionId: run.sessionId,
          runId: run.runId,
          environment,
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.totalTokens,
          },
        });
        if (!Number.isSafeInteger(cost) || cost < 0) {
          throw new TypeError('The durable cost meter must return non-negative integer microunits.');
        }
        if (cost >= limits.maxCostMicrounits) {
          limit = 'maxCostMicrounits';
          value = cost;
        }
      }
    }
    if (limit === undefined) return null;
    const controller = await this.#controller(run);
    const reached = await controller.reachLimit({
      commandId: `limit_${this.#createId()}`,
      expectedRunRevision: run.revision,
      limit,
      ...(value === undefined ? {} : { value }),
    });
    return effect(reached.run, { type: 'limit-reached' });
  }

  async #compact(
    run: KernelRunProjection,
    controller: RunController,
    signal: AbortSignal,
  ): Promise<KernelEffect> {
    const checkpoint = await this.#options.journal.getLatestContextCheckpoint({
      projectId: run.projectId,
      sessionId: run.sessionId,
      runId: run.runId,
      status: 'started',
    });
    if (checkpoint === null) throw new TypeError('Compacting Run has no started checkpoint.');
    const compactedInput = await this.#compilePrompt(run, {
      throughSequence: checkpoint.coveredSequence,
      includeCurrentRunOpaque: false,
    });
    if (compactedInput.truncated || compactedInput.throughSequence !== checkpoint.coveredSequence) {
      throw new ContextLifecycleError(
        'CONTEXT_HISTORY_INVALID',
        'Context checkpoint input does not match its committed Session sequence boundary.',
      );
    }
    const prompt = compactedInput.prompt;
    const modelLifecycle = openModelLifecycleJournalApplication(this.#options.journal);
    const turnId = run.currentTurnId;
    if (turnId === null) throw new TypeError('Compacting Run requires an active Turn.');
    const session = await this.#exactRunSession(run);
    const lifecycle = new ContextLifecycle({
      gateway: this.#options.gateway,
      session,
      observer: {
        onEvent: async (event) => {
          if (event.type !== 'usage-observed') return;
          if (event.purpose !== 'context-compaction') {
            throw new TypeError('Context compaction emitted usage with a foreign purpose.');
          }
          await modelLifecycle.commit({
            schemaVersion: 1,
            projectId: run.projectId,
            sessionId: run.sessionId,
            runId: run.runId,
            turnId,
            checkpointId: checkpoint.checkpointId,
            decisionId: checkpoint.decisionId,
            attemptId: event.attemptId,
            commandId: `${run.runId}:context-usage:${checkpoint.checkpointId}:${event.attemptId}`,
            lease: leaseReference(controller),
            expectedRunRevision: run.revision,
            fact: {
              ...event,
              purpose: 'context-compaction' as const,
              billingMode: this.#usageBillingMode(session, event.routeId),
            },
          });
        },
      },
    });
    try {
      await controller.ensureLeaseFresh();
      const compacted = await lifecycle.compact({
          decisionId: checkpoint.decisionId,
          committedThroughSequence: checkpoint.coveredSequence,
          messages: prompt.messages,
          signal,
        });
      const completed = await controller.completeContextCompaction({
        commandId: `context_complete_${checkpoint.checkpointId}`,
        expectedRunRevision: run.revision,
        checkpointId: checkpoint.checkpointId,
        decisionId: checkpoint.decisionId,
        summaryRef: `context:${checkpoint.checkpointId}`,
        summary: compacted.summary,
        coveredSequence: compacted.committedThroughSequence,
        attemptId: compacted.attemptId,
        ...(compacted.usage === undefined ? {} : { usage: compacted.usage }),
        ...(compacted.usage === undefined ? {} : {
          billingMode: this.#usageBillingMode(session, compacted.routeId),
        }),
      });
      return effect(completed.run, {
        type: 'context-compacted', coveredSequence: compacted.committedThroughSequence,
      });
    } catch (error) {
      controller.assertLeaseActive();
      const failed = await controller.failContextCompaction({
        commandId: `context_fail_${checkpoint.checkpointId}`,
        expectedRunRevision: run.revision,
        checkpointId: checkpoint.checkpointId,
        decisionId: checkpoint.decisionId,
        code: error instanceof ContextLifecycleError ? error.code : 'CONTEXT_COMPACTION_FAILED',
      });
      return effect(failed.run, { type: 'interrupted' });
    }
  }

  async #compilePrompt(
    run: KernelRunProjection,
    options: Readonly<{
      throughSequence?: number;
      includeCurrentRunOpaque?: boolean;
    }> = {},
  ): Promise<Readonly<{
    prompt: CompiledPrompt;
    toolCatalog: ToolCatalogSnapshot;
    checkpoint: Readonly<{ summaryRef: string; summary: string; coveredSequence: number }> | null;
    protocolEnvelopes: readonly ModelProtocolEnvelope[];
    throughSequence: number;
    truncated: boolean;
  }>> {
    const session = await this.#exactRunSession(run);
    const sessionIndex = await this.#options.journal.getSessionIndex(
      run.projectId,
      run.sessionId,
    );
    if (sessionIndex === null) throw new TypeError('Prompt compilation requires its Session.');
    const requestedThroughSequence = options.throughSequence ?? sessionIndex.lastActivitySequence;
    if (
      !Number.isSafeInteger(requestedThroughSequence) || requestedThroughSequence < 0 ||
      requestedThroughSequence > sessionIndex.lastActivitySequence
    ) {
      throw new ContextLifecycleError(
        'CONTEXT_HISTORY_INVALID', 'Session Context boundary is invalid or no longer available.',
      );
    }
    const checkpoint = await this.#options.journal.getLatestSessionContextCheckpoint({
      projectId: run.projectId,
      sessionId: run.sessionId,
      throughSequence: requestedThroughSequence,
      status: 'compacted',
    });
    const afterSequence = checkpoint?.coveredSequence ?? 0;
    const historyPage = await readBoundedContextItems<AgentEvent>({
      readPage: async ({ afterSequence: cursor, throughSequence, limit }) => {
        const page = await this.#options.journal.readSession({
          projectId: run.projectId,
          sessionId: run.sessionId,
          afterSequence: cursor,
          throughSequence,
          eventTypes: MODEL_HISTORY_EVENT_TYPES,
          limit,
        });
        return page;
      },
      afterSequence,
      throughSequence: requestedThroughSequence,
      pageSize: EVENT_PAGE_SIZE,
      maxItems: this.#maxContextEvents,
    });
    let events = historyPage.items;
    let throughSequence = historyPage.nextSequence;
    if (historyPage.truncated) {
      throughSequence = latestSafeModelHistorySequence(events, afterSequence);
      if (throughSequence <= afterSequence) {
        throw new ContextLifecycleError(
          'CONTEXT_HISTORY_INVALID',
          'Bounded Session Context has no safe Tool/Observation checkpoint boundary.',
        );
      }
      events = events.filter((event) => event.sequence <= throughSequence);
    }
    if (run.currentTurnId === null) throw new TypeError('Prompt compilation requires an active Turn.');
    const turnSnapshot = await this.#options.journal.getTurnSnapshot({
      projectId: run.projectId,
      sessionId: run.sessionId,
      runId: run.runId,
      turnId: run.currentTurnId,
    });
    if (turnSnapshot === null || turnSnapshot.environmentBindingId !== run.environmentBindingId) {
      throw new TypeError('Prompt compilation requires the exact captured Turn Snapshot.');
    }
    const toolCatalog = await this.#exactToolCatalog(run, turnSnapshot);
    const tools = canonicalTools(toolCatalog, turnSnapshot.payload.tools);
    const promptSnapshot = await this.#exactPromptSnapshot(run, turnSnapshot);
    const promptRuntime = new PromptRuntime({ runtimeProtocol: promptSnapshot.runtimeProtocol });
    const base = promptRuntime.compile({
      model: primarySession(session).route.modelId,
      sections: promptSnapshot.sections,
      tools,
      ...(checkpoint === null ? {} : {
        checkpoint: { summary: checkpoint.summary ?? '', coveredSequence: checkpoint.coveredSequence },
      }),
      generation: primarySession(session).generation,
    });
    const protocolEnvelopes = await this.#protocolEnvelopes(events);
    const currentRunAttemptIds = new Set(events.flatMap((event) =>
      event.type === 'model_attempt_committed' && event.runId === run.runId &&
        event.attemptId !== undefined
        ? [event.attemptId]
        : []));
    const currentRunProtocolEnvelopes = protocolEnvelopes.filter((envelope) =>
      currentRunAttemptIds.has(envelope.attemptId));
    const history = projectAgentHistoryForModel(events, {
      currentRunId: run.runId,
      includeCurrentRunOpaque:
        options.includeCurrentRunOpaque !== false &&
        exactReplayOrigin(primarySession(session), currentRunProtocolEnvelopes),
    });
    const messages: ModelMessage[] = [
      ...base.messages.map(cloneMessage),
      ...history.map(cloneMessage),
    ];
    const request = {
      ...base.request,
      messages: messages.map(cloneMessage),
    };
    const prompt: CompiledPrompt = deepFreeze({
      messages,
      tools,
      tokenEstimate: base.tokenEstimate + estimateTokens(history),
      request,
    });
    return {
      prompt,
      toolCatalog,
      checkpoint: checkpoint === null ? null : {
        summaryRef: checkpoint.summaryRef ?? `context:${checkpoint.checkpointId}`,
        summary: checkpoint.summary ?? '',
        coveredSequence: checkpoint.coveredSequence,
      },
      protocolEnvelopes,
      throughSequence,
      truncated: historyPage.truncated,
    };
  }

  async #protocolEnvelopes(events: readonly AgentEvent[]): Promise<readonly ModelProtocolEnvelope[]> {
    const envelopes: ModelProtocolEnvelope[] = [];
    for (const event of events) {
      if (event.type !== 'model_attempt_committed') continue;
      if (event.turnId === undefined || event.attemptId === undefined) {
        throw new TypeError('Committed Model event has no exact Turn or Attempt identity.');
      }
      const envelope = await this.#options.journal.getProtocolEnvelope(event.turnId);
      if (envelope === null || envelope.attemptId !== event.attemptId) {
        throw new TypeError('Committed Model event has no matching protocol envelope.');
      }
      envelopes.push(envelope);
    }
    return Object.freeze(envelopes);
  }

  async #captureTurnRuntime(
    run: KernelRunProjection,
    turnId: string,
    signal: AbortSignal,
  ): Promise<JournalAgentTurnRuntimeLease | undefined> {
    if (this.#options.captureTurnRuntime === undefined) return undefined;
    const key = toolCatalogCacheKey(run, turnId);
    if (this.#turnRuntimeLeases.has(key)) {
      throw new ExactTurnDependencyError('TURN_RUNTIME_ALREADY_CAPTURED');
    }
    let raw: JournalAgentTurnRuntimeLease;
    try {
      const events = await this.#runEvents(
        run.projectId, run.sessionId, run.runId, 0,
      );
      const turnIndex = events.filter((event) => event.type === 'turn.started').length + 1;
      raw = await this.#options.captureTurnRuntime({
        projectId: run.projectId,
        sessionId: run.sessionId,
        runId: run.runId,
        turnId,
        turnIndex,
        query: durableTurnQuery(events),
        signal,
      });
    } catch (error) {
      throw new ExactTurnDependencyError('TURN_RUNTIME_UNAVAILABLE', error);
    }
    let lease: JournalAgentTurnRuntimeLease;
    try {
      lease = onceTurnRuntimeLease(raw);
    } catch (error) {
      if (raw !== null && typeof raw === 'object' && typeof raw.release === 'function') {
        raw.release();
      }
      throw new ExactTurnDependencyError('TURN_RUNTIME_INVALID', error);
    }
    this.#turnRuntimeLeases.set(key, lease);
    return lease;
  }

  async #turnSnapshot(
    _session: ModelSession | ModelSessionBundle,
    run: KernelRunProjection,
    turnId: string,
    runtime?: JournalAgentTurnRuntimeLease,
  ) {
    const toolCatalog = runtime?.toolCatalog ?? this.#options.toolCatalog;
    const verifier = runtime?.verifier ?? this.#options.verifier;
    const skills = [...(runtime?.skills ?? this.#options.skills ?? [])]
      .map((skill) => structuredClone(skill));
    const skillAllowedTools = skills.some((skill) => skill.allowedTools !== undefined)
      ? skills.flatMap((skill) => skill.allowedTools ?? [])
      : undefined;
    const runtimeState = await this.#options.journal.getRuntimeCommandProjection({
      projectId: run.projectId,
      sessionId: run.sessionId,
      runId: run.runId,
    });
    const exposure = new ToolExposurePlanner().plan({
      registry: toolCatalog,
      ...(this.#options.allowedTools === undefined
        ? {}
        : { allowedTools: this.#options.allowedTools }),
      activeTools: runtimeState?.activeTools ?? [],
      ...(skillAllowedTools === undefined ? {} : { skillAllowedTools }),
    });
    const identity = (name: string) => ({
      name,
      revision: requiredToolRevision(toolCatalog, name),
    });
    return {
      turnSnapshotId: `snapshot_${turnId}`,
      capability: structuredClone(runtime?.capability ?? this.#options.capability),
      promptRevision: requireText(
        runtime?.promptRevision ?? this.#options.promptRevision,
        'promptRevision',
      ),
      runtimeProtocol: runtime?.runtimeProtocol ?? this.#options.runtimeProtocol,
      promptSections: runtime?.promptSections ?? this.#options.promptSections ?? [],
      tools: exposure.modelTools.map((tool) => identity(tool.name)),
      discoverableTools: exposure.catalog.map((tool) => identity(tool.flatName)),
      ...(runtime?.discoverableCapabilities === undefined
        ? {}
        : { discoverableCapabilities: runtime.discoverableCapabilities }),
      skills,
      hooks: (runtime?.invocationHooks ?? this.#options.invocationHooks ?? []).map((hook) => ({
        id: requireText(hook.id, 'hook.id'),
        revision: requireText(hook.revision, 'hook.revision'),
      })),
      verifiers: verifier === undefined ? [] : [{
        id: verifier.verifierId,
        revision: verifier.revision,
        required: verifier.mode === 'required',
      }],
    };
  }

  async #toolRuntime(
    run: KernelRunProjection,
    controller: RunController,
  ): Promise<ToolInvocationRuntime> {
    if (run.currentTurnId === null) throw new TypeError('Tool Runtime requires an active Turn.');
    const turnSnapshot = await this.#options.journal.getTurnSnapshot({
      projectId: run.projectId,
      sessionId: run.sessionId,
      runId: run.runId,
      turnId: run.currentTurnId,
    });
    if (turnSnapshot === null || turnSnapshot.environmentBindingId !== run.environmentBindingId) {
      throw new ToolCatalogResolutionError(
        'The exact captured Turn Snapshot is unavailable for Tool execution.',
      );
    }
    let registry: ToolCatalogSnapshot;
    let unavailableCatalog = false;
    try { registry = await this.#exactToolCatalog(run, turnSnapshot); } catch (error) {
      if (!(error instanceof ToolCatalogResolutionError)) throw error;
      // Empty catalog permits explicit unsupported_revision settlement, never current-handler fallback.
      registry = new ToolRegistry().captureSnapshot();
      unavailableCatalog = true;
    }
    const policy = await this.#exactPermissionPolicy(run, turnSnapshot);
    const invocationHooks = await this.#exactInvocationHooks(run, turnSnapshot);
    const modelSession = await this.#exactRunSession(run);
    const resultProjectionBudget = toolResultProjectionBudget(modelSession);
    return new ToolInvocationRuntime({
      ...(this.#options.toolHostId === undefined ? {} : { hostId: this.#options.toolHostId }),
      ...(this.#options.toolResourceLeases === undefined ? {} : { resourceLeases: this.#options.toolResourceLeases }),
      ...(this.#options.revalidateToolTarget === undefined ? {} : { revalidateTarget: this.#options.revalidateToolTarget }),
      journal: this.#options.journal,
      registry,
      allowedTools: turnSnapshot.payload.tools,
      discoverableTools: unavailableCatalog ? [] : turnSnapshot.payload.discoverableTools ?? turnSnapshot.payload.tools,
      discoverableCapabilities: turnSnapshot.payload.discoverableCapabilities ?? [],
      invocationHooks,
      permissionManager: policy.permissionManager,
      ...(this.#options.artifactStore === undefined
        ? {}
        : { artifactStore: this.#options.artifactStore }),
      resultProjectionBudget,
      binding: {
        projectId: run.projectId,
        sessionId: run.sessionId,
        runId: run.runId,
        turnId: run.currentTurnId,
        lease: controller.currentLease(),
        mode: policy.mode,
      },
      ...(this.#options.maxToolConcurrency === undefined
        ? {}
        : { maxConcurrency: this.#options.maxToolConcurrency }),
      ...(this.#options.runtimeCommandExecutor === undefined
        ? {}
        : { runtimeCommandExecutor: this.#options.runtimeCommandExecutor }),
      now: this.#now,
    });
  }

  async #turnInvocations(
    run: KernelRunProjection,
    turnId: string,
  ): Promise<AgentInvocationProjection[]> {
    const invocations: AgentInvocationProjection[] = [];
    let afterActionOrdinal = -1;
    while (true) {
      const page = await this.#options.journal.listTurnInvocations({
        projectId: run.projectId,
        sessionId: run.sessionId,
        runId: run.runId,
        turnId,
        afterActionOrdinal,
        limit: 1_000,
      });
      if (page.length === 0) break;
      invocations.push(...page);
      if (page.length < 1_000) break;
      afterActionOrdinal = page.at(-1)!.actionOrdinal;
    }
    return invocations;
  }

  async #cancellationEffect(run: KernelRunProjection): Promise<KernelEffect | null> {
    const current = await this.#readScoped(run.projectId, run.sessionId, run.runId);
    if (current.state === 'Cancelling') return effect(current, { type: 'cancel-requested' });
    if (current.state === 'Cancelled') return effect(current, { type: 'cancellation-settled' });
    return null;
  }

  async #exactSession(
    projectId: string,
    sessionId: string,
    runId: string,
  ): Promise<ModelSession | ModelSessionBundle> {
    return (await this.#currentSession(projectId, sessionId, runId)).session;
  }

  async #initialTopLevelSession(
    projectId: string,
    sessionId: string,
    runId: string,
  ): Promise<Readonly<{
    session: ModelSession | ModelSessionBundle;
    binding: SessionModelBinding;
  }>> {
    let binding = await this.#bindingStore.get(projectId, sessionId);
    if (binding === null) {
      const candidate = await this.#resolveModelSession({
        projectId,
        sessionId,
        runId,
        binding: null,
      });
      try {
        binding = await this.#bindingStore.bind({
          projectId,
          sessionId,
          commandId: `model_bind_${this.#createId()}`,
          expectedRevision: 0,
          session: candidate,
        });
        this.#cacheLiveSession(sessionCacheKey(binding), candidate);
        return { session: candidate, binding };
      } catch (error) {
        if (!(error instanceof AgentJournalError) || error.code !== 'REVISION_CONFLICT') throw error;
        binding = await this.#bindingStore.get(projectId, sessionId);
        if (binding === null) throw error;
      }
    }
    const key = sessionCacheKey(binding);
    const cached = this.#liveSessions.get(key);
    if (cached !== undefined) return { session: cached, binding };
    const live = await this.#resolveModelSession({
      projectId,
      sessionId,
      runId,
      binding: {
        source: 'session',
        projectId,
        sessionId,
        revision: binding.revision,
        model: binding.model,
      },
    });
    const session = rehydrateExactRuntimeBinding(binding.model, live);
    this.#cacheLiveSession(key, session);
    return { session, binding };
  }

  async #currentSession(
    projectId: string,
    sessionId: string,
    runId: string,
  ): Promise<Readonly<{
    session: ModelSession | ModelSessionBundle;
    binding: SessionModelBinding;
  }>> {
    const inherited = await this.#inheritedChildEnvironment({ projectId, sessionId, runId });
    const resolutionScope = {
      projectId,
      sessionId,
      runId,
      ...(inherited === undefined ? {} : { parent: inherited.parent }),
    };
    const binding = await this.#bindingStore.get(projectId, sessionId);
    if (binding === null) {
      let session: ModelSession | ModelSessionBundle;
      if (inherited === undefined) {
        session = await this.#resolveModelSession({ ...resolutionScope, binding: null });
      } else {
        const inheritedModel = {
          descriptor: inherited.environment.payload.modelSession,
          bindingDigest: inherited.environment.payload.modelSession.bindingDigest,
        } satisfies PersistedModelRuntimeBinding;
        const live = await this.#resolveModelSession({
          ...resolutionScope,
          binding: {
            source: 'run-environment',
            projectId: inherited.parentRun.projectId,
            sessionId: inherited.parentRun.sessionId,
            runId: inherited.parentRun.runId,
            environmentBindingId: inherited.environment.environmentBindingId,
            model: inheritedModel,
          },
        });
        session = rehydrateExactRuntimeBinding(inheritedModel, live);
      }
      const persisted = await this.#bindingStore.bind({
        projectId,
        sessionId,
        commandId: `model_bind_${this.#createId()}`,
        expectedRevision: 0,
        session,
      });
      this.#cacheLiveSession(sessionCacheKey(persisted), session);
      return { session, binding: persisted };
    }
    if (
      inherited !== undefined &&
      binding.model.bindingDigest !== inherited.environment.payload.modelSession.bindingDigest
    ) {
      throw new SessionModelBindingError(
        'MODEL_BINDING_INVALID',
        'Child Session binding disagrees with the persisted parent Run Environment.',
      );
    }
    const key = sessionCacheKey(binding);
    const cached = this.#liveSessions.get(key);
    if (cached !== undefined) return { session: cached, binding };
    const live = await this.#resolveModelSession({
      ...resolutionScope,
      binding: {
        source: 'session', projectId, sessionId, revision: binding.revision, model: binding.model,
      },
    });
    const session = rehydrateExactRuntimeBinding(binding.model, live);
    this.#cacheLiveSession(key, session);
    return { session, binding };
  }

  async #exactRunSession(run: KernelRunProjection): Promise<ModelSession | ModelSessionBundle> {
    if (run.environmentBindingId === null) {
      return await this.#exactSession(run.projectId, run.sessionId, run.runId);
    }
    const environment = await this.#options.journal.getEnvironmentBinding({
      projectId: run.projectId,
      sessionId: run.sessionId,
      runId: run.runId,
    });
    if (
      environment === null || environment.environmentBindingId !== run.environmentBindingId
    ) {
      throw new TypeError('Run Environment binding is unavailable or disagrees with the Run.');
    }
    const model: PersistedModelRuntimeBinding = {
      descriptor: environment.payload.modelSession,
      bindingDigest: environment.payload.modelSession.bindingDigest,
    };
    const key = runSessionCacheKey(run.runId, environment.environmentBindingId, model.bindingDigest);
    const cached = this.#liveSessions.get(key);
    if (cached !== undefined) return cached;
    const live = await this.#resolveModelSession({
      projectId: run.projectId,
      sessionId: run.sessionId,
      runId: run.runId,
      ...await this.#parentResolutionScope(run),
      binding: {
        source: 'run-environment',
        projectId: run.projectId,
        sessionId: run.sessionId,
        runId: run.runId,
        environmentBindingId: environment.environmentBindingId,
        model,
      },
    });
    const session = rehydrateExactRuntimeBinding(model, live);
    this.#cacheLiveSession(key, session);
    return session;
  }

  async #parentResolutionScope(
    run: Pick<KernelRunProjection, 'projectId' | 'sessionId' | 'runId'>,
  ): Promise<Readonly<{ parent?: NonNullable<AgentRunProjection['parent']> }>> {
    const projection = await this.#options.journal.getRunProjection(run.runId);
    if (
      projection === null || projection.projectId !== run.projectId ||
      projection.sessionId !== run.sessionId
    ) {
      throw new TypeError('Run identity is unavailable for Model resolution.');
    }
    return projection.parent === undefined ? {} : { parent: projection.parent };
  }

  async #inheritedChildEnvironment(
    run: Pick<KernelRunProjection, 'projectId' | 'sessionId' | 'runId'>,
  ): Promise<Readonly<{
    parent: NonNullable<AgentRunProjection['parent']>;
    parentRun: AgentRunProjection;
    environment: PersistedEnvironmentBinding;
  }> | undefined> {
    const projection = await this.#options.journal.getRunProjection(run.runId);
    if (
      projection === null || projection.projectId !== run.projectId ||
      projection.sessionId !== run.sessionId
    ) {
      throw new TypeError('Child Run identity is unavailable for inherited Model resolution.');
    }
    if (projection.parent === undefined) return undefined;
    const parentRun = await this.#options.journal.getRunProjection(projection.parent.runId);
    if (parentRun === null || parentRun.projectId !== run.projectId) {
      throw new TypeError('Child Run parent scope is unavailable.');
    }
    const environment = await this.#options.journal.getEnvironmentBinding({
      projectId: parentRun.projectId,
      sessionId: parentRun.sessionId,
      runId: parentRun.runId,
    });
    if (environment === null) {
      throw new TypeError('Child Run parent Environment Binding is unavailable.');
    }
    return Object.freeze({ parent: projection.parent, parentRun, environment });
  }

  #usageBillingMode(session: ModelSession | ModelSessionBundle, routeId: string): UsageMode {
    const routes = 'primary' in session
      ? [session.primary, ...session.fallbacks]
      : [session];
    if (!routes.some((candidate) => candidate.route.routeId === routeId)) {
      throw new TypeError(`Usage was emitted by an unbound Model route: ${routeId}`);
    }
    const mode = this.#options.resolveUsageBillingMode({ session, routeId });
    if (mode !== 'byok' && mode !== 'managed') {
      throw new TypeError('Usage billing mode must be byok or managed.');
    }
    return mode;
  }

  async #resolveModelSession(input: Parameters<JournalAgentModelResolver>[0]): Promise<
    ModelSession | ModelSessionBundle
  > {
    try {
      return await this.#options.resolveModelSession(input);
    } catch (error) {
      if (error instanceof JournalAgentModelResolutionError) throw error;
      throw new JournalAgentModelResolutionError(
        'MODEL_BINDING_UNAVAILABLE',
        'The exact persisted Model runtime binding is unavailable.',
        undefined,
        error,
      );
    }
  }

  #cacheLiveSession(key: string, session: ModelSession | ModelSessionBundle): void {
    this.#liveSessions.delete(key);
    this.#liveSessions.set(key, session);
    while (this.#liveSessions.size > this.#maxCachedSessions) {
      const oldest = this.#liveSessions.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.#liveSessions.delete(oldest);
    }
  }

  async #exactToolCatalog(
    run: KernelRunProjection,
    turnSnapshot: PersistedTurnSnapshot,
  ): Promise<ToolCatalogSnapshot> {
    const required = uniqueToolIdentities([
      ...turnSnapshot.payload.tools,
      ...(turnSnapshot.payload.discoverableTools ?? []),
    ]);
    const turnRuntime = this.#turnRuntimeLeases.get(
      toolCatalogCacheKey(run, turnSnapshot.turnId),
    );
    if (turnRuntime !== undefined) {
      if (
        !capabilityIdentityEquals(turnRuntime.capability, turnSnapshot.payload.capability) ||
        !catalogMatches(turnRuntime.toolCatalog, required)
      ) {
        throw new ToolCatalogResolutionError(
          'The captured Turn Runtime no longer matches its persisted Tool identities.',
        );
      }
      return turnRuntime.toolCatalog;
    }
    if (catalogMatches(this.#options.toolCatalog, required)) return this.#options.toolCatalog;
    const key = toolCatalogCacheKey(run, turnSnapshot.turnId);
    const cached = this.#toolCatalogLeases.get(key);
    if (cached !== undefined) {
      if (!catalogMatches(cached.snapshot, required)) {
        this.#toolCatalogLeases.delete(key);
        cached.release();
        throw new ToolCatalogResolutionError(
          'The cached Tool Catalog no longer matches the captured Turn revision.',
        );
      }
      this.#toolCatalogLeases.delete(key);
      this.#toolCatalogLeases.set(key, cached);
      return cached.snapshot;
    }
    if (this.#options.resolveToolCatalogSnapshot === undefined) {
      throw new ToolCatalogResolutionError(
        'No resolver is configured for the exact captured Tool Catalog revision.',
      );
    }
    let rawLease: JournalAgentToolCatalogLease;
    try {
      rawLease = await this.#options.resolveToolCatalogSnapshot({
        projectId: run.projectId,
        sessionId: run.sessionId,
        runId: run.runId,
        turnId: turnSnapshot.turnId,
        turnSnapshotId: turnSnapshot.turnSnapshotId,
        tools: required.map((tool) => structuredClone(tool)),
      });
    } catch (error) {
      throw new ToolCatalogResolutionError(
        'The exact captured Tool Catalog revision could not be resolved.',
        error,
      );
    }
    if (
      rawLease === null || typeof rawLease !== 'object' ||
      !(rawLease.snapshot instanceof ToolCatalogSnapshot) ||
      typeof rawLease.release !== 'function'
    ) {
      throw new ToolCatalogResolutionError('The Tool Catalog resolver returned an invalid lease.');
    }
    const lease = onceToolCatalogLease(rawLease);
    if (!catalogMatches(lease.snapshot, required)) {
      lease.release();
      throw new ToolCatalogResolutionError(
        'The resolved Tool Catalog does not match the captured Tool identities and revisions.',
      );
    }
    if (this.#toolCatalogLeases.size >= this.#maxCachedToolCatalogs) {
      lease.release();
      throw new ToolCatalogResolutionError(
        'The bounded exact Tool Catalog lease cache is full with active Turns.',
      );
    }
    this.#toolCatalogLeases.set(key, lease);
    return lease.snapshot;
  }

  async #exactInvocationHooks(
    run: KernelRunProjection,
    turnSnapshot: PersistedTurnSnapshot,
  ): Promise<readonly AgentInvocationHookContribution[]> {
    const required = turnSnapshot.payload.hooks ?? [];
    const turnRuntime = this.#turnRuntimeLeases.get(
      toolCatalogCacheKey(run, turnSnapshot.turnId),
    );
    if (turnRuntime !== undefined && hooksMatch(turnRuntime.invocationHooks ?? [], required)) {
      return turnRuntime.invocationHooks ?? [];
    }
    if (hooksMatch(this.#options.invocationHooks ?? [], required)) {
      return this.#options.invocationHooks ?? [];
    }
    if (this.#options.resolveInvocationHooks === undefined) {
      throw new ExactTurnDependencyError('INVOCATION_HOOKS_UNAVAILABLE');
    }
    const hooks = await this.#options.resolveInvocationHooks({
      projectId: run.projectId,
      sessionId: run.sessionId,
      runId: run.runId,
      turnId: turnSnapshot.turnId,
      turnSnapshotId: turnSnapshot.turnSnapshotId,
      hooks: required.map((hook) => structuredClone(hook)),
    });
    if (!hooksMatch(hooks, required)) {
      throw new ExactTurnDependencyError('INVOCATION_HOOKS_REVISION_MISMATCH');
    }
    return Object.freeze([...hooks]);
  }

  async #exactPromptSnapshot(
    run: KernelRunProjection,
    turnSnapshot: PersistedTurnSnapshot,
  ): Promise<JournalAgentPromptSnapshotLease> {
    const key = turnDependencyKey('prompt', run, turnSnapshot.turnId);
    const cached = this.#promptSnapshotLeases.get(key);
    if (cached !== undefined) return cached;
    let raw: JournalAgentPromptSnapshotLease;
    const turnRuntime = this.#turnRuntimeLeases.get(
      toolCatalogCacheKey(run, turnSnapshot.turnId),
    );
    if (
      turnSnapshot.payload.runtimeProtocol !== undefined &&
      turnSnapshot.payload.promptSections !== undefined
    ) {
      raw = {
        revision: turnSnapshot.payload.promptRevision,
        runtimeProtocol: turnSnapshot.payload.runtimeProtocol,
        sections: turnSnapshot.payload.promptSections,
        release: () => undefined,
      };
    } else if (
      turnRuntime !== undefined &&
      turnRuntime.promptRevision === turnSnapshot.payload.promptRevision &&
      capabilityIdentityEquals(turnRuntime.capability, turnSnapshot.payload.capability) &&
      skillIdentitiesEqual(turnRuntime.skills, turnSnapshot.payload.skills)
    ) {
      raw = {
        revision: turnRuntime.promptRevision,
        runtimeProtocol: turnRuntime.runtimeProtocol,
        sections: turnRuntime.promptSections,
        release: () => undefined,
      };
    } else if (
      this.#options.promptRevision === turnSnapshot.payload.promptRevision &&
      capabilityIdentityEquals(this.#options.capability, turnSnapshot.payload.capability) &&
      skillIdentitiesEqual(this.#options.skills ?? [], turnSnapshot.payload.skills)
    ) {
      raw = {
        revision: this.#options.promptRevision,
        runtimeProtocol: this.#options.runtimeProtocol,
        sections: this.#options.promptSections ?? [],
        release: () => undefined,
      };
    } else if (this.#options.resolvePromptSnapshot !== undefined) {
      raw = await this.#options.resolvePromptSnapshot({
        projectId: run.projectId,
        sessionId: run.sessionId,
        runId: run.runId,
        turnId: turnSnapshot.turnId,
        turnSnapshotId: turnSnapshot.turnSnapshotId,
        promptRevision: turnSnapshot.payload.promptRevision,
        capability: structuredClone(turnSnapshot.payload.capability),
        skills: turnSnapshot.payload.skills.map((skill) => structuredClone(skill)),
      });
    } else {
      throw new ExactTurnDependencyError('PROMPT_REVISION_UNAVAILABLE');
    }
    if (raw.revision !== turnSnapshot.payload.promptRevision) {
      raw.release();
      throw new ExactTurnDependencyError('PROMPT_REVISION_MISMATCH');
    }
    const lease = oncePromptSnapshotLease(raw);
    this.#promptSnapshotLeases.set(key, lease);
    return lease;
  }

  async #exactPermissionPolicy(
    run: KernelRunProjection,
    turnSnapshot: PersistedTurnSnapshot,
  ): Promise<JournalAgentPermissionPolicyLease> {
    const key = turnDependencyKey('permission', run, turnSnapshot.turnId);
    const cached = this.#permissionPolicyLeases.get(key);
    if (cached !== undefined) return cached;
    const environment = await this.#options.journal.getEnvironmentBinding({
      projectId: run.projectId,
      sessionId: run.sessionId,
      runId: run.runId,
    });
    if (environment === null || environment.environmentBindingId !== run.environmentBindingId) {
      throw new ExactTurnDependencyError('PERMISSION_POLICY_ENVIRONMENT_UNAVAILABLE');
    }
    let raw: JournalAgentPermissionPolicyLease;
    if (this.#options.permissionPolicyRevision === environment.payload.permissionPolicyRevision) {
      raw = {
        revision: this.#options.permissionPolicyRevision,
        permissionManager: this.#options.permissionManager,
        mode: this.#options.mode ?? 'default',
        release: () => undefined,
      };
    } else if (this.#options.resolvePermissionPolicy !== undefined) {
      raw = await this.#options.resolvePermissionPolicy({
        projectId: run.projectId,
        sessionId: run.sessionId,
        runId: run.runId,
        turnId: turnSnapshot.turnId,
        turnSnapshotId: turnSnapshot.turnSnapshotId,
        permissionPolicyRevision: environment.payload.permissionPolicyRevision,
      });
    } else {
      throw new ExactTurnDependencyError('PERMISSION_POLICY_REVISION_UNAVAILABLE');
    }
    if (raw.revision !== environment.payload.permissionPolicyRevision) {
      raw.release();
      throw new ExactTurnDependencyError('PERMISSION_POLICY_REVISION_MISMATCH');
    }
    const lease = oncePermissionPolicyLease(raw);
    this.#permissionPolicyLeases.set(key, lease);
    return lease;
  }

  async #exactVerifier(
    run: KernelRunProjection,
    turnSnapshot: PersistedTurnSnapshot,
  ): Promise<DeliveryVerifier | undefined> {
    if (turnSnapshot.payload.verifiers.length === 0) return undefined;
    if (turnSnapshot.payload.verifiers.length !== 1) {
      throw new ExactTurnDependencyError('VERIFIER_SNAPSHOT_INVALID');
    }
    const required = turnSnapshot.payload.verifiers[0]!;
    const turnRuntime = this.#turnRuntimeLeases.get(
      toolCatalogCacheKey(run, turnSnapshot.turnId),
    );
    if (
      turnRuntime?.verifier?.verifierId === required.id &&
      turnRuntime.verifier.revision === required.revision &&
      (turnRuntime.verifier.mode === 'required') === required.required
    ) {
      return turnRuntime.verifier;
    }
    if (
      this.#options.verifier?.verifierId === required.id &&
      this.#options.verifier.revision === required.revision &&
      (this.#options.verifier.mode === 'required') === required.required
    ) {
      return this.#options.verifier;
    }
    const key = turnDependencyKey('verifier', run, turnSnapshot.turnId);
    const cached = this.#verifierLeases.get(key);
    if (cached !== undefined) return cached.verifier;
    if (this.#options.resolveVerifier === undefined) {
      throw new ExactTurnDependencyError('VERIFIER_REVISION_UNAVAILABLE');
    }
    const raw = await this.#options.resolveVerifier({
      projectId: run.projectId,
      sessionId: run.sessionId,
      runId: run.runId,
      turnId: turnSnapshot.turnId,
      turnSnapshotId: turnSnapshot.turnSnapshotId,
      verifier: structuredClone(required),
    });
    if (
      raw.verifier.verifierId !== required.id || raw.verifier.revision !== required.revision ||
      (raw.verifier.mode === 'required') !== required.required
    ) {
      raw.release();
      throw new ExactTurnDependencyError('VERIFIER_REVISION_MISMATCH');
    }
    const lease = onceVerifierLease(raw);
    this.#verifierLeases.set(key, lease);
    return lease.verifier;
  }

  async #turnLifecycle(
    run: KernelRunProjection,
    expectedStatus: 'started' | 'committed',
  ): Promise<Readonly<{ revision: number; status: 'started' | 'committed' | 'closed' }>> {
    if (run.currentTurnId === null) throw new TypeError('Run has no active Turn lifecycle.');
    const lifecycle = await this.#options.journal.getTurnLifecycle({
      projectId: run.projectId,
      sessionId: run.sessionId,
      runId: run.runId,
      turnId: run.currentTurnId,
    });
    if (lifecycle === null || lifecycle.status !== expectedStatus) {
      throw new TypeError(
        `Turn lifecycle must be ${expectedStatus} before this transition.`,
      );
    }
    return lifecycle;
  }

  async #dependencyFailure(
    run: KernelRunProjection,
    controller: RunController,
    error: unknown,
  ): Promise<KernelEffect | null> {
    if (error instanceof RunLeaseLostError) throw error;
    if (
      error instanceof JournalAgentModelResolutionError &&
      error.code === 'MODEL_CONNECTION_REQUIRED'
    ) {
      const requested = await controller.requestInput({
        commandId: `model_connection_${this.#createId()}`,
        expectedRunRevision: run.revision,
        reason: 'model_connection_required',
        ...(error.detail?.connectionId === undefined
          ? {}
          : { connectionId: error.detail.connectionId }),
      });
      return effect(requested.run, {
        type: 'input-required',
        reason: 'model_connection_required',
      });
    }
    if (
      error instanceof JournalAgentModelResolutionError ||
      error instanceof SessionModelBindingError
    ) {
      const interrupted = await controller.interrupt({
        commandId: `model_unavailable_${this.#createId()}`,
        expectedRunRevision: run.revision,
        code: 'MODEL_BINDING_UNAVAILABLE',
        detail: { reason: error.message },
      });
      return effect(interrupted.run, { type: 'interrupted' });
    }
    if (error instanceof ToolCatalogResolutionError) {
      const interrupted = await controller.interrupt({
        commandId: `tool_catalog_unavailable_${this.#createId()}`,
        expectedRunRevision: run.revision,
        code: 'TOOL_CATALOG_REVISION_UNAVAILABLE',
        detail: { reason: error.message },
      });
      return effect(interrupted.run, { type: 'interrupted' });
    }
    if (error instanceof ExactTurnDependencyError && run.state === 'created') {
      const interrupted = await controller.interrupt({
        commandId: `turn_dependency_invalid_${this.#createId()}`,
        expectedRunRevision: run.revision,
        code: 'CAPABILITY_REVISION_UNAVAILABLE',
        detail: { reason: error.code },
      });
      return effect(interrupted.run, { type: 'interrupted' });
    }
    if (error instanceof ExactTurnDependencyError) {
      const requested = await controller.requestInput({
        commandId: `turn_dependency_${this.#createId()}`,
        expectedRunRevision: run.revision,
        reason: 'capability_revision_required',
      });
      return effect(requested.run, {
        type: 'input-required',
        reason: 'capability_revision_required',
      });
    }
    return null;
  }

  async #controller(run: KernelRunProjection): Promise<RunController> {
    const existing = this.#controllers.get(run.runId);
    if (existing !== undefined) {
      existing.assertLeaseActive();
      this.#controllers.delete(run.runId);
      this.#controllers.set(run.runId, existing);
      return existing;
    }
    if (this.#controllers.size >= this.#maxCachedRuns) {
      throw new TypeError('The bounded active Agent Run controller cache is full.');
    }
    const controller = new RunController({
      journal: this.#options.journal,
      projectId: run.projectId,
      sessionId: run.sessionId,
      runId: run.runId,
      ownerId: this.#ownerId,
      leaseTtlMs: this.#leaseTtlMs,
    });
    await controller.acquire();
    this.#controllers.set(run.runId, controller);
    return controller;
  }

  async releaseRun(
    run: KernelRunProjection,
    options: Readonly<{ waitForWork?: boolean }> = {},
  ): Promise<void> {
    const controller = this.#controllers.get(run.runId);
    this.#controllers.delete(run.runId);
    if (controller !== undefined) await controller.release(options);
    const prefix = toolCatalogRunPrefix(run);
    let retainedTurnKey: string | undefined;
    if (run.currentTurnId !== null) {
      const lifecycle = await this.#options.journal.getTurnLifecycle({
        projectId: run.projectId,
        sessionId: run.sessionId,
        runId: run.runId,
        turnId: run.currentTurnId,
      });
      if (lifecycle !== null && lifecycle.status !== 'closed') {
        retainedTurnKey = toolCatalogCacheKey(run, run.currentTurnId);
      }
    }
    for (const [key, lease] of this.#toolCatalogLeases) {
      if (!key.startsWith(prefix)) continue;
      if (key === retainedTurnKey) continue;
      this.#toolCatalogLeases.delete(key);
      lease.release();
    }
    for (const [key, lease] of this.#turnRuntimeLeases) {
      if (!key.startsWith(prefix)) continue;
      if (key === retainedTurnKey) continue;
      this.#turnRuntimeLeases.delete(key);
      lease.release();
    }
    for (const leases of [
      this.#promptSnapshotLeases,
      this.#permissionPolicyLeases,
      this.#verifierLeases,
    ] as const) {
      for (const [key, lease] of leases) {
        if (!key.startsWith(prefix)) continue;
        if (retainedTurnKey !== undefined && key.startsWith(`${retainedTurnKey}\0`)) continue;
        leases.delete(key);
        lease.release();
      }
    }
    const sessionPrefix = ['run', run.runId, ''].join('\0');
    for (const key of this.#liveSessions.keys()) {
      if (key.startsWith(sessionPrefix)) this.#liveSessions.delete(key);
    }
  }

  #releaseTurnDependencies(run: KernelRunProjection, turnId: string): void {
    const toolKey = toolCatalogCacheKey(run, turnId);
    const toolLease = this.#toolCatalogLeases.get(toolKey);
    if (toolLease !== undefined) {
      this.#toolCatalogLeases.delete(toolKey);
      toolLease.release();
    }
    for (const [kind, leases] of [
      ['prompt', this.#promptSnapshotLeases],
      ['permission', this.#permissionPolicyLeases],
      ['verifier', this.#verifierLeases],
    ] as const) {
      const key = turnDependencyKey(kind, run, turnId);
      const lease = leases.get(key);
      if (lease === undefined) continue;
      leases.delete(key);
      lease.release();
    }
    const runtime = this.#turnRuntimeLeases.get(toolKey);
    if (runtime !== undefined) {
      this.#turnRuntimeLeases.delete(toolKey);
      runtime.release();
    }
  }

  async #scope(runId: string): Promise<{ projectId: string; sessionId: string }> {
    const run = await this.#options.journal.getRunProjection(runId);
    if (run === null) throw new TypeError(`Run not found: ${runId}`);
    return { projectId: run.projectId, sessionId: run.sessionId };
  }

  async #readScoped(
    projectId: string,
    sessionId: string,
    runId: string,
  ): Promise<KernelRunProjection> {
    const run = await this.#options.journal.getKernelRunProjection({ projectId, sessionId, runId });
    if (run === null) throw new TypeError(`Kernel Run not found: ${runId}`);
    return run;
  }

  async #runEvents(
    projectId: string,
    sessionId: string,
    runId: string,
    afterSequence: number,
  ): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    let cursor = afterSequence;
    while (true) {
      const page = await this.#options.journal.readRunEvents({
        projectId,
        sessionId,
        runId,
        afterSequence: cursor,
        limit: EVENT_PAGE_SIZE,
      });
      if (page.events.length === 0) break;
      events.push(...page.events);
      if (page.nextSequence === null || page.events.length < EVENT_PAGE_SIZE) {
        break;
      }
      cursor = page.nextSequence;
    }
    return events;
  }
}

function canonicalTools(
  snapshot: ToolCatalogSnapshot,
  captured: readonly Readonly<{ name: string; revision: string }>[],
): CanonicalModelTool[] {
  const available = new Map<string, ReturnType<ToolCatalogSnapshot['llmTools']>[number]>();
  for (const tool of snapshot.llmTools()) available.set(tool.name, tool);
  return captured.map((identity) => {
    const tool = available.get(identity.name);
    if (
      tool === undefined || requiredToolRevision(snapshot, identity.name) !== identity.revision
    ) {
      throw new TypeError(`Exact captured Tool is unavailable: ${identity.name}@${identity.revision}.`);
    }
    const inputSchema = structuredClone(tool.inputSchema);
    assertPortableValue(inputSchema);
    return {
      name: tool.name,
      ...(tool.description === '' ? {} : { description: tool.description }),
      inputSchema,
    };
  });
}

class ToolCatalogResolutionError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ToolCatalogResolutionError';
  }
}

class ExactTurnDependencyError extends Error {
  constructor(readonly code: string, override readonly cause?: unknown) {
    super(`The exact captured Turn dependency is unavailable: ${code}.`,
      cause === undefined ? undefined : { cause });
    this.name = 'ExactTurnDependencyError';
  }
}

function catalogMatches(
  snapshot: ToolCatalogSnapshot,
  required: readonly Readonly<{ name: string; revision: string }>[],
): boolean {
  return required.every((identity) => {
    const revision = snapshot.invocationRevision(identity.name);
    return snapshot.get(identity.name) !== undefined && revision === identity.revision;
  });
}

function uniqueToolIdentities(
  identities: readonly Readonly<{ name: string; revision: string }>[],
): ReadonlyArray<Readonly<{ name: string; revision: string }>> {
  const byName = new Map<string, string>();
  for (const identity of identities) {
    const previous = byName.get(identity.name);
    if (previous !== undefined && previous !== identity.revision) {
      throw new ToolCatalogResolutionError(
        `Captured Tool ${identity.name} has conflicting revisions.`,
      );
    }
    byName.set(identity.name, identity.revision);
  }
  return [...byName].map(([name, revision]) => ({ name, revision }));
}

function onceToolCatalogLease(
  lease: JournalAgentToolCatalogLease,
): JournalAgentToolCatalogLease {
  let released = false;
  return Object.freeze({
    snapshot: lease.snapshot,
    release: () => {
      if (released) return;
      released = true;
      lease.release();
    },
  });
}

function onceTurnRuntimeLease(
  lease: JournalAgentTurnRuntimeLease,
): JournalAgentTurnRuntimeLease {
  if (
    lease === null || typeof lease !== 'object' ||
    !(lease.toolCatalog instanceof ToolCatalogSnapshot) ||
    typeof lease.release !== 'function'
  ) {
    throw new TypeError('Turn Runtime capture returned an invalid lease.');
  }
  const capability = {
    snapshotId: requireText(lease.capability?.snapshotId, 'capability.snapshotId'),
    revision: requireText(lease.capability?.revision, 'capability.revision'),
  };
  const promptRevision = requireText(lease.promptRevision, 'promptRevision');
  const rawPromptSections: unknown = lease.promptSections;
  const rawSkills: unknown = lease.skills;
  if (!Array.isArray(rawPromptSections) || !Array.isArray(rawSkills)) {
    throw new TypeError('Turn Runtime promptSections and skills must be arrays.');
  }
  const runtimeProtocol = snapshotPromptSection(lease.runtimeProtocol);
  const promptSections = (rawPromptSections as readonly unknown[])
    .map((section) => snapshotPromptSection(section as PromptSection));
  const skills = (rawSkills as readonly unknown[]).map(snapshotTurnRuntimeSkill);
  const discoverableCapabilities = snapshotDiscoverableCapabilities(
    lease.discoverableCapabilities,
  );
  const invocationHooks = snapshotTurnRuntimeHooks(lease.invocationHooks);
  if (new Set(invocationHooks.map(({ id }) => id)).size !== invocationHooks.length) {
    throw new TypeError('Turn Runtime contains duplicate Invocation Hook identities.');
  }
  if (new Set(skills.map(({ id }) => id)).size !== skills.length) {
    throw new TypeError('Turn Runtime contains duplicate Skill identities.');
  }
  let released = false;
  return Object.freeze({
    capability: Object.freeze(capability),
    toolCatalog: lease.toolCatalog,
    promptRevision,
    runtimeProtocol,
    promptSections: Object.freeze(promptSections),
    discoverableCapabilities,
    skills: Object.freeze(skills.map((skill) => Object.freeze(skill))),
    invocationHooks: Object.freeze(invocationHooks),
    ...(lease.verifier === undefined ? {} : { verifier: lease.verifier }),
    release: () => {
      if (released) return;
      released = true;
      lease.release();
    },
  });
}

function snapshotDiscoverableCapabilities(
  value: JournalAgentTurnRuntimeLease['discoverableCapabilities'],
): readonly AgentCapabilityDiscoveryManifestEntry[] {
  return snapshotCapabilityDiscoveryManifest(value ?? []);
}

function snapshotTurnRuntimeSkill(
  value: unknown,
): JournalAgentTurnRuntimeLease['skills'][number] {
  if (!isPlainRuntimeRecord(value)) {
    throw new TypeError('Turn Runtime Skill entries must be plain objects.');
  }
  const id = requireText(value.id, 'skill.id');
  const revision = requireText(value.revision, 'skill.revision');
  const allowedTools = value.allowedTools;
  if (allowedTools !== undefined && !Array.isArray(allowedTools)) {
    throw new TypeError('skill.allowedTools must be an array.');
  }
  return Object.freeze({
    id,
    revision,
    ...(allowedTools === undefined
      ? {}
      : { allowedTools: Object.freeze((allowedTools as readonly unknown[])
          .map((name) => requireText(name, 'skill.allowedTools'))) }),
  });
}

function snapshotTurnRuntimeHooks(
  value: JournalAgentTurnRuntimeLease['invocationHooks'],
): readonly AgentInvocationHookContribution[] {
  const rawHooks: unknown = value ?? [];
  if (!Array.isArray(rawHooks)) throw new TypeError('Turn Runtime invocationHooks must be an array.');
  const ids = new Set<string>();
  return Object.freeze((rawHooks as readonly unknown[]).map((candidate) => {
    if (!isPlainRuntimeRecord(candidate)) {
      throw new TypeError('Turn Runtime Invocation Hook entries must be plain objects.');
    }
    const id = requireText(candidate.id, 'hook.id');
    const revision = requireText(candidate.revision, 'hook.revision');
    const before = candidate.before;
    const after = candidate.after;
    if (
      before !== undefined && typeof before !== 'function' ||
      after !== undefined && typeof after !== 'function' ||
      before === undefined && after === undefined
    ) {
      throw new TypeError(`Invocation Hook ${id} must provide callable before or after phases.`);
    }
    if (ids.has(id)) throw new TypeError(`Invocation Hook ${id} is duplicated.`);
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

function isPlainRuntimeRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function oncePromptSnapshotLease(
  lease: JournalAgentPromptSnapshotLease,
): JournalAgentPromptSnapshotLease {
  let released = false;
  return Object.freeze({
    revision: lease.revision,
    runtimeProtocol: structuredClone(lease.runtimeProtocol),
    sections: Object.freeze(lease.sections.map((section) => structuredClone(section))),
    release: () => {
      if (released) return;
      released = true;
      lease.release();
    },
  });
}

function oncePermissionPolicyLease(
  lease: JournalAgentPermissionPolicyLease,
): JournalAgentPermissionPolicyLease {
  let released = false;
  return Object.freeze({
    revision: lease.revision,
    permissionManager: lease.permissionManager,
    mode: lease.mode,
    release: () => {
      if (released) return;
      released = true;
      lease.release();
    },
  });
}

function onceVerifierLease(lease: JournalAgentVerifierLease): JournalAgentVerifierLease {
  let released = false;
  return Object.freeze({
    verifier: lease.verifier,
    release: () => {
      if (released) return;
      released = true;
      lease.release();
    },
  });
}

function persistedDeliveryDecisions(events: readonly AgentEvent[]): PersistedDeliveryDecision[] {
  const decisions: PersistedDeliveryDecision[] = [];
  for (const event of events) {
    if (
      event.type !== 'delivery.decided' ||
      event.payload.verifierId === undefined ||
      event.payload.verifierRevision === undefined
    ) {
      continue;
    }
    decisions.push({
      verifierId: event.payload.verifierId,
      verifierRevision: event.payload.verifierRevision,
      evidenceRevision: event.payload.evidenceRevision,
      decision: event.payload.outcome === 'accepted'
        ? 'accepted'
        : event.payload.outcome === 'revision-requested'
          ? 'revise'
          : 'indeterminate',
    });
  }
  return decisions;
}

function toolCatalogCacheKey(run: KernelRunProjection, turnId: string): string {
  return ['tool', run.projectId, run.sessionId, run.runId, turnId].join('\0');
}

function turnDependencyKey(
  kind: 'prompt' | 'permission' | 'verifier',
  run: KernelRunProjection,
  turnId: string,
): string {
  return ['tool', run.projectId, run.sessionId, run.runId, turnId, kind].join('\0');
}

function capabilityIdentityEquals(
  current: Readonly<{ snapshotId: string; revision: string }>,
  captured: Readonly<{ snapshotId: string; revision: string }>,
): boolean {
  return current.snapshotId === captured.snapshotId && current.revision === captured.revision;
}

function skillIdentitiesEqual(
  current: readonly Readonly<{ id: string; revision: string }>[],
  captured: readonly Readonly<{ id: string; revision: string }>[],
): boolean {
  return current.length === captured.length && current.every((skill, index) => {
    const expected = captured[index];
    return expected !== undefined && skill.id === expected.id && skill.revision === expected.revision;
  });
}

function hooksMatch(
  current: readonly Readonly<{ id: string; revision: string }>[],
  captured: readonly Readonly<{ id: string; revision: string }>[],
): boolean {
  return current.length === captured.length && current.every((hook, index) => {
    const expected = captured[index];
    return expected !== undefined && hook.id === expected.id && hook.revision === expected.revision;
  });
}

function toolCatalogRunPrefix(run: KernelRunProjection): string {
  return ['tool', run.projectId, run.sessionId, run.runId, ''].join('\0');
}

function positiveBound(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return value;
}

function isAgentWaitReason(value: string | null): value is AgentWaitReason {
  return value === 'approval' || value === 'input_required' ||
    value === 'outcome_resolution' || value === 'model_connection_required' ||
    value === 'capability_revision_required';
}

function unresolvedOutcomeRequests(
  invocations: readonly AgentInvocationProjection[],
): Array<Readonly<{ invocationId: string; summary: string }>> {
  return invocations.flatMap((invocation) =>
    invocation.terminal?.kind === 'unknown' && invocation.outcomeResolution === undefined
      ? [{ invocationId: invocation.invocationId, summary: invocation.terminal.summary }]
      : []);
}

function requiredToolRevision(snapshot: ToolCatalogSnapshot, name: string): string {
  const revision = snapshot.invocationRevision(name);
  if (revision === undefined || revision.trim() === '') {
    throw new TypeError(`Tool revision is unavailable: ${name}.`);
  }
  return revision;
}

function primarySession(session: ModelSession | ModelSessionBundle): ModelSession {
  return 'primary' in session ? session.primary : session;
}

function toolResultProjectionBudget(
  session: ModelSession | ModelSessionBundle,
): ToolResultProjectionBudget {
  const sessions = 'primary' in session ? [session.primary, ...session.fallbacks] : [session];
  const advertisedInputs = sessions.map((candidate) =>
    candidate.route.maxInputTokens ?? candidate.route.contextTokens).filter(
      (value): value is number => value !== null && Number.isSafeInteger(value) && value > 0,
    );
  const maxTokens = advertisedInputs.length === sessions.length
    ? Math.max(1_024, Math.min(16_384, Math.floor(Math.min(...advertisedInputs) / 64)))
    : 1_024;
  return Object.freeze({
    maxTokens,
    // All currently supported providers use byte-addressable tokenizers. UTF-8
    // bytes are a conservative upper bound when no exact provider tokenizer is exposed.
    estimateTokens: (text: string) => Buffer.byteLength(text, 'utf8'),
  });
}

function modelSessionWithReplay(
  session: ModelSession | ModelSessionBundle,
  envelopes: readonly ModelProtocolEnvelope[],
): ModelSession | ModelSessionBundle {
  if (envelopes.length === 0) return session;
  const bind = (candidate: ModelSession) => {
    const { stop, ...generation } = candidate.generation;
    return createModelSession({
      route: candidate.route,
      generation: {
        ...generation,
        ...(stop === undefined ? {} : { stop: [...stop] }),
      },
      codec: candidate.codec,
      client: candidate.client,
      replay: {
        mode: exactReplayOrigin(candidate, envelopes)
          ? 'same-connection'
          : 'compatible-protocol',
        envelopes,
      },
    });
  };
  if (!('primary' in session)) return bind(session);
  return createModelSessionBundle({
    primary: bind(session.primary),
    fallbacks: session.fallbacks.map((fallback) => bind(fallback)),
    policy: session.policy,
  });
}

function exactReplayOrigin(
  session: ModelSession,
  envelopes: readonly ModelProtocolEnvelope[],
): boolean {
  return envelopes.every((envelope) =>
    envelope.origin.connectionId === session.route.connectionId &&
    envelope.origin.model === session.route.modelId &&
    envelope.origin.protocol === session.route.protocol,
  );
}

function leaseReference(controller: RunController): { ownerId: string; fencingToken: number } {
  const lease = controller.currentLease();
  return { ownerId: lease.ownerId, fencingToken: lease.fencingToken };
}

function effect(run: KernelRunProjection, signal: AgentStateSignal): KernelEffect {
  return Object.freeze({ run, signal });
}

function isConcurrentKernelTransition(error: unknown): boolean {
  return error instanceof AgentJournalError && (
    error.code === 'REVISION_CONFLICT' || error.code === 'COMMAND_CONFLICT' ||
    error.code === 'MODEL_COMMIT_CONFLICT'
  );
}

function isInvocationConcurrency(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error &&
    (error.code === 'INVOCATION_CONFLICT' || error.code === 'LEASE_LOST');
}

function cloneMessage(message: ModelMessage): ModelMessage {
  return structuredClone(message);
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

function sessionCacheKey(binding: SessionModelBinding): string {
  return [
    'session', binding.projectId, binding.sessionId, String(binding.revision),
    binding.model.bindingDigest,
  ].join('\0');
}

function runSessionCacheKey(
  runId: string,
  environmentBindingId: string,
  bindingDigest: string,
): string {
  return ['run', runId, environmentBindingId, bindingDigest].join('\0');
}

function assertSameRunModelRoute(
  sessionBinding: PersistedModelRuntimeBinding,
  runBinding: PersistedModelRuntimeBinding,
): void {
  const base = sessionBinding.descriptor;
  const run = runBinding.descriptor;
  const baseRoutes = [base.primary, ...base.fallbacks];
  const runRoutes = [run.primary, ...run.fallbacks];
  if (
    baseRoutes.length !== runRoutes.length ||
    baseRoutes.some((descriptor, index) => {
      const candidate = runRoutes[index];
      return candidate === undefined ||
        descriptor.route.routeId !== candidate.route.routeId ||
        descriptor.route.metadata.digest !== candidate.route.metadata.digest ||
        JSON.stringify(descriptor.clientBinding) !== JSON.stringify(candidate.clientBinding) ||
        JSON.stringify(descriptor.replay) !== JSON.stringify(candidate.replay);
    }) ||
    JSON.stringify(base.policy) !== JSON.stringify(run.policy)
  ) {
    throw new SessionModelBindingError(
      'MODEL_BINDING_INVALID',
      'A Run request may override generation parameters but cannot change its Session model route.',
    );
  }
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} is required.`);
  return value;
}

/** The Kernel selects the current Turn query from durable facts. */
function durableTurnQuery(events: readonly AgentEvent[]): string {
  for (const event of [...events].reverse()) {
    if (event.type !== 'input.received' && event.type !== 'run.steered') continue;
    const content = event.payload.content;
    if (typeof content === 'string' && content.trim() !== '') return content;
    const childTask = content !== null && typeof content === 'object' && !Array.isArray(content)
      ? (content as Record<string, PortableValue>).task
      : undefined;
    // child.start persists its bounded task and optional context as the child
    // Run's durable ingress. The task is the exact user-facing query for the
    // child's first Turn; context is deliberately not blended into it.
    if (
      content !== null &&
      typeof content === 'object' &&
      !Array.isArray(content) &&
      typeof childTask === 'string' &&
      childTask.trim() !== ''
    ) {
      return childTask;
    }
    throw new TypeError('Current Turn input must be a non-empty text value.');
  }
  throw new TypeError('Current Turn has no durable user input.');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalPortableJson(value: PortableValue): string {
  const visit = (candidate: PortableValue): PortableValue => {
    if (Array.isArray(candidate)) return candidate.map(visit);
    if (candidate !== null && typeof candidate === 'object') {
      return Object.fromEntries(Object.entries(candidate)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, visit(entry)]));
    }
    return candidate;
  };
  return JSON.stringify(visit(value));
}

function requireResumedState(
  state: KernelRunProjection['state'],
): Extract<AgentStateSignal, { type: 'run-resumed' }>['resumeState'] {
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
      throw new TypeError(`Journal resumed Run to invalid state ${state}.`);
  }
}

function modelFailureDiagnostic(error: unknown): PortableValue {
  if (typeof error !== 'object' || error === null) {
    return { category: 'model-gateway', code: 'UNKNOWN', retryable: false };
  }
  const record = error as Readonly<Record<string, unknown>>;
  const rawCode = record.code;
  const rawStatus = record.statusCode ?? record.status;
  const statusCode = Number.isSafeInteger(rawStatus) && Number(rawStatus) >= 100 &&
    Number(rawStatus) <= 599 ? Number(rawStatus) : undefined;
  return {
    category: 'model-gateway',
    code: typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(rawCode)
      ? rawCode
      : 'UNKNOWN',
    ...(typeof record.retryable === 'boolean' ? { retryable: record.retryable } : {}),
    ...(statusCode === undefined ? {} : { statusCode }),
  };
}

function isTerminalModelFailure(error: unknown): error is ModelGatewayError {
  return error instanceof ModelGatewayError && !error.retryable &&
    error.code !== 'MODEL_CANCELLED' && error.code !== 'MODEL_OBSERVER_FAILED';
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}
