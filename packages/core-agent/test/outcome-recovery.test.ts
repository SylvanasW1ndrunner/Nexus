import { spawn } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { executionPermissionAudit, preparedToolIntent } from './permission-audit-fixture.js';
import {
  PermissionManager,
  RunEventCommitter,
  SqliteAgentJournal,
  ToolRegistry,
} from '../src/index.js';
import {
  validatedAttemptFixture,
  validatedParallelReadAttemptFixture,
} from './validated-attempt-fixture.js';
import { openToolLifecycleCommitter } from '../src/internal/tool-lifecycle-authority.js';
import { resolveViteNodeEntry } from './fixtures/vite-node-entry.js';

const temporaryDirectories: string[] = [];
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = join(packageRoot, '..', '..');
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => NodeDatabaseSync;
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function runtimeModule() {
  return await import('../src/tools/tool-invocation-runtime.js');
}

describe('Tool outcome recovery', () => {
  it('runs two different Invocations exactly once across two synchronized child processes', async () => {
    const fixture = await createParallelWindowProcessFixture();
    const readyA = join(fixture.directory, 'parallel-a.ready');
    const readyB = join(fixture.directory, 'parallel-b.ready');
    const release = join(fixture.directory, 'parallel.release');
    const childA = spawnParallelWindowWorker(fixture, readyA, release);
    const childB = spawnParallelWindowWorker(fixture, readyB, release);
    await Promise.all([waitForPath(readyA), waitForPath(readyB)]);

    await writeFile(release, 'go', 'utf8');
    const exits = await Promise.all([waitForExit(childA), waitForExit(childB)]);
    expect(exits).toEqual([0, 0]);
    expect(await readParallelHandlerCalls(fixture.counterPath)).toEqual(
      fixture.invocationIds.map((invocationId) => ({ invocationId, calls: 1 }))
        .sort((left, right) => left.invocationId.localeCompare(right.invocationId)),
    );
    const reopened = new SqliteAgentJournal({ filePath: fixture.journalPath });
    expect(await reopened.countEvents('tool.started', 'project-a')).toBe(2);
    expect(await reopened.countEvents('tool.succeeded', 'project-a')).toBe(2);
    expect(await reopened.countEvents('tool.observed', 'project-a')).toBe(2);
    expect((await reopened.listInvocations(fixture.runId)).every(
      ({ state }) => state === 'observed',
    )).toBe(true);
  }, 20_000);

  it.each([
    ['after-started-before-handler', 'idempotent', 1, 'succeeded'],
    ['after-external-recoveryClass-before-terminal', 'non_idempotent', 1, 'unknown'],
    ['after-terminal-before-observation', 'non_idempotent', 1, 'succeeded'],
  ] as const)('survives a real child-process crash at %s', async (
    cut,
    recoveryClass,
    expectedCounter,
    expectedOutcome,
  ) => {
    const fixture = await createRecoveryFixture({ recoveryClass, leaseTtlMs: 60_000 });
    await fixture.runtime.resolve();
    const child = spawnCrashWorker(fixture, cut);
    expect(await waitForExit(child)).not.toBe(0);

    const reopenedJournal = new SqliteAgentJournal({ filePath: fixture.journalPath });
    const recovered = await fixture.takeoverRuntime({ journal: reopenedJournal });
    const observation = await recovered.recover(fixture.invocationId);
    if (observation === undefined) throw new Error('Expected recovered observation.');
    expect(await readCounter(fixture.counterPath)).toBe(expectedCounter);
    expect(observation.outcome).toBe(expectedOutcome);
    if (expectedOutcome === 'succeeded') {
      expect(observation.modelProjection).toMatchObject({
        status: 'ok', preview: JSON.stringify({ counter: expectedCounter }),
      });
    }
    expect(await reopenedJournal.countEvents('tool.started', 'project-a')).toBe(
      cut === 'after-started-before-handler' ? 2 : 1,
    );
    expect(await reopenedJournal.countEvents('tool.observed', 'project-a')).toBe(1);
    expect(
      await reopenedJournal.countEvents(
        expectedOutcome === 'unknown' ? 'tool.unknown' : 'tool.succeeded',
        'project-a',
      ),
    ).toBe(1);
  }, 20_000);

  it('retries an idempotent Tool with the same persisted idempotency key after restart', async () => {
    const fixture = await createRecoveryFixture({ recoveryClass: 'idempotent' });
    await fixture.runtime.resolve();
    const child = spawnCrashWorker(fixture, 'after-external-recoveryClass-before-terminal');
    expect(await waitForExit(child)).not.toBe(0);

    const started = await fixture.journal.getInvocation(fixture.invocationId);
    const recovered = await fixture.takeoverRuntime();
    await recovered.recover(fixture.invocationId);
    const finished = await fixture.journal.getInvocation(fixture.invocationId);

    expect(await readCounter(fixture.counterPath)).toBe(1);
    expect(finished?.started?.idempotencyKey).toBe(started?.started?.idempotencyKey);
    expect(await readIdempotencyKeys(fixture.counterPath)).toEqual([
      started?.started?.idempotencyKey,
    ]);
  }, 20_000);

  it('uses lease fencing to reject a stale completion and never replays a non-idempotent effect', async () => {
    let clock = Date.parse('2026-08-10T00:00:00.000Z');
    let signalEffect = (): void => undefined;
    const effectCommitted = new Promise<void>((resolve) => { signalEffect = resolve; });
    let sawLeaseAbort = false;
    const fixture = await createRecoveryFixture({
      recoveryClass: 'non_idempotent', leaseTtlMs: 50, leasePollIntervalMs: 5,
      now: () => new Date(clock).toISOString(),
      afterCounter: async (signal) => {
        signalEffect();
        await new Promise<void>((resolve) => {
          const aborted = () => {
            sawLeaseAbort = true;
            resolve();
          };
          if (signal.aborted) aborted();
          else signal.addEventListener('abort', aborted, { once: true });
        });
      },
    });
    await fixture.runtime.resolve();
    const staleExecution = fixture.runtime.execute(fixture.invocationId);
    await effectCommitted;

    clock += 100;
    const takeover = await fixture.journal.acquireRunLease({
      projectId: 'project-a', runId: fixture.runId, ownerId: 'worker-b', ttlMs: 60_000,
    });
    const recovered = await fixture.newRuntime({ lease: takeover });
    const observation = await recovered.recover(fixture.invocationId);
    if (observation === undefined) throw new Error('Expected recovered observation.');
    await expect(staleExecution).rejects.toMatchObject({ code: 'LEASE_LOST' });

    expect(sawLeaseAbort).toBe(true);
    expect(observation.outcome).toBe('unknown');
    expect(await readCounter(fixture.counterPath)).toBe(1);
    expect(await fixture.journal.countEvents('tool.unknown', 'project-a')).toBe(1);
    expect(await fixture.journal.countEvents('tool.succeeded', 'project-a')).toBe(0);
    expect(await fixture.journal.countEvents('tool.observed', 'project-a')).toBe(1);
  });

  it('aborts on natural lease expiry without takeover and recovers an idempotent effect once', async () => {
    let clock = Date.parse('2026-08-10T00:00:00.000Z');
    let signalEffect = (): void => undefined;
    const effectCommitted = new Promise<void>((resolve) => { signalEffect = resolve; });
    let handlerPass = 0;
    let sawLeaseAbort = false;
    const fixture = await createRecoveryFixture({
      recoveryClass: 'idempotent', leaseTtlMs: 50, leasePollIntervalMs: 5,
      now: () => new Date(clock).toISOString(),
      afterCounter: async (signal) => {
        handlerPass += 1;
        if (handlerPass !== 1) return;
        signalEffect();
        await new Promise<void>((resolve) => {
          const aborted = () => {
            sawLeaseAbort = true;
            resolve();
          };
          if (signal.aborted) aborted();
          else signal.addEventListener('abort', aborted, { once: true });
        });
      },
    });
    await fixture.runtime.resolve();
    const staleExecution = fixture.runtime.execute(fixture.invocationId);
    await effectCommitted;

    clock += 100;
    await expect(staleExecution).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(sawLeaseAbort).toBe(true);
    expect((await fixture.journal.getInvocation(fixture.invocationId))?.state).toBe('started');
    expect(await fixture.journal.countEvents('tool.succeeded', 'project-a')).toBe(0);
    expect(await fixture.journal.countEvents('tool.observed', 'project-a')).toBe(0);

    const takeover = await fixture.journal.acquireRunLease({
      projectId: 'project-a', runId: fixture.runId, ownerId: 'worker-b', ttlMs: 60_000,
    });
    const recovered = await fixture.newRuntime({ lease: takeover });
    await expect(recovered.recover(fixture.invocationId))
      .resolves.toMatchObject({ outcome: 'succeeded' });
    expect(await readCounter(fixture.counterPath)).toBe(1);
    expect(handlerPass).toBe(2);
    expect(await fixture.journal.countEvents('tool.succeeded', 'project-a')).toBe(1);
    expect(await fixture.journal.countEvents('tool.observed', 'project-a')).toBe(1);
  });

  it('refreshes the lease deadline after renewal without a false abort', async () => {
    let clock = Date.parse('2026-08-10T00:00:00.000Z');
    let signalEffect = (): void => undefined;
    let releaseHandler = (): void => undefined;
    const effectCommitted = new Promise<void>((resolve) => { signalEffect = resolve; });
    const handlerRelease = new Promise<void>((resolve) => { releaseHandler = resolve; });
    let sawLeaseAbort = false;
    const fixture = await createRecoveryFixture({
      recoveryClass: 'idempotent', leaseTtlMs: 50, leasePollIntervalMs: 5,
      now: () => new Date(clock).toISOString(),
      afterCounter: async (signal) => {
        signalEffect();
        await Promise.race([
          handlerRelease,
          new Promise<void>((resolve) => {
            const aborted = () => {
              sawLeaseAbort = true;
              resolve();
            };
            if (signal.aborted) aborted();
            else signal.addEventListener('abort', aborted, { once: true });
          }),
        ]);
      },
    });
    await fixture.runtime.resolve();
    let settled = false;
    const execution = fixture.runtime.execute(fixture.invocationId).finally(() => {
      settled = true;
    });
    await effectCommitted;

    clock += 40;
    await fixture.journal.renewRunLease({
      projectId: 'project-a', runId: fixture.runId, ownerId: fixture.lease.ownerId,
      fencingToken: fixture.lease.fencingToken, ttlMs: 100,
    });
    clock += 60;
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(sawLeaseAbort).toBe(false);
    expect(settled).toBe(false);

    releaseHandler();
    await expect(execution).resolves.toMatchObject({ outcome: 'succeeded' });
    expect(sawLeaseAbort).toBe(false);
    expect(await readCounter(fixture.counterPath)).toBe(1);
  });

  it.each(['read', 'idempotent', 'transactional'] as const)(
    'commits one Journal recovery claim before two Runtime instances replay a %s Handler',
    async (recoveryClass) => {
      let clock = Date.now();
      const fixture = await createRecoveryFixture({
        recoveryClass,
        now: () => new Date(clock).toISOString(),
        leaseTtlMs: 100,
        handlerDelayMs: 50,
      });
      await fixture.runtime.resolve();
      await commitStartedForRecovery(fixture);
      clock += 101;
      const takeover = await fixture.journal.acquireRunLease({
        projectId: fixture.projectId,
        runId: fixture.runId,
        ownerId: 'recovery-owner',
        ttlMs: 60_000,
      });
      const first = await fixture.newRuntime({ lease: takeover });
      const second = await fixture.newRuntime({ lease: takeover });

      const observations = await Promise.all([
        first.recover(fixture.invocationId),
        second.recover(fixture.invocationId),
      ]);

      expect(observations).toHaveLength(2);
      expect(observations.every((observation) => observation?.outcome === 'succeeded')).toBe(true);
      expect(fixture.handlerCalls()).toBe(1);
      expect(await fixture.journal.countEvents('tool.started', fixture.projectId)).toBe(2);
      expect(await fixture.journal.countEvents('tool.succeeded', fixture.projectId)).toBe(1);
      expect(await fixture.journal.countEvents('tool.observed', fixture.projectId)).toBe(1);
    },
    20_000,
  );

  it.each(['read', 'idempotent', 'transactional'] as const)(
    'lets one of two real recovery processes claim and replay a %s Handler',
    async (recoveryClass) => {
      let clock = Date.now();
      const fixture = await createRecoveryFixture({
        recoveryClass,
        now: () => new Date(clock).toISOString(),
        leaseTtlMs: 100,
      });
      await fixture.runtime.resolve();
      await commitStartedForRecovery(fixture);
      clock += 101;
      const takeover = await fixture.journal.acquireRunLease({
        projectId: fixture.projectId,
        runId: fixture.runId,
        ownerId: 'process-recovery-owner',
        ttlMs: 60_000,
      });
      const releasePath = join(fixture.directory, `release-${recoveryClass}`);
      const readyPaths = [
        join(fixture.directory, `ready-${recoveryClass}-a`),
        join(fixture.directory, `ready-${recoveryClass}-b`),
      ];
      const children = readyPaths.map((readyPath) => spawnRecoveryRaceWorker(
        fixture,
        takeover,
        readyPath,
        releasePath,
      ));
      await Promise.all(readyPaths.map(waitForPath));
      await writeFile(releasePath, 'go', 'utf8');

      expect(await Promise.all(children.map(waitForExit))).toEqual([0, 0]);
      expect(await readHandlerCalls(fixture.counterPath)).toBe(1);
      expect(await readCounter(fixture.counterPath)).toBe(1);
      expect(await fixture.journal.countEvents('tool.started', fixture.projectId)).toBe(2);
      expect(await fixture.journal.countEvents('tool.succeeded', fixture.projectId)).toBe(1);
      expect(await fixture.journal.countEvents('tool.observed', fixture.projectId)).toBe(1);
    },
    20_000,
  );

  it('requires an exact single-use retry permit for a risky equivalent action', async () => {
    const fixture = await createRecoveryFixture({ recoveryClass: 'non_idempotent' });
    await fixture.runtime.resolve();
    const child = spawnCrashWorker(fixture, 'after-external-recoveryClass-before-terminal');
    expect(await waitForExit(child)).not.toBe(0);
    const activeRuntime = await fixture.takeoverRuntime();
    await activeRuntime.recover(fixture.invocationId);
    const unknown = await fixture.journal.getInvocation(fixture.invocationId);

    await expect(activeRuntime.authorizeRiskyRetry({
      commandId: 'risk-permit-wrong-revision', invocationId: fixture.invocationId,
      toolRevision: `${unknown?.toolRevision ?? ''}-changed`, recoveryClass: 'non_idempotent',
      intentDigest: unknown?.intentDigest ?? '',
      reason: 'must not bind another revision',
    })).rejects.toMatchObject({ code: 'INVOCATION_CONFLICT' });
    await expect(activeRuntime.authorizeRiskyRetry({
      commandId: 'risk-permit-wrong-digest', invocationId: fixture.invocationId,
      toolRevision: unknown?.toolRevision ?? '', recoveryClass: 'non_idempotent',
      intentDigest: 'f'.repeat(64),
      reason: 'must not bind another digest',
    })).rejects.toMatchObject({ code: 'INVOCATION_CONFLICT' });

    const permitted = await activeRuntime.authorizeRiskyRetry({
      commandId: 'risk-permit', invocationId: fixture.invocationId,
      toolRevision: unknown?.toolRevision ?? '', recoveryClass: 'non_idempotent',
      intentDigest: unknown?.intentDigest ?? '',
      reason: 'user accepted duplicate-effect risk',
    });
    const replay = await activeRuntime.authorizeRiskyRetry({
      commandId: 'risk-permit', invocationId: fixture.invocationId,
      toolRevision: unknown?.toolRevision ?? '', recoveryClass: 'non_idempotent',
      intentDigest: unknown?.intentDigest ?? '',
      reason: 'user accepted duplicate-effect risk',
    });
    expect(replay).toEqual(permitted);

    const next = await fixture.commitEquivalentNextTurn('turn-b', 'attempt-b');
    const nextRuntime = await fixture.newRuntime({ turnId: 'turn-b' });
    expect(await nextRuntime.resolve()).toEqual({
      state: 'ExecutingTools', invocationIds: [next.invocationId],
    });
    await nextRuntime.execute(next.invocationId);
    expect((await fixture.journal.getInvocation(next.invocationId))?.retryOf)
      .toBe(fixture.invocationId);
    expect(await readCounter(fixture.counterPath)).toBe(2);

    const third = await fixture.commitEquivalentNextTurn('turn-c', 'attempt-c');
    const thirdRuntime = await fixture.newRuntime({ turnId: 'turn-c' });
    await thirdRuntime.resolve();
    expect((await fixture.journal.getInvocation(third.invocationId))?.state)
      .toBe('denied');
    expect(await fixture.journal.getApproval({
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
      invocationId: third.invocationId,
    })).toBeNull();
    await expect(thirdRuntime.executeEligible())
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ invocationId: third.invocationId, outcome: 'denied' }),
      ]));
    expect(await readCounter(fixture.counterPath)).toBe(2);
  }, 20_000);

  it('keeps unknown-predecessor and retry-permit lookup indexed at run-history scale', async () => {
    const fixture = await createRecoveryFixture({ recoveryClass: 'non_idempotent' });
    await fixture.runtime.resolve();
    const child = spawnCrashWorker(fixture, 'after-external-recoveryClass-before-terminal');
    expect(await waitForExit(child)).not.toBe(0);
    const activeRuntime = await fixture.takeoverRuntime();
    await activeRuntime.recover(fixture.invocationId);
    const unknown = await fixture.journal.getInvocation(fixture.invocationId);
    if (
      unknown?.toolRevision === undefined || unknown.recoveryClass !== 'non_idempotent' ||
      unknown.intentDigest === undefined
    ) throw new Error('Missing unknown outcome binding.');
    const permit = await activeRuntime.authorizeRiskyRetry({
      commandId: 'scale-retry-permit', invocationId: unknown.invocationId,
      toolRevision: unknown.toolRevision, recoveryClass: unknown.recoveryClass,
      intentDigest: unknown.intentDigest,
      reason: 'scale fixture permit',
    });

    const database = new DatabaseSync(fixture.journalPath);
    try {
      const insert = database.prepare(
        `INSERT INTO agent_invocations (
          invocation_id, project_id, session_id, run_id, turn_id, attempt_id,
          call_id, action_ordinal, name, arguments_json, state, revision,
          payload_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'observed', 2, ?, ?, ?)`,
      );
      database.exec('BEGIN IMMEDIATE');
      for (let index = 0; index < 3_000; index += 1) {
        const invocationId = `scale-invocation-${index}`;
        const payload = {
          ...unknown,
          invocationId,
          callId: `scale-call-${index}`,
          actionOrdinal: index + 1_000,
          state: 'observed',
          revision: 2,
          intentDigest: index.toString(16).padStart(64, '0'),
          terminal: { kind: 'succeeded', summary: 'noise', resultRefs: [],
            occurredAt: unknown.updatedAt },
          observation: { observationId: `scale-observation-${index}`, invocationId,
            summary: 'noise', evidenceRefs: [], outcome: 'succeeded',
            occurredAt: unknown.updatedAt },
          retryPermitId: `noise-permit-${index}`,
        };
        insert.run(
          invocationId, unknown.projectId, unknown.sessionId, unknown.runId,
          unknown.turnId, unknown.attemptId, payload.callId, payload.actionOrdinal,
          unknown.name, JSON.stringify(unknown.arguments), JSON.stringify(payload),
          unknown.createdAt, unknown.updatedAt,
        );
      }
      database.exec('COMMIT');

      const predecessorPlan = database.prepare(
        `EXPLAIN QUERY PLAN SELECT invocation_id FROM agent_invocations
         WHERE project_id = ? AND run_id = ? AND name = ? AND invocation_id <> ?
           AND state = 'observed'
           AND json_extract(payload_json, '$.toolRevision') = ?
           AND json_extract(payload_json, '$.recoveryClass') = ?
           AND json_extract(payload_json, '$.intentDigest') = ?
           AND json_extract(payload_json, '$.terminal.kind') = 'unknown'
         ORDER BY updated_at DESC LIMIT 1`,
      ).all(
        unknown.projectId, unknown.runId, unknown.name, 'next-invocation',
        unknown.toolRevision, unknown.recoveryClass, unknown.intentDigest,
      ) as unknown as Array<{ detail: string }>;
      const permitPlan = database.prepare(
        `EXPLAIN QUERY PLAN SELECT 1 AS present FROM agent_invocations
         WHERE project_id = ? AND run_id = ?
           AND json_extract(payload_json, '$.retryPermitId') = ? LIMIT 1`,
      ).all(
        unknown.projectId, unknown.runId, permit.permitId,
      ) as unknown as Array<{ detail: string }>;
      expect(predecessorPlan.map(({ detail }) => detail).join('\n'))
        .toContain('idx_agent_invocations_unknown_equivalent');
      expect(permitPlan.map(({ detail }) => detail).join('\n'))
        .toContain('idx_agent_invocations_retry_permit');
    } finally {
      database.close();
    }

    const next = await fixture.commitEquivalentNextTurn('turn-scale', 'attempt-scale');
    const nextRuntime = await fixture.newRuntime({ turnId: 'turn-scale' });
    const startedAt = performance.now();
    expect(await nextRuntime.resolve()).toEqual({
      state: 'ExecutingTools', invocationIds: [next.invocationId],
    });
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect((await fixture.journal.getInvocation(next.invocationId))?.retryOf)
      .toBe(unknown.invocationId);
  }, 20_000);

  it('resolves an unknown outcome once with exact binding and replays the decision durably', async () => {
    const fixture = await createRecoveryFixture({ recoveryClass: 'non_idempotent' });
    await fixture.runtime.resolve();
    const child = spawnCrashWorker(fixture, 'after-external-recoveryClass-before-terminal');
    expect(await waitForExit(child)).not.toBe(0);
    const recovered = await fixture.takeoverRuntime();
    await recovered.recover(fixture.invocationId);
    const unknown = await fixture.journal.getInvocation(fixture.invocationId);
    if (
      unknown?.canonicalToolId === undefined || unknown.toolRevision === undefined ||
      unknown.recoveryClass === undefined || unknown.intentDigest === undefined ||
      unknown.proposedRevision === undefined
    ) throw new Error('Missing unknown Invocation binding');
    const decision = {
      commandId: 'resolve-unknown', invocationId: unknown.invocationId,
      canonicalToolId: unknown.canonicalToolId, toolRevision: unknown.toolRevision,
      recoveryClass: unknown.recoveryClass, intentDigest: unknown.intentDigest,
      proposedRevision: unknown.proposedRevision, outcome: 'succeeded' as const,
      summary: 'Operator verified the external effect.',
    };

    const first = await recovered.resolveUnknownOutcome(decision);
    const replay = await recovered.resolveUnknownOutcome(decision);
    expect(replay).toEqual(first);
    await expect(recovered.resolveUnknownOutcome({
      ...decision, commandId: 'resolve-conflict', outcome: 'failed',
    })).rejects.toMatchObject({ code: 'OUTCOME_RESOLUTION_CONFLICT' });
    expect(first).toMatchObject({
      outcome: 'succeeded', summary: 'Operator verified the external effect.',
    });
    expect(await fixture.journal.countEvents('tool.outcome_resolved', 'project-a')).toBe(1);
    expect(await fixture.journal.countEvents('tool.observed', 'project-a')).toBe(1);

    const next = await fixture.commitEquivalentNextTurn('turn-b', 'resolved-next-attempt');
    const nextRuntime = await fixture.newRuntime({ turnId: 'turn-b' });
    expect(await nextRuntime.resolve()).toEqual({
      state: 'ExecutingTools', invocationIds: [next.invocationId],
    });
    expect((await fixture.journal.getInvocation(next.invocationId))?.retryOf).toBeUndefined();
    await nextRuntime.execute(next.invocationId);
    expect(await readCounter(fixture.counterPath)).toBe(2);

    await fixture.journal.rebuildProjectProjections('project-a');
    expect((await fixture.journal.getInvocation(fixture.invocationId))?.terminal?.kind)
      .toBe('succeeded');
  }, 20_000);
});

