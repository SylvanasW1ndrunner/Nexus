import type { PreparedToolIntent, ToolExecuteContext } from './tool-protocol.js';
import { ToolExecutionError } from './tool-errors.js';

export type ToolResourceOperationContext = Readonly<{ signal: AbortSignal; deadline: string }>;
export type ToolResourceLease = Readonly<{ release(context: ToolResourceOperationContext): void | Promise<void> }>;
export type ToolTargetRevalidator = (intent: PreparedToolIntent, context: ToolExecuteContext) => void | 'target_changed' | 'conflict' | Promise<void | 'target_changed' | 'conflict'>;
export interface ToolResourceLeaseProvider {
  acquire(scope: string, invocationId: string, intent: PreparedToolIntent, context: ToolResourceOperationContext): ToolResourceLease | Promise<ToolResourceLease>;
}

/** Tracks actual promises, independently of the deadline-limited wait seen by the caller. */
export class ToolExecutionDrain {
  readonly #pending = new Set<Promise<unknown>>();
  track<T>(work: Promise<T>): Promise<T> {
    this.#pending.add(work);
    void work.then(() => this.#pending.delete(work), () => this.#pending.delete(work));
    return work;
  }
  close(releaseGeneration: () => void): void {
    void (async () => {
      while (this.#pending.size) await Promise.allSettled([...this.#pending]);
      try { releaseGeneration(); } catch { /* Cleanup cannot replace the durable business outcome. */ }
    })();
  }
}

/** Run-local arbitration; external mutations still require conditional I/O in the Tool. */
export class RunToolResourceLeases implements ToolResourceLeaseProvider {
  readonly #held = new Map<string, Map<string, PreparedToolIntent>>();
  acquire(scope: string, invocationId: string, intent: PreparedToolIntent): ToolResourceLease {
    const entries = this.#held.get(scope) ?? new Map<string, PreparedToolIntent>();
    for (const [id, held] of entries) {
      if (id === invocationId || intent.access !== 'read' || held.access !== 'read' || intent.concurrency !== 'read' || held.concurrency !== 'read' || intent.resourceKeys.some(key => held.resourceKeys.includes(key))) {
        throw new ToolExecutionError({ code: 'conflict', category: 'conflict', retryable: true, outcome: 'not_applied' }, 'The prepared resource execution window is occupied or awaiting cleanup.');
      }
    }
    entries.set(invocationId, intent);
    this.#held.set(scope, entries);
    let released = false;
    return Object.freeze({ release: () => {
      if (released) return;
      released = true;
      entries.delete(invocationId);
      if (entries.size === 0) this.#held.delete(scope);
    } });
  }
}

// Always enforce local exclusion, including when a Host provider is injected.
const executionGuards = new RunToolResourceLeases();
const CLEANUP_GRACE_MS = 1_000;

export class ToolExecutionBoundary {
  constructor(readonly leases: ToolResourceLeaseProvider, readonly revalidate?: ToolTargetRevalidator, readonly now: () => number = Date.now) {}

  async acquire(intent: PreparedToolIntent, context: ToolExecuteContext, drain: ToolExecutionDrain): Promise<ToolResourceLease> {
    checkBoundary(context, this.now);
    const scope = `${context.projectId}\0${context.sessionId}\0${context.runId}`;
    const guard = executionGuards.acquire(scope, context.invocationId, intent);
    const acquisition = drain.track(Promise.resolve().then(() => {
      checkBoundary(context, this.now);
      return this.leases.acquire(scope, context.invocationId, intent, context);
    }));
    let lease: ToolResourceLease;
    try {
      lease = await waitWithinBoundary(acquisition, context, this.now);
    } catch (error) {
      // A late acquire still owns a resource. Release it only after the provider resolves.
      void drain.track(acquisition.then(
        late => this.releaseAfterDrain(compositeLease(late, guard), Promise.resolve(), drain),
        async () => { await guard.release(context); },
      )).catch(() => undefined);
      throw error;
    }
    const guarded = compositeLease(lease, guard);
    const validation = drain.track(Promise.resolve().then(async () => {
      checkBoundary(context, this.now);
      if (this.revalidate === undefined && intent.targetIdentity !== null) throw new ToolExecutionError({ code: 'target_changed', category: 'precondition', retryable: true, outcome: 'not_applied' }, 'The Host has no revalidator for the prepared target.');
      const result = await this.revalidate?.(intent, context);
      if (result) throw new ToolExecutionError({ code: result, category: 'conflict', retryable: true, outcome: 'not_applied' }, 'The prepared target or boundary changed before execution.');
    }));
    try {
      await waitWithinBoundary(validation, context, this.now);
      checkBoundary(context, this.now);
      return guarded;
    } catch (error) {
      // Revalidation can ignore cancellation too; retain the guard while it is still active.
      void this.releaseAfterDrain(guarded, validation, drain);
      throw error;
    }
  }

  /** Schedules actual release after actual handler/revalidator drain; never blocks terminal commit. */
  releaseAfterDrain(lease: ToolResourceLease, settled: Promise<unknown>, drain: ToolExecutionDrain): Promise<void> {
    const cleanup = settled.catch(() => undefined).then(async () => {
      const controller = new AbortController();
      const cleanupContext = { signal: controller.signal, deadline: new Date(this.now() + CLEANUP_GRACE_MS).toISOString() };
      const timer = setTimeout(() => controller.abort(), CLEANUP_GRACE_MS);
      timer.unref?.();
      const actualRelease = drain.track(Promise.resolve().then(() => lease.release(cleanupContext)));
      try { await waitWithinBoundary(actualRelease, cleanupContext, this.now); }
      catch { /* Failed/pending cleanup leaves the local guard quarantined. */ }
      finally { clearTimeout(timer); }
    });
    void drain.track(cleanup);
    return cleanup;
  }
}

function compositeLease(lease: ToolResourceLease, guard: ToolResourceLease): ToolResourceLease {
  let release: Promise<void> | undefined;
  return Object.freeze({ release(context: ToolResourceOperationContext) {
    release ??= Promise.resolve().then(async () => {
      await lease.release(context);
      await guard.release(context);
    });
    return release;
  } });
}

function checkBoundary(context: ToolResourceOperationContext, now: () => number): void {
  if (now() >= Date.parse(context.deadline)) throw new ToolExecutionError({ code: 'TOOL_TIMEOUT', category: 'timeout', retryable: true, outcome: 'not_applied' }, 'The prepared invocation deadline expired.');
  if (context.signal.aborted) throw new ToolExecutionError({ code: 'TOOL_CANCELLED', category: 'cancelled', retryable: true, outcome: 'not_applied' }, 'The prepared invocation was cancelled.');
}

function waitWithinBoundary<T>(actual: Promise<T>, context: ToolResourceOperationContext, now: () => number): Promise<T> {
  checkBoundary(context, now);
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); context.signal.removeEventListener('abort', onAbort); };
    const onAbort = () => {
      cleanup();
      try { checkBoundary(context, now); }
      catch (error) { reject(normalizeBoundaryError(error)); return; }
      reject(new ToolExecutionError({ code: 'TOOL_CANCELLED', category: 'cancelled', retryable: true, outcome: 'not_applied' }));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new ToolExecutionError({ code: 'TOOL_TIMEOUT', category: 'timeout', retryable: true, outcome: 'not_applied' }));
    }, Math.max(0, Date.parse(context.deadline) - now()));
    timer.unref?.();
    actual.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(normalizeBoundaryError(error)); });
    context.signal.addEventListener('abort', onAbort, { once: true });
    if (context.signal.aborted) onAbort();
  });
}

function normalizeBoundaryError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Tool resource boundary operation failed.');
}
