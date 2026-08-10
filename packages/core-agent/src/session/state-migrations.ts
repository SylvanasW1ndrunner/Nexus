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
  type FileHandle,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';
import { assertPortableValue, type PortableValue } from '@dbagent/shared';
import { SqliteAgentJournal } from '../events/sqlite-agent-journal.js';
import type {
  AgentEvent,
  AgentEventDraft,
  AgentEventPayloadMap,
} from '../events/agent-event.js';
import {
  AuditProjectionAccumulator,
  ProjectionEventValidator,
  SessionProjectionAccumulator,
  UserActivityProjectionAccumulator,
} from './session-projection.js';
import type {
  AgentContextCheckpoint,
  AgentMessage,
  AgentRunRecord,
  AgentSession,
  AgentSubagentRecord,
  AgentUserPreference,
} from '../types.js';
import {
  createLegacyMigrationWriter,
  type LegacyMigrationWriter,
} from '../internal/legacy-migration-writer.js';
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
    messages: Array<AgentMessage & { messageIndex: number; sourceRunId?: string }>;
    record?: AgentSession;
    archived?: boolean;
    createdAt?: string;
    updatedAt?: string;
    lastMessageAt?: string | null;
  }>;
  runs: Array<AgentRunRecord | {
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
    evidence?: string;
    createdAt?: string;
    updatedAt?: string;
  }>;
  checkpoints: Array<{
    sessionId: string;
    sequence: number;
    summary: string;
    createdAt: string;
    record?: AgentContextCheckpoint;
  }>;
  subagents: Array<AgentSubagentRecord | {
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

export type MigrationValidationDiagnostics = {
  projectPasses: number;
  maxPageSize: number;
  importBatches: number;
  carrierLeaseRenewals: number;
  maxImportBatchSize: number;
  maxActiveProjectionSessions: number;
  maxActiveProjectionAccumulators: number;
};

const STATE_MIGRATION_CONSTRUCTION_TOKEN = Symbol('state-migration-construction');
const STATE_MIGRATION_HANDLE_BRAND: unique symbol = Symbol('state-migration-handle');

class StateMigrationHandleImpl {
  readonly [STATE_MIGRATION_HANDLE_BRAND] = true as const;
  readonly #projectDir: string;
  readonly #intent: MigrationIntent;

  private constructor(
    projectDir: string,
    intent: MigrationIntent,
    token: typeof STATE_MIGRATION_CONSTRUCTION_TOKEN,
  ) {
    if (token !== STATE_MIGRATION_CONSTRUCTION_TOKEN) {
      throw new StateMigrationError('INVALID_ARGUMENT', 'Migration construction authority is invalid.');
    }
    this.#projectDir = projectDir;
    this.#intent = intent;
  }

  static create(projectDir: string, intent: MigrationIntent): StateMigrationHandleImpl {
    assertDerivedMigrationIntent(projectDir, intent);
    return new StateMigrationHandleImpl(projectDir, intent, STATE_MIGRATION_CONSTRUCTION_TOKEN);
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

  validationDiagnostics(): Promise<MigrationValidationDiagnostics> {
    return Promise.resolve(withDatabase(this.#intent.finalPath, (database) => {
      const row = database.prepare(`
        SELECT project_passes, max_page_size, import_batches, carrier_lease_renewals,
               max_import_batch_size, max_active_projection_sessions,
               max_active_projection_accumulators
        FROM legacy_imports WHERE migration_id = ?
      `).get(this.#intent.migrationId) as {
        project_passes: number;
        max_page_size: number;
        import_batches: number;
        carrier_lease_renewals: number;
        max_import_batch_size: number;
        max_active_projection_sessions: number;
        max_active_projection_accumulators: number;
      };
      return {
        projectPasses: Number(row.project_passes),
        maxPageSize: Number(row.max_page_size),
        importBatches: Number(row.import_batches),
        carrierLeaseRenewals: Number(row.carrier_lease_renewals),
        maxImportBatchSize: Number(row.max_import_batch_size),
        maxActiveProjectionSessions: Number(row.max_active_projection_sessions),
        maxActiveProjectionAccumulators: Number(row.max_active_projection_accumulators),
      };
    }));
  }

  async readImportedLegacyStatePage(options: {
    cursor: string | null;
    limit: number;
  }): Promise<{
    items: AgentEventPayloadMap['legacy.imported'][];
    nextCursor: string | null;
  }> {
    requireMigrationPageLimit(options.limit);
    let { projectIndex, afterSequence } = parseLegacyStateCursor(options.cursor);
    const journal = new SqliteAgentJournal({ filePath: this.#intent.finalPath });
    const items: AgentEventPayloadMap['legacy.imported'][] = [];
    while (projectIndex < this.#intent.projectIds.length) {
      const projectId = this.#intent.projectIds[projectIndex]!;
      while (true) {
        const events = await journal.readProject(projectId, afterSequence, 1_000);
        if (events.length === 0) {
          projectIndex += 1;
          afterSequence = 0;
          break;
        }
        for (const event of events) {
          afterSequence = event.sequence;
          if (event.type !== 'legacy.imported') continue;
          items.push(structuredClone(event.payload));
          if (items.length === options.limit) {
            return {
              items,
              nextCursor: `${projectIndex}:${afterSequence}`,
            };
          }
        }
      }
    }
    return { items, nextCursor: null };
  }

  listLegacyArchives(options: {
    afterRelativePath: string | null;
    limit: number;
  }): Promise<{ items: LegacyArchiveRef[]; nextCursor: string | null }> {
    if (options.afterRelativePath !== null && typeof options.afterRelativePath !== 'string') {
      throw new StateMigrationError('INVALID_ARGUMENT', 'Archive cursor must be a string or null.');
    }
    requireMigrationPageLimit(options.limit);
    return Promise.resolve(withDatabase(this.#intent.finalPath, (database) => {
      const rows = database.prepare(`
        SELECT archive_handle, relative_path, checksum, byte_size
        FROM legacy_archives
        WHERE migration_id = ? AND relative_path > ?
        ORDER BY relative_path LIMIT ?
      `).all(
        this.#intent.migrationId, options.afterRelativePath ?? '', options.limit + 1,
      ) as unknown as Array<{
        archive_handle: string;
        relative_path: string;
        checksum: string;
        byte_size: number;
      }>;
      const hasMore = rows.length > options.limit;
      const page = hasMore ? rows.slice(0, options.limit) : rows;
      const items = page.map((row) => ({
        schemaVersion: 1 as const,
        archiveHandle: row.archive_handle,
        relativePath: row.relative_path,
        checksum: row.checksum,
        byteSize: Number(row.byte_size),
      }));
      return {
        items,
        nextCursor: hasMore ? page.at(-1)!.relative_path : null,
      };
    }));
  }

  async openLegacyArchive(ref: LegacyArchiveRef): Promise<AsyncIterable<Uint8Array>> {
    assertLegacyArchiveRef(ref);
    const row = this.#resolveLegacyArchive(ref);
    const path = containedMigrationPath(this.#projectDir, row.object_relative_path);
    let file: FileHandle | undefined;
    try {
      file = await open(path, 'r');
      const details = await file.stat();
      if (details.size !== ref.byteSize || await hashFileHandle(file) !== ref.checksum) {
        throw new StateMigrationError(
          'MIGRATION_VALIDATION_FAILED',
          'Legacy archive bytes failed verification.',
        );
      }
      const verifiedDetails = await file.stat();
      if (!sameFileGeneration(details, verifiedDetails)) {
        throw new StateMigrationError(
          'MIGRATION_VALIDATION_FAILED',
          'Legacy archive bytes changed during verification.',
        );
      }
      const verified = file;
      file = undefined;
      return streamFileHandle(verified, ref.byteSize, ref.checksum, verifiedDetails);
    } catch (error) {
      await file?.close().catch(() => undefined);
      if (error instanceof StateMigrationError) throw error;
      throw new StateMigrationError(
        'MIGRATION_VALIDATION_FAILED',
        `Legacy archive bytes could not be opened: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async readLegacyArchive(
    ref: LegacyArchiveRef,
    options: { maxBytes: number },
  ): Promise<Uint8Array> {
    assertLegacyArchiveRef(ref);
    if (!Number.isSafeInteger(options?.maxBytes) || options.maxBytes < 0) {
      throw new StateMigrationError('INVALID_ARGUMENT', 'maxBytes must be a non-negative integer.');
    }
    if (ref.byteSize > options.maxBytes) {
      throw new StateMigrationError('INVALID_ARGUMENT', 'Legacy archive exceeds maxBytes.');
    }
    const chunks: Uint8Array[] = [];
    let byteSize = 0;
    for await (const chunk of await this.openLegacyArchive(ref)) {
      byteSize += chunk.byteLength;
      if (byteSize > options.maxBytes) {
        throw new StateMigrationError('MIGRATION_VALIDATION_FAILED', 'Legacy archive exceeded maxBytes.');
      }
      chunks.push(chunk);
    }
    const bytes = new Uint8Array(byteSize);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  #resolveLegacyArchive(ref: LegacyArchiveRef): {
    object_relative_path: string;
  } {
    const row = withDatabase(this.#intent.finalPath, (database) =>
      database.prepare(`
        SELECT relative_path, object_relative_path, archive_handle, checksum, byte_size
        FROM legacy_archives
        WHERE migration_id = ? AND archive_handle = ? AND relative_path = ?
          AND checksum = ? AND byte_size = ?
      `).get(
        this.#intent.migrationId,
        ref.archiveHandle,
        ref.relativePath,
        ref.checksum,
        ref.byteSize,
      ) as {
        relative_path: string;
        object_relative_path: string;
        archive_handle: string;
        checksum: string;
        byte_size: number;
      } | undefined,
    );
    if (row === undefined) {
      throw new StateMigrationError('MIGRATION_VALIDATION_FAILED', 'Legacy archive reference is invalid.');
    }
    return row;
  }

  async inspect(): Promise<MigrationInspection> {
    const intent = await readIntent(this.#projectDir);
    return inspectionFromIntent(intent ?? this.#intent, intent?.status ?? 'missing');
  }
}

export type StateMigrationHandle = Pick<
  StateMigrationHandleImpl,
  | 'activeSchemaVersion'
  | 'countLegacyImports'
  | 'listLegacyArchives'
  | 'openLegacyArchive'
  | 'readLegacyArchive'
  | 'inspect'
> & { readonly [STATE_MIGRATION_HANDLE_BRAND]: true };

/** @internal Package tests and migration diagnostics only. */
export type InternalStateMigrationHandle = StateMigrationHandleImpl;

export async function openProjectStateMigration(
  projectDir: string,
  options: StateMigrationOptions = {},
): Promise<StateMigrationHandle> {
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

async function migrateLocked(
  projectDir: string,
  options: Required<Pick<StateMigrationOptions, 'targetSchemaVersion' | 'migratorRevision'>> &
    Pick<StateMigrationOptions, 'crashAt'>,
): Promise<StateMigrationHandleImpl> {
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
    await validateShadow(reconstructed, true);
    await setMigrationActive(finalPath, reconstructed.migrationId);
    const completed = { ...reconstructed, status: 'completed' as const };
    await writeIntent(projectDir, completed);
    return StateMigrationHandleImpl.create(projectDir, completed);
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
  normalizeLegacyContractState(importedState);
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
  const archives = await materializeLegacyArchives(projectDir, manifest, migrationId);
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
        sealed INTEGER NOT NULL DEFAULT 0 CHECK (sealed IN (0, 1)),
        authority_issued INTEGER NOT NULL DEFAULT 0 CHECK (authority_issued IN (0, 1))
      )
    `);
    database.prepare(`
      INSERT INTO legacy_migration_build_context (id, migration_id, source_digest)
      VALUES (1, ?, ?)
    `).run(migrationId, sourceDigest);
  });
  const migrationWriter = createLegacyMigrationWriter(journal, { migrationId, sourceDigest });
  let importDiagnostics: Pick<
    MigrationValidationDiagnostics,
    'importBatches' | 'carrierLeaseRenewals' | 'maxImportBatchSize'
  >;
  try {
    importDiagnostics = await importLegacyFacts(journal, migrationWriter, {
      migrationId, sourceDigest, importedState, archives, projectIds,
    });
  } finally {
    migrationWriter.seal();
  }
  const eventCount = await journal.countEvents();
  const importedPrefixes = await captureImportedEventPrefixes(journal, projectIds);
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
        project_passes INTEGER NOT NULL DEFAULT 0,
        max_page_size INTEGER NOT NULL DEFAULT 0,
        import_batches INTEGER NOT NULL,
        carrier_lease_renewals INTEGER NOT NULL,
        max_import_batch_size INTEGER NOT NULL,
        max_active_projection_sessions INTEGER NOT NULL DEFAULT 0,
        max_active_projection_accumulators INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE legacy_import_prefixes (
        migration_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        max_sequence INTEGER NOT NULL CHECK (max_sequence > 0),
        event_count INTEGER NOT NULL CHECK (event_count > 0),
        prefix_digest TEXT NOT NULL,
        PRIMARY KEY (migration_id, project_id)
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
        INSERT INTO legacy_imports (
          migration_id, project_ids_json, event_count, import_batches,
          carrier_lease_renewals, max_import_batch_size, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        migrationId, canonicalJson(projectIds), eventCount,
        importDiagnostics.importBatches, importDiagnostics.carrierLeaseRenewals,
        importDiagnostics.maxImportBatchSize,
        new Date(0).toISOString(),
      );
      const insertPrefix = shadow.prepare(`
        INSERT INTO legacy_import_prefixes (
          migration_id, project_id, max_sequence, event_count, prefix_digest
        ) VALUES (?, ?, ?, ?, ?)
      `);
      for (const prefix of importedPrefixes) {
        insertPrefix.run(
          migrationId, prefix.projectId, prefix.maxSequence, prefix.eventCount, prefix.digest,
        );
      }
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
): Promise<StateMigrationHandleImpl> {
  const writerGate = acquireExclusiveStateWriterGate(projectDir);
  let ownsPromotedSource = false;
  try {
    const currentRow = await readMigrationRowIfNew(intent.finalPath);
    ownsPromotedSource = currentRow !== undefined &&
      currentRow.migration_id === intent.migrationId &&
      await pathExists(intent.sourceBackupPath);
    await validateShadow(intent);
    if (currentRow === undefined) {
      if (await pathExists(intent.sourcePath)) {
        if (await pathExists(intent.sourceBackupPath)) {
          throw new StateMigrationError(
            'MIGRATION_STATE_CONFLICT',
            'Both active source and versioned source backup exist.',
            inspectionFromIntent(intent, intent.status),
          );
        }
        await migrationBarrier(projectDir, 'after-live-recheck');
        await assertSourceDigestStillMatches(projectDir, intent);
        await assertLiveLegacyStillMatches(projectDir, intent);
        await sealMigrationBuildContext(intent.shadowPath, intent);
        await validateShadow(intent, true);
        writerGate.persistMigrationSealed(intent.migrationId, intent.sourceDigest);
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
        ownsPromotedSource = true;
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
    await migrationBarrier(projectDir, 'after-promote-before-active');
    await validateShadow(intent, true);
    await setMigrationActive(intent.finalPath, intent.migrationId);
    writerGate.persistActive(intent.migrationId, intent.sourceDigest);
    const completed = { ...intent, status: 'completed' as const };
    await writeIntent(projectDir, completed);
    await rm(intent.shadowPath, { force: true });
    await fsyncDirectory(projectDir);
    return StateMigrationHandleImpl.create(projectDir, completed);
  } catch (error) {
    if (!(error instanceof StateMigrationError && error.code === 'INJECTED_CRASH')) {
      await rollbackFailedActivation(projectDir, intent, ownsPromotedSource);
      writerGate.persistLegacyWritable(intent.migrationId, intent.sourceDigest);
    }
    throw error;
  } finally {
    writerGate.close();
  }
}

function readLegacyState(path: string): ImportedLegacyState {
  return withDatabase(path, (database) => {
    try {
      const runs = readLegacyRuns(database);
      const messages: Iterable<LegacyMessageRow> = tableExists(database, 'agent_session_messages')
        ? (database.prepare(`
          SELECT session_id, message_index, role, content, created_at,
                 tool_call_id, tool_name, tool_calls_json
          FROM agent_session_messages
          ORDER BY session_id, message_index
        `).iterate() as unknown as Iterable<LegacyMessageRow>)
        : [];
      const sessions = readLegacySessions(database, messages, runs);
      const toolDiagnostics = validateLegacyToolCallLinks(sessions);
      const preferences = readLegacyPreferences(database);
      const checkpoints = readLegacyContextCheckpoints(database);
      const subagents = readLegacySubagents(database);
      const diagnosticRows = tableExists(database, 'legacy_runtime_diagnostics')
        ? (database.prepare(`
          SELECT kind, durable_evidence FROM legacy_runtime_diagnostics ORDER BY kind
        `).all() as unknown as Array<{ kind: string; durable_evidence: string }>)
        : [];
      return {
        sessions,
        runs,
        plan: firstLegacyPlan(runs),
        preferences,
        checkpoints,
        subagents,
        diagnostics: [
          ...diagnosticRows.map((diagnostic) => ({
            code: diagnostic.kind === 'approval'
              ? 'LEGACY_APPROVAL_EXPIRED'
              : 'LEGACY_RESULT_HANDLE_EXPIRED',
            evidence: diagnostic.durable_evidence,
          })),
          ...toolDiagnostics,
        ],
      };
    } catch (error) {
      if (error instanceof StateMigrationError) throw error;
      throw new StateMigrationError(
        'MIGRATION_SOURCE_CORRUPT',
        `Legacy state cannot be read: ${errorMessage(error)}`,
      );
    }
  });
}

type LegacyMessageRow = {
  session_id: string;
  message_index: number;
  role: string;
  content: string;
  created_at: string;
  tool_call_id: string | null;
  tool_name: string | null;
  tool_calls_json: string | null;
};

function readLegacyRuns(database: NodeDatabaseSync): ImportedLegacyState['runs'] {
  if (!tableExists(database, 'agent_runs')) return [];
  const columns = tableColumnNames(database, 'agent_runs');
  if (columns.has('payload_json')) {
    const rows = database.prepare('SELECT * FROM agent_runs ORDER BY run_id').all() as unknown as
      Array<Record<string, unknown>>;
    return rows.map((row) => {
      const record = parseLegacyRunRecord(requireLegacyText(row.payload_json, 'Run payload_json'));
      if (
        record.runId !== requireLegacyText(row.run_id, 'Run run_id') ||
        record.sessionId !== requireLegacyText(row.session_id, 'Run session_id') ||
        record.status !== requireLegacyText(row.status, 'Run status') ||
        record.phase !== requireLegacyText(row.phase, 'Run phase') ||
        record.iteration !== requireLegacyInteger(row.iteration, 'Run iteration') ||
        record.createdAt !== requireLegacyIso(row.created_at, 'Run created_at') ||
        record.updatedAt !== requireLegacyIso(row.updated_at, 'Run updated_at')
      ) {
        throw new TypeError(`Legacy Run ${record.runId} payload disagrees with its columns.`);
      }
      return record;
    });
  }
  const required = ['run_id', 'session_id', 'status', 'created_at', 'updated_at'];
  if (required.some((column) => !columns.has(column))) {
    throw new TypeError('Legacy Run table has an unsupported historical layout.');
  }
  const planExpression = columns.has('plan_json') ? 'plan_json' : 'NULL AS plan_json';
  const rows = database.prepare(`
    SELECT run_id, session_id, status, ${planExpression}, created_at, updated_at
    FROM agent_runs ORDER BY run_id
  `).all() as unknown as Array<{
    run_id: string; session_id: string; status: string; plan_json: string | null;
    created_at: string; updated_at: string;
  }>;
  return rows.map((run) => ({
    runId: requireLegacyText(run.run_id, 'Run run_id'),
    sessionId: requireLegacyText(run.session_id, 'Run session_id'),
    status: run.status === 'completed' ? 'completed' : 'interrupted_legacy',
    plan: parseNullableJson(run.plan_json),
    createdAt: requireLegacyIso(run.created_at, 'Run created_at'),
    updatedAt: requireLegacyIso(run.updated_at, 'Run updated_at'),
  }));
}

function readLegacySessions(
  database: NodeDatabaseSync,
  messages: Iterable<LegacyMessageRow>,
  runs: ImportedLegacyState['runs'],
): ImportedLegacyState['sessions'] {
  if (!tableExists(database, 'agent_sessions')) return [];
  const columns = tableColumnNames(database, 'agent_sessions');
  const rows = database.prepare('SELECT * FROM agent_sessions ORDER BY id')
    .iterate() as unknown as Iterable<Record<string, unknown>>;
  const result: ImportedLegacyState['sessions'] = [];
  const messageIterator = messages[Symbol.iterator]();
  let nextMessage = messageIterator.next();
  for (const row of rows) {
    const id = requireLegacyText(row.id, 'Session id');
    const sessionMessages: Array<AgentMessage & { messageIndex: number }> = [];
    while (!nextMessage.done && nextMessage.value.session_id === id) {
      sessionMessages.push(legacyMessageFromRow(nextMessage.value));
      nextMessage = messageIterator.next();
    }
    const sourceRunId = latestLegacyRunId(runs, id) ?? `legacy-session:${id}`;
    const indexedMessages = sessionMessages.map((message) => ({ ...message, sourceRunId }));
    const payloadJson = requireLegacyText(row.payload_json, 'Session payload_json');
    if (columns.has('message_count') && columns.has('prompt_tokens')) {
      const metadata = parseLegacySessionRecord(payloadJson, indexedMessages);
      const projectIdentity = legacyProjectIdentityFromRow(row, payloadJson);
      const userId = row.user_id === null ? undefined : requireLegacyText(row.user_id, 'Session user_id');
      if (
        metadata.id !== id || metadata.title !== requireLegacyText(row.title, 'Session title') ||
        metadata.mode !== requireLegacyText(row.mode, 'Session mode') || metadata.userId !== userId ||
        metadata.messages.length !== requireLegacyInteger(row.message_count, 'Session message_count') ||
        metadata.tokenUsage.promptTokens !== requireLegacyInteger(row.prompt_tokens, 'prompt_tokens') ||
        metadata.tokenUsage.completionTokens !== requireLegacyInteger(row.completion_tokens, 'completion_tokens') ||
        metadata.tokenUsage.totalTokens !== requireLegacyInteger(row.total_tokens, 'total_tokens')
      ) {
        throw new TypeError(`Legacy Session ${id} payload disagrees with its columns.`);
      }
      result.push({
        id,
        ...projectIdentity,
        title: metadata.title,
        userId: metadata.userId ?? null,
        mode: metadata.mode,
        messages: indexedMessages,
        record: metadata,
        archived: requireLegacyInteger(row.archived, 'Session archived') === 1,
        createdAt: requireLegacyIso(row.created_at, 'Session created_at'),
        updatedAt: requireLegacyIso(row.updated_at, 'Session updated_at'),
        lastMessageAt: row.last_message_at === null
          ? null
          : requireLegacyIso(row.last_message_at, 'Session last_message_at'),
      });
      continue;
    }
    const identity = legacyProjectIdentity(payloadJson);
    result.push({
      id,
      ...identity,
      title: requireLegacyText(row.title, 'Session title'),
      userId: row.user_id === null ? null : requireLegacyText(row.user_id, 'Session user_id'),
      mode: requireLegacyText(row.mode, 'Session mode'),
      messages: indexedMessages,
    });
  }
  if (!nextMessage.done) {
    throw new TypeError(`Legacy message references missing Session ${nextMessage.value.session_id}.`);
  }
  return result;
}

function readLegacyPreferences(database: NodeDatabaseSync): ImportedLegacyState['preferences'] {
  if (!tableExists(database, 'agent_user_preferences')) return [];
  const columns = tableColumnNames(database, 'agent_user_preferences');
  const rows = database.prepare('SELECT * FROM agent_user_preferences ORDER BY id').all() as unknown as
    Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: requireLegacyText(row.id, 'Preference id'),
    userId: requireLegacyText(row.user_id, 'Preference user_id'),
    key: requireLegacyText(row.preference_key, 'Preference key'),
    value: requireLegacyText(row.value, 'Preference value'),
    confidence: requireLegacyFinite(row.confidence, 'Preference confidence'),
    sourceSessionId: row.source_session_id === null
      ? null
      : requireLegacyText(row.source_session_id, 'Preference source_session_id'),
    ...(columns.has('evidence') && row.evidence !== null
      ? { evidence: requireLegacyText(row.evidence, 'Preference evidence') }
      : {}),
    ...(columns.has('created_at')
      ? { createdAt: requireLegacyIso(row.created_at, 'Preference created_at') }
      : {}),
    ...(columns.has('updated_at')
      ? { updatedAt: requireLegacyIso(row.updated_at, 'Preference updated_at') }
      : {}),
  }));
}

function readLegacyContextCheckpoints(
  database: NodeDatabaseSync,
): ImportedLegacyState['checkpoints'] {
  if (!tableExists(database, 'agent_context_checkpoints')) return [];
  const columns = tableColumnNames(database, 'agent_context_checkpoints');
  const rows = database.prepare(`
    SELECT * FROM agent_context_checkpoints ORDER BY session_id, sequence
  `).all() as unknown as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const sessionId = requireLegacyText(row.session_id, 'Checkpoint session_id');
    const sequence = requireLegacyInteger(row.sequence, 'Checkpoint sequence');
    const summary = requireLegacyText(row.summary, 'Checkpoint summary');
    const createdAt = requireLegacyIso(row.created_at, 'Checkpoint created_at');
    if (!columns.has('trigger')) return { sessionId, sequence, summary, createdAt };
    const record: AgentContextCheckpoint = {
      version: requireLegacyInteger(row.version, 'Checkpoint version') as 1,
      sequence,
      trigger: requireLegacyEnum(row.trigger, ['auto', 'manual', 'automatic'], 'Checkpoint trigger') === 'automatic'
        ? 'auto'
        : requireLegacyEnum(row.trigger, ['auto', 'manual'], 'Checkpoint trigger') as AgentContextCheckpoint['trigger'],
      method: requireLegacyEnum(
        row.method, ['model', 'deterministic-fallback'], 'Checkpoint method',
      ) as AgentContextCheckpoint['method'],
      summary,
      coveredConversationMessageCount: requireLegacyInteger(
        row.covered_message_count, 'Checkpoint covered_message_count',
      ),
      sourceTokenEstimate: requireLegacyInteger(row.source_token_estimate, 'Checkpoint source_token_estimate'),
      summaryTokenEstimate: requireLegacyInteger(row.summary_token_estimate, 'Checkpoint summary_token_estimate'),
      modelContextTokens: row.model_context_tokens === null
        ? null
        : requireLegacyInteger(row.model_context_tokens, 'Checkpoint model_context_tokens'),
      createdAt,
      ...(row.focus === null ? {} : { focus: requireLegacyText(row.focus, 'Checkpoint focus') }),
    };
    if (record.version !== 1) throw new TypeError('Legacy Checkpoint version is unsupported.');
    return { sessionId, sequence, summary, createdAt, record };
  });
}

function readLegacySubagents(database: NodeDatabaseSync): ImportedLegacyState['subagents'] {
  if (!tableExists(database, 'agent_subagents')) return [];
  const columns = tableColumnNames(database, 'agent_subagents');
  const rows = database.prepare('SELECT * FROM agent_subagents ORDER BY id').all() as unknown as
    Array<Record<string, unknown>>;
  return rows.map((row) => {
    if (!columns.has('task')) {
      return {
        id: requireLegacyText(row.id, 'Subagent id'),
        parentSessionId: requireLegacyText(row.parent_session_id, 'Subagent parent_session_id'),
        childSessionId: row.child_session_id === null
          ? null
          : requireLegacyText(row.child_session_id, 'Subagent child_session_id'),
        status: requireLegacyText(row.status, 'Subagent status'),
        depth: requireLegacyInteger(row.depth, 'Subagent depth'),
      };
    }
    const artifactReferences = parseStrictPortableJson(
      requireLegacyText(row.artifact_references_json, 'Subagent artifact_references_json'),
      'Subagent artifact references',
    );
    if (!Array.isArray(artifactReferences) ||
      artifactReferences.some((reference) => typeof reference !== 'string')) {
      throw new TypeError('Legacy Subagent artifact references are invalid.');
    }
    return {
      id: requireLegacyText(row.id, 'Subagent id'),
      parentSessionId: requireLegacyText(row.parent_session_id, 'Subagent parent_session_id'),
      ...(row.child_session_id === null
        ? {}
        : { childSessionId: requireLegacyText(row.child_session_id, 'Subagent child_session_id') }),
      task: requireLegacyText(row.task, 'Subagent task'),
      contextStrategy: normalizeLegacyContextStrategy(row.context_strategy),
      status: requireLegacyEnum(row.status, ['running', 'completed', 'failed', 'cancelled'], 'Subagent status') as
        AgentSubagentRecord['status'],
      depth: requireLegacyInteger(row.depth, 'Subagent depth'),
      ...(row.summary === null ? {} : { summary: requireLegacyText(row.summary, 'Subagent summary') }),
      ...(artifactReferences.length === 0 ? {} : { artifactReferences: artifactReferences as string[] }),
      ...(row.error_message === null
        ? {}
        : { errorMessage: requireLegacyText(row.error_message, 'Subagent error_message') }),
      createdAt: requireLegacyIso(row.created_at, 'Subagent created_at'),
      updatedAt: requireLegacyIso(row.updated_at, 'Subagent updated_at'),
    };
  });
}

function parseLegacySessionRecord(payloadJson: string, messages: AgentMessage[]): AgentSession {
  const value = parseStrictPortableJson(payloadJson, 'Session payload_json');
  const record = requireLegacyRecord(value, 'Session payload_json');
  const allowed = [
    'id', 'title', 'userId', 'mode', 'messages', 'tokenUsage', 'modelBinding', 'project',
    'taskPlan', 'artifacts', 'toolActivations', 'activeSkills', 'sessionSkills', 'subagentDepth',
    'capabilityStates', 'contextCheckpoint', 'aborted',
  ];
  assertLegacyExactKeys(record, allowed, 'Session payload_json');
  const result = { ...record, messages: structuredClone(messages) } as AgentSession;
  requireLegacyText(result.id, 'Session payload id');
  requireLegacyText(result.title, 'Session payload title');
  requireLegacyText(result.mode, 'Session payload mode');
  if (typeof result.aborted !== 'boolean') throw new TypeError('Session payload aborted must be boolean.');
  const usage = requireLegacyRecord(result.tokenUsage, 'Session tokenUsage');
  assertLegacyExactKeys(usage, ['promptTokens', 'completionTokens', 'totalTokens'], 'Session tokenUsage');
  ['promptTokens', 'completionTokens', 'totalTokens'].forEach((key) =>
    requireLegacyInteger(usage[key], `Session tokenUsage.${key}`));
  return result;
}

function parseLegacyRunRecord(payloadJson: string): AgentRunRecord {
  const value = parseStrictPortableJson(payloadJson, 'Run payload_json');
  const record = requireLegacyRecord(value, 'Run payload_json');
  assertLegacyExactKeys(record, [
    'runId', 'sessionId', 'status', 'phase', 'iteration', 'finalText', 'toolExecutions',
    'completion', 'errorMessage', 'createdAt', 'updatedAt',
  ], 'Run payload_json');
  requireLegacyText(record.runId, 'Run payload runId');
  requireLegacyText(record.sessionId, 'Run payload sessionId');
  requireLegacyEnum(record.status, [
    'running', 'done', 'aborted', 'failed', 'interrupted', 'max_iterations_reached',
  ], 'Run payload status');
  requireLegacyEnum(record.phase, ['act', 'verify', 'finalize', 'done'], 'Run payload phase');
  requireLegacyInteger(record.iteration, 'Run payload iteration');
  if (typeof record.finalText !== 'string') throw new TypeError('Run payload finalText must be a string.');
  if (!Array.isArray(record.toolExecutions)) throw new TypeError('Run payload toolExecutions must be an array.');
  requireLegacyIso(record.createdAt, 'Run payload createdAt');
  requireLegacyIso(record.updatedAt, 'Run payload updatedAt');
  return record as AgentRunRecord;
}

function validateLegacyToolCallLinks(
  sessions: ImportedLegacyState['sessions'],
): ImportedLegacyState['diagnostics'] {
  const diagnostics: ImportedLegacyState['diagnostics'] = [];
  for (const session of sessions) {
    const calls = new Map<string, { id: string; name: string }>();
    const resolved = new Set<string>();
    for (const message of session.messages) {
      if (message.role === 'assistant') {
        for (const call of message.toolCalls ?? []) {
          if (calls.has(call.id)) {
            throw new StateMigrationError(
              'MIGRATION_VALIDATION_FAILED', `Legacy ToolCall id is duplicated: ${call.id}.`,
            );
          }
          calls.set(call.id, { id: call.id, name: call.name });
        }
      } else if (message.role === 'tool') {
        const expected = calls.get(message.toolCallId);
        if (expected === undefined || expected.name !== message.toolName ||
          resolved.has(message.toolCallId)) {
          throw new StateMigrationError(
            'MIGRATION_VALIDATION_FAILED',
            `Legacy Tool result identity is invalid: ${message.toolCallId}.`,
          );
        }
        resolved.add(message.toolCallId);
      }
    }
    for (const call of calls.values()) {
      if (resolved.has(call.id)) continue;
      diagnostics.push({
        code: 'LEGACY_TOOL_OUTCOME_UNKNOWN',
        evidence: `Session ${session.id} was interrupted before ToolCall ${call.id} (${call.name}) recorded a result.`,
      });
    }
  }
  return diagnostics;
}

function latestLegacyRunId(runs: ImportedLegacyState['runs'], sessionId: string): string | undefined {
  return runs
    .filter((run) => run.sessionId === sessionId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) ||
      left.runId.localeCompare(right.runId, 'en'))[0]?.runId;
}

