import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunEventCommitter, SqliteAgentJournal } from '../src/index.js';
import { validatedAttemptFixture } from './validated-attempt-fixture.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('authoritative Tool Invocation Journal lifecycle', () => {
  it('persists exact approval, terminal and Observation facts and rebuilds every projection', async () => {
    const fixture = await createFixture();
    const digest = sha256({ sql: 'select 1' });
    const validated = await fixture.journal.commitToolInvocation({
      ...fixture.base('validate', 1), action: 'validate',
      canonicalToolId: { name: 'query_database' }, toolRevision: '1', effect: 'read',
      normalizedArgumentsDigest: digest, authorization: 'ask', approvalSummary: 'Run query',
    });
    expect(validated.invocation.state).toBe('awaiting_approval');
    expect(validated.approval).toMatchObject({
      projectId: 'project-a', sessionId: 'session-a', runId: fixture.runId,
      turnId: 'turn-a', invocationId: fixture.invocationId,
      canonicalToolId: { name: 'query_database' }, toolRevision: '1',
      effect: 'read', normalizedArgumentsDigest: digest, proposedRevision: 1,
      status: 'pending',
    });
    const approved = await fixture.journal.commitToolInvocation({
      ...fixture.base('approve', validated.invocation.revision), action: 'decide-approval',
      approvalId: validated.approval?.approvalId ?? '', canonicalToolId: { name: 'query_database' },
      toolRevision: '1', effect: 'read', normalizedArgumentsDigest: digest,
      proposedRevision: 1, decision: 'approve', decidedBy: 'tester',
    });
    const started = await fixture.journal.commitToolInvocation({
      ...fixture.base('start', approved.invocation.revision), action: 'start',
      idempotencyKey: 'idem-fixture-a', attempt: 1,
    });
    const finished = await fixture.journal.commitToolInvocation({
      ...fixture.base('finish', started.invocation.revision), action: 'finish',
      outcome: 'succeeded', summary: 'Query completed.', resultRefs: [],
      durableSummary: { rowCount: 1 },
    });
    await fixture.journal.commitToolInvocation({
      ...fixture.base('observe', finished.invocation.revision), action: 'observe',
      observation: {
        observationId: 'observation-a', invocationId: fixture.invocationId,
        summary: 'Query completed.', evidenceRefs: [], outcome: 'succeeded',
        modelProjection: { rows: [{ value: 1 }] },
      },
    });

    expect(await fixture.journal.listObservations(fixture.runId)).toHaveLength(1);
    await fixture.journal.rebuildProjectProjections('project-a');
    expect(await fixture.journal.getInvocation(fixture.invocationId)).toMatchObject({
      state: 'observed', revision: 7, terminal: { kind: 'succeeded' },
      observation: { observationId: 'observation-a' },
    });
    expect(await fixture.journal.getApprovalForInvocation(fixture.invocationId)).toMatchObject({
      status: 'approved', canonicalToolId: { name: 'query_database' },
    });
    expect(await fixture.journal.listObservations(fixture.runId)).toHaveLength(1);
  });

  it('uses Invocation CAS so two independent decisions cannot both commit', async () => {
    const fixture = await createFixture();
    const command = (commandId: string) => ({
      ...fixture.base(commandId, 1), action: 'validate' as const,
      canonicalToolId: { name: 'query_database' }, toolRevision: '1', effect: 'read' as const,
      normalizedArgumentsDigest: sha256({ sql: 'select 1' }),
      authorization: 'allow' as const, approvalSummary: 'Run query',
    });
    const settled = await Promise.allSettled([
      fixture.journal.commitToolInvocation(command('validate-a')),
      fixture.journal.commitToolInvocation(command('validate-b')),
    ]);
    expect(settled.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    expect(await fixture.journal.countEvents('tool.validated', 'project-a')).toBe(1);
    expect(await fixture.journal.countEvents('tool.authorized', 'project-a')).toBe(1);
  });
});

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dbagent-tool-journal-'));
  temporaryDirectories.push(directory);
  const journal = new SqliteAgentJournal({ filePath: join(directory, 'state.db') });
  const created = await journal.createRun({
    projectId: 'project-a', sessionId: 'session-a', clientRequestId: 'request-a', input: 'go',
  });
  const lease = await journal.acquireRunLease({
    projectId: 'project-a', runId: created.runId, ownerId: 'worker-a', ttlMs: 60_000,
  });
  const leaseRef = { ownerId: lease.ownerId, fencingToken: lease.fencingToken };
  await journal.startRun({
    projectId: 'project-a', sessionId: 'session-a', runId: created.runId,
    commandId: 'start-run', lease: leaseRef, expectedRunRevision: 1,
  });
  await journal.startTurn({
    projectId: 'project-a', sessionId: 'session-a', runId: created.runId, turnId: 'turn-a',
    commandId: 'start-turn', lease: leaseRef, expectedRunRevision: 2,
  });
  const committed = await new RunEventCommitter(journal).commitValidatedAttempt({
    projectId: 'project-a', sessionId: 'session-a', runId: created.runId, turnId: 'turn-a',
    commandId: 'commit-attempt', lease: leaseRef, expectedRunRevision: 3,
    expectedTurnRevision: 1, attempt: await validatedAttemptFixture('journal-attempt'),
  });
  const invocationId = committed.invocations[0]?.invocationId ?? '';
  return {
    journal, runId: created.runId, invocationId,
    base: (commandId: string, expectedInvocationRevision: number) => ({
      projectId: 'project-a', sessionId: 'session-a', runId: created.runId,
      turnId: 'turn-a', invocationId, commandId, lease: leaseRef,
      expectedRunRevision: 4, expectedInvocationRevision,
    }),
  };
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
