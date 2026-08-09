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

describe('RunEventCommitter', () => {
  it('atomically materializes ordered drafts, current wire identities, and opaque refs', async () => {
    const journal = new SqliteAgentJournal({ filePath: await journalPath() });
    const command = await commitCommand(journal);

    const committed = await new RunEventCommitter(journal).commitValidatedAttempt(command);

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
    ).rejects.toMatchObject({ code: 'INVALID_EVENT_PAYLOAD' });

    expect(await journal.getCommittedTurn(command.turnId)).toBeNull();
    expect(await journal.listInvocations(command.runId)).toEqual([]);
    expect(await journal.countEvents('model_attempt_committed', 'project-a')).toBe(0);
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
  return {
    projectId: 'project-a',
    sessionId: 'session-a',
    runId: created.runId,
    turnId: 'turn-current',
    commandId: 'commit-current',
    lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken },
    attempt: modelAttempt(),
  };
}

function modelAttempt(): ValidatedModelAttempt {
  return {
    attemptId: 'attempt-current',
    origin: {
      connectionId: 'connection-current',
      model: 'model-current',
      protocol: 'openai-responses',
    },
    terminal: true,
    validation: 'validated',
    finishReason: 'tool-calls',
    usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
    opaqueBlockRefs: ['attempt-current:opaque:2'],
    blocks: [
      { type: 'text', text: 'I will inspect it.' },
      {
        type: 'tool-call-draft',
        draftCallKey: 'attempt-current:1',
        wireIdentity: { callId: 'wire-current-a', providerItemId: 'item-current-a' },
        name: 'query_database',
        arguments: { sql: 'select 1' },
      },
      {
        type: 'provider-opaque',
        opaqueRef: 'attempt-current:opaque:2',
        protocol: 'openai-responses',
        origin: { connectionId: 'connection-current', model: 'model-current' },
        replay: 'same-connection-only',
        value: { encrypted: 'opaque-current' },
      },
      {
        type: 'tool-call-draft',
        draftCallKey: 'attempt-current:3',
        wireIdentity: { callId: 'wire-current-b', providerItemId: 'item-current-b' },
        name: 'read_result',
        arguments: { resultRef: 'result-current' },
      },
    ],
  };
}

async function journalPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dbagent-model-turn-'));
  tempDirs.push(directory);
  return join(directory, 'agent-journal.db');
}