function legacyProjectIdentityFromRow(
  row: Record<string, unknown>,
  payloadJson: string,
): { projectKey: string; projectRoot: string } {
  const fallback = legacyProjectIdentity(payloadJson);
  return {
    projectKey: typeof row.project_key === 'string' && row.project_key.length > 0
      ? row.project_key
      : fallback.projectKey,
    projectRoot: typeof row.project_root === 'string' && row.project_root.length > 0
      ? row.project_root
      : fallback.projectRoot,
  };
}

function tableColumnNames(database: NodeDatabaseSync, table: string): Set<string> {
  if (!/^[a-z_]+$/u.test(table)) throw new TypeError('Legacy table name is invalid.');
  return new Set((database.prepare(`PRAGMA table_info(${table})`).all() as unknown as
    Array<{ name: string }>).map(({ name }) => name));
}

function parseStrictPortableJson(value: string, label: string): PortableValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
    assertPortableValue(parsed);
  } catch (error) {
    throw new TypeError(`${label} is invalid: ${errorMessage(error)}`);
  }
  return parsed;
}

function requireLegacyRecord(value: unknown, label: string): Record<string, PortableValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, PortableValue>;
}

function assertLegacyExactKeys(
  record: Record<string, unknown>,
  allowed: string[],
  label: string,
): void {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new TypeError(`${label} has unknown fields: ${unknown.sort().join(', ')}.`);
}

