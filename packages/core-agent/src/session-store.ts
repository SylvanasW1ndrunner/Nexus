import type {
  AgentContextCheckpoint,
  AgentMode,
  AgentProjectReference,
  AgentRunRecord,
  AgentRunStore,
  AgentSession,
  AgentSubagentRecord,
  AgentSubagentStore,
  AgentUserPreference,
} from './types.js';
import type { AgentJournal } from './events/agent-journal.js';
import {
  AuditProjector,
  UserActivityProjector,
  projectSession,
  type AuditProjectionEvent,
  type ProjectionPage,
  type SessionProjection,
  type UserActivityEvent,
} from './session/session-projection.js';
import { LegacySessionAuthorityDisabledError } from './session.js';

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

/**
 * Read-only bounded views over the committed Journal. This is the normal
 * Session store after the Task 4 cutover; it owns no mutable Session tables.
 */
export class JournalSessionStore {
  constructor(
    private readonly journal: AgentJournal,
    private readonly projectId: string,
  ) {
    if (!projectId.trim()) throw new TypeError('projectId is required.');
  }

  async load(
    sessionId: string,
    options: { afterSequence?: number; limit?: number } = {},
  ): Promise<SessionProjection> {
    const afterSequence = options.afterSequence ?? 0;
    const limit = options.limit ?? 100;
    const events = await readProjectBounded(this.journal, this.projectId, afterSequence, 10_000);
    return projectSession(events, {
      projectId: this.projectId,
      sessionId,
      afterSequence,
      limit,
    });
  }

  async activities(
    sessionId: string,
    options: { afterSequence?: number; limit?: number } = {},
  ): Promise<ProjectionPage<UserActivityEvent>> {
    const afterSequence = options.afterSequence ?? 0;
    const limit = options.limit ?? 100;
    const events = await readProjectBounded(this.journal, this.projectId, 0, 10_000);
    return new UserActivityProjector().project(events, {
      projectId: this.projectId,
      sessionId,
      afterSequence,
      limit,
    });
  }

  async audit(
    sessionId: string,
    options: { afterSequence?: number; limit?: number } = {},
  ): Promise<ProjectionPage<AuditProjectionEvent>> {
    const afterSequence = options.afterSequence ?? 0;
    const limit = options.limit ?? 100;
    const events = await readProjectBounded(this.journal, this.projectId, 0, 10_000);
    return new AuditProjector().project(events, {
      projectId: this.projectId,
      sessionId,
      afterSequence,
      limit,
    });
  }
}

/**
 * Disabled legacy API surface. It performs no SQLite read, write, migration,
 * or dual-read fallback; legacy bytes are consumed only by StateMigrationRunner.
 */
export class AgentSessionStore implements AgentSessionWriter, AgentSubagentStore, AgentRunStore {
  constructor(
    readonly filePath: string,
    readonly project?: AgentProjectReference,
  ) {
    if (!filePath.trim()) throw new TypeError('Agent session database path is required.');
  }

  forProject(project: AgentProjectReference): AgentSessionStore {
    return new AgentSessionStore(this.filePath, project);
  }

  save(input: SaveAgentSessionInput): Promise<AgentSessionSummary> {
    void input;
    return rejectDisabled('save');
  }
  load(id: string): Promise<AgentSession | undefined> {
    void id;
    return rejectDisabled('load');
  }
  list(filter: AgentSessionListFilter = {}): Promise<AgentSessionSummary[]> {
    void filter;
    return rejectDisabled('list');
  }
  update(
    id: string,
    patch: Partial<Pick<AgentSession, 'title' | 'mode' | 'aborted'>>,
    now?: string,
  ): Promise<AgentSessionSummary> {
    void id;
    void patch;
    void now;
    return rejectDisabled('update');
  }
  archive(id: string, archived?: boolean, now?: string): Promise<AgentSessionSummary> {
    void id;
    void archived;
    void now;
    return rejectDisabled('archive');
  }
  delete(id: string): Promise<boolean> {
    void id;
    return rejectDisabled('delete');
  }
  fork(input: {
    id: string;
    fromMessageIndex: number;
    newId?: string;
    title?: string;
    now?: string;
  }): Promise<AgentSession> {
    void input;
    return rejectDisabled('fork');
  }
  export(id: string, format: AgentSessionExportFormat): Promise<string> {
    void id;
    void format;
    return rejectDisabled('export');
  }
  upsertPreference(input: AgentPreferenceUpsertInput): Promise<AgentUserPreference> {
    void input;
    return rejectDisabled('upsertPreference');
  }
  listPreferences(userId: string, limit?: number): Promise<AgentUserPreference[]> {
    void userId;
    void limit;
    return rejectDisabled('listPreferences');
  }
  listContextCheckpoints(
    sessionId: string,
    limit?: number,
  ): Promise<AgentContextCheckpoint[]> {
    void sessionId;
    void limit;
    return rejectDisabled('listContextCheckpoints');
  }
  deletePreference(userId: string, key: string): Promise<boolean> {
    void userId;
    void key;
    return rejectDisabled('deletePreference');
  }
  saveRun(record: AgentRunRecord): Promise<void> {
    void record;
    return rejectDisabled('saveRun');
  }
  getRun(runId: string): Promise<AgentRunRecord | undefined> {
    void runId;
    return rejectDisabled('getRun');
  }
  listRuns(sessionId?: string, limit?: number): Promise<AgentRunRecord[]> {
    void sessionId;
    void limit;
    return rejectDisabled('listRuns');
  }
  recoverInterrupted(now?: string): Promise<number> {
    void now;
    return rejectDisabled('recoverInterrupted');
  }
  saveSubagent(record: AgentSubagentRecord): void {
    void record;
    throw disabled('saveSubagent');
  }
  loadSubagent(id: string): AgentSubagentRecord | undefined {
    void id;
    throw disabled('loadSubagent');
  }
  listSubagents(parentSessionId?: string): AgentSubagentRecord[] {
    void parentSessionId;
    throw disabled('listSubagents');
  }
}

async function readProjectBounded(
  journal: AgentJournal,
  projectId: string,
  afterSequence: number,
  maximumEvents: number,
) {
  const events = [];
  let cursor = afterSequence;
  while (events.length < maximumEvents) {
    const page = await journal.readProject(
      projectId,
      cursor,
      Math.min(1_000, maximumEvents - events.length),
    );
    if (page.length === 0) return events;
    events.push(...page);
    cursor = page.at(-1)!.sequence;
  }
  return events;
}

function disabled(operation: string): LegacySessionAuthorityDisabledError {
  return new LegacySessionAuthorityDisabledError(`AgentSessionStore.${operation}`);
}

function rejectDisabled<T>(operation: string): Promise<T> {
  return Promise.reject(disabled(operation));
}
