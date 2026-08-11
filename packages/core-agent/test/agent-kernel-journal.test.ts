import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentJournalError } from '../src/events/agent-journal.js';
import { RunEventCommitter } from '../src/events/run-event-committer.js';
import { SqliteAgentJournal } from '../src/events/sqlite-agent-journal.js';
import { upcastAgentEvent } from '../src/events/event-upcasters.js';
import { openToolLifecycleCommitter } from '../src/internal/tool-lifecycle-authority.js';
import {
  RunController,
  type EnvironmentBindingInput,
  type TurnSnapshotInput,
} from '../src/kernel/run-controller.js';
import { validatedAttemptFixture, validatedTextAttemptFixture } from './validated-attempt-fixture.js';

const roots: string[] = [];
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => NodeDatabaseSync;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('journal-driven RunController', () => {
  it('atomically prepares a turn with immutable environment and turn snapshots', async () => {
    const { journal, controller, runId } = await fixture();
    const prepared = await controller.prepareTurn({
      commandId: 'prepare-1',
      expectedRunRevision: 1,
      turnId: 'turn-1',
      environment: environment(),
      snapshot: snapshot(),
    });

    expect(prepared.run.state).toBe('CallingModel');
    expect(prepared.run.currentTurnId).toBe('turn-1');
    expect(prepared.environment.payload.modelRoute.primary.maxInputTokens).toBe(131_072);
    expect(prepared.snapshot.payload.capability.revision).toBe('cap-r1');
    expect(prepared.snapshot.environmentBindingId).toBe(prepared.environment.environmentBindingId);

    const reopened = new SqliteAgentJournal({ filePath: journal.filePath });
    expect(await reopened.getKernelRunProjection(scope(runId))).toEqual(prepared.run);
    expect(await reopened.getEnvironmentBinding(scope(runId))).toEqual(prepared.environment);
    expect(await reopened.getTurnSnapshot(turnScope(runId, 'turn-1'))).toEqual(prepared.snapshot);
  });

  it('rolls back both facts and projections at every injected prepare boundary', async () => {
    const { journal, controller, runId } = await fixture();
    journal.failKernelAt('after-events-before-projection');
    await expect(controller.prepareTurn({
      commandId: 'prepare-fault', expectedRunRevision: 1, turnId: 'turn-fault',
      environment: environment(), snapshot: snapshot(),
    })).rejects.toThrow('INJECTED_KERNEL_FAILURE');

    expect(await journal.getEnvironmentBinding(scope(runId))).toBeNull();
    expect(await journal.getTurnSnapshot(turnScope(runId, 'turn-fault'))).toBeNull();
    expect(await journal.getKernelRunProjection(scope(runId))).toEqual(expect.objectContaining({
      state: 'created', revision: 1, currentTurnId: null,
    }));
    expect(await journal.countEvents('run.environment_bound')).toBe(0);
    expect(await journal.countEvents('turn.started')).toBe(0);
  });

  it('seals kernel lifecycle event types from the generic journal committer', async () => {
    const { journal, runId, lease } = await fixture();
    await expect(journal.commit({
      projectId: 'project-1', sessionId: 'session-1', runId,
      commandId: 'forged-kernel-event',
      lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken },
      expectedRunRevision: 1,
      events: [{
        type: 'run.environment_bound',
        payload: { environmentBindingId: 'env-forged', digest: '0'.repeat(64) },
      }],
    })).rejects.toMatchObject({ code: 'COMMITTER_REQUIRED' });
  });

  it('reads a run through bounded source-sequence cursors without leaking sibling runs', async () => {
    const first = await fixture('request-a');
    const secondIngress = await first.journal.createRun({
      projectId: 'project-1', sessionId: 'session-1', clientRequestId: 'request-b', input: 'b',
    });
    await first.controller.prepareTurn({
      commandId: 'prepare-a', expectedRunRevision: 1, turnId: 'turn-a',
      environment: environment(), snapshot: snapshot(),
    });
    const secondLease = await first.journal.acquireRunLease({
      projectId: 'project-1', runId: secondIngress.runId, ownerId: 'other', ttlMs: 60_000,
    });
    expect(secondLease.fencingToken).toBe(1);

    const firstPage = await first.journal.readRunEvents({
      projectId: 'project-1', sessionId: 'session-1', runId: first.runId,
      afterSequence: 0, limit: 2,
    });
    const secondPage = await first.journal.readRunEvents({
      projectId: 'project-1', sessionId: 'session-1', runId: first.runId,
      afterSequence: firstPage.events.at(-1)!.sequence, limit: 20,
    });
    expect(firstPage.events).toHaveLength(2);
    expect([...firstPage.events, ...secondPage.events].every((event) =>
      event.runId === first.runId)).toBe(true);
    expect(secondPage.events.every((event) =>
      event.sequence > firstPage.events.at(-1)!.sequence)).toBe(true);
  });

  it('requires exact Project and Session identity for every Kernel read boundary', async () => {
    const { journal, controller, runId } = await fixture();
    await controller.prepareTurn({
      commandId: 'prepare-scoped-read', expectedRunRevision: 1, turnId: 'turn-scoped-read',
      environment: environment(), snapshot: snapshot(),
    });
    const wrongScope = { projectId: 'project-1', sessionId: 'session-other', runId };

    await expect(journal.getKernelRunProjection(wrongScope as never)).rejects.toMatchObject({
      code: 'RUN_IDENTITY_CONFLICT',
    });
    await expect(journal.getEnvironmentBinding(wrongScope as never)).rejects.toMatchObject({
      code: 'RUN_IDENTITY_CONFLICT',
    });
    await expect(journal.getTurnSnapshot({
      ...wrongScope, turnId: 'turn-scoped-read',
    } as never)).rejects.toMatchObject({ code: 'RUN_IDENTITY_CONFLICT' });
    await expect(journal.readRunEvents({
      ...wrongScope, afterSequence: 0, limit: 20,
    })).rejects.toMatchObject({ code: 'RUN_IDENTITY_CONFLICT' });
  });

  it('detects snapshot payload tampering instead of trusting a stale digest', async () => {
    const { journal, controller, runId } = await fixture();
    await controller.prepareTurn({
      commandId: 'prepare-tamper', expectedRunRevision: 1, turnId: 'turn-tamper',
      environment: environment(), snapshot: snapshot(),
    });
    const database = new DatabaseSync(journal.filePath);
    database.prepare(`UPDATE agent_snapshots SET payload_json = ? WHERE snapshot_id = ?`)
      .run(JSON.stringify({ capability: { snapshotId: 'evil', revision: 'evil' } }), 'snapshot-1');
    database.close();
    await expect(journal.getTurnSnapshot(turnScope(runId, 'turn-tamper'))).rejects.toMatchObject({
      code: 'PROJECTION_CORRUPT',
    });
  });

  it('rebuilds Kernel, Environment and Turn Snapshot projections only from Journal facts', async () => {
    const { journal, controller, runId } = await fixture();
    const prepared = await controller.prepareTurn({
      commandId: 'prepare-replay', expectedRunRevision: 1, turnId: 'turn-replay',
      environment: environment(), snapshot: snapshot(),
    });
    const attempt = await validatedTextAttemptFixture('attempt-replay');
    const started = await controller.startModelAttempt({
      commandId: 'start-replay', expectedRunRevision: prepared.run.revision,
      turnId: 'turn-replay', expectedTurnRevision: 1,
      attemptId: attempt.attemptId, origin: attempt.origin,
    });
    const online = {
      run: started.run,
      environment: await journal.getEnvironmentBinding(scope(runId)),
      snapshot: await journal.getTurnSnapshot(turnScope(runId, 'turn-replay')),
    };

    await journal.rebuildProjectProjections('project-1');

    const replayed = {
      run: await journal.getKernelRunProjection(scope(runId)),
      environment: await journal.getEnvironmentBinding(scope(runId)),
      snapshot: await journal.getTurnSnapshot(turnScope(runId, 'turn-replay')),
    };
    expect(replayed).toEqual(online);
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(online));
  });

  it('rejects a stale controller after a lease takeover', async () => {
    let nowMs = Date.parse('2026-08-10T00:00:00.000Z');
    const root = mkdtempSync(join(tmpdir(), 'agent-kernel-'));
    roots.push(root);
    const journal = new SqliteAgentJournal({
      filePath: join(root, 'journal.db'), now: () => new Date(nowMs).toISOString(),
    });
    const ingress = await journal.createRun({
      projectId: 'project-1', sessionId: 'session-1', clientRequestId: 'lease-run', input: 'x',
    });
    const stale = new RunController({
      journal, projectId: 'project-1', sessionId: 'session-1', runId: ingress.runId,
      ownerId: 'owner-stale', leaseTtlMs: 100,
    });
    await stale.acquire();
    nowMs += 101;
    const winner = new RunController({
      journal, projectId: 'project-1', sessionId: 'session-1', runId: ingress.runId,
      ownerId: 'owner-winner', leaseTtlMs: 60_000,
    });
    await winner.acquire();
    await expect(stale.prepareTurn({
      commandId: 'stale-write', expectedRunRevision: 1, turnId: 'turn-stale',
      environment: environment(), snapshot: snapshot(),
    })).rejects.toMatchObject({ code: 'FENCING_TOKEN_STALE' });
  });

  it('binds the exact active Attempt and moves a zero-tool Turn to Finalizing', async () => {
    const { journal, controller, runId } = await fixture();
    const prepared = await controller.prepareTurn({
      commandId: 'prepare-final', expectedRunRevision: 1, turnId: 'turn-final',
      environment: environment(), snapshot: snapshot(),
    });
    const attempt = await validatedTextAttemptFixture('attempt-final');
    const started = await controller.startModelAttempt({
      commandId: 'attempt-start', expectedRunRevision: prepared.run.revision,
      turnId: 'turn-final', expectedTurnRevision: 1,
      attemptId: attempt.attemptId, origin: attempt.origin,
    });
    expect(started.run.state).toBe('ReceivingModel');
    expect(started.run.currentAttemptId).toBe('attempt-final');

    const wrongAttempt = await validatedTextAttemptFixture('attempt-wrong');
    await expect(new RunEventCommitter(journal).commitValidatedAttempt({
      projectId: 'project-1', sessionId: 'session-1', runId, turnId: 'turn-final',
      commandId: 'wrong-attempt',
      lease: { ownerId: 'owner-1', fencingToken: 1 },
      expectedRunRevision: started.run.revision, expectedTurnRevision: 1,
      attempt: wrongAttempt,
    })).rejects.toMatchObject({ code: 'MODEL_COMMIT_CONFLICT' });

    const committed = await new RunEventCommitter(journal).commitValidatedAttempt({
      projectId: 'project-1', sessionId: 'session-1', runId, turnId: 'turn-final',
      commandId: 'right-attempt',
      lease: { ownerId: 'owner-1', fencingToken: 1 },
      expectedRunRevision: started.run.revision, expectedTurnRevision: 1, attempt,
    });
    expect(committed.invocations).toEqual([]);
    expect(await journal.getKernelRunProjection(scope(runId))).toEqual(expect.objectContaining({
      state: 'Finalizing', currentAttemptId: null,
    }));
  });

  it('commits delivery decision, Turn closure and terminal Run atomically', async () => {
    const ready = await finalizingFixture();
    const result = await ready.controller.finalize({
      commandId: 'finalize-1', expectedRunRevision: ready.run.revision,
      turnId: 'turn-final', expectedTurnRevision: 2,
      finalContentRef: 'artifact:final-answer',
      decision: {
        evidenceRevision: 0, status: 'not-required', outcome: 'accepted', evidenceRefs: [],
      },
    });
    expect(result.events.map(({ type }) => type)).toEqual([
      'delivery.decided', 'turn.closed', 'run.completed',
    ]);
    expect(result.run).toEqual(expect.objectContaining({
      state: 'Completed', deliveryStatus: 'not-required',
      finalContentRef: 'artifact:final-answer',
    }));
    const reopened = new SqliteAgentJournal({ filePath: ready.journal.filePath });
    expect(await reopened.getKernelRunProjection(scope(ready.runId))).toEqual(result.run);
    await reopened.rebuildProjectProjections('project-1');
    expect(await reopened.getKernelRunProjection(scope(ready.runId))).toEqual(result.run);
  });

  it('never exposes a partial terminal state when finalization crashes', async () => {
    const ready = await finalizingFixture();
    ready.journal.failKernelAt('after-events-before-projection');
    await expect(ready.controller.finalize({
      commandId: 'finalize-fault', expectedRunRevision: ready.run.revision,
      turnId: 'turn-final', expectedTurnRevision: 2,
      finalContentRef: 'artifact:final-answer',
      decision: {
        evidenceRevision: 0, status: 'not-required', outcome: 'accepted', evidenceRefs: [],
      },
    })).rejects.toThrow('INJECTED_KERNEL_FAILURE');
    expect(await ready.journal.countEvents('delivery.decided')).toBe(0);
    expect(await ready.journal.countEvents('turn.closed')).toBe(0);
    expect(await ready.journal.countEvents('run.completed')).toBe(0);
    expect(await ready.journal.getKernelRunProjection(scope(ready.runId))).toEqual(
      expect.objectContaining({ state: 'Finalizing', deliveryStatus: null }),
    );
  });

  it('persists cancellation intent, waits for the active Attempt, then settles atomically', async () => {
    const { journal, controller, runId } = await fixture();
    const prepared = await controller.prepareTurn({
      commandId: 'prepare-cancel', expectedRunRevision: 1, turnId: 'turn-cancel',
      environment: environment(), snapshot: snapshot(),
    });
    const attempt = await validatedTextAttemptFixture('attempt-cancel');
    const started = await controller.startModelAttempt({
      commandId: 'start-cancel', expectedRunRevision: prepared.run.revision,
      turnId: 'turn-cancel', expectedTurnRevision: 1,
      attemptId: attempt.attemptId, origin: attempt.origin,
    });

    const requested = await controller.requestCancel({
      commandId: 'request-cancel', expectedRunRevision: started.run.revision,
      reason: 'operator-requested',
    });
    expect(requested.events.map(({ type }) => type)).toEqual(['run.cancel_requested']);
    expect(requested.run).toEqual(expect.objectContaining({
      state: 'Cancelling', currentAttemptId: 'attempt-cancel',
    }));
    await expect(controller.settleCancellation({
      commandId: 'settle-too-early', expectedRunRevision: requested.run.revision,
    })).rejects.toMatchObject({ code: 'COMMAND_CONFLICT' });

    const discarded = await controller.discardModelAttempt({
      commandId: 'discard-cancelled-attempt', expectedRunRevision: requested.run.revision,
      turnId: 'turn-cancel', expectedTurnRevision: 1, attemptId: 'attempt-cancel',
      reason: 'run-cancelled',
    });
    expect(discarded.run).toEqual(expect.objectContaining({
      state: 'Cancelling', currentAttemptId: null,
    }));

    const settled = await controller.settleCancellation({
      commandId: 'settle-cancel', expectedRunRevision: discarded.run.revision,
    });
    expect(settled.events.map(({ type }) => type)).toEqual(['turn.closed', 'run.cancelled']);
    expect(settled.run.state).toBe('Cancelled');
    const reopened = new SqliteAgentJournal({ filePath: journal.filePath });
    expect(await reopened.getKernelRunProjection(scope(runId))).toEqual(settled.run);
    await reopened.rebuildProjectProjections('project-1');
    expect(await reopened.getKernelRunProjection(scope(runId))).toEqual(settled.run);
  });

  it('persists a no-progress evidence fingerprint and restores its monotonic cursor', async () => {
    const { journal, controller, runId } = await fixture();
    const prepared = await controller.prepareTurn({
      commandId: 'prepare-no-progress', expectedRunRevision: 1, turnId: 'turn-no-progress',
      environment: environment(), snapshot: snapshot(),
    });
    const database = new DatabaseSync(journal.filePath);
    database.prepare('UPDATE agent_runs SET state = ? WHERE run_id = ?')
      .run('Preparing', runId);
    database.close();
    const fingerprint = 'a'.repeat(64);
    const recorded = await controller.recordNoProgress({
      commandId: 'record-no-progress', expectedRunRevision: prepared.run.revision, fingerprint,
    });
    expect(recorded.events).toEqual([
      expect.objectContaining({ type: 'turn.no_progress', payload: { fingerprint } }),
    ]);
    expect(recorded.run).toEqual(expect.objectContaining({
      state: 'Preparing', noProgressCount: 1,
    }));
    const reopened = new SqliteAgentJournal({ filePath: journal.filePath });
    expect(await reopened.getKernelRunProjection(scope(runId))).toEqual(recorded.run);
    await reopened.rebuildProjectProjections('project-1');
    expect(await reopened.getKernelRunProjection(scope(runId))).toEqual(recorded.run);
  });

  it('rebuilds the exact approval wait projection produced online', async () => {
    const ready = await toolKernelFixture('approval');
    const digest = 'a'.repeat(64);
    const validated = await commitTool(ready.journal, {
      ...ready.toolCommand('validate-approval', ready.invocationRevision), action: 'validate',
      canonicalToolId: { name: 'query_database' }, toolRevision: '1', effect: 'read',
      normalizedArgumentsDigest: digest, authorization: 'ask', approvalSummary: 'Run query',
    });
    expect(validated.approval?.status).toBe('pending');
    const online = await ready.journal.getKernelRunProjection(scope(ready.runId));
    expect(online).toEqual(expect.objectContaining({
      state: 'AwaitingUser', waitReason: 'approval',
    }));

    await ready.journal.rebuildProjectProjections('project-1');
    const replayed = await ready.journal.getKernelRunProjection(scope(ready.runId));
    expect(replayed).toEqual(online);
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(online));
  });

  it('rebuilds the exact evidence revision and digest produced online', async () => {
    const ready = await toolKernelFixture('evidence');
    const digest = 'b'.repeat(64);
    const validated = await commitTool(ready.journal, {
      ...ready.toolCommand('validate-evidence', ready.invocationRevision), action: 'validate',
      canonicalToolId: { name: 'query_database' }, toolRevision: '1', effect: 'read',
      normalizedArgumentsDigest: digest, authorization: 'allow', approvalSummary: 'Run query',
    });
    const started = await commitTool(ready.journal, {
      ...ready.toolCommand('start-evidence', validated.invocation.revision), action: 'start',
      idempotencyKey: 'evidence-invocation', attempt: 1,
    });
    const finished = await commitTool(ready.journal, {
      ...ready.toolCommand('finish-evidence', started.invocation.revision), action: 'finish',
      outcome: 'succeeded', summary: 'Query completed.', resultRefs: [],
      durableSummary: { rowCount: 1 },
    });
    await commitTool(ready.journal, {
      ...ready.toolCommand('observe-evidence', finished.invocation.revision), action: 'observe',
      observation: {
        observationId: 'observation-evidence', invocationId: ready.invocationId,
        summary: 'Query completed.', evidenceRefs: [], outcome: 'succeeded',
        modelProjection: { rows: [{ value: 1 }] },
      },
    });
    const online = await ready.journal.getKernelRunProjection(scope(ready.runId));
    expect(online).toEqual(expect.objectContaining({
      evidenceRevision: 1, evidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));

    await ready.journal.rebuildProjectProjections('project-1');
    const replayed = await ready.journal.getKernelRunProjection(scope(ready.runId));
    expect(replayed).toEqual(online);
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(online));
  });

  it('refuses terminal delivery while the protocol projection still has an active Attempt', async () => {
    const ready = await finalizingFixture();
    const database = new DatabaseSync(ready.journal.filePath);
    database.prepare('UPDATE agent_kernel_runs SET current_attempt_id = ? WHERE run_id = ?')
      .run('attempt-tampered', ready.runId);
    database.close();

    await expect(ready.controller.finalize({
      commandId: 'finalize-with-open-attempt', expectedRunRevision: ready.run.revision,
      turnId: 'turn-final', expectedTurnRevision: 2,
      finalContentRef: 'artifact:final-answer',
      decision: {
        evidenceRevision: 0, status: 'not-required', outcome: 'accepted', evidenceRefs: [],
      },
    })).rejects.toMatchObject({ code: 'COMMAND_CONFLICT' });
    expect(await ready.journal.countEvents('run.completed')).toBe(0);
  });

  it('validates the complete delivery decision before writing terminal facts', async () => {
    const ready = await finalizingFixture();
    await expect(ready.controller.finalize({
      commandId: 'finalize-invalid-decision', expectedRunRevision: ready.run.revision,
      turnId: 'turn-final', expectedTurnRevision: 2,
      finalContentRef: 'artifact:final-answer',
      decision: {
        evidenceRevision: 0, status: 'not-required', outcome: 'failed', evidenceRefs: [],
        unexpected: true,
      } as never,
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await ready.journal.countEvents('delivery.decided')).toBe(0);
  });

  it.each([
    ['delivered', 'not-required'],
    ['pending', 'unverified'],
    ['failed', 'unverified'],
  ] as const)('upcasts v1 delivery %s conservatively to %s', (legacy, expected) => {
    const event = upcastAgentEvent({
      eventId: 'event-1', projectId: 'p', sequence: 1, schemaVersion: 1,
      sessionId: 's', runId: 'r', type: 'run.completed',
      occurredAt: '2026-08-10T00:00:00.000Z',
      payload: {
        finalContentRef: 'artifact:answer', deliveryStatus: legacy, evidenceRefs: [],
      },
    } as never);
    expect((event.payload as { deliveryStatus: string }).deliveryStatus).toBe(expected);
  });
});

