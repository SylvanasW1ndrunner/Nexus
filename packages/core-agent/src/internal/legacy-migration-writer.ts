import { createRequire } from 'node:module';
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';
import type { JournalCommand, JournalCommitResult } from '../events/agent-journal.js';
import type { SqliteAgentJournal } from '../events/sqlite-agent-journal.js';

type NodeDatabaseSyncConstructor = new (location: string) => NodeDatabaseSync;

export type LegacyMigrationIdentity = Readonly<{
  migrationId: string;
  sourceDigest: string;
}>;

export type LegacyMigrationWriter = Readonly<{
  commit(command: JournalCommand): Promise<JournalCommitResult>;
  seal(): void;
}>;

const activeIdentities = new WeakMap<SqliteAgentJournal, LegacyMigrationIdentity>();

export function createLegacyMigrationWriter(
  journal: SqliteAgentJournal,
  identity: LegacyMigrationIdentity,
): LegacyMigrationWriter {
  if (!isDigest(identity.migrationId) || !isDigest(identity.sourceDigest)) {
    throw new TypeError('Validated legacy migration identity is required.');
  }
  const frozenIdentity = Object.freeze({ ...identity });
  claimShadowAuthority(journal.filePath, frozenIdentity);
  activeIdentities.set(journal, frozenIdentity);
  let sealed = false;
  return Object.freeze({
    commit(command: JournalCommand) {
      if (sealed) return Promise.reject(new TypeError('Legacy migration writer is sealed.'));
      return journal.commit(command);
    },
    seal() {
      if (sealed) return;
      sealed = true;
      activeIdentities.delete(journal);
    },
  });
}

/** @internal Runtime check used only by SqliteAgentJournal's reserved commit boundary. */
export function activeLegacyMigrationIdentity(
  journal: SqliteAgentJournal,
): LegacyMigrationIdentity | undefined {
  return activeIdentities.get(journal);
}

function claimShadowAuthority(path: string, identity: LegacyMigrationIdentity): void {
  const sqliteModuleId = ['node', 'sqlite'].join(':');
  const { DatabaseSync } = createRequire(import.meta.url)(sqliteModuleId) as {
    DatabaseSync: NodeDatabaseSyncConstructor;
  };
  const database = new DatabaseSync(path);
  try {
    database.exec('BEGIN IMMEDIATE');
    const schemaMigrationExists = database.prepare(`
      SELECT 1 AS present FROM sqlite_schema
      WHERE type = 'table' AND name = 'schema_migrations'
    `).get() !== undefined;
    if (schemaMigrationExists && database.prepare(`
      SELECT 1 AS active FROM schema_migrations WHERE status = 'active' LIMIT 1
    `).get() !== undefined) {
      throw new TypeError('Legacy migration authority cannot be issued for an active Shadow.');
    }
    const claim = database.prepare(`
      UPDATE legacy_migration_build_context SET authority_issued = 1
      WHERE id = 1 AND migration_id = ? AND source_digest = ?
        AND sealed = 0 AND authority_issued = 0
    `).run(identity.migrationId, identity.sourceDigest);
    if (Number(claim.changes) !== 1) {
      throw new TypeError('Legacy migration authority is unavailable for this Shadow.');
    }
    database.exec('COMMIT');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // The transaction may not have started or may already have ended.
    }
    throw error;
  } finally {
    database.close();
  }
}

function isDigest(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}
