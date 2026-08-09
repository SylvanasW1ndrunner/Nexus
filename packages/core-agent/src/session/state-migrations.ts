import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, relative, sep } from 'node:path';
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';
import { SqliteAgentJournal } from '../events/sqlite-agent-journal.js';

type NodeSqlite = {
  DatabaseSync: new (path: string) => NodeDatabaseSync;
  backup(database: NodeDatabaseSync, destination: string): Promise<void>;
};

const nodeSqlite = createRequire(import.meta.url)('node:sqlite') as NodeSqlite;
const DatabaseSync = nodeSqlite.DatabaseSync;

export type MigrationCrashPoint =
  | 'after-shadow-validated'
  | 'after-intent-fsync'
  | 'after-source-renamed'
  | 'after-shadow-promoted';

export type MigrationErrorCode =
  | 'INVALID_ARGUMENT'
  | 'INJECTED_CRASH'
  | 'MIGRATION_LOCKED'
  | 'MIGRATION_SOURCE_CORRUPT'
  | 'MIGRATION_STATE_CONFLICT'
  | 'MIGRATION_VALIDATION_FAILED';

export type MigrationManifestEntry = {
  relativePath: string;
  checksum: string;
  byteSize: number;
};

export type MigrationInspection = {
  migrationId: string;
  sourceDigest: string;
  manifest: MigrationManifestEntry[];
  shadowPath: string;
  sourceBackupPath: string;
  sourceSnapshotPath: string;
  intentStatus: 'missing' | 'validated_pending_activation' | 'completed';
};

export class StateMigrationError extends Error {
  constructor(
    readonly code: MigrationErrorCode,
    message: string,
    readonly inspection?: MigrationInspection,
    readonly crashPoint?: MigrationCrashPoint,
  ) {
    super(message);
    this.name = 'StateMigrationError';
  }
}

export type StateMigrationOptions = {
  targetSchemaVersion?: number;
  migratorRevision?: string;
  crashAt?: MigrationCrashPoint;
};

type MigrationIntent = {
  schemaVersion: 1;
  migrationId: string;
  sourceDigest: string;
  targetSchemaVersion: number;
  migratorRevision: string;
  sourcePath: string;
  sourceSnapshotPath: string;
  sourceBackupPath: string;
  shadowPath: string;
  finalPath: string;
  validationDigest: string;
  status: 'validated_pending_activation' | 'completed';
  manifest: MigrationManifestEntry[];
};

type MigrationRow = {
  migration_id: string;
  source_digest: string;
  target_schema_version: number;
  migrator_revision: string;
  validation_digest: string;
  status: 'validated_pending_activation' | 'active';
  validation_report_json: string;
  manifest_json: string;
};

export type ImportedLegacyState = {
  sessions: Array<{
    id: string;
    title: string;
    userId: string | null;
    mode: string;
    messages: Array<{ role: string; content: string; createdAt: string }>;
  }>;
  runs: Array<{
    runId: string;
    sessionId: string;
    status: string;
    plan: unknown;
    createdAt: string;
    updatedAt: string;
  }>;
  plan: unknown;
  preferences: Array<{
    id: string;
    userId: string;
    key: string;
    value: string;
    confidence: number;
    sourceSessionId: string | null;
  }>;
  checkpoints: Array<{
    sessionId: string;
    sequence: number;
    summary: string;
    createdAt: string;
  }>;
  subagents: Array<{
    id: string;
    parentSessionId: string;
    childSessionId: string | null;
    status: string;
    depth: number;
  }>;
  diagnostics: Array<{ code: string; evidence: string }>;
};

export class StateMigrationRunner {
  readonly #projectDir: string;
  readonly #intent: MigrationIntent;

  constructor(projectDir: string, intent: MigrationIntent) {
    this.#projectDir = projectDir;
    this.#intent = intent;
  }