async function fixture(clientRequestId = 'request-1') {
  const root = mkdtempSync(join(tmpdir(), 'agent-kernel-'));
  roots.push(root);
  const journal = new SqliteAgentJournal({ filePath: join(root, 'journal.db') });
  const ingress = await journal.createRun({
    projectId: 'project-1', sessionId: 'session-1', clientRequestId, input: 'inspect project',
  });
  const controller = new RunController({
    journal, projectId: 'project-1', sessionId: 'session-1', runId: ingress.runId,
    ownerId: 'owner-1', leaseTtlMs: 60_000,
  });
  const lease = await controller.acquire();
  return { journal, controller, runId: ingress.runId, lease };
}

function environment(): EnvironmentBindingInput {
  return {
    environmentBindingId: 'environment-1',
    settingsRevision: 'settings-r1',
    permissionPolicyRevision: 'permission-r1',
    modelRoute: {
      routeRevision: 'route-r1',
      primary: {
        connectionId: 'connection-1', modelId: 'model-1', protocol: 'openai-responses',
        codecRevision: 'openai-responses@1', maxInputTokens: 131_072, maxOutputTokens: 8_192,
        generation: { temperature: 0.2 },
      },
      fallbacks: [],
    },
  };
}

async function finalizingFixture() {
  const base = await fixture();
  const prepared = await base.controller.prepareTurn({
    commandId: 'prepare-final', expectedRunRevision: 1, turnId: 'turn-final',
    environment: environment(), snapshot: snapshot(),
  });
  const attempt = await validatedTextAttemptFixture('attempt-final');
  const started = await base.controller.startModelAttempt({
    commandId: 'attempt-start', expectedRunRevision: prepared.run.revision,
    turnId: 'turn-final', expectedTurnRevision: 1,
    attemptId: attempt.attemptId, origin: attempt.origin,
  });
  await new RunEventCommitter(base.journal).commitValidatedAttempt({
    projectId: 'project-1', sessionId: 'session-1', runId: base.runId, turnId: 'turn-final',
    commandId: 'attempt-commit', lease: { ownerId: 'owner-1', fencingToken: 1 },
    expectedRunRevision: started.run.revision, expectedTurnRevision: 1, attempt,
  });
  const run = await base.journal.getKernelRunProjection(scope(base.runId));
  if (run === null) throw new Error('Missing prepared Run');
  return { ...base, run };
}