type RecoveryClass = 'read' | 'idempotent' | 'transactional' | 'non_idempotent';

type RecoveryFixtureOptions = {
  recoveryClass: RecoveryClass;
  leaseTtlMs?: number;
  now?: () => string;
  afterCounter?: (signal: AbortSignal) => Promise<void>;
  handlerDelayMs?: number;
  leasePollIntervalMs?: number;
};

async function createParallelWindowProcessFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dbagent-parallel-window-'));
  temporaryDirectories.push(directory);
  const journalPath = join(directory, 'state.db');
  const counterPath = join(directory, 'parallel-counter.db');
  initializeParallelCounter(counterPath);
  const journal = new SqliteAgentJournal({ filePath: journalPath });
  const created = await journal.createRun({
    projectId: 'project-a', sessionId: 'session-a', clientRequestId: 'parallel-window', input: 'go',
  });
  const lease = await journal.acquireRunLease({
    projectId: 'project-a', runId: created.runId, ownerId: 'parallel-owner', ttlMs: 60_000,
  });
  const leaseRef = leaseReference(lease);
  await journal.startRun({
    projectId: 'project-a', sessionId: 'session-a', runId: created.runId,
    commandId: 'parallel-start-run', lease: leaseRef, expectedRunRevision: 1,
  });
  await journal.startTurn({
    projectId: 'project-a', sessionId: 'session-a', runId: created.runId, turnId: 'turn-a',
    commandId: 'parallel-start-turn', lease: leaseRef, expectedRunRevision: 2,
  });
  const committed = await new RunEventCommitter(journal).commitValidatedAttempt({
    projectId: 'project-a', sessionId: 'session-a', runId: created.runId, turnId: 'turn-a',
    commandId: 'parallel-commit-turn', lease: leaseRef, expectedRunRevision: 3,
    expectedTurnRevision: 1, billingMode: 'byok',
    attempt: await validatedParallelReadAttemptFixture('parallel-process-attempt'),
  });
  const registry = new ToolRegistry();
  registry.registerInvocation({
    name: 'query_database', description: 'parallel process read fixture', dangerLevel: 'safe',
    readonly: true, source: 'unknown', access: 'read', recoveryClass: 'read',
    toolRevision: 'query_database@1', handlerRevision: 'query_database@parallel-window-1',
    intentRevision: 'prepared-tool-intent.v1',
    permission: { actions: ['read'] }, exposure: 'direct',
    limits: { timeoutMs: 10_000, maxInputBytes: 4_096, maxOutputBytes: 65_536, maxArtifactBytes: 1_048_576, maxDepth: 8, maxRecords: 128 },
    outputSchema: { type: 'object' },
    failurePolicy: { onUnknown: { failureKind: 'unknown', retryable: false } },
    execution: { concurrency: 'read', timeoutMs: 10_000 },
    inputSchema: {
      type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'],
    },
  }, {
    revision: { toolName: 'query_database', toolRevision: 'query_database@1', handlerRevision: 'query_database@parallel-window-1', intentRevision: 'prepared-tool-intent.v1' },
    prepare: (preparedInput, context) => ({
      ...preparedToolIntent({ toolName: 'query_database', toolRevision: 'query_database@1', handlerRevision: 'query_database@parallel-window-1' }).intent,
      input: structuredClone(preparedInput),
      toolRevision: context.toolRevision,
      handlerRevision: context.handlerRevision,
      intentRevision: context.intentRevision,
      generation: context.generation,
      targetIdentity: null,
      limits: context.limits,
    }),
    execute: () => { throw new Error('Parent fixture must never execute a Handler.'); },
  });
  const snapshot = registry.captureSnapshot();
  const allowedTools = snapshot.llmTools().map(({ name }) => {
    const revision = snapshot.invocationRevision(name);
    if (revision === undefined) throw new Error(`Missing Invocation revision for ${name}.`);
    return { name, revision };
  });
  const { ToolInvocationRuntime } = await runtimeModule();
  const runtime = new ToolInvocationRuntime({
    journal, registry: snapshot, allowedTools, permissionManager: new PermissionManager(),
    binding: {
      projectId: 'project-a', sessionId: 'session-a', runId: created.runId,
      turnId: 'turn-a', lease, mode: 'full-access',
    },
    maxConcurrency: 2,
  });
  await runtime.resolve();
  return {
    directory, journalPath, counterPath, journal, runId: created.runId,
    projectId: 'project-a', sessionId: 'session-a', turnId: 'turn-a', lease,
    invocationIds: committed.invocations.map(({ invocationId }) => invocationId),
  };
}

