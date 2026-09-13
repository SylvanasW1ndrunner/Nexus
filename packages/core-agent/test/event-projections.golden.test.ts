import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/events/agent-event.js';
import { RunEventCommitter } from '../src/events/run-event-committer.js';
import { SqliteAgentJournal } from '../src/events/sqlite-agent-journal.js';
import { JournalSessionStore } from '../src/journal-session-store.js';
import {
  AuditProjector,
  ProjectionError,
  SessionProjectionAccumulator,
  UserActivityProjectionAccumulator,
  UserActivityProjector,
  projectSession,
} from '../src/session/session-projection.js';
import { validatedAttemptFixture } from './validated-attempt-fixture.js';

const temporaryDirectories: string[] = [];
const GOLDEN_ARTIFACT_ID = `artifact_${'b'.repeat(64)}`;
const GOLDEN_ARTIFACT_HANDLE = `agent-artifact:0e3ffbf31db2e5b45f9fe42a:${'b'.repeat(40)}`;
const GOLDEN_ARTIFACT_CHECKSUM = 'c'.repeat(64);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('Journal event projections', () => {
  it('drains more than 1000 activities without losing the rejected boundary event', () => {
    const base: AgentEvent[] = [
      {
        eventId: 'stream-input', sequence: 1, schemaVersion: 1,
        projectId: 'project-stream', sessionId: 'session-stream', runId: 'run-stream',
        type: 'input.received', occurredAt: '2026-09-03T00:00:00.000Z',
        payload: { clientRequestId: 'stream-request', content: 'stream activities' },
      },
      {
        eventId: 'stream-run', sequence: 3, schemaVersion: 2,
        projectId: 'project-stream', sessionId: 'session-stream', runId: 'run-stream',
        type: 'run.created', occurredAt: '2026-09-03T00:00:01.000Z',
        payload: { clientRequestId: 'stream-request' },
      },
      {
        eventId: 'stream-turn', sequence: 5, schemaVersion: 1,
        projectId: 'project-stream', sessionId: 'session-stream', runId: 'run-stream',
        turnId: 'turn-stream', type: 'turn.started', occurredAt: '2026-09-03T00:00:02.000Z',
        payload: {},
      },
      {
        eventId: 'stream-attempt', sequence: 7, schemaVersion: 1,
        projectId: 'project-stream', sessionId: 'session-stream', runId: 'run-stream',
        turnId: 'turn-stream', attemptId: 'attempt-stream', type: 'model_attempt_started',
        occurredAt: '2026-09-03T00:00:03.000Z',
        payload: { origin: { connectionId: 'connection', model: 'model', protocol: 'openai-chat' } },
      },
    ];
    const activities: AgentEvent[] = Array.from({ length: 1_001 }, (_, index) => ({
      eventId: `stream-delta-${index}`,
      sequence: 9 + index * 2,
      schemaVersion: 1 as const,
      projectId: 'project-stream', sessionId: 'session-stream', runId: 'run-stream',
      turnId: 'turn-stream', attemptId: 'attempt-stream', type: 'model_delta_batch' as const,
      occurredAt: '2026-09-03T00:00:04.000Z',
      payload: { blocks: [{ type: 'text', text: String(index) }] },
    }));
    const accumulator = new UserActivityProjectionAccumulator({
      projectId: 'project-stream', sessionId: 'session-stream', afterSequence: 0, limit: 1_000,
    });
    const pages = [];
    for (const event of [...base, ...activities]) {
      if (!accumulator.accept(event)) {
        pages.push(accumulator.drain());
        expect(accumulator.accept(event)).toBe(true);
      }
    }
    pages.push(accumulator.drain());

    const projected = pages.flatMap(({ items }) => items);
    expect(pages.map(({ items }) => items.length)).toEqual([1_000, 1]);
    expect(projected.map(({ sourceSequence }) => sourceSequence)).toEqual(
      activities.map(({ sequence }) => sequence),
    );
    expect(new Set(projected.map(({ activityId }) => activityId)).size).toBe(1_001);
    expect(pages[0]?.nextSourceSequence).toBe(activities[999]?.sequence);
    expect(pages[1]?.nextSourceSequence).toBe(activities[1_000]?.sequence);
    expect(accumulator.finish().items).toEqual([]);
  });

  it('keeps provider reasoning and Tool-call draft deltas out of User Activity', () => {
    const events: AgentEvent[] = [
      {
        eventId: 'private-input', sequence: 1, schemaVersion: 1,
        projectId: 'project-private', sessionId: 'session-private', runId: 'run-private',
        type: 'input.received', occurredAt: '2026-09-04T00:00:00.000Z',
        payload: { clientRequestId: 'private-request', content: 'inspect the project' },
      },
      {
        eventId: 'private-run', sequence: 2, schemaVersion: 2,
        projectId: 'project-private', sessionId: 'session-private', runId: 'run-private',
        type: 'run.created', occurredAt: '2026-09-04T00:00:01.000Z',
        payload: { clientRequestId: 'private-request' },
      },
      {
        eventId: 'private-turn', sequence: 3, schemaVersion: 1,
        projectId: 'project-private', sessionId: 'session-private', runId: 'run-private',
        turnId: 'turn-private', type: 'turn.started', occurredAt: '2026-09-04T00:00:02.000Z',
        payload: {},
      },
      {
        eventId: 'private-attempt', sequence: 4, schemaVersion: 1,
        projectId: 'project-private', sessionId: 'session-private', runId: 'run-private',
        turnId: 'turn-private', attemptId: 'attempt-private', type: 'model_attempt_started',
        occurredAt: '2026-09-04T00:00:03.000Z',
        payload: { origin: { connectionId: 'connection', model: 'model', protocol: 'openai-responses' } },
      },
      {
        eventId: 'private-delta', sequence: 5, schemaVersion: 1,
        projectId: 'project-private', sessionId: 'session-private', runId: 'run-private',
        turnId: 'turn-private', attemptId: 'attempt-private', type: 'model_delta_batch',
        occurredAt: '2026-09-04T00:00:04.000Z',
        payload: {
          blocks: [
            { type: 'reasoning-summary', text: 'provider-internal reasoning summary' },
            {
              type: 'tool-call-delta', blockOrdinal: 1, draftCallKey: 'draft-private',
              name: 'filesystem.read', argumentsDelta: '{"path":"secret"}',
            },
          ],
        },
      },
      {
        eventId: 'visible-delta', sequence: 6, schemaVersion: 1,
        projectId: 'project-private', sessionId: 'session-private', runId: 'run-private',
        turnId: 'turn-private', attemptId: 'attempt-private', type: 'model_delta_batch',
        occurredAt: '2026-09-04T00:00:05.000Z',
        payload: {
          blocks: [
            { type: 'reasoning-summary', text: 'still private' },
            { type: 'text', text: 'Reading the requested project.' },
          ],
        },
      },
    ];

    const projected = new UserActivityProjector().project(events, {
      projectId: 'project-private', sessionId: 'session-private', afterSequence: 0, limit: 100,
    });

    expect(projected.items).toEqual([
      expect.objectContaining({
        sourceSequence: 6,
        kind: 'model-preview',
        summary: 'Reading the requested project.',
      }),
    ]);
    expect(projected.nextSourceSequence).toBe(6);
    expect(JSON.stringify(projected)).not.toMatch(/provider-internal|draft-private|secret/u);
  });

  it('projects a pending approval as an actionable, de-noised user activity', () => {
    const events: AgentEvent[] = [
      {
        eventId: 'approval-input', sequence: 1, schemaVersion: 1,
        projectId: 'project-approval', sessionId: 'session-approval', runId: 'run-approval',
        type: 'input.received', occurredAt: '2026-09-03T00:00:00.000Z',
        payload: { clientRequestId: 'approval-request', content: 'Make the requested change.' },
      },
      {
        eventId: 'approval-run', sequence: 2, schemaVersion: 2,
        projectId: 'project-approval', sessionId: 'session-approval', runId: 'run-approval',
        type: 'run.created', occurredAt: '2026-09-03T00:00:01.000Z',
        payload: { clientRequestId: 'approval-request' },
      },
      {
        eventId: 'approval-turn', sequence: 3, schemaVersion: 1,
        projectId: 'project-approval', sessionId: 'session-approval', runId: 'run-approval',
        turnId: 'turn-approval', type: 'turn.started', occurredAt: '2026-09-03T00:00:02.000Z',
        payload: {},
      },
      {
        eventId: 'approval-attempt', sequence: 4, schemaVersion: 1,
        projectId: 'project-approval', sessionId: 'session-approval', runId: 'run-approval',
        turnId: 'turn-approval', attemptId: 'attempt-approval', type: 'model_attempt_started',
        occurredAt: '2026-09-03T00:00:03.000Z',
        payload: { origin: { connectionId: 'connection', model: 'model', protocol: 'openai-chat' } },
      },
      {
        eventId: 'approval-proposed', sequence: 5, schemaVersion: 1,
        projectId: 'project-approval', sessionId: 'session-approval', runId: 'run-approval',
        turnId: 'turn-approval', attemptId: 'attempt-approval', invocationId: 'invocation-internal',
        type: 'tool.proposed', occurredAt: '2026-09-03T00:00:04.000Z',
        payload: {
          invocationId: 'invocation-internal', callId: 'call-internal', actionOrdinal: 0,
          name: 'database.execute', arguments: { sql: 'update accounts set status = \'active\'' },
        },
      },
      {
        eventId: 'approval-requested', sequence: 6, schemaVersion: 1,
        projectId: 'project-approval', sessionId: 'session-approval', runId: 'run-approval',
        turnId: 'turn-approval', attemptId: 'attempt-approval', invocationId: 'invocation-internal',
        type: 'tool.approval_requested', occurredAt: '2026-09-03T00:00:05.000Z',
        payload: {
          summary: 'Apply the requested account-status change.',
          approval: {
            approvalId: 'approval-user-action', projectId: 'project-approval',
            sessionId: 'session-approval', runId: 'run-approval', turnId: 'turn-approval',
            invocationId: 'invocation-internal', canonicalToolId: { namespace: 'database', name: 'execute' },
            toolRevision: 'database.execute@7', recoveryClass: 'non_idempotent',
            intentDigest: 'd'.repeat(64), proposedRevision: 4, status: 'pending',
          },
        },
      },
    ];

    const projected = new UserActivityProjector().project(events, {
      projectId: 'project-approval', sessionId: 'session-approval', afterSequence: 0, limit: 100,
    });
    const approval = projected.items.find(({ kind }) => kind === 'approval');

    expect(approval).toMatchObject({
      kind: 'approval', phase: 'waiting',
      summary: 'Apply the requested account-status change.',
    });
    expect(approval?.detail).toEqual({
      approvalId: 'approval-user-action',
      actionSummary: 'Apply the requested account-status change.',
    });
    expect(JSON.stringify(approval)).not.toMatch(
      /normalizedArgumentsDigest|invocationId|toolRevision|canonicalToolId|namespace|decision/u,
    );
  });

  it('keeps an ordinary user Run visible when its request id uses the legacy-import prefix', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dbagent-projection-prefix-'));
    temporaryDirectories.push(directory);
    const journal = new SqliteAgentJournal({ filePath: join(directory, 'state.db') });
    const created = await journal.createRun({
      projectId: 'project-a', sessionId: 'session-prefix',
      clientRequestId: 'legacy-import:user-chosen', input: { text: 'ordinary input' },
    });
    const projection = await new JournalSessionStore(journal, 'project-a')
      .load('session-prefix', { limit: 100 });
    expect(projection.runs).toEqual([
      expect.objectContaining({
        runId: created.runId, clientRequestId: 'legacy-import:user-chosen', state: 'created',
      }),
    ]);
    expect(projection.messages).toEqual([
      expect.objectContaining({ runId: created.runId, role: 'user', content: 'ordinary input' }),
    ]);
  });

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
      expect.objectContaining({ artifactId: GOLDEN_ARTIFACT_ID, availability: 'available' }),
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
    expect(serializedUser).not.toContain(GOLDEN_ARTIFACT_CHECKSUM);
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
      projectId: 'project-a', sessionId: 'session-a', afterSequence: 0, limit: 10,
    });
    const sessionB = projectSession(events, {
      projectId: 'project-a', sessionId: 'session-b', afterSequence: 0, limit: 100,
    });
    expect(JSON.stringify(sessionA)).not.toContain('private second session');
    expect(JSON.stringify(sessionB)).not.toContain('请检查 orders');
    expect(sessionA.messages).toHaveLength(2);
    expect(sessionA.nextSourceSequence).toBe(events.at(-1)?.sequence);

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

  it('streams past 10k source events and keeps causality for activity and Session page 2', async () => {
    const fixture = await createLargeJournal();
    const store = new JournalSessionStore(fixture.journal, 'project-a');
    const first = await store.activities('session-large', {
      afterSequence: fixture.beforeTailSequence,
      limit: 1,
    });
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({ kind: 'artifact', sourceSequence: fixture.artifactSequence });
    expect(first.nextSourceSequence).toBe(fixture.artifactSequence);

    const second = await store.activities('session-large', {
      afterSequence: first.nextSourceSequence,
      limit: 1,
    });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]).toMatchObject({
      kind: 'artifact', phase: 'failed', sourceSequence: fixture.expiredSequence,
    });
    expect(second.nextSourceSequence).toBe(fixture.expiredSequence);

    const session = await store.load('session-large', {
      afterSequence: fixture.beforeTailSequence,
      limit: 1,
    });
    expect(session.artifacts).toHaveLength(1);
    expect(session.artifacts[0]?.sourceSequence).toBe(fixture.expiredSequence);
    expect(session.messages.length).toBeLessThanOrEqual(1);
    expect(session.runs.length).toBeLessThanOrEqual(1);
    expect(session.nextSourceSequence).toBe(fixture.expiredSequence);
  });

  it('releases more than 10k terminal Run scopes before applying a late cursor', () => {
    const events = terminalRunEvents(10_050);
    const afterSequence = events.at(-1)!.sequence;
    const session = new SessionProjectionAccumulator({
      projectId: 'project-retention', sessionId: 'session-retention', afterSequence, limit: 1,
    }, true);
    const user = new UserActivityProjectionAccumulator({
      projectId: 'project-retention', sessionId: 'session-retention', afterSequence, limit: 1,
    }, true);
    for (const event of events) {
      expect(session.accept(event)).toBe(true);
      expect(user.accept(event)).toBe(true);
    }
    expect(session.retainedScopes()).toEqual({
      events: 0, runs: 0, turns: 0, attempts: 0, invocations: 0, finalText: 0,
    });
    expect(user.retainedScopes()).toEqual({
      events: 0, runs: 0, turns: 0, attempts: 0, invocations: 0, finalText: 0,
    });
    expect(session.finish().runs).toEqual([]);
    expect(user.finish().items).toEqual([]);
  });

  it('retains a terminal Run until its last asynchronous subagent outcome arrives', () => {
    const base = {
      projectId: 'project-retention', sessionId: 'session-retention', runId: 'run-with-child',
      occurredAt: '2026-08-10T00:00:00.000Z',
    };
    const events: AgentEvent[] = [
      {
        ...base, eventId: 'event-child-1', sequence: 1, schemaVersion: 1,
        type: 'input.received', payload: { clientRequestId: 'request-with-child', content: 'delegate' },
      },
      {
        ...base, eventId: 'event-child-2', sequence: 2, schemaVersion: 2,
        type: 'run.created', payload: { clientRequestId: 'request-with-child' },
      },
      {
        ...base, eventId: 'event-child-3', sequence: 3, schemaVersion: 1,
        type: 'subagent.started', payload: { subagentId: 'child-1', summary: 'started' },
      },
      {
        ...base, eventId: 'event-child-4', sequence: 4, schemaVersion: 1,
        type: 'run.failed', payload: { code: 'PARENT_TERMINAL' },
      },
      {
        ...base, eventId: 'event-child-5', sequence: 5, schemaVersion: 1,
        type: 'subagent.completed', payload: { subagentId: 'child-1', summary: 'done', refs: [] },
      },
    ];
    const projection = new SessionProjectionAccumulator({
      projectId: base.projectId, sessionId: base.sessionId, afterSequence: 0, limit: 10,
    }, true);

    for (const event of events) expect(projection.accept(event)).toBe(true);

    expect(projection.finish().runs).toEqual([
      expect.objectContaining({ runId: base.runId, state: 'Failed' }),
    ]);
    expect(projection.retainedScopes()).toEqual({
      events: 0, runs: 0, turns: 0, attempts: 0, invocations: 0, finalText: 0,
    });
  });

  it('pages thousands of Runs and messages under one exact visible-item limit', () => {
    const events = terminalRunEvents(2_000);
    const seenMessages = new Set<number>();
    const seenRuns = new Set<string>();
    let cursor = 0;
    while (cursor < events.at(-1)!.sequence) {
      const page = projectSession(events, {
        projectId: 'project-retention', sessionId: 'session-retention',
        afterSequence: cursor, limit: 37,
      });
      expect(page.messages.length + page.artifacts.length + page.runs.length)
        .toBeLessThanOrEqual(37);
      expect(page.nextSourceSequence).toBeGreaterThan(cursor);
      for (const message of page.messages) {
        expect(seenMessages.has(message.sourceSequence)).toBe(false);
        seenMessages.add(message.sourceSequence);
      }
      for (const run of page.runs) {
        expect(seenRuns.has(run.runId)).toBe(false);
        seenRuns.add(run.runId);
      }
      cursor = page.nextSourceSequence;
    }
    expect(seenMessages.size).toBe(2_000);
    expect(seenRuns.size).toBe(2_000);
  });

  it('validates current payloads and Turn/Attempt ownership during pure projection', async () => {
    const fixture = await createGoldenJournal();
    const events = await readAll(fixture.journal, 'project-a', 100);
    const badPayload = structuredClone(events);
    const artifact = badPayload.find(({ type }) => type === 'artifact.created');
    if (artifact?.type !== 'artifact.created') throw new Error('Artifact fixture is missing.');
    artifact.payload.byteSize = 'seventeen' as never;
    expectProjectionError(() => projectSession(badPayload, {
      projectId: 'project-a', sessionId: 'session-a', afterSequence: 0, limit: 100,
    }), 'SCHEMA_INVALID');

    const badAttempt = structuredClone(events);
    const committed = badAttempt.find(({ type }) => type === 'model_attempt_committed');
    if (committed?.type !== 'model_attempt_committed') throw new Error('Attempt fixture is missing.');
    committed.attemptId = 'attempt-owned-by-another-turn';
    expectProjectionError(() => new AuditProjector().project(badAttempt, {
      projectId: 'project-a', sessionId: 'session-a', afterSequence: 0, limit: 100,
    }), 'CAUSALITY_INVALID');
  });

  it('resolves final content by exact finalContentRef and keeps evidence out of artifact refs', async () => {
    const fixture = await createGoldenJournal();
    const persisted = await readAll(fixture.journal, 'project-a', 100);
    const events = withDiscardedPreview(persisted);
    const user = new UserActivityProjector().project(events, {
      projectId: 'project-a', sessionId: 'session-a', afterSequence: 0, limit: 100,
    });
    const artifact = user.items.find(({ kind }) => kind === 'artifact');
    expect(artifact?.detail).toEqual({
      handle: GOLDEN_ARTIFACT_HANDLE,
      mediaType: 'text/plain',
      byteSize: 17,
      availability: 'available',
    });
    expect(JSON.stringify(artifact)).not.toContain(GOLDEN_ARTIFACT_ID);
    const final = user.items.find(({ kind }) => kind === 'final');
    expect(final?.summary).toBe('I will inspect it.');
    expect(final?.artifactRefs).toBeUndefined();

    const wrongRef = structuredClone(events);
    const completed = wrongRef.find(({ type }) => type === 'run.completed');
    if (completed?.type !== 'run.completed') throw new Error('Completion fixture is missing.');
    completed.payload.finalContentRef = 'turn:turn-golden:text:99';
    expectProjectionError(() => new UserActivityProjector().project(wrongRef, {
      projectId: 'project-a', sessionId: 'session-a', afterSequence: 0, limit: 100,
    }), 'CAUSALITY_INVALID');
  });
});