async function toolKernelFixture(label: string) {
  const base = await fixture(`request-${label}`);
  const turnId = `turn-${label}`;
  const prepared = await base.controller.prepareTurn({
    commandId: `prepare-${label}`, expectedRunRevision: 1, turnId,
    environment: toolEnvironment(), snapshot: toolSnapshot(label),
  });
  const attempt = await validatedAttemptFixture(`attempt-${label}`);
  const started = await base.controller.startModelAttempt({
    commandId: `attempt-start-${label}`, expectedRunRevision: prepared.run.revision,
    turnId, expectedTurnRevision: 1, attemptId: attempt.attemptId, origin: attempt.origin,
  });
  const committed = await new RunEventCommitter(base.journal).commitValidatedAttempt({
    projectId: 'project-1', sessionId: 'session-1', runId: base.runId, turnId,
    commandId: `attempt-commit-${label}`, lease: { ownerId: 'owner-1', fencingToken: 1 },
    expectedRunRevision: started.run.revision, expectedTurnRevision: 1, attempt,
  });
  const invocation = committed.invocations[0];
  if (invocation === undefined) throw new Error('Tool fixture has no Invocation.');
  return {
    ...base, turnId, invocationId: invocation.invocationId,
    invocationRevision: invocation.revision,
    toolCommand: (commandId: string, expectedInvocationRevision: number) => ({
      projectId: 'project-1', sessionId: 'session-1', runId: base.runId,
      turnId, invocationId: invocation.invocationId, commandId,
      lease: { ownerId: 'owner-1', fencingToken: 1 },
      expectedRunRevision: 4, expectedInvocationRevision,
    }),
  };
}

