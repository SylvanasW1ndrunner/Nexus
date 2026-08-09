import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ValidatedModelAttempt } from '@dbagent/core-llm';
import { RunEventCommitter, SqliteAgentJournal } from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('SqliteAgentJournal transaction and lease faults', () => {
  it.each([
    'after-model-event-before-attempt',
    'after-model-attempt-before-turn',
    'after-turn-before-envelope',
    'after-envelope-before-invocations',
    'after-first-invocation',
  ] as const)('rolls back every model commit row at %s and stays empty after reopen', async (cut) => {
    const filePath = await journalPath();
    const journal = new SqliteAgentJournal({ filePath });
    const { runId, lease } = await createLeasedRun(journal);
    const command = {
      projectId: 'project-a',
      sessionId: 'session-a',
      runId,
      turnId: 'turn-a',
      commandId: `commit-${cut}`,
      lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken },
      attempt: modelAttempt(),
    };
    journal.failAt(cut);

    await expect(new RunEventCommitter(journal).commitValidatedAttempt(command)).rejects.toThrow(
      'INJECTED_FAILURE',
    );

    const reopened = new SqliteAgentJournal({ filePath });
    expect(await reopened.getCommittedTurn(command.turnId)).toBeNull();
    expect(await reopened.getProtocolEnvelope(command.turnId)).toBeNull();
    expect(await reopened.listInvocations(command.runId)).toEqual([]);
    expect(await reopened.countEvents('model_attempt_committed', 'project-a')).toBe(0);
    expect(await reopened.countEvents('tool.proposed', 'project-a')).toBe(0);
  });

  it('uses WAL, FULL sync, foreign keys and a bounded busy timeout on real connections', async () => {
    const journal = new SqliteAgentJournal({ filePath: await journalPath(), busyTimeoutMs: 2_500 });
    await journal.createRun({
      projectId: 'project-a',
      sessionId: 'session-a',
      clientRequestId: 'request-a',
      input: 'hello',
    });

    await expect(journal.inspectStoragePragmas()).resolves.toEqual({
      journalMode: 'wal',
      synchronous: 2,
      foreignKeys: 1,
      busyTimeoutMs: 2_500,
    });
  });

  it('increments fencing tokens on takeover and rejects stale writers and renewals', async () => {
    let now = Date.parse('2026-08-09T00:00:00.000Z');
    const journal = new SqliteAgentJournal({
      filePath: await journalPath(),
      now: () => new Date(now).toISOString(),
    });
    const created = await journal.createRun({
      projectId: 'project-a',
      sessionId: 'session-a',
      clientRequestId: 'request-a',
      input: 'hello',
    });
    const first = await journal.acquireRunLease({
      projectId: 'project-a',
      runId: created.runId,
      ownerId: 'worker-a',
      ttlMs: 1_000,
    });
    await expect(
      journal.acquireRunLease({
        projectId: 'project-a',
        runId: created.runId,
        ownerId: 'worker-b',
        ttlMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: 'LEASE_HELD' });

    now += 1_001;
    const second = await journal.acquireRunLease({
      projectId: 'project-a',
      runId: created.runId,
      ownerId: 'worker-b',
      ttlMs: 1_000,
    });
    expect(second.fencingToken).toBe(first.fencingToken + 1);
    await expect(
      journal.renewRunLease({
        projectId: 'project-a',
        runId: created.runId,
        ownerId: first.ownerId,
        fencingToken: first.fencingToken,
        ttlMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: 'STALE_LEASE' });
    await expect(
      journal.commit({
        projectId: 'project-a',
        sessionId: 'session-a',
        runId: created.runId,
        commandId: 'stale-start',
        lease: { ownerId: first.ownerId, fencingToken: first.fencingToken },
        events: [{ type: 'run.started', payload: {} }],
      }),
    ).rejects.toMatchObject({ code: 'FENCING_TOKEN_STALE' });
    await expect(
      journal.commit({
        projectId: 'project-a',
        sessionId: 'session-a',
        runId: created.runId,
        commandId: 'fresh-start',
        lease: { ownerId: second.ownerId, fencingToken: second.fencingToken },
        events: [{ type: 'run.started', payload: {} }],
      }),
    ).resolves.toMatchObject({ events: [{ type: 'run.started' }] });
  });
});

async function createLeasedRun(journal: SqliteAgentJournal) {
  const created = await journal.createRun({
    projectId: 'project-a',
    sessionId: 'session-a',
    clientRequestId: `request-${crypto.randomUUID()}`,
    input: 'hello',
  });
  const lease = await journal.acquireRunLease({
    projectId: 'project-a',
    runId: created.runId,
    ownerId: 'worker-a',
    ttlMs: 60_000,
  });
  return { runId: created.runId, lease };
}

function modelAttempt(): ValidatedModelAttempt {
  return {
    attemptId: 'attempt-a',
    origin: { connectionId: 'connection-a', model: 'model-a', protocol: 'openai-responses' },
    terminal: true,
    validation: 'validated',
    finishReason: 'tool-calls',
    opaqueBlockRefs: [],
    blocks: [
      { type: 'text', text: 'Checking.' },
      {
        type: 'tool-call-draft',
        draftCallKey: 'attempt-a:1',
        wireIdentity: { callId: 'wire-a', providerItemId: 'item-a' },
        name: 'query_database',
        arguments: { sql: 'select 1' },
      },
      {
        type: 'tool-call-draft',
        draftCallKey: 'attempt-a:2',
        wireIdentity: { callId: 'wire-b', providerItemId: 'item-b' },
        name: 'read_result',
        arguments: { handle: 'result-a' },
      },
    ],
  };
}

async function journalPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dbagent-agent-journal-fault-'));
  tempDirs.push(directory);
  return join(directory, 'agent-journal.db');
}
