import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { ValidatedModelAttempt } from '@dbagent/core-llm';
import { RunEventCommitter, SqliteAgentJournal, replayAgentEvents } from '../src/index.js';
import { validatedAttemptFixture } from './validated-attempt-fixture.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('RunEventCommitter', () => {
  it('keeps preparation private and makes SqliteAgentJournal the final validated-attempt authority', async () => {
    const journal = new SqliteAgentJournal({ filePath: await journalPath() });
    expect(Object.getOwnPropertySymbols(SqliteAgentJournal.prototype)).toEqual([]);
    expect(typeof journal.commitValidatedAttempt).toBe('function');
    const command = await commitCommand(journal);
    const committed = await journal.commitValidatedAttempt(command);
    await expect(journal.getCommittedTurn(command.turnId)).resolves.toEqual(committed.turn);
  });
  it('atomically materializes ordered drafts, current wire identities, and opaque refs', async () => {
    const journal = new SqliteAgentJournal({ filePath: await journalPath() });
    const command = await commitCommand(journal);

    const committed = await new RunEventCommitter(journal).commitValidatedAttempt(command);

    await expect(journal.getRunProjection(command.runId)).resolves.toMatchObject({ revision: 4 });

    expect(committed.turn.blocks.map((block) => block.type)).toEqual([
      'text',
      'tool-call',
      'provider-opaque',
      'tool-call',
    ]);
    expect(committed.invocations.map(({ actionOrdinal, name }) => [actionOrdinal, name])).toEqual([
      [0, 'query_database'],
      [1, 'read_result'],
    ]);
    expect(committed.invocations[0]?.callId).toMatch(/^call_[a-f0-9]{32}$/);
    expect(committed.invocations[0]?.callId).not.toBe(committed.invocations[1]?.callId);
    expect(committed.envelope).toEqual({
      schemaVersion: 1,
      attemptId: 'attempt-current',
      origin: {
        connectionId: 'connection-current',
        model: 'model-current',
        protocol: 'openai-responses',
      },
      correlations: [
        {
          callId: committed.invocations[0]?.callId,
          draftCallKey: 'attempt-current:1',
          wireIdentity: { callId: 'wire-current-a', providerItemId: 'item-current-a' },
          replay: 'same-connection-only',
        },
        {
          callId: committed.invocations[1]?.callId,
          draftCallKey: 'attempt-current:3',
          wireIdentity: { callId: 'wire-current-b', providerItemId: 'item-current-b' },
          replay: 'same-connection-only',
        },
      ],
      opaqueBlockRefs: ['attempt-current:opaque:2'],
    });
    expect(JSON.stringify(committed.envelope)).not.toContain('historical-wire-id');
    await expect(journal.getCommittedTurn(command.turnId)).resolves.toEqual(committed.turn);
    await expect(journal.getProtocolEnvelope(command.turnId)).resolves.toEqual(committed.envelope);
    await expect(journal.listInvocations(command.runId)).resolves.toEqual(committed.invocations);
    await expect(journal.countEvents('model_attempt_committed', 'project-a')).resolves.toBe(1);
    await expect(journal.countEvents('tool.proposed', 'project-a')).resolves.toBe(2);
  });

  it('returns the exact first commit on command replay and creates no duplicate identities', async () => {
    const journal = new SqliteAgentJournal({ filePath: await journalPath() });
    const command = await commitCommand(journal);
    const committer = new RunEventCommitter(journal);

    const first = await committer.commitValidatedAttempt(command);
    const second = await committer.commitValidatedAttempt(command);

    expect(second).toEqual(first);
    expect(await journal.listInvocations(command.runId)).toHaveLength(2);
    expect(await journal.countEvents('model_attempt_committed', 'project-a')).toBe(1);
    expect(await journal.countEvents('tool.proposed', 'project-a')).toBe(2);
  });

  it('rejects an unvalidated or non-portable attempt before any committed fact is visible', async () => {
    const journal = new SqliteAgentJournal({ filePath: await journalPath() });
    const command = await commitCommand(journal);
    const committer = new RunEventCommitter(journal);
    const unvalidated = { ...command.attempt, validation: undefined } as never;
    await expect(
      committer.commitValidatedAttempt({ ...command, commandId: 'invalid-validation', attempt: unvalidated }),
    ).rejects.toMatchObject({ code: 'ATTEMPT_NOT_VALIDATED' });
    const badAttempt = structuredClone(command.attempt);
    (badAttempt.blocks[1] as { arguments: unknown }).arguments = new Error('not portable');
    await expect(
      committer.commitValidatedAttempt({ ...command, commandId: 'invalid-payload', attempt: badAttempt }),
    ).rejects.toMatchObject({ code: 'ATTEMPT_NOT_VALIDATED' });

    expect(await journal.getCommittedTurn(command.turnId)).toBeNull();
    expect(await journal.listInvocations(command.runId)).toEqual([]);
    expect(await journal.countEvents('model_attempt_committed', 'project-a')).toBe(0);
  });

  it('rejects a Proxy whose second attempt read swaps authenticity before the first write', async () => {
    const journal = new SqliteAgentJournal({ filePath: await journalPath() });
    const command = await commitCommand(journal);
    let attemptReads = 0;
    const attack = new Proxy(command, {
      get(target, property) {
        if (property !== 'attempt') return target[property as keyof typeof target];
        attemptReads += 1;
        return attemptReads === 1 ? target.attempt : structuredClone(target.attempt);
      },
    });

    await expect(journal.commitValidatedAttempt(attack))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(attemptReads).toBeLessThanOrEqual(1);
    await expect(journal.getCommittedTurn(command.turnId)).resolves.toBeNull();
    await expect(journal.countEvents('model_attempt_committed', 'project-a')).resolves.toBe(0);
  });

  it('rejects accessor commands and non-canonical whitespace identities before preparation', async () => {
    const journal = new SqliteAgentJournal({ filePath: await journalPath() });
    const command = await commitCommand(journal);
    let getterReads = 0;
    const accessorCommand = { ...command } as Record<string, unknown>;
    Object.defineProperty(accessorCommand, 'attempt', {
      enumerable: true,
      get() {
        getterReads += 1;
        return getterReads === 1 ? command.attempt : structuredClone(command.attempt);
      },
    });

    await expect(journal.commitValidatedAttempt(accessorCommand as never))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(getterReads).toBe(0);
    await expect(journal.commitValidatedAttempt({ ...command, commandId: ' commit-with-space' }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(journal.countEvents('model_attempt_committed', 'project-a')).resolves.toBe(0);
  });

  it('requires a causally started Turn and matching run/turn revisions', async () => {
    const journal = new SqliteAgentJournal({ filePath: await journalPath() });
    const created = await journal.createRun({
      projectId: 'project-a', sessionId: 'session-a', clientRequestId: 'causal-a', input: 'hello',
    });
    const lease = await journal.acquireRunLease({
      projectId: 'project-a', runId: created.runId, ownerId: 'worker-a', ttlMs: 60_000,
    });
    const base = {
      projectId: 'project-a', sessionId: 'session-a', runId: created.runId,
      turnId: 'turn-not-started', commandId: 'causal-commit',
      lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken },
      expectedRunRevision: 1, expectedTurnRevision: 1,
      billingMode: 'byok' as const,
      attempt: await modelAttempt(),
    };
    await expect(new RunEventCommitter(journal).commitValidatedAttempt(base))
      .rejects.toMatchObject({ code: 'TURN_NOT_FOUND' });

    await journal.startRun({
      projectId: 'project-a', sessionId: 'session-a', runId: created.runId,
      commandId: 'start-run-causal', lease: base.lease, expectedRunRevision: 1,
    });
    await journal.startTurn({
      projectId: 'project-a', sessionId: 'session-a', runId: created.runId,
      turnId: 'turn-not-started', commandId: 'start-turn-causal', lease: base.lease,
      expectedRunRevision: 2,
    });
    await expect(new RunEventCommitter(journal).commitValidatedAttempt({
      ...base, commandId: 'stale-causal', expectedRunRevision: 1,
    })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  });

  it('stores every committed projection fact in events for exact event-only replay', async () => {
    const journal = new SqliteAgentJournal({ filePath: await journalPath() });
    const command = await commitCommand(journal);
    const committed = await new RunEventCommitter(journal).commitValidatedAttempt(command);
    const events = await journal.readProject('project-a', 0, 100);
    const replayed = replayAgentEvents(events);

    expect(replayed.turns).toEqual([committed.turn]);
    expect(replayed.invocations).toEqual(committed.invocations);
    expect(replayed.envelopes).toEqual([committed.envelope]);
    expect(replayed.validatedAttempts).toEqual([command.attempt]);
  });

  it('stores one canonical validated attempt and accepts a bounded 90 KiB model event', async () => {
    const journal = new SqliteAgentJournal({ filePath: await journalPath() });
    const command = await commitCommand(journal);
    command.attempt = await validatedAttemptFixture('attempt-current', 90 * 1024);

    await expect(journal.commitValidatedAttempt(command)).resolves.toBeDefined();
    const event = (await journal.readProject('project-a', 0, 100)).find(
      ({ type }) => type === 'model_attempt_committed',
    );
    expect(event?.payload && Object.keys(event.payload).sort()).toEqual([
      'protocolEnvelope', 'turn', 'validatedAttempt',
    ]);
    expect(event?.payload).toMatchObject({
      turn: { protocolEnvelopeRef: 'protocol-envelope:turn-current' },
      protocolEnvelope: { schemaVersion: 1 },
    });
    expect(JSON.stringify(event?.payload).match(/"padding"/gu)).toHaveLength(1);
  });

  it('rebuilds every Task3 projection table from events alone in dependency order', async () => {
    const filePath = await journalPath();
    const journal = new SqliteAgentJournal({ filePath });
    const command = await commitCommand(journal);
    const committed = await new RunEventCommitter(journal).commitValidatedAttempt(command);
    const { DatabaseSync: Database } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (path: string) => DatabaseSync;
    };
    const database = new Database(filePath);
    database.exec(`PRAGMA foreign_keys=OFF; DELETE FROM agent_invocations;
      DELETE FROM agent_protocol_envelopes; DELETE FROM agent_turns; DELETE FROM agent_attempts;
      DELETE FROM agent_turn_lifecycles; DELETE FROM agent_run_leases; DELETE FROM agent_runs;
      PRAGMA foreign_keys=ON;`);
    database.close();

    await journal.rebuildProjectProjections('project-a');

    await expect(journal.getCommittedTurn(command.turnId)).resolves.toEqual(committed.turn);
    await expect(journal.getProtocolEnvelope(command.turnId)).resolves.toEqual(committed.envelope);
    await expect(journal.listInvocations(command.runId)).resolves.toEqual(committed.invocations);
    await expect(journal.getRunProjection(command.runId)).resolves.toMatchObject({
      projectId: 'project-a', sessionId: 'session-a', revision: 4,
    });
    const verify = new Database(filePath);
    expect(verify.prepare('SELECT revision, status FROM agent_turn_lifecycles WHERE turn_id = ?')
      .get(command.turnId)).toEqual({ revision: 2, status: 'committed' });
    verify.close();
  });
});

