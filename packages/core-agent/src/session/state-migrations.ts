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
  LegacyAgentContextCheckpoint as AgentContextCheckpoint,
  LegacyAgentMessage as AgentMessage,
  LegacyAgentRunRecord as AgentRunRecord,
  LegacyAgentSession as AgentSession,
  LegacyAgentSubagentRecord as AgentSubagentRecord,
  LegacyAgentUserPreference as AgentUserPreference,
} from './legacy-import-types.js';
import {
  createLegacyMigrationWriter,
  type LegacyMigrationWriter,
} from '../internal/legacy-migration-writer.js';
import {
  acquireExclusiveStateWriterGate,
  acquireMigrationOwnerGate,
} from './state-writer-gate.js';

type NodeSqlite = {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => NodeDatabaseSync;
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
  maxRetainedValidationScopes: number;
  maxImportHashProjects: number;
  maxValidationFactProjects: number;
  maxSourceEntityBufferSize: number;
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
               max_active_projection_accumulators, max_retained_validation_scopes,
               max_import_hash_projects, max_validation_fact_projects,
               max_source_entity_buffer_size
        FROM legacy_imports WHERE migration_id = ?
      `).get(this.#intent.migrationId) as {
        project_passes: number;
        max_page_size: number;
        import_batches: number;
        carrier_lease_renewals: number;
        max_import_batch_size: number;
        max_active_projection_sessions: number;
        max_active_projection_accumulators: number;
        max_retained_validation_scopes: number;
        max_import_hash_projects: number;
        max_validation_fact_projects: number;
        max_source_entity_buffer_size: number;
      };
      return {
        projectPasses: Number(row.project_passes),
        maxPageSize: Number(row.max_page_size),
        importBatches: Number(row.import_batches),
        carrierLeaseRenewals: Number(row.carrier_lease_renewals),
        maxImportBatchSize: Number(row.max_import_batch_size),
        maxActiveProjectionSessions: Number(row.max_active_projection_sessions),
        maxActiveProjectionAccumulators: Number(row.max_active_projection_accumulators),
        maxRetainedValidationScopes: Number(row.max_retained_validation_scopes),
        maxImportHashProjects: Number(row.max_import_hash_projects),
        maxValidationFactProjects: Number(row.max_validation_fact_projects),
        maxSourceEntityBufferSize: Number(row.max_source_entity_buffer_size),
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

  const projectIds = readLegacyProjectIds(sourceSnapshotPath, sourceDigest);
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
    'importBatches' | 'carrierLeaseRenewals' | 'maxImportBatchSize' |
    'maxImportHashProjects' | 'maxSourceEntityBufferSize'
  > & { importedStateDigest: string; validationCounts: LegacyValidationCounts };
  try {
    importDiagnostics = await importLegacyFacts(journal, migrationWriter, {
      migrationId, sourceDigest, sourcePath: sourceSnapshotPath, archives, projectIds,
    });
  } finally {
    migrationWriter.seal();
  }
  const importedStateDigest = importDiagnostics.importedStateDigest;
  const validationReport = {
    schemaVersion: 1,
    status: 'validated',
    ...importDiagnostics.validationCounts,
    archiveCount: manifest.length - 1,
    importedStateDigest,
    manifestDigest: sha256(canonicalJson(manifest)),
  };
  const validationDigest = sha256(canonicalJson(validationReport));
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
        max_retained_validation_scopes INTEGER NOT NULL DEFAULT 0,
        max_import_hash_projects INTEGER NOT NULL DEFAULT 0,
        max_validation_fact_projects INTEGER NOT NULL DEFAULT 0,
        max_source_entity_buffer_size INTEGER NOT NULL DEFAULT 0,
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
          carrier_lease_renewals, max_import_batch_size, max_import_hash_projects,
          max_source_entity_buffer_size, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        migrationId, canonicalJson(projectIds), eventCount,
        importDiagnostics.importBatches, importDiagnostics.carrierLeaseRenewals,
        importDiagnostics.maxImportBatchSize,
        importDiagnostics.maxImportHashProjects,
        importDiagnostics.maxSourceEntityBufferSize,
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

type LegacySessionBundle = {
  session: ImportedLegacyState['sessions'][number];
  messages: Iterable<AgentMessage & { messageIndex: number; sourceRunId: string }>;
  runs: Iterable<ImportedLegacyState['runs'][number]>;
  preferences: Iterable<ImportedLegacyState['preferences'][number]>;
  checkpoints: Iterable<ImportedLegacyState['checkpoints'][number]>;
  subagents: Iterable<ImportedLegacyState['subagents'][number]>;
  diagnostics: Iterable<ImportedLegacyState['diagnostics'][number]>;
  plan: PortableValue | null;
};

function readLegacyProjectIds(path: string, sourceDigest: string): string[] {
  return withDatabase(path, (database) => {
    if (!tableExists(database, 'agent_sessions')) {
      return [legacyProjectId(`legacy-source:${sourceDigest}`, `legacy-source://${sourceDigest}`)];
    }
    const columns = tableColumnNames(database, 'agent_sessions');
    const projectIds = new Set<string>();
    const rows = database.prepare(`
      SELECT id,
        ${columns.has('project_key') ? 'project_key' : 'NULL AS project_key'},
        ${columns.has('project_root') ? 'project_root' : 'NULL AS project_root'},
        json_remove(payload_json, '$.messages') AS payload_json
      FROM agent_sessions ORDER BY id
    `)
      .iterate() as unknown as Iterable<Record<string, unknown>>;
    for (const row of rows) {
      const payloadJson = requireLegacyText(row.payload_json, 'Session payload_json');
      const identity = legacyProjectIdentityFromRow(row, payloadJson, sourceDigest);
      projectIds.add(legacyProjectId(identity.projectKey, identity.projectRoot));
    }
    if (projectIds.size === 0) {
      projectIds.add(legacyProjectId(
        `legacy-source:${sourceDigest}`, `legacy-source://${sourceDigest}`,
      ));
    }
    return [...projectIds].sort();
  });
}

