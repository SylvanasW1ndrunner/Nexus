import { executionPermissionAudit, permissionAudit, preparedToolIntent } from './permission-audit-fixture.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';
import { createModelSessionBundle, describeModelSessionBundle } from '@dbagent/core-llm';
import { afterEach, describe, expect, it } from 'vitest';
import { RunEventCommitter } from '../src/events/run-event-committer.js';
import { SqliteAgentJournal } from '../src/events/sqlite-agent-journal.js';
import { upcastAgentEvent } from '../src/events/event-upcasters.js';
import { openToolLifecycleCommitter } from '../src/internal/tool-lifecycle-authority.js';
import {
  RunController,
  type EnvironmentBindingInput,
  type TurnSnapshotInput,
} from '../src/kernel/run-controller.js';
import { createTestModelSession } from './model-session-fixture.js';
import { validatedAttemptFixture, validatedTextAttemptFixture } from './validated-attempt-fixture.js';

const roots: string[] = [];
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => NodeDatabaseSync;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('journal-driven RunController', () => {
  it('atomically captures immutable turn inputs before context becomes ready', async () => {
    const { journal, controller, runId } = await fixture();
    const expectedEnvironment = await environment();
    const captured = await controller.captureTurn({
      commandId: 'prepare-1',
      expectedRunRevision: 1,
      turnId: 'turn-1',
      environment: expectedEnvironment,
      snapshot: snapshot(),
    });
    expect(captured.run.state).toBe('Preparing');
    const prepared = await controller.commitContextReady({
      commandId: 'context-ready-1',
      expectedRunRevision: captured.run.revision,
      turnId: 'turn-1',
      expectedTurnRevision: 1,
    });

    expect(prepared.run.state).toBe('CallingModel');
    expect(prepared.run.currentTurnId).toBe('turn-1');
    expect(captured.environment.payload.modelSession).toEqual(expectedEnvironment.modelSession);
    expect(captured.snapshot.payload.capability.revision).toBe('cap-r1');
    expect(captured.snapshot.payload.runtimeProtocol?.content).toEqual([
      { type: 'text', text: 'Follow the durable protocol.' },
    ]);
    expect(captured.snapshot.payload.promptSections?.[0]?.content).toEqual([
      { type: 'text', text: 'Captured project instructions.' },
    ]);
    expect(captured.snapshot.environmentBindingId).toBe(captured.environment.environmentBindingId);

    const reopened = new SqliteAgentJournal({ filePath: journal.filePath });
    expect(await reopened.getKernelRunProjection(scope(runId))).toEqual(prepared.run);
    expect(await reopened.getEnvironmentBinding(scope(runId))).toEqual(captured.environment);
    expect(await reopened.getTurnSnapshot(turnScope(runId, 'turn-1'))).toEqual(captured.snapshot);
  });

  it('durably captures discoverable Capability external-context activation metadata', async () => {
    const { journal, controller, runId } = await fixture();
    const input = snapshot();
    const activation = {
      kind: 'external_context' as const,
      selection: 'automatic' as const,
      providerId: 'fixture-provider',
      probeRevision: 'fixture-probe.v1',
      candidates: [{ candidateId: 'fixture', label: 'Fixture', fingerprint: 'fixture-fingerprint' }],
    };

    const captured = await controller.captureTurn({
      commandId: 'prepare-capability-activation', expectedRunRevision: 1, turnId: 'turn-capability-activation',
      environment: await environment(),
      snapshot: {
        ...input,
        turnSnapshotId: 'snapshot-capability-activation',
        discoverableCapabilities: [{
          name: 'fixture.capability', description: 'Fixture external Capability.', status: 'available',
          target: { moduleId: 'fixture.module', instanceId: 'primary' }, activation,
        }],
      },
    });

    expect(captured.snapshot.payload.discoverableCapabilities).toEqual([expect.objectContaining({
      name: 'fixture.capability', activation,
    })]);
    const reopened = new SqliteAgentJournal({ filePath: journal.filePath });
    expect((await reopened.getTurnSnapshot(turnScope(runId, 'turn-capability-activation')))?.payload.discoverableCapabilities).toEqual(captured.snapshot.payload.discoverableCapabilities);
  });

  it('rolls back both facts and projections at every injected prepare boundary', async () => {
    const { journal, controller, runId } = await fixture();
    journal.failKernelAt('after-events-before-projection');
    await expect(controller.captureTurn({
      commandId: 'prepare-fault', expectedRunRevision: 1, turnId: 'turn-fault',
      environment: await environment(), snapshot: snapshot(),
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
    await first.controller.captureTurn({
      commandId: 'prepare-a', expectedRunRevision: 1, turnId: 'turn-a',
      environment: await environment(), snapshot: snapshot(),
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
    await controller.captureTurn({
      commandId: 'prepare-scoped-read', expectedRunRevision: 1, turnId: 'turn-scoped-read',
      environment: await environment(), snapshot: snapshot(),
    });
    const wrongScope = { projectId: 'project-1', sessionId: 'session-other', runId };

    await expect(journal.getKernelRunProjection(wrongScope)).rejects.toMatchObject({
      code: 'RUN_IDENTITY_CONFLICT',
    });
    await expect(journal.getEnvironmentBinding(wrongScope)).rejects.toMatchObject({
      code: 'RUN_IDENTITY_CONFLICT',
    });
    await expect(journal.getTurnSnapshot({
      ...wrongScope, turnId: 'turn-scoped-read',
    })).rejects.toMatchObject({ code: 'RUN_IDENTITY_CONFLICT' });
    await expect(journal.readRunEvents({
      ...wrongScope, afterSequence: 0, limit: 20,
    })).rejects.toMatchObject({ code: 'RUN_IDENTITY_CONFLICT' });
  });

  it('detects snapshot payload tampering instead of trusting a stale digest', async () => {
    const { journal, controller, runId } = await fixture();
    await controller.captureTurn({
      commandId: 'prepare-tamper', expectedRunRevision: 1, turnId: 'turn-tamper',
      environment: await environment(), snapshot: snapshot(),
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
    const prepared = await captureReadyTurn(controller, {
      commandId: 'prepare-replay', expectedRunRevision: 1, turnId: 'turn-replay',
      environment: await environment(), snapshot: snapshot(),
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
    await expect(stale.captureTurn({
      commandId: 'stale-write', expectedRunRevision: 1, turnId: 'turn-stale',
      environment: await environment(), snapshot: snapshot(),
    })).rejects.toMatchObject({ code: 'RUN_LEASE_LOST' });
  });

  it('binds the exact active Attempt and moves a zero-tool Turn to Finalizing', async () => {
    const { journal, controller, runId } = await fixture();
    const prepared = await captureReadyTurn(controller, {
      commandId: 'prepare-final', expectedRunRevision: 1, turnId: 'turn-final',
      environment: await environment(), snapshot: snapshot(),
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
      billingMode: 'byok',
      attempt: wrongAttempt,
    })).rejects.toMatchObject({ code: 'MODEL_COMMIT_CONFLICT' });

    const committed = await new RunEventCommitter(journal).commitValidatedAttempt({
      projectId: 'project-1', sessionId: 'session-1', runId, turnId: 'turn-final',
      commandId: 'right-attempt',
      lease: { ownerId: 'owner-1', fencingToken: 1 },
      expectedRunRevision: started.run.revision, expectedTurnRevision: 1, billingMode: 'byok', attempt,
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
    await expect(reopened.getRunCompletion(scope(ready.runId))).resolves.toMatchObject({
      finalContentRef: 'artifact:final-answer',
      deliveryStatus: 'not-required',
      evidenceRefs: [],
    });
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
    const prepared = await captureReadyTurn(controller, {
      commandId: 'prepare-cancel', expectedRunRevision: 1, turnId: 'turn-cancel',
      environment: await environment(), snapshot: snapshot(),
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

  it('settles cancellation when a closed Turn remains projected across a boundary race', async () => {
    const ready = await finalizingFixture();
    const revised = await ready.controller.finalize({
      commandId: 'request-delivery-revision', expectedRunRevision: ready.run.revision,
      turnId: 'turn-final', expectedTurnRevision: 2,
      finalContentRef: 'artifact:pending-answer',
      decision: {
        evidenceRevision: 0, status: 'unverified', outcome: 'revision-requested',
        verifierId: 'fixture-completion-guard', verifierRevision: 'v1', evidenceRefs: [],
        observation: { issue: 'pending-action-final' },
      },
    });
    expect(revised.run).toEqual(expect.objectContaining({
      state: 'Preparing', currentTurnId: null,
    }));
    const requested = await ready.controller.requestCancel({
      commandId: 'cancel-after-delivery-revision',
      expectedRunRevision: revised.run.revision,
      reason: 'deadline',
    });
    const database = new DatabaseSync(ready.journal.filePath);
    database.prepare(
      'UPDATE agent_kernel_runs SET current_turn_id = ? WHERE run_id = ?',
    ).run('turn-final', ready.runId);
    database.close();
    const settled = await ready.controller.settleCancellation({
      commandId: 'settle-after-delivery-revision',
      expectedRunRevision: requested.run.revision,
    });

    expect(settled.events.map(({ type }) => type)).toEqual(['run.cancelled']);
    expect(settled.run.state).toBe('Cancelled');
    expect(await ready.journal.countEvents('turn.closed')).toBe(1);
  });

  it('persists a no-progress evidence fingerprint and restores its monotonic cursor', async () => {
    const ready = await toolKernelFixture('no-progress');
    const validated = await commitTool(ready.journal, {
      ...await ready.toolCommand('validate-no-progress', ready.invocationRevision), action: 'validate',
      canonicalToolId: { name: 'query_database' }, toolRevision: '1', recoveryClass: 'read',
      intentDigest: ready.intentDigest(ready.invocationId), authorization: 'allow', permissionAudit: permissionAudit('allow'), actionSummary: 'Run query', approvalSummary: 'Run query',
    });
    const started = await commitTool(ready.journal, {
      ...await ready.toolCommand('start-no-progress', validated.invocation.revision), action: 'start',
      intentDigest: ready.intentDigest(ready.invocationId), idempotencyKey: 'no-progress-invocation', attempt: 1, permissionAudit: executionPermissionAudit(),
    });
    const finished = await commitTool(ready.journal, {
      ...await ready.toolCommand('finish-no-progress', started.invocation.revision), action: 'finish',
      intentDigest: ready.intentDigest(ready.invocationId), outcome: 'succeeded', summary: 'Query completed.', resultRefs: [],
      durableSummary: { rowCount: 1 },
    });
    await commitTool(ready.journal, {
      ...await ready.toolCommand('observe-no-progress', finished.invocation.revision), action: 'observe',
      observation: {
        observationId: 'observation-no-progress', invocationId: ready.invocationId,
        summary: 'Query completed.', evidenceRefs: [], outcome: 'succeeded',
        modelProjection: { rows: [{ value: 1 }] },
      },
    });
    const secondary = ready.secondaryInvocation;
    if (secondary === undefined) throw new Error('Tool fixture has no secondary Invocation.');
    const secondaryValidated = await commitTool(ready.journal, {
      ...await ready.toolCommand(
        'validate-no-progress-result', secondary.revision, secondary,
      ),
      action: 'validate', canonicalToolId: { name: 'read_result' }, toolRevision: '1',
      recoveryClass: 'read', intentDigest: ready.intentDigest(secondary.invocationId), authorization: 'allow', permissionAudit: permissionAudit('allow', 'read', 'read_result'),
      actionSummary: 'Read query result',
      approvalSummary: 'Read query result',
    });
    const secondaryStarted = await commitTool(ready.journal, {
      ...await ready.toolCommand(
        'start-no-progress-result', secondaryValidated.invocation.revision, secondary,
      ),
      action: 'start', idempotencyKey: 'no-progress-result-invocation', attempt: 1, permissionAudit: executionPermissionAudit('read', 'read_result'),
      intentDigest: ready.intentDigest(secondary.invocationId),
    });
    const secondaryFinished = await commitTool(ready.journal, {
      ...await ready.toolCommand(
        'finish-no-progress-result', secondaryStarted.invocation.revision, secondary,
      ),
      action: 'finish', outcome: 'succeeded', summary: 'Result page read.', resultRefs: [],
      intentDigest: ready.intentDigest(secondary.invocationId),
      durableSummary: { rowCount: 1 },
    });
    await commitTool(ready.journal, {
      ...await ready.toolCommand(
        'observe-no-progress-result', secondaryFinished.invocation.revision, secondary,
      ),
      action: 'observe',
      observation: {
        observationId: 'observation-no-progress-result', invocationId: secondary.invocationId,
        summary: 'Result page read.', evidenceRefs: [], outcome: 'succeeded',
        modelProjection: { rows: [{ value: 1 }] },
      },
    });
    const observedRun = await ready.journal.getKernelRunProjection(scope(ready.runId));
    if (observedRun === null) throw new Error('Missing observed Run projection.');
    const closed = await ready.controller.closeObservedTurn({
      commandId: 'close-no-progress',
      expectedRunRevision: observedRun.revision,
      turnId: ready.turnId,
      expectedTurnRevision: 2,
    });
    const fingerprint = 'a'.repeat(64);
    const recorded = await ready.controller.recordNoProgress({
      commandId: 'record-no-progress', expectedRunRevision: closed.run.revision,
      turnId: ready.turnId, fingerprint,
    });
    expect(recorded.events).toEqual([
      expect.objectContaining({ type: 'turn.no_progress', payload: { fingerprint } }),
    ]);
    expect(recorded.run).toEqual(expect.objectContaining({
      state: 'Preparing', noProgressCount: 1,
    }));
    const reopened = new SqliteAgentJournal({ filePath: ready.journal.filePath });
    expect(await reopened.getKernelRunProjection(scope(ready.runId))).toEqual(recorded.run);
    await reopened.rebuildProjectProjections('project-1');
    expect(await reopened.getKernelRunProjection(scope(ready.runId))).toEqual(recorded.run);
  });

  it('rebuilds the exact approval wait projection produced online', async () => {
    const ready = await toolKernelFixture('approval');
    const validated = await commitTool(ready.journal, {
      ...await ready.toolCommand('validate-approval', ready.invocationRevision), action: 'validate',
      canonicalToolId: { name: 'query_database' }, toolRevision: '1', recoveryClass: 'read',
      intentDigest: ready.intentDigest(ready.invocationId), authorization: 'ask', permissionAudit: permissionAudit('ask'), actionSummary: 'Run query', approvalSummary: 'Run query',
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
    const validated = await commitTool(ready.journal, {
      ...await ready.toolCommand('validate-evidence', ready.invocationRevision), action: 'validate',
      canonicalToolId: { name: 'query_database' }, toolRevision: '1', recoveryClass: 'read',
      intentDigest: ready.intentDigest(ready.invocationId), authorization: 'allow', permissionAudit: permissionAudit('allow'), actionSummary: 'Run query', approvalSummary: 'Run query',
    });
    const started = await commitTool(ready.journal, {
      ...await ready.toolCommand('start-evidence', validated.invocation.revision), action: 'start',
      intentDigest: ready.intentDigest(ready.invocationId), idempotencyKey: 'evidence-invocation', attempt: 1, permissionAudit: executionPermissionAudit(),
    });
    const finished = await commitTool(ready.journal, {
      ...await ready.toolCommand('finish-evidence', started.invocation.revision), action: 'finish',
      intentDigest: ready.intentDigest(ready.invocationId), outcome: 'succeeded', summary: 'Query completed.', resultRefs: [],
      durableSummary: { rowCount: 1 },
    });
    await commitTool(ready.journal, {
      ...await ready.toolCommand('observe-evidence', finished.invocation.revision), action: 'observe',
      observation: {
        observationId: 'observation-evidence', invocationId: ready.invocationId,
        summary: 'Query completed.', evidenceRefs: [], outcome: 'succeeded',
        modelProjection: { rows: [{ value: 1 }] },
      },
    });
    const online = await ready.journal.getKernelRunProjection(scope(ready.runId));
    if (online === null) throw new Error('Missing online Kernel projection.');
    expect(online.evidenceRevision).toBe(1);
    expect(online.evidenceDigest).toMatch(/^[a-f0-9]{64}$/u);

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

let environmentBinding: Promise<EnvironmentBindingInput> | undefined;

function environment(): Promise<EnvironmentBindingInput> {
  environmentBinding ??= createEnvironmentBinding(
    'environment-1', 'connection-1', 'model-1',
  );
  return environmentBinding;
}

async function createEnvironmentBinding(
  environmentBindingId: string,
  connectionId: string,
  modelId: string,
): Promise<EnvironmentBindingInput> {
  const session = await createTestModelSession({ connectionId, modelId });
  return {
    environmentBindingId,
    settingsRevision: 'settings-r1',
    permissionPolicyRevision: 'permission-r1',
    modelSession: describeModelSessionBundle(createModelSessionBundle({ primary: session })),
  };
}

async function finalizingFixture() {
  const base = await fixture();
  const prepared = await captureReadyTurn(base.controller, {
    commandId: 'prepare-final', expectedRunRevision: 1, turnId: 'turn-final',
    environment: await environment(), snapshot: snapshot(),
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
    expectedRunRevision: started.run.revision, expectedTurnRevision: 1, billingMode: 'byok', attempt,
  });
  const run = await base.journal.getKernelRunProjection(scope(base.runId));
  if (run === null) throw new Error('Missing prepared Run');
  return { ...base, run };
}

async function toolKernelFixture(label: string) {
  const base = await fixture(`request-${label}`);
  const turnId = `turn-${label}`;
  const prepared = await captureReadyTurn(base.controller, {
    commandId: `prepare-${label}`, expectedRunRevision: 1, turnId,
    environment: await toolEnvironment(), snapshot: toolSnapshot(label),
  });
  const attempt = await validatedAttemptFixture(`attempt-${label}`);
  const started = await base.controller.startModelAttempt({
    commandId: `attempt-start-${label}`, expectedRunRevision: prepared.run.revision,
    turnId, expectedTurnRevision: 1, attemptId: attempt.attemptId, origin: attempt.origin,
  });
  const committed = await new RunEventCommitter(base.journal).commitValidatedAttempt({
    projectId: 'project-1', sessionId: 'session-1', runId: base.runId, turnId,
    commandId: `attempt-commit-${label}`, lease: { ownerId: 'owner-1', fencingToken: 1 },
    expectedRunRevision: started.run.revision, expectedTurnRevision: 1, billingMode: 'byok', attempt,
  });
  const invocation = committed.invocations[0];
  if (invocation === undefined) throw new Error('Tool fixture has no Invocation.');
  const preparedResults = new Map<string, Awaited<ReturnType<ReturnType<typeof openToolLifecycleCommitter>['commit']>>>();
  for (const [index, target] of committed.invocations.entries()) {
    const name = index === 0 ? 'query_database' : 'read_result';
    const intent = preparedToolIntent({ toolName: name, toolRevision: '1', handlerRevision: `${name}-handler@1` });
    const run = await currentRunRevision(base.journal, base.runId);
    preparedResults.set(target.invocationId, await openToolLifecycleCommitter(base.journal).commit({
      projectId: 'project-1', sessionId: 'session-1', runId: base.runId, turnId,
      invocationId: target.invocationId, commandId: `prepare-tool-${label}-${index}`,
      lease: { ownerId: 'owner-1', fencingToken: 1 }, expectedRunRevision: run,
      expectedInvocationRevision: target.revision, action: 'prepare',
      canonicalToolId: { name }, catalogRevision: 'fixture-catalog@1',
      intent: intent.intent, intentDigest: intent.intentDigest, deadline: '2030-01-01T00:00:00.000Z',
    }));
  }
  const preparedInvocation = preparedResults.get(invocation.invocationId);
  if (preparedInvocation === undefined) throw new Error('Tool preparation did not commit.');
  return {
    ...base, turnId, invocationId: invocation.invocationId,
    invocationRevision: preparedInvocation.invocation.revision,
    secondaryInvocation: committed.invocations[1] === undefined ? undefined : preparedResults.get(committed.invocations[1].invocationId)?.invocation,
    toolCommand: async (
      commandId: string,
      expectedInvocationRevision: number,
      targetInvocation: typeof invocation = invocation,
    ) => ({
      projectId: 'project-1', sessionId: 'session-1', runId: base.runId,
      turnId, invocationId: targetInvocation.invocationId, commandId,
      lease: { ownerId: 'owner-1', fencingToken: 1 },
      expectedRunRevision: await currentRunRevision(base.journal, base.runId),
      expectedInvocationRevision,
    }),
    intentDigest: (invocationId: string) => preparedResults.get(invocationId)?.invocation.intentDigest ?? '',
  };
}

async function currentRunRevision(journal: SqliteAgentJournal, runId: string): Promise<number> {
  const run = await journal.getKernelRunProjection(scope(runId));
  if (run === null) throw new Error('Expected Kernel Run projection.');
  return run.revision;
}

let toolEnvironmentBinding: Promise<EnvironmentBindingInput> | undefined;

function toolEnvironment(): Promise<EnvironmentBindingInput> {
  toolEnvironmentBinding ??= createEnvironmentBinding(
    'environment-tool', 'connection-current', 'model-current',
  );
  return toolEnvironmentBinding;
}

function toolSnapshot(label: string): TurnSnapshotInput {
  return {
    turnSnapshotId: `snapshot-${label}`,
    capability: { snapshotId: `capability-${label}`, revision: 'cap-r1' },
    promptRevision: 'prompt-r1',
    runtimeProtocol: {
      id: 'runtime-protocol', source: 'runtime', scope: 'static', priority: 0,
      revision: 'runtime-r1', cacheability: 'stable', tokenEstimate: 4,
      content: [{ type: 'text', text: 'Follow the durable protocol.' }],
    },
    promptSections: [{
      id: 'project-instructions', source: 'project', scope: 'turn', priority: 10,
      revision: 'project-r1', cacheability: 'stable', tokenEstimate: 4,
      content: [{ type: 'text', text: 'Captured project instructions.' }],
    }],
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

async function captureReadyTurn(
  controller: RunController,
  input: Parameters<RunController['captureTurn']>[0],
) {
  const captured = await controller.captureTurn(input);
  return await controller.commitContextReady({
    commandId: `${input.commandId}:context-ready`,
    expectedRunRevision: captured.run.revision,
    turnId: input.turnId,
    expectedTurnRevision: 1,
  });
}

function snapshot(): TurnSnapshotInput {
  return {
    turnSnapshotId: 'snapshot-1',
    capability: { snapshotId: 'capability-1', revision: 'cap-r1' },
    promptRevision: 'prompt-r1',
    runtimeProtocol: {
      id: 'runtime-protocol', source: 'runtime', scope: 'static', priority: 0,
      revision: 'runtime-r1', cacheability: 'stable', tokenEstimate: 4,
      content: [{ type: 'text', text: 'Follow the durable protocol.' }],
    },
    promptSections: [{
      id: 'project-instructions', source: 'project', scope: 'turn', priority: 10,
      revision: 'project-r1', cacheability: 'stable', tokenEstimate: 4,
      content: [{ type: 'text', text: 'Captured project instructions.' }],
    }],
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
