import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/events/agent-event.js';
import { RunEventCommitter } from '../src/events/run-event-committer.js';
import { SqliteAgentJournal } from '../src/events/sqlite-agent-journal.js';
import {
  AuditProjector,
  ProjectionError,
  UserActivityProjector,
  projectSession,
} from '../src/session/session-projection.js';
import { validatedAttemptFixture } from './validated-attempt-fixture.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('Journal event projections', () => {
  it('replays byte-equal Session, User and Audit views twice and across two reopens', async () => {
    const fixture = await createGoldenJournal();
    const firstEvents = await readAll(fixture.journal, 'project-a', 2);
    const first = projectAll(firstEvents, 'session-a');
    const second = projectAll(firstEvents, 'session-a');

    const reopenedOnce = new SqliteAgentJournal({ filePath: fixture.filePath });
    const reopenedTwice = new SqliteAgentJournal({ filePath: fixture.filePath });
    const third = projectAll(await readAll(reopenedOnce, 'project-a', 3), 'session-a');
    const fourth = projectAll(await readAll(reopenedTwice, 'project-a', 1), 'session-a');

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(third).toEqual(first);
    expect(fourth).toEqual(first);
    expect(first.session.messages.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: 'user', content: '请检查 orders' },
      { role: 'assistant', content: 'I will inspect it.' },
    ]);
    expect(first.session.artifacts).toEqual([
      expect.objectContaining({ artifactId: 'artifact-golden', availability: 'available' }),
    ]);
    expect(first.session.lastSourceSequence).toBe(firstEvents.at(-1)?.sequence);
  });

  it('uses filtered Journal source cursors and discards tentative preview without making it final', async () => {
    const fixture = await createGoldenJournal();
    const persisted = await readAll(fixture.journal, 'project-a', 100);
    const events = withDiscardedPreview(persisted);
    const projector = new UserActivityProjector();
    const all = projector.project(events, {
      projectId: 'project-a',
      sessionId: 'session-a',
      afterSequence: 0,
      limit: 100,
    });
    const preview = all.items.find(({ kind }) => kind === 'model-preview');
    const discarded = all.items.find(
      ({ kind, phase }) => kind === 'model-preview' && phase === 'discarded',
    );
    expect(preview?.replaceKey).toBe('attempt-preview');
    expect(discarded?.replaceKey).toBe('attempt-preview');
    expect(all.items.some(({ kind, summary }) => kind === 'final' && summary.includes('tentative')))
      .toBe(false);

    const gapIndex = all.items.findIndex((item, index) =>
      index > 0 && item.sourceSequence > all.items[index - 1]!.sourceSequence + 1,
    );
    expect(gapIndex).toBeGreaterThan(0);
    const cursor = all.items[gapIndex - 1]?.sourceSequence;
    const resumed = projector.project(events, {
      projectId: 'project-a',
      sessionId: 'session-a',
      afterSequence: cursor ?? 0,
      limit: 2,
    });
    expect(resumed.items.every(({ sourceSequence }) => sourceSequence > (cursor ?? 0))).toBe(true);
    expect(resumed.items[0]?.sourceSequence).toBeGreaterThan((cursor ?? 0) + 1);

    const serializedUser = JSON.stringify(all);
    expect(serializedUser).not.toContain('protocolEnvelopeRef');
    expect(serializedUser).not.toContain('draftCallKey');
    expect(serializedUser).not.toContain('checksum-golden');
    expect(serializedUser).not.toContain(fixture.directory);
    const audit = new AuditProjector().project(events, {
      projectId: 'project-a',
      sessionId: 'session-a',
      afterSequence: 0,
      limit: 100,
    });
    expect(JSON.stringify(audit)).toContain('protocolEnvelopeRef');
  });

  it('isolates sessions, paginates without renumbering and rejects corrupt causality', async () => {
    const fixture = await createGoldenJournal();
    await fixture.journal.createRun({
      projectId: 'project-a',
      sessionId: 'session-b',
      clientRequestId: 'request-session-b',
      input: { text: 'private second session' },
    });
    const events = await readAll(fixture.journal, 'project-a', 100);
    const sessionA = projectSession(events, {
      projectId: 'project-a', sessionId: 'session-a', afterSequence: 0, limit: 2,
    });
    const sessionB = projectSession(events, {
      projectId: 'project-a', sessionId: 'session-b', afterSequence: 0, limit: 100,
    });
    expect(JSON.stringify(sessionA)).not.toContain('private second session');
    expect(JSON.stringify(sessionB)).not.toContain('请检查 orders');
    expect(sessionA.messages).toHaveLength(2);
    expect(sessionA.nextSourceSequence).toBe(sessionA.messages.at(-1)?.sourceSequence);

    const duplicateSequence = structuredClone(events);
    duplicateSequence[1] = { ...duplicateSequence[1]!, sequence: duplicateSequence[0]!.sequence };
    expect(() => projectSession(duplicateSequence, {
      projectId: 'project-a', sessionId: 'session-a', afterSequence: 0, limit: 100,
    })).toThrowError(ProjectionError);

    const brokenParent = structuredClone(events);
    const child = brokenParent.find(({ parentEventId }) => parentEventId !== undefined);
    if (child) child.parentEventId = 'missing-parent';
    expect(() => new AuditProjector().project(brokenParent, {
      projectId: 'project-a', sessionId: 'session-a', afterSequence: 0, limit: 100,
    })).toThrowError(ProjectionError);
  });
});