function* streamLegacySessionBundles(
  path: string,
  sourceDigest: string,
  projectId: string,
  includeGlobalForFirstBundle: boolean,
): Generator<LegacySessionBundle> {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const sessionIds = tableExists(database, 'agent_sessions')
      ? database.prepare('SELECT id FROM agent_sessions ORDER BY id')
        .iterate() as unknown as Iterable<{ id: string }>
      : [];
    let yielded = false;
    let sawSession = false;
    for (const { id: rawId } of sessionIds) {
      sawSession = true;
      const id = requireLegacyText(rawId, 'Session id');
      const session = readLegacySessionMetadata(database, id, sourceDigest);
      if (legacyProjectId(session.projectKey, session.projectRoot) !== projectId) continue;
      const sourceRunId = latestLegacyRunIdFromDatabase(database, id) ?? `legacy-session:${id}`;
      assertLegacyToolCallLinks(database, id);
      const isFirst = includeGlobalForFirstBundle && !yielded;
      yielded = true;
      yield {
        session,
        messages: iterateLegacyMessages(database, id, sourceRunId),
        runs: iterateLegacyRuns(database, id),
        preferences: iterateLegacyPreferences(database, id, isFirst),
        checkpoints: iterateLegacyContextCheckpoints(database, id),
        subagents: iterateLegacySubagents(database, id),
        diagnostics: iterateLegacyDiagnostics(database, id, isFirst),
        plan: firstLegacyPlanFromDatabase(database, id),
      };
    }
    if (!yielded && !sawSession) {
      const id = `legacy-session-${sourceDigest.slice(0, 16)}`;
      const fallbackProjectId = legacyProjectId(
        `legacy-source:${sourceDigest}`, `legacy-source://${sourceDigest}`,
      );
      if (projectId !== fallbackProjectId) return;
      yield {
        session: {
          id, projectKey: `legacy-source:${sourceDigest}`,
          projectRoot: `legacy-source://${sourceDigest}`,
          title: 'Legacy import', userId: null, mode: 'default', messages: [],
          record: {
            id, title: 'Legacy import', mode: 'default', messages: [],
            tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, aborted: false,
          },
          archived: false, createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(), lastMessageAt: null,
        },
        messages: [], runs: [], preferences: [], checkpoints: [], subagents: [],
        diagnostics: iterateLegacyDiagnostics(database, id, true), plan: null,
      };
    }
  } finally {
    database.close();
  }
}

function* iterateLegacyMessages(
  database: NodeDatabaseSync,
  sessionId: string,
  sourceRunId: string,
): Generator<AgentMessage & { messageIndex: number; sourceRunId: string }> {
  if (!tableExists(database, 'agent_session_messages')) return;
  const rows = database.prepare(`
    SELECT session_id, message_index, role, content, created_at,
           tool_call_id, tool_name, tool_calls_json
    FROM agent_session_messages WHERE session_id = ? ORDER BY message_index
  `).iterate(sessionId) as unknown as Iterable<LegacyMessageRow>;
  let previousIndex = -1;
  for (const row of rows) {
    const messageIndex = requireLegacyInteger(row.message_index, 'Message message_index');
    if (messageIndex <= previousIndex) throw new TypeError('Legacy Message order is invalid.');
    previousIndex = messageIndex;
    yield { ...legacyMessageFromRow(row), sourceRunId };
  }
}