function requireLegacyText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} is required.`);
  return value;
}

function requireLegacyInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${label} must be a non-negative integer.`);
  }
  return Number(value);
}

function requireLegacyFinite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${label} must be finite.`);
  return value;
}

function requireLegacyIso(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value) {
    throw new TypeError(`${label} must be an exact ISO timestamp.`);
  }
  return value;
}

function requireLegacyEnum(value: unknown, allowed: string[], label: string): string {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new TypeError(`${label} is unsupported.`);
  }
  return value;
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
      (childSessionId != null && !sessionIds.has(childSessionId)),
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
    completedRunCount: state.runs.filter(({ status }) => status === 'done').length,
    interruptedRunCount: state.runs.filter(({ status }) => status === 'interrupted').length,
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

async function validateShadow(intent: MigrationIntent, requireSealed = false): Promise<void> {
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
      const prefixes = database.prepare(`
        SELECT project_id, max_sequence, event_count, prefix_digest
        FROM legacy_import_prefixes WHERE migration_id = ? ORDER BY project_id
      `).all(intent.migrationId) as unknown as Array<{
        project_id: string;
        max_sequence: number;
        event_count: number;
        prefix_digest: string;
      }>;
      if (prefixes.length !== intent.projectIds.length ||
        prefixes.reduce((count, prefix) => count + Number(prefix.event_count), 0) !==
          Number(imported.event_count)) {
        throw new Error('Legacy import prefixes are incomplete.');
      }
      const context = database.prepare(`
        SELECT migration_id, source_digest, sealed
        FROM legacy_migration_build_context WHERE id = 1
      `).get() as { migration_id: string; source_digest: string; sealed: number } | undefined;
      if (context === undefined || context.migration_id !== intent.migrationId ||
        context.source_digest !== intent.sourceDigest ||
        (requireSealed ? Number(context.sealed) !== 1 : ![0, 1].includes(Number(context.sealed)))) {
        throw new Error('Legacy migration build context is invalid.');
      }
      const carriers = database.prepare(`
        SELECT DISTINCT runs.state, runs.hidden FROM agent_runs AS runs
        JOIN agent_events AS events
          ON events.project_id = runs.project_id AND events.run_id = runs.run_id
        WHERE events.event_type = 'run.created'
          AND json_extract(events.payload_json, '$.visibility') = 'legacy-import-carrier'
      `).all() as unknown as Array<{ state: string; hidden: number }>;
      if (carriers.length === 0 || carriers.some(({ state, hidden }) =>
        !['Completed', 'Failed', 'Cancelled'].includes(state) || Number(hidden) !== 1)) {
        throw new Error('Synthetic legacy carrier Runs are not terminal and hidden.');
      }
      return { prefixes };
    });

    const journal = new SqliteAgentJournal({ filePath: path });
    const reconstructed = emptyImportedLegacyState();
    let projectPasses = 0;
    let maxPageSize = 0;
    let maxActiveProjectionSessions = 0;
    let maxActiveProjectionAccumulators = 0;
    for (const projectId of intent.projectIds) {
      const expectedPrefix = databaseValidation.prefixes.find(
        (prefix) => prefix.project_id === projectId,
      );
      if (expectedPrefix === undefined) throw new Error('Legacy import Project prefix is missing.');
      const prefixHash = createHash('sha256');
      let prefixEventCount = 0;
      projectPasses += 1;
      const causalValidator = new ProjectionEventValidator(projectId);
      const projections = new Map<string, {
        accumulators: Array<{
          accept(event: AgentEvent): boolean;
          finish(): unknown;
        }>;
        active: boolean[];
      }>();
      let cursor = 0;
      while (true) {
        const page = await journal.readProject(projectId, cursor, 1_000);
        if (page.length === 0) break;
        maxPageSize = Math.max(maxPageSize, page.length);
        for (const event of page) {
          if (event.sequence > Number(expectedPrefix.max_sequence)) break;
          prefixHash.update(canonicalJson(event));
          prefixHash.update('\n');
          prefixEventCount += 1;
          cursor = event.sequence;
          causalValidator.accept(event);
          const terminal = causalValidator.releaseTerminal(event, true);
          if (event.type === 'legacy.imported') applyLegacyImport(reconstructed, event.payload);
          let projection = projections.get(event.sessionId);
          if (projection === undefined) {
            projection = {
              accumulators: [
                new SessionProjectionAccumulator({
                  projectId, sessionId: event.sessionId, afterSequence: 0, limit: 1_000,
                }, true),
                new UserActivityProjectionAccumulator({
                  projectId, sessionId: event.sessionId, afterSequence: 0, limit: 1_000,
                }, true),
                new AuditProjectionAccumulator({
                  projectId, sessionId: event.sessionId, afterSequence: 0, limit: 1_000,
                }, true),
              ],
              active: [true, true, true],
            };
            projections.set(event.sessionId, projection);
            maxActiveProjectionSessions = Math.max(
              maxActiveProjectionSessions, projections.size,
            );
            maxActiveProjectionAccumulators = Math.max(
              maxActiveProjectionAccumulators,
              [...projections.values()].reduce(
                (count, current) => count + current.active.filter(Boolean).length,
                0,
              ),
            );
          }
          const currentProjection = projection;
          projection.accumulators.forEach((accumulator, index) => {
            if (currentProjection.active[index]) {
              currentProjection.active[index] = accumulator.accept(event);
            }
          });
          if (terminal !== undefined) {
            projection.accumulators.forEach((accumulator) => accumulator.finish());
            projections.delete(event.sessionId);
          }
        }
        if (cursor >= Number(expectedPrefix.max_sequence)) break;
      }
      if (cursor !== Number(expectedPrefix.max_sequence) ||
        prefixEventCount !== Number(expectedPrefix.event_count) ||
        prefixHash.digest('hex') !== expectedPrefix.prefix_digest) {
        throw new Error('Legacy imported Journal prefix changed.');
      }
      for (const projection of projections.values()) {
        projection.accumulators.forEach((accumulator) => accumulator.finish());
      }
    }
    if (!requireSealed) {
      withDatabase(path, (database) => {
        database.prepare(`
          UPDATE legacy_imports SET project_passes = ?, max_page_size = ?,
            max_active_projection_sessions = ?, max_active_projection_accumulators = ?
          WHERE migration_id = ?
        `).run(
          projectPasses, maxPageSize, maxActiveProjectionSessions,
          maxActiveProjectionAccumulators, intent.migrationId,
        );
        database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      });
    }
    normalizeImportedLegacyState(reconstructed);
    reconstructed.plan ??= firstLegacyPlan(reconstructed.runs);
    if (sha256(canonicalJson(reconstructed)) !== intent.importedStateDigest) {
      throw new Error('Imported legacy state digest changed.');
    }
    const validationReport = validateLegacyState(reconstructed, intent.manifest);
    if (sha256(canonicalJson(validationReport)) !== intent.validationDigest ||
      sha256(canonicalJson(JSON.parse(row.validation_report_json) as unknown)) !== intent.validationDigest) {
      throw new Error('Migration validation report digest changed.');
    }
    await validateLegacyArchives(dirname(intent.finalPath), path, intent);
  } catch (error) {
    if (error instanceof StateMigrationError) throw error;
    throw new StateMigrationError(
      'MIGRATION_VALIDATION_FAILED',
      `Validated Shadow failed semantic revalidation: ${errorMessage(error)}`,
      inspectionFromIntent(intent, intent.status),
    );
  }
}

type ImportedEventPrefix = {
  projectId: string;
  maxSequence: number;
  eventCount: number;
  digest: string;
};

async function captureImportedEventPrefixes(
  journal: SqliteAgentJournal,
  projectIds: readonly string[],
): Promise<ImportedEventPrefix[]> {
  const prefixes: ImportedEventPrefix[] = [];
  for (const projectId of projectIds) {
    const hash = createHash('sha256');
    let cursor = 0;
    let eventCount = 0;
    while (true) {
      const page = await journal.readProject(projectId, cursor, 1_000);
      if (page.length === 0) break;
      for (const event of page) {
        hash.update(canonicalJson(event));
        hash.update('\n');
        cursor = event.sequence;
        eventCount += 1;
      }
    }
    if (eventCount === 0) throw new Error(`Imported Project ${projectId} has no Journal prefix.`);
    prefixes.push({ projectId, maxSequence: cursor, eventCount, digest: hash.digest('hex') });
  }
  return prefixes;
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

function normalizeLegacyContractState(state: ImportedLegacyState): void {
  const epoch = new Date(0).toISOString();
  state.runs = state.runs.map((run): AgentRunRecord => {
    if ('phase' in run) return structuredClone(run);
    return {
      runId: run.runId,
      sessionId: run.sessionId,
      status: run.status === 'completed' ? 'done' : 'interrupted',
      phase: run.status === 'completed' ? 'done' : 'verify',
      iteration: 0,
      finalText: '',
      toolExecutions: [],
      ...(run.status === 'completed'
        ? {}
        : { errorMessage: 'Legacy Run was interrupted during migration.' }),
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    };
  });
  for (const session of state.sessions) {
    const mode = normalizeLegacyMode(session.mode);
    session.mode = mode;
    const sourceRunId = latestLegacyRunId(state.runs, session.id) ?? `legacy-session:${session.id}`;
    for (const message of session.messages) message.sourceRunId = sourceRunId;
    const messages = session.messages.map(legacyMessageRecord);
    const record = session.record ?? {
      id: session.id,
      title: session.title,
      ...(session.userId === null ? {} : { userId: session.userId }),
      mode,
      messages,
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      aborted: false,
    };
    record.messages = messages;
    session.record = record;
    session.archived ??= false;
    session.createdAt ??= messages[0]?.createdAt ?? epoch;
    session.updatedAt ??= messages.at(-1)?.createdAt ?? session.createdAt;
    session.lastMessageAt ??= messages.at(-1)?.createdAt ?? null;
  }
  for (const preference of state.preferences) {
    preference.createdAt ??= epoch;
    preference.updatedAt ??= preference.createdAt;
  }
  for (const checkpoint of state.checkpoints) {
    checkpoint.record ??= {
      version: 1,
      sequence: checkpoint.sequence,
      trigger: 'auto',
      method: 'deterministic-fallback',
      summary: checkpoint.summary,
      coveredConversationMessageCount: 0,
      sourceTokenEstimate: 0,
      summaryTokenEstimate: 0,
      modelContextTokens: null,
      createdAt: checkpoint.createdAt,
    };
  }
  state.subagents = state.subagents.map((subagent): AgentSubagentRecord => {
    if ('task' in subagent) return structuredClone(subagent);
    return {
      id: subagent.id,
      parentSessionId: subagent.parentSessionId,
      ...(subagent.childSessionId === null ? {} : { childSessionId: subagent.childSessionId }),
      task: 'Legacy subagent task unavailable',
      contextStrategy: 'fresh',
      status: normalizeLegacySubagentStatus(subagent.status),
      depth: subagent.depth,
      createdAt: epoch,
      updatedAt: epoch,
    };
  });
}

function normalizeLegacyMode(mode: string): AgentSession['mode'] {
  return mode === 'edit' || mode === 'full' ? mode : 'read';
}

function normalizeLegacySubagentStatus(status: string): AgentSubagentRecord['status'] {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
    ? status
    : 'running';
}

function normalizeLegacyContextStrategy(value: unknown): AgentSubagentRecord['contextStrategy'] {
  const strategy = requireLegacyEnum(
    value, ['fresh', 'fork', 'checkpoint-plus-recent'], 'Subagent context_strategy',
  );
  return strategy === 'fork' || strategy === 'checkpoint-plus-recent' ? 'fork' : 'fresh';
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
      Number(row.byte_size) !== entry.byteSize ||
      row.archive_handle !== legacyArchiveHandle(intent.migrationId, entry.relativePath)) {
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
      const context = database.prepare(`
        SELECT sealed FROM legacy_migration_build_context WHERE id = 1 AND migration_id = ?
      `).get(migrationId) as { sealed: number } | undefined;
      if (Number(context?.sealed) !== 1) throw new Error('Unsealed migration cannot become active.');
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

async function rollbackFailedActivation(
  projectDir: string,
  intent: MigrationIntent,
  ownsPromotedSource: boolean,
): Promise<void> {
  const sourceExists = await pathExists(intent.sourcePath);
  const backupExists = await pathExists(intent.sourceBackupPath);
  if (ownsPromotedSource && backupExists) {
    if (sourceExists) await rm(intent.sourcePath, { force: true });
    await rename(intent.sourceBackupPath, intent.sourcePath);
  } else if (!sourceExists && backupExists) {
    await rename(intent.sourceBackupPath, intent.sourcePath);
  }
  await rm(intent.shadowPath, { force: true });
  await rm(join(projectDir, 'state.migration.json'), { force: true });
  await fsyncDirectory(projectDir);
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

function assertDerivedMigrationIntent(projectDir: string, intent: MigrationIntent): void {
  const expected = migrationPaths(resolve(projectDir), intent.migrationId);
  for (const key of [
    'sourcePath', 'sourceSnapshotPath', 'sourceBackupPath', 'shadowPath', 'finalPath',
  ] as const) {
    if (resolve(intent[key]) !== expected[key]) {
      throw new StateMigrationError(
        'MIGRATION_STATE_CONFLICT',
        `Migration ${key} was not derived from the authenticated Project identity.`,
      );
    }
  }
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
  migrationId: string,
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
      archiveHandle: legacyArchiveHandle(migrationId, entry.relativePath),
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
): Promise<Pick<
  MigrationValidationDiagnostics,
  'importBatches' | 'carrierLeaseRenewals' | 'maxImportBatchSize'
>> {
  let importBatches = 0;
  let carrierLeaseRenewals = 0;
  let maxImportBatchSize = 0;
  const sessions = input.importedState.sessions.length > 0
    ? input.importedState.sessions
    : [{
        id: `legacy-session-${input.migrationId.slice(0, 16)}`,
        projectKey: `legacy-source:${input.sourceDigest}`,
        projectRoot: `legacy-source://${input.sourceDigest}`,
        title: 'Legacy import',
        userId: null, mode: 'read', messages: [],
        record: {
          id: `legacy-session-${input.migrationId.slice(0, 16)}`,
          title: 'Legacy import', mode: 'read', messages: [],
          tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, aborted: false,
        } satisfies AgentSession,
        archived: false,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        lastMessageAt: null,
      }];
  const sessionIds = new Set(sessions.map(({ id }) => id));
  const firstSessionId = sessions[0]!.id;
  const targetSessionId = (sessionId: string | null | undefined) =>
    sessionIds.has(sessionId ?? '') ? sessionId! : firstSessionId;
  const runsBySession = groupByTarget(input.importedState.runs, (run) =>
    targetSessionId(run.sessionId));
  const preferencesBySession = groupByTarget(input.importedState.preferences, (preference) =>
    targetSessionId(preference.sourceSessionId));
  const checkpointsBySession = groupByTarget(input.importedState.checkpoints, (checkpoint) =>
    targetSessionId(checkpoint.sessionId));
  const subagentsBySession = groupByTarget(input.importedState.subagents, (subagent) =>
    targetSessionId(subagent.parentSessionId));
  for (const session of sessions) {
    if (session.record === undefined || session.archived === undefined ||
      session.createdAt === undefined || session.updatedAt === undefined ||
      session.lastMessageAt === undefined) {
      throw new StateMigrationError(
        'MIGRATION_VALIDATION_FAILED',
        `Legacy Session ${session.id} was not normalized to the current import schema.`,
      );
    }
    const projectId = legacyProjectId(session.projectKey, session.projectRoot);
    const clientRequestId = sha256(`legacy carrier\0${input.migrationId}\0${session.id}`);
    const created = await journal.createRun({
      projectId, sessionId: session.id, clientRequestId,
      input: { legacyMigrationId: input.migrationId },
    });
    let lease = await journal.acquireRunLease({
      projectId, runId: created.runId,
      ownerId: `legacy-migration:${input.migrationId.slice(0, 24)}`, ttlMs: 60_000,
    });
    const facts = legacyFactsForSession({
      session,
      runs: runsBySession.get(session.id) ?? [],
      preferences: preferencesBySession.get(session.id) ?? [],
      checkpoints: checkpointsBySession.get(session.id) ?? [],
      subagents: subagentsBySession.get(session.id) ?? [],
      diagnostics: session.id === firstSessionId ? input.importedState.diagnostics : [],
      archives: session.id === firstSessionId ? input.archives : [],
      plan: input.importedState.plan,
    });
    let offset = 0;
    let batch: AgentEventPayloadMap['legacy.imported'][] = [];
    const commitBatch = async () => {
      if (batch.length === 0) return;
      maxImportBatchSize = Math.max(maxImportBatchSize, batch.length);
      importBatches += 1;
      lease = await journal.renewRunLease({
        projectId,
        runId: created.runId,
        ownerId: lease.ownerId,
        fencingToken: lease.fencingToken,
        ttlMs: 60_000,
      });
      carrierLeaseRenewals += 1;
      const projection = await journal.getRunProjection(created.runId);
      if (projection === null) throw new Error('Synthetic legacy Run projection is missing.');
      const events: AgentEventDraft[] = batch.map((payload) => ({
        type: 'legacy.imported', payload,
      }));
      await writer.commit({
          projectId, sessionId: session.id, runId: created.runId,
          commandId: `legacy-import:${input.migrationId}:${sha256(session.id).slice(0, 16)}:${offset}`,
          lease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken },
          expectedRunRevision: projection.revision,
          events,
      });
      offset += batch.length;
      batch = [];
    };
    for (const fact of facts) {
      batch.push(fact);
      if (batch.length === 500) await commitBatch();
    }
    await commitBatch();
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
  return { importBatches, carrierLeaseRenewals, maxImportBatchSize };
}

