import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';

type NodeDatabaseSyncConstructor = new (
  location: string,
  options?: { readOnly?: boolean },
) => NodeDatabaseSync;

export type StateWriterGate = {
  readFence(): StateWriterFence;
  persistMigrationSealed(migrationId: string, sourceDigest: string): void;
  persistActive(migrationId: string, sourceDigest: string): void;
  persistLegacyWritable(migrationId: string, sourceDigest: string): void;
  close(): void;
};

export type StateWriterFence = {
  phase: 'legacy-writable' | 'migration-sealed' | 'active';
  migrationId?: string;
  sourceDigest?: string;
};

export class StateWriterGateError extends Error {
  readonly code = 'STATE_MIGRATION_ACTIVE';

  constructor() {
    super('STATE_MIGRATION_ACTIVE: legacy Project state is already migrated and read-only.');
    this.name = 'StateWriterGateError';
  }
}

const WRITER_GATE_FILE = 'state.writer-gate.db';
const MIGRATION_OWNER_GATE_FILE = 'state.migration-owner-gate.db';

export function acquireSharedStateWriterGate(projectDir: string): StateWriterGate {
  const resolvedProjectDir = resolve(projectDir);
  const gate = acquireGate(resolvedProjectDir, 'shared', 5_000);
  try {
    if (gate.readFence().phase !== 'legacy-writable') throw new StateWriterGateError();
    return gate;
  } catch (error) {
    gate.close();
    throw error;
  }
}

export function acquireExclusiveStateWriterGate(projectDir: string): StateWriterGate {
  return acquireGate(resolve(projectDir), 'exclusive', 5_000);
}

export function acquireMigrationOwnerGate(projectDir: string): StateWriterGate {
  return acquireRawGate(join(resolve(projectDir), MIGRATION_OWNER_GATE_FILE), 'exclusive', 100);
}

export function readStateWriterFence(projectDir: string): StateWriterFence {
  const resolvedProjectDir = resolve(projectDir);
  mkdirSync(resolvedProjectDir, { recursive: true });
  const database = openDatabase(join(resolvedProjectDir, WRITER_GATE_FILE));
  try {
    ensureWriterFenceSchema(database, resolvedProjectDir);
    return readFence(database);
  } finally {
    database.close();
  }
}

export function legacyProjectDirForSidecar(filePath: string, directoryName: string): string {
  const parent = dirname(resolve(filePath));
  return basename(parent) === directoryName ? dirname(parent) : parent;
}

export function legacyProjectDirForArtifactRoot(rootDir: string): string {
  return dirname(resolve(rootDir));
}

function activeMigrationFromState(projectDir: string): {
  migrationId: string;
  sourceDigest: string;
} | undefined {
  const statePath = join(projectDir, 'state.db');
  if (!existsSync(statePath)) return undefined;
  const sqliteModuleId = ['node', 'sqlite'].join(':');
  const { DatabaseSync } = createRequire(import.meta.url)(sqliteModuleId) as {
    DatabaseSync: NodeDatabaseSyncConstructor;
  };
  const database = new DatabaseSync(statePath, { readOnly: true });
  try {
    const schema = database.prepare(`
      SELECT 1 AS present FROM sqlite_schema
      WHERE type = 'table' AND name = 'schema_migrations'
    `).get() as { present: number } | undefined;
    if (schema === undefined) return undefined;
    const columns = new Set(
      (database.prepare('PRAGMA table_info(schema_migrations)').all() as unknown as
        Array<{ name: string }>).map(({ name }) => name),
    );
    if (!columns.has('migration_id') || !columns.has('source_digest')) {
      const active = database.prepare(`
        SELECT 1 AS present FROM schema_migrations WHERE status = 'active' LIMIT 1
      `).get() as { present: number } | undefined;
      return active === undefined
        ? undefined
        : { migrationId: 'legacy-active-state', sourceDigest: 'legacy-active-state' };
    }
    return database.prepare(`
      SELECT migration_id AS migrationId, source_digest AS sourceDigest FROM schema_migrations
      WHERE status = 'active' LIMIT 1
    `).get() as { migrationId: string; sourceDigest: string } | undefined;
  } finally {
    database.close();
  }
}

