import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ValidateFunction } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { PortableValue } from '@dbagent/shared';
import type { ProjectArtifactStore } from '../artifacts/project-artifact-store.js';
import type {
  ToolApprovalFact,
  ToolEffectFact,
  ToolExecutionErrorFact,
  ToolObservationFact,
} from '../events/agent-event.js';
import {
  AgentJournalError,
  type AgentJournal,
  type RunLease,
} from '../events/agent-journal.js';
import type { AgentInvocationProjection } from '../events/event-projectors.js';
import type { PermissionManager } from '../permission-manager.js';
import type {
  ToolCatalogSnapshot,
  ToolInvocationExecutionContext,
  ToolInvocationHandlerRuntime,
} from '../tool-registry.js';
import { normalizeAgentToolResult } from '../tool-result.js';
import type { AgentMode, AgentToolDescriptor } from '../types.js';
import {
  adaptToolHandlerFailure,
  ToolInvocationError,
  invalidToolResultError,
} from './tool-errors.js';
import {
  decideSchedule,
  type ToolScheduleDecision,
  type ToolInvocationScheduleState,
  type ScheduledToolEffect,
} from './tool-scheduler.js';

const MAX_COMPILED_SCHEMAS = 128;
const DEFAULT_MAX_CONCURRENCY = 4;
const COMPETING_EXECUTION_WAIT_MS = 5_000;
const COMPETING_EXECUTION_POLL_MS = 5;
const DEFAULT_ACTIVE_LEASE_POLL_MS = 250;
const INVOCATION_PAGE_SIZE = 256;

const schemaCompiler = new Ajv2020({
  allErrors: true,
  strictSchema: true,
  strictTypes: false,
  allowUnionTypes: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
});
const compiledSchemas = new Map<string, ValidateFunction>();

export type ToolInvocationRuntimeBinding = Readonly<{
  projectId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  lease: RunLease;
  mode: AgentMode;
}>;

export type ToolInvocationRuntimeOptions = Readonly<{
  journal: AgentJournal;
  registry: ToolCatalogSnapshot;
  permissionManager: PermissionManager;
  artifactStore?: ProjectArtifactStore | undefined;
  binding: ToolInvocationRuntimeBinding;
  maxConcurrency?: number;
  /** Fallback cadence when the Journal has no push lease-loss notification. */
  leasePollIntervalMs?: number;
  /** Authoritative clock paired with the Journal clock; injectable for deterministic recovery. */
  now?: () => number;
  onCrashPoint?: (point: ToolInvocationCrashPoint) => void | Promise<void>;
}>;

export type ToolInvocationCrashPoint =
  | 'after-started-before-handler'
  | 'after-external-effect-before-terminal'
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
  effect: ToolEffectFact;
  normalizedArgumentsDigest: string;
  proposedRevision: number;
  decision: 'approve' | 'deny';
  decidedBy?: string;
  reason?: string;
}>;

export type RiskyRetryAuthorization = Readonly<{
  commandId: string;
  invocationId: string;
  toolRevision: string;
  effect: 'non_idempotent';
  normalizedArgumentsDigest: string;
  reason: string;
}>;

export type UnknownOutcomeResolution = Readonly<{
  commandId: string;
  invocationId: string;
  canonicalToolId: { namespace?: string; name: string };
  toolRevision: string;
  effect: ToolEffectFact;
  normalizedArgumentsDigest: string;
  proposedRevision: number;
  outcome: 'succeeded' | 'failed';
  summary: string;
}>;

/**
 * The sole Tool Handler execution boundary.
 *
 * The Runtime owns no authoritative lifecycle state. Its only in-memory state
 * coalesces duplicate calls inside this process; every decision and recovery
 * fact is reconstructed from the Journal.
 */
export class ToolInvocationRuntime {
  readonly #journal: AgentJournal;
  readonly #registry: ToolCatalogSnapshot;
  readonly #permissionManager: PermissionManager;
  readonly #artifactStore: ProjectArtifactStore | undefined;
  readonly #binding: ToolInvocationRuntimeBinding;
  readonly #maxConcurrency: number;
  readonly #runtimeId = randomUUID();
  readonly #leasePollIntervalMs: number;
  readonly #now: () => number;
  readonly #terminalInflight = new Map<string, Promise<AgentInvocationProjection>>();
  readonly #onCrashPoint: ToolInvocationRuntimeOptions['onCrashPoint'];

