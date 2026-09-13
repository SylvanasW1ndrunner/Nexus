import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createModelSessionBundle, describeModelSessionBundle } from '@dbagent/core-llm';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteAgentJournal } from '../src/events/sqlite-agent-journal.js';
import { openKernelJournalCommitter } from '../src/internal/kernel-journal-authority.js';
import { RunEventCommitter } from '../src/events/run-event-committer.js';
import { validatedTextAttemptFixture } from './validated-attempt-fixture.js';
import { createTestModelSession } from './model-session-fixture.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Journal-backed Context lifecycle', () => {
  it('rebuilds one completed checkpoint and attempt usage exactly once from facts', async () => {
    const fixture = await capturedRun('complete');
    const committer = openKernelJournalCommitter(fixture.journal);
    const started = await committer.commit({
      action: 'start-context-compaction', ...fixture.commandScope,
      commandId: 'context-start-complete', expectedRunRevision: fixture.runRevision,
      checkpointId: 'checkpoint-complete', decisionId: 'decision-complete',
      reason: 'manual', coveredSequence: 17,
    });
    const completion = {
      action: 'complete-context-compaction' as const, ...fixture.commandScope,
      commandId: 'context-complete', expectedRunRevision: started.run.revision,
      checkpointId: 'checkpoint-complete', decisionId: 'decision-complete',
      summaryRef: 'artifact:checkpoint-complete', summary: 'Durable compacted history.',
      coveredSequence: 17, attemptId: 'attempt-context-complete',
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150, cachedInputTokens: 40 },
      billingMode: 'byok' as const,
    };
    const completed = await committer.commit(completion);
    await expect(committer.commit(completion)).resolves.toEqual(completed);
    expect(await fixture.journal.countEvents('context.compacted', 'project-context')).toBe(1);
    expect(await fixture.journal.countEvents('usage.recorded', 'project-context')).toBe(1);

    const scope = {
      projectId: 'project-context', sessionId: 'session-context', runId: fixture.runId,
    };
    const online = {
      run: await fixture.journal.getKernelRunProjection(scope),
      checkpoint: await fixture.journal.getContextCheckpoint({
        ...scope, checkpointId: 'checkpoint-complete',
      }),
      latest: await fixture.journal.getLatestContextCheckpoint(scope),
      usage: await fixture.journal.getRunUsage(scope),
    };
    expect(online).toMatchObject({
      run: { state: 'Preparing' },
      checkpoint: {
        status: 'compacted', summary: 'Durable compacted history.',
        usage: { cachedInputTokens: 40 },
      },
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
    });

    deleteContextProjections(fixture.journal.filePath, fixture.runId);
    await fixture.journal.rebuildProjectProjections('project-context');
    const rebuilt = {
      run: await fixture.journal.getKernelRunProjection(scope),
      checkpoint: await fixture.journal.getContextCheckpoint({
        ...scope, checkpointId: 'checkpoint-complete',
      }),
      latest: await fixture.journal.getLatestContextCheckpoint(scope),
      usage: await fixture.journal.getRunUsage(scope),
    };
    expect(rebuilt).toEqual(online);
    expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(online));
    await fixture.journal.rebuildProjectProjections('project-context');
    expect(await fixture.journal.getRunUsage(scope)).toEqual(online.usage);
    expect(await fixture.journal.countEvents('usage.recorded', 'project-context')).toBe(1);
  });

  it('rebuilds a failed checkpoint without manufacturing usage', async () => {
    const fixture = await capturedRun('failed');
    const committer = openKernelJournalCommitter(fixture.journal);
    const started = await committer.commit({
      action: 'start-context-compaction', ...fixture.commandScope,
      commandId: 'context-start-failed', expectedRunRevision: fixture.runRevision,
      checkpointId: 'checkpoint-failed', decisionId: 'decision-failed',
      reason: 'automatic', coveredSequence: 9,
    });
    await committer.commit({
      action: 'fail-context-compaction', ...fixture.commandScope,
      commandId: 'context-failed', expectedRunRevision: started.run.revision,
      checkpointId: 'checkpoint-failed', decisionId: 'decision-failed',
      code: 'MODEL_TRANSPORT_FAILED',
    });
    const scope = {
      projectId: 'project-context', sessionId: 'session-context', runId: fixture.runId,
    };
    const online = {
      run: await fixture.journal.getKernelRunProjection(scope),
      checkpoint: await fixture.journal.getContextCheckpoint({
        ...scope, checkpointId: 'checkpoint-failed',
      }),
      usage: await fixture.journal.getRunUsage(scope),
    };
    expect(online).toMatchObject({
      run: { state: 'Interrupted' },
      checkpoint: { status: 'failed', failureCode: 'MODEL_TRANSPORT_FAILED' },
      usage: { records: [], inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    });

    deleteContextProjections(fixture.journal.filePath, fixture.runId);
    await fixture.journal.rebuildProjectProjections('project-context');
    expect({
      run: await fixture.journal.getKernelRunProjection(scope),
      checkpoint: await fixture.journal.getContextCheckpoint({
        ...scope, checkpointId: 'checkpoint-failed',
      }),
      usage: await fixture.journal.getRunUsage(scope),
    }).toEqual(online);
  });

  it('persists one manual request during model execution and consumes it once at a later Preparing boundary', async () => {
    const fixture = await capturedRun('manual-queue');
    const committer = openKernelJournalCommitter(fixture.journal);
    const ready = await committer.commit({
      action: 'commit-context-ready', ...fixture.commandScope,
      commandId: 'context-ready-manual-queue', expectedRunRevision: fixture.runRevision,
      turnId: fixture.turnId, expectedTurnRevision: 1,
    });
    expect(ready.run.state).toBe('CallingModel');
    const attempt = await validatedTextAttemptFixture('manual-queue-attempt');
    const receiving = await committer.commit({
      action: 'start-model-attempt', ...fixture.commandScope,
      commandId: 'start-manual-queue-attempt', expectedRunRevision: ready.run.revision,
      turnId: fixture.turnId, expectedTurnRevision: 1,
      attemptId: attempt.attemptId, origin: attempt.origin,
    });
    expect(receiving.run.state).toBe('ReceivingModel');
    const request = {
      action: 'queue-context-compaction' as const, ...fixture.commandScope,
      commandId: 'context-queue-manual', expectedRunRevision: receiving.run.revision,
      decisionId: 'decision-manual-queued',
    };
    const queued = await committer.commit(request);
    await expect(committer.commit(request)).resolves.toEqual(queued);
    expect(await fixture.journal.countEvents(
      'context.compaction_requested', 'project-context',
    )).toBe(1);
    const scope = {
      projectId: 'project-context', sessionId: 'session-context', runId: fixture.runId,
    };
    const pending = await fixture.journal.getPendingContextCompaction(scope);
    expect(pending).toMatchObject({ decisionId: 'decision-manual-queued' });

    const reopened = new SqliteAgentJournal({ filePath: fixture.journal.filePath });
    await expect(openKernelJournalCommitter(reopened).commit(request)).resolves.toEqual(queued);
    expect((await reopened.getKernelRunProjection(scope))?.revision).toBe(queued.run.revision);
    expect(await reopened.getPendingContextCompaction(scope)).toEqual(pending);
    await reopened.rebuildProjectProjections('project-context');
    expect(await reopened.getPendingContextCompaction(scope)).toEqual(pending);

    const lease = await reopened.acquireRunLease({
      projectId: 'project-context', runId: fixture.runId,
      ownerId: 'manual-queue-recovery', ttlMs: 60_000,
    });
    const commandScope = {
      ...scope, lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken },
    };
    const interrupted = await openKernelJournalCommitter(reopened).commit({
      action: 'interrupt-run', ...commandScope,
      commandId: 'interrupt-manual-queue-attempt',
      expectedRunRevision: queued.run.revision,
      code: 'MODEL_TRANSPORT_INTERRUPTED',
    });
    const resumed = await openKernelJournalCommitter(reopened).commit({
      action: 'resume-run', ...commandScope,
      commandId: 'resume-manual-queue-attempt',
      expectedRunRevision: interrupted.run.revision,
      reason: 'continue the persisted Model Attempt',
    });
    expect(resumed.run).toMatchObject({
      state: 'ReceivingModel', currentAttemptId: attempt.attemptId,
    });
    await expect(new RunEventCommitter(reopened).commitValidatedAttempt({
      ...scope, turnId: fixture.turnId, commandId: 'commit-stale-manual-queue-attempt',
      lease: commandScope.lease, expectedRunRevision: queued.run.revision,
      expectedTurnRevision: 1, billingMode: 'byok', attempt,
    })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    const committed = await new RunEventCommitter(reopened).commitValidatedAttempt({
      ...scope, turnId: fixture.turnId, commandId: 'commit-manual-queue-attempt',
      lease: commandScope.lease, expectedRunRevision: resumed.run.revision,
      expectedTurnRevision: 1, billingMode: 'byok', attempt,
    });
    expect(committed.invocations).toEqual([]);
    const finalizing = await reopened.getKernelRunProjection(scope);
    if (finalizing === null) throw new Error('Expected a finalizing Run.');
    const finalized = await openKernelJournalCommitter(reopened).commit({
      action: 'finalize-run', ...commandScope,
      commandId: 'finalize-manual-queue-attempt',
      expectedRunRevision: finalizing.revision,
      turnId: fixture.turnId, expectedTurnRevision: 2,
      finalContentRef: 'artifact:manual-queue-final',
      decision: {
        evidenceRevision: finalizing.evidenceRevision,
        status: 'unverified', outcome: 'revision-requested',
        evidenceRefs: [], reason: 'continue at a fresh Preparing boundary',
        observation: { code: 'CONTINUE_AT_FRESH_PREPARING_BOUNDARY' },
      },
    });
    expect(finalized.run.state).toBe('Preparing');
    const nextTurnId = 'turn-manual-queue-next';
    const nextBoundary = await openKernelJournalCommitter(reopened).commit({
      action: 'capture-turn', ...commandScope,
      commandId: 'capture-next-manual-queue-boundary',
      expectedRunRevision: finalized.run.revision,
      turnId: nextTurnId,
      environment: fixture.environment,
      snapshot: {
        turnSnapshotId: 'snapshot-manual-queue-next',
        capability: { snapshotId: 'capability-manual-queue-next', revision: 'capability-r1' },
        promptRevision: 'prompt-context-r1', tools: [], skills: [], verifiers: [],
      },
    });
    expect(nextBoundary.run).toMatchObject({ state: 'Preparing', currentTurnId: nextTurnId });
    const start = {
      action: 'start-context-compaction' as const, ...commandScope,
      commandId: 'context-start-manual-queue', expectedRunRevision: nextBoundary.run.revision,
      checkpointId: 'checkpoint-manual-queue', decisionId: 'decision-manual-queued',
      reason: 'manual' as const, coveredSequence: 12,
    };
    const started = await openKernelJournalCommitter(reopened).commit(start);
    await expect(openKernelJournalCommitter(reopened).commit(start)).resolves.toEqual(started);
    expect(await reopened.getPendingContextCompaction(scope)).toBeNull();
    expect(await reopened.countEvents('context.compaction_started', 'project-context')).toBe(1);
    await reopened.rebuildProjectProjections('project-context');
    expect(await reopened.getPendingContextCompaction(scope)).toBeNull();
  });
});