async function createRecoveryFixture(options: RecoveryFixtureOptions) {
  const directory = await mkdtemp(join(tmpdir(), 'dbagent-outcome-recovery-'));
  temporaryDirectories.push(directory);
  const journalPath = join(directory, 'state.db');
  const counterPath = join(directory, 'external-counter.db');
  initializeCounter(counterPath);
  const journal = new SqliteAgentJournal({
    filePath: journalPath,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const created = await journal.createRun({
    projectId: 'project-a', sessionId: 'session-a', clientRequestId: 'recovery-a', input: 'go',
  });
  const lease = await journal.acquireRunLease({
    projectId: 'project-a', runId: created.runId, ownerId: 'worker-a',
    ttlMs: options.leaseTtlMs ?? 60_000,
  });
  const leaseRef = { ownerId: lease.ownerId, fencingToken: lease.fencingToken };
  await journal.startRun({
    projectId: 'project-a', sessionId: 'session-a', runId: created.runId,
    commandId: 'start-run', lease: leaseRef, expectedRunRevision: 1,
  });
  await journal.startTurn({
    projectId: 'project-a', sessionId: 'session-a', runId: created.runId, turnId: 'turn-a',
    commandId: 'start-turn-a', lease: leaseRef, expectedRunRevision: 2,
  });
  const committed = await new RunEventCommitter(journal).commitValidatedAttempt({
    projectId: 'project-a', sessionId: 'session-a', runId: created.runId, turnId: 'turn-a',
    commandId: 'commit-turn-a', lease: leaseRef, expectedRunRevision: 3,
    expectedTurnRevision: 1, billingMode: 'byok', attempt: await validatedAttemptFixture('recovery-attempt'),
  });
  const invocationId = committed.invocations[0]?.invocationId ?? '';

  const createRegistry = () => {
    const registry = new ToolRegistry();
    const counterHandler = async (
      _arguments: Readonly<Record<string, unknown>>,
      context: { idempotencyKey: string; signal: AbortSignal },
    ) => {
      handlerCalls += 1;
      incrementCounter(counterPath, context.idempotencyKey, options.recoveryClass === 'idempotent');
      if (options.handlerDelayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.handlerDelayMs));
      }
      await options.afterCounter?.(context.signal);
      return { counter: await readCounter(counterPath) };
    };
    registry.registerInvocation({
      name: 'query_database', description: 'persistent counter fixture', dangerLevel: 'safe',
      readonly: options.recoveryClass === 'read', source: 'unknown',
      access: options.recoveryClass === 'read' ? 'read' : 'write', recoveryClass: options.recoveryClass,
      toolRevision: 'query_database@1', handlerRevision: 'query_database-handler@1',
      intentRevision: 'prepared-tool-intent.v1', permission: { actions: ['read'] },
      exposure: 'direct', execution: {
        concurrency: options.recoveryClass === 'read' ? 'read' : 'write', timeoutMs: 10_000,
      },
      limits: { timeoutMs: 10_000, maxInputBytes: 4_096, maxOutputBytes: 65_536, maxArtifactBytes: 1_048_576, maxDepth: 8, maxRecords: 128 },
      outputSchema: { type: 'object' },
      failurePolicy: { onUnknown: { failureKind: 'unknown', retryable: false } },
      inputSchema: {
        type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'],
      },
    }, {
      revision: { toolName: 'query_database', toolRevision: 'query_database@1', handlerRevision: 'query_database-handler@1', intentRevision: 'prepared-tool-intent.v1' },
      prepare: (preparedInput, context) => ({
        ...preparedToolIntent({ toolName: 'query_database', toolRevision: 'query_database@1', handlerRevision: 'query_database-handler@1', recoveryClass: options.recoveryClass }).intent,
        input: structuredClone(preparedInput), toolRevision: context.toolRevision,
        handlerRevision: context.handlerRevision, intentRevision: context.intentRevision,
        generation: context.generation, limits: context.limits,
      }),
      execute: counterHandler,
      ...(options.recoveryClass === 'transactional' ? { recover: counterHandler } : {}),
    });
    registry.registerInvocation({
      name: 'read_result', description: 'unused fixture Tool', dangerLevel: 'safe', readonly: true,
      source: 'unknown', access: 'read', recoveryClass: 'read',
      toolRevision: 'read_result@1', handlerRevision: 'read_result-handler@1', intentRevision: 'prepared-tool-intent.v1',
      permission: { actions: ['read'] }, exposure: 'direct',
      limits: { timeoutMs: 10_000, maxInputBytes: 4_096, maxOutputBytes: 65_536, maxArtifactBytes: 1_048_576, maxDepth: 8, maxRecords: 128 },
      outputSchema: { type: 'object' }, failurePolicy: { onUnknown: { failureKind: 'unknown', retryable: false } },
      execution: { concurrency: 'read', timeoutMs: 10_000 },
      inputSchema: {
        type: 'object', properties: { resultRef: { type: 'string' } }, required: ['resultRef'],
      },
    }, {
      revision: { toolName: 'read_result', toolRevision: 'read_result@1', handlerRevision: 'read_result-handler@1', intentRevision: 'prepared-tool-intent.v1' },
      prepare: () => preparedToolIntent({ toolName: 'read_result', toolRevision: 'read_result@1', handlerRevision: 'read_result-handler@1' }).intent,
      execute: () => ({ skipped: true }),
    });
    return registry;
  };
  let handlerCalls = 0;
  let activeLease = lease;
  let takeoverOrdinal = 0;
  const snapshot = createRegistry().captureSnapshot();
  const allowedTools = snapshot.llmTools().map(({ name }) => {
    const revision = snapshot.invocationRevision(name);
    if (revision === undefined) throw new Error(`Missing Invocation revision for ${name}.`);
    return { name, revision };
  });
  const { ToolInvocationRuntime } = await runtimeModule();
  const runtimeOptions = (overrides: {
    journal?: SqliteAgentJournal; lease?: typeof lease; turnId?: string;
  } = {}) => ({
    journal: overrides.journal ?? journal, registry: snapshot,
    allowedTools,
    revalidateTarget: () => undefined,
    permissionManager: new PermissionManager(),
    binding: {
      projectId: 'project-a', sessionId: 'session-a', runId: created.runId,
      turnId: overrides.turnId ?? 'turn-a', lease: overrides.lease ?? activeLease,
      mode: 'full-access' as const,
    },
    ...(options.leasePollIntervalMs === undefined
      ? {}
      : { leasePollIntervalMs: options.leasePollIntervalMs }),
    ...(options.now === undefined ? {} : { now: () => Date.parse(options.now?.() ?? '') }),
  });
  const runtime = new ToolInvocationRuntime(runtimeOptions());

  const newRuntime = (overrides: {
    journal?: SqliteAgentJournal; lease?: typeof lease; turnId?: string;
  } = {}) => Promise.resolve(new ToolInvocationRuntime(runtimeOptions(overrides)));

  const takeoverRuntime = async (overrides: {
    journal?: SqliteAgentJournal; turnId?: string;
  } = {}) => {
    expireRunLeaseForCrash(journalPath, created.runId);
    const leaseJournal = overrides.journal ?? journal;
    takeoverOrdinal += 1;
    activeLease = await leaseJournal.acquireRunLease({
      projectId: 'project-a', runId: created.runId,
      ownerId: `recovery-owner-${takeoverOrdinal}`, ttlMs: 60_000,
    });
    return new ToolInvocationRuntime(runtimeOptions({
      journal: leaseJournal,
      lease: activeLease,
      ...(overrides.turnId === undefined ? {} : { turnId: overrides.turnId }),
    }));
  };

  const commitEquivalentNextTurn = async (turnId: string, attemptId: string) => {
    const run = await journal.getRunProjection(created.runId);
    if (run === null) throw new Error('Missing Run projection');
    await journal.startTurn({
      projectId: 'project-a', sessionId: 'session-a', runId: created.runId, turnId,
      commandId: `start-${turnId}`, lease: leaseReference(activeLease),
      expectedRunRevision: run.revision,
    });
    const started = await journal.getRunProjection(created.runId);
    if (started === null) throw new Error('Missing started Run projection');
    const result = await new RunEventCommitter(journal).commitValidatedAttempt({
      projectId: 'project-a', sessionId: 'session-a', runId: created.runId, turnId,
      commandId: `commit-${turnId}`, lease: leaseReference(activeLease),
      expectedRunRevision: started.revision,
      expectedTurnRevision: 1, billingMode: 'byok', attempt: await validatedAttemptFixture(attemptId),
    });
    return result.invocations[0] ?? (() => { throw new Error('Missing retry Invocation'); })();
  };

  return {
    directory, journalPath, counterPath, journal, runId: created.runId, turnId: 'turn-a',
    sessionId: 'session-a', projectId: 'project-a', lease, runtime, invocationId,
    recoveryClass: options.recoveryClass, newRuntime, takeoverRuntime, commitEquivalentNextTurn,
    handlerCalls: () => handlerCalls,
  };
}

