import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';
import { redactPersistedAgentValue } from './redaction.js';
import type {
  AgentContextCheckpoint,
  AgentMessage,
  AgentMode,
  AgentSession,
  AgentUserPreference,
} from './types.js';

const DEFAULT_USER_ID = 'local-user';
const PREFERENCE_CONTEXT_LIMIT = 50;
type NodeDatabaseSyncConstructor = new (
  location: string,
) => NodeDatabaseSync;

export type AgentSessionSummary = {
  id: string;
  title: string;
  userId?: string;
  mode: AgentMode;
  strategy: AgentSession['strategy'];
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
  listContextCheckpoints?(
    sessionId: string,
    limit?: number,
  ): Promise<AgentContextCheckpoint[]>;
};

type SessionRow = {
  id: string;
  title: string;
  user_id: string | null;
  mode: AgentMode;
  strategy: AgentSession['strategy'];
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
  model_context_tokens: number;
  focus: string | null;
  created_at: string;
};

export class AgentSessionStore implements AgentSessionWriter {
  constructor(private readonly filePath: string) {
    if (!filePath.trim()) throw new Error('Agent session database path is required.');
  }

  async save(input: SaveAgentSessionInput): Promise<AgentSessionSummary> {
    const now = input.now ?? new Date().toISOString();
    const session = redactPersistedAgentValue(input.session) as AgentSession;
    return this.withDatabase((database) => {
      const existing = database
        .prepare(
          'SELECT archived, created_at FROM agent_sessions WHERE id = ?',
        )
        .get(session.id) as
        | { archived: number; created_at: string }
        | undefined;
      const persistedMessageCount = Number(
        (
          database
            .prepare(
              'SELECT COUNT(*) AS count FROM agent_session_messages WHERE session_id = ?',
            )
            .get(session.id) as { count: number }
        ).count,
      );
      if (persistedMessageCount > session.messages.length) {
        throw new Error(
          'Agent session history is append-only and cannot be shortened.',
        );
      }
      assertAppendOnlyTail(
        database,
        session,
        persistedMessageCount,
      );
      const summary = summarizeSession(
        session,
        existing?.archived === 1,
        existing?.created_at ?? firstMessageAt(session) ?? now,
        now,
      );

      database.exec('BEGIN IMMEDIATE');
      try {
        database
          .prepare(`
            INSERT INTO agent_sessions (
              id, title, user_id, mode, strategy, archived,
              message_count, tool_message_count,
              prompt_tokens, completion_tokens, total_tokens,
              created_at, updated_at, last_message_at, payload_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              title = excluded.title,
              user_id = excluded.user_id,
              mode = excluded.mode,
              strategy = excluded.strategy,
              archived = excluded.archived,
              message_count = excluded.message_count,
              tool_message_count = excluded.tool_message_count,
              prompt_tokens = excluded.prompt_tokens,
              completion_tokens = excluded.completion_tokens,
              total_tokens = excluded.total_tokens,
              updated_at = excluded.updated_at,
              last_message_at = excluded.last_message_at,
              payload_json = excluded.payload_json
          `)
          .run(
            session.id,
            session.title,
            session.userId ?? null,
            session.mode,
            session.strategy,
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
        const insertMessage = database.prepare(`
          INSERT INTO agent_session_messages (
            session_id, message_index, role, content, created_at,
            tool_call_id, tool_name, tool_calls_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (
          let index = persistedMessageCount;
          index < session.messages.length;
          index += 1
        ) {
          const message = session.messages[index];
          if (!message) continue;
          insertMessage.run(...messageRowValues(session.id, index, message));
        }
        if (session.contextCheckpoint) {
          upsertContextCheckpointRow(
            database,
            session.id,
            session.contextCheckpoint,
          );
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
        .prepare('SELECT payload_json FROM agent_sessions WHERE id = ?')
        .get(id) as { payload_json: string } | undefined;
      if (!row) return undefined;
      const messageRows = database
        .prepare(
          'SELECT * FROM agent_session_messages WHERE session_id = ? ORDER BY message_index ASC',
        )
        .all(id) as unknown as SessionMessageRow[];
      return parseSession(
        row.payload_json,
        messageRows.map(messageFromRow),
      );
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
        .prepare(`
          SELECT *
          FROM agent_sessions
          WHERE archived = ?
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
        `)
        .all(
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
        .prepare('SELECT * FROM agent_sessions WHERE id = ?')
        .get(id) as SessionRow | undefined;
      if (!row) throw new Error(`Agent session not found: ${id}`);
      database
        .prepare(
          'UPDATE agent_sessions SET archived = ?, updated_at = ? WHERE id = ?',
        )
        .run(archived ? 1 : 0, now, id);
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
            .prepare('DELETE FROM agent_sessions WHERE id = ?')
            .run(id).changes,
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
    if (
      input.fromMessageIndex < 0 ||
      input.fromMessageIndex >= session.messages.length
    ) {
      throw new Error(`Invalid fork message index: ${input.fromMessageIndex}`);
    }
    const now = input.now ?? new Date().toISOString();
    const base = sessionWithoutContextCheckpoint(session);
    const forked: AgentSession = {
      ...base,
      id: input.newId ?? randomUUID(),
      title: input.title ?? `${session.title} (fork)`,
      messages: structuredClone(
        session.messages.slice(0, input.fromMessageIndex + 1),
      ),
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

  async upsertPreference(
    input: AgentPreferenceUpsertInput,
  ): Promise<AgentUserPreference> {
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
        .prepare(`
          SELECT *
          FROM agent_user_preferences
          WHERE user_id = ?
          ORDER BY confidence DESC, updated_at DESC, id ASC
          LIMIT ?
        `)
        .all(normalizedUserId, limit) as unknown as PreferenceRow[];
      return rows.map(preferenceFromRow);
    });
  }

  async listContextCheckpoints(
    sessionId: string,
    limit = 100,
  ): Promise<AgentContextCheckpoint[]> {
    const normalizedSessionId = requireText(sessionId, 'sessionId');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error(
        'Context checkpoint limit must be an integer from 1 to 1000.',
      );
    }
    return this.withDatabase((database) => {
      const rows = database
        .prepare(`
          SELECT *
          FROM agent_context_checkpoints
          WHERE session_id = ?
          ORDER BY sequence DESC
          LIMIT ?
        `)
        .all(normalizedSessionId, limit) as unknown as ContextCheckpointRow[];
      return rows.map(contextCheckpointFromRow).reverse();
    });
  }

  async deletePreference(userId: string, key: string): Promise<boolean> {
    return this.withDatabase(
      (database) =>
        Number(
          database
            .prepare(
              'DELETE FROM agent_user_preferences WHERE user_id = ? AND preference_key = ?',
            )
            .run(requireText(userId, 'userId'), requireText(key, 'key')).changes,
        ) > 0,
    );
  }

  private async withDatabase<T>(
    operation: (database: NodeDatabaseSync) => T,
  ): Promise<T> {
    const database = await openDatabase(this.filePath);
    try {
      return operation(database);
    } finally {
      database.close();
    }
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
      title TEXT NOT NULL,
      user_id TEXT,
      mode TEXT NOT NULL,
      strategy TEXT NOT NULL,
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
      model_context_tokens INTEGER NOT NULL CHECK (model_context_tokens > 0),
      focus TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (session_id, sequence)
    );

    CREATE INDEX IF NOT EXISTS idx_agent_context_checkpoints_created
      ON agent_context_checkpoints(session_id, created_at DESC);

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
  `);
  migrateLegacySessionPayloads(database);
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
    strategy: session.strategy,
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
    strategy: row.strategy,
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
    ...(row.last_message_at === null
      ? {}
      : { lastMessageAt: row.last_message_at }),
  };
}

function parseSession(
  payload: string,
  normalizedMessages: AgentMessage[] = [],
): AgentSession {
  const parsed = JSON.parse(payload) as AgentSession;
  const messages =
    normalizedMessages.length > 0
      ? normalizedMessages
      : Array.isArray(parsed.messages)
        ? parsed.messages
        : [];
  return redactPersistedAgentValue({
    ...parsed,
    messages,
  }) as AgentSession;
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
  return /(?:以后请|默认(?:使用|采用|不要|优先)?|总是|始终|永远不要|不要再|我偏好|我希望)|(?:\bi prefer\b|\bfrom now on\b|\bby default\b|\bplease always\b|\bplease never\b|\bnever again\b)/i.test(
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

function normalizePreference(
  input: AgentPreferenceUpsertInput,
): AgentUserPreference {
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
    ...(input.sourceSessionId === undefined
      ? {}
      : { sourceSessionId: input.sourceSessionId }),
    ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
    createdAt: now,
    updatedAt: now,
  };
}

function upsertPreferenceRow(
  database: NodeDatabaseSync,
  preference: AgentUserPreference,
): void {
  const existing = database
    .prepare(
      'SELECT created_at FROM agent_user_preferences WHERE user_id = ? AND preference_key = ?',
    )
    .get(preference.userId, preference.key) as
    | { created_at: string }
    | undefined;
  database
    .prepare(`
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
    `)
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
    ...(row.source_session_id === null
      ? {}
      : { sourceSessionId: row.source_session_id }),
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
      throw new Error(
        `Persisted tool message is incomplete at index ${row.message_index}.`,
      );
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
    .prepare(`
      SELECT *
      FROM agent_session_messages
      WHERE session_id = ? AND message_index = ?
    `)
    .get(
      session.id,
      persistedMessageCount - 1,
    ) as SessionMessageRow | undefined;
  const current = session.messages[persistedMessageCount - 1];
  if (
    !row ||
    !current ||
    canonicalMessageJson(messageFromRow(row)) !==
      canonicalMessageJson(current)
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
    .prepare(`
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
    `)
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

function contextCheckpointFromRow(
  row: ContextCheckpointRow,
): AgentContextCheckpoint {
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
    .prepare(`
      SELECT id, payload_json
      FROM agent_sessions AS session
      WHERE NOT EXISTS (
        SELECT 1
        FROM agent_session_messages AS message
        WHERE message.session_id = session.id
      )
    `)
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
      updatePayload.run(
        JSON.stringify(sessionMetadataPayload(session)),
        row.id,
      );
      if (session.contextCheckpoint) {
        upsertContextCheckpointRow(
          database,
          row.id,
          session.contextCheckpoint,
        );
      }
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function sessionWithoutContextCheckpoint(
  session: AgentSession,
): AgentSession {
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
      lines.push(
        `Tool calls: ${message.toolCalls.map((tool) => tool.name).join(', ')}`,
        '',
      );
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