function groupByTarget<T>(items: readonly T[], target: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = target(item);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [item]);
    else group.push(item);
  }
  return groups;
}

function* legacyFactsForSession(input: {
  session: ImportedLegacyState['sessions'][number];
  runs: ImportedLegacyState['runs'];
  preferences: ImportedLegacyState['preferences'];
  checkpoints: ImportedLegacyState['checkpoints'];
  subagents: ImportedLegacyState['subagents'];
  diagnostics: ImportedLegacyState['diagnostics'];
  archives: MaterializedLegacyArchive[];
  plan: PortableValue | null;
}): Generator<AgentEventPayloadMap['legacy.imported']> {
  const { session } = input;
  if (session.record === undefined || session.archived === undefined ||
    session.createdAt === undefined || session.updatedAt === undefined ||
    session.lastMessageAt === undefined) {
    throw new Error(`Legacy Session ${session.id} was not normalized.`);
  }
  yield {
    entityType: 'session', legacyId: session.id,
    projectKey: session.projectKey, projectRoot: session.projectRoot,
    record: {
      session: { ...structuredClone(session.record), messages: [] },
      archived: session.archived, createdAt: session.createdAt,
      updatedAt: session.updatedAt, lastMessageAt: session.lastMessageAt,
    },
  };
  for (const message of session.messages) yield {
    entityType: 'message', legacyId: `${session.id}:${message.messageIndex}`,
    messageIndex: message.messageIndex,
    sourceRunId: message.sourceRunId ?? `legacy-session:${session.id}`,
    record: legacyMessageRecord(message),
  };
  for (const run of input.runs) {
    if (!('phase' in run)) throw new Error('Legacy Run was not normalized.');
    yield {
      entityType: 'run', legacyId: run.runId, record: structuredClone(run),
      sourceStatus: run.status, legacyPlan: input.plan,
    };
  }
  for (const preference of input.preferences) {
    if (preference.createdAt === undefined || preference.updatedAt === undefined) {
      throw new Error('Legacy preference was not normalized.');
    }
    const record: AgentUserPreference = {
      id: preference.id, userId: preference.userId, key: preference.key,
      value: preference.value, confidence: preference.confidence,
      ...(preference.sourceSessionId === null ? {} : { sourceSessionId: preference.sourceSessionId }),
      ...(preference.evidence === undefined ? {} : { evidence: preference.evidence }),
      createdAt: preference.createdAt, updatedAt: preference.updatedAt,
    };
    yield { entityType: 'preference', legacyId: preference.id, record };
  }
  for (const checkpoint of input.checkpoints) {
    if (checkpoint.record === undefined) throw new Error('Legacy Checkpoint was not normalized.');
    yield {
      entityType: 'checkpoint', legacyId: `${checkpoint.sessionId}:${checkpoint.sequence}`,
      sessionId: checkpoint.sessionId, record: structuredClone(checkpoint.record),
    };
  }
  for (const subagent of input.subagents) {
    if (!('task' in subagent)) throw new Error('Legacy subagent was not normalized.');
    yield { entityType: 'subagent', legacyId: subagent.id, record: structuredClone(subagent) };
  }
  for (const [index, diagnostic] of input.diagnostics.entries()) yield {
    entityType: 'diagnostic', legacyId: `diagnostic:${index}:${diagnostic.code}`,
    code: diagnostic.code, evidence: diagnostic.evidence,
  };
  for (const archive of input.archives) yield {
    entityType: 'archive', legacyId: archive.relativePath, relativePath: archive.relativePath,
    archiveHandle: archive.archiveHandle, checksum: archive.checksum, byteSize: archive.byteSize,
  };
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

function legacyMessageRecord(
  message: AgentMessage & { messageIndex: number; sourceRunId?: string },
): AgentMessage {
  const { messageIndex, sourceRunId, ...record } = message;
  void messageIndex;
  void sourceRunId;
  return structuredClone(record);
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
    case 'session': {
      const record = parsePortableLegacySession(payload.record.session);
      state.sessions.push({
        id: payload.legacyId,
        projectKey: payload.projectKey,
        projectRoot: payload.projectRoot,
        title: record.title,
        userId: record.userId ?? null,
        mode: record.mode,
        messages: [],
        record,
        archived: payload.record.archived,
        createdAt: payload.record.createdAt,
        updatedAt: payload.record.updatedAt,
        lastMessageAt: payload.record.lastMessageAt,
      });
      return;
    }
    case 'message': {
      const sessionId = payload.legacyId.slice(0, payload.legacyId.lastIndexOf(':'));
      const session = state.sessions.find(({ id }) => id === sessionId);
      const record = parsePortableLegacyMessage(payload.record);
      session?.messages.push({
        ...record,
        messageIndex: payload.messageIndex,
        sourceRunId: payload.sourceRunId,
      });
      session?.record?.messages.push(structuredClone(record));
      return;
    }
    case 'run':
      state.runs.push(parseLegacyRunRecord(canonicalJson(payload.record)));
      state.plan ??= payload.legacyPlan;
      return;
    case 'preference': {
      const record = parsePortableLegacyPreference(payload.record);
      state.preferences.push({
        ...record,
        sourceSessionId: record.sourceSessionId ?? null,
      });
      return;
    }
    case 'checkpoint': {
      const record = parsePortableLegacyCheckpoint(payload.record);
      state.checkpoints.push({
        sessionId: payload.sessionId,
        sequence: record.sequence,
        summary: record.summary,
        createdAt: record.createdAt,
        record,
      });
      return;
    }
    case 'subagent':
      state.subagents.push(parsePortableLegacySubagent(payload.record));
      return;
    case 'diagnostic':
      state.diagnostics.push({ code: payload.code, evidence: payload.evidence });
      return;
    case 'archive':
      return;
    default:
      return assertNever(payload);
  }
}