  static async open(
    projectDir: string,
    options: StateMigrationOptions = {},
  ): Promise<StateMigrationRunner> {
    const normalizedDir = requireText(projectDir, 'projectDir');
    const targetSchemaVersion = options.targetSchemaVersion ?? 2;
    const migratorRevision = requireText(options.migratorRevision ?? 'task-4-r1', 'migratorRevision');
    if (!Number.isSafeInteger(targetSchemaVersion) || targetSchemaVersion < 2) {
      throw new StateMigrationError('INVALID_ARGUMENT', 'targetSchemaVersion must be at least 2.');
    }
    await mkdir(normalizedDir, { recursive: true });
    const lockPath = join(normalizedDir, 'state.migration.lock');
    let lock;
    try {
      lock = await open(lockPath, 'wx', 0o600);
    } catch (error) {
      if (errorCode(error) === 'EEXIST') {
        throw new StateMigrationError('MIGRATION_LOCKED', 'Another migration owns this Project.');
      }
      throw error;
    }
    try {
      return await migrateLocked(normalizedDir, {
        targetSchemaVersion,
        migratorRevision,
        ...(options.crashAt === undefined ? {} : { crashAt: options.crashAt }),
      });
    } finally {
      await lock.close();
      await unlink(lockPath).catch(() => undefined);
    }
  }

