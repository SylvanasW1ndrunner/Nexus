import type { JournalCommand, JournalCommitResult } from '../events/agent-journal.js';
import type { SqliteAgentJournal } from '../events/sqlite-agent-journal.js';

export type LegacyMigrationIdentity = Readonly<{
  migrationId: string;
  sourceDigest: string;
}>;

export type LegacyMigrationWriter = Readonly<{
  commit(command: JournalCommand): Promise<JournalCommitResult>;
  seal(): void;
}>;

const activeIdentities = new WeakMap<SqliteAgentJournal, LegacyMigrationIdentity>();
const issuedJournals = new WeakSet<SqliteAgentJournal>();

export function createLegacyMigrationWriter(
  journal: SqliteAgentJournal,
  identity: LegacyMigrationIdentity,
): LegacyMigrationWriter {
  if (issuedJournals.has(journal)) throw new TypeError('Legacy migration writer was already issued.');
  if (!isDigest(identity.migrationId) || !isDigest(identity.sourceDigest)) {
    throw new TypeError('Validated legacy migration identity is required.');
  }
  const frozenIdentity = Object.freeze({ ...identity });
  issuedJournals.add(journal);
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

function isDigest(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}
