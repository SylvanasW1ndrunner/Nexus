import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';

type NodeDatabaseSyncConstructor = new (location: string) => NodeDatabaseSync;

export type StateWriterGate = {
  close(): void;
};

const WRITER_GATE_FILE = 'state.writer-gate.db';
const MIGRATION_OWNER_GATE_FILE = 'state.migration-owner-gate.db';

export function acquireSharedStateWriterGate(projectDir: string): StateWriterGate {
  return acquireGate(join(resolve(projectDir), WRITER_GATE_FILE), 'shared', 5_000);
}

export function acquireExclusiveStateWriterGate(projectDir: string): StateWriterGate {
  return acquireGate(join(resolve(projectDir), WRITER_GATE_FILE), 'exclusive', 5_000);
}

export function acquireMigrationOwnerGate(projectDir: string): StateWriterGate {
  return acquireGate(join(resolve(projectDir), MIGRATION_OWNER_GATE_FILE), 'exclusive', 100);
}

function acquireGate(
  path: string,
  mode: 'shared' | 'exclusive',
  busyTimeoutMs: number,
): StateWriterGate {
  mkdirSync(dirname(path), { recursive: true });
  const sqliteModuleId = ['node', 'sqlite'].join(':');
  const { DatabaseSync } = createRequire(import.meta.url)(sqliteModuleId) as {
    DatabaseSync: NodeDatabaseSyncConstructor;
  };
  const database = new DatabaseSync(path);
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
