import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunEventCommitter, SqliteAgentJournal } from '../src/index.js';
import type { ToolInvocationJournalCommand } from '../src/events/agent-journal.js';
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

  it('rejects oversized approval text before cloning or hashing the command', async () => {
    const fixture = await createFixture();
    const command = {
      ...fixture.base('validate-too-large', 1), action: 'validate' as const,
      canonicalToolId: { name: 'query_database' }, toolRevision: '1', effect: 'read' as const,
      normalizedArgumentsDigest: sha256({ sql: 'select 1' }),
      authorization: 'ask' as const, approvalSummary: 'x'.repeat(2_001),
    };

    await expect(fixture.journal.commitToolInvocation(command))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect((await fixture.journal.getInvocation(fixture.invocationId))?.state).toBe('proposed');
    expect(await fixture.journal.countEvents('tool.validated', 'project-a')).toBe(0);
  });

  it('hard-bounds approval decision provenance at Journal ingress', async () => {
    const fixture = await createFixture();
    const digest = sha256({ sql: 'select 1' });
    const validated = await fixture.journal.commitToolInvocation({
      ...fixture.base('validate-for-bounds', 1), action: 'validate',
      canonicalToolId: { name: 'query_database' }, toolRevision: '1', effect: 'read',
      normalizedArgumentsDigest: digest, authorization: 'ask', approvalSummary: 'Run query',
    });
    const base = {
      ...fixture.base('decision-too-large', validated.invocation.revision),
      action: 'decide-approval' as const,
      approvalId: validated.approval?.approvalId ?? '',
      canonicalToolId: { name: 'query_database' }, toolRevision: '1', effect: 'read' as const,
      normalizedArgumentsDigest: digest, proposedRevision: 1,
      decision: 'approve' as const,
    };

    await expect(fixture.journal.commitToolInvocation({
      ...base, decidedBy: 'x'.repeat(257),
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(fixture.journal.commitToolInvocation({
      ...base, commandId: 'reason-too-large', reason: 'x'.repeat(2_001),
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await fixture.journal.getApprovalForInvocation(fixture.invocationId))
      .toMatchObject({ status: 'pending' });
  });

  it('rejects oversized or unsupported result references before terminal commit', async () => {
    const fixture = await createFixture();
    const digest = sha256({ sql: 'select 1' });
    const validated = await fixture.journal.commitToolInvocation({
      ...fixture.base('validate-for-results', 1), action: 'validate',
      canonicalToolId: { name: 'query_database' }, toolRevision: '1', effect: 'read',
      normalizedArgumentsDigest: digest, authorization: 'allow', approvalSummary: 'Run query',
    });
    const started = await fixture.journal.commitToolInvocation({
      ...fixture.base('start-for-results', validated.invocation.revision), action: 'start',
      idempotencyKey: 'idem-result-bounds', attempt: 1,
    });
    const finishBase = {
      ...fixture.base('finish-result-bounds', started.invocation.revision),
      action: 'finish' as const, outcome: 'succeeded' as const,
      summary: 'Completed.', resultRefs: [] as string[],
    };

    await expect(fixture.journal.commitToolInvocation({
      ...finishBase, summary: 'x'.repeat(4_097),
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(fixture.journal.commitToolInvocation({
      ...finishBase,
      commandId: 'too-many-result-refs',
      resultRefs: Array.from({ length: 33 }, (_, index) =>
        `agent-artifact:${'a'.repeat(24)}:${index.toString(16).padStart(40, '0')}`),
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(fixture.journal.commitToolInvocation({
      ...finishBase, commandId: 'invalid-result-ref', resultRefs: ['https://example.test/result'],
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect((await fixture.journal.getInvocation(fixture.invocationId))?.state).toBe('started');
    expect(await fixture.journal.countEvents('tool.succeeded', 'project-a')).toBe(0);
  });

  it.each([
    'validate', 'reject-validation', 'decide-approval', 'start', 'finish', 'observe',
    'authorize-retry', 'resolve-outcome',
  ] as const)('rejects accessor ingress for the %s action without invoking it', async (action) => {
    const journal = await emptyJournal();
    const command = commandForSnapshot(action) as unknown as Record<string, unknown>;
    let getterCalls = 0;
    Object.defineProperty(command, 'commandId', {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return `accessor-${action}`;
      },
    });

    await expect(journal.commitToolInvocation(command as ToolInvocationJournalCommand))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(getterCalls).toBe(0);
  });

  it('rejects Proxy, cycle, sparse array, symbol and action-extraneous keys at ingress', async () => {
    const journal = await emptyJournal();
    const proxied = new Proxy(commandForSnapshot('start'), {});
    await expect(journal.commitToolInvocation(proxied))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    const cyclicObservation: Record<string, unknown> = {
      observationId: 'observation-a', invocationId: 'invocation-a',
      summary: 'done', evidenceRefs: [], outcome: 'succeeded',
    };
    cyclicObservation.self = cyclicObservation;
    await expect(journal.commitToolInvocation({
      ...commandForSnapshot('observe'), observation: cyclicObservation,
    } as ToolInvocationJournalCommand)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    const sparseRefs = new Array<string>(1);
    await expect(journal.commitToolInvocation({
      ...commandForSnapshot('finish'), resultRefs: sparseRefs,
    } as ToolInvocationJournalCommand)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    const withSymbol: ToolInvocationJournalCommand & {
      [key: symbol]: string;
    } = commandForSnapshot('start');
    withSymbol[Symbol('unexpected')] = 'value';
    await expect(journal.commitToolInvocation(withSymbol))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    await expect(journal.commitToolInvocation({
      ...commandForSnapshot('start'), reason: 'belongs to another action',
    } as ToolInvocationJournalCommand)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('captures nested command data before yielding so caller mutation cannot change identity', async () => {
    const fixture = await createFixture();
    const canonicalToolId = { name: 'query_database' };
    const lease = { ...fixture.base('snapshot-before-yield', 1).lease };
    const command = {
      ...fixture.base('snapshot-before-yield', 1),
      lease,
      action: 'validate' as const,
      canonicalToolId,
      toolRevision: '1',
      effect: 'read' as const,
      normalizedArgumentsDigest: sha256({ sql: 'select 1' }),
      authorization: 'allow' as const,
      approvalSummary: 'Run query',
    };

    const pending = fixture.journal.commitToolInvocation(command);
    canonicalToolId.name = 'mutated_tool';
    lease.ownerId = 'mutated-owner';
    command.approvalSummary = 'mutated summary';
    const committed = await pending;

    expect(committed.invocation.canonicalToolId).toEqual({ name: 'query_database' });
    expect(committed.invocation.state).toBe('authorized');
  });

  it('strictly snapshots scoped public query inputs without evaluating accessors', async () => {
    const journal = await emptyJournal();
    let getterCalls = 0;
    const getInput = {
      projectId: 'project-a', sessionId: 'session-a', runId: 'run-a', invocationId: 'invocation-a',
    };
    Object.defineProperty(getInput, 'runId', {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return 'run-a';
      },
    });
    await expect(journal.getApproval(getInput))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(getterCalls).toBe(0);
    await expect(journal.listApprovals({
      projectId: 'project-a', sessionId: 'session-a', runId: 'run-a', limit: 1,
      unexpected: true,
    } as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(journal.listTurnInvocations({
      projectId: 'project-a', sessionId: 'session-a', runId: 'run-a', turnId: 'turn-a', limit: 1,
      unexpected: true,
    } as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

async function emptyJournal(): Promise<SqliteAgentJournal> {
  const directory = await mkdtemp(join(tmpdir(), 'dbagent-tool-ingress-'));
  temporaryDirectories.push(directory);
  return new SqliteAgentJournal({ filePath: join(directory, 'state.db') });
}

function commandForSnapshot(
  action: ToolInvocationJournalCommand['action'],
): ToolInvocationJournalCommand {
  const common = {
    action,
    projectId: 'project-a', sessionId: 'session-a', runId: 'run-a', turnId: 'turn-a',
    invocationId: 'invocation-a', commandId: `command-${action}`,
    lease: { ownerId: 'owner-a', fencingToken: 1 },
    expectedRunRevision: 1, expectedInvocationRevision: 1,
  };
  switch (action) {
    case 'validate':
      return {
        ...common, action,
        canonicalToolId: { name: 'tool-a' }, toolRevision: '1', effect: 'read',
        normalizedArgumentsDigest: 'a'.repeat(64), authorization: 'allow',
        approvalSummary: 'Allow tool.',
      };
    case 'reject-validation':
      return {
        ...common, action, summary: 'Rejected.',
        error: { code: 'TOOL_INPUT_INVALID', category: 'validation', retryable: false,
          outcome: 'not_applied' },
      };
    case 'decide-approval':
      return {
        ...common, action, approvalId: 'approval-a', canonicalToolId: { name: 'tool-a' },
        toolRevision: '1', effect: 'read', normalizedArgumentsDigest: 'a'.repeat(64),
        proposedRevision: 1, decision: 'approve',
      };
    case 'start':
      return { ...common, action, idempotencyKey: 'idempotency-a', attempt: 1 };
    case 'finish':
      return { ...common, action, outcome: 'succeeded', summary: 'Done.', resultRefs: [] };
    case 'observe':
      return {
        ...common, action,
        observation: {
          observationId: 'observation-a', invocationId: 'invocation-a', summary: 'Done.',
          evidenceRefs: [], outcome: 'succeeded',
        },
      };
    case 'authorize-retry':
      return {
        ...common, action, permitId: 'permit-a', toolRevision: '1', effect: 'non_idempotent',
        normalizedArgumentsDigest: 'a'.repeat(64), reason: 'User accepted retry.',
      };
    case 'resolve-outcome':
      return {
        ...common, action, resolutionId: 'resolution-a', outcome: 'succeeded',
        canonicalToolId: { name: 'tool-a' }, toolRevision: '1', effect: 'non_idempotent',
        normalizedArgumentsDigest: 'a'.repeat(64), proposedRevision: 1, summary: 'Resolved.',
      };
  }
}

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
