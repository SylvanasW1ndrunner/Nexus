import type { AgentEvent } from './events/agent-event.js';
import type { AgentJournal } from './events/agent-journal.js';
import type {
  AgentContextCheckpoint,
  AgentSubagentRecord,
  AgentUserPreference,
} from './types.js';
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

  async preferences(sessionId: string): Promise<LegacyPreferenceProjection[]> {
    requireSessionId(sessionId);
    const facts = await this.#legacyFacts(sessionId);
    return facts.flatMap(({ payload }) => payload.entityType === 'preference'
      ? [structuredClone(payload.record)]
      : []);
  }

  async checkpoints(sessionId: string): Promise<LegacyCheckpointProjection[]> {
    requireSessionId(sessionId);
    const facts = await this.#legacyFacts(sessionId);
    return facts.flatMap(({ payload }) => payload.entityType === 'checkpoint'
      ? [structuredClone(payload.record)]
      : []);
  }

  async subagents(sessionId: string): Promise<LegacySubagentProjection[]> {
    requireSessionId(sessionId);
    const facts = await this.#legacyFacts(sessionId);
    return facts.flatMap(({ payload }) => payload.entityType === 'subagent'
      ? [structuredClone(payload.record)]
      : []);
  }

  async #legacyFacts(
    sessionId: string,
  ): Promise<Array<Extract<AgentEvent, { type: 'legacy.imported' }>>> {
    const result: Array<Extract<AgentEvent, { type: 'legacy.imported' }>> = [];
    let cursor = 0;
    while (true) {
      const page = await this.journal.readProject(this.projectId, cursor, 1_000);
      if (page.length === 0) return result;
      for (const event of page) {
        cursor = event.sequence;
        if (event.sessionId === sessionId && event.type === 'legacy.imported') result.push(event);
      }
    }
  }
}

export type LegacyPreferenceProjection = AgentUserPreference;
export type LegacyCheckpointProjection = AgentContextCheckpoint;
export type LegacySubagentProjection = AgentSubagentRecord;

function requireSessionId(sessionId: string): void {
  if (!sessionId.trim()) throw new TypeError('sessionId is required.');
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
