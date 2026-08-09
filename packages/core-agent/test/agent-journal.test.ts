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
    await journal.commit({
      projectId: 'project-a',
      sessionId: 'session-a',
      runId: created.runId,
      commandId: 'start-a',
      lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken },
      events: [{ type: 'run.started', payload: {} }],
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
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'COMMITTER_REQUIRED' });
    expect(await journal.countEvents('model_attempt_committed', 'project-a')).toBe(0);
  });
});

async function journalPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dbagent-agent-journal-'));
  tempDirs.push(directory);
  return join(directory, 'nested', 'agent-journal.db');
}