  activeSchemaVersion(): Promise<number> {
    return Promise.resolve(withDatabase(this.#intent.finalPath, (database) => {
      const row = database.prepare('SELECT schema_version FROM state_metadata WHERE id = 1').get() as
        | { schema_version: number }
        | undefined;
      return Number(row?.schema_version ?? 0);
    }));
  }

  countLegacyImports(): Promise<number> {
    return Promise.resolve(withDatabase(this.#intent.finalPath, (database) =>
      Number(
        (
          database.prepare('SELECT COUNT(*) AS count FROM legacy_imports').get() as {
            count: number;
          }
        ).count,
      ),
    ));
  }

  readImportedLegacyState(): Promise<ImportedLegacyState> {
    return Promise.resolve(withDatabase(this.#intent.finalPath, (database) => {
      const row = database
        .prepare('SELECT imported_state_json FROM legacy_imports WHERE migration_id = ?')
        .get(this.#intent.migrationId) as { imported_state_json: string } | undefined;
      if (row === undefined) {
        throw new StateMigrationError('MIGRATION_VALIDATION_FAILED', 'Legacy import is missing.');
      }
      return JSON.parse(row.imported_state_json) as ImportedLegacyState;
    }));
  }

  async inspect(): Promise<MigrationInspection> {
    const intent = await readIntent(this.#projectDir);
    return inspectionFromIntent(intent ?? this.#intent, intent?.status ?? 'missing');
  }
}

async function migrateLocked(
  projectDir: string,
  options: Required<Pick<StateMigrationOptions, 'targetSchemaVersion' | 'migratorRevision'>> &
    Pick<StateMigrationOptions, 'crashAt'>,
): Promise<StateMigrationRunner> {
  const finalPath = join(projectDir, 'state.db');
  const existingIntent = await readIntent(projectDir);
  const shadowCandidates = await listShadowCandidates(projectDir);
  if (shadowCandidates.length > 1) {
    throw new StateMigrationError(
      'MIGRATION_STATE_CONFLICT',
      'Multiple migration Shadow databases exist.',
    );
  }

  if (existingIntent !== undefined) {
    assertIntentOptions(existingIntent, options);
    assertShadowSetConsistent(shadowCandidates, existingIntent);
    return await activate(projectDir, existingIntent, options.crashAt);
  }

  const currentRow = await readMigrationRowIfNew(finalPath);
  if (currentRow !== undefined) {
    const reconstructed = intentFromActiveRow(projectDir, currentRow);
    await setMigrationActive(finalPath, reconstructed.migrationId);
    const completed = { ...reconstructed, status: 'completed' as const };
    await writeIntent(projectDir, completed);
    return new StateMigrationRunner(projectDir, completed);
  }

  if (shadowCandidates.length === 1) {
    const row = readValidatedMigrationRow(shadowCandidates[0]!);
    if (row.target_schema_version !== options.targetSchemaVersion ||
      row.migrator_revision !== options.migratorRevision) {
      throw new StateMigrationError('MIGRATION_STATE_CONFLICT', 'Validated Shadow target conflicts.');
    }
    const intent = intentFromValidatedRow(projectDir, shadowCandidates[0]!, row);
    await assertSourceDigestStillMatches(projectDir, intent);
    await writeIntent(projectDir, intent);
    crashIf(options.crashAt, 'after-intent-fsync', inspectionFromIntent(intent, intent.status));
    return await activate(projectDir, intent, options.crashAt);
  }

  const intent = await buildValidatedShadow(projectDir, options);
  crashIf(options.crashAt, 'after-shadow-validated', inspectionFromIntent(intent, 'missing'));
  await writeIntent(projectDir, intent);
  crashIf(options.crashAt, 'after-intent-fsync', inspectionFromIntent(intent, intent.status));
  return await activate(projectDir, intent, options.crashAt);
}

async function buildValidatedShadow(
  projectDir: string,
  options: Required<Pick<StateMigrationOptions, 'targetSchemaVersion' | 'migratorRevision'>>,
): Promise<MigrationIntent> {
  const sourcePath = join(projectDir, 'state.db');
  await assertLegacySource(sourcePath);
  const sourceSnapshotTemporary = join(projectDir, `state.source.${process.pid}.db.tmp`);
  const source = new DatabaseSync(sourcePath);
  try {
    source.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    await nodeSqlite.backup(source, sourceSnapshotTemporary);
  } catch (error) {
    throw new StateMigrationError(
      'MIGRATION_SOURCE_CORRUPT',
      `Unable to checkpoint and back up legacy SQLite: ${errorMessage(error)}`,
    );
  } finally {
    source.close();
  }
  await fsyncFile(sourceSnapshotTemporary);
  const manifest = await createSourceManifest(projectDir, sourceSnapshotTemporary);
  const sourceDigest = sha256(canonicalJson(manifest));
  const migrationId = sha256(
    `${sourceDigest}\0${options.targetSchemaVersion}\0${options.migratorRevision}`,
  );
  const sourceSnapshotPath = join(projectDir, `state.source.${migrationId}.db`);
  const sourceBackupPath = join(projectDir, `state.legacy.${migrationId}.db`);
  const shadowPath = join(projectDir, `state.v2.${migrationId}.db.tmp`);
  await rename(sourceSnapshotTemporary, sourceSnapshotPath);
  await fsyncDirectory(projectDir);
  if (await pathExists(shadowPath)) {
    throw new StateMigrationError('MIGRATION_STATE_CONFLICT', 'Target Shadow already exists.');
  }

  await new SqliteAgentJournal({ filePath: shadowPath }).countEvents();
  const importedState = readLegacyState(sourceSnapshotPath);
  const validationReport = validateLegacyState(importedState, manifest);
  const validationDigest = sha256(canonicalJson(validationReport));
  const shadow = new DatabaseSync(shadowPath);
  try {
    shadow.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE state_metadata (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        schema_version INTEGER NOT NULL
      );
      CREATE TABLE schema_migrations (
        migration_id TEXT PRIMARY KEY,
        source_digest TEXT NOT NULL,
        target_schema_version INTEGER NOT NULL,
        migrator_revision TEXT NOT NULL,
        validation_digest TEXT NOT NULL,
        status TEXT NOT NULL,
        validation_report_json TEXT NOT NULL,
        manifest_json TEXT NOT NULL
      );
      CREATE TABLE legacy_imports (
        migration_id TEXT PRIMARY KEY,
        imported_state_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE legacy_archives (
        migration_id TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        checksum TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        PRIMARY KEY (migration_id, relative_path)
      );
    `);
    shadow.exec('BEGIN IMMEDIATE');
    try {
      shadow.prepare('INSERT INTO state_metadata (id, schema_version) VALUES (1, ?)')
        .run(options.targetSchemaVersion);
      shadow.prepare(`
        INSERT INTO legacy_imports (migration_id, imported_state_json, created_at)
        VALUES (?, ?, ?)
      `).run(migrationId, canonicalJson(importedState), new Date(0).toISOString());
      const insertArchive = shadow.prepare(`
        INSERT INTO legacy_archives (migration_id, relative_path, checksum, byte_size)
        VALUES (?, ?, ?, ?)
      `);
      for (const entry of manifest.filter(({ relativePath }) => relativePath !== 'state.source.db')) {
        insertArchive.run(migrationId, entry.relativePath, entry.checksum, entry.byteSize);
      }
      shadow.prepare(`
        INSERT INTO schema_migrations (
          migration_id, source_digest, target_schema_version, migrator_revision,
          validation_digest, status, validation_report_json, manifest_json
        ) VALUES (?, ?, ?, ?, ?, 'validated_pending_activation', ?, ?)
      `).run(
        migrationId,
        sourceDigest,
        options.targetSchemaVersion,
        options.migratorRevision,
        validationDigest,
        canonicalJson(validationReport),
        canonicalJson(manifest),
      );
      shadow.exec('COMMIT');
    } catch (error) {
      shadow.exec('ROLLBACK');
      throw error;
    }
    shadow.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    shadow.close();
  }
  await fsyncFile(shadowPath);
  await fsyncDirectory(projectDir);
  return {
    schemaVersion: 1,
    migrationId,
    sourceDigest,
    targetSchemaVersion: options.targetSchemaVersion,
    migratorRevision: options.migratorRevision,
    sourcePath,
    sourceSnapshotPath,
    sourceBackupPath,
    shadowPath,
    finalPath: sourcePath,
    validationDigest,
    status: 'validated_pending_activation',
    manifest,
  };
}

async function activate(
  projectDir: string,
  intent: MigrationIntent,
  crashAt: MigrationCrashPoint | undefined,
): Promise<StateMigrationRunner> {
  await validateIntentAndShadow(intent);
  const currentRow = await readMigrationRowIfNew(intent.finalPath);
  if (currentRow === undefined) {
    if (await pathExists(intent.sourcePath)) {
      if (await pathExists(intent.sourceBackupPath)) {
        throw new StateMigrationError(
          'MIGRATION_STATE_CONFLICT',
          'Both active source and versioned source backup exist.',
          inspectionFromIntent(intent, intent.status),
        );
      }
      await assertSourceDigestStillMatches(projectDir, intent);
      await rename(intent.sourcePath, intent.sourceBackupPath);
      await fsyncDirectory(projectDir);
      crashIf(crashAt, 'after-source-renamed', inspectionFromIntent(intent, intent.status));
    }
    if (!(await pathExists(intent.finalPath))) {
      if (!(await pathExists(intent.shadowPath))) {
        throw new StateMigrationError(
          'MIGRATION_STATE_CONFLICT',
          'Validated Shadow is missing during activation.',
          inspectionFromIntent(intent, intent.status),
        );
      }
      await rename(intent.shadowPath, intent.finalPath);
      await fsyncDirectory(projectDir);
      crashIf(crashAt, 'after-shadow-promoted', inspectionFromIntent(intent, intent.status));
    }
  } else if (
    currentRow.migration_id !== intent.migrationId ||
    currentRow.source_digest !== intent.sourceDigest ||
    currentRow.validation_digest !== intent.validationDigest
  ) {
    throw new StateMigrationError(
      'MIGRATION_STATE_CONFLICT',
      'Current new database does not match activation intent.',
      inspectionFromIntent(intent, intent.status),
    );
  }
  await setMigrationActive(intent.finalPath, intent.migrationId);
  const completed = { ...intent, status: 'completed' as const };
  await writeIntent(projectDir, completed);
  await rm(intent.shadowPath, { force: true });
  await fsyncDirectory(projectDir);
  return new StateMigrationRunner(projectDir, completed);
}

function readLegacyState(path: string): ImportedLegacyState {
  return withDatabase(path, (database) => {
    try {
      const sessionRows = tableExists(database, 'agent_sessions')
        ? (database.prepare(
          'SELECT id, title, user_id, mode FROM agent_sessions ORDER BY id',
        ).all() as unknown as Array<{
          id: string; title: string; user_id: string | null; mode: string;
        }>)
        : [];
      const messages = tableExists(database, 'agent_session_messages')
        ? (database.prepare(`
          SELECT session_id, role, content, created_at
          FROM agent_session_messages
          ORDER BY session_id, message_index
        `).all() as unknown as Array<{
          session_id: string; role: string; content: string; created_at: string;
        }>)
        : [];
      const sessions = sessionRows.map((session) => ({
        id: session.id,
        title: session.title,
        userId: session.user_id,
        mode: session.mode,
        messages: messages
          .filter(({ session_id: sessionId }) => sessionId === session.id)
          .map((message) => ({
            role: message.role,
            content: message.content,
            createdAt: message.created_at,
          })),
      }));
      const runRows = tableExists(database, 'agent_runs')
        ? (database.prepare(`
          SELECT run_id, session_id, status, plan_json, created_at, updated_at
          FROM agent_runs ORDER BY run_id
        `).all() as unknown as Array<{
          run_id: string; session_id: string; status: string; plan_json: string | null;
          created_at: string; updated_at: string;
        }>)
        : [];
      const runs = runRows.map((run) => ({
        runId: run.run_id,
        sessionId: run.session_id,
        status: run.status === 'completed' ? 'completed' : 'interrupted_legacy',
        plan: parseNullableJson(run.plan_json),
        createdAt: run.created_at,
        updatedAt: run.updated_at,
      }));
      const preferenceRows = tableExists(database, 'agent_user_preferences')
        ? (database.prepare(`
          SELECT id, user_id, preference_key, value, confidence, source_session_id
          FROM agent_user_preferences ORDER BY id
        `).all() as unknown as Array<{
          id: string; user_id: string; preference_key: string; value: string;
          confidence: number; source_session_id: string | null;
        }>)
        : [];
      const checkpointRows = tableExists(database, 'agent_context_checkpoints')
        ? (database.prepare(`
          SELECT session_id, sequence, summary, created_at
          FROM agent_context_checkpoints ORDER BY session_id, sequence
        `).all() as unknown as Array<{
          session_id: string; sequence: number; summary: string; created_at: string;
        }>)
        : [];
      const subagentRows = tableExists(database, 'agent_subagents')
        ? (database.prepare(`
          SELECT id, parent_session_id, child_session_id, status, depth
          FROM agent_subagents ORDER BY id
        `).all() as unknown as Array<{
          id: string; parent_session_id: string; child_session_id: string | null;
          status: string; depth: number;
        }>)
        : [];
      const diagnosticRows = tableExists(database, 'legacy_runtime_diagnostics')
        ? (database.prepare(`
          SELECT kind, durable_evidence FROM legacy_runtime_diagnostics ORDER BY kind
        `).all() as unknown as Array<{ kind: string; durable_evidence: string }>)
        : [];
      return {
        sessions,
        runs,
        plan: runs.find(({ plan }) => plan !== null)?.plan ?? null,
        preferences: preferenceRows.map((preference) => ({
          id: preference.id,
          userId: preference.user_id,
          key: preference.preference_key,
          value: preference.value,
          confidence: preference.confidence,
          sourceSessionId: preference.source_session_id,
        })),
        checkpoints: checkpointRows.map((checkpoint) => ({
          sessionId: checkpoint.session_id,
          sequence: checkpoint.sequence,
          summary: checkpoint.summary,
          createdAt: checkpoint.created_at,
        })),
        subagents: subagentRows.map((subagent) => ({
          id: subagent.id,
          parentSessionId: subagent.parent_session_id,
          childSessionId: subagent.child_session_id,
          status: subagent.status,
          depth: subagent.depth,
        })),
        diagnostics: diagnosticRows.map((diagnostic) => ({
          code: diagnostic.kind === 'approval'
            ? 'LEGACY_APPROVAL_EXPIRED'
            : 'LEGACY_RESULT_HANDLE_EXPIRED',
          evidence: diagnostic.durable_evidence,
        })),
      };
    } catch (error) {
      throw new StateMigrationError(
        'MIGRATION_SOURCE_CORRUPT',
        `Legacy state cannot be read: ${errorMessage(error)}`,
      );
    }
  });
}

function validateLegacyState(
  state: ImportedLegacyState,
  manifest: MigrationManifestEntry[],
): Record<string, unknown> {
  const sessionIds = new Set(state.sessions.map(({ id }) => id));
  if (
    state.runs.some(({ sessionId }) => !sessionIds.has(sessionId)) ||
    state.subagents.some(({ parentSessionId, childSessionId }) =>
      !sessionIds.has(parentSessionId) ||
      (childSessionId !== null && !sessionIds.has(childSessionId)),
    )
  ) {
    throw new StateMigrationError(
      'MIGRATION_VALIDATION_FAILED',
      'Legacy Run or subagent relationship points outside imported Sessions.',
    );
  }
  return {
    schemaVersion: 1,
    status: 'validated',
    sessionCount: state.sessions.length,
    messageCount: state.sessions.reduce((count, session) => count + session.messages.length, 0),
    runCount: state.runs.length,
    completedRunCount: state.runs.filter(({ status }) => status === 'completed').length,
    interruptedRunCount: state.runs.filter(({ status }) => status === 'interrupted_legacy').length,
    preferenceCount: state.preferences.length,
    checkpointCount: state.checkpoints.length,
    subagentCount: state.subagents.length,
    archiveCount: manifest.length - 1,
    importedStateDigest: sha256(canonicalJson(state)),
    manifestDigest: sha256(canonicalJson(manifest)),
  };
}

async function createSourceManifest(
  projectDir: string,
  sourceSnapshotPath: string,
): Promise<MigrationManifestEntry[]> {
  const candidates: Array<{ path: string; relativePath: string }> = [
    ...(await listFiles(join(projectDir, 'legacy-artifacts'), projectDir)),
    ...(await listSingleFile(join(projectDir, 'legacy-audit.jsonl'), projectDir)),
    ...(await listFiles(join(projectDir, 'legacy-checkpoints'), projectDir)),
    ...(await listFiles(join(projectDir, 'legacy-streams'), projectDir)),
    { path: sourceSnapshotPath, relativePath: 'state.source.db' },
  ];
  const manifest: MigrationManifestEntry[] = [];
  for (const candidate of candidates.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath, 'en'),
  )) {
    const metadata = await stat(candidate.path);
    manifest.push({
      relativePath: candidate.relativePath,
      checksum: await hashFile(candidate.path),
      byteSize: metadata.size,
    });
  }
  return manifest;
}

async function assertSourceDigestStillMatches(
  projectDir: string,
  intent: MigrationIntent,
): Promise<void> {
  const source = await firstExistingPath([
    intent.sourceSnapshotPath,
    intent.sourceBackupPath,
    intent.sourcePath,
  ]);
  if (source === undefined) {
    throw new StateMigrationError(
      'MIGRATION_STATE_CONFLICT',
      'No immutable legacy source remains for digest verification.',
      inspectionFromIntent(intent, intent.status),
    );
  }
  const manifest = await createSourceManifest(projectDir, source);
  const digest = sha256(canonicalJson(manifest));
  if (digest !== intent.sourceDigest || canonicalJson(manifest) !== canonicalJson(intent.manifest)) {
    throw new StateMigrationError(
      'MIGRATION_STATE_CONFLICT',
      'Legacy source digest changed after validation.',
      inspectionFromIntent(intent, intent.status),
    );
  }
}

async function assertLegacySource(path: string): Promise<void> {
  if (!(await pathExists(path))) {
    throw new StateMigrationError('MIGRATION_SOURCE_CORRUPT', 'Legacy state.db is missing.');
  }
  try {
    withDatabase(path, (database) => {
      const integrity = database.prepare('PRAGMA integrity_check').get() as {
        integrity_check: string;
      };
      if (integrity.integrity_check !== 'ok' || !tableExists(database, 'agent_sessions')) {
        throw new Error('Legacy SQLite integrity or required table check failed.');
      }
    });
  } catch (error) {
    throw new StateMigrationError(
      'MIGRATION_SOURCE_CORRUPT',
      `Legacy SQLite is corrupt: ${errorMessage(error)}`,
    );
  }
}

async function validateIntentAndShadow(intent: MigrationIntent): Promise<void> {
  if (await pathExists(intent.shadowPath)) {
    const row = readValidatedMigrationRow(intent.shadowPath);
    if (
      row.migration_id !== intent.migrationId ||
      row.source_digest !== intent.sourceDigest ||
      row.validation_digest !== intent.validationDigest ||
      row.target_schema_version !== intent.targetSchemaVersion ||
      row.migrator_revision !== intent.migratorRevision
    ) {
      throw new StateMigrationError(
        'MIGRATION_STATE_CONFLICT',
        'Shadow metadata conflicts with activation intent.',
        inspectionFromIntent(intent, intent.status),
      );
    }
  }
}

function readValidatedMigrationRow(path: string): MigrationRow {
  try {
    return withDatabase(path, (database) => {
      const row = database.prepare(`
        SELECT * FROM schema_migrations
        WHERE status IN ('validated_pending_activation', 'active')
      `).get() as MigrationRow | undefined;
      if (row === undefined) throw new Error('Validated migration row is missing.');
      return row;
    });
  } catch (error) {
    throw new StateMigrationError(
      'MIGRATION_STATE_CONFLICT',
      `Shadow is not a validated new database: ${errorMessage(error)}`,
    );
  }
}

async function readMigrationRowIfNew(path: string): Promise<MigrationRow | undefined> {
  if (!(await pathExists(path))) return undefined;
  try {
    return withDatabase(path, (database) => {
      if (!tableExists(database, 'schema_migrations')) return undefined;
      return database.prepare('SELECT * FROM schema_migrations LIMIT 1').get() as
        | MigrationRow
        | undefined;
    });
  } catch {
    return undefined;
  }
}

async function setMigrationActive(path: string, migrationId: string): Promise<void> {
  withDatabase(path, (database) => {
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = database.prepare(`
        UPDATE schema_migrations SET status = 'active'
        WHERE migration_id = ? AND status IN ('validated_pending_activation', 'active')
      `).run(migrationId);
      if (Number(result.changes) !== 1) throw new Error('Migration activation row is missing.');
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  });
  await fsyncFile(path);
}

function intentFromValidatedRow(
  projectDir: string,
  shadowPath: string,
  row: MigrationRow,
): MigrationIntent {
  return {
    schemaVersion: 1,
    migrationId: row.migration_id,
    sourceDigest: row.source_digest,
    targetSchemaVersion: row.target_schema_version,
    migratorRevision: row.migrator_revision,
    sourcePath: join(projectDir, 'state.db'),
    sourceSnapshotPath: join(projectDir, `state.source.${row.migration_id}.db`),
    sourceBackupPath: join(projectDir, `state.legacy.${row.migration_id}.db`),
    shadowPath,
    finalPath: join(projectDir, 'state.db'),
    validationDigest: row.validation_digest,
    status: 'validated_pending_activation',
    manifest: JSON.parse(row.manifest_json) as MigrationManifestEntry[],
  };
}

function intentFromActiveRow(projectDir: string, row: MigrationRow): MigrationIntent {
  const shadowPath = join(projectDir, `state.v2.${row.migration_id}.db.tmp`);
  return {
    ...intentFromValidatedRow(projectDir, shadowPath, row),
    status: 'completed',
  };
}

async function readIntent(projectDir: string): Promise<MigrationIntent | undefined> {
  try {
    const value = JSON.parse(await readFile(join(projectDir, 'state.migration.json'), 'utf8')) as
      MigrationIntent;
    if (value.schemaVersion !== 1 || !value.migrationId || !value.sourceDigest) {
      throw new Error('Intent shape is invalid.');
    }
    return value;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw new StateMigrationError(
      'MIGRATION_STATE_CONFLICT',
      `Migration intent is corrupt: ${errorMessage(error)}`,
    );
  }
}

async function writeIntent(projectDir: string, intent: MigrationIntent): Promise<void> {
  const path = join(projectDir, 'state.migration.json');
  const temporaryPath = join(projectDir, `state.migration.${process.pid}.${Date.now()}.tmp`);
  const file = await open(temporaryPath, 'wx', 0o600);
  try {
    await file.writeFile(`${canonicalJson(intent)}\n`, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporaryPath, path);
  await fsyncDirectory(projectDir);
}

async function listShadowCandidates(projectDir: string): Promise<string[]> {
  return (await readdir(projectDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^state\.v2\..+\.db\.tmp$/u.test(entry.name))
    .map((entry) => join(projectDir, entry.name))
    .sort();
}

function assertShadowSetConsistent(
  shadows: string[],
  intent: MigrationIntent,
): void {
  if (shadows.some((path) => path !== intent.shadowPath)) {
    throw new StateMigrationError(
      'MIGRATION_STATE_CONFLICT',
      'Competing Shadow does not match activation intent.',
      inspectionFromIntent(intent, intent.status),
    );
  }
}

function assertIntentOptions(
  intent: MigrationIntent,
  options: Pick<StateMigrationOptions, 'targetSchemaVersion' | 'migratorRevision'>,
): void {
  if (
    intent.targetSchemaVersion !== options.targetSchemaVersion ||
    intent.migratorRevision !== options.migratorRevision
  ) {
    throw new StateMigrationError(
      'MIGRATION_STATE_CONFLICT',
      'Migration options conflict with persisted intent.',
      inspectionFromIntent(intent, intent.status),
    );
  }
}

function inspectionFromIntent(
  intent: MigrationIntent,
  status: MigrationInspection['intentStatus'],
): MigrationInspection {
  return {
    migrationId: intent.migrationId,
    sourceDigest: intent.sourceDigest,
    manifest: structuredClone(intent.manifest),
    shadowPath: intent.shadowPath,
    sourceBackupPath: intent.sourceBackupPath,
    sourceSnapshotPath: intent.sourceSnapshotPath,
    intentStatus: status,
  };
}

function crashIf(
  requested: MigrationCrashPoint | undefined,
  actual: MigrationCrashPoint,
  inspection: MigrationInspection,
): void {
  if (requested === actual) {
    throw new StateMigrationError(
      'INJECTED_CRASH',
      `Injected migration crash at ${actual}.`,
      inspection,
      actual,
    );
  }
}

async function listFiles(
  root: string,
  projectDir: string,
): Promise<Array<{ path: string; relativePath: string }>> {
  if (!(await pathExists(root))) return [];
  const result: Array<{ path: string; relativePath: string }> = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    result.push({ path, relativePath: normalizeRelative(relative(projectDir, path)) });
  }
  return result;
}

async function listSingleFile(
  path: string,
  projectDir: string,
): Promise<Array<{ path: string; relativePath: string }>> {
  return (await pathExists(path))
    ? [{ path, relativePath: normalizeRelative(relative(projectDir, path)) }]
    : [];
}

function normalizeRelative(path: string): string {
  return path.split(sep).join('/');
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  const chunks = createReadStream(path, { highWaterMark: 64 * 1024 }) as AsyncIterable<Uint8Array>;
  for await (const chunk of chunks) hash.update(chunk);
  return hash.digest('hex');
}

async function fsyncFile(path: string): Promise<void> {
  const file = await open(path, 'r+');
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r');
  try {
    await directory.sync();
  } catch (error) {
    if (!['EINVAL', 'EBADF', 'EPERM', 'EISDIR'].includes(errorCode(error) ?? '')) throw error;
  } finally {
    await directory.close();
  }
}

function tableExists(database: NodeDatabaseSync, table: string): boolean {
  return database.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table) !== undefined;
}

function withDatabase<T>(path: string, operation: (database: NodeDatabaseSync) => T): T {
  const database = new DatabaseSync(path);
  try {
    return operation(database);
  } finally {
    database.close();
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortPortable(value));
}

function sortPortable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortPortable);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right, 'en'))
        .map(([key, item]) => [key, sortPortable(item)]),
    );
  }
  return value;
}

function parseNullableJson(value: string | null): unknown {
  return value === null ? null : JSON.parse(value);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

async function firstExistingPath(paths: string[]): Promise<string | undefined> {
  for (const path of paths) if (await pathExists(path)) return path;
  return undefined;
}

function requireText(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new StateMigrationError('INVALID_ARGUMENT', `${name} is required.`);
  }
  return value.trim();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
