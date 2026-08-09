import type { AgentEvent } from './events/agent-event.js';
import type { AgentJournal } from './events/agent-journal.js';
import {
  AuditProjectionAccumulator,
  SessionProjectionAccumulator,
  UserActivityProjectionAccumulator,
  type AuditProjectionEvent,
  type ProjectionPage,
  type SessionProjection,
  type UserActivityEvent,
} from './session/session-projection.js';

/** Read-only, bounded Session/User/Audit views over committed Journal facts. */
export class JournalSessionStore {
  constructor(
    private readonly journal: AgentJournal,
    private readonly projectId: string,
  ) {
    if (!projectId.trim()) throw new TypeError('projectId is required.');
  }

  load(
    sessionId: string,
    options: { afterSequence?: number; limit?: number } = {},
  ): Promise<SessionProjection> {
    return consumeProjectPages(this.journal, this.projectId, new SessionProjectionAccumulator({
      projectId: this.projectId,
      sessionId,
      afterSequence: options.afterSequence ?? 0,
      limit: options.limit ?? 100,
    }, true));
  }

  activities(
    sessionId: string,
    options: { afterSequence?: number; limit?: number } = {},
  ): Promise<ProjectionPage<UserActivityEvent>> {
    return consumeProjectPages(
      this.journal,
      this.projectId,
      new UserActivityProjectionAccumulator({
        projectId: this.projectId,
        sessionId,
        afterSequence: options.afterSequence ?? 0,
        limit: options.limit ?? 100,
      }, true),
    );
  }

  audit(
    sessionId: string,
    options: { afterSequence?: number; limit?: number } = {},
  ): Promise<ProjectionPage<AuditProjectionEvent>> {
    return consumeProjectPages(this.journal, this.projectId, new AuditProjectionAccumulator({
      projectId: this.projectId,
      sessionId,
      afterSequence: options.afterSequence ?? 0,
      limit: options.limit ?? 100,
    }, true));
  }
}

async function consumeProjectPages<T>(
  journal: AgentJournal,
  projectId: string,
  accumulator: { accept(event: AgentEvent): boolean; finish(): T },
): Promise<T> {
  let readCursor = 0;
  while (true) {
    const page = await journal.readProject(projectId, readCursor, 1_000);
    if (page.length === 0) return accumulator.finish();
    for (const event of page) {
      if (!accumulator.accept(event)) return accumulator.finish();
      readCursor = event.sequence;
    }
  }
}