function expireRunLeaseForCrash(journalPath: string, runId: string): void {
  const database = new DatabaseSync(journalPath);
  try {
    const result = database.prepare(
      'UPDATE agent_run_leases SET expires_at_ms = 0 WHERE run_id = ?',
    ).run(runId);
    if (Number(result.changes) !== 1) throw new Error('Crash fixture lease is missing.');
  } finally {
    database.close();
  }
}

function leaseReference(lease: { ownerId: string; fencingToken: number }) {
  return { ownerId: lease.ownerId, fencingToken: lease.fencingToken };
}

async function commitStartedForRecovery(
  fixture: Awaited<ReturnType<typeof createRecoveryFixture>>,
): Promise<void> {
  const invocation = await fixture.journal.getInvocation(fixture.invocationId);
  const run = await fixture.journal.getRunProjection(fixture.runId);
  if (invocation === null || run === null) throw new Error('Recovery fixture is incomplete.');
  await openToolLifecycleCommitter(fixture.journal).commit({
    action: 'start',
    projectId: fixture.projectId,
    sessionId: fixture.sessionId,
    runId: fixture.runId,
    turnId: fixture.turnId,
    invocationId: fixture.invocationId,
    commandId: `test-start:${fixture.invocationId}`,
    lease: { ownerId: fixture.lease.ownerId, fencingToken: fixture.lease.fencingToken },
    expectedRunRevision: run.revision,
    expectedInvocationRevision: invocation.revision,
    intentDigest: invocation.intentDigest ?? '',
    idempotencyKey: `test-idempotency:${fixture.invocationId}`,
    attempt: 1,
    permissionAudit: executionPermissionAudit(fixture.recoveryClass),
  });
}

