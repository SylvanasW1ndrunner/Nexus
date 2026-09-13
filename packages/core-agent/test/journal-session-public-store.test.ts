import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteAgentJournal } from '../src/events/sqlite-agent-journal.js';
import { JournalSessionStore } from '../src/journal-session-store.js';
import {
  SessionModelBindingStore,
  describeRuntimeBinding,
} from '../src/kernel/session-model-binding.js';
import { createTestModelSession } from './model-session-fixture.js';

const roots: string[] = [];
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => NodeDatabaseSync;
};

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('Journal-backed public Session store', () => {
  it('atomically bootstraps model binding and the exact initial Skill configuration', async () => {
    const fixture = createFixture();
    const session = await createTestModelSession({
      connectionId: 'connection-bootstrap', modelId: 'model-bootstrap',
    });
    const command = {
      sessionId: 'session-bootstrap',
      commandId: 'bootstrap-request',
      model: describeRuntimeBinding(session),
      definitions: [{ content: '# Frozen default\nUse the creation-time default.' }],
    } as const;

    const first = await fixture.store.bootstrap(command);
    expect(await fixture.store.bootstrap(command)).toEqual(first);
    await expect(fixture.store.get('session-bootstrap')).resolves.toMatchObject({
      modelBinding: { revision: 1, modelId: 'model-bootstrap' },
      skillConfiguration: {
        revision: 1,
        definitions: [{ content: '# Frozen default\nUse the creation-time default.' }],
      },
    });
    await expect(fixture.store.bootstrap({ ...command, definitions: [] }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect((await fixture.journal.readSessionEvents({
      projectId: 'project-a', sessionId: 'session-bootstrap', afterSequence: 0, limit: 10,
    })).events.map(({ type }) => type)).toEqual([
      'session.model_bound', 'session.skills_configured',
    ]);
  });

  it('keeps a delegated Session readable but rejects top-level and user Session mutations', async () => {
    const fixture = createFixture();
    const parent = await fixture.journal.createRun({
      projectId: 'project-a', sessionId: 'parent-session', clientRequestId: 'parent-request', input: 'root',
    });
    const database = new DatabaseSync(fixture.filePath);
    try {
      database.prepare(`
        INSERT INTO agent_sessions (
          project_id, session_id, session_kind, visibility, parent_run_id, parent_session_id,
          archive_revision, archived, title, created_at, updated_at, last_activity_sequence, run_count
        ) VALUES (?, ?, 'delegated', 'internal', ?, ?, 0, 0, NULL, ?, ?, 0, 0)
      `).run(
        'project-a', 'child-session', parent.runId, 'parent-session',
        '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z',
      );
    } finally {
      database.close();
    }

    await expect(fixture.store.get('child-session')).resolves.toMatchObject({
      kind: 'delegated', visibility: 'internal', parentRunId: parent.runId,
    });
    await expect(fixture.journal.createRun({
      projectId: 'project-a', sessionId: 'child-session', clientRequestId: 'top-level-reuse', input: 'forbidden',
    })).rejects.toMatchObject({ code: 'COMMAND_CONFLICT' });
    await expect(fixture.store.setArchived({
      sessionId: 'child-session', commandId: 'archive-child', expectedRevision: 0, archived: true,
    })).rejects.toMatchObject({ code: 'COMMAND_CONFLICT' });
    await expect(fixture.store.configureSkills({
      sessionId: 'child-session', commandId: 'skills-child', expectedRevision: 0, definitions: [],
    })).rejects.toMatchObject({ code: 'COMMAND_CONFLICT' });
    const model = await createTestModelSession({
      connectionId: 'connection-child', modelId: 'model-child',
    });
    await expect(new SessionModelBindingStore(fixture.journal).bind({
      projectId: 'project-a', sessionId: 'child-session', commandId: 'bind-child',
      expectedRevision: 0, session: model,
    })).rejects.toMatchObject({ code: 'COMMAND_CONFLICT' });
    await expect(fixture.store.bootstrap({
      sessionId: 'child-session', commandId: 'bootstrap-child',
      model: describeRuntimeBinding(model), definitions: [],
    })).rejects.toMatchObject({ code: 'COMMAND_CONFLICT' });
  });

  it('gets a new Session with two Runs and a credential-free model binding', async () => {
    const fixture = createFixture();
    await fixture.journal.createRun({
      projectId: 'project-a', sessionId: 'session-a', clientRequestId: 'request-a1', input: 'one',
    });
    fixture.advance();
    await fixture.journal.createRun({
      projectId: 'project-a', sessionId: 'session-a', clientRequestId: 'request-a2', input: 'two',
    });
    const session = await createTestModelSession({ connectionId: 'connection-a', modelId: 'model-a' });
    await new SessionModelBindingStore(fixture.journal).bind({
      projectId: 'project-a', sessionId: 'session-a', commandId: 'bind-a',
      expectedRevision: 0, session,
    });

    const view = await fixture.store.get('session-a');
    expect(view).toMatchObject({
      schemaVersion: 1, projectId: 'project-a', sessionId: 'session-a', runCount: 2,
      title: 'one',
      archived: false, archiveRevision: 0,
      modelBinding: {
        revision: 1, connectionId: 'connection-a', modelId: 'model-a',
        parameters: { temperature: 0, maxOutputTokens: 4_096 },
      },
      skillConfiguration: { revision: 0, definitions: [] },
    });
    expect(JSON.stringify(view)).not.toMatch(/apiKey|credential|bindingDigest|clientBinding/u);
    await expect(new JournalSessionStore(fixture.journal, 'project-b').get('session-a'))
      .resolves.toBeNull();
    await expect(fixture.store.get('missing')).resolves.toBeNull();
  });

  it('lists active, archived and all Sessions with stable keyset pagination', async () => {
    const fixture = createFixture();
    for (const sessionId of ['session-a', 'session-b', 'session-c']) {
      await fixture.journal.createRun({
        projectId: 'project-a', sessionId, clientRequestId: `request-${sessionId}`, input: sessionId,
      });
      fixture.advance();
    }
    await fixture.store.setArchived({
      sessionId: 'session-b', commandId: 'archive-b', expectedRevision: 0, archived: true,
    });

    const first = await fixture.store.list({ filter: 'all', limit: 2 });
    expect(first.nextCursor).toBeDefined();
    const second = await fixture.store.list({ filter: 'all', limit: 2, cursor: first.nextCursor! });
    expect(first.items.map(({ sessionId }) => sessionId)).toEqual(['session-b', 'session-c']);
    expect(first.hasMore).toBe(true);
    expect(second.items.map(({ sessionId }) => sessionId)).toEqual(['session-a']);
    expect(second.hasMore).toBe(false);
    await expect(fixture.store.list({ filter: 'active', limit: 10 })).resolves.toMatchObject({
      items: [expect.objectContaining({ sessionId: 'session-c' }), expect.objectContaining({ sessionId: 'session-a' })],
    });
    await expect(fixture.store.list({ filter: 'archived', limit: 10 })).resolves.toMatchObject({
      items: [expect.objectContaining({ sessionId: 'session-b' })],
    });
    await expect(new JournalSessionStore(fixture.journal, 'project-b').list({
      filter: 'all', limit: 10, cursor: first.nextCursor!,
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('archives and unarchives idempotently across restart with command and revision CAS', async () => {
    const fixture = createFixture();
    await fixture.journal.createRun({
      projectId: 'project-a', sessionId: 'session-a', clientRequestId: 'request-a', input: 'one',
    });
    const archive = {
      sessionId: 'session-a', commandId: 'archive-a', expectedRevision: 0, archived: true,
    } as const;
    const first = await fixture.store.setArchived(archive);
    expect(await fixture.store.setArchived(archive)).toEqual(first);
    await expect(fixture.store.setArchived({ ...archive, archived: false }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    const contenders = await Promise.allSettled([
      fixture.store.setArchived({
        sessionId: 'session-a', commandId: 'unarchive-a', expectedRevision: 1, archived: false,
      }),
      fixture.store.setArchived({
        sessionId: 'session-a', commandId: 'archive-again-a', expectedRevision: 1, archived: true,
      }),
    ]);
    expect(contenders.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(contenders.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    expect((contenders.find(({ status }) => status === 'rejected') as PromiseRejectedResult).reason)
      .toMatchObject({ code: 'REVISION_CONFLICT' });

    const reopened = new JournalSessionStore(
      new SqliteAgentJournal({ filePath: fixture.filePath }), 'project-a',
    );
    expect((await reopened.get('session-a'))?.archiveRevision).toBe(2);
    expect((await reopened.get('session-a'))?.archived).toBe(
      contenders[0]?.status === 'fulfilled' ? false : true,
    );
  });

  it('persists Session Skill configuration where explicit empty clears and omission can inherit', async () => {
    const fixture = createFixture();
    await fixture.journal.createRun({
      projectId: 'project-a', sessionId: 'session-a', clientRequestId: 'request-a', input: 'one',
    });
    const configured = await fixture.store.configureSkills({
      sessionId: 'session-a', commandId: 'skills-a', expectedRevision: 0,
      definitions: [
        { content: '# Project review\nReview the project before changing it.', sourcePath: '.agent/skills/review/SKILL.md' },
        { content: '# Database inspection\nInspect schema before planning.' },
      ],
    });
    expect(await fixture.store.skillConfiguration('session-a')).toEqual(configured);
    const inherited = await fixture.store.resolveSkillDefinitions('session-a', undefined);
    const cleared = await fixture.store.resolveSkillDefinitions('session-a', []);
    expect(inherited).toEqual(configured.definitions);
    expect(cleared).toEqual([]);
    const reopened = new JournalSessionStore(
      new SqliteAgentJournal({ filePath: fixture.filePath }), 'project-a',
    );
    expect((await reopened.get('session-a'))?.skillConfiguration).toEqual(configured);
    expect(await reopened.resolveSkillDefinitions('session-a', undefined)).toEqual(configured.definitions);
    expect(JSON.stringify(await fixture.store.activities('session-a'))).not.toMatch(
      /Project review|Database inspection|skills_configured/u,
    );
    await expect(fixture.store.configureSkills({
      sessionId: 'session-a', commandId: 'skills-a', expectedRevision: 0,
      definitions: [{ content: '# Changed command body' }],
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(fixture.store.configureSkills({
      sessionId: 'session-a', commandId: 'skills-too-large', expectedRevision: 1,
      definitions: [{ content: 'x'.repeat(256 * 1024 + 1) }],
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('rebuilds Session indexes, model binding, archive state and complete Skills from facts alone', async () => {
    const fixture = createFixture();
    await fixture.journal.createRun({
      projectId: 'project-a', sessionId: 'session-a', clientRequestId: 'request-a',
      input: { text: '  Review   the\norders pipeline  ', ignored: { privateConfig: 'never-title-this' } },
    });
    const session = await createTestModelSession({ connectionId: 'connection-a', modelId: 'model-a' });
    await new SessionModelBindingStore(fixture.journal).bind({
      projectId: 'project-a', sessionId: 'session-a', commandId: 'bind-a',
      expectedRevision: 0, session,
    });
    await fixture.store.configureSkills({
      sessionId: 'session-a', commandId: 'skills-a', expectedRevision: 0,
      definitions: [{ content: '# Durable Skill\nUse exact project conventions.', sourcePath: 'skills/durable.md' }],
    });
    await fixture.store.setArchived({
      sessionId: 'session-a', commandId: 'archive-a', expectedRevision: 0, archived: true,
    });
    const before = await fixture.store.get('session-a');
    expect(before?.title).toBe('Review the orders pipeline');

    await fixture.journal.rebuildProjectProjections('project-a');
    const after = await new JournalSessionStore(
      new SqliteAgentJournal({ filePath: fixture.filePath }), 'project-a',
    ).get('session-a');
    expect(after).toEqual(before);
  });

  it('backfills the Session query index when opening a pre-index Journal schema', async () => {
    const fixture = createFixture();
    await fixture.journal.createRun({
      projectId: 'project-a', sessionId: 'session-a', clientRequestId: 'request-a', input: 'Legacy journal title',
    });
    const database = new DatabaseSync(fixture.filePath);
    try {
      database.exec(`
        DROP TABLE agent_session_skill_configurations;
        DROP INDEX idx_agent_sessions_project_archive_activity;
        DROP INDEX idx_agent_sessions_project_activity;
        DROP TABLE agent_sessions;
      `);
    } finally {
      database.close();
    }

    const upgraded = new JournalSessionStore(
      new SqliteAgentJournal({ filePath: fixture.filePath }), 'project-a',
    );
    await expect(upgraded.get('session-a')).resolves.toMatchObject({
      sessionId: 'session-a', title: 'Legacy journal title', runCount: 1,
    });
  });

  it('migrates only provable delegated Session ancestry and keeps ambiguous legacy Sessions public', async () => {
    const fixture = createFixture();
    const parent = await fixture.journal.createRun({
      projectId: 'project-a', sessionId: 'parent-session', clientRequestId: 'parent-request', input: 'root',
    });
    const database = new DatabaseSync(fixture.filePath);
    try {
      database.exec(`
        CREATE TABLE agent_sessions_legacy (
          project_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          archive_revision INTEGER NOT NULL DEFAULT 0,
          archived INTEGER NOT NULL DEFAULT 0,
          title TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_activity_sequence INTEGER NOT NULL DEFAULT 0,
          run_count INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (project_id, session_id)
        );
        INSERT INTO agent_sessions_legacy
          SELECT project_id, session_id, archive_revision, archived, title,
                 created_at, updated_at, last_activity_sequence, run_count
          FROM agent_sessions;
        INSERT INTO agent_sessions_legacy VALUES
          ('project-a', 'delegated-session', 0, 0, NULL, '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z', 0, 1),
          ('project-a', 'ambiguous-session', 0, 0, NULL, '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z', 0, 1);
        DROP TABLE agent_sessions;
        ALTER TABLE agent_sessions_legacy RENAME TO agent_sessions;
        INSERT INTO agent_runs (
          run_id, project_id, session_id, client_request_id, state, revision, hidden,
          input_json, created_at, updated_at
        ) VALUES (
          'child-proven', 'project-a', 'delegated-session', 'child-request', 'created', 1, 0,
          'null', '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z'
        );
        INSERT INTO agent_run_ancestry (
          project_id, run_id, parent_run_id, root_run_id, depth, root_child_ordinal
        ) VALUES ('project-a', 'child-proven', '${parent.runId}', '${parent.runId}', 1, 1);
      `);
    } finally {
      database.close();
    }

    const reopenedJournal = new SqliteAgentJournal({ filePath: fixture.filePath });
    const reopened = new JournalSessionStore(reopenedJournal, 'project-a');
    expect((await reopened.list({ filter: 'all', limit: 10 })).items.map(({ sessionId }) => sessionId))
      .toEqual(expect.arrayContaining(['parent-session', 'ambiguous-session']));
    expect((await reopened.list({ filter: 'all', visibility: 'internal', limit: 10 })).items)
      .toEqual([expect.objectContaining({
        sessionId: 'delegated-session', kind: 'delegated', visibility: 'internal',
        parentRunId: parent.runId, parentSessionId: 'parent-session',
      })]);

    const twice = new JournalSessionStore(
      new SqliteAgentJournal({ filePath: fixture.filePath }), 'project-a',
    );
    expect(await twice.get('delegated-session')).toMatchObject({
      kind: 'delegated', visibility: 'internal', parentRunId: parent.runId,
    });
    expect(await twice.get('ambiguous-session')).toMatchObject({ kind: 'root', visibility: 'public' });
  });

  it('uses the Session index for 10000 Sessions instead of replaying Agent events N+1', async () => {
    const fixture = createFixture();
    await fixture.journal.countEvents();
    const database = new DatabaseSync(fixture.filePath);
    try {
      database.exec('BEGIN IMMEDIATE');
      const insert = database.prepare(`
        INSERT INTO agent_sessions (
          project_id, session_id, archive_revision, archived, title,
          created_at, updated_at, last_activity_sequence, run_count
        ) VALUES (?, ?, 0, 0, NULL, ?, ?, ?, 1)
      `);
      for (let index = 0; index < 10_000; index += 1) {
        const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
        insert.run('project-scale', `session-${String(index).padStart(5, '0')}`, timestamp, timestamp, index + 1);
      }
      database.exec('COMMIT');
      const plan = database.prepare(`
        EXPLAIN QUERY PLAN
        SELECT session_id FROM agent_sessions
        WHERE project_id = ? AND archived = ?
        ORDER BY updated_at DESC, last_activity_sequence DESC, session_id ASC LIMIT ?
      `).all('project-scale', 0, 21) as unknown as Array<{ detail: string }>;
      expect(plan.map(({ detail }) => detail).join('\n')).toMatch(
        /idx_agent_sessions_project_archive_activity/u,
      );
    } finally {
      database.close();
    }
    const startedAt = performance.now();
    const page = await new JournalSessionStore(
      new SqliteAgentJournal({ filePath: fixture.filePath }), 'project-scale',
    ).list({ filter: 'active', limit: 20 });
    expect(page.items).toHaveLength(20);
    expect(page.hasMore).toBe(true);
    expect(performance.now() - startedAt).toBeLessThan(500);
  });
});

function createFixture(): {
  filePath: string;
  journal: SqliteAgentJournal;
  store: JournalSessionStore;
  advance(): void;
} {
  const root = mkdtempSync(join(tmpdir(), 'journal-session-public-'));
  roots.push(root);
  const filePath = join(root, 'state.db');
  let clock = Date.parse('2026-09-03T00:00:00.000Z');
  const journal = new SqliteAgentJournal({
    filePath,
    now: () => new Date(clock).toISOString(),
  });
  return {
    filePath,
    journal,
    store: new JournalSessionStore(journal, 'project-a'),
    advance: () => { clock += 1_000; },
  };
}
