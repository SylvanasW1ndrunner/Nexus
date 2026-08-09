import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import type { ValidatedModelAttempt } from '@dbagent/core-llm';
import { RunEventCommitter, SqliteAgentJournal } from '../src/index.js';
import { validatedAttemptFixture } from './validated-attempt-fixture.js';

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
      expectedRunRevision: 2,
      expectedTurnRevision: 1,
      attempt: await modelAttempt(),
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

    now += 1_000;
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
      journal.startRun({
        projectId: 'project-a',
        sessionId: 'session-a',
        runId: created.runId,
        commandId: 'stale-start',
        lease: { ownerId: first.ownerId, fencingToken: first.fencingToken },
        expectedRunRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'FENCING_TOKEN_STALE' });
    await expect(
      journal.startRun({
        projectId: 'project-a',
        sessionId: 'session-a',
        runId: created.runId,
        commandId: 'fresh-start',
        lease: { ownerId: second.ownerId, fencingToken: second.fencingToken },
        expectedRunRevision: 1,
      }),
    ).resolves.toMatchObject({ events: [{ type: 'run.started' }] });
  });

  it('surfaces a bounded typed busy failure under a real worker_threads SQLite write lock', async () => {
    const filePath = await journalPath();
    const journal = new SqliteAgentJournal({ filePath, busyTimeoutMs: 75 });
    await journal.createRun({
      projectId: 'project-a', sessionId: 'session-a', clientRequestId: 'seed', input: 'seed',
    });
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(workerData);
      db.exec('BEGIN IMMEDIATE');
      parentPort.postMessage('locked');
      parentPort.once('message', () => { db.exec('ROLLBACK'); db.close(); });
    `, { eval: true, workerData: filePath });
    await new Promise<void>((resolve, reject) => {
      worker.once('message', () => resolve());
      worker.once('error', reject);
    });

    await expect(journal.createRun({
      projectId: 'project-a', sessionId: 'session-a', clientRequestId: 'blocked', input: 'blocked',
    })).rejects.toMatchObject({ code: 'JOURNAL_BUSY' });

    worker.postMessage('release');
    await new Promise<void>((resolve, reject) => {
      worker.once('exit', () => resolve());
      worker.once('error', reject);
    });
    await expect(journal.countEvents(undefined, 'project-a')).resolves.toBe(2);
  });

  it.each(['before-commit', 'after-commit-before-return'] as const)(
    'recovers deterministically when a SQLite writer process dies %s',
    async (cut) => {
      const filePath = await journalPath();
      const journal = new SqliteAgentJournal({ filePath });
      const created = await journal.createRun({
        projectId: 'project-a', sessionId: 'session-a', clientRequestId: `crash-${cut}`, input: cut,
      });
      const worker = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(workerData.filePath);
        db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
        db.prepare('UPDATE agent_project_sequences SET current_sequence=current_sequence+1 WHERE project_id=?').run('project-a');
        const sequence = db.prepare('SELECT current_sequence FROM agent_project_sequences WHERE project_id=?').get('project-a').current_sequence;
        db.prepare(\`INSERT INTO agent_events
          (project_id, sequence, event_id, schema_version, session_id, run_id, event_type,
           occurred_at, payload_json, audience_json, persistence)
          VALUES (?, ?, ?, 1, ?, ?, 'artifact.created', ?, ?, ?, 'durable')\`)
          .run('project-a', sequence, 'event-crash-' + workerData.cut,
            'session-a', workerData.runId, new Date(0).toISOString(),
            JSON.stringify({ artifactId: 'artifact-crash', mediaType: 'text/plain', summary: 'bounded' }),
            JSON.stringify(['internal', 'user', 'audit']));
        if (workerData.cut === 'after-commit-before-return') db.exec('COMMIT');
        parentPort.postMessage('cut');
        setInterval(() => {}, 1000);
      `, { eval: true, workerData: { filePath, cut, runId: created.runId } });
      await new Promise<void>((resolve, reject) => {
        worker.once('message', () => resolve());
        worker.once('error', reject);
      });
      await worker.terminate();

      const reopened = new SqliteAgentJournal({ filePath });
      expect(await reopened.countEvents('artifact.created', 'project-a'))
        .toBe(cut === 'before-commit' ? 0 : 1);
      expect((await reopened.readProject('project-a', 0, 100)).map((event) => event.sequence))
        .toEqual(cut === 'before-commit' ? [1, 2] : [1, 2, 3]);
    },
  );
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
  await journal.startRun({
    projectId: 'project-a', sessionId: 'session-a', runId: created.runId,
    commandId: `start-${created.runId}`,
    lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken }, expectedRunRevision: 1,
  });
  await journal.startTurn({
    projectId: 'project-a', sessionId: 'session-a', runId: created.runId, turnId: 'turn-a',
    commandId: `turn-${created.runId}`,
    lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken }, expectedRunRevision: 2,
  });
  return { runId: created.runId, lease };
}

async function modelAttempt(): Promise<ValidatedModelAttempt> {
  return await validatedAttemptFixture('attempt-a');
}

async function journalPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dbagent-agent-journal-fault-'));
  tempDirs.push(directory);
  return join(directory, 'agent-journal.db');
}
