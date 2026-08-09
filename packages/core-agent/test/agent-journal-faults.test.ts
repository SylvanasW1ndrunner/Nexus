import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ValidatedModelAttempt } from '@dbagent/core-llm';
import { RunEventCommitter, SqliteAgentJournal } from '../src/index.js';
import { validatedAttemptFixture } from './validated-attempt-fixture.js';

const tempDirs: string[] = [];

beforeAll(() => {
  execFileSync(process.execPath, [
    'node_modules/typescript/bin/tsc', '-b', 'packages/core-agent/tsconfig.json', '--force',
  ], { cwd: resolve('.'), stdio: 'pipe' });
});

afterAll(() => {
  execFileSync(process.execPath, [
    'scripts/clean-path.mjs', 'packages/core-agent/dist', 'packages/core-agent/tsconfig.tsbuildinfo',
  ], { cwd: resolve('.'), stdio: 'pipe' });
});

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
      expectedRunRevision: 3,
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

  it('enforces project/session/run causal tuples with composite foreign keys', async () => {
    const filePath = await journalPath();
    const journal = new SqliteAgentJournal({ filePath });
    const { runId } = await createLeasedRun(journal);
    const database = openDatabase(filePath);

    expect(() => database.prepare(
      `INSERT INTO agent_turn_lifecycles
       (project_id, session_id, run_id, turn_id, revision, status, started_at)
       VALUES ('project-b', 'session-b', ?, 'cross-scope-turn', 1, 'started', ?)`,
    ).run(runId, new Date(0).toISOString())).toThrow();
    database.close();
  });

  it('classifies invalid event metadata and required causal IDs as CORRUPT_EVENT', async () => {
    const filePath = await journalPath();
    const journal = new SqliteAgentJournal({ filePath });
    const { runId, lease } = await createLeasedRun(journal);
    await journal.commitValidatedAttempt({
      projectId: 'project-a', sessionId: 'session-a', runId, turnId: 'turn-a',
      commandId: 'corruption-seed',
      lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken },
      expectedRunRevision: 3, expectedTurnRevision: 1, attempt: await modelAttempt(),
    });
    const database = openDatabase(filePath);
    database.prepare(
      `UPDATE agent_events SET occurred_at = 'not-an-iso-time', attempt_id = NULL
       WHERE event_type = 'model_attempt_committed'`,
    ).run();
    database.close();

    await expect(journal.readProject('project-a', 0, 100))
      .rejects.toMatchObject({ code: 'CORRUPT_EVENT' });
  });

  it('runtime-validates projection JSON and classifies corruption consistently', async () => {
    const filePath = await journalPath();
    const journal = new SqliteAgentJournal({ filePath });
    const { runId, lease } = await createLeasedRun(journal);
    await journal.commitValidatedAttempt({
      projectId: 'project-a', sessionId: 'session-a', runId, turnId: 'turn-a',
      commandId: 'projection-corruption-seed',
      lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken },
      expectedRunRevision: 3, expectedTurnRevision: 1, attempt: await modelAttempt(),
    });
    const database = openDatabase(filePath);
    database.prepare("UPDATE agent_turns SET payload_json = '{}' WHERE turn_id = 'turn-a'").run();
    database.close();

    await expect(journal.getCommittedTurn('turn-a'))
      .rejects.toMatchObject({ code: 'PROJECTION_CORRUPT' });
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

  it('replays a semantic command after lease takeover despite new fencing and revision inputs', async () => {
    let now = Date.parse('2026-08-09T00:00:00.000Z');
    const journal = new SqliteAgentJournal({
      filePath: await journalPath(), now: () => new Date(now).toISOString(),
    });
    const created = await journal.createRun({
      projectId: 'project-a', sessionId: 'session-a', clientRequestId: 'semantic-replay', input: 'go',
    });
    const firstLease = await journal.acquireRunLease({
      projectId: 'project-a', runId: created.runId, ownerId: 'worker-a', ttlMs: 1_000,
    });
    const first = await journal.startRun({
      projectId: 'project-a', sessionId: 'session-a', runId: created.runId,
      commandId: 'same-semantic-command',
      lease: { ownerId: firstLease.ownerId, fencingToken: firstLease.fencingToken },
      expectedRunRevision: 1,
    });
    now += 1_001;
    const takeover = await journal.acquireRunLease({
      projectId: 'project-a', runId: created.runId, ownerId: 'worker-b', ttlMs: 1_000,
    });

    await expect(journal.startRun({
      projectId: 'project-a', sessionId: 'session-a', runId: created.runId,
      commandId: 'same-semantic-command',
      lease: { ownerId: takeover.ownerId, fencingToken: takeover.fencingToken },
      expectedRunRevision: 999,
    })).resolves.toEqual(first);
    await expect(journal.countEvents('run.started', 'project-a')).resolves.toBe(1);
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

  it('uses a barrier for two real Journal writers racing the same command and Turn', async () => {
    const filePath = await journalPath();
    const journal = new SqliteAgentJournal({ filePath });
    const seeded = await createLeasedRun(journal);
    const gate = new SharedArrayBuffer(4);
    const command = workerCommand(seeded.runId, seeded.lease, 'worker-race');
    const workers = [0, 1].map(() => journalWorker({ filePath, gate, command }));
    await Promise.all(workers.map((worker) => waitForWorkerMessage(worker, 'ready')));
    const pendingResults = workers.map((worker) => waitForWorkerMessage(worker, 'result'));
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0, workers.length);
    const results = await Promise.all(pendingResults);

    expect(results[0]?.result).toEqual(results[1]?.result);
    await expect(journal.countEvents('model_attempt_committed', 'project-a')).resolves.toBe(1);
    await expect(journal.countEvents('tool.proposed', 'project-a')).resolves.toBe(2);
    await Promise.all(workers.map((worker) => worker.terminate()));
  });

  it.each(['before-commit', 'after-commit-before-return'] as const)(
    'retries the original real Journal command after worker death %s', async (cut) => {
      const filePath = await journalPath();
      const journal = new SqliteAgentJournal({ filePath });
      const seeded = await createLeasedRun(journal);
      const command = workerCommand(seeded.runId, seeded.lease, `worker-crash-${cut}`);
      const gate = new SharedArrayBuffer(4);
      let lock: DatabaseSync | undefined;
      if (cut === 'before-commit') {
        lock = openDatabase(filePath);
        lock.exec('BEGIN IMMEDIATE');
      }
      const worker = journalWorker({
        filePath, gate, command, pauseAfterCommit: cut === 'after-commit-before-return',
      });
      await waitForWorkerMessage(worker, 'ready');
      Atomics.store(new Int32Array(gate), 0, 1);
      Atomics.notify(new Int32Array(gate), 0, 1);
      await waitForWorkerMessage(worker, 'calling');
      if (cut === 'after-commit-before-return') {
        await waitForCommandRow(filePath, command.commandId);
      }
      await worker.terminate();
      if (lock !== undefined) {
        lock.exec('ROLLBACK');
        lock.close();
      }

      const reopened = new SqliteAgentJournal({ filePath });
      const retry = await reopened.commitValidatedAttempt({
        ...command, attempt: await validatedAttemptFixture('attempt-worker'),
      });
      expect(retry.turn.turnId).toBe('turn-a');
      await expect(reopened.countEvents('model_attempt_committed', 'project-a')).resolves.toBe(1);
      expect((await reopened.readProject('project-a', 0, 100)).map(({ sequence }) => sequence))
        .toEqual([1, 2, 3, 4, 5, 6, 7]);
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

function openDatabase(filePath: string): DatabaseSync {
  const { DatabaseSync: Database } = createRequire(import.meta.url)('node:sqlite') as {
    DatabaseSync: new (path: string) => DatabaseSync;
  };
  const database = new Database(filePath);
  database.exec('PRAGMA foreign_keys=ON');
  return database;
}

function workerCommand(
  runId: string,
  lease: { ownerId: string; fencingToken: number },
  commandId: string,
) {
  return {
    projectId: 'project-a', sessionId: 'session-a', runId, turnId: 'turn-a', commandId,
    lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken },
    expectedRunRevision: 3, expectedTurnRevision: 1,
  };
}

function journalWorker(workerData: {
  filePath: string;
  gate: SharedArrayBuffer;
  command: ReturnType<typeof workerCommand>;
  pauseAfterCommit?: boolean;
}): Worker {
  return new Worker(new URL('./fixtures/journal-api-worker.mjs', import.meta.url), {
    workerData: { ...workerData, attemptId: 'attempt-worker' },
  });
}

function waitForWorkerMessage(
  worker: Worker,
  type: 'ready' | 'calling' | 'result',
): Promise<{ type: string; result?: unknown }> {
  return new Promise((resolveMessage, reject) => {
    const receive = (message: { type?: string; result?: unknown }) => {
      if (message.type !== type) return;
      worker.off('error', reject);
      worker.off('message', receive);
      resolveMessage({ type, result: message.result });
    };
    worker.on('message', receive);
    worker.once('error', reject);
  });
}

async function waitForCommandRow(filePath: string, commandId: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const database = openDatabase(filePath);
    const found = database.prepare(
      'SELECT 1 AS present FROM agent_commands WHERE project_id = ? AND command_id = ?',
    ).get('project-a', commandId);
    database.close();
    if (found !== undefined) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  throw new Error(`Timed out waiting for committed command ${commandId}.`);
}
