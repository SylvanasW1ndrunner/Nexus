import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';

type NodeDatabaseSyncConstructor = new (location: string) => NodeDatabaseSync;

export class ArtifactMutationGateTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Artifact mutation gate remained busy for ${timeoutMs}ms.`);
    this.name = 'ArtifactMutationGateTimeoutError';
  }
}

export type ArtifactMutationGate = { close(): void };

export async function acquireArtifactMutationGate(
  rootDir: string,
  timeoutMs: number,
): Promise<ArtifactMutationGate> {
  const root = resolve(rootDir);
  mkdirSync(root, { recursive: true });
  const path = join(root, 'artifact.mutation-gate.db');
  const sqliteModuleId = ['node', 'sqlite'].join(':');
  const { DatabaseSync } = createRequire(import.meta.url)(sqliteModuleId) as {
    DatabaseSync: NodeDatabaseSyncConstructor;
  };
  const deadline = Date.now() + timeoutMs;
  while (true) {
    let database: NodeDatabaseSync | undefined;
    let transactionOpen = false;
    try {
      database = new DatabaseSync(path);
      database.exec('PRAGMA busy_timeout = 0');
      database.exec('BEGIN EXCLUSIVE');
      transactionOpen = true;
      database.prepare('SELECT COUNT(*) AS count FROM sqlite_schema').get();
      const acquired = database;
      let closed = false;
      return {
        close() {
          if (closed) return;
          closed = true;
          try {
            acquired.exec('COMMIT');
          } finally {
            acquired.close();
          }
        },
      };
    } catch (error) {
      try {
        if (transactionOpen) database?.exec('ROLLBACK');
      } finally {
        database?.close();
      }
      if (!isBusy(error)) throw error;
      if (Date.now() >= deadline) throw new ArtifactMutationGateTimeoutError(timeoutMs);
      await delay(8 + Math.floor(Math.random() * 8));
    }
  }
}

function isBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = 'code' in error ? String((error as { code?: unknown }).code) : '';
  return /SQLITE_(?:BUSY|LOCKED)/iu.test(code) ||
    /database(?: table)? is (?:locked|busy)|SQLITE_(?:BUSY|LOCKED)/iu.test(error.message);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
