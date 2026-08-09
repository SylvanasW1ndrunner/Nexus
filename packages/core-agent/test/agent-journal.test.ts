import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_EVENT_SCHEMA_REGISTRY,
  AgentJournalError,
  SqliteAgentJournal,
  replayAgentEvents,
  upcastAgentEvent,
} from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('SqliteAgentJournal', () => {
  it('persists gap-free project events and rebuilds the same projection after reopening', async () => {
    const filePath = await journalPath();
    const journal = new SqliteAgentJournal({ filePath, now: () => '2026-08-09T00:00:00.000Z' });
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
      ttlMs: 10_000,
    });
    await journal.startRun({
      projectId: 'project-a',
      sessionId: 'session-a',
      runId: created.runId,
      commandId: 'start-a',
      lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken },
      expectedRunRevision: 1,
    });

    const firstRead = await journal.readProject('project-a', 0, 100);
    expect(firstRead.map((event) => [event.sequence, event.type])).toEqual([
      [1, 'input.received'],
      [2, 'run.created'],
      [3, 'run.started'],
    ]);
    expect(firstRead.every((event) => event.schemaVersion === 1)).toBe(true);
    expect(new Set(firstRead.map((event) => event.eventId)).size).toBe(3);
    expect(await journal.readProject('project-a', 1, 1)).toMatchObject([
      { sequence: 2, type: 'run.created' },
    ]);

    const reopened = new SqliteAgentJournal({ filePath });
    const secondRead = await reopened.readProject('project-a', 0, 100);
    expect(secondRead).toEqual(firstRead);
    expect(await reopened.getRunProjection(created.runId)).toMatchObject({
      projectId: 'project-a',
      sessionId: 'session-a',
      runId: created.runId,
      state: 'Preparing',
      revision: 2,
    });
    expect(replayAgentEvents(firstRead)).toEqual(replayAgentEvents(secondRead));
    expect(replayAgentEvents(firstRead)).toEqual(replayAgentEvents(firstRead));
  });

  it('uses a static schema registry and upcasts without rewriting stored events', () => {
    expect(Object.keys(AGENT_EVENT_SCHEMA_REGISTRY)).toEqual(
      expect.arrayContaining([
        'input.received',
        'run.created',
        'model_attempt_committed',
        'tool.proposed',
        'usage.recorded',
      ]),
    );
    expect(AGENT_EVENT_SCHEMA_REGISTRY['model_attempt_committed']).toMatchObject({
      schemaVersion: 1,
      persistence: 'durable',
      audience: ['internal', 'model', 'audit'],
    });
    const event = {
      eventId: 'event-1',
      projectId: 'project-a',
      sequence: 9,
      schemaVersion: 1,
      sessionId: 'session-a',
      runId: 'run-a',
      type: 'run.started' as const,
      occurredAt: '2026-08-09T00:00:00.000Z',
      payload: {},
    };
    expect(upcastAgentEvent(event)).toEqual(event);
    expect(upcastAgentEvent(event)).not.toBe(event);
  });

  it('rejects producer-controlled metadata, unknown schemas, secrets, and non-portable payloads', async () => {
    const journal = new SqliteAgentJournal({ filePath: await journalPath() });
    const created = await journal.createRun({
      projectId: 'project-a',
      sessionId: 'session-a',
      clientRequestId: 'request-a',
      input: 'hello',
    });
    const lease = await journal.acquireRunLease({
      projectId: 'project-a',
      runId: created.runId,
      ownerId: 'worker-a',
      ttlMs: 10_000,
    });
    const base = {
      projectId: 'project-a',
      sessionId: 'session-a',
      runId: created.runId,
      lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken },
      expectedRunRevision: 1,
    };

    await expect(
      journal.commit({
        ...base,
        commandId: 'invent-metadata',
        events: [
          {
            type: 'run.started',
            payload: {},
            schemaVersion: 99,
            audience: ['user'],
          } as never,
        ],
      }),
    ).rejects.toMatchObject({ code: 'PRODUCER_METADATA_FORBIDDEN' });
    await expect(
      journal.commit({
        ...base,
        commandId: 'invent-type',
        events: [{ type: 'run.invented', payload: {} } as never],
      }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_EVENT_TYPE' });
    await expect(
      journal.commit({
        ...base,
        commandId: 'secret-payload',
        events: [{ type: 'run.failed', payload: { code: 'AUTH', detail: { apiKey: 'sk-secret' } } }],
      }),
    ).rejects.toBeInstanceOf(AgentJournalError);
    await expect(
      journal.commit({
        ...base,
        commandId: 'error-payload',
        events: [{ type: 'run.failed', payload: new Error('raw error') } as never],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_EVENT_PAYLOAD' });
    await expect(journal.countEvents(undefined, 'project-a')).resolves.toBe(2);
  });

  it('reserves committed model and proposed Tool facts for RunEventCommitter', async () => {
    const journal = new SqliteAgentJournal({ filePath: await journalPath() });
    const created = await journal.createRun({
      projectId: 'project-a',
      sessionId: 'session-a',
      clientRequestId: 'request-a',
      input: 'hello',
    });
    const lease = await journal.acquireRunLease({
      projectId: 'project-a',
      runId: created.runId,
      ownerId: 'worker-a',
      ttlMs: 10_000,
    });

    await expect(
      journal.commit({
        projectId: 'project-a',
        sessionId: 'session-a',
        runId: created.runId,
        commandId: 'raw-model-commit',
        lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken },
        expectedRunRevision: 1,
        events: [
          {
            type: 'model_attempt_committed',
            turnId: 'turn-a',
            attemptId: 'attempt-a',
            payload: {
              attemptId: 'attempt-a',
              blocks: [{ type: 'text', text: 'bypass' }],
              finishReason: 'stop',
              protocolEnvelopeRef: 'forged-envelope',
            },
          } as never,
        ],
      }),
    ).rejects.toMatchObject({ code: 'COMMITTER_REQUIRED' });
    expect(await journal.countEvents('model_attempt_committed', 'project-a')).toBe(0);
  });

  it('rejects unknown command and draft keys before they can override journal-owned identity', async () => {
    const journal = new SqliteAgentJournal({ filePath: await journalPath() });
    const first = await journal.createRun({
      projectId: 'project-a', sessionId: 'session-a', clientRequestId: 'request-a', input: 'a',
    });
    const second = await journal.createRun({
      projectId: 'project-b', sessionId: 'session-b', clientRequestId: 'request-b', input: 'b',
    });
    const lease = await journal.acquireRunLease({
      projectId: 'project-a', runId: first.runId, ownerId: 'worker-a', ttlMs: 10_000,
    });
    const base = {
      projectId: 'project-a', sessionId: 'session-a', runId: first.runId,
      commandId: 'identity-attack',
      lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken },
      expectedRunRevision: 1,
      events: [{
        type: 'run.started', payload: {}, projectId: 'project-b', sessionId: 'session-b',
        runId: second.runId, lease: { ownerId: 'attacker', fencingToken: 999 },
      }],
    } as unknown as Parameters<SqliteAgentJournal['commit']>[0];

    await expect(journal.commit(base)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(journal.commit({ ...base, events: [{ type: 'run.started', payload: {} }], extra: true } as never))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(journal.getRunProjection(first.runId)).resolves.toMatchObject({ revision: 1 });
    await expect(journal.getRunProjection(second.runId)).resolves.toMatchObject({ revision: 1 });
  });

  it.each([
    'run.completed', 'turn.started', 'model_attempt_started', 'model_failed',
    'tool.started', 'tool.succeeded', 'tool.observed',
  ] as const)('rejects generic writes of authority-bearing %s facts', async (type) => {
    const journal = new SqliteAgentJournal({ filePath: await journalPath() });
    const created = await journal.createRun({
      projectId: 'project-a', sessionId: 'session-a', clientRequestId: 'request-a', input: 'a',
    });
    const lease = await journal.acquireRunLease({
      projectId: 'project-a', runId: created.runId, ownerId: 'worker-a', ttlMs: 10_000,
    });
    await expect(journal.commit({
      projectId: 'project-a', sessionId: 'session-a', runId: created.runId,
      commandId: `reserved-${type}`,
      lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken },
      expectedRunRevision: 1,
      events: [{ type, payload: {} } as never],
    })).rejects.toMatchObject({ code: 'COMMITTER_REQUIRED' });
  });

  it('reserves input.received for createRun even when a generic producer holds the lease', async () => {
    const journal = new SqliteAgentJournal({ filePath: await journalPath() });
    const created = await journal.createRun({
      projectId: 'project-a', sessionId: 'session-a', clientRequestId: 'input-authority',
      input: { text: 'original' },
    });
    const lease = await journal.acquireRunLease({
      projectId: 'project-a', runId: created.runId, ownerId: 'worker-a', ttlMs: 10_000,
    });

    await expect(journal.commit({
      projectId: 'project-a', sessionId: 'session-a', runId: created.runId,
      commandId: 'forge-second-input',
      lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken },
      expectedRunRevision: 1,
      events: [{
        type: 'input.received',
        payload: { clientRequestId: 'forged-request', content: { text: 'forged' } },
      }],
    })).rejects.toMatchObject({ code: 'COMMITTER_REQUIRED' });
    await expect(journal.countEvents('input.received', 'project-a')).resolves.toBe(1);
  });

  it('does not expose the prepared model-attempt persistence primitive', async () => {
    const journal = new SqliteAgentJournal({ filePath: await journalPath() });
    expect('commitPreparedModelAttempt' in journal).toBe(false);
  });
});

async function journalPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dbagent-agent-journal-'));
  tempDirs.push(directory);
  return join(directory, 'nested', 'agent-journal.db');
}
