import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, renameSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute } from 'node:path';
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';
import {
  agentProjectStorageIdentity,
  assertSameAgentProject,
} from './project-context.js';
import { redactPersistedAgentValue } from './redaction.js';
import type {
  AgentContextCheckpoint,
  AgentMessage,
  AgentMode,
  AgentProjectReference,
  AgentRunRecord,
  AgentRunStore,
  AgentSession,
  AgentSubagentRecord,
  AgentSubagentStore,
  AgentUserPreference,
} from './types.js';

const DEFAULT_USER_ID = 'local-user';
const PREFERENCE_CONTEXT_LIMIT = 50;
const LEGACY_PROJECT_KEY = 'legacy:unscoped';
type NodeDatabaseSyncConstructor = new (location: string) => NodeDatabaseSync;

export type AgentSessionSummary = {
  id: string;
  title: string;
  userId?: string;
  mode: AgentMode;
  archived: boolean;
  messageCount: number;
  toolMessageCount: number;
  tokenUsage: AgentSession['tokenUsage'];
  createdAt: string;
  updatedAt: string;
  lastMessageAt?: string;
};

export type AgentSessionListFilter = {
  userId?: string;
  archived?: boolean;
  query?: string;
  limit?: number;
  offset?: number;
};

export type AgentSessionExportFormat = 'json' | 'markdown';

export type SaveAgentSessionInput = {
  session: AgentSession;
  now?: string;
};

export type AgentPreferenceUpsertInput = {
  userId: string;
  key: string;
  value: string;
  confidence?: number;
  sourceSessionId?: string;
  evidence?: string;
  now?: string;
};

export type AgentSessionWriter = {
  save(input: SaveAgentSessionInput): Promise<AgentSessionSummary>;
  listPreferences?(userId: string, limit?: number): Promise<AgentUserPreference[]>;
  listContextCheckpoints?(sessionId: string, limit?: number): Promise<AgentContextCheckpoint[]>;
};

type SessionRow = {
  id: string;
  project_key: string;
  project_root: string | null;
  title: string;
  user_id: string | null;
  mode: AgentMode;
  archived: number;
  message_count: number;
  tool_message_count: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
  payload_json: string;
};

type AgentSessionProjectScope = {
  projectKey: string;
  projectRoot: string | null;
  project?: AgentProjectReference;
};

type PreferenceRow = {
  id: string;
  user_id: string;
  preference_key: string;
  value: string;
  confidence: number;
  source_session_id: string | null;
  evidence: string | null;
  created_at: string;
  updated_at: string;
};

type SessionMessageRow = {
  session_id: string;
  message_index: number;
  role: AgentMessage['role'];
  content: string;
  created_at: string;
  tool_call_id: string | null;
  tool_name: string | null;
  tool_calls_json: string | null;
};

type ContextCheckpointRow = {
  session_id: string;
  sequence: number;
  version: number;
  trigger: AgentContextCheckpoint['trigger'];
  method: AgentContextCheckpoint['method'];
  summary: string;
  covered_message_count: number;
  source_token_estimate: number;
  summary_token_estimate: number;
  model_context_tokens: number | null;
  focus: string | null;
  created_at: string;
};