function spawnCrashWorker(
  fixture: Awaited<ReturnType<typeof createRecoveryFixture>>,
  cut: 'after-started-before-handler' | 'after-external-recoveryClass-before-terminal' | 'after-terminal-before-observation',
) {
  const viteNode = resolveViteNodeEntry();
  const worker = join(
    packageRoot, 'test', 'fixtures', 'tool-runtime-crash-worker.ts',
  );
  return spawn(process.execPath, [viteNode, worker], {
    cwd: repositoryRoot, stdio: 'ignore',
    env: {
      ...process.env,
      DBAGENT_TOOL_CRASH_INPUT: JSON.stringify({
        journalPath: fixture.journalPath, counterPath: fixture.counterPath,
        projectId: fixture.projectId, sessionId: fixture.sessionId, runId: fixture.runId,
        turnId: fixture.turnId, invocationId: fixture.invocationId, lease: fixture.lease,
        recoveryClass: fixture.recoveryClass, cut,
      }),
    },
  });
}

function spawnRecoveryRaceWorker(
  fixture: Awaited<ReturnType<typeof createRecoveryFixture>>,
  lease: Awaited<ReturnType<SqliteAgentJournal['acquireRunLease']>>,
  readyPath: string,
  releasePath: string,
) {
  const viteNode = resolveViteNodeEntry();
  const worker = join(
    packageRoot, 'test', 'fixtures',
    'tool-recovery-race-worker.ts',
  );
  return spawn(process.execPath, [viteNode, worker], {
    cwd: repositoryRoot, stdio: 'ignore',
    env: {
      ...process.env,
      DBAGENT_TOOL_RECOVERY_RACE_INPUT: JSON.stringify({
        journalPath: fixture.journalPath,
        counterPath: fixture.counterPath,
        readyPath,
        releasePath,
        projectId: fixture.projectId,
        sessionId: fixture.sessionId,
        runId: fixture.runId,
        turnId: fixture.turnId,
        invocationId: fixture.invocationId,
        lease,
        recoveryClass: fixture.recoveryClass,
      }),
    },
  });
}

