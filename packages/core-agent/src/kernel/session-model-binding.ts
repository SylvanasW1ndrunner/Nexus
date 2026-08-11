import type { SqliteAgentJournal } from '../events/sqlite-agent-journal.js';
import { openSessionBindingCommitter } from '../internal/session-binding-authority.js';

export type SessionModelBinding = Readonly<{
  schemaVersion: 1;
  projectId: string;
  sessionId: string;
  revision: number;
  connectionId: string;
  modelId: string;
  updatedAt: string;
}>;

export type BindSessionModelCommand = Readonly<{
  projectId: string;
  sessionId: string;
  commandId: string;
  expectedRevision: number;
  connectionId: string;
  modelId: string;
}>;

export class SessionModelBindingStore {
  constructor(private readonly journal: SqliteAgentJournal) {}

  async bind(command: BindSessionModelCommand): Promise<SessionModelBinding> {
    return await openSessionBindingCommitter(this.journal).commit(structuredClone(command));
  }

  async get(projectId: string, sessionId: string): Promise<SessionModelBinding | null> {
    return await this.journal.getSessionModelBinding(projectId, sessionId);
  }
}