function toolEnvironment(): EnvironmentBindingInput {
  return {
    environmentBindingId: 'environment-tool', settingsRevision: 'settings-r1',
    permissionPolicyRevision: 'permission-r1',
    modelRoute: {
      routeRevision: 'route-tool-r1',
      primary: {
        connectionId: 'connection-current', modelId: 'model-current',
        protocol: 'openai-responses', codecRevision: 'openai-responses@1',
        maxInputTokens: 12_288, maxOutputTokens: 4_096, generation: {},
      },
      fallbacks: [],
    },
  };
}

function toolSnapshot(label: string): TurnSnapshotInput {
  return {
    turnSnapshotId: `snapshot-${label}`,
    capability: { snapshotId: `capability-${label}`, revision: 'cap-r1' },
    promptRevision: 'prompt-r1',
    tools: [
      { name: 'query_database', revision: '1' },
      { name: 'read_result', revision: '1' },
    ],
    skills: [], verifiers: [],
  };
}

function commitTool(
  journal: SqliteAgentJournal,
  command: Parameters<ReturnType<typeof openToolLifecycleCommitter>['commit']>[0],
) {
  return openToolLifecycleCommitter(journal).commit(command);
}

function snapshot(): TurnSnapshotInput {
  return {
    turnSnapshotId: 'snapshot-1',
    capability: { snapshotId: 'capability-1', revision: 'cap-r1' },
    promptRevision: 'prompt-r1',
    tools: [{ name: 'workspace_read', revision: 'tool-r1' }],
    skills: [{ id: 'project-guide', revision: 'skill-r1' }],
    verifiers: [{ id: 'delivery', revision: 'verifier-r1', required: true }],
  };
}

function scope(runId: string) {
  return { projectId: 'project-1', sessionId: 'session-1', runId };
}

function turnScope(runId: string, turnId: string) {
  return { ...scope(runId), turnId };
}
