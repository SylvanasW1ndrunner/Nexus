import { describe, expect, expectTypeOf, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PortableValue } from '@dbagent/shared';
import {
  JournalAgentSubagentRuntime,
  JournalAgentSubagentScheduler,
  deriveChildAgentIdentity,
  type AgentSubagentObservation,
} from '../src/subagent-pool.js';
import type { JournalAgentSubagentRuntime as PublicJournalAgentSubagentRuntime } from '../src/index.js';
import type { CreateRunCommand, CreateRunResult } from '../src/events/agent-journal.js';
import type { AgentJournal } from '../src/events/agent-journal.js';
import type { KernelRunProjection } from '../src/kernel/run-controller.js';
import type {
  CancelRunInput,
  SteerRunInput,
} from '../src/kernel/agent-kernel.js';
import type {
  RuntimeCommand,
  RuntimeCommandApplicationResult,
} from '../src/kernel/runtime-command.js';
import type * as PublicExports from '../src/index.js';
import { createRuntimeCommandIssuer } from '../src/internal/runtime-command-authority.js';
import { bindSubagentOutcomeCommitter } from '../src/internal/subagent-outcome-authority.js';
import { SqliteAgentJournal } from '../src/events/sqlite-agent-journal.js';

describe('JournalAgentSubagentRuntime', () => {
  it('takes the Journal directly and exposes no compatibility options object', () => {
    type PublicJournal = ConstructorParameters<typeof PublicJournalAgentSubagentRuntime>[0];
    type BoundOutcomeCommitter = Parameters<typeof bindSubagentOutcomeCommitter>[1];
    expectTypeOf<PublicJournal>().toHaveProperty('createRun');
    expectTypeOf<PublicJournal>().not.toHaveProperty('kernel');
    expectTypeOf<typeof PublicExports>().not.toHaveProperty('JournalAgentSubagentRuntimeOptions');
    expectTypeOf<BoundOutcomeCommitter>().toHaveProperty('commitFresh');
    expectTypeOf<BoundOutcomeCommitter>().toHaveProperty('commitRecovery');
    expectTypeOf<BoundOutcomeCommitter>().not.toBeFunction();
  });

  it('creates a durable child and returns immediately without advancing it', async () => {
    const identity = childIdentity();
    const journal = new FakeChildJournal();
    const kernel = new FakeChildKernel(journal);
    const runtime = new JournalAgentSubagentRuntime(journal);

    const observation = await runtime.execute(
      childStartCommand(identity, { task: 'Inspect asynchronously', context: null }),
      application(identity),
    );

    expect(journal.insertedRunCount).toBe(1);
    expect(kernel.advanced).toEqual([]);
    expect(observation).toMatchObject({
      childRunId: identity.childRunId,
      childSessionId: identity.childSessionId,
      status: 'running',
    });
  });

  it('persists root ancestry across a real SQLite Journal reopen', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nexus-subagent-tree-'));
    try {
      const filePath = join(directory, 'agent.db');
      const first = new SqliteAgentJournal({ filePath });
      const root = await first.createRun({
        projectId: 'project-tree', sessionId: 'session-root',
        clientRequestId: 'root-request', input: 'root',
      });
      expect(await first.getRunAncestry(root.runId)).toEqual({
        projectId: 'project-tree', runId: root.runId, parentRunId: null,
        rootRunId: root.runId, depth: 0, rootChildOrdinal: 0,
      });
      const reopened = new SqliteAgentJournal({ filePath });
      expect(await reopened.getRunAncestry(root.runId)).toEqual({
        projectId: 'project-tree', runId: root.runId, parentRunId: null,
        rootRunId: root.runId, depth: 0, rootChildOrdinal: 0,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('creates an independent child Run on the same Kernel with durable parent causality', async () => {
    const identity = deriveChildAgentIdentity({
      projectId: 'project-1',
      parentRunId: 'run-parent',
      parentTurnId: 'turn-parent',
      parentInvocationId: 'invocation-parent',
      commandId: 'command-child.start',
    });
    const journal = new FakeChildJournal();
    const kernel = new FakeChildKernel(journal);
    const runtime = new JournalAgentSubagentRuntime(journal);

    const observation = await runtime.execute(
      childStartCommand(identity, {
        task: 'Inspect the storage boundary',
        context: { files: ['src/storage.ts'] },
      }),
      application(identity),
    );

    expect(journal.created).toHaveLength(1);
    expect(journal.created[0]).toEqual({
      projectId: 'project-1',
      sessionId: identity.childSessionId,
      runId: identity.childRunId,
      clientRequestId: `subagent:${identity.childRunId}`,
      input: {
        task: 'Inspect the storage boundary',
        context: { files: ['src/storage.ts'] },
      },
      parent: {
        runId: 'run-parent',
        turnId: 'turn-parent',
        invocationId: 'invocation-parent',
      },
    });
    expect(identity.childSessionId).not.toBe('session-parent');
    expect(kernel.advanced).toEqual([]);
    expect(observation).toEqual(expectedObservation(identity, 'running'));
  });

  it('does not copy a parent one-time approval into the child Run', async () => {
    const identity = childIdentity();
    const journal = new FakeChildJournal();
    const runtime = new JournalAgentSubagentRuntime(journal);

    await runtime.execute(
      childStartCommand(identity, {
        task: 'Write an artifact',
        context: { requestedPath: 'report.md' },
      }),
      application(identity),
    );

    const created = journal.created[0] as CreateRunCommand & Record<string, unknown>;
    expect(created).not.toHaveProperty('approvalId');
    expect(created).not.toHaveProperty('authorization');
    expect(created.input).toEqual({
      task: 'Write an artifact',
      context: { requestedPath: 'report.md' },
    });
  });

  it('idempotently recreates only the durable child intent after restart', async () => {
    const identity = childIdentity();
    const journal = new FakeChildJournal();
    const kernel = new FakeChildKernel(journal);
    const command = childStartCommand(identity, {
      task: 'Recover the child',
      context: null,
    });
    const committed = application(identity);

    const firstRuntime = new JournalAgentSubagentRuntime(journal);
    const first = await firstRuntime.execute(command, committed);
    const secondRuntime = new JournalAgentSubagentRuntime(journal);
    const second = await secondRuntime.execute(command, committed);

    expect(journal.created).toHaveLength(2);
    expect(journal.insertedRunCount).toBe(1);
    expect(kernel.advanced).toEqual([]);
    expect(second).toEqual(first);
    expect(second).toEqual(expectedObservation(identity, 'running'));
  });

  it('recovers a durable non-terminal child without creating another child identity', async () => {
    const identity = childIdentity();
    const journal = new FakeChildJournal();
    const kernel = new FakeChildKernel(journal);
    const command = childStartCommand(identity, { task: 'Resume exactly once', context: null });
    await new JournalAgentSubagentRuntime(journal).execute(command, application(identity));
    const settled: string[] = [];

    const recovered = new JournalAgentSubagentScheduler({ journal });
    recovered.recover({
      projectId: 'project-1', childSessionId: identity.childSessionId,
      childRunId: identity.childRunId, kernel,
      onSettled: () => { settled.push(identity.childRunId); },
    });
    // A second Runtime recovery observes the same durable identity, not a new task.
    recovered.recover({
      projectId: 'project-1', childSessionId: identity.childSessionId,
      childRunId: identity.childRunId, kernel,
    });
    await recovered.close();

    expect(journal.created).toHaveLength(1);
    expect(kernel.advanced).toEqual([identity.childRunId]);
    expect(settled).toEqual([identity.childRunId]);
  });

  it('reconciles the original child.start outcome after recovery without creating another child', async () => {
    const identity = childIdentity();
    const journal = new FakeChildJournal();
    const kernel = new FakeChildKernel(journal);
    const command = childStartCommand(identity, { task: 'Recover parent outcome', context: null });
    const facts: string[] = [];
    const commit = (_identity: unknown, observation: AgentSubagentObservation) => {
      facts.push(observation.childRunId);
      return Promise.resolve({
        eventId: 'outcome-recovered', projectId: 'project-1', sequence: 2, schemaVersion: 1,
        sessionId: 'session-parent', runId: 'run-parent', turnId: 'turn-parent',
        invocationId: 'invocation-parent', type: 'subagent.completed' as const,
        occurredAt: '2026-08-08T00:00:01.000Z',
        payload: { subagentId: observation.childRunId, summary: observation.summary, refs: [] },
      });
    };
    bindSubagentOutcomeCommitter(journal as unknown as AgentJournal, {
      commitFresh: commit,
      commitRecovery: commit,
    });
    await new JournalAgentSubagentRuntime(journal).execute(command, application(identity));

    const scheduler = new JournalAgentSubagentScheduler({ journal });
    scheduler.recover({
      projectId: 'project-1', childSessionId: identity.childSessionId,
      childRunId: identity.childRunId, kernel, recovery: recoveryIdentity(identity, command),
    });
    await scheduler.close();

    expect(journal.created).toHaveLength(1);
    expect(kernel.advanced).toEqual([identity.childRunId]);
    expect(facts).toEqual([identity.childRunId]);
  });

  it('propagates parent cancellation through the scheduler without holding the Tool command', async () => {
    const identity = childIdentity();
    const journal = new FakeChildJournal();
    const kernel = new FakeChildKernel(journal, { blockUntilCancelled: true });
    const runtime = new JournalAgentSubagentRuntime(journal);
    const parent = new AbortController();

    const command = childStartCommand(identity, { task: 'Long investigation', context: null });
    await runtime.execute(command, application(identity));
    const scheduler = new JournalAgentSubagentScheduler({ journal });
    scheduler.schedule(command, application(identity), kernel, { signal: parent.signal });
    await kernel.advanceStarted;
    parent.abort('parent cancelled');

    await scheduler.close();
    expect(kernel.cancelled).toEqual([{
      runId: identity.childRunId,
      reason: 'parent cancelled',
    }]);
  });

  it('cancels a durable queued child before closing the scheduler', async () => {
    const firstIdentity = childIdentity();
    const secondIdentity = deriveChildAgentIdentity({
      projectId: 'project-1', parentRunId: 'run-parent', parentTurnId: 'turn-parent',
      parentInvocationId: 'invocation-parent', commandId: 'command-child.second',
    });
    const journal = new FakeChildJournal();
    const kernel = new FakeChildKernel(journal, { blockUntilCancelled: true });
    const firstCommand = childStartCommand(firstIdentity, { task: 'First child', context: null });
    const secondCommand = {
      ...childStartCommand(secondIdentity, { task: 'Queued child', context: null }),
      commandId: 'command-child.second',
    } as Extract<RuntimeCommand, { kind: 'child.start' }>;
    const runtime = new JournalAgentSubagentRuntime(journal);
    await runtime.execute(firstCommand, application(firstIdentity));
    await runtime.execute(secondCommand, application(secondIdentity, secondCommand.commandId));
    const scheduler = new JournalAgentSubagentScheduler({ journal, maxConcurrentChildren: 1 });
    scheduler.schedule(firstCommand, application(firstIdentity), kernel);
    await kernel.advanceStarted;
    scheduler.schedule(secondCommand, application(secondIdentity, secondCommand.commandId), kernel);

    await scheduler.close();

    expect(kernel.cancelled.map((input) => input.runId)).toEqual(expect.arrayContaining([
      secondIdentity.childRunId,
      firstIdentity.childRunId,
    ]));
    expect((await journal.getRunProjection(secondIdentity.childRunId))?.state).toBe('Cancelled');
  });

  it('bounds non-cooperative close and persists a queryable interruption', async () => {
    const identity = childIdentity();
    const journal = new FakeChildJournal();
    const kernel = new FakeChildKernel(journal, { blockCancel: true });
    const command = childStartCommand(identity, { task: 'Non-cooperative child', context: null });
    await new JournalAgentSubagentRuntime(journal).execute(command, application(identity));
    const scheduler = new JournalAgentSubagentScheduler({ journal, closeTimeoutMs: 10 });
    scheduler.schedule(command, application(identity), kernel);
    await kernel.advanceStarted;

    await expect(Promise.race([
      scheduler.close().then(() => 'closed', () => 'failed'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 250)),
    ])).resolves.toBe('failed');
    expect(kernel.interrupted).toEqual([{
      runId: identity.childRunId,
      code: 'SUBAGENT_SCHEDULER_CLOSE_TIMEOUT',
      detail: { category: 'subagent-scheduler-close', reason: 'close-timeout' },
    }]);
    expect((await journal.getRunProjection(identity.childRunId))?.state).toBe('Interrupted');
  });

  it('persists child cancellation and parent outcome when a live driver fails', async () => {
    const identity = childIdentity();
    const journal = new FakeChildJournal();
    const kernel = new FakeChildKernel(journal, { throwOnAdvance: true });
    const command = createRuntimeCommandIssuer().issue(childStartCommand(identity, {
      task: 'Fail safely', context: null,
    })) as Extract<RuntimeCommand, { kind: 'child.start' }>;
    const outcomes: string[] = [];
    const commit = (_identity: unknown, observation: AgentSubagentObservation) => {
      outcomes.push(observation.status);
      return Promise.resolve({
        eventId: 'failed-driver-outcome', projectId: 'project-1', sequence: 2, schemaVersion: 1,
        sessionId: 'session-parent', runId: 'run-parent', turnId: 'turn-parent',
        invocationId: 'invocation-parent', type: 'subagent.cancelled' as const,
        occurredAt: '2026-08-08T00:00:01.000Z',
        payload: { subagentId: identity.childRunId, reason: observation.summary },
      });
    };
    bindSubagentOutcomeCommitter(journal as unknown as AgentJournal, {
      commitFresh: commit,
      commitRecovery: commit,
    });
    await new JournalAgentSubagentRuntime(journal).execute(command, application(identity));
    const scheduler = new JournalAgentSubagentScheduler({ journal });
    scheduler.schedule(command, application(identity), kernel);
    await scheduler.close();

    const interruption = kernel.interrupted.find((item) =>
      item.runId === identity.childRunId && item.code === 'SUBAGENT_SCHEDULER_FAILED');
    expect(interruption).toBeDefined();
    expect(JSON.stringify(interruption?.detail)).toContain('subagent-scheduler');
    expect(outcomes).toEqual(['interrupted']);
  });

  it('enforces durable ancestry depth before the first child turn', async () => {
    const identity = childIdentity();
    const journal = new FakeChildJournal();
    journal.ancestryDepth = 2;
    const kernel = new FakeChildKernel(journal);
    const command = childStartCommand(identity, { task: 'Too deep', context: null });
    await new JournalAgentSubagentRuntime(journal).execute(command, application(identity));
    const scheduler = new JournalAgentSubagentScheduler({ journal, maxDepth: 1 });
    scheduler.schedule(command, application(identity), kernel);
    await scheduler.close();

    expect(kernel.advanceOptions).toEqual([{ limits: { maxTurns: 0 } }]);
  });

  it('cancels every durable descendant before the selected child', async () => {
    const identity = childIdentity();
    const journal = new FakeChildJournal();
    journal.descendants = [
      { projectId: 'project-1', runId: 'child-grandchild', parentRunId: identity.childRunId, rootRunId: 'run-parent', depth: 2, rootChildOrdinal: 1 },
      { projectId: 'project-1', runId: identity.childRunId, parentRunId: 'run-parent', rootRunId: 'run-parent', depth: 1, rootChildOrdinal: 1 },
    ];
    const kernel = new FakeChildKernel(journal);
    await journal.createRun({ projectId: 'project-1', sessionId: identity.childSessionId, runId: identity.childRunId, clientRequestId: `subagent:${identity.childRunId}`, input: null });
    journal.runs.set('child-grandchild', projection({ runId: 'child-grandchild', projectId: 'project-1', sessionId: 'child-grandchild-session', state: 'created' }));
    const scheduler = new JournalAgentSubagentScheduler({ journal });
    scheduler.schedule(childCommand('child.cancel', identity, {
      childRunId: identity.childRunId, expectedChildRevision: 1, reason: 'stop tree',
    }), application(identity), kernel);
    await scheduler.close();

    expect(kernel.cancelled.map((input) => input.runId)).toEqual(['child-grandchild', identity.childRunId]);
  });

  it('cancels a child handle subtree by its durable root ancestry', async () => {
    const identity = childIdentity();
    const journal = new FakeChildJournal();
    journal.descendants = [
      { projectId: 'project-1', runId: identity.childRunId, parentRunId: 'run-parent', rootRunId: 'run-parent', depth: 1, rootChildOrdinal: 1 },
      { projectId: 'project-1', runId: 'child-grandchild', parentRunId: identity.childRunId, rootRunId: 'run-parent', depth: 2, rootChildOrdinal: 1 },
    ];
    await journal.createRun({ projectId: 'project-1', sessionId: identity.childSessionId, runId: identity.childRunId, clientRequestId: `subagent:${identity.childRunId}`, input: null });
    journal.runs.set('child-grandchild', projection({ runId: 'child-grandchild', projectId: 'project-1', sessionId: 'child-grandchild-session', state: 'created' }));
    const kernel = new FakeChildKernel(journal);

    await new JournalAgentSubagentScheduler({ journal }).cancelDescendants({
      projectId: 'project-1', rootRunId: identity.childRunId, reason: 'child handle cancel', kernel,
    });

    expect(kernel.cancelled.map((input) => input.runId)).toEqual(['child-grandchild']);
  });

  it('uses the supplied root Kernel when a child-only resolver is configured', async () => {
    const journal = new FakeChildJournal();
    journal.runs.set('run-root', projection({
      runId: 'run-root', projectId: 'project-1', sessionId: 'session-root', state: 'created',
    }));
    const kernel = new FakeChildKernel(journal);
    const resolved: string[] = [];
    const scheduler = new JournalAgentSubagentScheduler({
      journal,
      resolveKernel: (runId) => {
        resolved.push(runId);
        return Promise.reject(new Error('Only descendant Runs may use the child resolver.'));
      },
    });

    const cancelled = await scheduler.cancelTree({
      projectId: 'project-1', rootRunId: 'run-root', reason: 'stop root', kernel,
    });

    expect(cancelled.state).toBe('Cancelled');
    expect(kernel.cancelled).toEqual([{ runId: 'run-root', reason: 'stop root' }]);
    expect(resolved).toEqual([]);
  });

  it('scheduler routes child.steer and child.cancel to the same child Kernel Run', async () => {
    const identity = childIdentity();
    const journal = new FakeChildJournal();
    const kernel = new FakeChildKernel(journal);
    await journal.createRun({
      projectId: 'project-1',
      sessionId: identity.childSessionId,
      runId: identity.childRunId,
      clientRequestId: `subagent:${identity.childRunId}`,
      input: null,
    });

    const steer = childCommand('child.steer', identity, {
        childRunId: identity.childRunId,
        expectedChildRevision: 1,
        input: { message: 'Also inspect tests.' },
      });
    const cancel = childCommand('child.cancel', identity, {
        childRunId: identity.childRunId,
        expectedChildRevision: 2,
        reason: 'No longer needed',
      });
    const scheduler = new JournalAgentSubagentScheduler({ journal });
    scheduler.schedule(steer, application(identity), kernel);
    await scheduler.close();
    const cancellingScheduler = new JournalAgentSubagentScheduler({ journal });
    cancellingScheduler.schedule(cancel, application(identity), kernel);
    await cancellingScheduler.close();

    expect(kernel.steered).toEqual([{
      runId: identity.childRunId,
      clientRequestId: 'subagent-steer:command-child.steer',
      input: { message: 'Also inspect tests.' },
    }]);
    expect(kernel.cancelled).toContainEqual({
      runId: identity.childRunId,
      reason: 'No longer needed',
    });
  });

  it('returns exactly one bounded structured parent Observation and no child transcript', async () => {
    const identity = childIdentity();
    const journal = new FakeChildJournal();
    const runtime = new JournalAgentSubagentRuntime(journal);

    const result = await runtime.execute(
      childStartCommand(identity, {
        task: 'Summarize one subsystem',
        context: { privateTranscript: ['never copy this'] },
      }),
      application(identity),
    );

    expect(result).toEqual(expectedObservation(identity, 'running'));
    expect(JSON.stringify(result)).not.toContain('privateTranscript');
    expect(JSON.stringify(result)).not.toContain('never copy this');
  });

  it('commits exactly one typed parent terminal fact when child.start is replayed', async () => {
    const identity = childIdentity();
    const journal = new FakeChildJournal();
    const kernel = new FakeChildKernel(journal);
    const runtime = new JournalAgentSubagentRuntime(journal);
    const command = createRuntimeCommandIssuer().issue(childStartCommand(identity, {
      task: 'Finish once',
      context: null,
    })) as Extract<RuntimeCommand, { kind: 'child.start' }>;
    const facts: Array<{ type: 'subagent.completed'; subagentId: string }> = [];
    const commit = (_identity: unknown, observation: AgentSubagentObservation) => {
      if (!facts.some((fact) => fact.subagentId === observation.childRunId)) {
        facts.push({ type: 'subagent.completed', subagentId: observation.childRunId });
      }
      return Promise.resolve({
        eventId: 'subagent-terminal',
        projectId: 'project-1',
        sequence: 2,
        schemaVersion: 1,
        sessionId: 'session-parent',
        runId: 'run-parent',
        turnId: 'turn-parent',
        invocationId: 'invocation-parent',
        type: 'subagent.completed' as const,
        occurredAt: '2026-08-08T00:00:01.000Z',
        payload: {
          subagentId: observation.childRunId,
          summary: observation.summary,
          refs: [...observation.evidenceRefs],
        },
      });
    };
    bindSubagentOutcomeCommitter(journal as unknown as AgentJournal, {
      commitFresh: commit,
      commitRecovery: commit,
    });

    await runtime.execute(command, application(identity));
    const scheduler = new JournalAgentSubagentScheduler({ journal });
    scheduler.schedule(command, application(identity), kernel);
    await scheduler.close();
    await runtime.execute(command, application(identity));

    expect(facts).toEqual([{ type: 'subagent.completed', subagentId: identity.childRunId }]);
  });
});

type ChildIdentity = ReturnType<typeof deriveChildAgentIdentity>;

class FakeChildJournal {
  readonly created: CreateRunCommand[] = [];
  readonly runs = new Map<string, KernelRunProjection>();
  ancestryDepth = 1;
  descendants: Array<{
    projectId: string; runId: string; parentRunId: string | null; rootRunId: string;
    depth: number; rootChildOrdinal: number;
  }> = [];

  get insertedRunCount(): number {
    return this.runs.size;
  }

  createRun(command: CreateRunCommand): Promise<CreateRunResult> {
    this.created.push(structuredClone(command));
    const runId = command.runId;
    if (runId === undefined) throw new Error('Child runId must be explicit.');
    if (!this.runs.has(runId)) {
      this.runs.set(runId, projection({
        runId,
        projectId: command.projectId,
        sessionId: command.sessionId,
        state: 'created',
      }));
    }
    return Promise.resolve({
      runId,
      inputEventId: `input:${runId}`,
      runCreatedEventId: `created:${runId}`,
    });
  }

  getRunProjection(runId: string): Promise<KernelRunProjection | null> {
    return Promise.resolve(structuredClone(this.runs.get(runId) ?? null));
  }

  getRunAncestry(runId: string) {
    const run = this.runs.get(runId);
    return Promise.resolve(run === undefined ? null : {
      projectId: run.projectId, runId, parentRunId: 'run-parent', rootRunId: 'run-parent', depth: this.ancestryDepth, rootChildOrdinal: 1,
    });
  }

  countRootChildren(): Promise<number> { return Promise.resolve(1); }

  listRunDescendants() { return Promise.resolve(structuredClone(this.descendants)); }
}

class FakeChildKernel {
  readonly advanced: string[] = [];
  readonly advanceOptions: Array<unknown> = [];
  readonly steered: SteerRunInput[] = [];
  readonly cancelled: CancelRunInput[] = [];
  readonly interrupted: Array<{ runId: string; code: string; detail?: PortableValue }> = [];
  readonly advanceStarted: Promise<void>;
  readonly #notifyAdvanceStarted: () => void;

  constructor(
    private readonly journal: FakeChildJournal,
    private readonly options: {
      blockUntilCancelled?: boolean;
      blockCancel?: boolean;
      throwOnAdvance?: boolean;
    } = {},
  ) {
    let notify: () => void = () => undefined;
    this.advanceStarted = new Promise<void>((resolve) => {
      notify = resolve;
    });
    this.#notifyAdvanceStarted = notify;
  }

  open(runId: string): Promise<KernelRunProjection> {
    const run = this.journal.runs.get(runId);
    if (run === undefined) throw new Error(`Run not found: ${runId}`);
    return Promise.resolve(structuredClone(run));
  }

  async advance(runId: string, options?: unknown): Promise<KernelRunProjection> {
    this.advanced.push(runId);
    this.advanceOptions.push(options);
    this.#notifyAdvanceStarted();
    if (this.options.throwOnAdvance === true) throw new Error('injected child advance failure');
    if (this.options.blockUntilCancelled === true) {
      while (this.journal.runs.get(runId)?.state !== 'Cancelled') {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      return await this.open(runId);
    }
    const current = await this.open(runId);
    const completed = projection({
      ...current,
      state: 'Completed',
      revision: current.revision + 1,
      evidenceRevision: 1,
      evidenceDigest: 'evidence-child',
      finalContentRef: 'content-child',
      deliveryStatus: 'verified',
    });
    this.journal.runs.set(runId, completed);
    return structuredClone(completed);
  }

  async steer(input: SteerRunInput): Promise<KernelRunProjection> {
    this.steered.push(structuredClone(input));
    return await this.open(input.runId);
  }

  async cancel(input: CancelRunInput): Promise<KernelRunProjection> {
    this.cancelled.push(structuredClone(input));
    if (this.options.blockCancel === true) return await new Promise<KernelRunProjection>(() => undefined);
    const current = await this.open(input.runId);
    const cancelled = projection({
      ...current,
      state: 'Cancelled',
      revision: current.revision + 1,
    });
    this.journal.runs.set(input.runId, cancelled);
    return structuredClone(cancelled);
  }

  async interruptExecution(input: { runId: string; code: string; detail?: PortableValue }): Promise<KernelRunProjection> {
    this.interrupted.push(structuredClone(input));
    const current = await this.open(input.runId);
    const interrupted = projection({
      ...current,
      state: 'Interrupted',
      revision: current.revision + 1,
    });
    this.journal.runs.set(input.runId, interrupted);
    return structuredClone(interrupted);
  }
}

function childIdentity(): ChildIdentity {
  return deriveChildAgentIdentity({
    projectId: 'project-1',
    parentRunId: 'run-parent',
    parentTurnId: 'turn-parent',
    parentInvocationId: 'invocation-parent',
    commandId: 'command-child.start',
  });
}

function childStartCommand(
  _identity: ChildIdentity,
  input: { task: string; context: PortableValue },
): Extract<RuntimeCommand, { kind: 'child.start' }> {
  return childCommand('child.start', _identity, {
    ...input,
  });
}

function recoveryIdentity(
  identity: ChildIdentity,
  command: Extract<RuntimeCommand, { kind: 'child.start' }>,
) {
  return {
    commandId: command.commandId,
    origin: structuredClone(command.origin),
    childRunId: identity.childRunId,
    childSessionId: identity.childSessionId,
    task: command.payload.task,
    context: structuredClone(command.payload.context),
  };
}

function childCommand<K extends RuntimeCommand['kind']>(
  kind: K,
  _identity: ChildIdentity,
  payload: Extract<RuntimeCommand, { kind: K }>['payload'],
): Extract<RuntimeCommand, { kind: K }> {
  return {
    schemaVersion: 2,
    kind,
    commandId: `command-${kind}`,
    origin: {
      runId: 'run-parent',
      turnId: 'turn-parent',
      invocationId: 'invocation-parent',
    },
    expectedRunRevision: 1,
    fencingToken: 1,
    payload,
  } as Extract<RuntimeCommand, { kind: K }>;
}

function application(
  identity: ChildIdentity,
  commandId = 'command-child.start',
): RuntimeCommandApplicationResult {
  return {
    events: [{
      eventId: 'event-runtime-command',
      projectId: 'project-1',
      sequence: 1,
      schemaVersion: 1,
      sessionId: 'session-parent',
      runId: 'run-parent',
      turnId: 'turn-parent',
      invocationId: 'invocation-parent',
      type: 'runtime.command_applied',
      occurredAt: '2026-08-08T00:00:00.000Z',
      payload: {
        commandId,
        kind: 'child.start',
        origin: {
          runId: 'run-parent',
          turnId: 'turn-parent',
          invocationId: 'invocation-parent',
        },
        expectedRunRevision: 1,
        fencingToken: 1,
        projectionRevision: 1,
        effect: {
          childRunId: identity.childRunId,
          childSessionId: identity.childSessionId,
          parentRunId: 'run-parent',
          parentInvocationId: 'invocation-parent',
          revision: 1,
          task: 'child task',
          context: null,
          status: 'running',
        },
      },
    }],
    run: projection({
      runId: 'run-parent',
      sessionId: 'session-parent',
      state: 'ExecutingTools',
    }),
    projection: {
      schemaVersion: 2,
      projectId: 'project-1',
      sessionId: 'session-parent',
      runId: 'run-parent',
      revision: 1,
      plan: null,
      activeTools: [],
      discoveredCapabilities: [],
      activationBindings: [],
      activeSkills: [],
      children: [{
        childRunId: identity.childRunId,
        childSessionId: identity.childSessionId,
        parentRunId: 'run-parent',
        parentInvocationId: 'invocation-parent',
        revision: 1,
        status: 'running',
        task: 'child task',
        context: null,
      }],
    },
  };
}

function expectedObservation(
  identity: ChildIdentity,
  status: 'running' | 'completed' | 'cancelled',
): AgentSubagentObservation {
  return {
    schemaVersion: 1,
    kind: 'subagent',
    childRunId: identity.childRunId,
    childSessionId: identity.childSessionId,
    parentRunId: 'run-parent',
    parentInvocationId: 'invocation-parent',
    status,
    summary: status === 'completed'
      ? 'Child Agent completed.'
      : status === 'cancelled'
        ? 'Child Agent was cancelled.'
        : 'Child Agent is running.',
    evidenceRefs: [],
    artifactRefs: [],
  };
}

function projection(
  input: Partial<KernelRunProjection> & Pick<KernelRunProjection, 'runId' | 'state'>,
): KernelRunProjection {
  return {
    schemaVersion: 1,
    projectId: 'project-1',
    sessionId: 'session-child',
    revision: 1,
    environmentBindingId: null,
    currentTurnId: null,
    turnSnapshotId: null,
    currentAttemptId: null,
    waitReason: null,
    evidenceRevision: 0,
    evidenceDigest: null,
    noProgressCount: 0,
    finalContentRef: null,
    deliveryStatus: null,
    updatedAt: '2026-08-08T00:00:00.000Z',
    ...input,
  };
}