type SubagentRow = {
  id: string;
  parent_session_id: string;
  child_session_id: string | null;
  task: string;
  context_strategy: AgentSubagentRecord['contextStrategy'];
  status: AgentSubagentRecord['status'];
  depth: number;
  summary: string | null;
  artifact_references_json: string;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

export class AgentSessionStore implements AgentSessionWriter, AgentSubagentStore, AgentRunStore {
  private readonly projectScope: AgentSessionProjectScope;

  constructor(
    private readonly filePath: string,
    project?: AgentProjectReference,
  ) {
    if (!filePath.trim()) throw new Error('Agent session database path is required.');
    this.projectScope = projectScope(project);
  }

  /**
   * Returns a Project-bound view over the same SQLite file. Every Session
   * query and mutation performed through the returned store is scoped in SQL.
   */
  forProject(project: AgentProjectReference): AgentSessionStore {
    return new AgentSessionStore(this.filePath, project);
  }

  async save(input: SaveAgentSessionInput): Promise<AgentSessionSummary> {
    const now = input.now ?? new Date().toISOString();
    const session = redactPersistedAgentValue(
      sanitizePersistedSqlToolResults(input.session),
    ) as AgentSession;
    assertSessionMatchesStoreScope(session, this.projectScope);
    return this.withDatabase((database) => {
      const existing = database
        .prepare('SELECT project_key, archived, created_at FROM agent_sessions WHERE id = ?')
        .get(session.id) as
        | { project_key: string; archived: number; created_at: string }
        | undefined;
      if (existing && existing.project_key !== this.projectScope.projectKey) {
        throw new Error('Agent session id is already owned by another Project.');
      }
      const persistedMessageCount = Number(
        (
          database
            .prepare('SELECT COUNT(*) AS count FROM agent_session_messages WHERE session_id = ?')
            .get(session.id) as { count: number }
        ).count,
      );
      if (persistedMessageCount > session.messages.length) {
        throw new Error('Agent session history is append-only and cannot be shortened.');
      }
      assertAppendOnlyTail(database, session, persistedMessageCount);
      const summary = summarizeSession(
        session,
        existing?.archived === 1,
        existing?.created_at ?? firstMessageAt(session) ?? now,
        now,
      );

      database.exec('BEGIN IMMEDIATE');
      try {
        const sessionWrite = database
          .prepare(
            `
            INSERT INTO agent_sessions (
              id, project_key, project_root, title, user_id, mode, archived,
              message_count, tool_message_count,
              prompt_tokens, completion_tokens, total_tokens,
              created_at, updated_at, last_message_at, payload_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              project_key = excluded.project_key,
              project_root = excluded.project_root,
              title = excluded.title,
              user_id = excluded.user_id,
              mode = excluded.mode,
              archived = excluded.archived,
              message_count = excluded.message_count,
              tool_message_count = excluded.tool_message_count,
              prompt_tokens = excluded.prompt_tokens,
              completion_tokens = excluded.completion_tokens,
              total_tokens = excluded.total_tokens,
              updated_at = excluded.updated_at,
              last_message_at = excluded.last_message_at,
              payload_json = excluded.payload_json
            WHERE agent_sessions.project_key = excluded.project_key
          `,
          )
          .run(
            session.id,
            this.projectScope.projectKey,
            this.projectScope.projectRoot,
            session.title,
            session.userId ?? null,
            session.mode,
            summary.archived ? 1 : 0,
            summary.messageCount,
            summary.toolMessageCount,
            session.tokenUsage.promptTokens,
            session.tokenUsage.completionTokens,
            session.tokenUsage.totalTokens,
            summary.createdAt,
            summary.updatedAt,
            summary.lastMessageAt ?? null,
            JSON.stringify(sessionMetadataPayload(session)),
          );
        if (Number(sessionWrite.changes) === 0) {
          throw new Error('Agent session id is already owned by another Project.');
        }
        const insertMessage = database.prepare(`
          INSERT INTO agent_session_messages (
            session_id, message_index, role, content, created_at,
            tool_call_id, tool_name, tool_calls_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (let index = persistedMessageCount; index < session.messages.length; index += 1) {
          const message = session.messages[index];
          if (!message) continue;
          insertMessage.run(...messageRowValues(session.id, index, message));
        }
        if (session.contextCheckpoint) {
          upsertContextCheckpointRow(database, session.id, session.contextCheckpoint);
        }
        for (const preference of extractPreferenceCandidates(
          session.messages.slice(persistedMessageCount),
          session,
          now,
        )) {
          upsertPreferenceRow(database, preference);
        }
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      return summary;
    });
  }

  async load(id: string): Promise<AgentSession | undefined> {
    return this.withDatabase((database) => {
      const row = database
        .prepare('SELECT payload_json FROM agent_sessions WHERE id = ? AND project_key = ?')
        .get(id, this.projectScope.projectKey) as { payload_json: string } | undefined;
      if (!row) return undefined;
      const messageRows = database
        .prepare(
          'SELECT * FROM agent_session_messages WHERE session_id = ? ORDER BY message_index ASC',
        )
        .all(id) as unknown as SessionMessageRow[];
      return parseSession(row.payload_json, messageRows.map(messageFromRow));
    });
  }

  async list(filter: AgentSessionListFilter = {}): Promise<AgentSessionSummary[]> {
    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? 100;
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error('offset must be a non-negative integer.');
    }
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error('limit must be a positive integer.');
    }
    const archived = filter.archived ?? false;
    const query = filter.query?.trim() ?? '';
    const pattern = `%${escapeLike(query)}%`;
    return this.withDatabase((database) => {
      const rows = database
        .prepare(
          `
          SELECT *
          FROM agent_sessions
          WHERE project_key = ?
            AND archived = ?
            AND (? IS NULL OR user_id = ?)
            AND (
              ? = ''
              OR title LIKE ? ESCAPE '\\' COLLATE NOCASE
              OR payload_json LIKE ? ESCAPE '\\' COLLATE NOCASE
              OR EXISTS (
                SELECT 1
                FROM agent_session_messages AS message
                WHERE message.session_id = agent_sessions.id
                  AND message.content LIKE ? ESCAPE '\\' COLLATE NOCASE
              )
            )
          ORDER BY updated_at DESC, id ASC
          LIMIT ? OFFSET ?
        `,
        )
        .all(
          this.projectScope.projectKey,
          archived ? 1 : 0,
          filter.userId ?? null,
          filter.userId ?? null,
          query,
          pattern,
          pattern,
          pattern,
          limit,
          offset,
        ) as unknown as SessionRow[];
      return rows.map(summaryFromRow);
    });
  }

  async update(
    id: string,
    patch: Partial<Pick<AgentSession, 'title' | 'mode' | 'aborted'>>,
    now = new Date().toISOString(),
  ): Promise<AgentSessionSummary> {
    const session = await this.load(id);
    if (!session) throw new Error(`Agent session not found: ${id}`);
    return this.save({ session: { ...session, ...patch }, now });
  }

  async archive(
    id: string,
    archived = true,
    now = new Date().toISOString(),
  ): Promise<AgentSessionSummary> {
    return this.withDatabase((database) => {
      const row = database
        .prepare('SELECT * FROM agent_sessions WHERE id = ? AND project_key = ?')
        .get(id, this.projectScope.projectKey) as SessionRow | undefined;
      if (!row) throw new Error(`Agent session not found: ${id}`);
      database
        .prepare(
          'UPDATE agent_sessions SET archived = ?, updated_at = ? WHERE id = ? AND project_key = ?',
        )
        .run(archived ? 1 : 0, now, id, this.projectScope.projectKey);
      return {
        ...summaryFromRow(row),
        archived,
        updatedAt: now,
      };
    });
  }

  async delete(id: string): Promise<boolean> {
    return this.withDatabase(
      (database) =>
        Number(
          database
            .prepare('DELETE FROM agent_sessions WHERE id = ? AND project_key = ?')
            .run(id, this.projectScope.projectKey).changes,
        ) > 0,
    );
  }

  async fork(input: {
    id: string;
    fromMessageIndex: number;
    newId?: string;
    title?: string;
    now?: string;
  }): Promise<AgentSession> {
    const session = await this.load(input.id);
    if (!session) throw new Error(`Agent session not found: ${input.id}`);
    if (input.fromMessageIndex < 0 || input.fromMessageIndex >= session.messages.length) {
      throw new Error(`Invalid fork message index: ${input.fromMessageIndex}`);
    }
    const now = input.now ?? new Date().toISOString();
    const base = sessionWithoutContextCheckpoint(session);
    const forked: AgentSession = {
      ...base,
      id: input.newId ?? randomUUID(),
      title: input.title ?? `${session.title} (fork)`,
      messages: structuredClone(session.messages.slice(0, input.fromMessageIndex + 1)),
      aborted: false,
    };
    await this.save({ session: forked, now });
    return forked;
  }

  async export(id: string, format: AgentSessionExportFormat): Promise<string> {
    const session = await this.load(id);
    if (!session) throw new Error(`Agent session not found: ${id}`);
    if (format === 'json') return `${JSON.stringify(session, null, 2)}\n`;
    return markdownSession(session);
  }

  async upsertPreference(input: AgentPreferenceUpsertInput): Promise<AgentUserPreference> {
    const preference = normalizePreference(input);
    return this.withDatabase((database) => {
      upsertPreferenceRow(database, preference);
      return preference;
    });
  }

  async listPreferences(
    userId: string,
    limit = PREFERENCE_CONTEXT_LIMIT,
  ): Promise<AgentUserPreference[]> {
    const normalizedUserId = requireText(userId, 'userId');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error('Preference limit must be an integer from 1 to 1000.');
    }
    return this.withDatabase((database) => {
      const rows = database
        .prepare(
          `
          SELECT *
          FROM agent_user_preferences
          WHERE user_id = ?
          ORDER BY confidence DESC, updated_at DESC, id ASC
          LIMIT ?
        `,
        )
        .all(normalizedUserId, limit) as unknown as PreferenceRow[];
      return rows.map(preferenceFromRow);
    });
  }

  async listContextCheckpoints(sessionId: string, limit = 100): Promise<AgentContextCheckpoint[]> {
    const normalizedSessionId = requireText(sessionId, 'sessionId');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error('Context checkpoint limit must be an integer from 1 to 1000.');
    }
    return this.withDatabase((database) => {
      const rows = database
        .prepare(
          `
          SELECT checkpoint.*
          FROM agent_context_checkpoints AS checkpoint
          INNER JOIN agent_sessions AS session
            ON session.id = checkpoint.session_id
          WHERE checkpoint.session_id = ?
            AND session.project_key = ?
          ORDER BY checkpoint.sequence DESC
          LIMIT ?
        `,
        )
        .all(
          normalizedSessionId,
          this.projectScope.projectKey,
          limit,
        ) as unknown as ContextCheckpointRow[];
      return rows.map(contextCheckpointFromRow).reverse();
    });
  }

  async deletePreference(userId: string, key: string): Promise<boolean> {
    return this.withDatabase(
      (database) =>
        Number(
          database
            .prepare('DELETE FROM agent_user_preferences WHERE user_id = ? AND preference_key = ?')
            .run(requireText(userId, 'userId'), requireText(key, 'key')).changes,
        ) > 0,
    );
  }

  async saveRun(record: AgentRunRecord): Promise<void> {
    const persisted = redactPersistedAgentValue(record) as AgentRunRecord;
    return this.withDatabase((database) => {
      const existing = database
        .prepare('SELECT project_key FROM agent_runs WHERE run_id = ?')
        .get(persisted.runId) as { project_key: string } | undefined;
      if (existing && existing.project_key !== this.projectScope.projectKey) {
        throw new Error('Agent run id is already owned by another Project.');
      }
      const write = database
        .prepare(
          `
          INSERT INTO agent_runs (
            run_id, project_key, session_id, status, phase, iteration,
            created_at, updated_at, payload_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(run_id) DO UPDATE SET
            session_id = excluded.session_id,
            status = excluded.status,
            phase = excluded.phase,
            iteration = excluded.iteration,
            updated_at = excluded.updated_at,
            payload_json = excluded.payload_json
          WHERE agent_runs.project_key = excluded.project_key
        `,
        )
        .run(
          persisted.runId,
          this.projectScope.projectKey,
          persisted.sessionId,
          persisted.status,
          persisted.phase,
          persisted.iteration,
          persisted.createdAt,
          persisted.updatedAt,
          JSON.stringify(persisted),
        );
      if (Number(write.changes) === 0) {
        throw new Error('Agent run id is already owned by another Project.');
      }
      pruneAgentRuns(database, this.projectScope.projectKey, persisted.updatedAt);
    });
  }

  async getRun(runId: string): Promise<AgentRunRecord | undefined> {
    const normalizedRunId = requireText(runId, 'runId');
    return this.withDatabase((database) => {
      const row = database
        .prepare('SELECT payload_json FROM agent_runs WHERE run_id = ? AND project_key = ?')
        .get(normalizedRunId, this.projectScope.projectKey) as
        | { payload_json: string }
        | undefined;
      return row ? (JSON.parse(row.payload_json) as AgentRunRecord) : undefined;
    });
  }

  async listRuns(sessionId?: string, limit = 100): Promise<AgentRunRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error('Agent run limit must be an integer from 1 to 1000.');
    }
    const normalizedSessionId =
      sessionId === undefined ? undefined : requireText(sessionId, 'sessionId');
    return this.withDatabase((database) => {
      const rows =
        normalizedSessionId === undefined
          ? (database
              .prepare(
                `
                SELECT payload_json
                FROM agent_runs
                WHERE project_key = ?
                ORDER BY updated_at DESC, run_id ASC
                LIMIT ?
              `,
              )
              .all(this.projectScope.projectKey, limit) as unknown as Array<{
              payload_json: string;
            }>)
          : (database
              .prepare(
                `
                SELECT payload_json
                FROM agent_runs
                WHERE project_key = ? AND session_id = ?
                ORDER BY updated_at DESC, run_id ASC
                LIMIT ?
              `,
              )
              .all(this.projectScope.projectKey, normalizedSessionId, limit) as unknown as Array<{
              payload_json: string;
            }>);
      return rows.map((row) => JSON.parse(row.payload_json) as AgentRunRecord);
    });
  }

  async recoverInterrupted(now = new Date().toISOString()): Promise<number> {
    return this.withDatabase((database) => {
      const rows = database
        .prepare(
          `
          SELECT run_id, payload_json
          FROM agent_runs
          WHERE project_key = ? AND status = 'running'
        `,
        )
        .all(this.projectScope.projectKey) as unknown as Array<{
        run_id: string;
        payload_json: string;
      }>;
      const update = database.prepare(
        `
        UPDATE agent_runs
        SET status = 'interrupted', phase = 'verify', updated_at = ?, payload_json = ?
        WHERE run_id = ? AND project_key = ?
      `,
      );
      for (const row of rows) {
        const record = JSON.parse(row.payload_json) as AgentRunRecord;
        const recovered: AgentRunRecord = {
          ...record,
          status: 'interrupted',
          phase: 'verify',
          updatedAt: now,
          errorMessage:
            record.errorMessage ?? 'Runtime stopped before the Agent run reached a terminal state.',
        };
        update.run(now, JSON.stringify(recovered), row.run_id, this.projectScope.projectKey);
      }
      return rows.length;
    });
  }

  saveSubagent(record: AgentSubagentRecord): void {
    const persisted = redactPersistedAgentValue(record) as AgentSubagentRecord;
    assertSubagentRecord(persisted);
    this.withDatabaseSync((database) => {
      assertRelatedSessionOwnership(
        database,
        persisted.parentSessionId,
        this.projectScope.projectKey,
        'parent',
      );
      if (persisted.childSessionId) {
        assertRelatedSessionOwnership(
          database,
          persisted.childSessionId,
          this.projectScope.projectKey,
          'child',
        );
      }
      const result = database
        .prepare(
          `
          INSERT INTO agent_subagents (
            id, project_key, parent_session_id, child_session_id, task, context_strategy, status,
            depth, summary, artifact_references_json, error_message,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            parent_session_id = excluded.parent_session_id,
            child_session_id = excluded.child_session_id,
            task = excluded.task,
            context_strategy = excluded.context_strategy,
            status = excluded.status,
            depth = excluded.depth,
            summary = excluded.summary,
            artifact_references_json = excluded.artifact_references_json,
            error_message = excluded.error_message,
            updated_at = excluded.updated_at
          WHERE agent_subagents.project_key = excluded.project_key
            AND agent_subagents.parent_session_id = excluded.parent_session_id
            AND agent_subagents.created_at = excluded.created_at
        `,
        )
        .run(
          persisted.id,
          this.projectScope.projectKey,
          persisted.parentSessionId,
          persisted.childSessionId ?? null,
          persisted.task,
          persisted.contextStrategy,
          persisted.status,
          persisted.depth,
          persisted.summary ?? null,
          JSON.stringify(persisted.artifactReferences ?? []),
          persisted.errorMessage ?? null,
          persisted.createdAt,
          persisted.updatedAt,
        );
      if (Number(result.changes) === 0) {
        throw new Error('Subagent id is already owned by another parent or Project.');
      }
    });
  }

  loadSubagent(id: string): AgentSubagentRecord | undefined {
    const normalizedId = requireText(id, 'subagent id');
    return this.withDatabaseSync((database) => {
      const row = database
        .prepare('SELECT * FROM agent_subagents WHERE id = ? AND project_key = ?')
        .get(normalizedId, this.projectScope.projectKey) as SubagentRow | undefined;
      return row ? subagentFromRow(row) : undefined;
    });
  }

  listSubagents(parentSessionId?: string): AgentSubagentRecord[] {
    const normalizedParent =
      parentSessionId === undefined ? undefined : requireText(parentSessionId, 'parentSessionId');
    return this.withDatabaseSync((database) => {
      const rows =
        normalizedParent === undefined
          ? (database
              .prepare(
                `
                SELECT *
                FROM agent_subagents
                WHERE project_key = ?
                ORDER BY created_at ASC, id ASC
              `,
              )
              .all(this.projectScope.projectKey) as unknown as SubagentRow[])
          : (database
              .prepare(
                `
                SELECT *
                FROM agent_subagents
                WHERE project_key = ? AND parent_session_id = ?
                ORDER BY created_at ASC, id ASC
              `,
              )
              .all(this.projectScope.projectKey, normalizedParent) as unknown as SubagentRow[]);
      return rows.map(subagentFromRow);
    });
  }

  private withDatabaseSync<T>(operation: (database: NodeDatabaseSync) => T): T {
    const database = openDatabaseSync(this.filePath);
    try {
      return operation(database);
    } finally {
      database.close();
    }
  }

  private async withDatabase<T>(operation: (database: NodeDatabaseSync) => T): Promise<T> {
    const database = await openDatabase(this.filePath);
    try {
      return operation(database);
    } finally {
      database.close();
    }
  }
}

function openDatabaseSync(filePath: string): NodeDatabaseSync {
  mkdirSync(dirname(filePath), { recursive: true });
  const sqliteModuleId = ['node', 'sqlite'].join(':');
  const { DatabaseSync } = createRequire(import.meta.url)(sqliteModuleId) as {
    DatabaseSync: NodeDatabaseSyncConstructor;
  };
  let database: NodeDatabaseSync | undefined;
  try {
    database = new DatabaseSync(filePath);
    initializeDatabase(database);
    return database;
  } catch (error) {
    try {
      database?.close();
    } catch {
      // The original error is more useful than a secondary close failure.
    }
    if (!isCorruptDatabaseError(error)) throw error;
    const quarantinedPath = `${filePath}.corrupt-${Date.now()}`;
    renameSync(filePath, quarantinedPath);
    const recovered = new DatabaseSync(filePath);
    initializeDatabase(recovered);
    return recovered;
  }
}

async function openDatabase(filePath: string): Promise<NodeDatabaseSync> {
  await mkdir(dirname(filePath), { recursive: true });
  const sqliteModuleId = ['node', 'sqlite'].join(':');
  const { DatabaseSync } = createRequire(import.meta.url)(sqliteModuleId) as {
    DatabaseSync: NodeDatabaseSyncConstructor;
  };
  let database: NodeDatabaseSync | undefined;
  try {
    database = new DatabaseSync(filePath);
    initializeDatabase(database);
    return database;
  } catch (error) {
    try {
      database?.close();
    } catch {
      // The original error is more useful than a secondary close failure.
    }
    if (!isCorruptDatabaseError(error)) throw error;
    const quarantinedPath = `${filePath}.corrupt-${Date.now()}`;
    await rename(filePath, quarantinedPath);
    const recovered = new DatabaseSync(filePath);
    initializeDatabase(recovered);
    return recovered;
  }
}

function initializeDatabase(database: NodeDatabaseSync): void {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL DEFAULT 'legacy:unscoped',
      project_root TEXT,
      title TEXT NOT NULL,
      user_id TEXT,
      mode TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
      message_count INTEGER NOT NULL,
      tool_message_count INTEGER NOT NULL,
      prompt_tokens INTEGER NOT NULL,
      completion_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_message_at TEXT,
      payload_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_sessions_user_archive_updated
      ON agent_sessions(user_id, archived, updated_at DESC);

    CREATE TABLE IF NOT EXISTS agent_session_messages (
      session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
      message_index INTEGER NOT NULL CHECK (message_index >= 0),
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      tool_call_id TEXT,
      tool_name TEXT,
      tool_calls_json TEXT,
      PRIMARY KEY (session_id, message_index)
    );

    CREATE INDEX IF NOT EXISTS idx_agent_session_messages_content
      ON agent_session_messages(session_id, message_index);

    CREATE TABLE IF NOT EXISTS agent_context_checkpoints (
      session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      version INTEGER NOT NULL,
      trigger TEXT NOT NULL,
      method TEXT NOT NULL,
      summary TEXT NOT NULL,
      covered_message_count INTEGER NOT NULL CHECK (covered_message_count >= 0),
      source_token_estimate INTEGER NOT NULL CHECK (source_token_estimate >= 0),
      summary_token_estimate INTEGER NOT NULL CHECK (summary_token_estimate >= 0),
      model_context_tokens INTEGER CHECK (model_context_tokens > 0),
      focus TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (session_id, sequence)
    );

    CREATE INDEX IF NOT EXISTS idx_agent_context_checkpoints_created
      ON agent_context_checkpoints(session_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS agent_subagents (
      id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL DEFAULT 'legacy:unscoped',
      parent_session_id TEXT NOT NULL,
      child_session_id TEXT,
      task TEXT NOT NULL,
      context_strategy TEXT NOT NULL DEFAULT 'fresh' CHECK (context_strategy IN ('fresh', 'fork')),
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
      depth INTEGER NOT NULL CHECK (depth > 0),
      summary TEXT,
      artifact_references_json TEXT NOT NULL DEFAULT '[]',
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_subagents_project_parent_created
      ON agent_subagents(project_key, parent_session_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS agent_runs (
      run_id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL DEFAULT 'legacy:unscoped',
      session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      phase TEXT NOT NULL,
      iteration INTEGER NOT NULL CHECK (iteration >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_runs_project_session_updated
      ON agent_runs(project_key, session_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS agent_user_preferences (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      preference_key TEXT NOT NULL,
      value TEXT NOT NULL,
      confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      source_session_id TEXT,
      evidence TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, preference_key)
    );

    CREATE INDEX IF NOT EXISTS idx_agent_preferences_user_updated
      ON agent_user_preferences(user_id, confidence DESC, updated_at DESC);

    CREATE TABLE IF NOT EXISTS agent_store_migrations (
      migration_key TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  migrateLegacySessionTable(database);
  migrateNullableContextWindows(database);
  migrateLegacySessionProjects(database);
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_project_user_archive_updated
      ON agent_sessions(project_key, user_id, archived, updated_at DESC);
  `);
  migrateLegacySessionPayloads(database);
  migrateLegacySubagentContextStrategy(database);
  migrateLegacySqlToolResults(database);
}

function migrateNullableContextWindows(database: NodeDatabaseSync): void {
  const columns = database
    .prepare('PRAGMA table_info(agent_context_checkpoints)')
    .all() as unknown as Array<{ name: string; notnull: number }>;
  const contextColumn = columns.find((column) => column.name === 'model_context_tokens');
  if (!contextColumn || contextColumn.notnull === 0) return;

  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(`
      ALTER TABLE agent_context_checkpoints RENAME TO agent_context_checkpoints_legacy_window;

      CREATE TABLE agent_context_checkpoints (
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        version INTEGER NOT NULL,
        trigger TEXT NOT NULL,
        method TEXT NOT NULL,
        summary TEXT NOT NULL,
        covered_message_count INTEGER NOT NULL CHECK (covered_message_count >= 0),
        source_token_estimate INTEGER NOT NULL CHECK (source_token_estimate >= 0),
        summary_token_estimate INTEGER NOT NULL CHECK (summary_token_estimate >= 0),
        model_context_tokens INTEGER CHECK (model_context_tokens > 0),
        focus TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, sequence)
      );

      INSERT INTO agent_context_checkpoints (
        session_id, sequence, version, trigger, method, summary,
        covered_message_count, source_token_estimate, summary_token_estimate,
        model_context_tokens, focus, created_at
      )
      SELECT
        session_id, sequence, version, trigger, method, summary,
        covered_message_count, source_token_estimate, summary_token_estimate,
        model_context_tokens, focus, created_at
      FROM agent_context_checkpoints_legacy_window;

      DROP TABLE agent_context_checkpoints_legacy_window;

      CREATE INDEX IF NOT EXISTS idx_agent_context_checkpoints_created
        ON agent_context_checkpoints(session_id, created_at DESC);
    `);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function migrateLegacySessionTable(database: NodeDatabaseSync): void {
  const columns = database.prepare('PRAGMA table_info(agent_sessions)').all() as unknown as Array<{
    name: string;
  }>;
  if (columns.some((column) => column.name === 'strategy')) {
    database.exec('ALTER TABLE agent_sessions DROP COLUMN strategy');
  }
  if (!columns.some((column) => column.name === 'project_key')) {
    database.exec(
      `ALTER TABLE agent_sessions ADD COLUMN project_key TEXT NOT NULL DEFAULT '${LEGACY_PROJECT_KEY}'`,
    );
  }
  if (!columns.some((column) => column.name === 'project_root')) {
    database.exec('ALTER TABLE agent_sessions ADD COLUMN project_root TEXT');
  }
}

function projectScope(project: AgentProjectReference | undefined): AgentSessionProjectScope {
  if (!project) {
    return {
      projectKey: LEGACY_PROJECT_KEY,
      projectRoot: null,
    };
  }
  const identity = agentProjectStorageIdentity(project);
  return {
    ...identity,
    project: structuredClone(project),
  };
}

function assertSessionMatchesStoreScope(
  session: AgentSession,
  scope: AgentSessionProjectScope,
): void {
  if (!scope.project) {
    if (session.project) {
      throw new Error(
        'Project-owned Agent sessions must be saved through a Project-bound session store.',
      );
    }
    return;
  }
  assertSameAgentProject(session.project, scope.project);
}

function assertSubagentRecord(record: AgentSubagentRecord): void {
  requireText(record.id, 'subagent id');
  requireText(record.parentSessionId, 'parentSessionId');
  if (record.childSessionId !== undefined) requireText(record.childSessionId, 'childSessionId');
  requireText(record.task, 'subagent task');
  if (record.contextStrategy !== 'fresh' && record.contextStrategy !== 'fork') {
    throw new Error(`Unsupported subagent context strategy: ${String(record.contextStrategy)}.`);
  }
  requireText(record.createdAt, 'subagent createdAt');
  requireText(record.updatedAt, 'subagent updatedAt');
  if (!['running', 'completed', 'failed', 'cancelled'].includes(record.status)) {
    throw new Error(`Unsupported subagent status: ${String(record.status)}.`);
  }
  if (!Number.isSafeInteger(record.depth) || record.depth < 1) {
    throw new Error('Subagent depth must be a positive integer.');
  }
  if (
    record.artifactReferences !== undefined &&
    !record.artifactReferences.every((reference) => typeof reference === 'string')
  ) {
    throw new Error('Subagent artifact references must be strings.');
  }
}

function assertRelatedSessionOwnership(
  database: NodeDatabaseSync,
  sessionId: string,
  projectKey: string,
  relationship: 'parent' | 'child',
): void {
  const existing = database
    .prepare('SELECT project_key FROM agent_sessions WHERE id = ?')
    .get(sessionId) as { project_key: string } | undefined;
  if (existing && existing.project_key !== projectKey) {
    throw new Error(`Subagent ${relationship} session is owned by another Project.`);
  }
}

function subagentFromRow(row: SubagentRow): AgentSubagentRecord {
  const artifactReferences = JSON.parse(row.artifact_references_json) as unknown;
  if (
    !Array.isArray(artifactReferences) ||
    !artifactReferences.every((reference) => typeof reference === 'string')
  ) {
    throw new Error(`Stored subagent ${row.id} has invalid artifact references.`);
  }
  return {
    id: row.id,
    parentSessionId: row.parent_session_id,
    ...(row.child_session_id === null ? {} : { childSessionId: row.child_session_id }),
    task: row.task,
    contextStrategy: row.context_strategy,
    status: row.status,
    depth: row.depth,
    ...(row.summary === null ? {} : { summary: row.summary }),
    ...(artifactReferences.length === 0 ? {} : { artifactReferences }),
    ...(row.error_message === null ? {} : { errorMessage: row.error_message }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function migrateLegacySubagentContextStrategy(database: NodeDatabaseSync): void {
  const columns = database.prepare('PRAGMA table_info(agent_subagents)').all() as unknown as Array<{
    name: string;
  }>;
  if (!columns.some((column) => column.name === 'context_strategy')) {
    database.exec(
      "ALTER TABLE agent_subagents ADD COLUMN context_strategy TEXT NOT NULL DEFAULT 'fresh' CHECK (context_strategy IN ('fresh', 'fork'))",
    );
  }
}

function projectReferenceFromPayload(payload: string): AgentProjectReference | undefined {
  try {
    const value = JSON.parse(payload) as {
      project?: { rootPath?: unknown; configDirectory?: unknown };
    };
    const rootPath = value.project?.rootPath;
    if (typeof rootPath !== 'string' || !rootPath.trim() || !isAbsolute(rootPath)) return undefined;
    return {
      rootPath,
      configDirectory:
        typeof value.project?.configDirectory === 'string'
          ? value.project.configDirectory
          : '',
    };
  } catch {
    return undefined;
  }
}

function migrateLegacySessionProjects(database: NodeDatabaseSync): void {
  const migrationKey = 'session-project-ownership-v1';
  const alreadyApplied = database
    .prepare('SELECT 1 AS applied FROM agent_store_migrations WHERE migration_key = ?')
    .get(migrationKey) as { applied: number } | undefined;
  if (alreadyApplied) return;
  database.exec('BEGIN IMMEDIATE');
  try {
    const appliedAfterLock = database
      .prepare('SELECT 1 AS applied FROM agent_store_migrations WHERE migration_key = ?')
      .get(migrationKey) as { applied: number } | undefined;
    if (appliedAfterLock) {
      database.exec('COMMIT');
      return;
    }
    const rows = database
      .prepare(
        `
        SELECT id, payload_json
        FROM agent_sessions
        WHERE project_key = ? OR project_key IS NULL OR project_key = ''
      `,
      )
      .all(LEGACY_PROJECT_KEY) as unknown as Array<{ id: string; payload_json: string }>;
    const update = database.prepare(
      'UPDATE agent_sessions SET project_key = ?, project_root = ? WHERE id = ?',
    );
    for (const row of rows) {
      const reference = projectReferenceFromPayload(row.payload_json);
      if (!reference) {
        update.run(LEGACY_PROJECT_KEY, null, row.id);
        continue;
      }
      const identity = agentProjectStorageIdentity(reference);
      update.run(identity.projectKey, identity.projectRoot, row.id);
    }
    database
      .prepare('INSERT INTO agent_store_migrations (migration_key, applied_at) VALUES (?, ?)')
      .run(migrationKey, new Date().toISOString());
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function summarizeSession(
  session: AgentSession,
  archived: boolean,
  createdAt: string,
  updatedAt: string,
): AgentSessionSummary {
  const messages = session.messages;
  const lastMessageAt = messages.at(-1)?.createdAt;
  return {
    id: session.id,
    title: session.title,
    ...(session.userId === undefined ? {} : { userId: session.userId }),
    mode: session.mode,
    archived,
    messageCount: messages.length,
    toolMessageCount: messages.filter((message) => message.role === 'tool').length,
    tokenUsage: { ...session.tokenUsage },
    createdAt,
    updatedAt,
    ...(lastMessageAt === undefined ? {} : { lastMessageAt }),
  };
}

function summaryFromRow(row: SessionRow): AgentSessionSummary {
  return {
    id: row.id,
    title: row.title,
    ...(row.user_id === null ? {} : { userId: row.user_id }),
    mode: row.mode,
    archived: row.archived === 1,
    messageCount: row.message_count,
    toolMessageCount: row.tool_message_count,
    tokenUsage: {
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      totalTokens: row.total_tokens,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.last_message_at === null ? {} : { lastMessageAt: row.last_message_at }),
  };
}

function parseSession(payload: string, normalizedMessages: AgentMessage[] = []): AgentSession {
  const currentSession = JSON.parse(payload) as AgentSession;
  const messages =
    normalizedMessages.length > 0
      ? normalizedMessages
      : Array.isArray(currentSession.messages)
        ? currentSession.messages
        : [];
  return redactPersistedAgentValue(
    sanitizePersistedSqlToolResults({
      ...currentSession,
      messages,
    }),
  ) as AgentSession;
}

function sanitizePersistedSqlToolResults(session: AgentSession): AgentSession {
  return {
    ...session,
    messages: session.messages.map((message) => {
      if (
        message.role !== 'tool' ||
        (message.toolName !== 'sql_execute' && message.toolName !== 'result_read')
      ) {
        return message;
      }
      return {
        ...message,
        content: summarizePersistedSqlToolContent(message.content),
      };
    }),
  };
}

function summarizePersistedSqlToolContent(content: string): string {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return JSON.stringify({
      status: 'legacy_result_removed',
      resultAvailable: false,
    });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return JSON.stringify({
      status: 'legacy_result_removed',
      resultAvailable: false,
    });
  }
  const source = value as Record<string, unknown>;
  const summarySource =
    source.type === 'schemanaut.agent-tool-result.v1' &&
    source.durableSummary &&
    typeof source.durableSummary === 'object' &&
    !Array.isArray(source.durableSummary)
      ? (source.durableSummary as Record<string, unknown>)
      : source;
  const allowed = [
    'columns',
    'rowCount',
    'returnedRowCount',
    'storedRowCount',
    'totalStoredRows',
    'hasMore',
    'hasMoreInDatabase',
    'truncated',
    'truncatedByDriver',
    'previewTruncated',
    'valuesTruncated',
    'elapsedMs',
    'transaction',
    'messages',
    'status',
    'resultAvailable',
  ] as const;
  const summary: Record<string, unknown> = {};
  for (const key of allowed) {
    if (Object.hasOwn(summarySource, key)) {
      summary[key] = structuredClone(summarySource[key]);
    }
  }
  if (Object.keys(summary).length === 0) {
    summary.status = 'legacy_result_removed';
    summary.resultAvailable = false;
  }
  return JSON.stringify(summary);
}

function extractPreferenceCandidates(
  messages: AgentMessage[],
  session: AgentSession,
  now: string,
): AgentUserPreference[] {
  const userId = session.userId?.trim() || DEFAULT_USER_ID;
  const candidates = new Map<string, AgentUserPreference>();
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const sentences = message.content
      .split(/[。！？!?\n]+/)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length >= 3 && sentence.length <= 240);
    for (const sentence of sentences) {
      if (!isStablePreferenceSentence(sentence)) continue;
      const normalized = sentence.toLocaleLowerCase().replace(/\s+/g, ' ');
      const key = `auto:${sha256(normalized).slice(0, 24)}`;
      candidates.set(key, {
        id: preferenceId(userId, key),
        userId,
        key,
        value: sentence,
        confidence: preferenceConfidence(sentence),
        sourceSessionId: session.id,
        evidence: sentence,
        createdAt: now,
        updatedAt: now,
      });
    }
  }
  return [...candidates.values()];
}

function isStablePreferenceSentence(sentence: string): boolean {
  return /(?:以后请|默认(?:使用|采用|不要|优先)?|总是|始终|永远不要|不要再|我偏好)|(?:\bi prefer\b|\bfrom now on\b|\bby default\b|\bplease always\b|\bplease never\b|\bnever again\b)/i.test(
    sentence,
  );
}

function preferenceConfidence(sentence: string): number {
  if (
    /(?:以后请|默认|总是|始终|永远不要|不要再)|(?:from now on|by default|always|never)/i.test(
      sentence,
    )
  ) {
    return 0.9;
  }
  return 0.7;
}

function normalizePreference(input: AgentPreferenceUpsertInput): AgentUserPreference {
  const userId = requireText(input.userId, 'userId');
  const key = requireText(input.key, 'key');
  const value = requireText(input.value, 'value');
  const confidence = input.confidence ?? 1;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error('Preference confidence must be between 0 and 1.');
  }
  const now = input.now ?? new Date().toISOString();
  return {
    id: preferenceId(userId, key),
    userId,
    key,
    value,
    confidence,
    ...(input.sourceSessionId === undefined ? {} : { sourceSessionId: input.sourceSessionId }),
    ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
    createdAt: now,
    updatedAt: now,
  };
}

function upsertPreferenceRow(database: NodeDatabaseSync, preference: AgentUserPreference): void {
  const existing = database
    .prepare(
      'SELECT created_at FROM agent_user_preferences WHERE user_id = ? AND preference_key = ?',
    )
    .get(preference.userId, preference.key) as { created_at: string } | undefined;
  database
    .prepare(
      `
      INSERT INTO agent_user_preferences (
        id, user_id, preference_key, value, confidence,
        source_session_id, evidence, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, preference_key) DO UPDATE SET
        value = excluded.value,
        confidence = excluded.confidence,
        source_session_id = excluded.source_session_id,
        evidence = excluded.evidence,
        updated_at = excluded.updated_at
    `,
    )
    .run(
      preference.id,
      preference.userId,
      preference.key,
      preference.value,
      preference.confidence,
      preference.sourceSessionId ?? null,
      preference.evidence ?? null,
      existing?.created_at ?? preference.createdAt,
      preference.updatedAt,
    );
}

function preferenceFromRow(row: PreferenceRow): AgentUserPreference {
  return {
    id: row.id,
    userId: row.user_id,
    key: row.preference_key,
    value: row.value,
    confidence: row.confidence,
    ...(row.source_session_id === null ? {} : { sourceSessionId: row.source_session_id }),
    ...(row.evidence === null ? {} : { evidence: row.evidence }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sessionMetadataPayload(session: AgentSession): AgentSession {
  return {
    ...session,
    messages: [],
    tokenUsage: { ...session.tokenUsage },
    ...(session.knowledgeSnapshot === undefined
      ? {}
      : { knowledgeSnapshot: structuredClone(session.knowledgeSnapshot) }),
    ...(session.contextCheckpoint === undefined
      ? {}
      : { contextCheckpoint: structuredClone(session.contextCheckpoint) }),
  };
}

function messageRowValues(
  sessionId: string,
  index: number,
  message: AgentMessage,
): [
  string,
  number,
  AgentMessage['role'],
  string,
  string,
  string | null,
  string | null,
  string | null,
] {
  if (message.role === 'tool') {
    return [
      sessionId,
      index,
      message.role,
      message.content,
      message.createdAt,
      message.toolCallId,
      message.toolName,
      null,
    ];
  }
  return [
    sessionId,
    index,
    message.role,
    message.content,
    message.createdAt,
    null,
    null,
    message.role === 'assistant' && message.toolCalls?.length
      ? JSON.stringify(message.toolCalls)
      : null,
  ];
}

function messageFromRow(row: SessionMessageRow): AgentMessage {
  if (row.role === 'tool') {
    if (!row.tool_call_id || !row.tool_name) {
      throw new Error(`Persisted tool message is incomplete at index ${row.message_index}.`);
    }
    return {
      role: 'tool',
      toolCallId: row.tool_call_id,
      toolName: row.tool_name,
      content: row.content,
      createdAt: row.created_at,
    };
  }
  if (row.role === 'assistant') {
    const toolCalls =
      row.tool_calls_json === null
        ? undefined
        : (JSON.parse(row.tool_calls_json) as Extract<
            AgentMessage,
            { role: 'assistant' }
          >['toolCalls']);
    return {
      role: 'assistant',
      content: row.content,
      ...(toolCalls?.length ? { toolCalls } : {}),
      createdAt: row.created_at,
    };
  }
  if (row.role === 'user' || row.role === 'system') {
    return {
      role: row.role,
      content: row.content,
      createdAt: row.created_at,
    };
  }
  throw new Error('Unsupported persisted Agent message role.');
}

function assertAppendOnlyTail(
  database: NodeDatabaseSync,
  session: AgentSession,
  persistedMessageCount: number,
): void {
  if (persistedMessageCount === 0) return;
  const row = database
    .prepare(
      `
      SELECT *
      FROM agent_session_messages
      WHERE session_id = ? AND message_index = ?
    `,
    )
    .get(session.id, persistedMessageCount - 1) as SessionMessageRow | undefined;
  const current = session.messages[persistedMessageCount - 1];
  if (
    !row ||
    !current ||
    canonicalMessageJson(messageFromRow(row)) !== canonicalMessageJson(current)
  ) {
    throw new Error(
      'Agent session history is append-only and existing messages cannot be reordered or modified.',
    );
  }
}

function canonicalMessageJson(message: AgentMessage): string {
  if (
    message.role === 'assistant' &&
    message.toolCalls !== undefined &&
    message.toolCalls.length === 0
  ) {
    return JSON.stringify({
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
    });
  }
  return JSON.stringify(message);
}

function upsertContextCheckpointRow(
  database: NodeDatabaseSync,
  sessionId: string,
  checkpoint: AgentContextCheckpoint,
): void {
  database
    .prepare(
      `
      INSERT INTO agent_context_checkpoints (
        session_id, sequence, version, trigger, method, summary,
        covered_message_count, source_token_estimate,
        summary_token_estimate, model_context_tokens, focus, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, sequence) DO UPDATE SET
        version = excluded.version,
        trigger = excluded.trigger,
        method = excluded.method,
        summary = excluded.summary,
        covered_message_count = excluded.covered_message_count,
        source_token_estimate = excluded.source_token_estimate,
        summary_token_estimate = excluded.summary_token_estimate,
        model_context_tokens = excluded.model_context_tokens,
        focus = excluded.focus,
        created_at = excluded.created_at
    `,
    )
    .run(
      sessionId,
      checkpoint.sequence,
      checkpoint.version,
      checkpoint.trigger,
      checkpoint.method,
      checkpoint.summary,
      checkpoint.coveredConversationMessageCount,
      checkpoint.sourceTokenEstimate,
      checkpoint.summaryTokenEstimate,
      checkpoint.modelContextTokens,
      checkpoint.focus ?? null,
      checkpoint.createdAt,
    );
}

function contextCheckpointFromRow(row: ContextCheckpointRow): AgentContextCheckpoint {
  return {
    version: 1,
    sequence: row.sequence,
    trigger: row.trigger,
    method: row.method,
    summary: row.summary,
    coveredConversationMessageCount: row.covered_message_count,
    sourceTokenEstimate: row.source_token_estimate,
    summaryTokenEstimate: row.summary_token_estimate,
    modelContextTokens: row.model_context_tokens,
    createdAt: row.created_at,
    ...(row.focus === null ? {} : { focus: row.focus }),
  };
}

function migrateLegacySessionPayloads(database: NodeDatabaseSync): void {
  const legacyRows = database
    .prepare(
      `
      SELECT id, payload_json
      FROM agent_sessions AS session
      WHERE NOT EXISTS (
        SELECT 1
        FROM agent_session_messages AS message
        WHERE message.session_id = session.id
      )
    `,
    )
    .all() as unknown as Array<{ id: string; payload_json: string }>;
  const candidates = legacyRows
    .map((row) => {
      try {
        const session = parseSession(row.payload_json);
        return session.messages.length > 0 ? { row, session } : undefined;
      } catch {
        return undefined;
      }
    })
    .filter(
      (
        item,
      ): item is {
        row: { id: string; payload_json: string };
        session: AgentSession;
      } => item !== undefined,
    );
  if (candidates.length === 0) return;

  database.exec('BEGIN IMMEDIATE');
  try {
    const insertMessage = database.prepare(`
      INSERT INTO agent_session_messages (
        session_id, message_index, role, content, created_at,
        tool_call_id, tool_name, tool_calls_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updatePayload = database.prepare(
      'UPDATE agent_sessions SET payload_json = ? WHERE id = ?',
    );
    for (const { row, session } of candidates) {
      session.messages.forEach((message, index) => {
        insertMessage.run(...messageRowValues(row.id, index, message));
      });
      updatePayload.run(JSON.stringify(sessionMetadataPayload(session)), row.id);
      if (session.contextCheckpoint) {
        upsertContextCheckpointRow(database, row.id, session.contextCheckpoint);
      }
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function migrateLegacySqlToolResults(database: NodeDatabaseSync): void {
  const migrationKey = 'sql-tool-result-summary-v1';
  const alreadyApplied = database
    .prepare('SELECT 1 AS applied FROM agent_store_migrations WHERE migration_key = ?')
    .get(migrationKey) as { applied: number } | undefined;
  if (alreadyApplied) return;

  database.exec('BEGIN IMMEDIATE');
  try {
    const rows = database
      .prepare(
        `
        SELECT session_id, message_index, content
        FROM agent_session_messages
        WHERE role = 'tool' AND tool_name IN ('sql_execute', 'result_read')
      `,
      )
      .all() as unknown as Array<{
      session_id: string;
      message_index: number;
      content: string;
    }>;
    const update = database.prepare(
      `
      UPDATE agent_session_messages
      SET content = ?
      WHERE session_id = ? AND message_index = ?
    `,
    );
    for (const row of rows) {
      update.run(
        summarizePersistedSqlToolContent(row.content),
        row.session_id,
        row.message_index,
      );
    }
    database
      .prepare('INSERT INTO agent_store_migrations (migration_key, applied_at) VALUES (?, ?)')
      .run(migrationKey, new Date().toISOString());
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function pruneAgentRuns(
  database: NodeDatabaseSync,
  projectKey: string,
  now: string,
): void {
  const retentionCutoff = new Date(
    Date.parse(now) - 30 * 24 * 60 * 60 * 1_000,
  ).toISOString();
  database
    .prepare('DELETE FROM agent_runs WHERE project_key = ? AND updated_at < ?')
    .run(projectKey, retentionCutoff);
  const count = Number(
    (
      database
        .prepare('SELECT COUNT(*) AS count FROM agent_runs WHERE project_key = ?')
        .get(projectKey) as { count: number }
    ).count,
  );
  const excess = count - 1_000;
  if (excess <= 0) return;
  database
    .prepare(
      `
      DELETE FROM agent_runs
      WHERE run_id IN (
        SELECT run_id
        FROM agent_runs
        WHERE project_key = ?
        ORDER BY updated_at ASC, run_id ASC
        LIMIT ?
      )
    `,
    )
    .run(projectKey, excess);
}

function sessionWithoutContextCheckpoint(session: AgentSession): AgentSession {
  const cloned = structuredClone(session);
  delete cloned.contextCheckpoint;
  return cloned;
}

function preferenceId(userId: string, key: string): string {
  return `preference:${sha256(`${userId}\0${key}`).slice(0, 32)}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function firstMessageAt(session: AgentSession): string | undefined {
  return session.messages[0]?.createdAt;
}

function markdownSession(session: AgentSession): string {
  const lines = [
    `# ${session.title}`,
    '',
    `- Session ID: ${session.id}`,
    `- Mode: ${session.mode}`,
    ...(session.userId ? [`- User ID: ${session.userId}`] : []),
    ...(session.knowledgeSnapshot
      ? [`- Knowledge snapshot: ${session.knowledgeSnapshot.knowledgeSnapshotId}`]
      : []),
    '',
  ];
  for (const message of session.messages) {
    lines.push(`## ${message.role} - ${message.createdAt}`, '', message.content, '');
    if (message.role === 'assistant' && message.toolCalls?.length) {
      lines.push(`Tool calls: ${message.toolCalls.map((tool) => tool.name).join(', ')}`, '');
    }
    if (message.role === 'tool') lines.push(`Tool: ${message.toolName}`, '');
  }
  return `${lines.join('\n')}\n`;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function requireText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is required.`);
  return normalized;
}

function isCorruptDatabaseError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /file is not a database|database disk image is malformed|unsupported file format/i.test(
    message,
  );
}
