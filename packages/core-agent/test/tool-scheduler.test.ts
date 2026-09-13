import { describe, expect, it } from 'vitest';
import type {
  ScheduledToolInvocation,
  ToolInvocationScheduleState,
} from '../src/tools/tool-scheduler.js';

type RecoveryClass = 'read' | 'idempotent' | 'transactional' | 'non_idempotent';

function invocation(
  invocationId: string,
  actionOrdinal: number,
  recoveryClass: RecoveryClass,
  state: ToolInvocationScheduleState,
): ScheduledToolInvocation {
  const read = recoveryClass === 'read';
  return Object.freeze({
    invocationId,
    actionOrdinal,
    recoveryClass,
    access: read ? 'read' as const : 'write' as const,
    concurrency: read ? 'read' as const : 'write' as const,
    // Distinct resources make the read window deliberately parallelizable;
    // individual tests add a shared key when they exercise serialization.
    resourceKeys: [`fixture:${invocationId}`],
    state,
  });
}

async function scheduler() {
  return await import('../src/tools/tool-scheduler.js');
}

describe('decideSchedule', () => {
  it('runs an authorized read window before waiting for a later write approval', async () => {
    const { decideSchedule } = await scheduler();
    const invocations = Object.freeze([
      invocation('read-1', 0, 'read', 'authorized'),
      invocation('read-2', 1, 'read', 'authorized'),
      invocation('write-1', 2, 'non_idempotent', 'awaiting_approval'),
      invocation('read-after-write', 3, 'read', 'authorized'),
    ]);

    expect(decideSchedule({ invocations, maxConcurrency: 4 })).toEqual({
      state: 'ExecutingTools',
      invocationIds: ['read-1', 'read-2'],
    });
  });

  it('never lets a later read leap over an unresolved write or external barrier', async () => {
    const { decideSchedule } = await scheduler();
    const invocations = [
      invocation('write-1', 0, 'transactional', 'awaiting_approval'),
      invocation('read-1', 1, 'read', 'authorized'),
      invocation('external-1', 2, 'idempotent', 'authorized'),
      invocation('read-2', 3, 'read', 'authorized'),
    ];

    expect(decideSchedule({ invocations, maxConcurrency: 8 })).toEqual({
      state: 'AwaitingUser',
      reason: 'approval',
      invocationIds: ['write-1'],
    });
  });

  it('enforces bounded parallelism without changing model order', async () => {
    const { decideSchedule } = await scheduler();
    const invocations = Array.from({ length: 7 }, (_, index) =>
      invocation(`read-${index}`, index, 'read', 'authorized'));

    expect(decideSchedule({ invocations, maxConcurrency: 3 })).toEqual({
      state: 'ExecutingTools',
      invocationIds: ['read-0', 'read-1', 'read-2'],
    });
  });

  it('keeps a running eligible window authoritative before dispatching more work', async () => {
    const { decideSchedule } = await scheduler();
    const invocations = [
      invocation('read-running', 0, 'read', 'started'),
      invocation('read-ready', 1, 'read', 'authorized'),
      invocation('write-after', 2, 'non_idempotent', 'authorized'),
    ];

    expect(decideSchedule({ invocations, maxConcurrency: 2 })).toEqual({
      state: 'ExecutingTools',
      invocationIds: ['read-running'],
    });
  });

  it('applies terminal observations in model order even when handlers finish out of order', async () => {
    const { decideSchedule } = await scheduler();
    const invocations = [
      invocation('read-0', 0, 'read', 'succeeded'),
      invocation('read-1', 1, 'read', 'failed'),
      invocation('read-2', 2, 'read', 'cancelled'),
      invocation('write-after', 3, 'non_idempotent', 'authorized'),
    ];

    expect(decideSchedule({ invocations, maxConcurrency: 3 })).toEqual({
      state: 'ApplyingObservations',
      invocationIds: ['read-0', 'read-1', 'read-2'],
    });
  });

  it('converges an all-denied read window to observations without executing a handler', async () => {
    const { decideSchedule } = await scheduler();
    const invocations = [
      invocation('denied-0', 0, 'read', 'denied'),
      invocation('denied-1', 1, 'read', 'denied'),
    ];

    expect(decideSchedule({ invocations, maxConcurrency: 2 })).toEqual({
      state: 'ApplyingObservations',
      invocationIds: ['denied-0', 'denied-1'],
    });
  });

  it('resolves proposed work before asking for a later approval in the same read window', async () => {
    const { decideSchedule } = await scheduler();
    const invocations = [
      invocation('read-proposed', 0, 'read', 'proposed'),
      invocation('read-waiting', 1, 'read', 'awaiting_approval'),
    ];

    expect(decideSchedule({ invocations, maxConcurrency: 2 })).toEqual({
      state: 'ResolvingActions',
      invocationIds: ['read-proposed'],
    });
  });

  it('resolves the entire eligible read window before dispatching any authorized peer', async () => {
    const { decideSchedule } = await scheduler();
    expect(decideSchedule({
      invocations: [
        invocation('read-authorized', 0, 'read', 'authorized'),
        invocation('read-proposed', 1, 'read', 'proposed'),
      ],
      maxConcurrency: 2,
    })).toEqual({ state: 'ResolvingActions', invocationIds: ['read-proposed'] });
  });

  it('does not let a later authorized read cross an earlier pending approval', async () => {
    const { decideSchedule } = await scheduler();
    expect(decideSchedule({
      invocations: [
        invocation('read-waiting', 0, 'read', 'awaiting_approval'),
        invocation('read-after', 1, 'read', 'authorized'),
      ],
      maxConcurrency: 2,
    })).toEqual({
      state: 'AwaitingUser', reason: 'approval', invocationIds: ['read-waiting'],
    });
  });

  it('runs only authorized reads before the first pending approval', async () => {
    const { decideSchedule } = await scheduler();
    expect(decideSchedule({
      invocations: [
        invocation('read-before', 0, 'read', 'authorized'),
        invocation('read-waiting', 1, 'read', 'awaiting_approval'),
        invocation('read-after', 2, 'read', 'authorized'),
      ],
      maxConcurrency: 3,
    })).toEqual({ state: 'ExecutingTools', invocationIds: ['read-before'] });
  });

  it('closes only after every invocation has its committed observation', async () => {
    const { decideSchedule } = await scheduler();
    expect(decideSchedule({
      invocations: [
        invocation('read-1', 0, 'read', 'observed'),
        invocation('write-1', 1, 'non_idempotent', 'observed'),
      ],
      maxConcurrency: 2,
    })).toEqual({ state: 'TurnReadyToClose', invocationIds: [] });
  });

  it('rejects duplicate ordinals and invalid concurrency without mutating the snapshot', async () => {
    const { decideSchedule, ToolScheduleError } = await scheduler();
    const duplicate = Object.freeze([
      invocation('read-a', 0, 'read', 'authorized'),
      invocation('read-b', 0, 'read', 'authorized'),
    ]);
    const before = structuredClone(duplicate);

    expect(() => decideSchedule({ invocations: duplicate, maxConcurrency: 2 }))
      .toThrow(ToolScheduleError);
    expect(duplicate).toEqual(before);
    expect(() => decideSchedule({ invocations: [], maxConcurrency: 0 }))
      .toThrow(ToolScheduleError);
  });
});
