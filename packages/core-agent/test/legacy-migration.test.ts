import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentAuditLogStore,
  AgentCheckpointStore,
  AgentSessionStore,
  AgentStreamStore,
  JournalSessionStore,
  ProjectArtifactStore,
  SqliteAgentJournal,
  StateMigrationError,
  StateMigrationRunner,
  type AgentRunRecord,
  type AgentSession,
  type AgentSubagentRecord,
  type MigrationCrashPoint,
  type MigrationInspection,
} from '../src/index.js';
import { createLegacyMigrationWriter } from '../src/internal/legacy-migration-writer.js';

const temporaryDirectories: string[] = [];
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => NodeDatabaseSync;
};
const crashPoints: MigrationCrashPoint[] = [
  'after-shadow-validated',
  'after-intent-fsync',
  'after-source-renamed',
  'after-shadow-promoted',
];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('StateMigrationRunner', () => {
  it('migrates the complete contract emitted only by public production stores', async () => {
    const fixture = await createPublicLegacyProject();

    const migrated = await StateMigrationRunner.open(fixture.projectDir, {
      targetSchemaVersion: 2,
      migratorRevision: 'task-4-r3-public-contract',
    });
    const inspection = await migrated.inspect();
    expect(withTestDatabase(join(fixture.projectDir, 'state.db'), (database) => ({
      status: (database.prepare('SELECT status FROM schema_migrations').get() as { status: string }).status,
      sealed: Number((database.prepare(
        'SELECT sealed FROM legacy_migration_build_context WHERE id = 1',
      ).get() as { sealed: number }).sealed),
    }))).toEqual({ status: 'active', sealed: 1 });
    const journal = new SqliteAgentJournal({ filePath: join(fixture.projectDir, 'state.db') });
    const publicStore = new JournalSessionStore(journal, inspection.projectId);

    await expect(publicStore.load(fixture.session.id, { limit: 100 })).resolves.toMatchObject({
      title: fixture.session.title,
      userId: fixture.session.userId,
      mode: fixture.session.mode,
      legacySession: {
        session: fixture.session,
        archived: false,
        createdAt: '2026-08-08T01:00:00.000Z',
        updatedAt: '2026-08-08T01:00:06.000Z',
        lastMessageAt: '2026-08-08T01:00:04.000Z',
      },
      messages: fixture.session.messages.map((message) => expect.objectContaining(message)),
      runs: [expect.objectContaining({
        runId: fixture.run.runId,
        state: 'Completed',
        legacyRecord: fixture.run,
      })],
    });
    await expect(publicStore.preferences(fixture.session.id)).resolves.toEqual([
      fixture.preference,
    ]);
    await expect(publicStore.checkpoints(fixture.session.id)).resolves.toEqual([
      fixture.session.contextCheckpoint,
    ]);
    await expect(publicStore.subagents(fixture.session.id)).resolves.toEqual([
      fixture.subagent,
    ]);
    for (const [readPage, expected] of [
      [(options: { afterSequence: number; limit: number }) =>
        publicStore.preferences(fixture.session.id, options), fixture.preference],
      [(options: { afterSequence: number; limit: number }) =>
        publicStore.checkpoints(fixture.session.id, options), fixture.session.contextCheckpoint],
      [(options: { afterSequence: number; limit: number }) =>
        publicStore.subagents(fixture.session.id, options), fixture.subagent],
    ] as const) {
      const page = await readPage({ afterSequence: 0, limit: 1 });
      expect(page.items).toEqual([expected]);
      expect(page.nextSourceSequence).toBeGreaterThan(0);
      await expect(readPage({ afterSequence: page.nextSourceSequence, limit: 1 }))
        .resolves.toMatchObject({ items: [] });
      await expect(readPage({ afterSequence: -1, limit: 1 })).rejects.toMatchObject({
        code: 'LIMIT_INVALID',
      });
      await expect(readPage({ afterSequence: 0, limit: 0 })).rejects.toMatchObject({
        code: 'LIMIT_INVALID',
      });
    }
    const activities = await publicStore.activities(fixture.session.id, { limit: 100 });
    expect(activities.items).toEqual(expect.arrayContaining([
      ...fixture.session.messages.map((message) => expect.objectContaining({
        runId: fixture.run.runId,
        kind: 'result',
        phase: 'succeeded',
        summary: message.content,
        detail: {
          entityType: 'message', role: message.role, sourceRunId: fixture.run.runId,
        },
      })),
      expect.objectContaining({
        runId: fixture.run.runId,
        kind: 'final',
        phase: 'succeeded',
        summary: fixture.run.finalText,
        detail: { entityType: 'run', record: fixture.run },
      }),
    ]));
    expect((await migrated.readImportedLegacyState()).runs).toEqual([fixture.run]);
    expect((await migrated.listLegacyArchives()).length).toBeGreaterThanOrEqual(4);
  });

  it.each([
    ['duplicate ToolCall ids', [
      { role: 'assistant', content: 'duplicate', toolCalls: [
        { id: 'call-a', name: 'lookup', arguments: { id: 1 } },
        { id: 'call-a', name: 'lookup', arguments: { id: 2 } },
      ], createdAt: '2026-08-08T02:00:01.000Z' },
    ]],
    ['a mismatched Tool result name', [
      { role: 'assistant', content: 'lookup', toolCalls: [
        { id: 'call-a', name: 'lookup', arguments: { id: 1 } },
      ], createdAt: '2026-08-08T02:00:01.000Z' },
      {
        role: 'tool', toolCallId: 'call-a', toolName: 'update', content: 'wrong name',
        createdAt: '2026-08-08T02:00:02.000Z',
      },
    ]],
    ['out-of-order Tool results', [
      { role: 'assistant', content: 'two calls', toolCalls: [
        { id: 'call-a', name: 'lookup', arguments: { id: 1 } },
        { id: 'call-b', name: 'lookup', arguments: { id: 2 } },
      ], createdAt: '2026-08-08T02:00:01.000Z' },
      {
        role: 'tool', toolCallId: 'call-b', toolName: 'lookup', content: 'second first',
        createdAt: '2026-08-08T02:00:02.000Z',
      },
    ]],
    ['a duplicate Tool result', [
      { role: 'assistant', content: 'one call', toolCalls: [
        { id: 'call-a', name: 'lookup', arguments: { id: 1 } },
      ], createdAt: '2026-08-08T02:00:01.000Z' },
      {
        role: 'tool', toolCallId: 'call-a', toolName: 'lookup', content: 'first',
        createdAt: '2026-08-08T02:00:02.000Z',
      },
      {
        role: 'tool', toolCallId: 'call-a', toolName: 'lookup', content: 'duplicate',
        createdAt: '2026-08-08T02:00:03.000Z',
      },
    ]],
    ['a missing Tool result', [
      { role: 'assistant', content: 'pending', toolCalls: [
        { id: 'call-a', name: 'lookup', arguments: { id: 1 } },
      ], createdAt: '2026-08-08T02:00:01.000Z' },
    ]],
  ] satisfies Array<[string, AgentSession['messages']]>)('rejects %s from a public Session producer', async (
    _case,
    toolMessages,
  ) => {
    const projectDir = await mkdtemp(join(tmpdir(), 'dbagent-public-invalid-tool-causality-'));
    temporaryDirectories.push(projectDir);
    const sessionStore = new AgentSessionStore(join(projectDir, 'state.db'), {
      rootPath: projectDir, configDirectory: '.dbagent',
    });
    await sessionStore.save({
      now: '2026-08-08T02:00:04.000Z',
      session: {
        id: 'invalid-tool-session', title: 'Invalid Tool causality', mode: 'read',
        project: { rootPath: projectDir, configDirectory: '.dbagent' },
        messages: [
          { role: 'user', content: 'Start', createdAt: '2026-08-08T02:00:00.000Z' },
          ...toolMessages,
        ],
        tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        aborted: false,
      },
    });

    await expect(StateMigrationRunner.open(projectDir, {
      targetSchemaVersion: 2,
      migratorRevision: 'task-4-r3-tool-causality',
    })).rejects.toMatchObject({ code: 'MIGRATION_VALIDATION_FAILED' });
  });

  it('streams a multi-page migration once and renews the carrier lease for every batch', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'dbagent-public-scale-migration-'));
    temporaryDirectories.push(projectDir);
    const project = { rootPath: projectDir, configDirectory: '.dbagent' };
    const messages: AgentSession['messages'] = Array.from({ length: 1_205 }, (_, index) => ({
      role: 'user' as const,
      content: `scale-message-${index}`,
      createdAt: new Date(Date.UTC(2026, 7, 8, 4, 0, index)).toISOString(),
    }));
    await new AgentSessionStore(join(projectDir, 'state.db'), project).save({
      now: '2026-08-08T05:00:00.000Z',
      session: {
        id: 'scale-session', title: 'Scale migration', mode: 'read', project, messages,
        tokenUsage: { promptTokens: 1_205, completionTokens: 0, totalTokens: 1_205 },
        aborted: false,
      },
    });

    const migrated = await StateMigrationRunner.open(projectDir, {
      targetSchemaVersion: 2, migratorRevision: 'task-4-r3-scale',
    });
    expect((await migrated.readImportedLegacyState()).sessions[0]?.messages).toHaveLength(1_205);
    await expect(migrated.validationDiagnostics()).resolves.toEqual({
      projectPasses: 1,
      maxPageSize: 1_000,
      importBatches: 3,
      carrierLeaseRenewals: 3,
    });
  });

  it('keeps equal-byte archives independently addressable by source path', async () => {
    const projectDir = await createLegacyProject();
    await writeFile(join(projectDir, 'legacy-artifacts', 'output-copy.txt'), 'legacy artifact\n');
    const migrated = await StateMigrationRunner.open(projectDir, {
      targetSchemaVersion: 2, migratorRevision: 'task-4-r3-reference-identity',
    });

    const matching = (await migrated.listLegacyArchives()).filter(
      ({ relativePath }) => relativePath.startsWith('legacy-artifacts/output'),
    );
    expect(matching.map(({ relativePath }) => relativePath)).toEqual([
      'legacy-artifacts/output-copy.txt',
      'legacy-artifacts/output.txt',
    ]);
    expect(new Set(matching.map(({ archiveHandle }) => archiveHandle))).toHaveLength(2);
    await expect(Promise.all(matching.map((ref) =>
      migrated.readLegacyArchive(ref, { maxBytes: ref.byteSize }),
    )))
      .resolves.toEqual([
        new TextEncoder().encode('legacy artifact\n'),
        new TextEncoder().encode('legacy artifact\n'),
      ]);
  });

  it('streams the verified descriptor after pathname replacement and bounds convenience reads', async () => {
    const projectDir = await createLegacyProject();
    const migrated = await StateMigrationRunner.open(projectDir, {
      targetSchemaVersion: 2, migratorRevision: 'task-4-r3-archive-descriptor',
    });
    const ref = (await migrated.listLegacyArchives()).find(
      ({ relativePath }) => relativePath === 'legacy-artifacts/output.txt',
    )!;
    const objectRelativePath = withTestDatabase(join(projectDir, 'state.db'), (database) =>
      (database.prepare(`
        SELECT object_relative_path FROM legacy_archives
        WHERE migration_id = ? AND archive_handle = ? AND relative_path = ?
      `).get(
        (database.prepare('SELECT migration_id FROM schema_migrations').get() as {
          migration_id: string;
        }).migration_id,
        ref.archiveHandle,
        ref.relativePath,
      ) as { object_relative_path: string }).object_relative_path,
    );
    const objectPath = join(projectDir, ...objectRelativePath.split('/'));

    const stream = await migrated.openLegacyArchive(ref);
    await rename(objectPath, `${objectPath}.verified`);
    await writeFile(objectPath, 'replacement bytes\n');
    await expect(readChunks(stream)).resolves.toEqual(new TextEncoder().encode('legacy artifact\n'));
    await expect(migrated.openLegacyArchive(ref)).rejects.toMatchObject({
      code: 'MIGRATION_VALIDATION_FAILED',
    });
    await expect(migrated.readLegacyArchive(ref, { maxBytes: ref.byteSize - 1 }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('issues migration authority once per unsealed Shadow and rejects sealed or active state', async () => {
    const migrationId = 'a'.repeat(64);
    const sourceDigest = 'b'.repeat(64);
    const createShadow = async (name: string, options: { sealed?: boolean; active?: boolean } = {}) => {
      const projectDir = await mkdtemp(join(tmpdir(), `dbagent-${name}-`));
      temporaryDirectories.push(projectDir);
      const path = join(projectDir, 'shadow.db');
      const journal = new SqliteAgentJournal({ filePath: path });
      await journal.countEvents();
      withTestDatabase(path, (database) => {
        database.exec(`
          CREATE TABLE legacy_migration_build_context (
            id INTEGER PRIMARY KEY, migration_id TEXT NOT NULL, source_digest TEXT NOT NULL,
            sealed INTEGER NOT NULL, authority_issued INTEGER NOT NULL DEFAULT 0
          );
        `);
        database.prepare(`
          INSERT INTO legacy_migration_build_context
            (id, migration_id, source_digest, sealed, authority_issued)
          VALUES (1, ?, ?, ?, 0)
        `).run(migrationId, sourceDigest, options.sealed ? 1 : 0);
        if (options.active) {
          database.exec('CREATE TABLE schema_migrations (status TEXT NOT NULL)');
          database.prepare('INSERT INTO schema_migrations (status) VALUES (?)').run('active');
        }
      });
      return { path, journal };
    };

    const available = await createShadow('authority-once');
    const writer = createLegacyMigrationWriter(available.journal, { migrationId, sourceDigest });
    expect(() => createLegacyMigrationWriter(
      new SqliteAgentJournal({ filePath: available.path }),
      { migrationId, sourceDigest },
    )).toThrow('unavailable');
    writer.seal();
    await expect(writer.commit({} as never)).rejects.toThrow('sealed');

    const sealed = await createShadow('authority-sealed', { sealed: true });
    expect(() => createLegacyMigrationWriter(sealed.journal, { migrationId, sourceDigest }))
      .toThrow('unavailable');
    const active = await createShadow('authority-active', { active: true });
    expect(() => createLegacyMigrationWriter(active.journal, { migrationId, sourceDigest }))
      .toThrow('active Shadow');
  });

  it.each(crashPoints)('recovers a real on-disk cut at %s without duplicate import', async (cut) => {
    const projectDir = await createLegacyProject();
    await expect(
      StateMigrationRunner.open(projectDir, {
        targetSchemaVersion: 2,
        migratorRevision: 'task-4-r1',
        crashAt: cut,
      }),
    ).rejects.toMatchObject({ code: 'INJECTED_CRASH', crashPoint: cut });

    const first = await StateMigrationRunner.open(projectDir, {
      targetSchemaVersion: 2,
      migratorRevision: 'task-4-r1',
    });
    const firstState = await first.readImportedLegacyState();
    const reopened = await StateMigrationRunner.open(projectDir, {
      targetSchemaVersion: 2,
      migratorRevision: 'task-4-r1',
    });
    const secondState = await reopened.readImportedLegacyState();

    expect(await reopened.activeSchemaVersion()).toBe(2);
    expect(await reopened.countLegacyImports()).toBe(1);
    expect(secondState).toEqual(firstState);
    expect(secondState.sessions.map(({ id }) => id)).toEqual(['session-a', 'session-b']);
    expect(secondState.sessions[0]?.messages.map(({ role, content }) => ({ role, content })))
      .toEqual([
        { role: 'user', content: '请检查订单' },
        { role: 'assistant', content: 'Orders checked ✓' },
        { role: 'user', content: 'Продолжи анализ' },
      ]);
    expect(secondState.runs).toEqual([
      expect.objectContaining({ runId: 'legacy-run-complete', status: 'done' }),
      expect.objectContaining({ runId: 'legacy-run-running', status: 'interrupted' }),
    ]);
    expect(secondState.plan).toEqual({
      steps: [
        { id: 'inspect', status: 'completed' },
        { id: 'report', status: 'in_progress' },
      ],
    });
    expect(secondState.preferences).toEqual([
      expect.objectContaining({ key: 'language', value: '中文' }),
    ]);
    expect(secondState.checkpoints).toEqual([
      expect.objectContaining({ sessionId: 'session-a', summary: '已检查订单' }),
    ]);
    expect(secondState.subagents).toEqual([
      expect.objectContaining({ parentSessionId: 'session-a', childSessionId: 'session-b' }),
    ]);
    expect(secondState.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'LEGACY_APPROVAL_EXPIRED' }),
      expect.objectContaining({ code: 'LEGACY_RESULT_HANDLE_EXPIRED' }),
    ]));
    expect(JSON.stringify(secondState)).not.toContain('active_approval');
    expect(JSON.stringify(secondState)).not.toContain('resultAvailable":true');

    const inspection = await reopened.inspect();
    expect(inspection.intentStatus).toBe('completed');
    expect(inspection.sourceBackupPath).toMatch(/state\.legacy\.[a-f0-9]+\.db$/u);
    expect(await readFile(inspection.sourceBackupPath)).not.toHaveLength(0);

    const firstJournal = new SqliteAgentJournal({ filePath: join(projectDir, 'state.db') });
    expect(await firstJournal.countEvents(undefined, inspection.projectId)).toBeGreaterThan(0);
    await firstJournal.rebuildProjectProjections(inspection.projectId);
    const firstProjection = await new JournalSessionStore(firstJournal, inspection.projectId)
      .load('session-a', { limit: 100 });
    const secondJournal = new SqliteAgentJournal({ filePath: join(projectDir, 'state.db') });
    await secondJournal.rebuildProjectProjections(inspection.projectId);
    const secondProjection = await new JournalSessionStore(secondJournal, inspection.projectId)
      .load('session-a', { limit: 100 });
    expect(secondProjection).toEqual(firstProjection);
    expect(secondProjection.messages.map(({ role, content }) => ({ role, content }))).toEqual(
      secondState.sessions[0]?.messages.map(({ role, content }) => ({ role, content })),
    );

    const persistedIntent = await readFile(join(projectDir, 'state.migration.json'), 'utf8');
    expect(persistedIntent).not.toContain(projectDir);
    expect(persistedIntent).not.toContain('sourcePath');
    expect(withTestDatabase(join(projectDir, 'state.db'), (database) =>
      database.prepare(`PRAGMA table_info(legacy_imports)`).all() as unknown as Array<{ name: string }>,
    ).map(({ name }) => name)).not.toContain('imported_state_json');
    const archives = withTestDatabase(join(projectDir, 'state.db'), (database) =>
      database.prepare(`
        SELECT relative_path, object_relative_path, checksum, byte_size
        FROM legacy_archives ORDER BY relative_path
      `).all() as unknown as Array<{
        relative_path: string; object_relative_path: string; checksum: string; byte_size: number;
      }>,
    );
    expect(archives).toHaveLength(4);
    for (const archive of archives) {
      const bytes = await readFile(join(projectDir, archive.object_relative_path));
      expect(bytes).toHaveLength(archive.byte_size);
      expect((await stat(join(projectDir, archive.object_relative_path))).isFile()).toBe(true);
    }
  });

  it('uses a live cross-process owner gate that cannot be stolen and is released by SIGKILL', async () => {
    const projectDir = await createLegacyProject();
    const child = spawnMigrationWorker(projectDir, 'migrate', {
      DBAGENT_MIGRATION_BARRIER_POINT: 'after-shadow-validated',
    });
    await waitForPath(join(projectDir, 'migration-barrier-ready'));

    await expect(StateMigrationRunner.open(projectDir, {
      targetSchemaVersion: 2,
      migratorRevision: 'task-4-r2',
    })).rejects.toMatchObject({
      code: 'MIGRATION_LOCKED',
    });
    expect(child.exitCode).toBeNull();

    child.kill('SIGKILL');
    await waitForExit(child);
    await expect(StateMigrationRunner.open(projectDir, {
      targetSchemaVersion: 2,
      migratorRevision: 'task-4-r2',
    })).resolves.toBeInstanceOf(StateMigrationRunner);
  }, 20_000);

  it('holds an exclusive writer gate across the final live recheck and promotion', async () => {
    const projectDir = await createLegacyWriterProject();
    const migration = spawnMigrationWorker(projectDir, 'migrate', {
      DBAGENT_MIGRATION_BARRIER_POINT: 'after-live-recheck',
    });
    await waitForPath(join(projectDir, 'migration-barrier-ready'));

    const writer = spawnMigrationWorker(projectDir, 'write');
    await waitForPath(join(projectDir, 'legacy-writer-started'));
    await delay(250);
    expect(writer.exitCode).toBeNull();
    await expect(stat(join(projectDir, 'legacy-writer-completed'))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    await writeFile(join(projectDir, 'migration-barrier-release'), 'release');
    await expect(waitForExit(migration)).resolves.toBe(0);
    await expect(waitForExit(writer)).resolves.not.toBe(0);
    const migrated = await StateMigrationRunner.open(projectDir, {
      targetSchemaVersion: 2,
      migratorRevision: 'task-4-r2',
    });
    expect((await migrated.readImportedLegacyState()).sessions[0]?.title)
      .not.toBe('writer-won-the-race');
  }, 20_000);

  it('rechecks the live source after the final-cut barrier and rebuilds from the preserved source', async () => {
    const projectDir = await createLegacyWriterProject();
    const migration = spawnMigrationWorker(projectDir, 'migrate', {
      DBAGENT_MIGRATION_BARRIER_POINT: 'after-live-recheck',
    });
    await waitForPath(join(projectDir, 'migration-barrier-ready'));
    withTestDatabase(join(projectDir, 'state.db'), (database) => {
      const row = database.prepare('SELECT payload_json FROM agent_sessions WHERE id = ?')
        .get('session-a') as { payload_json: string };
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      payload.title = 'changed-at-final-cut';
      database.prepare('UPDATE agent_sessions SET title = ?, payload_json = ? WHERE id = ?')
        .run('changed-at-final-cut', JSON.stringify(payload), 'session-a');
      database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    });
    await writeFile(join(projectDir, 'migration-barrier-release'), 'release');
    expect(await waitForExit(migration)).not.toBe(0);

    const recovered = await StateMigrationRunner.open(projectDir, {
      targetSchemaVersion: 2, migratorRevision: 'task-4-r2',
    });
    expect((await recovered.readImportedLegacyState()).sessions[0]?.title)
      .toBe('changed-at-final-cut');
  }, 20_000);

  it('rolls back a tampered promoted file before active and remigrates the preserved source', async () => {
    const projectDir = await createLegacyProject();
    const migration = spawnMigrationWorker(projectDir, 'migrate', {
      DBAGENT_MIGRATION_BARRIER_POINT: 'after-promote-before-active',
    });
    await waitForPath(join(projectDir, 'migration-barrier-ready'));
    withTestDatabase(join(projectDir, 'state.db'), (database) => {
      const row = database.prepare(`
        SELECT project_id, sequence, payload_json FROM agent_events
        WHERE event_type = 'legacy.imported' ORDER BY project_id, sequence LIMIT 1
      `).get() as { project_id: string; sequence: number; payload_json: string };
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      payload.legacyId = 'tampered-after-promotion';
      database.prepare(`
        UPDATE agent_events SET payload_json = ? WHERE project_id = ? AND sequence = ?
      `).run(JSON.stringify(payload), row.project_id, row.sequence);
      database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    });
    await writeFile(join(projectDir, 'migration-barrier-release'), 'release');
    expect(await waitForExit(migration)).not.toBe(0);
    const recovered = await StateMigrationRunner.open(projectDir, {
      targetSchemaVersion: 2, migratorRevision: 'task-4-r2',
    });
    expect(await recovered.activeSchemaVersion()).toBe(2);
    expect((await recovered.readImportedLegacyState()).sessions.map(({ id }) => id))
      .toEqual(['session-a', 'session-b']);
  }, 20_000);

  it('releases the exclusive activation writer gate when the migration process is killed', async () => {
    const projectDir = await createLegacyWriterProject();
    const migration = spawnMigrationWorker(projectDir, 'migrate', {
      DBAGENT_MIGRATION_BARRIER_POINT: 'after-live-recheck',
    });
    await waitForPath(join(projectDir, 'migration-barrier-ready'));
    const writer = spawnMigrationWorker(projectDir, 'write');
    await waitForPath(join(projectDir, 'legacy-writer-started'));
    await delay(250);
    expect(writer.exitCode).toBeNull();

    migration.kill('SIGKILL');
    await waitForExit(migration);
    const writerExit = await waitForExit(writer);
    if (writerExit !== 0) {
      throw new Error(await readFile(join(projectDir, 'write-worker-error'), 'utf8'));
    }
    expect(await readFile(join(projectDir, 'legacy-writer-completed'), 'utf8')).toBe('completed');
  }, 20_000);

  it.each(['audit', 'checkpoint', 'stream', 'artifact'] as const)(
    'blocks the %s manifest producer at the final cut and rejects it after activation',
    async (mode) => {
      const projectDir = await createLegacyProject();
      const migration = spawnMigrationWorker(projectDir, 'migrate', {
        DBAGENT_MIGRATION_BARRIER_POINT: 'after-live-recheck',
      });
      await waitForPath(join(projectDir, 'migration-barrier-ready'));
      const writer = spawnMigrationWorker(projectDir, mode);
      await waitForPath(join(projectDir, `${mode}-writer-started`));
      await delay(250);
      expect(writer.exitCode).toBeNull();
      await expect(stat(join(projectDir, `${mode}-writer-completed`))).rejects.toMatchObject({
        code: 'ENOENT',
      });

      await writeFile(join(projectDir, 'migration-barrier-release'), 'release');
      expect(await waitForExit(migration)).toBe(0);
      expect(await waitForExit(writer)).not.toBe(0);
      expect(await readFile(join(projectDir, `${mode}-worker-error`), 'utf8'))
        .toContain('STATE_MIGRATION_ACTIVE');
    },
    20_000,
  );

  it.each(['audit', 'checkpoint', 'stream', 'artifact'] as const)(
    'releases the %s manifest-producer gate after migration SIGKILL',
    async (mode) => {
      const projectDir = await createLegacyProject();
      const migration = spawnMigrationWorker(projectDir, 'migrate', {
        DBAGENT_MIGRATION_BARRIER_POINT: 'after-live-recheck',
      });
      await waitForPath(join(projectDir, 'migration-barrier-ready'));
      const writer = spawnMigrationWorker(projectDir, mode);
      await waitForPath(join(projectDir, `${mode}-writer-started`));
      await delay(250);
      expect(writer.exitCode).toBeNull();

      migration.kill('SIGKILL');
      await waitForExit(migration);
      const writerExit = await waitForExit(writer);
      if (writerExit !== 0) {
        throw new Error(await readFile(join(projectDir, `${mode}-worker-error`), 'utf8'));
      }
      expect(await readFile(join(projectDir, `${mode}-writer-completed`), 'utf8')).toBe('completed');
    },
    20_000,
  );

  it.each(crashPoints)('recovers after an uncatchable child termination at %s', async (cut) => {
    const projectDir = await createLegacyProject();
    const viteNode = join(
      process.cwd(), 'node_modules', '.pnpm', 'vite-node@2.1.9_@types+node@22.19.20',
      'node_modules', 'vite-node', 'vite-node.mjs',
    );
    const helper = join(process.cwd(), 'packages', 'core-agent', 'test', 'fixtures',
      'migration-hard-crash.ts');
    const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
      const child = spawn(process.execPath, [viteNode, helper], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DBAGENT_MIGRATION_CHILD_PROJECT: projectDir,
          DBAGENT_MIGRATION_HARD_CRASH: cut,
        },
        stdio: 'ignore',
      });
      child.once('error', rejectExit);
      child.once('exit', resolveExit);
    });
    expect(exitCode).not.toBe(0);
    const recovered = await StateMigrationRunner.open(projectDir, {
      targetSchemaVersion: 2, migratorRevision: 'task-4-r1',
    });
    expect(await recovered.countLegacyImports()).toBe(1);
    expect((await recovered.inspect()).intentStatus).toBe('completed');
  });

  it('rejects generic producer forgery of a reserved legacy fact', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dbagent-forged-legacy-fact-'));
    temporaryDirectories.push(directory);
    const journal = new SqliteAgentJournal({ filePath: join(directory, 'state.db') });
    const created = await journal.createRun({
      projectId: 'project-a', sessionId: 'session-a', clientRequestId: 'forged', input: 'x',
    });
    const lease = await journal.acquireRunLease({
      projectId: 'project-a', runId: created.runId, ownerId: 'forger', ttlMs: 60_000,
    });
    await expect(journal.commit({
      projectId: 'project-a', sessionId: 'session-a', runId: created.runId,
      commandId: 'forged-legacy-import',
      lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken },
      expectedRunRevision: 1,
      events: [{
        type: 'legacy.imported',
        payload: {
          entityType: 'session', legacyId: 'session-a', projectKey: 'a', projectRoot: 'a',
          record: {
            session: {
              id: 'session-a', title: 'forged', mode: 'full', messages: [],
              tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, aborted: false,
            },
            archived: false,
            createdAt: '2026-08-08T00:00:00.000Z',
            updatedAt: '2026-08-08T00:00:00.000Z',
            lastMessageAt: null,
          },
        },
      }],
    })).rejects.toMatchObject({ code: 'COMMITTER_REQUIRED' });
    expect('commitLegacyImport' in journal).toBe(false);
  });

  it('revalidates Journal facts and archived bytes after the validated-shadow cut', async () => {
    const journalTamperDir = await createLegacyProject();
    const journalCut = await captureCrashInspection(journalTamperDir);
    withTestDatabase(journalCut.shadowPath, (database) => {
      const row = database.prepare(`
        SELECT project_id, sequence, payload_json FROM agent_events
        WHERE event_type = 'legacy.imported' ORDER BY project_id, sequence LIMIT 1
      `).get() as { project_id: string; sequence: number; payload_json: string };
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      payload.title = 'tampered-after-validation';
      database.prepare(`
        UPDATE agent_events SET payload_json = ? WHERE project_id = ? AND sequence = ?
      `).run(JSON.stringify(payload), row.project_id, row.sequence);
    });
    await expect(StateMigrationRunner.open(journalTamperDir, {
      targetSchemaVersion: 2, migratorRevision: 'task-4-r1',
    })).rejects.toMatchObject({ code: 'MIGRATION_VALIDATION_FAILED' });

    const archiveTamperDir = await createLegacyProject();
    const archiveCut = await captureCrashInspection(archiveTamperDir);
    const archive = withTestDatabase(archiveCut.shadowPath, (database) =>
      database.prepare(`
        SELECT object_relative_path, byte_size FROM legacy_archives ORDER BY relative_path LIMIT 1
      `).get() as { object_relative_path: string; byte_size: number },
    );
    await writeFile(
      join(archiveTamperDir, archive.object_relative_path),
      new Uint8Array(archive.byte_size).fill(0x78),
    );
    await expect(StateMigrationRunner.open(archiveTamperDir, {
      targetSchemaVersion: 2, migratorRevision: 'task-4-r1',
    })).rejects.toMatchObject({ code: 'MIGRATION_VALIDATION_FAILED' });
  });

  it('exposes every exact legacy fact through normal public projections and verified archives', async () => {
    const projectDir = await createLegacyProject();
    withTestDatabase(join(projectDir, 'state.db'), (database) => {
      const insert = database.prepare(`
        INSERT INTO agent_session_messages (
          session_id, message_index, role, content, created_at,
          tool_call_id, tool_name, tool_calls_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insert.run('session-b', 1, 'system', 'system exact', '2026-08-08T00:03:01.000Z',
        null, null, null);
      insert.run('session-b', 2, 'assistant', 'calling tool', '2026-08-08T00:03:02.000Z',
        null, null, JSON.stringify([{ id: 'call-1', name: 'lookup', arguments: { id: 7 } }]));
      insert.run('session-b', 3, 'tool', 'tool exact', '2026-08-08T00:03:03.000Z',
        'call-1', 'lookup', null);
    });

    const migrated = await StateMigrationRunner.open(projectDir);
    const inspection = await migrated.inspect();
    const journal = new SqliteAgentJournal({ filePath: join(projectDir, 'state.db') });
    const store = new JournalSessionStore(journal, inspection.projectId);
    const child = await store.load('session-b', { limit: 100 });
    expect(child.messages.map(({ role, content, ...message }) => ({ role, content, ...message })))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'system', content: 'system exact' }),
        expect.objectContaining({
          role: 'assistant', content: 'calling tool',
          toolCalls: [{ id: 'call-1', name: 'lookup', arguments: { id: 7 } }],
        }),
        expect.objectContaining({
          role: 'tool', content: 'tool exact', toolCallId: 'call-1', toolName: 'lookup',
        }),
      ]));
    expect(child.runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: 'legacy-run-running', state: 'Interrupted' }),
    ]));
    expect(await store.preferences('session-a')).toEqual([
      expect.objectContaining({ id: 'preference-language', key: 'language' }),
    ]);
    expect(await store.checkpoints('session-a')).toEqual([
      expect.objectContaining({ sequence: 7 }),
    ]);
    expect(await store.subagents('session-a')).toEqual([
      expect.objectContaining({ id: 'subagent-a', childSessionId: 'session-b' }),
    ]);

    const carriers = withTestDatabase(join(projectDir, 'state.db'), (database) =>
      database.prepare(`
        SELECT state, hidden FROM agent_runs WHERE client_request_id LIKE 'legacy-import:%'
      `).all() as unknown as Array<{ state: string; hidden: number }>,
    );
    expect(carriers.length).toBeGreaterThan(0);
    expect(carriers.every(({ state, hidden }) =>
      ['Completed', 'Failed', 'Cancelled'].includes(state) && hidden === 1)).toBe(true);
    expect(child.runs.every(({ runId }) => !runId.startsWith('run_'))).toBe(true);
    expect(withTestDatabase(join(projectDir, 'state.db'), (database) =>
      database.prepare('SELECT sealed FROM legacy_migration_build_context WHERE id = 1')
        .get() as { sealed: number },
    ).sealed).toBe(1);

    const archives = await migrated.listLegacyArchives();
    expect(archives).toHaveLength(4);
    const firstBytes = await migrated.readLegacyArchive(archives[0]!, {
      maxBytes: archives[0]!.byteSize,
    });
    const reopened = await StateMigrationRunner.open(projectDir);
    await expect(reopened.readLegacyArchive(archives[0]!, {
      maxBytes: archives[0]!.byteSize,
    })).resolves.toEqual(firstBytes);
  });

  it('rechecks the live semantic source immediately before activation', async () => {
    const projectDir = await createLegacyProject();
    await StateMigrationRunner.open(projectDir, {
      targetSchemaVersion: 2, migratorRevision: 'task-4-r1', crashAt: 'after-intent-fsync',
    }).catch(() => undefined);
    withTestDatabase(join(projectDir, 'state.db'), (database) => {
      database.prepare('UPDATE agent_sessions SET title = ? WHERE id = ?')
        .run('changed-after-validation', 'session-a');
    });
    await expect(StateMigrationRunner.open(projectDir, {
      targetSchemaVersion: 2, migratorRevision: 'task-4-r1',
    })).rejects.toMatchObject({ code: 'MIGRATION_STATE_CONFLICT' });
  });

  it('rejects path-bearing or non-strict migration intents', async () => {
    const projectDir = await createLegacyProject();
    await StateMigrationRunner.open(projectDir, {
      targetSchemaVersion: 2, migratorRevision: 'task-4-r1', crashAt: 'after-intent-fsync',
    }).catch(() => undefined);
    const intentPath = join(projectDir, 'state.migration.json');
    const intent = JSON.parse(await readFile(intentPath, 'utf8')) as Record<string, unknown>;
    intent.sourcePath = '..\\forged.db';
    await writeFile(intentPath, JSON.stringify(intent));
    await expect(StateMigrationRunner.open(projectDir)).rejects.toMatchObject({
      code: 'MIGRATION_STATE_CONFLICT',
    });
    delete intent.sourcePath;
    intent.migrationId = '..\\not-a-digest';
    await writeFile(intentPath, JSON.stringify(intent));
    await expect(StateMigrationRunner.open(projectDir)).rejects.toMatchObject({
      code: 'MIGRATION_STATE_CONFLICT',
    });
  });

  it('preserves legacy Project isolation from projectKey and projectRoot', async () => {
    const projectDir = await createLegacyProject();
    withTestDatabase(join(projectDir, 'state.db'), (database) => {
      database.prepare('UPDATE agent_sessions SET payload_json = ? WHERE id = ?')
        .run(JSON.stringify({ projectKey: 'orders', projectRoot: 'C:/projects/orders' }), 'session-a');
      database.prepare('UPDATE agent_sessions SET payload_json = ? WHERE id = ?')
        .run(JSON.stringify({ projectKey: 'child', projectRoot: 'C:/projects/child' }), 'session-b');
    });
    const migrated = await StateMigrationRunner.open(projectDir);
    const inspection = await migrated.inspect();
    expect(inspection.projectIds).toHaveLength(2);
    const journal = new SqliteAgentJournal({ filePath: join(projectDir, 'state.db') });
    const sessionSets = await Promise.all(inspection.projectIds.map(async (projectId) =>
      new Set((await journal.readProject(projectId, 0, 1_000)).map(({ sessionId }) => sessionId)),
    ));
    expect(sessionSets.every((sessions) => sessions.size === 1)).toBe(true);
    expect(new Set(sessionSets.flatMap((sessions) => [...sessions]))).toEqual(
      new Set(['session-a', 'session-b']),
    );
  });

  it('derives a deterministic id from a stable sorted immutable source manifest', async () => {
    const leftDir = await createLegacyProject();
    const rightDir = await createLegacyProject();
    const left = await captureCrashInspection(leftDir);
    const right = await captureCrashInspection(rightDir);
    expect(left.sourceDigest).toBe(right.sourceDigest);
    expect(left.migrationId).toBe(right.migrationId);
    expect(left.manifest.map(({ relativePath }) => relativePath)).toEqual([
      'legacy-artifacts/output.txt',
      'legacy-audit.jsonl',
      'legacy-checkpoints/session-a.json',
      'legacy-streams/session-a.json',
      'state.source.db',
    ]);
  });

  it('reconstructs a missing intent only from a validated shadow and preserves the source backup', async () => {
    const projectDir = await createLegacyProject();
    await StateMigrationRunner.open(projectDir, {
      targetSchemaVersion: 2, migratorRevision: 'task-4-r1', crashAt: 'after-shadow-validated',
    }).catch(() => undefined);
    await expect(readFile(join(projectDir, 'state.migration.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const recovered = await StateMigrationRunner.open(projectDir, {
      targetSchemaVersion: 2, migratorRevision: 'task-4-r1',
    });
    const inspection = await recovered.inspect();
    expect(inspection.intentStatus).toBe('completed');
    expect(await readFile(inspection.sourceBackupPath)).not.toHaveLength(0);
    expect(await recovered.countLegacyImports()).toBe(1);
  });

  it('stops on competing shadows, digest conflict and corrupt legacy SQLite', async () => {
    const projectDir = await createLegacyProject();
    let cutInspection: Awaited<ReturnType<StateMigrationRunner['inspect']>> | undefined;
    await StateMigrationRunner.open(projectDir, {
      targetSchemaVersion: 2, migratorRevision: 'task-4-r1', crashAt: 'after-shadow-validated',
    }).catch((error: unknown) => {
      if (error instanceof StateMigrationError) cutInspection = error.inspection;
    });
    if (!cutInspection) throw new Error('Missing crash inspection.');
    await copyFile(
      cutInspection.shadowPath,
      join(projectDir, `state.v2.${cutInspection.migrationId}.duplicate.db.tmp`),
    );
    await expect(StateMigrationRunner.open(projectDir, {
      targetSchemaVersion: 2, migratorRevision: 'task-4-r1',
    })).rejects.toMatchObject({ code: 'MIGRATION_STATE_CONFLICT' });

    const corruptDir = await mkdtemp(join(tmpdir(), 'dbagent-legacy-corrupt-'));
    temporaryDirectories.push(corruptDir);
    await writeFile(join(corruptDir, 'state.db'), 'not a sqlite database');
    await expect(StateMigrationRunner.open(corruptDir, {
      targetSchemaVersion: 2, migratorRevision: 'task-4-r1',
    })).rejects.toMatchObject({ code: 'MIGRATION_SOURCE_CORRUPT' });
  });
});

async function captureCrashInspection(projectDir: string): Promise<MigrationInspection> {
  try {
    await StateMigrationRunner.open(projectDir, {
      targetSchemaVersion: 2,
      migratorRevision: 'task-4-r1',
      crashAt: 'after-shadow-validated',
    });
  } catch (error: unknown) {
    if (error instanceof StateMigrationError && error.inspection) return error.inspection;
    throw error;
  }
  throw new Error('Expected migration crash was not injected.');
}

async function createLegacyProject(): Promise<string> {
  const projectDir = await mkdtemp(join(tmpdir(), 'dbagent-legacy-project-'));
  temporaryDirectories.push(projectDir);
  await Promise.all([
    mkdir(join(projectDir, 'legacy-streams'), { recursive: true }),
    mkdir(join(projectDir, 'legacy-checkpoints'), { recursive: true }),
    mkdir(join(projectDir, 'legacy-artifacts'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(projectDir, 'legacy-streams', 'session-a.json'), '{"delta":"partial"}\n'),
    writeFile(join(projectDir, 'legacy-checkpoints', 'session-a.json'), '{"sequence":7}\n'),
    writeFile(join(projectDir, 'legacy-audit.jsonl'), '{"kind":"tool","ok":true}\n'),
    writeFile(join(projectDir, 'legacy-artifacts', 'output.txt'), 'legacy artifact\n'),
  ]);

  const database = new DatabaseSync(join(projectDir, 'state.db'));
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE agent_sessions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, user_id TEXT, mode TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE agent_session_messages (
      session_id TEXT NOT NULL, message_index INTEGER NOT NULL, role TEXT NOT NULL,
      content TEXT NOT NULL, created_at TEXT NOT NULL,
      tool_call_id TEXT, tool_name TEXT, tool_calls_json TEXT,
      PRIMARY KEY(session_id, message_index)
    );
    CREATE TABLE agent_runs (
      run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL,
      plan_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE agent_user_preferences (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, preference_key TEXT NOT NULL,
      value TEXT NOT NULL, confidence REAL NOT NULL, source_session_id TEXT,
      evidence TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE agent_context_checkpoints (
      session_id TEXT NOT NULL, sequence INTEGER NOT NULL, version INTEGER NOT NULL,
      trigger TEXT NOT NULL, method TEXT NOT NULL, summary TEXT NOT NULL,
      covered_message_count INTEGER NOT NULL, source_token_estimate INTEGER NOT NULL,
      summary_token_estimate INTEGER NOT NULL, model_context_tokens INTEGER,
      focus TEXT, created_at TEXT NOT NULL,
      PRIMARY KEY(session_id, sequence)
    );
    CREATE TABLE agent_subagents (
      id TEXT PRIMARY KEY, parent_session_id TEXT NOT NULL, child_session_id TEXT,
      task TEXT NOT NULL, context_strategy TEXT NOT NULL, status TEXT NOT NULL,
      depth INTEGER NOT NULL, summary TEXT, artifact_references_json TEXT NOT NULL,
      error_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE legacy_runtime_diagnostics (
      kind TEXT NOT NULL, durable_evidence TEXT NOT NULL
    );
  `);
  const insertSession = database.prepare(
    'INSERT INTO agent_sessions (id, title, user_id, mode, payload_json) VALUES (?, ?, ?, ?, ?)',
  );
  insertSession.run('session-a', '订单检查', 'user-a', 'general', '{"aborted":false}');
  insertSession.run('session-b', 'child', 'user-a', 'general', '{"aborted":false}');
  const insertMessage = database.prepare(`
    INSERT INTO agent_session_messages
      (session_id, message_index, role, content, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  insertMessage.run('session-a', 0, 'user', '请检查订单', '2026-08-08T00:00:00.000Z');
  insertMessage.run('session-a', 1, 'assistant', 'Orders checked ✓', '2026-08-08T00:01:00.000Z');
  insertMessage.run('session-a', 2, 'user', 'Продолжи анализ', '2026-08-08T00:02:00.000Z');
  insertMessage.run('session-b', 0, 'user', 'child task', '2026-08-08T00:03:00.000Z');
  const plan = JSON.stringify({ steps: [
    { id: 'inspect', status: 'completed' },
    { id: 'report', status: 'in_progress' },
  ] });
  const insertRun = database.prepare(`
    INSERT INTO agent_runs (run_id, session_id, status, plan_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertRun.run(
    'legacy-run-complete', 'session-a', 'completed', plan,
    '2026-08-08T00:00:00.000Z', '2026-08-08T00:04:00.000Z',
  );
  insertRun.run(
    'legacy-run-running', 'session-b', 'running', null,
    '2026-08-08T00:03:00.000Z', '2026-08-08T00:04:00.000Z',
  );
  database.prepare(`
    INSERT INTO agent_user_preferences
      (id, user_id, preference_key, value, confidence, source_session_id, evidence,
       created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'preference-language', 'user-a', 'language', '中文', 1, 'session-a', '以后请用中文',
    '2026-08-08T00:02:00.000Z', '2026-08-08T00:02:00.000Z',
  );
  database.prepare(`
    INSERT INTO agent_context_checkpoints
      (session_id, sequence, version, trigger, method, summary, covered_message_count,
       source_token_estimate, summary_token_estimate, model_context_tokens, focus, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'session-a', 7, 1, 'automatic', 'model', '已检查订单', 2, 200, 30, 16_384,
    '订单', '2026-08-08T00:02:30.000Z',
  );
  database.prepare(`
    INSERT INTO agent_subagents
      (id, parent_session_id, child_session_id, task, context_strategy, status, depth,
       summary, artifact_references_json, error_message, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'subagent-a', 'session-a', 'session-b', 'inspect child', 'checkpoint-plus-recent',
    'completed', 1, 'done', '[]', null,
    '2026-08-08T00:03:00.000Z', '2026-08-08T00:04:00.000Z',
  );
  database.prepare(
    'INSERT INTO legacy_runtime_diagnostics (kind, durable_evidence) VALUES (?, ?)',
  ).run('approval', 'legacy approval row existed');
  database.prepare(
    'INSERT INTO legacy_runtime_diagnostics (kind, durable_evidence) VALUES (?, ?)',
  ).run('result-handle', 'legacy result id existed');
  database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  database.close();
  return projectDir;
}

async function createPublicLegacyProject(): Promise<{
  projectDir: string;
  session: AgentSession;
  run: AgentRunRecord;
  preference: {
    id: string; userId: string; key: string; value: string; confidence: number;
    sourceSessionId?: string; evidence?: string; createdAt: string; updatedAt: string;
  };
  subagent: AgentSubagentRecord;
}> {
  const projectDir = await mkdtemp(join(tmpdir(), 'dbagent-public-legacy-project-'));
  temporaryDirectories.push(projectDir);
  const project = { rootPath: projectDir, configDirectory: '.dbagent' };
  const session: AgentSession = {
    id: 'public-session-a',
    title: 'Production legacy contract',
    userId: 'public-user-a',
    mode: 'edit',
    project,
    messages: [
      { role: 'system', content: 'Use exact production state.', createdAt: '2026-08-08T01:00:00.000Z' },
      { role: 'user', content: 'Inspect production facts.', createdAt: '2026-08-08T01:00:01.000Z' },
      {
        role: 'assistant',
        content: 'Calling lookup.',
        toolCalls: [{ id: 'public-call-1', name: 'lookup', arguments: { orderId: 7 } }],
        createdAt: '2026-08-08T01:00:02.000Z',
      },
      {
        role: 'tool', toolCallId: 'public-call-1', toolName: 'lookup',
        content: '{"status":"paid"}', createdAt: '2026-08-08T01:00:03.000Z',
      },
      { role: 'assistant', content: 'Order is paid.', createdAt: '2026-08-08T01:00:04.000Z' },
    ],
    tokenUsage: { promptTokens: 123, completionTokens: 45, totalTokens: 168 },
    modelBinding: {
      connectionId: 'connection-public', modelId: 'model-public', routeRevision: 'route-v7',
      parameters: { temperature: 0.2, maxOutputTokens: 512, seed: 42 },
    },
    taskPlan: {
      version: 1,
      goal: 'Inspect the exact legacy contract',
      tasks: [{
        id: 'task-public', title: 'Inspect', description: 'Read and verify production state',
        status: 'completed', acceptanceCriteria: ['All facts preserved'], dependsOn: [],
        evidence: [{
          kind: 'query', summary: 'Order 7 is paid', reference: 'query:7',
          createdAt: '2026-08-08T01:00:04.000Z',
        }],
        createdAt: '2026-08-08T01:00:00.000Z', updatedAt: '2026-08-08T01:00:04.000Z',
      }],
      createdAt: '2026-08-08T01:00:00.000Z', updatedAt: '2026-08-08T01:00:04.000Z',
    },
    artifacts: [{
      id: 'legacy-session-artifact', path: 'legacy-artifacts/output.txt',
      mediaType: 'text/plain', sizeBytes: 18, createdAt: '2026-08-08T01:00:04.000Z',
      source: 'lookup',
    }],
    toolActivations: [{
      toolName: 'lookup', toolRevision: 7, checkpointSequence: 9,
      taskPhase: 'verification', activatedAt: '2026-08-08T01:00:01.000Z',
    }],
    activeSkills: [{ name: 'query-and-answer', scope: 'project' }],
    subagentDepth: 2,
    capabilityStates: [{
      capabilityId: 'database', moduleId: 'postgres', instanceId: 'orders',
      stateId: 'state-7', version: '7',
    }],
    contextCheckpoint: {
      version: 1, sequence: 9, trigger: 'manual', method: 'model',
      summary: 'Order state retained', coveredConversationMessageCount: 4,
      sourceTokenEstimate: 900, summaryTokenEstimate: 90, modelContextTokens: 16_384,
      focus: 'order 7', createdAt: '2026-08-08T01:00:05.000Z',
    },
    aborted: false,
  };
  const sessionStore = new AgentSessionStore(join(projectDir, 'state.db'), project);
  await sessionStore.save({ session, now: '2026-08-08T01:00:06.000Z' });
  await sessionStore.save({
    session: {
      id: 'public-child-a', title: 'Production child', userId: 'public-user-a', mode: 'read',
      project, messages: [{
        role: 'user', content: 'Verify the evidence.', createdAt: '2026-08-08T01:00:02.000Z',
      }],
      tokenUsage: { promptTokens: 5, completionTokens: 0, totalTokens: 5 }, aborted: false,
    },
    now: '2026-08-08T01:00:06.000Z',
  });
  const preference = await sessionStore.upsertPreference({
    userId: 'public-user-a', key: 'language', value: 'English', confidence: 0.875,
    sourceSessionId: session.id, evidence: 'User requested English.',
    now: '2026-08-08T01:00:07.000Z',
  });
  const run: AgentRunRecord = {
    runId: 'public-run-a', sessionId: session.id, status: 'done', phase: 'done', iteration: 3,
    finalText: 'Order is paid.',
    toolExecutions: [{
      toolName: 'lookup', status: 'success', completionRole: 'supporting',
      completionGroup: 'orders', completionEvidence: {
        kind: 'query', deliveryReady: true, outcome: 'succeeded', source: 'runtime',
        executionId: 'public-call-1', summary: 'Order 7 is paid', metrics: { rows: 1 },
      },
    }],
    completion: {
      verified: true, deliveryReady: true, finalResponseReady: true, phase: 'done',
      unresolvedTaskIds: [], missing: [], evidenceKinds: ['query'],
    },
    createdAt: '2026-08-08T01:00:00.000Z', updatedAt: '2026-08-08T01:00:08.000Z',
  };
  await sessionStore.saveRun(run);
  const subagent: AgentSubagentRecord = {
    id: 'public-subagent-a', parentSessionId: session.id, childSessionId: 'public-child-a',
    task: 'Verify order evidence', contextStrategy: 'fork', status: 'completed', depth: 3,
    summary: 'Evidence verified', artifactReferences: ['legacy-session-artifact'],
    createdAt: '2026-08-08T01:00:02.000Z', updatedAt: '2026-08-08T01:00:08.000Z',
  };
  sessionStore.saveSubagent(subagent);

  const checkpointStore = new AgentCheckpointStore(
    join(projectDir, 'legacy-checkpoints', `${session.id}.json`),
  );
  await checkpointStore.save({
    session, iteration: 3, status: 'done', toolExecutions: [],
    finalText: run.finalText, now: '2026-08-08T01:00:08.000Z',
  });
  const streamStore = new AgentStreamStore(
    join(projectDir, 'legacy-streams', `${session.id}.json`),
  );
  await streamStore.start({
    id: 'public-stream-a', sessionId: session.id, roundId: 'round-3',
    providerId: 'provider-public', model: 'model-public', now: '2026-08-08T01:00:02.000Z',
  });
  await streamStore.appendEvent('public-stream-a', {
    type: 'usage', usage: { promptTokens: 123, completionTokens: 45, totalTokens: 168 },
  }, '2026-08-08T01:00:03.000Z');
  await new AgentAuditLogStore(join(projectDir, 'legacy-audit.jsonl')).append({
    type: 'run_finished', timestamp: '2026-08-08T01:00:08.000Z', sessionId: session.id,
    status: 'done', iterations: 3, durationMs: 8_000, finalTextPreview: run.finalText,
  });

  const artifactJournal = new SqliteAgentJournal({
    filePath: join(projectDir, 'legacy-artifacts', 'artifact-journal.db'),
    now: () => '2026-08-08T01:00:04.000Z',
    createId: (() => { let id = 0; return () => `public-artifact-id-${++id}`; })(),
  });
  const artifactRun = await artifactJournal.createRun({
    projectId: 'legacy-artifact-project', sessionId: session.id,
    clientRequestId: 'legacy-artifact-request', input: { source: 'public legacy producer' },
  });
  const artifactLease = await artifactJournal.acquireRunLease({
    projectId: 'legacy-artifact-project', runId: artifactRun.runId,
    ownerId: 'legacy-artifact-writer', ttlMs: 60_000,
  });
  await artifactJournal.startRun({
    projectId: 'legacy-artifact-project', sessionId: session.id, runId: artifactRun.runId,
    commandId: 'legacy-artifact-start',
    lease: { ownerId: artifactLease.ownerId, fencingToken: artifactLease.fencingToken },
    expectedRunRevision: 1,
  });
  const artifactStore = new ProjectArtifactStore({
    projectId: 'legacy-artifact-project', rootDir: join(projectDir, 'legacy-artifacts'),
    journal: artifactJournal, now: () => '2026-08-08T01:00:04.000Z',
    createId: (() => { let id = 0; return () => `public-store-id-${++id}`; })(),
  });
  const staged = await artifactStore.stage({
    mediaType: 'text/plain', source: (async function* () {
      yield new TextEncoder().encode('legacy artifact\n');
    })(),
  });
  await artifactStore.commit({
    staged, summary: 'Public legacy artifact',
    journal: {
      sessionId: session.id, runId: artifactRun.runId, commandId: 'legacy-artifact-commit',
      lease: { ownerId: artifactLease.ownerId, fencingToken: artifactLease.fencingToken },
      expectedRunRevision: 2,
    },
  });
  return { projectDir, session, run, preference, subagent };
}

async function createLegacyWriterProject(): Promise<string> {
  const projectDir = await mkdtemp(join(tmpdir(), 'dbagent-legacy-writer-project-'));
  temporaryDirectories.push(projectDir);
  const store = new AgentSessionStore(join(projectDir, 'state.db'));
  await store.save({
    now: '2026-08-08T00:01:00.000Z',
    session: {
      id: 'session-a',
      title: 'before-writer-race',
      userId: 'user-a',
      mode: 'read',
      messages: [
        { role: 'user', content: 'race', createdAt: '2026-08-08T00:00:00.000Z' },
      ],
      tokenUsage: { promptTokens: 1, completionTokens: 0, totalTokens: 1 },
      aborted: false,
    },
  });
  withTestDatabase(join(projectDir, 'state.db'), (database) => {
    database.exec('ALTER TABLE agent_runs ADD COLUMN plan_json TEXT');
  });
  return projectDir;
}

function withTestDatabase<T>(path: string, operation: (database: NodeDatabaseSync) => T): T {
  const database = new DatabaseSync(path);
  try {
    return operation(database);
  } finally {
    database.close();
  }
}

async function readChunks(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const result: Uint8Array[] = [];
  for await (const chunk of chunks) result.push(chunk);
  const byteSize = result.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(byteSize);
  let offset = 0;
  for (const chunk of result) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function spawnMigrationWorker(
  projectDir: string,
  mode: 'migrate' | 'write' | 'audit' | 'checkpoint' | 'stream' | 'artifact',
  environment: Record<string, string> = {},
) {
  const viteNode = join(
    process.cwd(), 'node_modules', '.pnpm', 'vite-node@2.1.9_@types+node@22.19.20',
    'node_modules', 'vite-node', 'vite-node.mjs',
  );
  const helper = join(process.cwd(), 'packages', 'core-agent', 'test', 'fixtures',
    'migration-lock-worker.ts');
  return spawn(process.execPath, [viteNode, helper], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DBAGENT_MIGRATION_CHILD_PROJECT: projectDir,
      DBAGENT_MIGRATION_LOCK_WORKER_MODE: mode,
      ...environment,
    },
    stdio: 'ignore',
  });
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${path}.`);
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return await new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('exit', resolveExit);
  });
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
