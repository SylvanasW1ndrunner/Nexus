import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  StateMigrationError,
  StateMigrationRunner,
  type MigrationCrashPoint,
  type MigrationInspection,
} from '../src/session/state-migrations.js';
import { SqliteAgentJournal } from '../src/events/sqlite-agent-journal.js';
import { JournalSessionStore } from '../src/journal-session-store.js';
import { AgentSessionStore } from '../src/session-store.js';

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
      expect.objectContaining({ runId: 'legacy-run-complete', status: 'completed' }),
      expect.objectContaining({ runId: 'legacy-run-running', status: 'interrupted_legacy' }),
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
          title: 'forged', userId: null, mode: 'general',
        },
      }],
    })).rejects.toMatchObject({ code: 'COMMITTER_REQUIRED' });
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

function spawnMigrationWorker(
  projectDir: string,
  mode: 'migrate' | 'write',
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