async function capturedRun(label: string) {
  const root = await mkdtemp(join(tmpdir(), 'dbagent-context-journal-'));
  roots.push(root);
  const journal = new SqliteAgentJournal({ filePath: join(root, 'journal.db') });
  const created = await journal.createRun({
    projectId: 'project-context', sessionId: 'session-context',
    clientRequestId: `context-${label}`, input: 'compact committed context',
  });
  const lease = await journal.acquireRunLease({
    projectId: 'project-context', runId: created.runId,
    ownerId: `context-worker-${label}`, ttlMs: 60_000,
  });
  const session = await createTestModelSession({
    connectionId: 'connection-1', modelId: 'model-1',
  });
  const environment = {
    environmentBindingId: `environment-${label}`,
    settingsRevision: 'settings-context-r1',
    permissionPolicyRevision: 'permission-context-r1',
    modelSession: describeModelSessionBundle(createModelSessionBundle({ primary: session })),
  };
  const captured = await openKernelJournalCommitter(journal).commit({
    action: 'capture-turn',
    projectId: 'project-context', sessionId: 'session-context', runId: created.runId,
    turnId: `turn-${label}`, commandId: `capture-${label}`,
    lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken },
    expectedRunRevision: 1,
    environment,
    snapshot: {
      turnSnapshotId: `snapshot-${label}`,
      capability: { snapshotId: `capability-${label}`, revision: 'capability-r1' },
      promptRevision: 'prompt-context-r1', tools: [], skills: [], verifiers: [],
    },
  });
  return {
    journal,
    runId: created.runId,
    turnId: `turn-${label}`,
    runRevision: captured.run.revision,
    environment,
    commandScope: {
      projectId: 'project-context', sessionId: 'session-context', runId: created.runId,
      lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken },
    },
  };
}

function deleteContextProjections(filePath: string, runId: string): void {
  const { DatabaseSync: Database } = createRequire(import.meta.url)('node:sqlite') as {
    DatabaseSync: new (path: string) => DatabaseSync;
  };
  const database = new Database(filePath);
  try {
    database.prepare('DELETE FROM agent_context_checkpoints WHERE run_id = ?').run(runId);
    database.prepare('DELETE FROM agent_usage WHERE run_id = ?').run(runId);
  } finally {
    database.close();
  }
}
