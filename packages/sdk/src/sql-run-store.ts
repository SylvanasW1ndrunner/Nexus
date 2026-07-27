import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';
import type { SqlRunSnapshot } from './types.js';

const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_RECORDS = 1_000;
type NodeDatabaseSyncConstructor = new (location: string) => NodeDatabaseSync;

export class SqlRunStore {
  readonly #filePath: string;
  #memoryDatabase: NodeDatabaseSync | undefined;
  #closed = false;
  readonly #projectKey: string;
  readonly #retentionMs: number;
  readonly #maxRecords: number;
  readonly #now: () => string;

  constructor(options: {
    filePath: string;
    projectKey: string;
    retentionMs?: number;
    maxRecords?: number;
    now?: () => string;
  }) {
    if (!options.filePath.trim()) throw new Error('SQL run database path is required.');
    if (!options.projectKey.trim()) throw new Error('SQL run Project key is required.');
    this.#filePath = options.filePath;
    this.#projectKey = options.projectKey;
    this.#retentionMs = positiveInteger(options.retentionMs, DEFAULT_RETENTION_MS);
    this.#maxRecords = positiveInteger(options.maxRecords, DEFAULT_MAX_RECORDS);
    this.#now = options.now ?? (() => new Date().toISOString());
    if (options.filePath !== ':memory:') mkdirSync(dirname(options.filePath), { recursive: true });
    const sqliteModuleId = ['node', 'sqlite'].join(':');
    const { DatabaseSync } = createRequire(import.meta.url)(sqliteModuleId) as {
      DatabaseSync: NodeDatabaseSyncConstructor;
    };
    const database = new DatabaseSync(options.filePath);
    initializeSqlRunDatabase(database);
    if (options.filePath === ':memory:') this.#memoryDatabase = database;
    else database.close();
    this.recoverInterrupted();
    this.prune();
  }

