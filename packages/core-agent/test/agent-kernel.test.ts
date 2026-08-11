import { describe, expect, it, vi } from 'vitest';
import {
  AgentKernelError,
  JournalDrivenAgentKernel,
  type AgentKernelEffect,
  type AgentKernelPort,
  type AgentPendingRequest,
} from '../src/kernel/agent-kernel.js';
import type { AgentStateSignal } from '../src/kernel/agent-state-machine.js';
import type { KernelRunProjection } from '../src/kernel/run-controller.js';

describe('JournalDrivenAgentKernel', () => {
  it('drives the one state-based spine only through typed committed transitions', async () => {
    const calls: string[] = [];
    let current = projection('Preparing', 1);
    const port = portFixture({
      read: () => current,
      effect(kind, run) {
        calls.push(kind);
        current = nextForSimpleRun(run);
        return currentEffect(run, current);
      },
    });

    const result = await new JournalDrivenAgentKernel({ port }).advance('run-1');

    expect(result.state).toBe('Completed');
    expect(calls).toEqual(['prepare', 'model', 'model', 'finalize']);
  });

  it('has no implicit 64-transition limit when the Host supplies no resource boundary', async () => {
    let current = projection('Preparing', 1, { currentTurnId: 'turn-0' });
    let completedTurns = 0;
    const checkLimits = vi.fn(async () => null);
    const port = portFixture({
      read: () => current,
      checkLimits,
      effect(_kind, run) {
        const next = nextForLongRun(run, completedTurns);
        if (run.state === 'ApplyingObservations') completedTurns += 1;
        current = next;
        return currentEffect(run, next);
      },
    });

    const result = await new JournalDrivenAgentKernel({ port }).advance('run-1');

    expect(result.state).toBe('Completed');
    expect(result.revision).toBeGreaterThan(64);
    expect(checkLimits).not.toHaveBeenCalled();
  });

  it('consults only an explicit Host turn/time/cost boundary', async () => {
    const current = projection('Preparing', 4);
    const limit = projection('LimitReached', 5);
    const checkLimits = vi.fn(async () => effect(limit, { type: 'limit-reached' }));
    const port = portFixture({ read: () => current, checkLimits });
    const limits = { maxTurns: 20, deadlineAt: '2026-08-10T01:00:00.000Z', maxCostMicrounits: 50_000 };

    const result = await new JournalDrivenAgentKernel({ port }).advance('run-1', { limits });

    expect(result.state).toBe('LimitReached');
    expect(checkLimits).toHaveBeenCalledWith(current, limits);
  });

  it('rejects a port that tries to bypass the state machine', async () => {
    const current = projection('Preparing', 1);
    const port = portFixture({
      read: () => current,
      effect: () => effect(projection('Completed', 2), { type: 'context-ready' }),
    });

    await expect(new JournalDrivenAgentKernel({ port }).advance('run-1')).rejects.toMatchObject({
      code: 'KERNEL_PROJECTION_INVALID',
    });
  });

  it('persists no-progress from the committed evidence digest instead of any Run revision', async () => {
    const before = projection('ApplyingObservations', 8, {
      currentTurnId: 'turn-1', evidenceRevision: 3, evidenceDigest: 'same-evidence',
    });
    const afterObservation = projection('Preparing', 9, {
      currentTurnId: 'turn-1', evidenceRevision: 4, evidenceDigest: 'same-evidence',
    });
    const afterNoProgress = projection('Preparing', 10, {
      currentTurnId: 'turn-1', evidenceRevision: 4, evidenceDigest: 'same-evidence',
      noProgressCount: 1,
    });
    const recordNoProgress = vi.fn(async (_run, input) => {
      expect(input.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
      return effect(afterNoProgress, { type: 'no-progress-recorded' });
    });
    const port = portFixture({
      read: () => before,
      effect: () => effect(afterObservation, { type: 'turn-observed' }),
      recordNoProgress,
    });

    const result = await new JournalDrivenAgentKernel({ port }).advance('run-1');

    expect(result).toEqual(afterNoProgress);
    expect(recordNoProgress).toHaveBeenCalledTimes(1);
  });

  it('settles explicit cancellation through Cancelling before returning Cancelled', async () => {
    let current = projection('ReceivingModel', 5, { currentAttemptId: 'attempt-1' });
    const calls: string[] = [];
    const port = portFixture({
      read: () => current,
      async cancel(_input, run) {
        calls.push('request');
        current = projection('Cancelling', run.revision + 1, {
          currentTurnId: run.currentTurnId, currentAttemptId: run.currentAttemptId,
        });
        return effect(current, { type: 'cancel-requested' });
      },
      effect(kind, run) {
        calls.push(kind);
        current = projection('Cancelled', run.revision + 1);
        return effect(current, { type: 'cancellation-settled' });
      },
    });

    const result = await new JournalDrivenAgentKernel({ port }).cancel({
      runId: 'run-1', reason: 'operator cancelled',
    });

    expect(result.state).toBe('Cancelled');
    expect(calls).toEqual(['request', 'settle-cancellation']);
  });

  it('rejects cancellation ports that jump directly to a terminal state', async () => {
    const current = projection('CallingModel', 2);
    const port = portFixture({
      read: () => current,
      cancel: async () => effect(projection('Cancelled', 3), { type: 'cancel-requested' }),
    });

    await expect(new JournalDrivenAgentKernel({ port }).cancel({ runId: 'run-1' }))
      .rejects.toMatchObject({ code: 'KERNEL_PROJECTION_INVALID' });
  });

  it('opens existing Runs and exposes typed pending requests without advancing work', async () => {
    const current = projection('AwaitingUser', 7, { waitReason: 'approval' });
    const pending: readonly AgentPendingRequest[] = Object.freeze([Object.freeze({
      kind: 'approval', requestId: 'approval-1', invocationId: 'invocation-1',
    })]);
    const read = vi.fn(async () => current);
    const listPending = vi.fn(async () => pending);
    const port = portFixture({ read, listPending });
    const kernel = new JournalDrivenAgentKernel({ port });

    expect(await kernel.open('run-1')).toEqual(current);
    expect(await kernel.pending('run-1')).toEqual(pending);
    expect(read).toHaveBeenCalledTimes(2);
    expect(listPending).toHaveBeenCalledWith(current);
  });

  it('routes an approval decision through the persisted scheduler transition', async () => {
    const current = projection('AwaitingUser', 3, { waitReason: 'approval' });
    const next = projection('ExecutingTools', 4);
    const approve = vi.fn(async () => effect(next, {
      type: 'schedule-decided', decision: { state: 'ExecutingTools', invocationIds: ['i-1'] },
    }));
    const port = portFixture({ read: () => current, approve });
    const input = { runId: 'run-1', approvalId: 'approval-1', decision: 'approve' as const };

    expect(await new JournalDrivenAgentKernel({ port }).approve(input)).toEqual(next);
    expect(approve).toHaveBeenCalledWith(input, current);
  });

  it('queues manual compaction during model execution and starts it only at Preparing', async () => {
    const running = projection('ReceivingModel', 4, { currentAttemptId: 'attempt-1' });
    const queued = projection('ReceivingModel', 5, { currentAttemptId: 'attempt-1' });
    const requestWhileRunning = vi.fn(async (_input, _run, mode) => {
      expect(mode).toBe('queue');
      return effect(queued, { type: 'manual-compaction-queued' });
    });
    expect(await new JournalDrivenAgentKernel({
      port: portFixture({ read: () => running, requestManualCompaction: requestWhileRunning }),
    }).requestManualCompaction({ runId: 'run-1' })).toEqual(queued);

    const preparing = projection('Preparing', 8);
    const compacting = projection('Compacting', 9);
    const requestAtBoundary = vi.fn(async (_input, _run, mode) => {
      expect(mode).toBe('start');
      return effect(compacting, { type: 'context-compaction-required' });
    });
    expect(await new JournalDrivenAgentKernel({
      port: portFixture({ read: () => preparing, requestManualCompaction: requestAtBoundary }),
    }).requestManualCompaction({ runId: 'run-1' })).toEqual(compacting);
  });

  it('does not execute work while user input, interruption or terminal state is pending', async () => {
    for (const [state, waitReason] of [
      ['AwaitingUser', 'input_required'], ['Interrupted', null], ['Completed', null],
    ] as const) {
      const effectFn = vi.fn();
      const port = portFixture({
        read: () => projection(state, 4, { waitReason }),
        effect: effectFn,
      });
      expect((await new JournalDrivenAgentKernel({ port }).advance('run-1')).state).toBe(state);
      expect(effectFn).not.toHaveBeenCalled();
    }
  });

  it('fails deterministically when an effect commits no newer durable revision', async () => {
    const run = projection('Preparing', 1);
    const port = portFixture({
      read: () => run,
      effect: () => effect(run, { type: 'context-ready' }),
    });
    await expect(new JournalDrivenAgentKernel({ port }).advance('run-1')).rejects.toMatchObject({
      code: 'KERNEL_NO_PROGRESS',
    });
  });
});

type PortFixtureOptions = Readonly<{
  read?: () => KernelRunProjection | Promise<KernelRunProjection>;
  effect?: (kind: string, run: KernelRunProjection) => AgentKernelEffect;
  cancel?: AgentKernelPort['cancel'];
  approve?: AgentKernelPort['approve'];
  requestManualCompaction?: AgentKernelPort['requestManualCompaction'];
  recordNoProgress?: AgentKernelPort['recordNoProgress'];
  listPending?: AgentKernelPort['listPending'];
  checkLimits?: AgentKernelPort['checkLimits'];
}>;

function portFixture(options: PortFixtureOptions = {}): AgentKernelPort {
  const read = options.read ?? (() => projection('Completed', 1));
  const apply = (kind: string, run: KernelRunProjection): AgentKernelEffect => {
    if (options.effect !== undefined) return options.effect(kind, run);
    throw new Error(`Unexpected Kernel effect: ${kind}`);
  };
  return {
    async start() { return await read(); },
    async read() { return await read(); },
    async prepare(run) { return apply('prepare', run); },
    async callModel(run) { return apply('model', run); },
    async runTools(run) { return apply('tools', run); },
    async finalize(run) { return apply('finalize', run); },
    async settleCancellation(run) { return apply('settle-cancellation', run); },
    async steer(input, run) { return apply(`steer:${input.runId}`, run); },
    cancel: options.cancel ?? (async (_input, run) => apply('cancel-request', run)),
    async resume(input, run) { return apply(`resume:${input.runId}`, run); },
    approve: options.approve ?? (async (_input, run) => apply('approve', run)),
    requestManualCompaction: options.requestManualCompaction ??
      (async (_input, run) => apply('manual-compaction', run)),
    recordNoProgress: options.recordNoProgress ??
      (async (run) => apply('record-no-progress', run)),
    listPending: options.listPending ?? (async () => []),
    checkLimits: options.checkLimits ?? (async () => null),
  };
}

function nextForSimpleRun(run: KernelRunProjection): KernelRunProjection {
  switch (run.state) {
    case 'Preparing': return projection('CallingModel', run.revision + 1);
    case 'CallingModel': return projection('ReceivingModel', run.revision + 1, {
      currentAttemptId: 'attempt-1',
    });
    case 'ReceivingModel': return projection('Finalizing', run.revision + 1);
    case 'Finalizing': return projection('Completed', run.revision + 1, {
      finalContentRef: 'artifact:answer', deliveryStatus: 'not-required',
    });
    default: throw new Error(`Unexpected state ${run.state}`);
  }
}

function nextForLongRun(
  run: KernelRunProjection,
  completedTurns: number,
): KernelRunProjection {
  switch (run.state) {
    case 'Preparing':
      return projection('CallingModel', run.revision + 1, {
        currentTurnId: `turn-${completedTurns}`,
        evidenceRevision: run.evidenceRevision, evidenceDigest: run.evidenceDigest,
      });
    case 'CallingModel':
      return projection('ReceivingModel', run.revision + 1, {
        currentTurnId: run.currentTurnId, currentAttemptId: `attempt-${completedTurns}`,
        evidenceRevision: run.evidenceRevision, evidenceDigest: run.evidenceDigest,
      });
    case 'ReceivingModel':
      if (completedTurns >= 13) {
        return projection('Finalizing', run.revision + 1, {
          currentTurnId: run.currentTurnId,
          evidenceRevision: run.evidenceRevision, evidenceDigest: run.evidenceDigest,
        });
      }
      return projection('ResolvingActions', run.revision + 1, {
        currentTurnId: run.currentTurnId,
        evidenceRevision: run.evidenceRevision, evidenceDigest: run.evidenceDigest,
      });
    case 'ResolvingActions':
      return projection('ExecutingTools', run.revision + 1, {
        currentTurnId: run.currentTurnId,
        evidenceRevision: run.evidenceRevision, evidenceDigest: run.evidenceDigest,
      });
    case 'ExecutingTools':
      return projection('ApplyingObservations', run.revision + 1, {
        currentTurnId: run.currentTurnId,
        evidenceRevision: run.evidenceRevision, evidenceDigest: run.evidenceDigest,
      });
    case 'ApplyingObservations':
      return projection('Preparing', run.revision + 1, {
        currentTurnId: run.currentTurnId,
        evidenceRevision: run.evidenceRevision + 1,
        evidenceDigest: `evidence-${completedTurns + 1}`,
      });
    case 'Finalizing':
      return projection('Completed', run.revision + 1, {
        currentTurnId: run.currentTurnId,
        evidenceRevision: run.evidenceRevision, evidenceDigest: run.evidenceDigest,
        finalContentRef: 'artifact:answer', deliveryStatus: 'not-required',
      });
    default: throw new Error(`Unexpected state ${run.state}`);
  }
}

function currentEffect(
  previous: KernelRunProjection,
  next: KernelRunProjection,
): AgentKernelEffect {
  let signal: AgentStateSignal;
  switch (`${previous.state}->${next.state}`) {
    case 'Preparing->CallingModel': signal = { type: 'context-ready' }; break;
    case 'CallingModel->ReceivingModel': signal = { type: 'model-attempt-started' }; break;
    case 'ReceivingModel->ResolvingActions':
      signal = { type: 'model-attempt-committed', hasActions: true }; break;
    case 'ReceivingModel->Finalizing':
      signal = { type: 'model-attempt-committed', hasActions: false }; break;
    case 'ResolvingActions->ExecutingTools':
      signal = {
        type: 'schedule-decided', decision: { state: 'ExecutingTools', invocationIds: ['i'] },
      }; break;
    case 'ExecutingTools->ApplyingObservations':
      signal = {
        type: 'schedule-decided', decision: { state: 'ApplyingObservations', invocationIds: ['i'] },
      }; break;
    case 'ApplyingObservations->Preparing': signal = { type: 'turn-observed' }; break;
    case 'Finalizing->Completed': signal = { type: 'delivery-accepted' }; break;
    default: throw new Error(`Missing test transition ${previous.state}->${next.state}`);
  }
  return effect(next, signal);
}

function effect(run: KernelRunProjection, signal: AgentStateSignal): AgentKernelEffect {
  return Object.freeze({ run, signal });
}

function projection(
  state: KernelRunProjection['state'],
  revision: number,
  overrides: Partial<KernelRunProjection> = {},
): KernelRunProjection {
  return {
    schemaVersion: 1, projectId: 'project-1', sessionId: 'session-1', runId: 'run-1',
    state, revision, environmentBindingId: null, currentTurnId: null,
    turnSnapshotId: null, currentAttemptId: null, waitReason: null,
    evidenceRevision: 0, evidenceDigest: null, noProgressCount: 0,
    finalContentRef: null, deliveryStatus: null,
    updatedAt: '2026-08-10T00:00:00.000Z',
    ...overrides,
  };
}
