import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PermissionManager,
  RunEventCommitter,
  SqliteAgentJournal,
  ToolRegistry,
  createAgentToolResultEnvelope,
} from '../src/index.js';
import { validatedAttemptFixture } from './validated-attempt-fixture.js';

const temporaryDirectories: string[] = [];
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
  it.each([
    ['after-started-before-handler', 'idempotent', 1, 'succeeded'],
    ['after-external-effect-before-terminal', 'non_idempotent', 1, 'outcome_unknown'],
    ['after-terminal-before-observation', 'non_idempotent', 1, 'succeeded'],
  ] as const)('survives a real child-process crash at %s', async (
    cut,
    effect,
    expectedCounter,
    expectedOutcome,
  ) => {
    const fixture = await createRecoveryFixture({ effect, leaseTtlMs: 60_000 });
    await fixture.runtime.resolve();
    const child = spawnCrashWorker(fixture, cut);
    expect(await waitForExit(child)).not.toBe(0);

    const reopenedJournal = new SqliteAgentJournal({ filePath: fixture.journalPath });
    const recovered = await fixture.newRuntime({ journal: reopenedJournal });
    const observation = await recovered.recover(fixture.invocationId);

    expect(await readCounter(fixture.counterPath)).toBe(expectedCounter);
    expect(observation.outcome).toBe(expectedOutcome);
    if (expectedOutcome === 'succeeded') {
      expect(observation.modelProjection).toEqual({ counter: expectedCounter });
    }
    expect(await reopenedJournal.countEvents('tool.started', 'project-a')).toBe(1);
    expect(await reopenedJournal.countEvents('tool.observed', 'project-a')).toBe(1);
    expect(
      await reopenedJournal.countEvents(
        expectedOutcome === 'outcome_unknown' ? 'tool.outcome_unknown' : 'tool.succeeded',
        'project-a',
      ),
    ).toBe(1);
  }, 20_000);

  it('retries an idempotent Tool with the same persisted idempotency key after restart', async () => {
    const fixture = await createRecoveryFixture({ effect: 'idempotent' });
    await fixture.runtime.resolve();
    const child = spawnCrashWorker(fixture, 'after-external-effect-before-terminal');
    expect(await waitForExit(child)).not.toBe(0);

    const started = await fixture.journal.getInvocation(fixture.invocationId);
    const recovered = await fixture.newRuntime();
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
      effect: 'non_idempotent', leaseTtlMs: 50, leasePollIntervalMs: 5,
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
    await expect(staleExecution).rejects.toMatchObject({ code: 'LEASE_LOST' });

    expect(sawLeaseAbort).toBe(true);
    expect(observation.outcome).toBe('outcome_unknown');
    expect(await readCounter(fixture.counterPath)).toBe(1);
    expect(await fixture.journal.countEvents('tool.outcome_unknown', 'project-a')).toBe(1);
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
      effect: 'idempotent', leaseTtlMs: 50, leasePollIntervalMs: 5,
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
      effect: 'idempotent', leaseTtlMs: 50, leasePollIntervalMs: 5,
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

  it('requires an exact single-use retry permit for a risky equivalent action', async () => {
    const fixture = await createRecoveryFixture({ effect: 'non_idempotent' });
    await fixture.runtime.resolve();
    const child = spawnCrashWorker(fixture, 'after-external-effect-before-terminal');
    expect(await waitForExit(child)).not.toBe(0);
    await (await fixture.newRuntime()).recover(fixture.invocationId);
    const unknown = await fixture.journal.getInvocation(fixture.invocationId);

    await expect(fixture.runtime.authorizeRiskyRetry({
      commandId: 'risk-permit-wrong-revision', invocationId: fixture.invocationId,
      toolRevision: `${unknown?.toolRevision ?? ''}-changed`, effect: 'non_idempotent',
      normalizedArgumentsDigest: unknown?.normalizedArgumentsDigest ?? '',
      reason: 'must not bind another revision',
    })).rejects.toMatchObject({ code: 'INVOCATION_CONFLICT' });
    await expect(fixture.runtime.authorizeRiskyRetry({
      commandId: 'risk-permit-wrong-digest', invocationId: fixture.invocationId,
      toolRevision: unknown?.toolRevision ?? '', effect: 'non_idempotent',
      normalizedArgumentsDigest: 'f'.repeat(64),
      reason: 'must not bind another digest',
    })).rejects.toMatchObject({ code: 'INVOCATION_CONFLICT' });

    const permitted = await fixture.runtime.authorizeRiskyRetry({
      commandId: 'risk-permit', invocationId: fixture.invocationId,
      toolRevision: unknown?.toolRevision ?? '', effect: 'non_idempotent',
      normalizedArgumentsDigest: unknown?.normalizedArgumentsDigest ?? '',
      reason: 'user accepted duplicate-effect risk',
    });
    const replay = await fixture.runtime.authorizeRiskyRetry({
      commandId: 'risk-permit', invocationId: fixture.invocationId,
      toolRevision: unknown?.toolRevision ?? '', effect: 'non_idempotent',
      normalizedArgumentsDigest: unknown?.normalizedArgumentsDigest ?? '',
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
    const fixture = await createRecoveryFixture({ effect: 'non_idempotent' });
    await fixture.runtime.resolve();
    const child = spawnCrashWorker(fixture, 'after-external-effect-before-terminal');
    expect(await waitForExit(child)).not.toBe(0);
    await (await fixture.newRuntime()).recover(fixture.invocationId);
    const unknown = await fixture.journal.getInvocation(fixture.invocationId);
    if (
      unknown?.toolRevision === undefined || unknown.effect !== 'non_idempotent' ||
      unknown.normalizedArgumentsDigest === undefined
    ) throw new Error('Missing unknown outcome binding.');
    const permit = await fixture.runtime.authorizeRiskyRetry({
      commandId: 'scale-retry-permit', invocationId: unknown.invocationId,
      toolRevision: unknown.toolRevision, effect: unknown.effect,
      normalizedArgumentsDigest: unknown.normalizedArgumentsDigest,
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
          normalizedArgumentsDigest: index.toString(16).padStart(64, '0'),
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
           AND json_extract(payload_json, '$.effect') = ?
           AND json_extract(payload_json, '$.normalizedArgumentsDigest') = ?
           AND json_extract(payload_json, '$.terminal.kind') = 'outcome_unknown'
         ORDER BY updated_at DESC LIMIT 1`,
      ).all(
        unknown.projectId, unknown.runId, unknown.name, 'next-invocation',
        unknown.toolRevision, unknown.effect, unknown.normalizedArgumentsDigest,
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
    const fixture = await createRecoveryFixture({ effect: 'non_idempotent' });
    await fixture.runtime.resolve();
    const child = spawnCrashWorker(fixture, 'after-external-effect-before-terminal');
    expect(await waitForExit(child)).not.toBe(0);
    const recovered = await fixture.newRuntime();
    await recovered.recover(fixture.invocationId);
    const unknown = await fixture.journal.getInvocation(fixture.invocationId);
    if (
      unknown?.canonicalToolId === undefined || unknown.toolRevision === undefined ||
      unknown.effect === undefined || unknown.normalizedArgumentsDigest === undefined ||
      unknown.proposedRevision === undefined
    ) throw new Error('Missing unknown Invocation binding');
    const decision = {
      commandId: 'resolve-unknown', invocationId: unknown.invocationId,
      canonicalToolId: unknown.canonicalToolId, toolRevision: unknown.toolRevision,
      effect: unknown.effect, normalizedArgumentsDigest: unknown.normalizedArgumentsDigest,
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

type RecoveryEffect = 'read' | 'idempotent' | 'transactional' | 'non_idempotent';

type RecoveryFixtureOptions = {
  effect: RecoveryEffect;
  leaseTtlMs?: number;
  now?: () => string;
  afterCounter?: (signal: AbortSignal) => Promise<void>;
  leasePollIntervalMs?: number;
};

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
    expectedTurnRevision: 1, attempt: await validatedAttemptFixture('recovery-attempt'),
  });
  const invocationId = committed.invocations[0]?.invocationId ?? '';

  const createRegistry = () => {
    const registry = new ToolRegistry();
    registry.registerInvocation({
      name: 'query_database', description: 'persistent counter fixture', dangerLevel: 'safe',
      readonly: options.effect === 'read', effect: options.effect,
      handlerRevision: 'query_database@1', requiredPermission: 'read',
      exposure: 'direct', execution: {
        concurrency: options.effect === 'read' ? 'read' : 'write', timeoutMs: 10_000,
      },
      inputSchema: {
        type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'],
      },
    }, {
      execute: async (_arguments, context) => {
        incrementCounter(counterPath, context.idempotencyKey, options.effect === 'idempotent');
        await options.afterCounter?.(context.signal);
        return createAgentToolResultEnvelope({
          modelProjection: { counter: await readCounter(counterPath) },
          durableSummary: { counter: await readCounter(counterPath) },
        });
      },
    });
    registry.registerInvocation({
      name: 'read_result', description: 'unused fixture Tool', dangerLevel: 'safe', readonly: true,
      effect: 'read', handlerRevision: 'read_result@1',
      requiredPermission: 'read', exposure: 'direct',
      execution: { concurrency: 'read' },
      inputSchema: {
        type: 'object', properties: { resultRef: { type: 'string' } }, required: ['resultRef'],
      },
    }, { execute: () => createAgentToolResultEnvelope({
      modelProjection: { skipped: true }, durableSummary: { skipped: true },
    }) });
    return registry;
  };
  const snapshot = createRegistry().captureSnapshot();
  const { ToolInvocationRuntime } = await runtimeModule();
  const runtimeOptions = (overrides: {
    journal?: SqliteAgentJournal; lease?: typeof lease; turnId?: string;
  } = {}) => ({
    journal: overrides.journal ?? journal, registry: snapshot,
    permissionManager: new PermissionManager(),
    binding: {
      projectId: 'project-a', sessionId: 'session-a', runId: created.runId,
      turnId: overrides.turnId ?? 'turn-a', lease: overrides.lease ?? lease, mode: 'full' as const,
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

  const commitEquivalentNextTurn = async (turnId: string, attemptId: string) => {
    const run = await journal.getRunProjection(created.runId);
    if (run === null) throw new Error('Missing Run projection');
    await journal.startTurn({
      projectId: 'project-a', sessionId: 'session-a', runId: created.runId, turnId,
      commandId: `start-${turnId}`, lease: leaseRef, expectedRunRevision: run.revision,
    });
    const started = await journal.getRunProjection(created.runId);
    if (started === null) throw new Error('Missing started Run projection');
    const result = await new RunEventCommitter(journal).commitValidatedAttempt({
      projectId: 'project-a', sessionId: 'session-a', runId: created.runId, turnId,
      commandId: `commit-${turnId}`, lease: leaseRef, expectedRunRevision: started.revision,
      expectedTurnRevision: 1, attempt: await validatedAttemptFixture(attemptId),
    });
    return result.invocations[0] ?? (() => { throw new Error('Missing retry Invocation'); })();
  };

  return {
    directory, journalPath, counterPath, journal, runId: created.runId, turnId: 'turn-a',
    sessionId: 'session-a', projectId: 'project-a', lease, runtime, invocationId,
    effect: options.effect, newRuntime, commitEquivalentNextTurn,
  };
}

function spawnCrashWorker(
  fixture: Awaited<ReturnType<typeof createRecoveryFixture>>,
  cut: 'after-started-before-handler' | 'after-external-effect-before-terminal' | 'after-terminal-before-observation',
) {
  const viteNode = join(
    process.cwd(), 'node_modules', '.pnpm', 'vite-node@2.1.9_@types+node@22.19.20',
    'node_modules', 'vite-node', 'vite-node.mjs',
  );
  const worker = join(
    process.cwd(), 'packages', 'core-agent', 'test', 'fixtures', 'tool-runtime-crash-worker.ts',
  );
  return spawn(process.execPath, [viteNode, worker], {
    cwd: process.cwd(), stdio: 'ignore',
    env: {
      ...process.env,
      DBAGENT_TOOL_CRASH_INPUT: JSON.stringify({
        journalPath: fixture.journalPath, counterPath: fixture.counterPath,
        projectId: fixture.projectId, sessionId: fixture.sessionId, runId: fixture.runId,
        turnId: fixture.turnId, invocationId: fixture.invocationId, lease: fixture.lease,
        effect: fixture.effect, cut,
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