function spawnParallelWindowWorker(
  fixture: Awaited<ReturnType<typeof createParallelWindowProcessFixture>>,
  readyPath: string,
  releasePath: string,
) {
  const viteNode = resolveViteNodeEntry();
  const worker = join(packageRoot, 'test', 'fixtures', 'tool-parallel-window-worker.ts');
  return spawn(process.execPath, [viteNode, worker], {
    cwd: repositoryRoot,
    stdio: 'ignore',
    env: {
      ...process.env,
      DBAGENT_TOOL_PARALLEL_WINDOW_INPUT: JSON.stringify({
        journalPath: fixture.journalPath,
        counterPath: fixture.counterPath,
        readyPath,
        releasePath,
        projectId: fixture.projectId,
        sessionId: fixture.sessionId,
        runId: fixture.runId,
        turnId: fixture.turnId,
        lease: fixture.lease,
      }),
    },
  });
}

function initializeCounter(path: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS effects (
        effect_id INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT NOT NULL,
        UNIQUE (idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS handler_calls (
        call_id TEXT PRIMARY KEY
      );`);
  } finally {
    database.close();
  }
}

function initializeParallelCounter(path: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE parallel_handler_calls (
        call_id TEXT PRIMARY KEY,
        invocation_id TEXT NOT NULL
      );`);
  } finally {
    database.close();
  }
}

