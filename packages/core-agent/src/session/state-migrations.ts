import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';
import { assertPortableValue, type PortableValue } from '@dbagent/shared';
import { SqliteAgentJournal } from '../events/sqlite-agent-journal.js';
import { replayAgentEvents } from '../events/event-projectors.js';
import type {
  AgentEvent,
  AgentEventDraft,
  AgentEventPayloadMap,
  LegacyImportedToolCall,
} from '../events/agent-event.js';
import {
  AuditProjectionAccumulator,
  SessionProjectionAccumulator,
  UserActivityProjectionAccumulator,
} from './session-projection.js';
import type { AgentMessage } from '../types.js';
import {
  createLegacyMigrationWriter,
  type LegacyMigrationWriter,
} from './legacy-migration-writer.js';
import {
  acquireExclusiveStateWriterGate,
  acquireMigrationOwnerGate,
} from './state-writer-gate.js';

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
  projectId: string;
  projectIds: string[];
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
  projectIds: string[];
  sourceDigest: string;
  importedStateDigest: string;
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
  project_ids_json: string;
  source_digest: string;
  imported_state_digest: string;
  target_schema_version: number;
  migrator_revision: string;
  validation_digest: string;
  status: 'validated_pending_activation' | 'active';
  validation_report_json: string;
  manifest_json: string;
};

type MaterializedLegacyArchive = MigrationManifestEntry & {
  objectRelativePath: string;
  archiveHandle: string;
};

