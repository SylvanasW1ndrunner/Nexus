import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';
import { DatabaseResultStoreError } from './result-store.js';

const CURRENT_SCHEMA_VERSION = 3;
const sqliteModuleId: string = 'node:sqlite';
const { DatabaseSync } = createRequire(import.meta.url)(sqliteModuleId) as {
  DatabaseSync: new (path: string) => NodeDatabaseSync;
};

export function withResultStoreDatabase<T>(
  path: string,
  operation: (database: NodeDatabaseSync) => T,
): T {
  let database: NodeDatabaseSync | undefined;
  try {
    mkdirSync(dirname(path), { recursive: true });
    database = new DatabaseSync(path);
    initializeResultStoreDatabase(database);
    return operation(database);
  } catch (error) {
    if (error instanceof DatabaseResultStoreError) throw error;
    throw new DatabaseResultStoreError(
      'STORAGE_FAILURE',
      'The database result metadata store is unavailable.',
      { cause: error },
    );
  } finally {
    try {
      database?.close();
    } catch {
      // Closing is best-effort after the operation result has already been decided.
    }
  }
}

export function inImmediateTransaction<T>(database: NodeDatabaseSync, operation: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Preserve the operation error; the connection is closed by the caller.
    }
    throw error;
  }
}

function initializeResultStoreDatabase(database: NodeDatabaseSync): void {
  database.exec('PRAGMA busy_timeout = 5000');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA synchronous = FULL');
  const row = database.prepare('PRAGMA user_version').get() as { user_version: number };
  if (row.user_version > CURRENT_SCHEMA_VERSION) {
    throw new DatabaseResultStoreError(
      'UNSUPPORTED_SCHEMA',
      `Result store schema ${row.user_version} is newer than supported schema ${CURRENT_SCHEMA_VERSION}.`,
    );
  }
  if (row.user_version === 0) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS database_results (
        result_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        project_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        format TEXT NOT NULL,
        columns_json TEXT NOT NULL,
        availability TEXT NOT NULL,
        checksum TEXT,
        row_count INTEGER NOT NULL DEFAULT 0,
        byte_count INTEGER NOT NULL DEFAULT 0,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        has_more INTEGER,
        truncated INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_accessed_at TEXT NOT NULL,
        expires_at TEXT,
        expiration_reason TEXT
      );
      CREATE TABLE IF NOT EXISTS database_result_chunks (
        result_id TEXT NOT NULL REFERENCES database_results(result_id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        row_offset INTEGER NOT NULL,
        row_count INTEGER NOT NULL,
        checksum TEXT NOT NULL,
        byte_count INTEGER NOT NULL,
        object_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (result_id, ordinal)
      );
      CREATE INDEX IF NOT EXISTS database_results_project_status_idx
        ON database_results(project_id, availability, last_accessed_at);
      CREATE INDEX IF NOT EXISTS database_result_chunks_checksum_idx
        ON database_result_chunks(checksum);
      CREATE TABLE IF NOT EXISTS database_result_exports (
        artifact_id TEXT PRIMARY KEY,
        result_id TEXT NOT NULL REFERENCES database_results(result_id) ON DELETE CASCADE,
        project_id TEXT NOT NULL,
        format TEXT NOT NULL,
        checksum TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        media_type TEXT NOT NULL,
        object_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT
      );
      CREATE INDEX IF NOT EXISTS database_result_exports_checksum_idx
        ON database_result_exports(checksum);
      PRAGMA user_version = 1;
    `);
  }
  if (row.user_version <= 1) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS database_result_leases (
        lease_id TEXT PRIMARY KEY,
        result_id TEXT NOT NULL REFERENCES database_results(result_id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS database_result_leases_result_expiry_idx
        ON database_result_leases(result_id, expires_at);
      PRAGMA user_version = 2;
    `);
  }
  if (row.user_version <= 2) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS database_result_append_operations (
        result_id TEXT NOT NULL REFERENCES database_results(result_id) ON DELETE CASCADE,
        operation_id TEXT NOT NULL,
        input_checksum TEXT NOT NULL,
        first_ordinal INTEGER NOT NULL,
        chunk_count INTEGER NOT NULL,
        row_count_before INTEGER NOT NULL,
        row_count_after INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (result_id, operation_id)
      );
      PRAGMA user_version = ${CURRENT_SCHEMA_VERSION};
    `);
  }
}