async function commitCommand(journal: SqliteAgentJournal) {
  const created = await journal.createRun({
    projectId: 'project-a',
    sessionId: 'session-a',
    clientRequestId: 'request-a',
    input: { text: 'inspect orders' },
  });
  const lease = await journal.acquireRunLease({
    projectId: 'project-a',
    runId: created.runId,
    ownerId: 'worker-a',
    ttlMs: 60_000,
  });
  const leaseRef = { ownerId: lease.ownerId, fencingToken: lease.fencingToken };
  await journal.startRun({
    projectId: 'project-a', sessionId: 'session-a', runId: created.runId,
    commandId: 'start-current-run', lease: leaseRef, expectedRunRevision: 1,
  });
  await journal.startTurn({
    projectId: 'project-a', sessionId: 'session-a', runId: created.runId,
    turnId: 'turn-current', commandId: 'start-current-turn', lease: leaseRef,
    expectedRunRevision: 2,
  });
  return {
    projectId: 'project-a',
    sessionId: 'session-a',
    runId: created.runId,
    turnId: 'turn-current',
    commandId: 'commit-current',
    lease: leaseRef,
    expectedRunRevision: 3,
    expectedTurnRevision: 1,
    billingMode: 'byok' as const,
    attempt: await modelAttempt(),
  };
}

async function modelAttempt(): Promise<ValidatedModelAttempt> {
  return await validatedAttemptFixture();
}

async function journalPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dbagent-model-turn-'));
  tempDirs.push(directory);
  return join(directory, 'agent-journal.db');
}