export type ImportedLegacyState = {
  sessions: Array<{
    id: string;
    projectKey: string;
    projectRoot: string;
    title: string;
    userId: string | null;
    mode: string;
    messages: Array<AgentMessage & { messageIndex: number }>;
  }>;
  runs: Array<{
    runId: string;
    sessionId: string;
    status: string;
    plan: PortableValue | null;
    createdAt: string;
    updatedAt: string;
  }>;
  plan: PortableValue | null;
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

export type LegacyArchiveRef = {
  schemaVersion: 1;
  archiveHandle: string;
  relativePath: string;
  checksum: string;
  byteSize: number;
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
    const normalizedDir = resolve(requireText(projectDir, 'projectDir'));
    const targetSchemaVersion = options.targetSchemaVersion ?? 2;
    const migratorRevision = requireText(options.migratorRevision ?? 'task-4-r1', 'migratorRevision');
    if (!Number.isSafeInteger(targetSchemaVersion) || targetSchemaVersion < 2) {
      throw new StateMigrationError('INVALID_ARGUMENT', 'targetSchemaVersion must be at least 2.');
    }
    await mkdir(normalizedDir, { recursive: true });
    let lock;
    try {
      lock = acquireMigrationOwnerGate(normalizedDir);
    } catch (error) {
      if (isDatabaseLocked(error)) {
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
      lock.close();
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

  async readImportedLegacyState(): Promise<ImportedLegacyState> {
    const journal = new SqliteAgentJournal({ filePath: this.#intent.finalPath });
    const imported = emptyImportedLegacyState();
    for (const projectId of this.#intent.projectIds) {
      let cursor = 0;
      while (true) {
        const events = await journal.readProject(projectId, cursor, 1_000);
        if (events.length === 0) break;
        for (const event of events) {
          cursor = event.sequence;
          if (event.type === 'legacy.imported') applyLegacyImport(imported, event.payload);
        }
      }
    }
    imported.plan = imported.runs.find(({ plan }) => plan !== null)?.plan ?? null;
    return imported;
  }

  listLegacyArchives(): Promise<LegacyArchiveRef[]> {
    return Promise.resolve(withDatabase(this.#intent.finalPath, (database) => {
      const rows = database.prepare(`
        SELECT archive_handle, relative_path, checksum, byte_size
        FROM legacy_archives WHERE migration_id = ? ORDER BY relative_path
      `).all(this.#intent.migrationId) as unknown as Array<{
        archive_handle: string;
        relative_path: string;
        checksum: string;
        byte_size: number;
      }>;
      return rows.map((row) => ({
        schemaVersion: 1 as const,
        archiveHandle: row.archive_handle,
        relativePath: row.relative_path,
        checksum: row.checksum,
        byteSize: Number(row.byte_size),
      }));
    }));
  }

  async readLegacyArchive(ref: LegacyArchiveRef): Promise<Uint8Array> {
    assertLegacyArchiveRef(ref);
    const row = withDatabase(this.#intent.finalPath, (database) =>
      database.prepare(`
        SELECT relative_path, object_relative_path, archive_handle, checksum, byte_size
        FROM legacy_archives WHERE migration_id = ? AND archive_handle = ?
      `).get(this.#intent.migrationId, ref.archiveHandle) as {
        relative_path: string;
        object_relative_path: string;
        archive_handle: string;
        checksum: string;
        byte_size: number;
      } | undefined,
    );
    if (row === undefined || row.relative_path !== ref.relativePath ||
      row.checksum !== ref.checksum || Number(row.byte_size) !== ref.byteSize) {
      throw new StateMigrationError('MIGRATION_VALIDATION_FAILED', 'Legacy archive reference is invalid.');
    }
    const path = containedMigrationPath(this.#projectDir, row.object_relative_path);
    const bytes = await readFile(path);
    if (bytes.byteLength !== ref.byteSize || sha256Bytes(bytes) !== ref.checksum) {
      throw new StateMigrationError('MIGRATION_VALIDATION_FAILED', 'Legacy archive bytes failed verification.');
    }
    return new Uint8Array(bytes);
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
  let shadowCandidates = await listShadowCandidates(projectDir);
  if (shadowCandidates.length > 1) {
    throw new StateMigrationError(
      'MIGRATION_STATE_CONFLICT',
      'Multiple migration Shadow databases exist.',
    );
  }

  if (existingIntent === undefined && shadowCandidates.length === 1 &&
    isUnvalidatedPartialShadow(shadowCandidates[0]!)) {
    await rm(shadowCandidates[0]!, { force: true });
    await fsyncDirectory(projectDir);
    shadowCandidates = [];
  }

  if (existingIntent !== undefined) {
    assertIntentOptions(existingIntent, options);
    assertShadowSetConsistent(shadowCandidates, existingIntent);
    return await activate(projectDir, existingIntent, options.crashAt);
  }

  const currentRow = await readMigrationRowIfNew(finalPath);
  if (currentRow !== undefined) {
    const reconstructed = intentFromActiveRow(projectDir, currentRow);
    await validateShadow(reconstructed);
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
    await validateShadow(intent);
    await assertSourceDigestStillMatches(projectDir, intent);
    await writeIntent(projectDir, intent);
    crashIf(options.crashAt, 'after-intent-fsync', inspectionFromIntent(intent, intent.status));
    return await activate(projectDir, intent, options.crashAt);
  }

  let intent: MigrationIntent;
  try {
    intent = await buildValidatedShadow(projectDir, options);
  } catch (error) {
    for (const candidate of await listShadowCandidates(projectDir)) {
      if (isUnvalidatedPartialShadow(candidate)) await rm(candidate, { force: true });
    }
    await fsyncDirectory(projectDir);
    throw error;
  }
  await migrationBarrier(projectDir, 'after-shadow-validated');
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

  const importedState = readLegacyState(sourceSnapshotPath);
  bindFallbackProjectIdentity(importedState, sourceDigest);
  const validationReport = validateLegacyState(importedState, manifest);
  const importedStateDigest = sha256(canonicalJson(importedState));
  const validationDigest = sha256(canonicalJson(validationReport));
  const projectIds = [...new Set(importedState.sessions.map((session) =>
    legacyProjectId(session.projectKey, session.projectRoot),
  ))].sort();
  if (projectIds.length === 0) {
    projectIds.push(legacyProjectId(
      `legacy-source:${sourceDigest}`, `legacy-source://${sourceDigest}`,
    ));
  }
  const archives = await materializeLegacyArchives(projectDir, manifest);
  const journal = new SqliteAgentJournal({
    filePath: shadowPath,
    now: () => new Date(0).toISOString(),
    createId: deterministicIdGenerator(migrationId),
  });
  await journal.countEvents();
  withDatabase(shadowPath, (database) => {
    database.exec(`
      CREATE TABLE legacy_migration_build_context (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        migration_id TEXT NOT NULL,
        source_digest TEXT NOT NULL,
        sealed INTEGER NOT NULL DEFAULT 0 CHECK (sealed IN (0, 1))
      )
    `);
    database.prepare(`
      INSERT INTO legacy_migration_build_context (id, migration_id, source_digest)
      VALUES (1, ?, ?)
    `).run(migrationId, sourceDigest);
  });
  const migrationWriter = createLegacyMigrationWriter(journal, { migrationId, sourceDigest });
  try {
    await importLegacyFacts(journal, migrationWriter, {
      migrationId, sourceDigest, importedState, archives, projectIds,
    });
  } finally {
    migrationWriter.seal();
  }
  const eventCount = await journal.countEvents();
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
        project_ids_json TEXT NOT NULL,
        source_digest TEXT NOT NULL,
        imported_state_digest TEXT NOT NULL,
        target_schema_version INTEGER NOT NULL,
        migrator_revision TEXT NOT NULL,
        validation_digest TEXT NOT NULL,
        status TEXT NOT NULL,
        validation_report_json TEXT NOT NULL,
        manifest_json TEXT NOT NULL
      );
      CREATE TABLE legacy_imports (
        migration_id TEXT PRIMARY KEY,
        project_ids_json TEXT NOT NULL,
        event_count INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE legacy_archives (
        migration_id TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        object_relative_path TEXT NOT NULL,
        archive_handle TEXT NOT NULL,
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
        INSERT INTO legacy_imports (migration_id, project_ids_json, event_count, created_at)
        VALUES (?, ?, ?, ?)
      `).run(migrationId, canonicalJson(projectIds), eventCount, new Date(0).toISOString());
      const insertArchive = shadow.prepare(`
        INSERT INTO legacy_archives (
          migration_id, relative_path, object_relative_path, archive_handle, checksum, byte_size
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const entry of archives) {
        insertArchive.run(
          migrationId, entry.relativePath, entry.objectRelativePath, entry.archiveHandle,
          entry.checksum, entry.byteSize,
        );
      }
      shadow.prepare(`
        INSERT INTO schema_migrations (
          migration_id, project_ids_json, source_digest, imported_state_digest,
          target_schema_version, migrator_revision,
          validation_digest, status, validation_report_json, manifest_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'validated_pending_activation', ?, ?)
      `).run(
        migrationId,
        canonicalJson(projectIds),
        sourceDigest,
        importedStateDigest,
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
  const intent: MigrationIntent = {
    schemaVersion: 1,
    migrationId,
    projectIds,
    sourceDigest,
    importedStateDigest,
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
  await validateShadow(intent);
  return intent;
}

async function activate(
  projectDir: string,
  intent: MigrationIntent,
  crashAt: MigrationCrashPoint | undefined,
): Promise<StateMigrationRunner> {
  const writerGate = acquireExclusiveStateWriterGate(projectDir);
  try {
    await validateShadow(intent);
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
        await assertLiveLegacyStillMatches(projectDir, intent);
        await sealMigrationBuildContext(intent.shadowPath, intent);
        await migrationBarrier(projectDir, 'after-live-recheck');
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
  } finally {
    writerGate.close();
  }
}

function readLegacyState(path: string): ImportedLegacyState {
  return withDatabase(path, (database) => {
    try {
      const sessionRows = tableExists(database, 'agent_sessions')
        ? (database.prepare(
          'SELECT id, title, user_id, mode, payload_json FROM agent_sessions ORDER BY id',
        ).all() as unknown as Array<{
          id: string; title: string; user_id: string | null; mode: string; payload_json: string;
        }>)
        : [];
      const messages = tableExists(database, 'agent_session_messages')
        ? (database.prepare(`
          SELECT session_id, message_index, role, content, created_at,
                 tool_call_id, tool_name, tool_calls_json
          FROM agent_session_messages
          ORDER BY session_id, message_index
        `).all() as unknown as Array<{
          session_id: string; message_index: number; role: string; content: string; created_at: string;
          tool_call_id: string | null; tool_name: string | null; tool_calls_json: string | null;
        }>)
        : [];
      const sessions = sessionRows.map((session) => ({
        id: session.id,
        projectKey: legacyProjectIdentity(session.payload_json).projectKey,
        projectRoot: legacyProjectIdentity(session.payload_json).projectRoot,
        title: session.title,
        userId: session.user_id,
        mode: session.mode,
        messages: messages
          .filter(({ session_id: sessionId }) => sessionId === session.id)
          .map(legacyMessageFromRow),
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

async function validateShadow(intent: MigrationIntent): Promise<void> {
  const path = await pathExists(intent.shadowPath) ? intent.shadowPath : intent.finalPath;
  const row = readValidatedMigrationRow(path);
  if (
    row.migration_id !== intent.migrationId ||
    row.source_digest !== intent.sourceDigest ||
    row.validation_digest !== intent.validationDigest ||
    row.imported_state_digest !== intent.importedStateDigest ||
    row.target_schema_version !== intent.targetSchemaVersion ||
    row.migrator_revision !== intent.migratorRevision ||
    row.project_ids_json !== canonicalJson(intent.projectIds) ||
    row.manifest_json !== canonicalJson(intent.manifest)
  ) {
    throw new StateMigrationError(
      'MIGRATION_STATE_CONFLICT',
      'Shadow metadata conflicts with activation intent.',
      inspectionFromIntent(intent, intent.status),
    );
  }
  try {
    const databaseValidation = withDatabase(path, (database) => {
      const integrity = database.prepare('PRAGMA integrity_check').get() as {
        integrity_check: string;
      };
      if (integrity.integrity_check !== 'ok') throw new Error('SQLite integrity_check failed.');
      const columns = database.prepare('PRAGMA table_info(agent_events)').all() as unknown as Array<{
        name: string;
      }>;
      const requiredColumns = [
        'project_id', 'sequence', 'event_id', 'schema_version', 'session_id', 'run_id',
        'turn_id', 'parent_event_id', 'invocation_id', 'attempt_id', 'event_type',
        'occurred_at', 'payload_json', 'audience_json', 'persistence',
      ];
      if (requiredColumns.some((name) => !columns.some((column) => column.name === name))) {
        throw new Error('Journal event schema is incomplete.');
      }
      const imported = database.prepare(`
        SELECT event_count FROM legacy_imports WHERE migration_id = ?
      `).get(intent.migrationId) as { event_count: number } | undefined;
      if (imported === undefined) throw new Error('Legacy import count is missing.');
      const eventCount = Number((database.prepare(
        'SELECT COUNT(*) AS count FROM agent_events',
      ).get() as { count: number }).count);
      if (eventCount !== Number(imported.event_count)) throw new Error('Legacy import event count changed.');
      const context = database.prepare(`
        SELECT migration_id, source_digest, sealed
        FROM legacy_migration_build_context WHERE id = 1
      `).get() as { migration_id: string; source_digest: string; sealed: number } | undefined;
      if (context === undefined || context.migration_id !== intent.migrationId ||
        context.source_digest !== intent.sourceDigest || ![0, 1].includes(Number(context.sealed))) {
        throw new Error('Legacy migration build context is invalid.');
      }
      const carriers = database.prepare(`
        SELECT state, hidden FROM agent_runs WHERE client_request_id LIKE 'legacy-import:%'
      `).all() as unknown as Array<{ state: string; hidden: number }>;
      if (carriers.length === 0 || carriers.some(({ state, hidden }) =>
        !['Completed', 'Failed', 'Cancelled'].includes(state) || Number(hidden) !== 1)) {
        throw new Error('Synthetic legacy carrier Runs are not terminal and hidden.');
      }
      return { eventCount };
    });

    const journal = new SqliteAgentJournal({ filePath: path });
    const reconstructed = emptyImportedLegacyState();
    for (const projectId of intent.projectIds) {
      const events = await readAllProjectEvents(journal, projectId);
      for (const event of events) {
        if (event.type === 'legacy.imported') applyLegacyImport(reconstructed, event.payload);
      }
      replayAgentEvents(events);
      const sessionIds = new Set(events.map(({ sessionId }) => sessionId));
      for (const sessionId of sessionIds) {
        const accumulators = [
          new SessionProjectionAccumulator({ projectId, sessionId, afterSequence: 0, limit: 1_000 }, true),
          new UserActivityProjectionAccumulator({ projectId, sessionId, afterSequence: 0, limit: 1_000 }, true),
          new AuditProjectionAccumulator({ projectId, sessionId, afterSequence: 0, limit: 1_000 }, true),
        ];
        for (const accumulator of accumulators) {
          for (const event of events) if (!accumulator.accept(event)) break;
          accumulator.finish();
        }
      }
    }
    normalizeImportedLegacyState(reconstructed);
    reconstructed.plan = reconstructed.runs.find(({ plan }) => plan !== null)?.plan ?? null;
    if (sha256(canonicalJson(reconstructed)) !== intent.importedStateDigest) {
      throw new Error('Imported legacy state digest changed.');
    }
    const validationReport = validateLegacyState(reconstructed, intent.manifest);
    if (sha256(canonicalJson(validationReport)) !== intent.validationDigest ||
      sha256(canonicalJson(JSON.parse(row.validation_report_json) as unknown)) !== intent.validationDigest) {
      throw new Error('Migration validation report digest changed.');
    }
    await validateLegacyArchives(dirname(intent.finalPath), path, intent);
    if (databaseValidation.eventCount !== await journal.countEvents()) {
      throw new Error('Journal event count is not stable after projection validation.');
    }
  } catch (error) {
    if (error instanceof StateMigrationError) throw error;
    throw new StateMigrationError(
      'MIGRATION_VALIDATION_FAILED',
      `Validated Shadow failed semantic revalidation: ${errorMessage(error)}`,
      inspectionFromIntent(intent, intent.status),
    );
  }
}

async function readAllProjectEvents(
  journal: SqliteAgentJournal,
  projectId: string,
): Promise<AgentEvent[]> {
  const result: AgentEvent[] = [];
  let cursor = 0;
  while (true) {
    const page = await journal.readProject(projectId, cursor, 1_000);
    if (page.length === 0) return result;
    result.push(...page);
    cursor = page.at(-1)!.sequence;
  }
}

function normalizeImportedLegacyState(state: ImportedLegacyState): void {
  state.sessions.sort((left, right) => left.id.localeCompare(right.id, 'en'));
  for (const session of state.sessions) {
    session.messages.sort((left, right) => left.messageIndex - right.messageIndex);
  }
  state.runs.sort((left, right) => left.runId.localeCompare(right.runId, 'en'));
  state.preferences.sort((left, right) => left.id.localeCompare(right.id, 'en'));
  state.checkpoints.sort((left, right) =>
    left.sessionId.localeCompare(right.sessionId, 'en') || left.sequence - right.sequence);
  state.subagents.sort((left, right) => left.id.localeCompare(right.id, 'en'));
}

async function validateLegacyArchives(
  projectDir: string,
  databasePath: string,
  intent: MigrationIntent,
): Promise<void> {
  const rows = withDatabase(databasePath, (database) => database.prepare(`
    SELECT relative_path, object_relative_path, archive_handle, checksum, byte_size
    FROM legacy_archives WHERE migration_id = ? ORDER BY relative_path
  `).all(intent.migrationId) as unknown as Array<{
    relative_path: string;
    object_relative_path: string;
    archive_handle: string;
    checksum: string;
    byte_size: number;
  }>);
  const expected = intent.manifest.filter(({ relativePath }) => relativePath !== 'state.source.db');
  if (rows.length !== expected.length) throw new Error('Legacy archive count changed.');
  for (const [index, entry] of expected.entries()) {
    const row = rows[index]!;
    if (row.relative_path !== entry.relativePath || row.checksum !== entry.checksum ||
      Number(row.byte_size) !== entry.byteSize || row.archive_handle !== `legacy-archive:${entry.checksum}`) {
      throw new Error('Legacy archive metadata changed.');
    }
    const bytes = await readFile(containedMigrationPath(projectDir, row.object_relative_path));
    if (bytes.byteLength !== entry.byteSize || sha256Bytes(bytes) !== entry.checksum) {
      throw new Error(`Legacy archive bytes changed: ${entry.relativePath}`);
    }
  }
}

async function sealMigrationBuildContext(path: string, intent: MigrationIntent): Promise<void> {
  if (!(await pathExists(path))) return;
  withDatabase(path, (database) => {
    const result = database.prepare(`
      UPDATE legacy_migration_build_context SET sealed = 1
      WHERE id = 1 AND migration_id = ? AND source_digest = ? AND sealed IN (0, 1)
    `).run(intent.migrationId, intent.sourceDigest);
    if (Number(result.changes) !== 1) throw new Error('Migration build context cannot be sealed.');
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  });
  await fsyncFile(path);
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
  if (!isSha256(row.migration_id) || !isSha256(row.source_digest) ||
    !isSha256(row.imported_state_digest) || !isSha256(row.validation_digest)) {
    throw new StateMigrationError('MIGRATION_STATE_CONFLICT', 'Migration row identity is invalid.');
  }
  const projectIdsValue = JSON.parse(row.project_ids_json) as unknown;
  if (!Array.isArray(projectIdsValue) || projectIdsValue.length === 0 ||
    projectIdsValue.some((projectId) => !isLegacyProjectId(projectId))) {
    throw new StateMigrationError('MIGRATION_STATE_CONFLICT', 'Migration Project map is invalid.');
  }
  const projectIds = projectIdsValue.map((projectId) => String(projectId));
  const manifest = JSON.parse(row.manifest_json) as unknown;
  if (!isMigrationManifest(manifest)) {
    throw new StateMigrationError('MIGRATION_STATE_CONFLICT', 'Migration manifest is invalid.');
  }
  const paths = migrationPaths(projectDir, row.migration_id);
  return {
    schemaVersion: 1,
    migrationId: row.migration_id,
    projectIds,
    sourceDigest: row.source_digest,
    importedStateDigest: row.imported_state_digest,
    targetSchemaVersion: row.target_schema_version,
    migratorRevision: row.migrator_revision,
    ...paths,
    shadowPath,
    validationDigest: row.validation_digest,
    status: 'validated_pending_activation',
    manifest,
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
      Record<string, unknown>;
    const allowed = [
      'schemaVersion', 'migrationId', 'projectIds', 'sourceDigest', 'importedStateDigest',
      'targetSchemaVersion', 'migratorRevision', 'validationDigest', 'status', 'manifest',
    ];
    if (Object.keys(value).some((key) => !allowed.includes(key)) || value.schemaVersion !== 1 ||
      !isSha256(value.migrationId) || !isSha256(value.sourceDigest) ||
      !isSha256(value.importedStateDigest) || !isSha256(value.validationDigest) ||
      !Array.isArray(value.projectIds) || value.projectIds.length === 0 ||
      value.projectIds.some((id) => !isLegacyProjectId(id)) ||
      !Number.isSafeInteger(value.targetSchemaVersion) || Number(value.targetSchemaVersion) < 2 ||
      typeof value.migratorRevision !== 'string' || value.migratorRevision.length === 0 ||
      !['validated_pending_activation', 'completed'].includes(String(value.status)) ||
      !isMigrationManifest(value.manifest)) {
      throw new Error('Intent shape is invalid.');
    }
    const paths = migrationPaths(projectDir, value.migrationId);
    return {
      ...value,
      ...paths,
    } as MigrationIntent;
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
    await file.writeFile(`${canonicalJson({
      schemaVersion: intent.schemaVersion,
      migrationId: intent.migrationId,
      projectIds: intent.projectIds,
      sourceDigest: intent.sourceDigest,
      importedStateDigest: intent.importedStateDigest,
      targetSchemaVersion: intent.targetSchemaVersion,
      migratorRevision: intent.migratorRevision,
      validationDigest: intent.validationDigest,
      status: intent.status,
      manifest: intent.manifest,
    })}\n`, 'utf8');
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

function isUnvalidatedPartialShadow(path: string): boolean {
  try {
    return withDatabase(path, (database) => {
      if (!tableExists(database, 'schema_migrations')) return true;
      return database.prepare('SELECT 1 FROM schema_migrations LIMIT 1').get() === undefined;
    });
  } catch {
    return false;
  }
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
    projectId: intent.projectIds[0] ?? `legacy_${intent.sourceDigest.slice(0, 32)}`,
    projectIds: [...intent.projectIds],
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
    if (process.env.DBAGENT_MIGRATION_HARD_CRASH === actual) {
      process.kill(process.pid, 'SIGKILL');
    }
    throw new StateMigrationError(
      'INJECTED_CRASH',
      `Injected migration crash at ${actual}.`,
      inspection,
      actual,
    );
  }
}

async function migrationBarrier(projectDir: string, point: string): Promise<void> {
  if (process.env.DBAGENT_MIGRATION_BARRIER_POINT !== point) return;
  const ready = join(projectDir, 'migration-barrier-ready');
  const release = join(projectDir, 'migration-barrier-release');
  await writeFile(ready, point);
  while (!(await pathExists(release))) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
}

function migrationPaths(projectDir: string, migrationId: string) {
  if (!isSha256(migrationId)) throw new Error('Migration id must be strict lowercase SHA-256.');
  const root = resolve(projectDir);
  const contained = (name: string): string => {
    const path = resolve(root, name);
    if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error('Migration path escaped Project.');
    return path;
  };
  return {
    sourcePath: contained('state.db'),
    sourceSnapshotPath: contained(`state.source.${migrationId}.db`),
    sourceBackupPath: contained(`state.legacy.${migrationId}.db`),
    shadowPath: contained(`state.v2.${migrationId}.db.tmp`),
    finalPath: contained('state.db'),
  };
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function isLegacyProjectId(value: unknown): value is string {
  return typeof value === 'string' && /^legacy_project_[a-f0-9]{40}$/u.test(value);
}

function isMigrationManifest(value: unknown): value is MigrationManifestEntry[] {
  return Array.isArray(value) && value.length >= 1 && value.every((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const record = entry as Record<string, unknown>;
    return Object.keys(record).every((key) => ['relativePath', 'checksum', 'byteSize'].includes(key)) &&
      typeof record.relativePath === 'string' && record.relativePath.length > 0 &&
      !record.relativePath.startsWith('/') && !record.relativePath.split('/').includes('..') &&
      isSha256(record.checksum) && Number.isSafeInteger(record.byteSize) && Number(record.byteSize) >= 0;
  });
}

function legacyProjectIdentity(payloadJson: string): { projectKey: string; projectRoot: string } {
  const fallback = { projectKey: 'legacy-default', projectRoot: 'legacy://default' };
  try {
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    const projectKey = payload.projectKey ?? payload.project_key;
    const projectRoot = payload.projectRoot ?? payload.project_root;
    return typeof projectKey === 'string' && projectKey.length > 0 &&
      typeof projectRoot === 'string' && projectRoot.length > 0
      ? { projectKey, projectRoot }
      : fallback;
  } catch {
    return fallback;
  }
}

function bindFallbackProjectIdentity(state: ImportedLegacyState, sourceDigest: string): void {
  for (const session of state.sessions) {
    if (session.projectKey === 'legacy-default' && session.projectRoot === 'legacy://default') {
      session.projectKey = `legacy-source:${sourceDigest}`;
      session.projectRoot = `legacy-source://${sourceDigest}`;
    }
  }
}

function legacyProjectId(projectKey: string, projectRoot: string): string {
  return `legacy_project_${sha256(`${projectKey}\0${projectRoot}`).slice(0, 40)}`;
}

function deterministicIdGenerator(migrationId: string): () => string {
  let ordinal = 0;
  return () => sha256(`${migrationId}\0${ordinal++}`);
}

async function materializeLegacyArchives(
  projectDir: string,
  manifest: readonly MigrationManifestEntry[],
): Promise<MaterializedLegacyArchive[]> {
  const root = resolve(projectDir);
  const result: MaterializedLegacyArchive[] = [];
  for (const entry of manifest.filter(({ relativePath }) => relativePath !== 'state.source.db')) {
    const source = resolve(root, ...entry.relativePath.split('/'));
    if (!source.startsWith(`${root}${sep}`)) {
      throw new StateMigrationError('MIGRATION_STATE_CONFLICT', 'Legacy archive source escaped Project.');
    }
    const objectRelativePath = normalizeRelative(join(
      'legacy-archives', 'objects', entry.checksum.slice(0, 2), entry.checksum.slice(2),
    ));
    const objectPath = resolve(root, ...objectRelativePath.split('/'));
    await mkdir(resolve(objectPath, '..'), { recursive: true });
    if (!(await pathExists(objectPath))) await copyFile(source, objectPath);
    if (await hashFile(objectPath) !== entry.checksum) {
      throw new StateMigrationError('MIGRATION_VALIDATION_FAILED', 'Archived legacy bytes failed checksum.');
    }
    await fsyncFile(objectPath);
    result.push({
      ...entry,
      objectRelativePath,
      archiveHandle: `legacy-archive:${entry.checksum}`,
    });
  }
  await fsyncDirectory(projectDir);
  return result;
}

async function importLegacyFacts(
  journal: SqliteAgentJournal,
  writer: LegacyMigrationWriter,
  input: {
    migrationId: string;
    sourceDigest: string;
    importedState: ImportedLegacyState;
    archives: MaterializedLegacyArchive[];
    projectIds: string[];
  },
): Promise<void> {
  const sessions = input.importedState.sessions.length > 0
    ? input.importedState.sessions
    : [{
        id: `legacy-session-${input.migrationId.slice(0, 16)}`,
        projectKey: `legacy-source:${input.sourceDigest}`,
        projectRoot: `legacy-source://${input.sourceDigest}`,
        title: 'Legacy import',
        userId: null, mode: 'general', messages: [],
      }];
  const factsBySession = new Map<string, AgentEventPayloadMap['legacy.imported'][]>(
    sessions.map((session) => [session.id, []]),
  );
  for (const session of sessions) {
    const facts = factsBySession.get(session.id)!;
    facts.push({
      entityType: 'session', legacyId: session.id, projectKey: session.projectKey,
      projectRoot: session.projectRoot, title: session.title, userId: session.userId,
      mode: session.mode,
    });
    session.messages.forEach((message) => facts.push(legacyMessageFact(session.id, message)));
  }
  const firstSessionId = sessions[0]!.id;
  const target = (sessionId: string | null | undefined) =>
    factsBySession.get(sessionId ?? '') ?? factsBySession.get(firstSessionId)!;
  for (const run of input.importedState.runs) target(run.sessionId).push({
    entityType: 'run', legacyId: run.runId, sessionId: run.sessionId, status: run.status,
    plan: run.plan,
    createdAt: run.createdAt, updatedAt: run.updatedAt,
  } as AgentEventPayloadMap['legacy.imported']);
  for (const preference of input.importedState.preferences) target(preference.sourceSessionId).push({
    entityType: 'preference', legacyId: preference.id, userId: preference.userId,
    key: preference.key, value: preference.value, confidence: preference.confidence,
    sourceSessionId: preference.sourceSessionId,
  });
  for (const checkpoint of input.importedState.checkpoints) target(checkpoint.sessionId).push({
    entityType: 'checkpoint', legacyId: `${checkpoint.sessionId}:${checkpoint.sequence}`,
    sessionId: checkpoint.sessionId, sequence: checkpoint.sequence, summary: checkpoint.summary,
    createdAt: checkpoint.createdAt,
  });
  for (const subagent of input.importedState.subagents) target(subagent.parentSessionId).push({
    entityType: 'subagent', legacyId: subagent.id, parentSessionId: subagent.parentSessionId,
    childSessionId: subagent.childSessionId, status: subagent.status, depth: subagent.depth,
  });
  for (const [index, diagnostic] of input.importedState.diagnostics.entries()) {
    target(firstSessionId).push({
      entityType: 'diagnostic', legacyId: `diagnostic:${index}:${diagnostic.code}`,
      code: diagnostic.code, evidence: diagnostic.evidence,
    });
  }
  for (const archive of input.archives) target(firstSessionId).push({
    entityType: 'archive', legacyId: archive.relativePath, relativePath: archive.relativePath,
    archiveHandle: archive.archiveHandle, checksum: archive.checksum, byteSize: archive.byteSize,
  });

  for (const session of sessions) {
    const projectId = legacyProjectId(session.projectKey, session.projectRoot);
    const clientRequestId = `legacy-import:${input.migrationId}:${sha256(session.id).slice(0, 24)}`;
    const created = await journal.createRun({
      projectId, sessionId: session.id, clientRequestId,
      input: { legacyMigrationId: input.migrationId },
    });
    const lease = await journal.acquireRunLease({
      projectId, runId: created.runId,
      ownerId: `legacy-migration:${input.migrationId.slice(0, 24)}`, ttlMs: 60_000,
    });
    withDatabase(journal.filePath, (database) => {
      database.prepare('UPDATE agent_runs SET hidden = 1 WHERE run_id = ?').run(created.runId);
    });
    const facts = factsBySession.get(session.id)!;
    for (let offset = 0; offset < facts.length; offset += 500) {
      const projection = await journal.getRunProjection(created.runId);
      if (projection === null) throw new Error('Synthetic legacy Run projection is missing.');
      const events: AgentEventDraft[] = facts.slice(offset, offset + 500).map((payload) => ({
        type: 'legacy.imported', payload,
      }));
      await writer.commit({
          projectId, sessionId: session.id, runId: created.runId,
          commandId: `legacy-import:${input.migrationId}:${sha256(session.id).slice(0, 16)}:${offset}`,
          lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken },
          expectedRunRevision: projection.revision,
          events,
      });
    }
    const projection = await journal.getRunProjection(created.runId);
    if (projection === null) throw new Error('Synthetic legacy Run projection is missing.');
    await writer.commit({
      projectId,
      sessionId: session.id,
      runId: created.runId,
      commandId: `legacy-import:${input.migrationId}:${sha256(session.id).slice(0, 16)}:terminal`,
      lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken },
      expectedRunRevision: projection.revision,
      events: [{ type: 'run.cancelled', payload: { reason: 'legacy-import-carrier-hidden' } }],
    });
  }
  if (new Set(sessions.map((session) => legacyProjectId(session.projectKey, session.projectRoot))).size !==
    input.projectIds.length) {
    throw new StateMigrationError('MIGRATION_VALIDATION_FAILED', 'Legacy Project isolation map changed.');
  }
}

function legacyMessageFromRow(message: {
  message_index: number;
  role: string;
  content: string;
  created_at: string;
  tool_call_id: string | null;
  tool_name: string | null;
  tool_calls_json: string | null;
}): AgentMessage & { messageIndex: number } {
  const base = {
    messageIndex: message.message_index,
    content: message.content,
    createdAt: message.created_at,
  };
  if (message.role === 'user' || message.role === 'system') {
    if (message.tool_call_id !== null || message.tool_name !== null || message.tool_calls_json !== null) {
      throw new StateMigrationError(
        'MIGRATION_VALIDATION_FAILED',
        `Legacy ${message.role} message contains Tool-only fields.`,
      );
    }
    return { ...base, role: message.role };
  }
  if (message.role === 'assistant') {
    if (message.tool_call_id !== null || message.tool_name !== null) {
      throw new StateMigrationError(
        'MIGRATION_VALIDATION_FAILED',
        'Legacy assistant message contains Tool-result identity fields.',
      );
    }
    if (message.tool_calls_json === null) return { ...base, role: 'assistant' };
    const toolCalls = parseLegacyToolCalls(message.tool_calls_json);
    return { ...base, role: 'assistant', toolCalls };
  }
  if (message.role === 'tool') {
    if (message.tool_call_id === null || message.tool_name === null || message.tool_calls_json !== null) {
      throw new StateMigrationError(
        'MIGRATION_VALIDATION_FAILED',
        'Legacy Tool message does not have an exact Tool-result identity.',
      );
    }
    return {
      ...base,
      role: 'tool',
      toolCallId: message.tool_call_id,
      toolName: message.tool_name,
    };
  }
  throw new StateMigrationError(
    'MIGRATION_VALIDATION_FAILED',
    `Unsupported legacy message role: ${message.role}`,
  );
}

function parseLegacyToolCalls(value: string): NonNullable<Extract<
  AgentMessage,
  { role: 'assistant' }
>['toolCalls']> {
  const parsed = JSON.parse(value) as unknown;
  try {
    assertPortableValue(parsed);
  } catch (error) {
    throw new StateMigrationError(
      'MIGRATION_VALIDATION_FAILED',
      `Legacy assistant toolCalls are not portable: ${errorMessage(error)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new StateMigrationError('MIGRATION_VALIDATION_FAILED', 'Legacy assistant toolCalls must be an array.');
  }
  return parsed.map((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new StateMigrationError('MIGRATION_VALIDATION_FAILED', 'Legacy Tool call must be an object.');
    }
    const record = item as Record<string, PortableValue>;
    if (Object.keys(record).sort().join(',') !== 'arguments,id,name' ||
      typeof record.id !== 'string' || !record.id ||
      typeof record.name !== 'string' || !record.name ||
      record.arguments === null || typeof record.arguments !== 'object' ||
      Array.isArray(record.arguments)) {
      throw new StateMigrationError('MIGRATION_VALIDATION_FAILED', 'Legacy Tool call schema is invalid.');
    }
    return {
      id: record.id,
      name: record.name,
      arguments: structuredClone(record.arguments),
    };
  });
}

function legacyMessageFact(
  sessionId: string,
  message: AgentMessage & { messageIndex: number },
): AgentEventPayloadMap['legacy.imported'] {
  const base = {
    entityType: 'message' as const,
    legacyId: `${sessionId}:${message.messageIndex}`,
    messageIndex: message.messageIndex,
    content: message.content,
    createdAt: message.createdAt,
  };
  if (message.role === 'assistant') {
    return {
      ...base,
      role: message.role,
      ...(message.toolCalls === undefined ? {} : { toolCalls: portableLegacyToolCalls(message.toolCalls) }),
    };
  }
  if (message.role === 'tool') {
    return {
      ...base,
      role: message.role,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
    };
  }
  return { ...base, role: message.role };
}

function portableLegacyToolCalls(
  toolCalls: NonNullable<Extract<AgentMessage, { role: 'assistant' }>['toolCalls']>,
): LegacyImportedToolCall[] {
  try {
    assertPortableValue(toolCalls);
  } catch (error) {
    throw new StateMigrationError(
      'MIGRATION_VALIDATION_FAILED',
      `Legacy assistant toolCalls are not portable: ${errorMessage(error)}`,
    );
  }
  return structuredClone(toolCalls) as LegacyImportedToolCall[];
}

function legacyMessageFromFact(
  payload: Extract<AgentEventPayloadMap['legacy.imported'], { entityType: 'message' }>,
): AgentMessage & { messageIndex: number } {
  const base = {
    messageIndex: payload.messageIndex,
    content: payload.content,
    createdAt: payload.createdAt,
  };
  if (payload.role === 'assistant') {
    return {
      ...base,
      role: payload.role,
      ...(payload.toolCalls === undefined ? {} : { toolCalls: payload.toolCalls }),
    };
  }
  if (payload.role === 'tool') {
    return {
      ...base,
      role: payload.role,
      toolCallId: payload.toolCallId,
      toolName: payload.toolName,
    };
  }
  return { ...base, role: payload.role };
}

function emptyImportedLegacyState(): ImportedLegacyState {
  return {
    sessions: [], runs: [], plan: null, preferences: [], checkpoints: [], subagents: [], diagnostics: [],
  };
}

function applyLegacyImport(
  state: ImportedLegacyState,
  payload: AgentEventPayloadMap['legacy.imported'],
): void {
  switch (payload.entityType) {
    case 'session':
      state.sessions.push({
        id: payload.legacyId, projectKey: payload.projectKey, projectRoot: payload.projectRoot,
        title: payload.title, userId: payload.userId, mode: payload.mode, messages: [],
      });
      return;
    case 'message': {
      const sessionId = payload.legacyId.slice(0, payload.legacyId.lastIndexOf(':'));
      state.sessions.find(({ id }) => id === sessionId)?.messages.push(legacyMessageFromFact(payload));
      return;
    }
    case 'run':
      state.runs.push({
        runId: payload.legacyId, sessionId: payload.sessionId, status: payload.status,
        plan: payload.plan, createdAt: payload.createdAt, updatedAt: payload.updatedAt,
      });
      return;
    case 'preference':
      state.preferences.push({
        id: payload.legacyId, userId: payload.userId, key: payload.key, value: payload.value,
        confidence: payload.confidence, sourceSessionId: payload.sourceSessionId,
      });
      return;
    case 'checkpoint':
      state.checkpoints.push({
        sessionId: payload.sessionId, sequence: payload.sequence, summary: payload.summary,
        createdAt: payload.createdAt,
      });
      return;
    case 'subagent':
      state.subagents.push({
        id: payload.legacyId, parentSessionId: payload.parentSessionId,
        childSessionId: payload.childSessionId, status: payload.status, depth: payload.depth,
      });
      return;
    case 'diagnostic':
      state.diagnostics.push({ code: payload.code, evidence: payload.evidence });
      return;
    case 'archive':
      return;
  }
}

async function assertLiveLegacyStillMatches(
  projectDir: string,
  intent: MigrationIntent,
): Promise<void> {
  if (!(await pathExists(intent.sourcePath))) return;
  const liveState = readLegacyState(intent.sourcePath);
  bindFallbackProjectIdentity(liveState, intent.sourceDigest);
  const currentManifest = await createSourceManifest(projectDir, intent.sourceSnapshotPath);
  const expectedSides = intent.manifest.filter(({ relativePath }) => relativePath !== 'state.source.db');
  const currentSides = currentManifest.filter(({ relativePath }) => relativePath !== 'state.source.db');
  if (sha256(canonicalJson(liveState)) !== intent.importedStateDigest ||
    canonicalJson(currentSides) !== canonicalJson(expectedSides)) {
    throw new StateMigrationError(
      'MIGRATION_STATE_CONFLICT',
      'Live legacy state changed after Shadow validation.',
      inspectionFromIntent(intent, intent.status),
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

function parseNullableJson(value: string | null): PortableValue | null {
  return value === null ? null : JSON.parse(value) as PortableValue;
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

function assertLegacyArchiveRef(ref: LegacyArchiveRef): void {
  if (ref === null || typeof ref !== 'object' || Array.isArray(ref) ||
    ref.schemaVersion !== 1 || !ref.archiveHandle.startsWith('legacy-archive:') ||
    !ref.relativePath || !isSha256(ref.checksum) ||
    !Number.isSafeInteger(ref.byteSize) || ref.byteSize < 0) {
    throw new StateMigrationError('INVALID_ARGUMENT', 'Legacy archive reference is invalid.');
  }
}

function containedMigrationPath(projectDir: string, relativePath: string): string {
  if (!relativePath || relativePath.startsWith('/') || relativePath.split(/[\\/]/u).includes('..')) {
    throw new StateMigrationError('MIGRATION_VALIDATION_FAILED', 'Legacy archive path is invalid.');
  }
  const root = resolve(projectDir);
  const path = resolve(root, ...relativePath.split('/'));
  if (!path.startsWith(`${root}${sep}`)) {
    throw new StateMigrationError('MIGRATION_VALIDATION_FAILED', 'Legacy archive path escaped Project.');
  }
  return path;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sha256Bytes(value: Uint8Array): string {
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

function isDatabaseLocked(error: unknown): boolean {
  return /database is locked|SQLITE_BUSY/iu.test(errorMessage(error));
}