function acquireGate(
  projectDir: string,
  mode: 'shared' | 'exclusive',
  busyTimeoutMs: number,
): StateWriterGate {
  const path = join(projectDir, WRITER_GATE_FILE);
  mkdirSync(projectDir, { recursive: true });
  const database = openDatabase(path);
  database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  ensureWriterFenceSchema(database, projectDir);
  const gate = beginGate(database, mode, busyTimeoutMs);
  const persist = (
    phase: StateWriterFence['phase'],
    migrationId: string,
    sourceDigest: string,
  ) => {
    if (mode !== 'exclusive') throw new Error('Writer fence transitions require the exclusive gate.');
    const current = readFence(database);
    if (current.phase !== 'legacy-writable' &&
      (current.migrationId !== migrationId || current.sourceDigest !== sourceDigest)) {
      throw new Error('Writer fence migration identity conflicts with the active transition.');
    }
    database.prepare(`
      UPDATE state_writer_fence
      SET phase = ?, migration_id = ?, source_digest = ?
      WHERE id = 1
    `).run(phase, migrationId, sourceDigest);
    database.exec('COMMIT');
    database.exec('BEGIN EXCLUSIVE');
  };
  return {
    ...gate,
    readFence: () => readFence(database),
    persistMigrationSealed: (migrationId, sourceDigest) =>
      persist('migration-sealed', migrationId, sourceDigest),
    persistActive: (migrationId, sourceDigest) => persist('active', migrationId, sourceDigest),
    persistLegacyWritable: (migrationId, sourceDigest) =>
      persist('legacy-writable', migrationId, sourceDigest),
  };
}

function acquireRawGate(
  path: string,
  mode: 'shared' | 'exclusive',
  busyTimeoutMs: number,
): StateWriterGate {
  mkdirSync(dirname(path), { recursive: true });
  const database = openDatabase(path);
  const gate = beginGate(database, mode, busyTimeoutMs);
  const unsupported = () => {
    throw new Error('Migration-owner gate does not own the writer fence.');
  };
  return {
    ...gate,
    readFence: unsupported,
    persistMigrationSealed: unsupported,
    persistActive: unsupported,
    persistLegacyWritable: unsupported,
  };
}

function openDatabase(path: string): NodeDatabaseSync {
  const sqliteModuleId = ['node', 'sqlite'].join(':');
  const { DatabaseSync } = createRequire(import.meta.url)(sqliteModuleId) as {
    DatabaseSync: NodeDatabaseSyncConstructor;
  };
  return new DatabaseSync(path);
}

function beginGate(
  database: NodeDatabaseSync,
  mode: 'shared' | 'exclusive',
  busyTimeoutMs: number,
): Pick<StateWriterGate, 'close'> {
  let transactionOpen = false;
  try {
    database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    database.exec(mode === 'exclusive' ? 'BEGIN EXCLUSIVE' : 'BEGIN');
    transactionOpen = true;
    database.prepare('SELECT COUNT(*) AS count FROM sqlite_schema').get();
  } catch (error) {
    try {
      if (transactionOpen) database.exec('ROLLBACK');
    } finally {
      database.close();
    }
    throw error;
  }
  let closed = false;
  return {
    close() {
      if (closed) return;
      closed = true;
      try {
        database.exec('COMMIT');
      } finally {
        database.close();
      }
    },
  };
}

function ensureWriterFenceSchema(database: NodeDatabaseSync, projectDir: string): void {
  const schema = database.prepare(`
    SELECT 1 AS present FROM sqlite_schema
    WHERE type = 'table' AND name = 'state_writer_fence'
  `).get() as { present: number } | undefined;
  if (schema === undefined) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS state_writer_fence (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        phase TEXT NOT NULL CHECK (phase IN ('legacy-writable', 'migration-sealed', 'active')),
        migration_id TEXT,
        source_digest TEXT,
        CHECK (
          (phase = 'legacy-writable') OR
          (migration_id IS NOT NULL AND source_digest IS NOT NULL)
        )
      );
      INSERT OR IGNORE INTO state_writer_fence (id, phase) VALUES (1, 'legacy-writable');
    `);
  }
  const active = activeMigrationFromState(projectDir);
  if (active !== undefined && readFence(database).phase === 'legacy-writable') {
    database.prepare(`
      UPDATE state_writer_fence
      SET phase = 'active', migration_id = ?, source_digest = ? WHERE id = 1
    `).run(active.migrationId, active.sourceDigest);
  }
}

function readFence(database: NodeDatabaseSync): StateWriterFence {
  const row = database.prepare(`
    SELECT phase, migration_id, source_digest FROM state_writer_fence WHERE id = 1
  `).get() as {
    phase: StateWriterFence['phase'];
    migration_id: string | null;
    source_digest: string | null;
  };
  return {
    phase: row.phase,
    ...(row.migration_id === null ? {} : { migrationId: row.migration_id }),
    ...(row.source_digest === null ? {} : { sourceDigest: row.source_digest }),
  };
}
