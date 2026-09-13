import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ValidatedModelAttempt } from '@dbagent/core-llm';
import { RunEventCommitter, SqliteAgentJournal } from '../src/index.js';
import { validatedAttemptFixture } from './validated-attempt-fixture.js';

const tempDirs: string[] = [];
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = dirname(dirname(packageRoot));
const typescriptEntry = createRequire(import.meta.url).resolve('typescript/bin/tsc');

beforeAll(() => {
  execFileSync(process.execPath, [
    typescriptEntry, '-b', `${packageRoot}/tsconfig.json`, '--force',
  ], { cwd: repositoryRoot, stdio: 'pipe' });
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
      billingMode: 'byok' as const,
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

  it('enforces the project/run tuple on leases with a composite foreign key', async () => {
    const filePath = await journalPath();
    const journal = new SqliteAgentJournal({ filePath });
    const created = await journal.createRun({
      projectId: 'project-a', sessionId: 'session-a', clientRequestId: 'lease-tuple', input: 'go',
    });
    const database = openDatabase(filePath);

    let rejected = false;
    try {
      database.prepare(
        `INSERT INTO agent_run_leases
         (project_id, run_id, owner_id, expires_at_ms, fencing_token)
         VALUES ('project-b', ?, 'worker-b', 1, 1)`,
      ).run(created.runId);
    } catch {
      rejected = true;
    } finally {
      database.close();
    }
    expect(rejected).toBe(true);
  });

  it('migrates the legacy run-only lease foreign key without losing valid leases', async () => {
    const filePath = await journalPath();
    const journal = new SqliteAgentJournal({ filePath });
    const created = await journal.createRun({
      projectId: 'project-a', sessionId: 'session-a', clientRequestId: 'lease-migration', input: 'go',
    });
    const lease = await journal.acquireRunLease({
      projectId: 'project-a', runId: created.runId, ownerId: 'worker-a', ttlMs: 60_000,
    });
    const database = openDatabase(filePath);
    database.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE');
    database.exec(`
      ALTER TABLE agent_run_leases RENAME TO agent_run_leases_scoped;
      CREATE TABLE agent_run_leases (
        project_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
        PRIMARY KEY (project_id, run_id),
        FOREIGN KEY (run_id) REFERENCES agent_runs(run_id)
      );
      INSERT INTO agent_run_leases SELECT * FROM agent_run_leases_scoped;
      DROP TABLE agent_run_leases_scoped;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
    database.close();

    const reopened = new SqliteAgentJournal({ filePath });
    await expect(reopened.renewRunLease({
      projectId: 'project-a', runId: created.runId, ownerId: lease.ownerId,
      ttlMs: 60_000, fencingToken: lease.fencingToken,
    })).resolves.toMatchObject({ projectId: 'project-a', runId: created.runId });
    const migrated = openDatabase(filePath);
    let rejected = false;
    try {
      migrated.prepare(
        `INSERT INTO agent_run_leases
         (project_id, run_id, owner_id, expires_at_ms, fencing_token)
         VALUES ('project-b', ?, 'worker-b', 1, 1)`,
      ).run(created.runId);
    } catch {
      rejected = true;
    } finally {
      migrated.close();
    }
    expect(rejected).toBe(true);
  });

  it('classifies invalid event metadata and required causal IDs as CORRUPT_EVENT', async () => {
    const filePath = await journalPath();
    const journal = new SqliteAgentJournal({ filePath });
    const { runId, lease } = await createLeasedRun(journal);
    await journal.commitValidatedAttempt({
      projectId: 'project-a', sessionId: 'session-a', runId, turnId: 'turn-a',
      commandId: 'corruption-seed',
      lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken },
      expectedRunRevision: 3, expectedTurnRevision: 1, billingMode: 'byok', attempt: await modelAttempt(),
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

  it('cross-checks event outer IDs with payload IDs and rejects empty optional causal IDs', async () => {
    const filePath = await journalPath();
    const journal = new SqliteAgentJournal({ filePath });
    const { runId, lease } = await createLeasedRun(journal);
    await journal.commitValidatedAttempt({
      projectId: 'project-a', sessionId: 'session-a', runId, turnId: 'turn-a',
      commandId: 'outer-payload-seed',
      lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken },
      expectedRunRevision: 3, expectedTurnRevision: 1, billingMode: 'byok', attempt: await modelAttempt(),
    });
    const database = openDatabase(filePath);
    database.prepare(
      "UPDATE agent_events SET attempt_id = 'attempt-other' WHERE event_type = 'model_attempt_committed'",
    ).run();
    database.close();
    await expect(journal.readProject('project-a', 0, 100))
      .rejects.toMatchObject({ code: 'CORRUPT_EVENT' });

    const secondPath = await journalPath();
    const second = new SqliteAgentJournal({ filePath: secondPath });
    await second.createRun({
      projectId: 'project-a', sessionId: 'session-a', clientRequestId: 'empty-causal', input: 'go',
    });
    const secondDatabase = openDatabase(secondPath);
    secondDatabase.prepare(
      "UPDATE agent_events SET turn_id = '' WHERE event_type = 'run.created'",
    ).run();
    secondDatabase.close();
    await expect(second.readProject('project-a', 0, 100))
      .rejects.toMatchObject({ code: 'CORRUPT_EVENT' });
  });

  it('rejects a parent event from a later sequence during reads', async () => {
    const filePath = await journalPath();
    const journal = new SqliteAgentJournal({ filePath });
    await journal.createRun({
      projectId: 'project-a', sessionId: 'session-a', clientRequestId: 'future-parent', input: 'go',
    });
    const database = openDatabase(filePath);
    const later = database.prepare(
      "SELECT event_id FROM agent_events WHERE event_type = 'run.created'",
    ).get() as { event_id: string };
    database.prepare(
      "UPDATE agent_events SET parent_event_id = ? WHERE event_type = 'input.received'",
    ).run(later.event_id);
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
      expectedRunRevision: 3, expectedTurnRevision: 1, billingMode: 'byok', attempt: await modelAttempt(),
    });
    const database = openDatabase(filePath);
    database.prepare("UPDATE agent_turns SET payload_json = '{}' WHERE turn_id = 'turn-a'").run();
    database.close();

    await expect(journal.getCommittedTurn('turn-a'))
      .rejects.toMatchObject({ code: 'PROJECTION_CORRUPT' });
  });

  it('cross-checks every projection JSON identity against its columns', async () => {
    const filePath = await journalPath();
    const journal = new SqliteAgentJournal({ filePath });
    const { runId, lease } = await createLeasedRun(journal);
    const committed = await journal.commitValidatedAttempt({
      projectId: 'project-a', sessionId: 'session-a', runId, turnId: 'turn-a',
      commandId: 'projection-identity-seed',
      lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken },
      expectedRunRevision: 3, expectedTurnRevision: 1, billingMode: 'byok', attempt: await modelAttempt(),
    });
    const database = openDatabase(filePath);
    database.prepare("UPDATE agent_turns SET payload_json = json_set(payload_json, '$.projectId', 'project-b')")
      .run();
    database.close();
    await expect(journal.getCommittedTurn('turn-a'))
      .rejects.toMatchObject({ code: 'PROJECTION_CORRUPT' });

    const restore = openDatabase(filePath);
    restore.prepare('UPDATE agent_turns SET payload_json = ?').run(JSON.stringify(committed.turn));
    restore.prepare(
      "UPDATE agent_protocol_envelopes SET envelope_json = json_set(envelope_json, '$.attemptId', 'attempt-other')",
    ).run();
    restore.prepare(
      "UPDATE agent_invocations SET payload_json = json_set(payload_json, '$.sessionId', 'session-other')",
    ).run();
    restore.close();
    await expect(journal.getProtocolEnvelope('turn-a'))
      .rejects.toMatchObject({ code: 'PROJECTION_CORRUPT' });
    await expect(journal.listInvocations(runId))
      .rejects.toMatchObject({ code: 'PROJECTION_CORRUPT' });
  });

  it('strictly validates projected ModelContentBlock and correlation unions', async () => {
    const filePath = await journalPath();
    const journal = new SqliteAgentJournal({ filePath });
    const { runId, lease } = await createLeasedRun(journal);
    const committed = await journal.commitValidatedAttempt({
      projectId: 'project-a', sessionId: 'session-a', runId, turnId: 'turn-a',
      commandId: 'projection-union-seed',
      lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken },
      expectedRunRevision: 3, expectedTurnRevision: 1, billingMode: 'byok', attempt: await modelAttempt(),
    });
    const database = openDatabase(filePath);
    const badTurn = { ...committed.turn, blocks: [{ type: 'invented', data: 'unsafe' }] };
    database.prepare('UPDATE agent_turns SET payload_json = ?').run(JSON.stringify(badTurn));
    const badEnvelope = {
      ...committed.envelope,
      correlations: [{
        callId: 'call-a', draftCallKey: 'draft-a', replay: 'invented', injected: true,
      }],
    };
    database.prepare('UPDATE agent_protocol_envelopes SET envelope_json = ?')
      .run(JSON.stringify(badEnvelope));
    database.close();

    await expect(journal.getCommittedTurn('turn-a'))
      .rejects.toMatchObject({ code: 'PROJECTION_CORRUPT' });
    await expect(journal.getProtocolEnvelope('turn-a'))
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

  it('releases only the exact Run lease and preserves monotonic fencing across reopen and rebuild', async () => {
    const filePath = await journalPath();
    const journal = new SqliteAgentJournal({ filePath });
    const created = await journal.createRun({
      projectId: 'project-a', sessionId: 'session-a',
      clientRequestId: 'lease-release', input: 'go',
    });
    const first = await journal.acquireRunLease({
      projectId: 'project-a', runId: created.runId, ownerId: 'worker-a', ttlMs: 60_000,
    });

    await expect(journal.releaseRunLease({
      projectId: 'project-a', runId: created.runId,
      ownerId: 'worker-b', fencingToken: first.fencingToken,
    })).resolves.toBe(false);
    await expect(journal.releaseRunLease({
      projectId: 'project-a', runId: created.runId,
      ownerId: first.ownerId, fencingToken: first.fencingToken + 1,
    })).resolves.toBe(false);
    expect(await journal.getRunLease('project-a', created.runId)).toMatchObject(first);
    await expect(journal.releaseRunLease({
      projectId: 'project-a', runId: created.runId,
      ownerId: first.ownerId, fencingToken: first.fencingToken,
    })).resolves.toBe(true);
    await expect(journal.releaseRunLease({
      projectId: 'project-a', runId: created.runId,
      ownerId: first.ownerId, fencingToken: first.fencingToken,
    })).resolves.toBe(false);

    const reopened = new SqliteAgentJournal({ filePath });
    const second = await reopened.acquireRunLease({
      projectId: 'project-a', runId: created.runId, ownerId: 'worker-a', ttlMs: 60_000,
    });
    expect(second.fencingToken).toBe(first.fencingToken + 1);
    await expect(reopened.releaseRunLease({
      projectId: 'project-a', runId: created.runId,
      ownerId: second.ownerId, fencingToken: second.fencingToken,
    })).resolves.toBe(true);
    await reopened.rebuildProjectProjections('project-a');
    const third = await reopened.acquireRunLease({
      projectId: 'project-a', runId: created.runId, ownerId: 'worker-c', ttlMs: 60_000,
    });
    expect(third.fencingToken).toBe(second.fencingToken + 1);
    await expect(reopened.renewRunLease({
      projectId: 'project-a', runId: created.runId,
      ownerId: first.ownerId, fencingToken: first.fencingToken, ttlMs: 60_000,
    })).rejects.toMatchObject({ code: 'STALE_LEASE' });
  });

  it('serializes concurrent acquisition after release and advances the persistent fence once', async () => {
    const journal = new SqliteAgentJournal({ filePath: await journalPath() });
    const created = await journal.createRun({
      projectId: 'project-a', sessionId: 'session-a',
      clientRequestId: 'lease-concurrent-release', input: 'go',
    });
    const first = await journal.acquireRunLease({
      projectId: 'project-a', runId: created.runId, ownerId: 'worker-a', ttlMs: 60_000,
    });
    await expect(journal.releaseRunLease({
      projectId: 'project-a', runId: created.runId,
      ownerId: first.ownerId, fencingToken: first.fencingToken,
    })).resolves.toBe(true);

    const contenders = await Promise.allSettled([
      journal.acquireRunLease({
        projectId: 'project-a', runId: created.runId, ownerId: 'worker-b', ttlMs: 60_000,
      }),
      journal.acquireRunLease({
        projectId: 'project-a', runId: created.runId, ownerId: 'worker-c', ttlMs: 60_000,
      }),
    ]);
    const winner = contenders.find((item) => item.status === 'fulfilled');
    const loser = contenders.find((item) => item.status === 'rejected');
    expect(winner?.status).toBe('fulfilled');
    expect(loser?.status).toBe('rejected');
    if (winner?.status !== 'fulfilled' || loser?.status !== 'rejected') {
      throw new Error('Expected exactly one serialized lease winner.');
    }
    expect(winner.value.fencingToken).toBe(first.fencingToken + 1);
    expect(loser.reason).toMatchObject({ code: 'LEASE_HELD' });
  });

  it('rejects non-exact lease release and Turn lifecycle inputs before reading storage', async () => {
    const journal = new SqliteAgentJournal({ filePath: await journalPath() });
    const { runId, lease } = await createLeasedRun(journal);
    await expect(journal.releaseRunLease({
      projectId: 'project-a', runId, ownerId: lease.ownerId,
      fencingToken: lease.fencingToken, unexpected: true,
    } as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(journal.releaseRunLease({
      projectId: 'project-a', runId, ownerId: lease.ownerId, fencingToken: 0,
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(journal.getTurnLifecycle({
      projectId: 'project-a', sessionId: 'session-a', runId, turnId: 'turn-a', unexpected: true,
    } as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(journal.getTurnLifecycle({
      projectId: 'project-a', sessionId: 'session-a', runId, turnId: '',
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await journal.getRunLease('project-a', runId)).toMatchObject(lease);
  });

  it('backfills the persistent fence counter from an existing active lease', async () => {
    const filePath = await journalPath();
    const journal = new SqliteAgentJournal({ filePath });
    const created = await journal.createRun({
      projectId: 'project-a', sessionId: 'session-a',
      clientRequestId: 'lease-fence-backfill', input: 'go',
    });
    const first = await journal.acquireRunLease({
      projectId: 'project-a', runId: created.runId, ownerId: 'worker-a', ttlMs: 60_000,
    });
    const database = openDatabase(filePath);
    database.exec('DROP TABLE agent_run_lease_fences');
    database.close();

    const migrated = new SqliteAgentJournal({ filePath });
    await expect(migrated.releaseRunLease({
      projectId: 'project-a', runId: created.runId,
      ownerId: first.ownerId, fencingToken: first.fencingToken,
    })).resolves.toBe(true);
    const next = await migrated.acquireRunLease({
      projectId: 'project-a', runId: created.runId, ownerId: 'worker-b', ttlMs: 60_000,
    });
    expect(next.fencingToken).toBe(first.fencingToken + 1);
  });

  it('reads one exact scoped Turn lifecycle through started, committed and closed states', async () => {
    const journal = new SqliteAgentJournal({ filePath: await journalPath() });
    const first = await createLeasedRun(journal);
    const scope = {
      projectId: 'project-a', sessionId: 'session-a', runId: first.runId, turnId: 'turn-a',
    };
    await expect(journal.getTurnLifecycle(scope))
      .resolves.toEqual({ revision: 1, status: 'started' });
    await new RunEventCommitter(journal).commitValidatedAttempt({
      ...scope, commandId: 'turn-lifecycle-commit',
      lease: { ownerId: first.lease.ownerId, fencingToken: first.lease.fencingToken },
      expectedRunRevision: 3, expectedTurnRevision: 1, billingMode: 'byok', attempt: await modelAttempt(),
    });
    await expect(journal.getTurnLifecycle(scope))
      .resolves.toEqual({ revision: 2, status: 'committed' });
    await expect(journal.getTurnLifecycle({ ...scope, turnId: 'missing-turn' }))
      .resolves.toBeNull();
    await expect(journal.getTurnLifecycle({ ...scope, sessionId: 'session-b' }))
      .rejects.toMatchObject({ code: 'RUN_IDENTITY_CONFLICT' });

    const database = openDatabase(journal.filePath);
    try {
      database.prepare(
        `UPDATE agent_turn_lifecycles SET revision = revision + 1, status = 'closed'
         WHERE project_id = ? AND session_id = ? AND run_id = ? AND turn_id = ?`,
      ).run(scope.projectId, scope.sessionId, scope.runId, scope.turnId);
    } finally {
      database.close();
    }
    await expect(journal.getTurnLifecycle(scope))
      .resolves.toEqual({ revision: 3, status: 'closed' });
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

  it('rejects a pre-initialization external SQLite file as incompatible state', async () => {
    const filePath = await journalPath();
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(workerData);
      db.exec('BEGIN IMMEDIATE');
      parentPort.postMessage('locked');
      parentPort.once('message', () => { db.exec('ROLLBACK'); db.close(); });
    `, { eval: true, workerData: filePath });
    await new Promise<void>((resolveReady, reject) => {
      worker.once('message', () => resolveReady());
      worker.once('error', reject);
    });
    const journal = new SqliteAgentJournal({ filePath, busyTimeoutMs: 75 });

    const errors: unknown[] = [];
    try {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          await journal.createRun({
            projectId: 'project-a', sessionId: 'session-a',
            clientRequestId: `ddl-busy-${attempt}`, input: 'go',
          });
        } catch (caught) {
          errors.push(caught);
        }
      }
    } finally {
      worker.postMessage('release');
      await new Promise<void>((resolveExit, reject) => {
        worker.once('exit', () => resolveExit());
        worker.once('error', reject);
      });
    }
    expect(errors).toHaveLength(10);
    expect(errors.every((error) =>
      (error as { code?: string }).code === 'incompatible_state_store')).toBe(true);
    await expect(rm(dirname(filePath), { recursive: true, force: true })).resolves.toBeUndefined();
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
      const events = await reopened.readProject('project-a', 0, 100);
      expect(events.map(({ sequence, type }) => ({ sequence, type }))).toEqual([
        { sequence: 1, type: 'input.received' },
        { sequence: 2, type: 'run.created' },
        { sequence: 3, type: 'run.started' },
        { sequence: 4, type: 'turn.started' },
        { sequence: 5, type: 'model_attempt_committed' },
        { sequence: 6, type: 'usage.recorded' },
        { sequence: 7, type: 'tool.proposed' },
        { sequence: 8, type: 'tool.proposed' },
      ]);
      const modelEvent = events[4];
      expect(modelEvent?.type).toBe('model_attempt_committed');
      expect(events.slice(5).map(({ parentEventId }) => parentEventId))
        .toEqual([modelEvent?.eventId, modelEvent?.eventId, modelEvent?.eventId]);
      const database = openDatabase(filePath);
      try {
        expect(database.prepare(
          `SELECT command_kind FROM agent_commands
           WHERE project_id = ? AND command_id = ?`,
        ).all('project-a', command.commandId)).toEqual([{ command_kind: 'model.commit' }]);
      } finally {
        database.close();
      }
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
    expectedRunRevision: 3, expectedTurnRevision: 1, billingMode: 'byok' as const,
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
    let database: DatabaseSync | undefined;
    let found: unknown;
    try {
      database = openDatabase(filePath);
      found = database.prepare(
        'SELECT 1 AS present FROM agent_commands WHERE project_id = ? AND command_id = ?',
      ).get('project-a', commandId);
    } catch (error) {
      if (!isTransientSqliteBusy(error)) throw error;
    } finally {
      database?.close();
    }
    if (found !== undefined) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  throw new Error(`Timed out waiting for committed command ${commandId}.`);
}

function isTransientSqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = 'code' in error ? String((error as { code?: unknown }).code) : '';
  return /SQLITE_(?:BUSY|LOCKED)/iu.test(code) ||
    /database(?: table)? is (?:locked|busy)|SQLITE_(?:BUSY|LOCKED)/iu.test(error.message);
}