function* iterateLegacyRuns(
  database: NodeDatabaseSync,
  sessionId: string,
): Generator<ImportedLegacyState['runs'][number]> {
  if (!tableExists(database, 'agent_runs')) return;
  const columns = tableColumnNames(database, 'agent_runs');
  if (columns.has('payload_json')) {
    const rows = database.prepare(`SELECT * FROM agent_runs
      WHERE session_id = ? ORDER BY run_id`).iterate(sessionId) as unknown as
      Iterable<Record<string, unknown>>;
    for (const row of rows) {
      const record = parseLegacyRunRecord(requireLegacyText(row.payload_json, 'Run payload_json'));
      if (record.runId !== requireLegacyText(row.run_id, 'Run run_id') ||
        record.sessionId !== requireLegacyText(row.session_id, 'Run session_id') ||
        record.status !== requireLegacyText(row.status, 'Run status') ||
        record.phase !== requireLegacyText(row.phase, 'Run phase') ||
        record.iteration !== requireLegacyInteger(row.iteration, 'Run iteration') ||
        record.createdAt !== requireLegacyIso(row.created_at, 'Run created_at') ||
        record.updatedAt !== requireLegacyIso(row.updated_at, 'Run updated_at')) {
        throw new TypeError(`Legacy Run ${record.runId} payload disagrees with its columns.`);
      }
      yield record;
    }
    return;
  }
  const required = ['run_id', 'session_id', 'status', 'created_at', 'updated_at'];
  if (required.some((column) => !columns.has(column))) {
    throw new TypeError('Legacy Run table has an unsupported historical layout.');
  }
  const planExpression = columns.has('plan_json') ? 'plan_json' : 'NULL AS plan_json';
  const rows = database.prepare(`
    SELECT run_id, session_id, status, ${planExpression}, created_at, updated_at
    FROM agent_runs WHERE session_id = ? ORDER BY run_id
  `).iterate(sessionId) as unknown as Iterable<{
    run_id: string; session_id: string; status: string; plan_json: string | null;
    created_at: string; updated_at: string;
  }>;
  for (const run of rows) {
    const completed = run.status === 'completed';
    yield {
      runId: requireLegacyText(run.run_id, 'Run run_id'),
      sessionId: requireLegacyText(run.session_id, 'Run session_id'),
      status: completed ? 'done' : 'interrupted', phase: completed ? 'done' : 'verify',
      iteration: 0, finalText: '', toolExecutions: [],
      ...(completed ? {} : { errorMessage: 'Legacy Run was interrupted during migration.' }),
      createdAt: requireLegacyIso(run.created_at, 'Run created_at'),
      updatedAt: requireLegacyIso(run.updated_at, 'Run updated_at'),
    };
  }
}

function latestLegacyRunIdFromDatabase(
  database: NodeDatabaseSync,
  sessionId: string,
): string | undefined {
  if (!tableExists(database, 'agent_runs')) return undefined;
  const row = database.prepare(`
    SELECT run_id FROM agent_runs WHERE session_id = ?
    ORDER BY updated_at DESC, run_id ASC LIMIT 1
  `).get(sessionId) as { run_id: string } | undefined;
  return row === undefined ? undefined : requireLegacyText(row.run_id, 'Run run_id');
}

function firstLegacyPlanFromDatabase(database: NodeDatabaseSync, sessionId: string): PortableValue | null {
  if (!tableExists(database, 'agent_runs') || !tableColumnNames(database, 'agent_runs').has('plan_json')) {
    return null;
  }
  const rows = database.prepare(`
    SELECT plan_json FROM agent_runs
    WHERE session_id = ? AND plan_json IS NOT NULL ORDER BY run_id
  `).iterate(sessionId) as unknown as Iterable<{ plan_json: string }>;
  for (const row of rows) return parseNullableJson(row.plan_json);
  return null;
}

function* iterateLegacyPreferences(
  database: NodeDatabaseSync,
  sessionId: string,
  includeUnscoped: boolean,
): Generator<ImportedLegacyState['preferences'][number]> {
  if (!tableExists(database, 'agent_user_preferences')) return;
  const columns = tableColumnNames(database, 'agent_user_preferences');
  const rows = database.prepare(`SELECT * FROM agent_user_preferences
    WHERE source_session_id = ? ${includeUnscoped ? 'OR source_session_id IS NULL' : ''}
    ORDER BY id`).iterate(sessionId) as unknown as Iterable<Record<string, unknown>>;
  const epoch = new Date(0).toISOString();
  for (const row of rows) yield {
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
    createdAt: columns.has('created_at')
      ? requireLegacyIso(row.created_at, 'Preference created_at')
      : epoch,
    updatedAt: columns.has('updated_at')
      ? requireLegacyIso(row.updated_at, 'Preference updated_at')
      : epoch,
  };
}

