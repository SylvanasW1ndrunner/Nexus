import { createHash } from 'node:crypto';
import type { PortableValue } from '@dbagent/shared';
import type { AgentJournal } from './events/agent-journal.js';
import type { CancelRunInput, SteerRunInput } from './kernel/agent-kernel.js';
import type { KernelRunProjection } from './kernel/run-controller.js';
import type {
  RuntimeCommand,
  RuntimeCommandApplicationResult,
  RuntimeCommandChildProjection,
} from './kernel/runtime-command.js';
import {
  openSubagentOutcomeCommitter,
  openSubagentOutcomeRecoveryCommitter,
  type DurableSubagentOutcomeRecovery,
} from './internal/subagent-outcome-authority.js';

const TERMINAL_STATES = new Set<KernelRunProjection['state']>([
  'Completed', 'Failed', 'Cancelled', 'LimitReached', 'Interrupted',
]);

export type ChildAgentIdentityInput = Readonly<{
  projectId: string;
  parentRunId: string;
  parentTurnId: string;
  parentInvocationId: string;
  commandId: string;
}>;

export type ChildAgentIdentity = Readonly<{
  childRunId: string;
  childSessionId: string;
}>;

export type AgentSubagentObservation = Readonly<{
  schemaVersion: 1;
  kind: 'subagent';
  childRunId: string;
  childSessionId: string;
  parentRunId: string;
  parentInvocationId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'limit_reached' | 'interrupted';
  summary: string;
  evidenceRefs: readonly string[];
  artifactRefs: readonly string[];
}>;

type ChildJournal = Pick<AgentJournal,
  'createRun' | 'getRunAncestry' | 'listRunDescendants'
> &
  Partial<Pick<AgentJournal, 'waitRunEvents'>>;

type ChildKernel = Readonly<{
  open(runId: string): Promise<KernelRunProjection>;
  advance(runId: string, options?: Readonly<{ limits?: Readonly<{ maxTurns?: number }> }>): Promise<KernelRunProjection>;
  steer(input: SteerRunInput): Promise<KernelRunProjection>;
  cancel(input: CancelRunInput): Promise<KernelRunProjection>;
  interruptExecution(input: Readonly<{
    runId: string;
    code: string;
    detail?: PortableValue;
  }>): Promise<KernelRunProjection>;
}>;

export type AgentSubagentExecutionOptions = Readonly<{
  signal?: AbortSignal;
  /** Releases the child-specific Kernel capture after its driver settles. */
  onSettled?: () => void | Promise<void>;
}>;

/** Journal-backed child execution adapter for the one Agent Kernel. */
export class JournalAgentSubagentRuntime {
  readonly #journal: ChildJournal;

  constructor(journal: ChildJournal) {
    this.#journal = journal;
  }

  async execute(
    command: Extract<RuntimeCommand, {
      kind: 'child.start' | 'child.steer' | 'child.cancel';
    }>,
    application: RuntimeCommandApplicationResult,
    options: AgentSubagentExecutionOptions = {},
  ): Promise<AgentSubagentObservation> {
    void options;
    assertApplicationScope(command, application);
    switch (command.kind) {
      case 'child.start':
        return await this.#start(command, application);
      case 'child.steer':
        return await this.#steer(command, application);
      case 'child.cancel':
        return await this.#cancel(command, application);
      default:
        return assertNever(command);
    }
  }

  async #start(
    command: Extract<RuntimeCommand, { kind: 'child.start' }>,
    application: RuntimeCommandApplicationResult,
  ): Promise<AgentSubagentObservation> {
    const child = committedChild(command, application);
    await this.#journal.createRun({
      projectId: application.run.projectId,
      sessionId: child.childSessionId,
      runId: child.childRunId,
      clientRequestId: `subagent:${child.childRunId}`,
      input: {
        task: command.payload.task,
        context: structuredClone(command.payload.context),
      },
      parent: {
        runId: command.origin.runId,
        turnId: command.origin.turnId,
        invocationId: command.origin.invocationId,
      },
    });

    // This is deliberately an intent boundary.  Awaiting model or Tool work
    // here would occupy the parent Tool lane and create a second driver loop.
    return pendingObservation(command, child);
  }

  #steer(
    command: Extract<RuntimeCommand, { kind: 'child.steer' }>,
    application: RuntimeCommandApplicationResult,
  ): Promise<AgentSubagentObservation> {
    const child = requireProjectedChild(application, command.payload.childRunId);
    return Promise.resolve(pendingObservation(command, child));
  }

  #cancel(
    command: Extract<RuntimeCommand, { kind: 'child.cancel' }>,
    application: RuntimeCommandApplicationResult,
  ): Promise<AgentSubagentObservation> {
    const child = requireProjectedChild(application, command.payload.childRunId);
    return Promise.resolve(pendingObservation(command, child, 'cancelled'));
  }
}