function firstLegacyPlan(runs: ImportedLegacyState['runs']): PortableValue | null {
  const run = runs.find((candidate) => 'plan' in candidate && candidate.plan !== null);
  return run !== undefined && 'plan' in run ? run.plan : null;
}

function parsePortableLegacySession(value: AgentSession): AgentSession {
  return parseLegacySessionRecord(canonicalJson(value), []);
}

function parsePortableLegacyMessage(value: AgentMessage): AgentMessage {
  const record = requireLegacyRecord(value, 'Legacy Message record');
  const role = requireLegacyEnum(record.role, ['user', 'assistant', 'tool', 'system'], 'Message role');
  const content = typeof record.content === 'string'
    ? record.content
    : (() => { throw new TypeError('Legacy Message content must be a string.'); })();
  const createdAt = requireLegacyIso(record.createdAt, 'Message createdAt');
  if (role === 'assistant') {
    assertLegacyExactKeys(record, ['role', 'content', 'toolCalls', 'createdAt'], 'Assistant Message');
    return {
      role,
      content,
      ...(record.toolCalls === undefined
        ? {}
        : { toolCalls: parseLegacyToolCalls(canonicalJson(record.toolCalls)) }),
      createdAt,
    };
  }
  if (role === 'tool') {
    assertLegacyExactKeys(
      record, ['role', 'toolCallId', 'toolName', 'content', 'createdAt'], 'Tool Message',
    );
    return {
      role,
      toolCallId: requireLegacyText(record.toolCallId, 'Tool Message toolCallId'),
      toolName: requireLegacyText(record.toolName, 'Tool Message toolName'),
      content,
      createdAt,
    };
  }
  assertLegacyExactKeys(record, ['role', 'content', 'createdAt'], 'Legacy Message');
  return { role, content, createdAt } as AgentMessage;
}