  constructor(options: ToolInvocationRuntimeOptions) {
    this.#journal = options.journal;
    this.#registry = options.registry;
    this.#permissionManager = options.permissionManager;
    this.#artifactStore = options.artifactStore;
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
  }

  async resolve(): Promise<ToolScheduleDecision> {
    let decision = await this.#currentDecision();
    if (decision.state === 'ResolvingActions') {
      for (const invocationId of decision.invocationIds) {
        await this.#validateInvocation(invocationId);
      }
      decision = await this.#currentDecision();
    }
    return decision;
  }

  async execute(
    invocationId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ToolObservationFact> {
    const current = await this.#requireBoundInvocation(invocationId);
    if (current.observation !== undefined) return publicObservation(current.observation);
    const decision = await this.resolve();
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
      await this.#terminalForQualifiedInvocation(invocationId, options.signal);
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
      const decision = await this.resolve();
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
      await this.#journal.commitToolInvocation({
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
        effect: decision.effect,
        normalizedArgumentsDigest: decision.normalizedArgumentsDigest,
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
    effect: ToolEffectFact;
    normalizedArgumentsDigest: string;
    reason: string;
  }> {
    const invocation = await this.#requireBoundInvocation(input.invocationId, false);
    const permitId = `retry_${sha256(`${input.invocationId}\0${input.commandId}`)}`;
    try {
      const result = await this.#journal.commitToolInvocation({
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
        effect: input.effect,
        normalizedArgumentsDigest: input.normalizedArgumentsDigest,
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
      invocation.toolRevision !== input.toolRevision || invocation.effect !== input.effect ||
      invocation.normalizedArgumentsDigest !== input.normalizedArgumentsDigest ||
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
      effect: input.effect,
      normalizedArgumentsDigest: input.normalizedArgumentsDigest,
      proposedRevision: input.proposedRevision,
      outcome: input.outcome,
      summary: input.summary,
    };
    const resolutionId = `resolution_${sha256(canonicalJson(resolutionIdentity))}`;
    try {
      const result = await this.#journal.commitToolInvocation({
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
        effect: input.effect,
        normalizedArgumentsDigest: input.normalizedArgumentsDigest,
        proposedRevision: input.proposedRevision,
        summary: input.summary,
      });
      if (result.invocation.observation === undefined) {
        throw new ToolInvocationError('INVOCATION_CONFLICT', 'Resolved Observation is missing.');
      }
      return publicObservation(result.invocation.observation);
    } catch (errorValue) {
      throw mapJournalError(errorValue);
    }
  }

  async recover(invocationId: string): Promise<ToolObservationFact> {
    const invocation = await this.#requireBoundInvocation(invocationId);
    if (invocation.observation !== undefined) return publicObservation(invocation.observation);
    if (invocation.terminal !== undefined) return await this.#convergeRecoveredObservation(invocation);
    if (invocation.state === 'authorized') return await this.execute(invocationId);
    if (invocation.state !== 'started' || invocation.started === undefined) {
      throw new ToolInvocationError('INVOCATION_CONFLICT', 'Invocation cannot be recovered.');
    }
    if (invocation.effect === 'read' || invocation.effect === 'idempotent') {
      return await this.#convergeRecoveredObservation(await this.#resumeStarted(invocation));
    }
    if (invocation.effect === 'transactional') {
      const runtime = this.#registry.getInvocationRuntime(invocation.name);
      if (runtime?.recover !== undefined) {
        return await this.#convergeRecoveredObservation(
          await this.#resumeStarted(invocation, true),
        );
      }
    }
    return await this.#convergeRecoveredObservation(await this.#finishUnknown(invocation));
  }

  async #terminalForQualifiedInvocation(
    invocationId: string,
    callerSignal: AbortSignal | undefined,
  ): Promise<AgentInvocationProjection> {
    const existing = this.#terminalInflight.get(invocationId);
    if (existing !== undefined) return await existing;
    const execution = this.#executeToTerminal(invocationId, callerSignal);
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
  ): Promise<AgentInvocationProjection> {
    let invocation = await this.#requireBoundInvocation(invocationId);
    if (invocation.observation !== undefined || invocation.terminal !== undefined) return invocation;
    if (invocation.state === 'started') {
      return await this.#waitForCompetingTerminal(invocationId, callerSignal);
    }
    if (invocation.state !== 'authorized') {
      throw new ToolInvocationError('INVOCATION_CONFLICT', 'Invocation is not authorized.');
    }
    let descriptor: AgentToolDescriptor;
    let runtime: ToolInvocationHandlerRuntime;
    try {
      descriptor = this.#requireDescriptor(invocation);
      runtime = this.#requireHandlerRuntime(invocation, descriptor);
    } catch (error) {
      if (error instanceof ToolInvocationError && isPreStartResolutionError(error)) {
        return await this.#rejectBeforeStart(invocation, error);
      }
      throw error;
    }
    const attempt = (invocation.started?.attempt ?? 0) + 1;
    const idempotencyKey = stableIdempotencyKey(invocation);
    try {
      const started = await this.#journal.commitToolInvocation({
        action: 'start',
        projectId: invocation.projectId,
        sessionId: invocation.sessionId,
        runId: invocation.runId,
        turnId: invocation.turnId,
        invocationId: invocation.invocationId,
        commandId: `tool-start:${invocation.invocationId}:${this.#runtimeId}`,
        lease: leaseReference(this.#binding.lease),
        expectedRunRevision: await this.#runRevision(),
        expectedInvocationRevision: invocation.revision,
        idempotencyKey,
        attempt,
      });
      invocation = started.invocation;
    } catch (error) {
      const mapped = mapJournalError(error);
      if (mapped.code === 'INVOCATION_CONFLICT') {
        return await this.#waitForCompetingTerminal(invocationId, callerSignal);
      }
      throw mapped;
    }
    await this.#crashPoint('after-started-before-handler');
    return await this.#invokeStarted(invocation, runtime, descriptor, callerSignal, false);
  }

  async #resumeStarted(
    invocation: AgentInvocationProjection,
    recoverHandler = false,
  ): Promise<AgentInvocationProjection> {
    const descriptor = this.#requireDescriptor(invocation);
    const runtime = this.#requireHandlerRuntime(invocation, descriptor);
    return await this.#invokeStarted(invocation, runtime, descriptor, undefined, recoverHandler);
  }

  async #invokeStarted(
    invocation: AgentInvocationProjection,
    runtime: ToolInvocationHandlerRuntime,
    descriptor: AgentToolDescriptor,
    callerSignal: AbortSignal | undefined,
    useRecoveryHandler: boolean,
  ): Promise<AgentInvocationProjection> {
    if (invocation.started === undefined) {
      throw new ToolInvocationError('INVOCATION_CONFLICT', 'Invocation start fact is missing.');
    }
    const linked = linkedAbortController(callerSignal, descriptor.execution.timeoutMs);
    const stopLeaseWatch = watchLease(
      this.#journal,
      this.#binding,
      this.#leasePollIntervalMs,
      () => linked.loseLease(),
      this.#now,
    );
    const context = Object.freeze<ToolInvocationExecutionContext>({
      projectId: invocation.projectId,
      sessionId: invocation.sessionId,
      runId: invocation.runId,
      turnId: invocation.turnId,
      invocationId: invocation.invocationId,
      idempotencyKey: invocation.started.idempotencyKey,
      fencingToken: this.#binding.lease.fencingToken,
      signal: linked.controller.signal,
    });
    const argumentsRecord = frozenArguments(invocation.arguments);
    const handler = useRecoveryHandler ? runtime.recover : runtime.execute;
    if (handler === undefined) return await this.#finishUnknown(invocation);
    let terminal:
      | { outcome: 'succeeded'; summary: string; resultRefs: string[]; durableSummary: PortableValue;
          modelProjection: PortableValue; userProjection?: PortableValue }
      | { outcome: 'failed' | 'cancelled' | 'outcome_unknown'; summary: string;
          resultRefs: []; error: ToolExecutionErrorFact };
    try {
      const value = await invokeHandlerUntilAbort(handler, argumentsRecord, context);
      await this.#crashPoint('after-external-effect-before-terminal');
      const normalized = normalizeAgentToolResult(value);
      const resultRefs: string[] = [];
      if (normalized.artifactBytes !== undefined) {
        if (this.#artifactStore === undefined) throw invalidToolResultError();
        const staged = await this.#artifactStore.stage({
          mediaType: 'application/vnd.schemanaut.tool-result+json',
          source: bytesSource(normalized.artifactBytes),
          expectedByteSize: normalized.artifactByteSize,
        });
        const ref = await this.#artifactStore.commit({
          staged,
          summary: 'Tool result artifact.',
          journal: {
            sessionId: invocation.sessionId,
            runId: invocation.runId,
            commandId: `tool-artifact:${invocation.invocationId}:${invocation.started.attempt}`,
            lease: leaseReference(this.#binding.lease),
            expectedRunRevision: await this.#runRevision(),
          },
        });
        resultRefs.push(ref.handle);
      }
      terminal = {
        outcome: 'succeeded',
        summary: 'The tool completed.',
        resultRefs,
        durableSummary: normalized.durableSummary,
        modelProjection: normalized.modelProjection,
        ...(normalized.userProjection === undefined
          ? {}
          : { userProjection: normalized.userProjection }),
      };
    } catch (error) {
      if (linked.leaseLost()) {
        throw new ToolInvocationError('LEASE_LOST', 'Run lease is no longer current.');
      }
      const mapped = adaptToolHandlerFailure({
        error,
        timedOut: linked.timedOut(),
        cancelled: !linked.timedOut() && linked.cancelled(),
      });
      const riskyEffect = descriptor.effect === 'non_idempotent' ||
        descriptor.effect === 'transactional';
      const unacknowledgedRiskyAbort = error instanceof ToolHandlerAbort && riskyEffect;
      const outcomeUnknown = riskyEffect &&
        (unacknowledgedRiskyAbort || mapped.fact.outcome === 'unknown');
      const executionError: ToolExecutionErrorFact = outcomeUnknown
        ? { ...mapped.fact, outcome: 'unknown' }
        : descriptor.effect === 'read' && mapped.fact.outcome === 'unknown'
          ? { ...mapped.fact, outcome: 'not_applied' }
          : mapped.fact;
      terminal = {
        outcome: outcomeUnknown
          ? 'outcome_unknown'
          : executionError.code === 'TOOL_CANCELLED' ? 'cancelled' : 'failed',
        summary: mapped.message,
        resultRefs: [],
        error: executionError,
      };
    } finally {
      stopLeaseWatch();
      linked.close();
    }
    let committed: AgentInvocationProjection;
    try {
      const result = await this.#journal.commitToolInvocation({
        action: 'finish',
        projectId: invocation.projectId,
        sessionId: invocation.sessionId,
        runId: invocation.runId,
        turnId: invocation.turnId,
        invocationId: invocation.invocationId,
        commandId: `tool-finish:${invocation.invocationId}:${invocation.started.attempt}:${this.#runtimeId}`,
        lease: leaseReference(this.#binding.lease),
        expectedRunRevision: await this.#runRevision(),
        expectedInvocationRevision: invocation.revision,
        outcome: terminal.outcome,
        summary: terminal.summary,
        resultRefs: terminal.resultRefs,
        ...('durableSummary' in terminal ? { durableSummary: terminal.durableSummary } : {}),
        ...('modelProjection' in terminal ? { modelProjection: terminal.modelProjection } : {}),
        ...('userProjection' in terminal && terminal.userProjection !== undefined
          ? { userProjection: terminal.userProjection }
          : {}),
        ...('error' in terminal ? { error: terminal.error } : {}),
      });
      committed = result.invocation;
    } catch (error) {
      throw mapJournalError(error);
    }
    await this.#crashPoint('after-terminal-before-observation');
    return committed;
  }

  async #finishUnknown(invocation: AgentInvocationProjection): Promise<AgentInvocationProjection> {
    if (invocation.started === undefined) {
      throw new ToolInvocationError('INVOCATION_CONFLICT', 'Invocation start fact is missing.');
    }
    try {
      const result = await this.#journal.commitToolInvocation({
        action: 'finish',
        projectId: invocation.projectId,
        sessionId: invocation.sessionId,
        runId: invocation.runId,
        turnId: invocation.turnId,
        invocationId: invocation.invocationId,
        commandId: `tool-unknown:${invocation.invocationId}:${invocation.started.attempt}:${this.#runtimeId}`,
        lease: leaseReference(this.#binding.lease),
        expectedRunRevision: await this.#runRevision(),
        expectedInvocationRevision: invocation.revision,
        outcome: 'outcome_unknown',
        summary: 'The tool outcome is unknown after interruption.',
        resultRefs: [],
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
      evidenceRefs: [...terminal.resultRefs],
      outcome: terminal.kind,
      ...(effectiveModelProjection === undefined
        ? {}
        : { modelProjection: structuredClone(effectiveModelProjection) }),
      ...(terminal.error === undefined ? {} : { errorCode: terminal.error.code }),
    };
    try {
      const result = await this.#journal.commitToolInvocation({
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
      const mapped = mapJournalError(error);
      if (mapped.code === 'INVOCATION_CONFLICT') {
        const current = await this.#requireBoundInvocation(invocation.invocationId, false);
        if (current.observation !== undefined) return publicObservation(current.observation);
      }
      throw mapped;
    }
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

  async #validateInvocation(invocationId: string): Promise<void> {
    const invocation = await this.#requireBoundInvocation(invocationId);
    if (invocation.state !== 'proposed') return;
    let descriptor: AgentToolDescriptor;
    let argumentsRecord: Record<string, unknown>;
    let toolRevision: string;
    try {
      descriptor = this.#requireDescriptor(invocation);
      if (descriptor.effect === 'legacy-undeclared') {
        throw new ToolInvocationError(
          'TOOL_REVISION_MISMATCH', 'Tool effect metadata is unavailable for this snapshot.',
        );
      }
      this.#requireHandlerRuntime(invocation, descriptor);
      argumentsRecord = portableArguments(invocation.arguments);
      const revision = this.#registry.invocationRevision(invocation.name);
      if (revision === undefined) {
        throw new ToolInvocationError('TOOL_REVISION_MISMATCH', 'Tool revision is unavailable.');
      }
      const validate = schemaValidator(
        `${invocation.name}:${revision}`,
        descriptor.inputSchema,
      );
      if (!validate(argumentsRecord)) {
        throw new ToolInvocationError(
          'TOOL_INPUT_INVALID', 'Tool arguments do not match its schema.',
        );
      }
      toolRevision = revision;
    } catch (error) {
      if (error instanceof ToolInvocationError && isPreStartResolutionError(error)) {
        await this.#rejectBeforeStart(invocation, error);
        return;
      }
      throw error;
    }
    try {
      await this.#journal.commitToolInvocation({
        action: 'validate',
        projectId: invocation.projectId,
        sessionId: invocation.sessionId,
        runId: invocation.runId,
        turnId: invocation.turnId,
        invocationId: invocation.invocationId,
        commandId: `tool-validate:${invocation.invocationId}:${invocation.revision}`,
        lease: leaseReference(this.#binding.lease),
        expectedRunRevision: await this.#runRevision(),
        expectedInvocationRevision: invocation.revision,
        canonicalToolId: structuredClone(descriptor.id),
        toolRevision,
        effect: descriptor.effect,
        normalizedArgumentsDigest: sha256(canonicalJson(argumentsRecord as PortableValue)),
        authorization: this.#permissionManager.decide(this.#binding.mode, descriptor),
        approvalSummary: `Allow ${descriptor.flatName} to run.`,
      });
    } catch (error) {
      throw mapJournalError(error);
    }
  }

  async #rejectBeforeStart(
    invocation: AgentInvocationProjection,
    error: ToolInvocationError,
  ): Promise<AgentInvocationProjection> {
    const fact = resolutionErrorFact(error);
    try {
      const result = await this.#journal.commitToolInvocation({
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
        summary: error.message,
        error: fact,
      });
      return result.invocation;
    } catch (commitError) {
      throw mapJournalError(commitError);
    }
  }

  #requireDescriptor(invocation: AgentInvocationProjection): AgentToolDescriptor {
    const tool = this.#registry.get(invocation.name);
    if (tool === undefined) {
      throw new ToolInvocationError('TOOL_NOT_FOUND', 'Tool is unavailable in this snapshot.');
    }
    const revision = this.#registry.invocationRevision(invocation.name);
    if (
      invocation.toolRevision !== undefined &&
      (revision === undefined || revision !== invocation.toolRevision)
    ) {
      throw new ToolInvocationError('TOOL_REVISION_MISMATCH', 'Tool revision does not match.');
    }
    if (invocation.effect !== undefined && tool.descriptor.effect !== invocation.effect) {
      throw new ToolInvocationError('TOOL_REVISION_MISMATCH', 'Tool effect does not match.');
    }
    return tool.descriptor;
  }

  #requireHandlerRuntime(
    invocation: AgentInvocationProjection,
    descriptor: AgentToolDescriptor,
  ): ToolInvocationHandlerRuntime {
    const runtime = this.#registry.getInvocationRuntime(descriptor.id);
    if (runtime === undefined) {
      throw new ToolInvocationError(
        'TOOL_NOT_FOUND', `Tool ${invocation.name} has no Invocation Handler.`,
      );
    }
    return runtime;
  }

  #effectForScheduling(invocation: AgentInvocationProjection): ScheduledToolEffect {
    if (invocation.effect !== undefined) return invocation.effect;
    if (
      invocation.state === 'failed' || invocation.state === 'cancelled' ||
      invocation.state === 'outcome_unknown' || invocation.state === 'observed'
    ) return 'unresolved';
    let descriptor: AgentToolDescriptor;
    try {
      descriptor = this.#requireDescriptor(invocation);
    } catch (error) {
      if (invocation.state === 'proposed' && error instanceof ToolInvocationError &&
        isPreStartResolutionError(error)) {
        return 'unresolved';
      }
      throw error;
    }
    if (descriptor.effect === 'legacy-undeclared') {
      throw new ToolInvocationError(
        'TOOL_REVISION_MISMATCH', 'Tool effect metadata is unavailable for scheduling.',
      );
    }
    return descriptor.effect;
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
        effect: this.#effectForScheduling(invocation),
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
    const run = await this.#journal.getRunProjection(this.#binding.runId);
    if (
      run === null || run.projectId !== this.#binding.projectId ||
      run.sessionId !== this.#binding.sessionId
    ) {
      throw new ToolInvocationError('INVOCATION_CONFLICT', 'Run scope does not match.');
    }
    return run.revision;
  }

  async #crashPoint(point: ToolInvocationCrashPoint): Promise<void> {
    await this.#onCrashPoint?.(point);
  }
}

