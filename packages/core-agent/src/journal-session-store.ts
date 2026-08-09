import type { AgentEvent } from './events/agent-event.js';
import type { AgentJournal } from './events/agent-journal.js';
import type {
  AgentContextCheckpoint,
  AgentSubagentRecord,
  AgentUserPreference,
} from './types.js';
import {
  AuditProjectionAccumulator,
  ProjectionError,
  SessionProjectionAccumulator,
  UserActivityProjectionAccumulator,
  type AuditProjectionEvent,
  type ProjectionPage,
  type SessionProjection,
  type UserActivityEvent,
} from './session/session-projection.js';

type LegacyPageOptions = { afterSequence: number; limit: number };

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

  async preferences(
    sessionId: string,
    options: LegacyPageOptions,
  ): Promise<ProjectionPage<LegacyPreferenceProjection>> {
    requireSessionId(sessionId);
    return await this.#legacyPage(sessionId, options, (event) =>
      event.payload.entityType === 'preference' ? structuredClone(event.payload.record) : undefined);
  }

  async checkpoints(
    sessionId: string,
    options: LegacyPageOptions,
  ): Promise<ProjectionPage<LegacyCheckpointProjection>> {
    requireSessionId(sessionId);
    return await this.#legacyPage(sessionId, options, (event) =>
      event.payload.entityType === 'checkpoint' ? structuredClone(event.payload.record) : undefined);
  }

  async subagents(
    sessionId: string,
    options: LegacyPageOptions,
  ): Promise<ProjectionPage<LegacySubagentProjection>> {
    requireSessionId(sessionId);
    return await this.#legacyPage(sessionId, options, (event) =>
      event.payload.entityType === 'subagent' ? structuredClone(event.payload.record) : undefined);
  }

  async #legacyPage<T>(
    sessionId: string,
    options: LegacyPageOptions,
    select: (event: Extract<AgentEvent, { type: 'legacy.imported' }>) => T | undefined,
  ): Promise<ProjectionPage<T>> {
    requireLegacyPageOptions(options);
    const items: T[] = [];
    let cursor = options.afterSequence;
    while (true) {
      const page = await this.journal.readProject(this.projectId, cursor, 1_000);
      if (page.length === 0) return { items, nextSourceSequence: cursor };
      for (const event of page) {
        cursor = event.sequence;
        if (event.sessionId !== sessionId || event.type !== 'legacy.imported') continue;
        const item = select(event);
        if (item === undefined) continue;
        items.push(item);
        if (items.length === options.limit) return { items, nextSourceSequence: cursor };
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

function requireLegacyPageOptions(options: LegacyPageOptions): void {
  if (!Number.isSafeInteger(options.afterSequence) || options.afterSequence < 0) {
    throw new ProjectionError('LIMIT_INVALID', 'afterSequence must be non-negative.');
  }
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 1_000) {
    throw new ProjectionError('LIMIT_INVALID', 'Projection limit must be between 1 and 1000.');
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