function parsePortableLegacyPreference(value: AgentUserPreference): AgentUserPreference {
  const record = requireLegacyRecord(value, 'Legacy preference record');
  assertLegacyExactKeys(record, [
    'id', 'userId', 'key', 'value', 'confidence', 'sourceSessionId', 'evidence',
    'createdAt', 'updatedAt',
  ], 'Legacy preference record');
  return {
    id: requireLegacyText(record.id, 'Preference id'),
    userId: requireLegacyText(record.userId, 'Preference userId'),
    key: requireLegacyText(record.key, 'Preference key'),
    value: requireLegacyText(record.value, 'Preference value'),
    confidence: requireLegacyFinite(record.confidence, 'Preference confidence'),
    ...(record.sourceSessionId === undefined
      ? {}
      : { sourceSessionId: requireLegacyText(record.sourceSessionId, 'Preference sourceSessionId') }),
    ...(record.evidence === undefined
      ? {}
      : { evidence: requireLegacyText(record.evidence, 'Preference evidence') }),
    createdAt: requireLegacyIso(record.createdAt, 'Preference createdAt'),
    updatedAt: requireLegacyIso(record.updatedAt, 'Preference updatedAt'),
  };
}

function parsePortableLegacyCheckpoint(value: AgentContextCheckpoint): AgentContextCheckpoint {
  const record = requireLegacyRecord(value, 'Legacy Checkpoint record');
  assertLegacyExactKeys(record, [
    'version', 'sequence', 'trigger', 'method', 'summary', 'coveredConversationMessageCount',
    'sourceTokenEstimate', 'summaryTokenEstimate', 'modelContextTokens', 'createdAt', 'focus',
  ], 'Legacy Checkpoint record');
  const version = requireLegacyInteger(record.version, 'Checkpoint version');
  if (version !== 1) throw new TypeError('Legacy Checkpoint version is unsupported.');
  const modelContextTokens = record.modelContextTokens === null
    ? null
    : requireLegacyInteger(record.modelContextTokens, 'Checkpoint modelContextTokens');
  return {
    version: 1,
    sequence: requireLegacyInteger(record.sequence, 'Checkpoint sequence'),
    trigger: requireLegacyEnum(record.trigger, ['auto', 'manual'], 'Checkpoint trigger') as
      AgentContextCheckpoint['trigger'],
    method: requireLegacyEnum(
      record.method, ['model', 'deterministic-fallback'], 'Checkpoint method',
    ) as AgentContextCheckpoint['method'],
    summary: requireLegacyText(record.summary, 'Checkpoint summary'),
    coveredConversationMessageCount: requireLegacyInteger(
      record.coveredConversationMessageCount, 'Checkpoint coveredConversationMessageCount',
    ),
    sourceTokenEstimate: requireLegacyInteger(record.sourceTokenEstimate, 'Checkpoint sourceTokenEstimate'),
    summaryTokenEstimate: requireLegacyInteger(record.summaryTokenEstimate, 'Checkpoint summaryTokenEstimate'),
    modelContextTokens,
    createdAt: requireLegacyIso(record.createdAt, 'Checkpoint createdAt'),
    ...(record.focus === undefined ? {} : { focus: requireLegacyText(record.focus, 'Checkpoint focus') }),
  };
}