/**
 * The Agent host owns this scheduler and its lifetime. It is the only background
 * child driver: Tool handlers and JournalAgentSubagentRuntime only persist
 * intent.  Every background promise is retained until it settles or close()
 * drains it.
 */
export class JournalAgentSubagentScheduler {
  readonly #journal: ChildJournal;
  readonly #operations = new Map<string, Promise<void>>();
  readonly #operationSettlers = new Map<string, () => void>();
  readonly #controlCommands = new Set<string>();
  readonly #controlQueues = new Map<string, Promise<void>>();
  readonly #scheduled = new Map<string, Readonly<{
    kernel: ChildKernel;
    controller: AbortController;
  }>>();
  readonly #cancellingRuns = new Set<string>();
  readonly #failures: unknown[] = [];
  readonly #maxConcurrentChildren: number;
  readonly #closeTimeoutMs: number;
  readonly #maxTurnsPerChild: number | undefined;
  readonly #maxDepth: number | undefined;
  readonly #maxChildrenPerRoot: number | undefined;
  readonly #resolveKernel: ((runId: string) => Promise<ChildKernel>) | undefined;
  readonly #queued: Array<Readonly<{ start: () => void; cancel: () => void }>> = [];
  #activeChildren = 0;
  #closed = false;

  constructor(options: Readonly<{
    journal: ChildJournal;
    maxConcurrentChildren?: number;
    maxTurnsPerChild?: number;
    maxDepth?: number;
    maxChildrenPerRoot?: number;
    closeTimeoutMs?: number;
    /** Resolves the Run-owned Kernel needed to respect a descendant lease. */
    resolveKernel?: (runId: string) => Promise<ChildKernel>;
  }>) {
    this.#journal = options.journal;
    this.#maxConcurrentChildren = boundedPositive(
      options.maxConcurrentChildren ?? 4, 'maxConcurrentChildren', 128,
    );
    this.#closeTimeoutMs = boundedPositive(options.closeTimeoutMs ?? 5_000, 'closeTimeoutMs', 60_000);
    this.#maxTurnsPerChild = options.maxTurnsPerChild === undefined
      ? undefined
      : boundedPositive(options.maxTurnsPerChild, 'maxTurnsPerChild', 10_000);
    this.#maxDepth = options.maxDepth === undefined
      ? undefined : boundedPositive(options.maxDepth, 'maxDepth', 32);
    this.#maxChildrenPerRoot = options.maxChildrenPerRoot === undefined
      ? undefined : boundedPositive(options.maxChildrenPerRoot, 'maxChildrenPerRoot', 10_000);
    this.#resolveKernel = options.resolveKernel;
  }

  schedule(
    command: Extract<RuntimeCommand, { kind: 'child.start' | 'child.steer' | 'child.cancel' }>,
    application: RuntimeCommandApplicationResult,
    kernel: ChildKernel,
    options: AgentSubagentExecutionOptions = {},
  ): void {
    if (this.#closed) throw new Error('Child Agent scheduler is closed.');
    const child = command.kind === 'child.start'
      ? committedChild(command, application)
      : requireProjectedChild(application, command.payload.childRunId);
    if (command.kind !== 'child.start') {
      this.#enqueueControl(command, application, child, kernel);
      return;
    }
    if (this.#operations.has(child.childRunId)) return;
    const controller = new AbortController();
    const signal = options.signal === undefined
      ? controller.signal
      : AbortSignal.any([options.signal, controller.signal]);
    let resolveOperation: () => void = () => undefined;
    let settled = false;
    const settle = async () => {
      if (settled) return;
      settled = true;
      try {
        await options.onSettled?.();
      } catch (error) {
        this.#failures.push(error);
      }
    };
    const operation = new Promise<void>((resolve) => {
      resolveOperation = resolve;
      this.#queued.push({ start: () => {
        this.#activeChildren += 1;
        const work = this.#run(command, application, child, kernel, signal)
          .catch(async (error) => {
            if (this.#closed && signal.aborted) return;
            await this.#reconcileDriverFailure({
              command, childSessionId: child.childSessionId, childRunId: child.childRunId, kernel, error,
            });
          })
          .finally(async () => {
            this.#activeChildren -= 1;
            this.#operations.delete(child.childRunId);
            this.#operationSettlers.delete(child.childRunId);
            this.#scheduled.delete(child.childRunId);
            this.#drain();
            await settle();
            resolve();
          });
        // `work` is owned by `operation` through its settlement continuation.
        void work;
      }, cancel: () => {
        this.#operations.delete(child.childRunId);
        this.#operationSettlers.delete(child.childRunId);
        this.#scheduled.delete(child.childRunId);
        void settle().finally(resolve);
      }});
    });
    this.#operations.set(child.childRunId, operation);
    this.#operationSettlers.set(child.childRunId, resolveOperation);
    this.#scheduled.set(child.childRunId, { kernel, controller });
    this.#drain();
  }

  #enqueueControl(
    command: Extract<RuntimeCommand, { kind: 'child.steer' | 'child.cancel' }>,
    application: RuntimeCommandApplicationResult,
    child: RuntimeCommandChildProjection,
    kernel: ChildKernel,
  ): void {
    if (this.#controlCommands.has(command.commandId)) return;
    this.#controlCommands.add(command.commandId);
    const childKernel = this.#scheduled.get(child.childRunId)?.kernel ?? kernel;
    const previous = this.#controlQueues.get(child.childRunId) ?? Promise.resolve();
    const work = previous.then(async () => {
      if (command.kind === 'child.steer') {
        await childKernel.steer({
          runId: child.childRunId,
          clientRequestId: `subagent-steer:${command.commandId}`,
          input: structuredClone(command.payload.input),
        });
        return;
      }
      await this.#cancelTree({
        projectId: application.run.projectId,
        runId: child.childRunId,
        reason: command.payload.reason ?? 'Cancelled by the parent Runtime.',
        kernel: childKernel,
      });
    });
    // Keep the per-child control lane usable after a failed command, while
    // retaining the failure for close() rather than silently discarding it.
    const next = work.catch(async (error) => {
      await this.#reconcileDriverFailure({
        childSessionId: child.childSessionId,
        childRunId: child.childRunId,
        kernel: childKernel,
        error,
      });
    });
    this.#controlQueues.set(child.childRunId, next);
    void next.finally(() => {
      this.#controlCommands.delete(command.commandId);
      if (this.#controlQueues.get(child.childRunId) === next) {
        this.#controlQueues.delete(child.childRunId);
      }
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    // A queued child already has durable identity and is present in
    // #scheduled. Retain that snapshot before cancelling queue entries,
    // because their queue cleanup deliberately removes them from the live
    // scheduler maps.
    const scheduledAtClose = [...this.#scheduled.entries()];
    const cancellations = Promise.allSettled(scheduledAtClose.map(async ([runId, scheduled]) => {
      if (this.#cancellingRuns.has(runId)) return;
      const run = await scheduled.kernel.open(runId);
      if (TERMINAL_STATES.has(run.state)) return;
      await scheduled.kernel.cancel({ runId, reason: 'Runtime scheduler is closing.' });
    }));
    const cancellationResult = await Promise.race([
      cancellations,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), this.#closeTimeoutMs)),
    ]);
    if (cancellationResult === 'timeout') {
      for (const scheduled of scheduledAtClose.map(([, scheduled]) => scheduled)) {
        scheduled.controller.abort('Runtime scheduler close cancellation timed out.');
      }
      // A cancellation hook may be non-cooperative.  Persist a terminal
      // interruption through the Run Kernel before detaching this scheduler
      // so recovery and callers can query the exact close failure instead of
      // inheriting an in-memory-only scheduler error.
      await Promise.race([
        Promise.allSettled(scheduledAtClose.map(async ([runId, scheduled]) => {
          await scheduled.kernel.interruptExecution({
            runId,
            code: 'SUBAGENT_SCHEDULER_CLOSE_TIMEOUT',
            detail: { category: 'subagent-scheduler-close', reason: 'close-timeout' },
          });
        })),
        new Promise<void>((resolve) => setTimeout(resolve, this.#closeTimeoutMs)),
      ]);
      // Queued entries are now durably terminal (or have a durable timeout
      // interruption) before their settlement callbacks read the projection.
      while (this.#queued.length > 0) this.#queued.shift()?.cancel();
      for (const settle of this.#operationSettlers.values()) settle();
      this.#operations.clear();
      this.#operationSettlers.clear();
      this.#scheduled.clear();
      throw new AggregateError([
        new Error(`Child Agent scheduler cancellation did not settle within ${this.#closeTimeoutMs}ms.`),
      ], 'Child Agent scheduler failed to converge.');
    }
    for (const result of cancellationResult) {
      if (result.status === 'rejected') this.#failures.push(result.reason);
    }
    // Do not settle queued public child handles until the cancellation facts
    // above are observable through their Run Kernels.
    while (this.#queued.length > 0) this.#queued.shift()?.cancel();
    const drained = await Promise.race([
      Promise.allSettled([...this.#operations.values(), ...this.#controlQueues.values()]),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), this.#closeTimeoutMs)),
    ]);
    if (drained === 'timeout') {
      // Do not let a Journal event wait keep a Runtime alive after the bounded
      // shutdown window. The cancellation fact above remains durable; a later
      // Runtime recovery reconciles any parent outcome that was not observed.
      for (const scheduled of this.#scheduled.values()) {
        scheduled.controller.abort('Runtime scheduler close timed out.');
      }
      // A non-cooperative Model implementation can leave a child Kernel
      // promise pending forever. It no longer owns a scheduler slot or map
      // entry after the bounded close; abort guards below prevent it from
      // issuing a later Journal wait or parent outcome commit if it returns.
      for (const settle of this.#operationSettlers.values()) settle();
      this.#operations.clear();
      this.#operationSettlers.clear();
      this.#scheduled.clear();
      this.#failures.push(new Error(
        `Child Agent scheduler did not drain within ${this.#closeTimeoutMs}ms.`,
      ));
    }
    if (this.#failures.length > 0) {
      const failures = this.#failures.splice(0, this.#failures.length);
      throw new AggregateError(failures, 'Child Agent scheduler failed to converge.');
    }
  }

  /**
   * Reattach a newly constructed Runtime to an already durable child.  This
   * never creates a Run: the Journal identity and Kernel replay fence remain
   * the source of truth, so recovery cannot duplicate model or Tool effects.
   */
  recover(input: Readonly<{
    projectId: string;
    childSessionId: string;
    childRunId: string;
    kernel: ChildKernel;
    recovery?: DurableSubagentOutcomeRecovery;
    /** Releases the child-specific Kernel capture after recovery settles. */
    onSettled?: () => void | Promise<void>;
  }>): void {
    if (this.#closed || this.#operations.has(input.childRunId)) return;
    const controller = new AbortController();
    let resolveOperation: () => void = () => undefined;
    let settled = false;
    const settle = async () => {
      if (settled) return;
      settled = true;
      try {
        await input.onSettled?.();
      } catch (error) {
        this.#failures.push(error);
      }
    };
    const operation = new Promise<void>((resolve) => {
      resolveOperation = resolve;
      this.#queued.push({ start: () => {
        this.#activeChildren += 1;
        const work = this.#driveToTerminal(
          input.projectId, input.childSessionId, input.childRunId, input.kernel, controller.signal,
        ).then(async (run) => {
          if (input.recovery !== undefined) {
            const committer = openSubagentOutcomeRecoveryCommitter(this.#journal);
            if (committer !== undefined) {
              await committer.commit(
                input.recovery,
                recoveryObservation(input.recovery, input.childSessionId, run),
              );
            }
          }
        }).catch(async (error) => {
          if (this.#closed && controller.signal.aborted) return;
          await this.#reconcileDriverFailure({
            ...(input.recovery === undefined ? {} : { recovery: input.recovery }),
            childSessionId: input.childSessionId, childRunId: input.childRunId, kernel: input.kernel, error,
            recoveryMode: true,
          });
        }).finally(async () => {
          this.#activeChildren -= 1;
          this.#operations.delete(input.childRunId);
          this.#operationSettlers.delete(input.childRunId);
          this.#scheduled.delete(input.childRunId);
          this.#drain();
          await settle();
          resolve();
        });
        void work;
      }, cancel: () => {
        this.#operations.delete(input.childRunId);
        this.#operationSettlers.delete(input.childRunId);
        this.#scheduled.delete(input.childRunId);
        void settle().finally(resolve);
      }});
    });
    this.#operations.set(input.childRunId, operation);
    this.#operationSettlers.set(input.childRunId, resolveOperation);
    this.#scheduled.set(input.childRunId, { kernel: input.kernel, controller });
    this.#drain();
  }

  async cancelDescendants(input: Readonly<{
    projectId: string;
    rootRunId: string;
    reason: string;
    kernel: ChildKernel;
  }>): Promise<void> {
    const ancestry = await this.#journal.getRunAncestry(input.rootRunId);
    if (ancestry === null) throw new Error(`Child Run ancestry is unavailable: ${input.rootRunId}.`);
    const descendants = await this.#journal.listRunDescendants({
      projectId: input.projectId, rootRunId: ancestry.rootRunId,
    });
    const subtree = descendants.filter((candidate) =>
      isDescendantOf(candidate, input.rootRunId, descendants));
    for (const descendant of [...subtree].sort((left, right) => right.depth - left.depth)) {
      await (await this.#kernelFor(descendant.runId, input.kernel)).cancel({
        runId: descendant.runId, reason: input.reason,
      });
    }
  }

  /** Cancels a requested Run and only its durable descendants. */
  async cancelTree(input: Readonly<{
    projectId: string;
    rootRunId: string;
    reason: string;
    kernel: ChildKernel;
  }>): Promise<KernelRunProjection> {
    return await this.#cancelTree({
      projectId: input.projectId,
      runId: input.rootRunId,
      reason: input.reason,
      kernel: input.kernel,
    });
  }

  #drain(): void {
    if (this.#closed) return;
    while (this.#activeChildren < this.#maxConcurrentChildren && this.#queued.length > 0) {
      this.#queued.shift()?.start();
    }
  }

  async #run(
    command: Extract<RuntimeCommand, { kind: 'child.start' | 'child.steer' | 'child.cancel' }>,
    application: RuntimeCommandApplicationResult,
    child: RuntimeCommandChildProjection,
    kernel: ChildKernel,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const reachedLimit = command.kind === 'child.start'
      ? await this.#enforceDurableTreeLimits(child.childRunId, kernel)
      : null;
    if (command.kind === 'child.steer') {
      await kernel.steer({
        runId: child.childRunId,
        clientRequestId: `subagent-steer:${command.commandId}`,
        input: structuredClone(command.payload.input),
      });
    }
    if (command.kind === 'child.cancel') {
      await this.#cancelTree({
        projectId: application.run.projectId,
        runId: child.childRunId,
        reason: command.payload.reason ?? 'Cancelled by the parent Runtime.',
        kernel,
      });
    }
    if (reachedLimit !== null) {
      if (command.kind === 'child.start') {
        const committer = openSubagentOutcomeCommitter(this.#journal);
        if (committer !== undefined) await committer.commit(
          command, observation(command, child.childSessionId, reachedLimit),
        );
      }
      return;
    }
    let cancellation: Promise<unknown> | undefined;
    const onAbort = () => {
      this.#cancellingRuns.add(child.childRunId);
      cancellation ??= kernel.cancel({
        runId: child.childRunId,
        reason: abortReason(signal),
      }).catch((error) => { this.#failures.push(error); });
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
    try {
      const run = await this.#driveToTerminal(
        application.run.projectId, child.childSessionId, child.childRunId, kernel, signal,
      );
      if (cancellation !== undefined) await cancellation;
      if (command.kind === 'child.start') {
        const committer = openSubagentOutcomeCommitter(this.#journal);
        if (committer !== undefined) {
          await committer.commit(command, observation(command, child.childSessionId, run));
        }
      }
    } finally {
      this.#cancellingRuns.delete(child.childRunId);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async #enforceDurableTreeLimits(
    childRunId: string,
    kernel: ChildKernel,
  ): Promise<KernelRunProjection | null> {
    if (this.#maxDepth === undefined && this.#maxChildrenPerRoot === undefined) return null;
    const ancestry = await this.#journal.getRunAncestry(childRunId);
    if (ancestry === null) throw new Error(`Child Run ancestry is unavailable: ${childRunId}.`);
    const overDepth = this.#maxDepth !== undefined && ancestry.depth > this.#maxDepth;
    const overRootCount = this.#maxChildrenPerRoot !== undefined &&
      ancestry.rootChildOrdinal > this.#maxChildrenPerRoot;
    if (!overDepth && !overRootCount) return null;
    // Zero turns is a durable pre-turn limit: the Kernel emits LimitReached
    // before any Model or Tool side effect.
    return await kernel.advance(childRunId, { limits: { maxTurns: 0 } });
  }

  async #cancelTree(input: Readonly<{
    projectId: string;
    runId: string;
    reason: string;
    kernel: ChildKernel;
  }>): Promise<KernelRunProjection> {
    const ancestry = await this.#journal.getRunAncestry(input.runId);
    if (ancestry === null) throw new Error(`Child Run ancestry is unavailable: ${input.runId}.`);
    const descendants = await this.#journal.listRunDescendants({
      projectId: input.projectId, rootRunId: ancestry.rootRunId,
    });
    const subtree = descendants.filter((candidate) => isDescendantOf(candidate, input.runId, descendants));
    for (const descendant of [...subtree].sort((left, right) => right.depth - left.depth)) {
      await (await this.#kernelFor(descendant.runId, input.kernel)).cancel({
        runId: descendant.runId, reason: input.reason,
      });
    }
    // The caller supplies the Kernel that owns the selected root Run. The
    // resolver is intentionally child-only and is used solely for descendants.
    return await input.kernel.cancel({
      runId: input.runId, reason: input.reason,
    });
  }

  async #kernelFor(runId: string, fallback: ChildKernel): Promise<ChildKernel> {
    // A live child driver already owns the Run lease through its captured
    // Kernel. Reconstructing another Kernel for that Run would contend for
    // the lease instead of propagating cancellation. Resolve only dormant
    // descendants that are not presently scheduled in this Runtime.
    return this.#scheduled.get(runId)?.kernel ?? await this.#resolveKernel?.(runId) ?? fallback;
  }

  /**
   * A scheduler driver is never allowed to leave an applied child.start
   * indefinitely running after an internal failure. Persist cancellation and
   * reconcile the parent terminal fact immediately; retain only failures that
   * prevented that durable convergence for close() diagnostics.
   */
  async #reconcileDriverFailure(input: Readonly<{
    command?: Extract<RuntimeCommand, { kind: 'child.start' }>;
    recovery?: DurableSubagentOutcomeRecovery;
    childSessionId: string;
    childRunId: string;
    kernel: ChildKernel;
    error: unknown;
    recoveryMode?: boolean;
  }>): Promise<void> {
    try {
      const run = await input.kernel.interruptExecution({
        runId: input.childRunId,
        code: 'SUBAGENT_SCHEDULER_FAILED',
        detail: { category: 'subagent-scheduler', reason: boundedErrorCode(input.error) },
      });
      if (input.command === undefined && input.recovery === undefined) return;
      if (input.recoveryMode === true && input.recovery !== undefined) {
        const committer = openSubagentOutcomeRecoveryCommitter(this.#journal);
        if (committer !== undefined) {
          await committer.commit(
            input.recovery,
            recoveryObservation(input.recovery, input.childSessionId, run),
          );
        }
      } else if (input.command !== undefined) {
        const committer = openSubagentOutcomeCommitter(this.#journal);
        if (committer !== undefined) {
          await committer.commit(
            input.command,
            observation(input.command, input.childSessionId, run),
          );
        }
      }
    } catch (reconcileError) {
      this.#failures.push(new AggregateError(
        [input.error, reconcileError], 'Child Agent driver failure could not be reconciled.',
      ));
    }
  }

  async #driveToTerminal(
    projectId: string,
    sessionId: string,
    runId: string,
    kernel: ChildKernel,
    signal: AbortSignal | undefined,
  ): Promise<KernelRunProjection> {
    let afterSequence = 0;
    while (true) {
      throwIfAborted(signal);
      let run = await kernel.open(runId);
      throwIfAborted(signal);
      if (TERMINAL_STATES.has(run.state)) return run;
      if (run.state !== 'AwaitingUser') {
        run = await kernel.advance(runId, this.#maxTurnsPerChild === undefined
          ? undefined
          : { limits: { maxTurns: this.#maxTurnsPerChild } });
        throwIfAborted(signal);
        if (TERMINAL_STATES.has(run.state)) return run;
      }
      const wait = this.#journal.waitRunEvents;
      if (wait === undefined) {
        throw new Error(`Child Run ${runId} stopped before reaching a terminal state.`);
      }
      const changed = await wait.call(this.#journal, {
        projectId, sessionId, runId, afterSequence, limit: 128, timeoutMs: 300_000,
        ...(signal === undefined ? {} : { signal }),
      });
      afterSequence = changed.nextSequence ?? afterSequence;
    }
  }
}

export function deriveChildAgentIdentity(input: ChildAgentIdentityInput): ChildAgentIdentity {
  const digest = createHash('sha256').update(canonicalJson({
    projectId: requireText(input.projectId, 'projectId'),
    runId: requireText(input.parentRunId, 'parentRunId'),
    turnId: requireText(input.parentTurnId, 'parentTurnId'),
    invocationId: requireText(input.parentInvocationId, 'parentInvocationId'),
    commandId: requireText(input.commandId, 'commandId'),
  })).digest('hex');
  const childRunId = `child_${digest.slice(0, 32)}`;
  return Object.freeze({
    childRunId,
    childSessionId: `child_session_${digest.slice(0, 32)}`,
  });
}

function committedChild(
  command: Extract<RuntimeCommand, { kind: 'child.start' }>,
  application: RuntimeCommandApplicationResult,
): RuntimeCommandChildProjection {
  const applied = application.events.find(
    (event) => event.type === 'runtime.command_applied' &&
      event.payload.commandId === command.commandId && event.payload.kind === command.kind,
  );
  if (applied === undefined || applied.type !== 'runtime.command_applied') {
    throw new TypeError('Committed child.start effect is unavailable.');
  }
  const effect = portableRecord(applied.payload.effect, 'child.start effect');
  const trusted = deriveChildAgentIdentity({
    projectId: application.run.projectId,
    parentRunId: command.origin.runId,
    parentTurnId: command.origin.turnId,
    parentInvocationId: command.origin.invocationId,
    commandId: command.commandId,
  });
  if (effect.childRunId !== trusted.childRunId || effect.childSessionId !== trusted.childSessionId) {
    throw new TypeError('Committed child identity does not match the trusted causal identity.');
  }
  const child = requireProjectedChild(application, trusted.childRunId);
  if (
    child.childSessionId !== trusted.childSessionId || child.parentRunId !== command.origin.runId ||
    child.parentInvocationId !== command.origin.invocationId
  ) {
    throw new TypeError('Committed child projection does not match its Runtime Command.');
  }
  return child;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error(typeof signal?.reason === 'string' ? signal.reason : 'Child Agent driver was aborted.');
}

function requireProjectedChild(
  application: RuntimeCommandApplicationResult,
  childRunId: string,
): RuntimeCommandChildProjection {
  const child = application.projection.children.find(
    (candidate) => candidate.childRunId === childRunId,
  );
  if (child === undefined) throw new TypeError(`Child Run is not projected: ${childRunId}.`);
  return child;
}

function assertApplicationScope(
  command: Extract<RuntimeCommand, {
    kind: 'child.start' | 'child.steer' | 'child.cancel';
  }>,
  application: RuntimeCommandApplicationResult,
): void {
  if (
    application.run.runId !== command.origin.runId ||
    application.run.projectId !== application.projection.projectId ||
    application.run.sessionId !== application.projection.sessionId
  ) {
    throw new TypeError('Runtime Command application scope does not match the parent Run.');
  }
}

function observation(
  command: Extract<RuntimeCommand, {
    kind: 'child.start' | 'child.steer' | 'child.cancel';
  }>,
  childSessionId: string,
  run: KernelRunProjection,
): AgentSubagentObservation {
  const status = observationStatus(run.state);
  return Object.freeze({
    schemaVersion: 1,
    kind: 'subagent',
    childRunId: run.runId,
    childSessionId,
    parentRunId: command.origin.runId,
    parentInvocationId: command.origin.invocationId,
    status,
    summary: observationSummary(status),
    // finalContentRef is an internal content locator and evidenceDigest is a
    // checksum, not a dereferenceable evidence ref. The host wait projection
    // reads actual completion/artifact facts before exposing public refs.
    evidenceRefs: Object.freeze([]),
    artifactRefs: Object.freeze([]),
  });
}

function recoveryObservation(
  recovery: DurableSubagentOutcomeRecovery,
  childSessionId: string,
  run: KernelRunProjection,
): AgentSubagentObservation {
  const status = observationStatus(run.state);
  return Object.freeze({
    schemaVersion: 1,
    kind: 'subagent',
    childRunId: run.runId,
    childSessionId,
    parentRunId: recovery.origin.runId,
    parentInvocationId: recovery.origin.invocationId,
    status,
    summary: observationSummary(status),
    evidenceRefs: Object.freeze([]),
    artifactRefs: Object.freeze([]),
  });
}

function pendingObservation(
  command: Extract<RuntimeCommand, {
    kind: 'child.start' | 'child.steer' | 'child.cancel';
  }>,
  child: RuntimeCommandChildProjection,
  status: AgentSubagentObservation['status'] = 'running',
): AgentSubagentObservation {
  return Object.freeze({
    schemaVersion: 1,
    kind: 'subagent',
    childRunId: child.childRunId,
    childSessionId: child.childSessionId,
    parentRunId: command.origin.runId,
    parentInvocationId: command.origin.invocationId,
    status,
    summary: observationSummary(status),
    evidenceRefs: Object.freeze([]),
    artifactRefs: Object.freeze([]),
  });
}

function observationStatus(
  state: KernelRunProjection['state'],
): AgentSubagentObservation['status'] {
  switch (state) {
    case 'created':
    case 'Preparing':
    case 'Compacting':
    case 'CallingModel':
    case 'ReceivingModel':
    case 'ResolvingActions':
    case 'AwaitingUser':
    case 'ExecutingTools':
    case 'ApplyingObservations':
    case 'Finalizing':
    case 'Cancelling': return 'running';
    case 'Completed': return 'completed';
    case 'Failed': return 'failed';
    case 'Cancelled': return 'cancelled';
    case 'LimitReached': return 'limit_reached';
    case 'Interrupted': return 'interrupted';
    default: throw new TypeError(`Child Run is not terminal: ${String(state)}.`);
  }
}

function observationSummary(status: AgentSubagentObservation['status']): string {
  switch (status) {
    case 'running': return 'Child Agent is running.';
    case 'completed': return 'Child Agent completed.';
    case 'failed': return 'Child Agent failed.';
    case 'cancelled': return 'Child Agent was cancelled.';
    case 'limit_reached': return 'Child Agent reached a runtime limit.';
    case 'interrupted': return 'Child Agent was interrupted.';
    default: return assertNever(status);
  }
}

function abortReason(signal: AbortSignal | undefined): string {
  const reason: unknown = signal?.reason;
  if (typeof reason === 'string' && reason.trim() !== '') return reason;
  if (reason instanceof Error && reason.message.trim() !== '') return reason.message;
  return 'Parent Run was cancelled.';
}

function boundedErrorCode(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const candidate = error.code;
    if (typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(candidate)) {
      return candidate;
    }
  }
  return 'UNKNOWN';
}

function portableRecord(value: PortableValue, label: string): Record<string, PortableValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function canonicalJson(value: PortableValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as { [key: string]: PortableValue };
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key] as PortableValue)}`).join(',')}}`;
}

function requireText(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} is required.`);
  return value;
}

function boundedPositive(value: number, name: string, maximum: number): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be an integer from 1 to ${maximum}.`);
  }
  return value;
}

function isDescendantOf(
  candidate: Readonly<{ runId: string; parentRunId: string | null }>,
  ancestorRunId: string,
  all: readonly Readonly<{ runId: string; parentRunId: string | null }>[],
): boolean {
  const parents = new Map(all.map((entry) => [entry.runId, entry.parentRunId] as const));
  let cursor = candidate.parentRunId;
  const seen = new Set<string>();
  while (cursor !== null && !seen.has(cursor)) {
    if (cursor === ancestorRunId) return true;
    seen.add(cursor);
    cursor = parents.get(cursor) ?? null;
  }
  return false;
}

function assertNever(value: never): never {
  throw new TypeError(`Unsupported child Runtime value: ${String(value)}.`);
}