function* iterateLegacyContextCheckpoints(
  database: NodeDatabaseSync,
  sessionId: string,
): Generator<ImportedLegacyState['checkpoints'][number]> {
  if (!tableExists(database, 'agent_context_checkpoints')) return;
  const columns = tableColumnNames(database, 'agent_context_checkpoints');
  const rows = database.prepare(`
    SELECT * FROM agent_context_checkpoints WHERE session_id = ? ORDER BY sequence
  `).iterate(sessionId) as unknown as Iterable<Record<string, unknown>>;
  for (const row of rows) {
    const sequence = requireLegacyInteger(row.sequence, 'Checkpoint sequence');
    const summary = requireLegacyText(row.summary, 'Checkpoint summary');
    const createdAt = requireLegacyIso(row.created_at, 'Checkpoint created_at');
    if (!columns.has('trigger')) {
      yield {
        sessionId, sequence, summary, createdAt,
        record: {
          version: 1, sequence, trigger: 'auto', method: 'deterministic-fallback', summary,
          coveredConversationMessageCount: 0, sourceTokenEstimate: 0,
          summaryTokenEstimate: 0, modelContextTokens: null, createdAt,
        },
      };
      continue;
    }
    const trigger = requireLegacyEnum(row.trigger, ['auto', 'manual', 'automatic'], 'Checkpoint trigger');
    const record: AgentContextCheckpoint = {
      version: requireLegacyInteger(row.version, 'Checkpoint version') as 1,
      sequence, trigger: trigger === 'automatic' ? 'auto' : trigger as 'auto' | 'manual',
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
    yield { sessionId, sequence, summary, createdAt, record };
  }
}

function* iterateLegacySubagents(
  database: NodeDatabaseSync,
  sessionId: string,
): Generator<ImportedLegacyState['subagents'][number]> {
  if (!tableExists(database, 'agent_subagents')) return;
  const columns = tableColumnNames(database, 'agent_subagents');
  const rows = database.prepare(`SELECT * FROM agent_subagents
    WHERE parent_session_id = ? ORDER BY id`).iterate(sessionId) as unknown as
    Iterable<Record<string, unknown>>;
  const epoch = new Date(0).toISOString();
  for (const row of rows) {
    const base = {
      id: requireLegacyText(row.id, 'Subagent id'),
      parentSessionId: requireLegacyText(row.parent_session_id, 'Subagent parent_session_id'),
      ...(row.child_session_id === null
        ? {}
        : { childSessionId: requireLegacyText(row.child_session_id, 'Subagent child_session_id') }),
    };
    if (!columns.has('task')) {
      yield {
        ...base, task: 'Legacy subagent task unavailable', contextStrategy: 'fresh',
        status: normalizeLegacySubagentStatus(requireLegacyText(row.status, 'Subagent status')),
        depth: requireLegacyInteger(row.depth, 'Subagent depth'), createdAt: epoch, updatedAt: epoch,
      };
      continue;
    }
    const artifactReferences = parseStrictPortableJson(
      requireLegacyText(row.artifact_references_json, 'Subagent artifact_references_json'),
      'Subagent artifact references',
    );
    if (!Array.isArray(artifactReferences) ||
      artifactReferences.some((reference) => typeof reference !== 'string')) {
      throw new TypeError('Legacy Subagent artifact references are invalid.');
    }
    yield {
      ...base, task: requireLegacyText(row.task, 'Subagent task'),
      contextStrategy: normalizeLegacyContextStrategy(row.context_strategy),
      status: requireLegacyEnum(
        row.status, ['running', 'completed', 'failed', 'cancelled'], 'Subagent status',
      ) as AgentSubagentRecord['status'],
      depth: requireLegacyInteger(row.depth, 'Subagent depth'),
      ...(row.summary === null ? {} : { summary: requireLegacyText(row.summary, 'Subagent summary') }),
      ...(artifactReferences.length === 0 ? {} : { artifactReferences: artifactReferences as string[] }),
      ...(row.error_message === null
        ? {}
        : { errorMessage: requireLegacyText(row.error_message, 'Subagent error_message') }),
      createdAt: requireLegacyIso(row.created_at, 'Subagent created_at'),
      updatedAt: requireLegacyIso(row.updated_at, 'Subagent updated_at'),
    };
  }
}

function assertLegacyToolCallLinks(database: NodeDatabaseSync, sessionId: string): void {
  if (!tableExists(database, 'agent_session_messages')) return;
  const duplicate = database.prepare(`
    SELECT json_extract(call.value, '$.id') AS call_id
    FROM agent_session_messages AS message, json_each(message.tool_calls_json) AS call
    WHERE message.session_id = ? AND message.role = 'assistant'
    GROUP BY call_id HAVING COUNT(*) > 1 LIMIT 1
  `).get(sessionId) as { call_id: string } | undefined;
  if (duplicate !== undefined) {
    throw new StateMigrationError(
      'MIGRATION_VALIDATION_FAILED', `Legacy ToolCall id is duplicated: ${duplicate.call_id}.`,
    );
  }
  const invalid = database.prepare(`
    SELECT result.tool_call_id
    FROM agent_session_messages AS result
    WHERE result.session_id = ? AND result.role = 'tool' AND (
      (SELECT COUNT(*) FROM agent_session_messages AS owner, json_each(owner.tool_calls_json) AS call
       WHERE owner.session_id = result.session_id AND owner.role = 'assistant'
         AND json_extract(call.value, '$.id') = result.tool_call_id
         AND json_extract(call.value, '$.name') = result.tool_name) != 1
      OR
      (SELECT COUNT(*) FROM agent_session_messages AS sibling
       WHERE sibling.session_id = result.session_id AND sibling.role = 'tool'
         AND sibling.tool_call_id = result.tool_call_id) != 1
    ) LIMIT 1
  `).get(sessionId) as { tool_call_id: string } | undefined;
  if (invalid !== undefined) {
    throw new StateMigrationError(
      'MIGRATION_VALIDATION_FAILED',
      `Legacy Tool result identity is invalid: ${invalid.tool_call_id}.`,
    );
  }
}

function* iterateLegacyDiagnostics(
  database: NodeDatabaseSync,
  sessionId: string,
  includeGlobal: boolean,
): Generator<ImportedLegacyState['diagnostics'][number]> {
  if (includeGlobal && tableExists(database, 'legacy_runtime_diagnostics')) {
    const rows = database.prepare(`
      SELECT kind, durable_evidence FROM legacy_runtime_diagnostics ORDER BY kind
    `).iterate() as unknown as Iterable<{ kind: string; durable_evidence: string }>;
    for (const row of rows) yield {
      code: row.kind === 'approval' ? 'LEGACY_APPROVAL_EXPIRED' : 'LEGACY_RESULT_HANDLE_EXPIRED',
      evidence: row.durable_evidence,
    };
  }
  if (!tableExists(database, 'agent_session_messages')) return;
  const unresolved = database.prepare(`
    SELECT json_extract(call.value, '$.id') AS call_id,
           json_extract(call.value, '$.name') AS call_name
    FROM agent_session_messages AS message, json_each(message.tool_calls_json) AS call
    WHERE message.session_id = ? AND message.role = 'assistant' AND NOT EXISTS (
      SELECT 1 FROM agent_session_messages AS result
      WHERE result.session_id = message.session_id AND result.role = 'tool'
        AND result.tool_call_id = json_extract(call.value, '$.id')
        AND result.tool_name = json_extract(call.value, '$.name')
    ) ORDER BY message.message_index, call.key
  `).iterate(sessionId) as unknown as Iterable<{ call_id: string; call_name: string }>;
  for (const row of unresolved) yield {
    code: 'LEGACY_TOOL_OUTCOME_UNKNOWN',
    evidence: `Session ${sessionId} was interrupted before ToolCall ${row.call_id} (${row.call_name}) recorded a result.`,
  };
}

function assertLegacyRelationships(path: string): void {
  withDatabase(path, (database) => {
    const orphanRun = tableExists(database, 'agent_runs') && database.prepare(`
      SELECT 1 FROM agent_runs AS child
      WHERE NOT EXISTS (SELECT 1 FROM agent_sessions AS parent WHERE parent.id = child.session_id)
      LIMIT 1
    `).get() !== undefined;
    const orphanCheckpoint = tableExists(database, 'agent_context_checkpoints') && database.prepare(`
      SELECT 1 FROM agent_context_checkpoints AS child
      WHERE NOT EXISTS (SELECT 1 FROM agent_sessions AS parent WHERE parent.id = child.session_id)
      LIMIT 1
    `).get() !== undefined;
    const orphanSubagent = tableExists(database, 'agent_subagents') && database.prepare(`
      SELECT 1 FROM agent_subagents AS child
      WHERE NOT EXISTS (
        SELECT 1 FROM agent_sessions AS parent WHERE parent.id = child.parent_session_id
      ) OR (child.child_session_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM agent_sessions AS nested WHERE nested.id = child.child_session_id
      )) LIMIT 1
    `).get() !== undefined;
    const orphanMessage = tableExists(database, 'agent_session_messages') && database.prepare(`
      SELECT 1 FROM agent_session_messages AS child
      WHERE NOT EXISTS (SELECT 1 FROM agent_sessions AS parent WHERE parent.id = child.session_id)
      LIMIT 1
    `).get() !== undefined;
    if (orphanRun || orphanCheckpoint || orphanSubagent || orphanMessage) {
      throw new StateMigrationError(
        'MIGRATION_VALIDATION_FAILED',
        'Legacy entity relationship points outside imported Sessions.',
      );
    }
  });
}

function parseLegacySessionMetadata(payloadJson: string): AgentSession {
  const value = parseStrictPortableJson(payloadJson, 'Session payload_json');
  const record = requireLegacyRecord(value, 'Session payload_json');
  assertLegacyExactKeys(record, [
    'id', 'title', 'userId', 'mode', 'tokenUsage', 'modelBinding', 'project',
    'taskPlan', 'artifacts', 'toolActivations', 'activeSkills', 'sessionSkills', 'subagentDepth',
    'capabilityStates', 'contextCheckpoint', 'aborted',
  ], 'Session payload_json');
  const result = { ...record, messages: [] } as unknown as AgentSession;
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

function readLegacySessionMetadata(
  database: NodeDatabaseSync,
  id: string,
  sourceDigest: string,
): ImportedLegacyState['sessions'][number] {
  const columns = tableColumnNames(database, 'agent_sessions');
  const modern = columns.has('message_count') && columns.has('prompt_tokens');
  const row = database.prepare(`
    SELECT id, title, user_id, mode,
      ${columns.has('project_key') ? 'project_key' : 'NULL AS project_key'},
      ${columns.has('project_root') ? 'project_root' : 'NULL AS project_root'},
      ${columns.has('archived') ? 'archived' : '0 AS archived'},
      ${columns.has('created_at') ? 'created_at' : 'NULL AS created_at'},
      ${columns.has('updated_at') ? 'updated_at' : 'NULL AS updated_at'},
      ${columns.has('last_message_at') ? 'last_message_at' : 'NULL AS last_message_at'},
      ${modern ? 'message_count, prompt_tokens, completion_tokens, total_tokens,' : ''}
      json_remove(payload_json, '$.messages') AS payload_json
    FROM agent_sessions WHERE id = ?
  `).get(id) as Record<string, unknown> | undefined;
  if (row === undefined) throw new TypeError(`Legacy Session ${id} disappeared.`);
  const payloadJson = requireLegacyText(row.payload_json, 'Session payload_json');
  const identity = legacyProjectIdentityFromRow(row, payloadJson, sourceDigest);
  const messageCount = tableExists(database, 'agent_session_messages')
    ? Number((database.prepare(`
        SELECT COUNT(*) AS count FROM agent_session_messages WHERE session_id = ?
      `).get(id) as { count: number }).count)
    : 0;
  const userId = row.user_id === null ? undefined : requireLegacyText(row.user_id, 'Session user_id');
  if (modern) {
    const metadata = parseLegacySessionMetadata(payloadJson);
    if (metadata.id !== id || metadata.title !== requireLegacyText(row.title, 'Session title') ||
      metadata.mode !== requireLegacyText(row.mode, 'Session mode') || metadata.userId !== userId ||
      messageCount !== requireLegacyInteger(row.message_count, 'Session message_count') ||
      metadata.tokenUsage.promptTokens !== requireLegacyInteger(row.prompt_tokens, 'prompt_tokens') ||
      metadata.tokenUsage.completionTokens !== requireLegacyInteger(row.completion_tokens, 'completion_tokens') ||
      metadata.tokenUsage.totalTokens !== requireLegacyInteger(row.total_tokens, 'total_tokens')) {
      throw new TypeError(`Legacy Session ${id} payload disagrees with its columns.`);
    }
    return {
      id, ...identity, title: metadata.title, userId: metadata.userId ?? null,
      mode: normalizeLegacyMode(metadata.mode), messages: [], record: metadata,
      archived: requireLegacyInteger(row.archived, 'Session archived') === 1,
      createdAt: requireLegacyIso(row.created_at, 'Session created_at'),
      updatedAt: requireLegacyIso(row.updated_at, 'Session updated_at'),
      lastMessageAt: row.last_message_at === null ? null : requireLegacyIso(row.last_message_at, 'Session last_message_at'),
    };
  }
  const epoch = new Date(0).toISOString();
  const bounds = tableExists(database, 'agent_session_messages')
    ? database.prepare(`SELECT MIN(created_at) AS first_at, MAX(created_at) AS last_at
        FROM agent_session_messages WHERE session_id = ?`).get(id) as {
        first_at: string | null; last_at: string | null;
      }
    : { first_at: null, last_at: null };
  const mode = normalizeLegacyMode(requireLegacyText(row.mode, 'Session mode'));
  const record: AgentSession = {
    id, title: requireLegacyText(row.title, 'Session title'), ...(userId === undefined ? {} : { userId }),
    mode, messages: [], tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, aborted: false,
  };
  return {
    id, ...identity, title: record.title, userId: userId ?? null, mode, messages: [], record,
    archived: false, createdAt: bounds.first_at ?? epoch,
    updatedAt: bounds.last_at ?? bounds.first_at ?? epoch, lastMessageAt: bounds.last_at,
  };
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

function legacyProjectIdentityFromRow(
  row: Record<string, unknown>,
  payloadJson: string,
  sourceDigest?: string,
): { projectKey: string; projectRoot: string } {
  const fallback = legacyProjectIdentity(payloadJson);
  const identity = {
    projectKey: typeof row.project_key === 'string' && row.project_key.length > 0
      ? row.project_key
      : fallback.projectKey,
    projectRoot: typeof row.project_root === 'string' && row.project_root.length > 0
      ? row.project_root
      : fallback.projectRoot,
  };
  return sourceDigest !== undefined && identity.projectKey === 'legacy-default' &&
    identity.projectRoot === 'legacy://default'
    ? { projectKey: `legacy-source:${sourceDigest}`, projectRoot: `legacy-source://${sourceDigest}` }
    : identity;
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
    withDatabase(path, (database) => {
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
      const prefixSummary = database.prepare(`
        SELECT COUNT(*) AS project_count, COALESCE(SUM(event_count), 0) AS event_count
        FROM legacy_import_prefixes WHERE migration_id = ?
      `).get(intent.migrationId) as { project_count: number; event_count: number };
      if (Number(prefixSummary.project_count) !== intent.projectIds.length ||
        Number(prefixSummary.event_count) !== Number(imported.event_count)) {
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
        SELECT COUNT(DISTINCT runs.run_id) AS carrier_count,
               COALESCE(SUM(CASE WHEN runs.state NOT IN ('Completed', 'Failed', 'Cancelled')
                 OR runs.hidden <> 1 THEN 1 ELSE 0 END), 0) AS invalid_count
        FROM agent_runs AS runs
        JOIN agent_events AS events
          ON events.project_id = runs.project_id AND events.run_id = runs.run_id
        WHERE events.event_type = 'run.created'
          AND json_extract(events.payload_json, '$.visibility') = 'legacy-import-carrier'
      `).get() as { carrier_count: number; invalid_count: number };
      if (Number(carriers.carrier_count) === 0 || Number(carriers.invalid_count) !== 0) {
        throw new Error('Synthetic legacy carrier Runs are not terminal and hidden.');
      }
      return undefined;
    });

    const journal = new SqliteAgentJournal({ filePath: path });
    const importedStateHash = createHash('sha256');
    let projectPasses = 0;
    let maxPageSize = 0;
    let maxActiveProjectionSessions = 0;
    let maxActiveProjectionAccumulators = 0;
    let maxRetainedValidationScopes = 0;
    for (const projectId of intent.projectIds) {
      const expectedPrefix = withDatabase(path, (database) => database.prepare(`
        SELECT project_id, max_sequence, event_count, prefix_digest
        FROM legacy_import_prefixes WHERE migration_id = ? AND project_id = ?
      `).get(intent.migrationId, projectId) as {
        project_id: string;
        max_sequence: number;
        event_count: number;
        prefix_digest: string;
      } | undefined);
      if (expectedPrefix === undefined) throw new Error('Legacy import Project prefix is missing.');
      const prefixHash = createHash('sha256');
      const factHash = createHash('sha256');
      let prefixEventCount = 0;
      let factCount = 0;
      projectPasses += 1;
      const causalValidator = new ProjectionEventValidator(projectId, { trustedJournal: true });
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
          const retained = causalValidator.retainedScopes();
          maxRetainedValidationScopes = Math.max(
            maxRetainedValidationScopes,
            Object.values(retained).reduce((count, current) => count + current, 0),
          );
          if (event.type === 'legacy.imported') {
            factHash.update(canonicalJson(event.payload));
            factHash.update('\n');
            factCount += 1;
          }
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
      importedStateHash.update(canonicalJson({
        projectId, count: factCount, digest: factHash.digest('hex'),
      }));
      importedStateHash.update('\n');
      for (const projection of projections.values()) {
        projection.accumulators.forEach((accumulator) => accumulator.finish());
      }
    }
    if (!requireSealed) {
      withDatabase(path, (database) => {
        database.prepare(`
          UPDATE legacy_imports SET project_passes = ?, max_page_size = ?,
            max_active_projection_sessions = ?, max_active_projection_accumulators = ?,
            max_retained_validation_scopes = ?, max_validation_fact_projects = ?
          WHERE migration_id = ?
        `).run(
          projectPasses, maxPageSize, maxActiveProjectionSessions,
          maxActiveProjectionAccumulators, maxRetainedValidationScopes,
          intent.projectIds.length === 0 ? 0 : 1, intent.migrationId,
        );
        database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      });
    }
    if (importedStateHash.digest('hex') !== intent.importedStateDigest) {
      throw new Error('Imported legacy state digest changed.');
    }
    if (sha256(canonicalJson(JSON.parse(row.validation_report_json) as unknown)) !==
      intent.validationDigest) {
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

function normalizeLegacyMode(mode: string): AgentSession['mode'] {
  if (mode === 'auto' || mode === 'full-access') return mode;
  if (mode === 'full') return 'full-access';
  return 'default';
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
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const rows = database.prepare(`
    SELECT relative_path, object_relative_path, archive_handle, checksum, byte_size
    FROM legacy_archives WHERE migration_id = ? ORDER BY relative_path
  `).iterate(intent.migrationId) as unknown as Iterable<{
    relative_path: string;
    object_relative_path: string;
    archive_handle: string;
    checksum: string;
    byte_size: number;
  }>;
  const expected = intent.manifest.filter(({ relativePath }) => relativePath !== 'state.source.db');
  let index = 0;
  try {
    for (const row of rows) {
      const entry = expected[index++];
      if (entry === undefined || row.relative_path !== entry.relativePath ||
        row.checksum !== entry.checksum || Number(row.byte_size) !== entry.byteSize ||
        row.archive_handle !== legacyArchiveHandle(intent.migrationId, entry.relativePath)) {
        throw new Error('Legacy archive metadata changed.');
      }
      const archivePath = containedMigrationPath(projectDir, row.object_relative_path);
      const metadata = await stat(archivePath);
      if (metadata.size !== entry.byteSize || await hashFile(archivePath) !== entry.checksum) {
        throw new Error(`Legacy archive bytes changed: ${entry.relativePath}`);
      }
    }
  } finally {
    database.close();
  }
  if (index !== expected.length) throw new Error('Legacy archive count changed.');
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

type LegacyValidationCounts = {
  sessionCount: number;
  messageCount: number;
  runCount: number;
  completedRunCount: number;
  interruptedRunCount: number;
  preferenceCount: number;
  checkpointCount: number;
  subagentCount: number;
};

async function importLegacyFacts(
  journal: SqliteAgentJournal,
  writer: LegacyMigrationWriter,
  input: {
    migrationId: string;
    sourceDigest: string;
    sourcePath: string;
    archives: MaterializedLegacyArchive[];
    projectIds: string[];
  },
): Promise<Pick<
  MigrationValidationDiagnostics,
  'importBatches' | 'carrierLeaseRenewals' | 'maxImportBatchSize' |
  'maxImportHashProjects' | 'maxSourceEntityBufferSize'
> & { importedStateDigest: string; validationCounts: LegacyValidationCounts }> {
  let importBatches = 0;
  let carrierLeaseRenewals = 0;
  let maxImportBatchSize = 0;
  const validationCounts: LegacyValidationCounts = {
    sessionCount: 0, messageCount: 0, runCount: 0, completedRunCount: 0,
    interruptedRunCount: 0, preferenceCount: 0, checkpointCount: 0, subagentCount: 0,
  };
  assertLegacyRelationships(input.sourcePath);
  let bundleIndex = 0;
  const stateHash = createHash('sha256');
  for (const expectedProjectId of input.projectIds) {
    const factHash = createHash('sha256');
    let factCount = 0;
    let projectSessionCount = 0;
    for (const bundle of streamLegacySessionBundles(
      input.sourcePath, input.sourceDigest, expectedProjectId, bundleIndex === 0,
    )) {
    const { session } = bundle;
    if (session.record === undefined || session.archived === undefined ||
      session.createdAt === undefined || session.updatedAt === undefined ||
      session.lastMessageAt === undefined) {
      throw new StateMigrationError(
        'MIGRATION_VALIDATION_FAILED',
        `Legacy Session ${session.id} was not normalized to the current import schema.`,
      );
    }
    const projectId = legacyProjectId(session.projectKey, session.projectRoot);
    if (projectId !== expectedProjectId) throw new Error('Legacy Project stream changed.');
    projectSessionCount += 1;
    validationCounts.sessionCount += 1;
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
      messages: bundle.messages,
      runs: bundle.runs,
      preferences: bundle.preferences,
      checkpoints: bundle.checkpoints,
      subagents: bundle.subagents,
      diagnostics: bundle.diagnostics,
      archives: bundleIndex === 0 ? input.archives : [],
      plan: bundle.plan,
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
      factHash.update(canonicalJson(fact));
      factHash.update('\n');
      factCount += 1;
      if (fact.entityType === 'message') validationCounts.messageCount += 1;
      else if (fact.entityType === 'run') {
        validationCounts.runCount += 1;
        if (fact.sourceStatus === 'done') validationCounts.completedRunCount += 1;
        else if (fact.sourceStatus === 'interrupted') validationCounts.interruptedRunCount += 1;
      } else if (fact.entityType === 'preference') validationCounts.preferenceCount += 1;
      else if (fact.entityType === 'checkpoint') validationCounts.checkpointCount += 1;
      else if (fact.entityType === 'subagent') validationCounts.subagentCount += 1;
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
    bundleIndex += 1;
    }
    if (projectSessionCount === 0) {
      throw new StateMigrationError(
        'MIGRATION_VALIDATION_FAILED', 'Legacy Project isolation map changed.',
      );
    }
    stateHash.update(canonicalJson({
      projectId: expectedProjectId, count: factCount, digest: factHash.digest('hex'),
    }));
    stateHash.update('\n');
  }
  return {
    importBatches,
    carrierLeaseRenewals,
    maxImportBatchSize,
    maxImportHashProjects: input.projectIds.length === 0 ? 0 : 1,
    maxSourceEntityBufferSize: bundleIndex === 0 ? 0 : 1,
    importedStateDigest: stateHash.digest('hex'),
    validationCounts,
  };
}

function* legacyFactsForSession(input: {
  session: ImportedLegacyState['sessions'][number];
  messages: Iterable<AgentMessage & { messageIndex: number; sourceRunId: string }>;
  runs: Iterable<ImportedLegacyState['runs'][number]>;
  preferences: Iterable<ImportedLegacyState['preferences'][number]>;
  checkpoints: Iterable<ImportedLegacyState['checkpoints'][number]>;
  subagents: Iterable<ImportedLegacyState['subagents'][number]>;
  diagnostics: Iterable<ImportedLegacyState['diagnostics'][number]>;
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
  for (const message of input.messages) yield {
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
  let diagnosticIndex = 0;
  for (const diagnostic of input.diagnostics) {
    yield {
      entityType: 'diagnostic', legacyId: `diagnostic:${diagnosticIndex}:${diagnostic.code}`,
      code: diagnostic.code, evidence: diagnostic.evidence,
    };
    diagnosticIndex += 1;
  }
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

async function assertLiveLegacyStillMatches(
  projectDir: string,
  intent: MigrationIntent,
): Promise<void> {
  if (!(await pathExists(intent.sourcePath))) return;
  const currentManifest = await createSourceManifest(projectDir, intent.sourceSnapshotPath);
  const expectedState = intent.manifest.find(({ relativePath }) => relativePath === 'state.source.db');
  const liveSnapshot = join(projectDir, `state.live-check.${process.pid}.db.tmp`);
  const liveDatabase = new DatabaseSync(intent.sourcePath, { readOnly: true });
  try {
    await nodeSqlite.backup(liveDatabase, liveSnapshot);
  } finally {
    liveDatabase.close();
  }
  const liveMetadata = await stat(liveSnapshot);
  const expectedSides = intent.manifest.filter(({ relativePath }) => relativePath !== 'state.source.db');
  const currentSides = currentManifest.filter(({ relativePath }) => relativePath !== 'state.source.db');
  try {
    if (expectedState === undefined || liveMetadata.size !== expectedState.byteSize ||
      await hashFile(liveSnapshot) !== expectedState.checksum ||
      canonicalJson(currentSides) !== canonicalJson(expectedSides)) {
      throw new StateMigrationError(
        'MIGRATION_STATE_CONFLICT',
        'Live legacy state changed after Shadow validation.',
        inspectionFromIntent(intent, intent.status),
      );
    }
  } finally {
    await rm(liveSnapshot, { force: true });
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