function parsePortableLegacySubagent(value: AgentSubagentRecord): AgentSubagentRecord {
  const record = requireLegacyRecord(value, 'Legacy subagent record');
  assertLegacyExactKeys(record, [
    'id', 'parentSessionId', 'childSessionId', 'task', 'contextStrategy', 'status', 'depth',
    'summary', 'artifactReferences', 'errorMessage', 'createdAt', 'updatedAt',
  ], 'Legacy subagent record');
  const artifactReferences = record.artifactReferences;
  if (artifactReferences !== undefined && (!Array.isArray(artifactReferences) ||
    artifactReferences.some((reference) => typeof reference !== 'string'))) {
    throw new TypeError('Legacy subagent artifactReferences are invalid.');
  }
  return {
    id: requireLegacyText(record.id, 'Subagent id'),
    parentSessionId: requireLegacyText(record.parentSessionId, 'Subagent parentSessionId'),
    ...(record.childSessionId === undefined
      ? {}
      : { childSessionId: requireLegacyText(record.childSessionId, 'Subagent childSessionId') }),
    task: requireLegacyText(record.task, 'Subagent task'),
    contextStrategy: requireLegacyEnum(record.contextStrategy, ['fresh', 'fork'], 'Subagent contextStrategy') as
      AgentSubagentRecord['contextStrategy'],
    status: requireLegacyEnum(record.status, ['running', 'completed', 'failed', 'cancelled'], 'Subagent status') as
      AgentSubagentRecord['status'],
    depth: requireLegacyInteger(record.depth, 'Subagent depth'),
    ...(record.summary === undefined ? {} : { summary: requireLegacyText(record.summary, 'Subagent summary') }),
    ...(artifactReferences === undefined ? {} : { artifactReferences: [...artifactReferences] as string[] }),
    ...(record.errorMessage === undefined
      ? {}
      : { errorMessage: requireLegacyText(record.errorMessage, 'Subagent errorMessage') }),
    createdAt: requireLegacyIso(record.createdAt, 'Subagent createdAt'),
    updatedAt: requireLegacyIso(record.updatedAt, 'Subagent updatedAt'),
  };
}