async function createGoldenJournal() {
  const directory = await mkdtemp(join(tmpdir(), 'dbagent-projection-golden-'));
  temporaryDirectories.push(directory);
  const filePath = join(directory, 'state.db');
  let clock = 0;
  const journal = new SqliteAgentJournal({
    filePath,
    now: () => `2026-08-09T12:00:${String(clock++).padStart(2, '0')}.000Z`,
  });
  const created = await journal.createRun({
    projectId: 'project-a',
    sessionId: 'session-a',
    clientRequestId: 'projection-golden',
    input: { text: '请检查 orders' },
  });
  const lease = await journal.acquireRunLease({
    projectId: 'project-a', runId: created.runId, ownerId: 'projection-worker', ttlMs: 60_000,
  });
  const leaseRef = { ownerId: lease.ownerId, fencingToken: lease.fencingToken };
  await journal.startRun({
    projectId: 'project-a', sessionId: 'session-a', runId: created.runId,
    commandId: 'projection-start', lease: leaseRef, expectedRunRevision: 1,
  });
  await journal.startTurn({
    projectId: 'project-a', sessionId: 'session-a', runId: created.runId,
    turnId: 'turn-golden', commandId: 'projection-turn', lease: leaseRef, expectedRunRevision: 2,
  });
  await new RunEventCommitter(journal).commitValidatedAttempt({
    projectId: 'project-a', sessionId: 'session-a', runId: created.runId,
    turnId: 'turn-golden', commandId: 'projection-model-commit', lease: leaseRef,
    expectedRunRevision: 3, expectedTurnRevision: 1,
    attempt: await validatedAttemptFixture('attempt-golden'),
  });
  const projection = await journal.getRunProjection(created.runId);
  if (!projection) throw new Error('Fixture run projection is missing.');
  await journal.commit({
    projectId: 'project-a', sessionId: 'session-a', runId: created.runId,
    commandId: 'projection-final', lease: leaseRef, expectedRunRevision: projection.revision,
    events: [
      {
        type: 'artifact.created',
        payload: {
          artifactId: 'artifact-golden',
          handle: 'agent-artifact:artifact-golden',
          checksum: 'checksum-golden',
          byteSize: 17,
          mediaType: 'text/plain',
          availability: 'available',
          summary: 'Golden output',
        },
      },
    ],
  });
  return { directory, filePath, journal };
}

function withDiscardedPreview(events: AgentEvent[]): AgentEvent[] {
  const scope = events.find(({ sessionId }) => sessionId === 'session-a');
  if (!scope) throw new Error('Projection fixture scope is missing.');
  const sequence = events.at(-1)!.sequence;
  return [
    ...events,
    {
      eventId: 'event-final', projectId: scope.projectId, sequence: sequence + 1,
      schemaVersion: 1, sessionId: scope.sessionId, runId: scope.runId,
      type: 'run.completed', occurredAt: '2026-08-09T12:00:59.000Z',
      payload: {
        finalContentRef: 'turn:turn-golden:text:0',
        deliveryStatus: 'delivered',
        evidenceRefs: ['artifact-golden'],
      },
    },
    {
      eventId: 'event-preview', projectId: scope.projectId, sequence: sequence + 2,
      schemaVersion: 1, sessionId: scope.sessionId, runId: scope.runId,
      turnId: 'turn-golden', attemptId: 'attempt-preview', type: 'model_delta_batch',
      occurredAt: '2026-08-09T12:01:00.000Z',
      payload: { blocks: [{ type: 'text', text: 'tentative preview' }] },
    },
    {
      eventId: 'event-preview-discard', projectId: scope.projectId, sequence: sequence + 3,
      schemaVersion: 1, sessionId: scope.sessionId, runId: scope.runId,
      turnId: 'turn-golden', attemptId: 'attempt-preview', type: 'model_attempt_discarded',
      occurredAt: '2026-08-09T12:01:01.000Z',
      payload: { reason: 'STREAM_DISCONNECTED' },
    },
  ];
}

function projectAll(
  events: Awaited<ReturnType<SqliteAgentJournal['readProject']>>,
  sessionId: string,
) {
  const options = { projectId: 'project-a', sessionId, afterSequence: 0, limit: 100 };
  return {
    session: projectSession(events, options),
    user: new UserActivityProjector().project(events, options),
    audit: new AuditProjector().project(events, options),
  };
}

async function readAll(journal: SqliteAgentJournal, projectId: string, pageSize: number) {
  const events: Awaited<ReturnType<SqliteAgentJournal['readProject']>> = [];
  let cursor = 0;
  while (true) {
    const page = await journal.readProject(projectId, cursor, pageSize);
    if (page.length === 0) return events;
    events.push(...page);
    cursor = page.at(-1)!.sequence;
  }
}
