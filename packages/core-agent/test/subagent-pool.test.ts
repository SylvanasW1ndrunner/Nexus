import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentSessionStore,
  AgentSubagentPool,
  createAgentSession,
  type AgentRunResult,
} from '../src/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('AgentSubagentPool persistence and cancellation', () => {
  it('restores completed parent-child records from AgentSessionStore after rebuilding the pool', async () => {
    const store = new AgentSessionStore(await sessionPath());
    const first = new AgentSubagentPool(
      (options) => Promise.resolve(runResult('done', options.userMessage, 'child-session')),
      {
        store,
        createId: () => 'subagent-persisted',
        now: timestampSequence(),
      },
    );

    const spawned = await first.spawn(spawnInput());
    await expect(first.wait(spawned.id)).resolves.toMatchObject({
      id: 'subagent-persisted',
      parentSessionId: 'parent-session',
      childSessionId: 'child-session',
      task: 'Inspect the orders schema',
      status: 'completed',
      summary: 'Inspect the orders schema',
    });

    const rebuilt = new AgentSubagentPool(
      () => Promise.reject(new Error('Recovered records must not be rerun.')),
      { store },
    );

    expect(rebuilt.get('subagent-persisted')).toMatchObject({
      parentSessionId: 'parent-session',
      childSessionId: 'child-session',
      status: 'completed',
    });
    expect(rebuilt.list('parent-session')).toEqual([
      expect.objectContaining({
        id: 'subagent-persisted',
        task: 'Inspect the orders schema',
        status: 'completed',
      }),
    ]);
  });

  it('turns an orphaned running record into one stable failed terminal state on recovery', async () => {
    const store = new AgentSessionStore(await sessionPath());
    const never = new Promise<AgentRunResult>(() => undefined);
    const first = new AgentSubagentPool(() => never, {
      store,
      createId: () => 'subagent-interrupted',
      now: () => '2026-07-26T00:00:00.000Z',
    });
    await first.spawn(spawnInput());

    const rebuilt = new AgentSubagentPool(() => never, {
      store,
      now: () => '2026-07-26T00:01:00.000Z',
    });
    expect(rebuilt.get('subagent-interrupted')).toMatchObject({
      status: 'failed',
      errorMessage: 'Child Agent was interrupted by a runtime restart.',
      updatedAt: '2026-07-26T00:01:00.000Z',
    });

    const rebuiltAgain = new AgentSubagentPool(() => never, {
      store,
      now: () => '2026-07-26T00:02:00.000Z',
    });
    expect(rebuiltAgain.get('subagent-interrupted')).toMatchObject({
      status: 'failed',
      errorMessage: 'Child Agent was interrupted by a runtime restart.',
      updatedAt: '2026-07-26T00:01:00.000Z',
    });
  });

  it('propagates the parent signal and never invokes a child whose parent was already cancelled', async () => {
    const parent = new AbortController();
    const runner = vi.fn(() => Promise.resolve(runResult('done', 'should not run')));
    parent.abort(new Error('parent stopped'));
    const pool = new AgentSubagentPool(runner, {
      createId: () => 'subagent-pre-aborted',
      now: () => '2026-07-26T00:00:00.000Z',
    });

    const record = await pool.spawn({
      ...spawnInput(),
      options: {
        ...spawnInput().options,
        signal: parent.signal,
      },
    });

    expect(record.status).toBe('cancelled');
    expect(runner).not.toHaveBeenCalled();
    await expect(pool.wait(record.id)).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('aborts a running child when the parent stops and keeps stop/wait terminal updates idempotent', async () => {
    const store = new AgentSessionStore(await sessionPath());
    const parent = new AbortController();
    let observedSignal: AbortSignal | undefined;
    let workAfterCancellation = 0;
    const pool = new AgentSubagentPool(
      async (options) => {
        observedSignal = options.signal;
        const signal = options.signal;
        if (!signal) throw new Error('Child signal is required.');
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        if (signal.aborted) throw new Error('child aborted');
        workAfterCancellation += 1;
        return runResult('done', 'unexpected completion');
      },
      {
        store,
        createId: () => 'subagent-parent-cancelled',
        now: timestampSequence(),
      },
    );
    const spawned = await pool.spawn({
      ...spawnInput(),
      options: {
        ...spawnInput().options,
        signal: parent.signal,
      },
    });

    parent.abort(new Error('parent stopped'));
    expect(observedSignal?.aborted).toBe(true);
    expect(pool.stop(spawned.id)).toBe(false);
    const [firstWait, secondWait] = await Promise.all([
      pool.wait(spawned.id),
      pool.wait(spawned.id),
    ]);
    expect(firstWait).toMatchObject({ status: 'cancelled' });
    expect(secondWait).toEqual(firstWait);
    expect(workAfterCancellation).toBe(0);

    const recovered = new AgentSubagentPool(
      () => Promise.reject(new Error('Cancelled children must not be rerun.')),
      { store },
    );
    expect(recovered.get(spawned.id)).toEqual(firstWait);
  });

  it('waits for a cancelled child runner to finish its cleanup before resolving', async () => {
    let releaseCleanup: (() => void) | undefined;
    const cleanupBarrier = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let cleanupFinished = false;
    const pool = new AgentSubagentPool(
      async (options) => {
        const signal = options.signal;
        if (!signal) throw new Error('Child signal is required.');
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        await cleanupBarrier;
        cleanupFinished = true;
        throw new Error('child aborted after cleanup');
      },
      {
        createId: () => 'subagent-cleanup',
        now: timestampSequence(),
      },
    );
    const spawned = await pool.spawn(spawnInput());

    expect(pool.stop(spawned.id)).toBe(true);
    let waitResolved = false;
    const waiting = pool.wait(spawned.id).then((record) => {
      waitResolved = true;
      return record;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(waitResolved).toBe(false);
    releaseCleanup?.();
    await expect(waiting).resolves.toMatchObject({ status: 'cancelled' });
    expect(cleanupFinished).toBe(true);
  });

  it('serializes concurrent spawn admission and exposes one idempotent cancellation terminal state', async () => {
    let id = 0;
    const pool = new AgentSubagentPool(
      (options) =>
        new Promise<AgentRunResult>((resolve) => {
          options.signal?.addEventListener(
            'abort',
            () => resolve(runResult('aborted', 'cancelled')),
            { once: true },
          );
        }),
      {
      maxConcurrent: 1,
      createId: () => `subagent-concurrent-${id++}`,
      now: timestampSequence(),
      },
    );

    const attempts = await Promise.allSettled([
      pool.spawn(spawnInput()),
      pool.spawn({
        ...spawnInput(),
        task: 'Inspect the customers schema',
      }),
    ]);
    const accepted = attempts.find(
      (attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof pool.spawn>>> =>
        attempt.status === 'fulfilled',
    );
    const rejected = attempts.find((attempt) => attempt.status === 'rejected');
    expect(accepted?.value.status).toBe('running');
    expect(rejected).toMatchObject({ status: 'rejected' });

    const childId = accepted?.value.id;
    if (!childId) throw new Error('Expected one admitted child.');
    expect(pool.stop(childId)).toBe(true);
    expect(pool.stop(childId)).toBe(false);
    const records = await Promise.all([pool.wait(childId), pool.wait(childId)]);
    expect(records[0]).toEqual(records[1]);
    expect(records[0].status).toBe('cancelled');
  });
});

function spawnInput() {
  return {
    parentSessionId: 'parent-session',
    task: 'Inspect the orders schema',
    options: {
      providerId: 'test',
      model: 'test',
      userMessage: 'Inspect the orders schema',
      mode: 'read' as const,
    },
  };
}

function runResult(
  status: AgentRunResult['status'],
  finalText: string,
  sessionId = `child-${status}`,
): AgentRunResult {
  return {
    runId: `run-${sessionId}`,
    status,
    session: createAgentSession({
      id: sessionId,
      title: 'Child',
      mode: 'read',
      now: () => '2026-07-26T00:00:00.000Z',
    }),
    finalText,
    iterations: 1,
    toolExecutions: [],
  };
}

function timestampSequence(): () => string {
  let second = 0;
  return () => `2026-07-26T00:00:0${second++}.000Z`;
}

async function sessionPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'schemanaut-subagents-'));
  temporaryDirectories.push(directory);
  return join(directory, 'nested', 'agent-sessions.db');
}
