import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';

type NodeDatabaseSyncConstructor = new (
  location: string,
  options?: { readOnly?: boolean },
) => NodeDatabaseSync;

export type StateWriterGate = {
  close(): void;
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
  const gate = acquireGate(join(resolvedProjectDir, WRITER_GATE_FILE), 'shared', 5_000);
  try {
    assertLegacyProjectWritable(resolvedProjectDir);
    return gate;
  } catch (error) {
    gate.close();
    throw error;
  }
}

export function acquireExclusiveStateWriterGate(projectDir: string): StateWriterGate {
  return acquireGate(join(resolve(projectDir), WRITER_GATE_FILE), 'exclusive', 5_000);
}

export function acquireMigrationOwnerGate(projectDir: string): StateWriterGate {
  return acquireGate(join(resolve(projectDir), MIGRATION_OWNER_GATE_FILE), 'exclusive', 100);
}

export function legacyProjectDirForSidecar(filePath: string, directoryName: string): string {
  const parent = dirname(resolve(filePath));
  return basename(parent) === directoryName ? dirname(parent) : parent;
}

export function legacyProjectDirForArtifactRoot(rootDir: string): string {
  return dirname(resolve(rootDir));
}

function assertLegacyProjectWritable(projectDir: string): void {
  const statePath = join(projectDir, 'state.db');
  if (!existsSync(statePath)) return;
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
    if (schema === undefined) return;
    const active = database.prepare(`
      SELECT 1 AS active FROM schema_migrations WHERE status = 'active' LIMIT 1
    `).get() as { active: number } | undefined;
    if (active !== undefined) throw new StateWriterGateError();
  } finally {
    database.close();
  }
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