function expectProjectionError(operation: () => unknown, code: ProjectionError['code']): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectionError);
    if (!(error instanceof ProjectionError)) throw error;
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`Expected ProjectionError ${code}.`);
}

function terminalRunEvents(count: number): AgentEvent[] {
  const events: AgentEvent[] = [];
  let sequence = 0;
  for (let index = 0; index < count; index += 1) {
    const runId = `run-retention-${index}`;
    const base = {
      projectId: 'project-retention',
      sessionId: 'session-retention',
      runId,
      occurredAt: '2026-08-10T00:00:00.000Z',
    };
    events.push({
      ...base,
      eventId: `event-retention-${++sequence}`,
      sequence, schemaVersion: 1,
      type: 'input.received',
      payload: { clientRequestId: `request-${index}`, content: `input-${index}` },
    });
    events.push({
      ...base,
      eventId: `event-retention-${++sequence}`,
      sequence, schemaVersion: 2,
      type: 'run.created',
      payload: { clientRequestId: `request-${index}` },
    });
    events.push({
      ...base,
      eventId: `event-retention-${++sequence}`,
      sequence, schemaVersion: 1,
      type: 'run.failed',
      payload: { code: 'LEGACY_TERMINAL' },
    });
  }
  return events;
}

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
    expectedRunRevision: 3, expectedTurnRevision: 1, billingMode: 'byok',
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
          artifactId: GOLDEN_ARTIFACT_ID,
          handle: GOLDEN_ARTIFACT_HANDLE,
          checksum: GOLDEN_ARTIFACT_CHECKSUM,
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