  put(run: SqlRunSnapshot): SqlRunSnapshot {
    return this.withDatabase((database) => {
      pruneExpired(database, this.#projectKey, this.#now());
      const snapshot = sanitizeSqlRunSnapshot(run);
      const expiresAt = new Date(
        Date.parse(snapshot.updatedAt) + this.#retentionMs,
      ).toISOString();
      const existing = database
        .prepare('SELECT project_key FROM sdk_sql_runs WHERE run_id = ?')
        .get(snapshot.runId) as { project_key: string } | undefined;
      if (existing && existing.project_key !== this.#projectKey) {
        throw new Error('SQL run id is already owned by another Project.');
      }
      const write = database
        .prepare(
          `
          INSERT INTO sdk_sql_runs (
            run_id, project_key, status, created_at, updated_at, expires_at, payload_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(run_id) DO UPDATE SET
            status = excluded.status,
            updated_at = excluded.updated_at,
            expires_at = excluded.expires_at,
            payload_json = excluded.payload_json
          WHERE sdk_sql_runs.project_key = excluded.project_key
        `,
        )
        .run(
          snapshot.runId,
          this.#projectKey,
          snapshot.status,
          snapshot.createdAt,
          snapshot.updatedAt,
          expiresAt,
          JSON.stringify(snapshot),
        );
      if (Number(write.changes) === 0) {
        throw new Error('SQL run id is already owned by another Project.');
      }
      this.pruneCapacity(database);
      return structuredClone(snapshot);
    });
  }

  get(runId: string): SqlRunSnapshot | undefined {
    return this.withDatabase((database) => {
      pruneExpired(database, this.#projectKey, this.#now());
      const row = database
        .prepare(
          'SELECT payload_json FROM sdk_sql_runs WHERE run_id = ? AND project_key = ?',
        )
        .get(runId, this.#projectKey) as { payload_json: string } | undefined;
      return row ? (JSON.parse(row.payload_json) as SqlRunSnapshot) : undefined;
    });
  }

  count(): number {
    return this.withDatabase((database) => {
      pruneExpired(database, this.#projectKey, this.#now());
      return countRuns(database, this.#projectKey);
    });
  }

  recoverInterrupted(now = this.#now()): number {
    return this.withDatabase((database) => {
      const rows = database
        .prepare(
          `
          SELECT run_id, payload_json
          FROM sdk_sql_runs
          WHERE project_key = ? AND status = 'executing'
        `,
        )
        .all(this.#projectKey) as unknown as Array<{ run_id: string; payload_json: string }>;
      const update = database.prepare(
        `
        UPDATE sdk_sql_runs
        SET status = 'outcome_unknown', updated_at = ?, payload_json = ?
        WHERE run_id = ? AND project_key = ?
      `,
      );
      for (const row of rows) {
        const snapshot = JSON.parse(row.payload_json) as SqlRunSnapshot;
        const recovered: SqlRunSnapshot = {
          ...snapshot,
          status: 'outcome_unknown',
          updatedAt: now,
        };
        update.run(now, JSON.stringify(recovered), row.run_id, this.#projectKey);
      }
      return rows.length;
    });
  }

  prune(now = this.#now()): number {
    return this.withDatabase((database) => pruneExpired(database, this.#projectKey, now));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#memoryDatabase?.close();
    this.#memoryDatabase = undefined;
  }

  private pruneCapacity(database: NodeDatabaseSync): void {
    const excess = countRuns(database, this.#projectKey) - this.#maxRecords;
    if (excess <= 0) return;
    database
      .prepare(
        `
        DELETE FROM sdk_sql_runs
        WHERE run_id IN (
          SELECT run_id
          FROM sdk_sql_runs
          WHERE project_key = ?
          ORDER BY updated_at ASC, run_id ASC
          LIMIT ?
        )
      `,
      )
      .run(this.#projectKey, excess);
  }

  private withDatabase<T>(operation: (database: NodeDatabaseSync) => T): T {
    if (this.#closed) throw new Error('SQL run store is closed.');
    if (this.#memoryDatabase) return operation(this.#memoryDatabase);
    const sqliteModuleId = ['node', 'sqlite'].join(':');
    const { DatabaseSync } = createRequire(import.meta.url)(sqliteModuleId) as {
      DatabaseSync: NodeDatabaseSyncConstructor;
    };
    const database = new DatabaseSync(this.#filePath);
    initializeSqlRunDatabase(database);
    try {
      return operation(database);
    } finally {
      database.close();
    }
  }
}

function initializeSqlRunDatabase(database: NodeDatabaseSync): void {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS sdk_sql_runs (
      run_id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sdk_sql_runs_project_updated
      ON sdk_sql_runs(project_key, updated_at DESC);
  `);
}

function countRuns(database: NodeDatabaseSync, projectKey: string): number {
  return Number(
    (
      database
        .prepare('SELECT COUNT(*) AS count FROM sdk_sql_runs WHERE project_key = ?')
        .get(projectKey) as { count: number }
    ).count,
  );
}

function pruneExpired(
  database: NodeDatabaseSync,
  projectKey: string,
  now: string,
): number {
  const result = database
    .prepare('DELETE FROM sdk_sql_runs WHERE project_key = ? AND expires_at <= ?')
    .run(projectKey, now);
  return Number(result.changes);
}

function sanitizeSqlRunSnapshot(run: SqlRunSnapshot): SqlRunSnapshot {
  if (!run.execution) return structuredClone(run);
  return {
    ...structuredClone(run),
    executionResultAvailable: false,
    execution: {
      ...structuredClone(run.execution),
      rows: [],
      returnedRowCount: run.execution.returnedRowCount ?? run.execution.rows.length,
      ...(run.execution.resultSets === undefined
        ? {}
        : {
            resultSets: run.execution.resultSets.map((resultSet) => ({
              ...structuredClone(resultSet),
              rows: [],
              returnedRowCount: resultSet.returnedRowCount ?? resultSet.rows.length,
            })),
          }),
    },
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('SQL run store limits must be positive integers.');
  }
  return value;
}