function assertNever(value: never): never {
  throw new TypeError(`Unhandled legacy import variant: ${String(value)}`);
}

async function assertLiveLegacyStillMatches(
  projectDir: string,
  intent: MigrationIntent,
): Promise<void> {
  if (!(await pathExists(intent.sourcePath))) return;
  const liveState = readLegacyState(intent.sourcePath);
  bindFallbackProjectIdentity(liveState, intent.sourceDigest);
  normalizeLegacyContractState(liveState);
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

async function hashFileHandle(file: FileHandle): Promise<string> {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (true) {
    const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, position);
    if (bytesRead === 0) return hash.digest('hex');
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
}

async function* streamFileHandle(
  file: FileHandle,
  expectedByteSize: number,
  expectedChecksum: string,
  baseline: Awaited<ReturnType<FileHandle['stat']>>,
): AsyncIterable<Uint8Array> {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const hash = createHash('sha256');
  let position = 0;
  try {
    while (position < expectedByteSize) {
      const requested = Math.min(buffer.byteLength, expectedByteSize - position);
      const { bytesRead } = await file.read(buffer, 0, requested, position);
      if (bytesRead === 0) {
        throw new StateMigrationError(
          'MIGRATION_VALIDATION_FAILED',
          'Legacy archive bytes changed while streaming.',
        );
      }
      position += bytesRead;
      const emitted = buffer.subarray(0, bytesRead);
      hash.update(emitted);
      yield new Uint8Array(emitted);
    }
    const extra = Buffer.allocUnsafe(1);
    const extraRead = await file.read(extra, 0, 1, expectedByteSize);
    const after = await file.stat();
    if (extraRead.bytesRead !== 0 || !sameFileGeneration(baseline, after) ||
      after.size !== expectedByteSize || hash.digest('hex') !== expectedChecksum) {
      throw new StateMigrationError(
        'MIGRATION_VALIDATION_FAILED',
        'Legacy archive bytes changed or failed terminal integrity validation.',
      );
    }
  } catch (error) {
    if (error instanceof StateMigrationError) throw error;
    throw new StateMigrationError(
      'MIGRATION_VALIDATION_FAILED',
      `Legacy archive bytes could not be streamed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await file.close();
  }
}

function sameFileGeneration(
  before: {
    dev: number | bigint; ino: number | bigint; size: number | bigint;
    mtimeMs: number | bigint;
  },
  after: {
    dev: number | bigint; ino: number | bigint; size: number | bigint;
    mtimeMs: number | bigint;
  },
): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mtimeMs === after.mtimeMs;
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

function requireMigrationPageLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new StateMigrationError('INVALID_ARGUMENT', 'Page limit must be between 1 and 1000.');
  }
}

function parseLegacyStateCursor(cursor: string | null): {
  projectIndex: number;
  afterSequence: number;
} {
  if (cursor === null) return { projectIndex: 0, afterSequence: 0 };
  const match = /^(0|[1-9]\d*):(0|[1-9]\d*)$/u.exec(cursor);
  if (match === null) {
    throw new StateMigrationError('INVALID_ARGUMENT', 'Legacy state cursor is invalid.');
  }
  const projectIndex = Number(match[1]);
  const afterSequence = Number(match[2]);
  if (!Number.isSafeInteger(projectIndex) || !Number.isSafeInteger(afterSequence)) {
    throw new StateMigrationError('INVALID_ARGUMENT', 'Legacy state cursor is invalid.');
  }
  return { projectIndex, afterSequence };
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

function legacyArchiveHandle(migrationId: string, relativePath: string): string {
  return `legacy-archive:${sha256(`${migrationId}\0${relativePath}`)}`;
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