async function createLargeJournal() {
  const directory = await mkdtemp(join(tmpdir(), 'dbagent-projection-large-'));
  temporaryDirectories.push(directory);
  const filePath = join(directory, 'state.db');
  const journal = new SqliteAgentJournal({
    filePath,
    now: () => '2026-08-09T12:00:00.000Z',
  });
  const created = await journal.createRun({
    projectId: 'project-a', sessionId: 'session-large', clientRequestId: 'large-projection',
    input: { text: 'large projection input' },
  });
  const lease = await journal.acquireRunLease({
    projectId: 'project-a', runId: created.runId, ownerId: 'large-worker', ttlMs: 60_000,
  });
  const leaseRef = { ownerId: lease.ownerId, fencingToken: lease.fencingToken };
  await journal.startRun({
    projectId: 'project-a', sessionId: 'session-large', runId: created.runId,
    commandId: 'large-start', lease: leaseRef, expectedRunRevision: 1,
  });
  const filler = Array.from({ length: 10_005 }, (_, index) => ({
    type: 'artifact.expired' as const,
    payload: { artifactId: `artifact_${index.toString(16).padStart(64, '0')}` },
  }));
  const committed = await journal.commit({
    projectId: 'project-a', sessionId: 'session-large', runId: created.runId,
    commandId: 'large-tail', lease: leaseRef, expectedRunRevision: 2,
    events: [
      ...filler,
      {
        type: 'artifact.created',
        payload: {
          artifactId: GOLDEN_ARTIFACT_ID,
          handle: GOLDEN_ARTIFACT_HANDLE,
          checksum: GOLDEN_ARTIFACT_CHECKSUM,
          byteSize: 17,
          mediaType: 'text/plain',
          availability: 'available',
          summary: 'large tail artifact',
        },
      },
      { type: 'artifact.expired', payload: { artifactId: GOLDEN_ARTIFACT_ID } },
    ],
  });
  const artifact = committed.events.at(-2);
  const expired = committed.events.at(-1);
  if (artifact?.type !== 'artifact.created' || expired?.type !== 'artifact.expired') {
    throw new Error('Large Journal tail was not committed.');
  }
  return {
    journal,
    beforeTailSequence: artifact.sequence - 1,
    artifactSequence: artifact.sequence,
    expiredSequence: expired.sequence,
  };
}