function incrementCounter(path: string, idempotencyKey: string, idempotent: boolean): void {
  const database = new DatabaseSync(path);
  try {
    if (idempotent) {
      database.prepare('INSERT OR IGNORE INTO effects (idempotency_key) VALUES (?)')
        .run(idempotencyKey);
    } else {
      database.prepare('INSERT INTO effects (idempotency_key) VALUES (?)')
        .run(`${idempotencyKey}:${crypto.randomUUID()}`);
    }
  } finally {
    database.close();
  }
}

async function readCounter(path: string): Promise<number> {
  await Promise.resolve();
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return Number((database.prepare('SELECT COUNT(*) AS count FROM effects').get() as { count: number }).count);
  } finally {
    database.close();
  }
}

async function readHandlerCalls(path: string): Promise<number> {
  await Promise.resolve();
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return Number(
      (database.prepare('SELECT COUNT(*) AS count FROM handler_calls').get() as { count: number })
        .count,
    );
  } finally {
    database.close();
  }
}

async function readParallelHandlerCalls(
  path: string,
): Promise<Array<{ invocationId: string; calls: number }>> {
  await Promise.resolve();
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return (database.prepare(
      `SELECT invocation_id, COUNT(*) AS calls
       FROM parallel_handler_calls GROUP BY invocation_id ORDER BY invocation_id`,
    ).all() as unknown as Array<{ invocation_id: string; calls: number }>).map((row) => ({
      invocationId: row.invocation_id,
      calls: Number(row.calls),
    }));
  } finally {
    database.close();
  }
}

async function readIdempotencyKeys(path: string): Promise<Array<string | undefined>> {
  await Promise.resolve();
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return (database.prepare('SELECT idempotency_key FROM effects ORDER BY effect_id').all() as
      Array<{ idempotency_key: string }>).map(({ idempotency_key }) => idempotency_key);
  } finally {
    database.close();
  }
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return await new Promise((resolve) => child.once('exit', resolve));
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error(`Timed out waiting for recovery worker: ${path}`);
}