function schemaValidator(cacheIdentity: string, schema: object): ValidateFunction {
  const key = `${cacheIdentity}:${sha256(canonicalUnknownJson(schema))}`;
  const existing = compiledSchemas.get(key);
  if (existing !== undefined) {
    compiledSchemas.delete(key);
    compiledSchemas.set(key, existing);
    return existing;
  }
  let compiled: ValidateFunction;
  try {
    compiled = schemaCompiler.compile(structuredClone(schema));
  } catch {
    throw new ToolInvocationError('TOOL_INPUT_INVALID', 'Tool input schema is invalid.');
  }
  compiledSchemas.set(key, compiled);
  while (compiledSchemas.size > MAX_COMPILED_SCHEMAS) {
    const oldest = compiledSchemas.keys().next().value;
    if (oldest === undefined) break;
    compiledSchemas.delete(oldest);
  }
  return compiled;
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
    approval.effect !== decision.effect ||
    approval.normalizedArgumentsDigest !== decision.normalizedArgumentsDigest ||
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

function isPreStartResolutionError(error: ToolInvocationError): boolean {
  return error.code === 'TOOL_NOT_FOUND' || error.code === 'TOOL_REVISION_MISMATCH' ||
    error.code === 'TOOL_INPUT_INVALID';
}

function resolutionErrorFact(error: ToolInvocationError): ToolExecutionErrorFact {
  switch (error.code) {
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

function scheduleState(invocation: AgentInvocationProjection): ToolInvocationScheduleState {
  if (invocation.state === 'validated') {
    throw new ToolInvocationError('INVOCATION_CONFLICT', 'Validated Invocation lacks a policy decision.');
  }
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

function publicObservation(
  observation: ToolObservationFact & { occurredAt?: string },
): ToolObservationFact {
  return {
    observationId: observation.observationId,
    invocationId: observation.invocationId,
    summary: observation.summary,
    evidenceRefs: [...observation.evidenceRefs],
    outcome: observation.outcome,
    ...(observation.modelProjection === undefined
      ? {}
      : { modelProjection: structuredClone(observation.modelProjection) }),
    ...(observation.errorCode === undefined ? {} : { errorCode: observation.errorCode }),
  };
}

function linkedAbortController(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
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
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
    timeout = true;
    controller.abort();
  }, timeoutMs);
  timer?.unref?.();
  return {
    controller,
    timedOut: () => timeout,
    cancelled: () => callerSignal?.aborted === true,
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

async function invokeHandlerUntilAbort(
  handler: NonNullable<ToolInvocationHandlerRuntime['execute']>,
  args: Readonly<Record<string, unknown>>,
  context: ToolInvocationExecutionContext,
): Promise<unknown> {
  let detach = (): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(new ToolHandlerAbort());
    detach = () => context.signal.removeEventListener('abort', onAbort);
    if (context.signal.aborted) onAbort();
    else context.signal.addEventListener('abort', onAbort, { once: true });
  });
  const execution = Promise.resolve().then(async () => await handler(args, context));
  void execution.catch(() => undefined);
  try {
    return await Promise.race([execution, aborted]);
  } finally {
    detach();
  }
}

class ToolHandlerAbort extends Error {
  constructor() {
    super('Tool Handler aborted.');
    this.name = 'ToolHandlerAbort';
  }
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