function withDiscardedPreview(events: AgentEvent[]): AgentEvent[] {
  const scope = events.find(({ sessionId }) => sessionId === 'session-a');
  if (!scope) throw new Error('Projection fixture scope is missing.');
  const sequence = events.at(-1)!.sequence;
  return [
    ...events,
    {
      eventId: 'event-final', projectId: scope.projectId, sequence: sequence + 1,
      schemaVersion: 2, sessionId: scope.sessionId, runId: scope.runId,
      type: 'run.completed', occurredAt: '2026-08-09T12:00:59.000Z',
      payload: {
        finalContentRef: 'turn:turn-golden:text:0',
        deliveryStatus: 'not-required',
        // This ordinary final answer adopts no Tool evidence. Artifact identity
        // is projected by artifact.created and is not a Delivery Evidence Ref.
        evidenceRefs: [],
      },
    },
    {
      eventId: 'event-preview-start', projectId: scope.projectId, sequence: sequence + 2,
      schemaVersion: 1, sessionId: scope.sessionId, runId: scope.runId,
      turnId: 'turn-golden', attemptId: 'attempt-preview', type: 'model_attempt_started',
      occurredAt: '2026-08-09T12:01:00.000Z',
      payload: {
        origin: {
          connectionId: 'preview-connection', model: 'preview', protocol: 'openai-responses',
        },
      },
    },
    {
      eventId: 'event-preview', projectId: scope.projectId, sequence: sequence + 3,
      schemaVersion: 1, sessionId: scope.sessionId, runId: scope.runId,
      turnId: 'turn-golden', attemptId: 'attempt-preview', type: 'model_delta_batch',
      occurredAt: '2026-08-09T12:01:01.000Z',
      payload: { blocks: [{ type: 'text', text: 'tentative preview' }] },
    },
    {
      eventId: 'event-preview-discard', projectId: scope.projectId, sequence: sequence + 4,
      schemaVersion: 1, sessionId: scope.sessionId, runId: scope.runId,
      turnId: 'turn-golden', attemptId: 'attempt-preview', type: 'model_attempt_discarded',
      occurredAt: '2026-08-09T12:01:02.000Z',
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
