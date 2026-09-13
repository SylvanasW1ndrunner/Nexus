import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunEventCommitter, SqliteAgentJournal, type ToolInvocationJournalCommand } from '../src/index.js';
import { openToolLifecycleCommitter } from '../src/internal/tool-lifecycle-authority.js';
import { executionPermissionAudit, permissionAudit, preparedToolIntent } from './permission-audit-fixture.js';
import { validatedAttemptFixture } from './validated-attempt-fixture.js';

const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

describe('authoritative Tool Invocation Journal lifecycle', () => {
  it('persists prepared, approval, terminal, and observation facts with one exact intent binding', async () => {
    const f = await fixture();
    const prepared = await prepare(f, 'read');
    const validated = await lifecycle(f, prepared.invocation.revision, {
      action: 'validate', canonicalToolId: { name: 'query_database' }, toolRevision: 'query_database@1', recoveryClass: 'read', intentDigest: prepared.intentDigest,
      authorization: 'ask', permissionAudit: permissionAudit('ask'), actionSummary: 'Run query', approvalSummary: 'Run query',
    });
    expect(validated.approval).toMatchObject({ recoveryClass: 'read', intentDigest: prepared.intentDigest, status: 'pending' });
    const decided = await lifecycle(f, validated.invocation.revision, {
      action: 'decide-approval', approvalId: validated.approval?.approvalId ?? '', canonicalToolId: { name: 'query_database' }, toolRevision: 'query_database@1',
      recoveryClass: 'read', intentDigest: prepared.intentDigest, proposedRevision: 1, decision: 'approve', decidedBy: 'tester', reason: 'Reviewed.',
    });
    const started = await lifecycle(f, decided.invocation.revision, {
      action: 'start', intentDigest: prepared.intentDigest, idempotencyKey: 'idem-a', attempt: 1, permissionAudit: executionPermissionAudit(),
    });
    const finished = await lifecycle(f, started.invocation.revision, {
      action: 'finish', intentDigest: prepared.intentDigest, outcome: 'succeeded', summary: 'Done.', resultRefs: [], durableSummary: { rowCount: 1 },
    });
    await lifecycle(f, finished.invocation.revision, {
      action: 'observe', observation: { observationId: 'observation-a', invocationId: f.invocationId, summary: 'Done.', evidenceRefs: [], outcome: 'succeeded', modelProjection: { rows: [{ value: 1 }] } },
    });
    expect((await f.journal.getInvocation(f.invocationId))?.state).toBe('observed');
    expect(await f.journal.listObservations(f.runId)).toHaveLength(1);
  });

  it('rejects a lifecycle validation whose digest is not the prepared target', async () => {
    const f = await fixture(); const prepared = await prepare(f, 'read');
    await expect(lifecycle(f, prepared.invocation.revision, {
      action: 'validate', canonicalToolId: { name: 'query_database' }, toolRevision: 'query_database@1', recoveryClass: 'read', intentDigest: 'f'.repeat(64),
      authorization: 'allow', permissionAudit: permissionAudit('allow'), actionSummary: 'Run query', approvalSummary: 'Run query',
    })).rejects.toMatchObject({ code: 'INVOCATION_STATE_CONFLICT' });
  });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dbagent-tool-journal-')); temporaryDirectories.push(directory);
  const journal = new SqliteAgentJournal({ filePath: join(directory, 'state.db') });
  const run = await journal.createRun({ projectId: 'project-a', sessionId: 'session-a', clientRequestId: 'request-a', input: 'go' });
  const lease = await journal.acquireRunLease({ projectId: 'project-a', runId: run.runId, ownerId: 'worker-a', ttlMs: 60_000 });
  const leaseRef = { ownerId: lease.ownerId, fencingToken: lease.fencingToken };
  await journal.startRun({ projectId: 'project-a', sessionId: 'session-a', runId: run.runId, commandId: 'start', lease: leaseRef, expectedRunRevision: 1 });
  await journal.startTurn({ projectId: 'project-a', sessionId: 'session-a', runId: run.runId, turnId: 'turn-a', commandId: 'turn', lease: leaseRef, expectedRunRevision: 2 });
  const committed = await new RunEventCommitter(journal).commitValidatedAttempt({ projectId: 'project-a', sessionId: 'session-a', runId: run.runId, turnId: 'turn-a', commandId: 'attempt', lease: leaseRef, expectedRunRevision: 3, expectedTurnRevision: 1, billingMode: 'byok', attempt: await validatedAttemptFixture('journal-attempt') });
  return { journal, runId: run.runId, lease: leaseRef, invocationId: committed.invocations[0]?.invocationId ?? '' };
}

async function prepare(f: Awaited<ReturnType<typeof fixture>>, recoveryClass: 'read' | 'non_idempotent') {
  const invocation = await f.journal.getInvocation(f.invocationId); const run = await f.journal.getRunProjection(f.runId);
  if (invocation === null || run === null) throw new Error('Missing invocation.');
  const p = preparedToolIntent({ toolName: 'query_database', toolRevision: 'query_database@1', handlerRevision: 'query_database-handler@1', recoveryClass });
  const result = await openToolLifecycleCommitter(f.journal).commit({ action: 'prepare', projectId: 'project-a', sessionId: 'session-a', runId: f.runId, turnId: 'turn-a', invocationId: f.invocationId, commandId: 'prepare', lease: f.lease, expectedRunRevision: run.revision, expectedInvocationRevision: invocation.revision, canonicalToolId: { name: 'query_database' }, catalogRevision: 'catalog@test', intent: p.intent, intentDigest: p.intentDigest, deadline: new Date(Date.now() + 60_000).toISOString() });
  return { ...p, invocation: result.invocation };
}

type LifecycleInput = ToolInvocationJournalCommand extends infer Command
  ? Command extends { action: 'validate' | 'decide-approval' | 'start' | 'finish' | 'observe' }
    ? Omit<Command, 'projectId' | 'sessionId' | 'runId' | 'turnId' | 'invocationId' | 'commandId' | 'lease' | 'expectedRunRevision' | 'expectedInvocationRevision'>
    : never
  : never;

async function lifecycle(
  f: Awaited<ReturnType<typeof fixture>>,
  expectedInvocationRevision: number,
  command: LifecycleInput,
) {
  const run = await f.journal.getRunProjection(f.runId); if (run === null) throw new Error('Missing run.');
  const complete: ToolInvocationJournalCommand = {
    ...command,
    projectId: 'project-a', sessionId: 'session-a', runId: f.runId, turnId: 'turn-a',
    invocationId: f.invocationId, commandId: `command-${command.action}-${expectedInvocationRevision}`,
    lease: f.lease, expectedRunRevision: run.revision, expectedInvocationRevision,
  };
  return await openToolLifecycleCommitter(f.journal).commit(complete);
}
