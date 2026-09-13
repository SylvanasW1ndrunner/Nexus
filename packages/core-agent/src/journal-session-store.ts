import type { PortableValue } from '@dbagent/shared';
import type { AgentEvent } from './events/agent-event.js';
import { AgentJournalError, type AgentJournal } from './events/agent-journal.js';
import type {
  PersistedModelRuntimeBinding,
  SessionModelBinding,
} from './kernel/session-model-binding.js';
import type {
  LegacyAgentContextCheckpoint as AgentContextCheckpoint,
  LegacyAgentSubagentRecord as AgentSubagentRecord,
  LegacyAgentUserPreference as AgentUserPreference,
} from './session/legacy-import-types.js';
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
import { openSessionStateCommitter } from './internal/session-state-authority.js';
import type {
  ConfigureSessionSkillsCommand,
  SessionArchiveProjection,
  SessionIndexCursorKey,
  SessionIndexProjection,
  SessionSkillConfiguration,
  SessionSkillDefinition,
  SessionBootstrapProjection,
  SetSessionArchivedCommand,
} from './session/session-journal.js';

type LegacyPageOptions = { afterSequence: number; limit: number };

export type JournalSessionModelBindingView = Readonly<{
  revision: number;
  connectionId: string;
  modelId: string;
  parameters: Readonly<Record<string, PortableValue>>;
  updatedAt: string;
}>;

export type JournalSessionView = Readonly<SessionIndexProjection & {
  schemaVersion: 1;
  modelBinding?: JournalSessionModelBindingView;
  skillConfiguration: SessionSkillConfiguration;
}>;

export type JournalSessionListFilter = 'active' | 'archived' | 'all';
export type JournalSessionVisibility = 'public' | 'internal';

export type JournalSessionListPage = Readonly<{
  items: readonly SessionIndexProjection[];
  hasMore: boolean;
  nextCursor?: string;
}>;

/** Bounded Session/User/Audit views and Session commands over committed Journal facts. */
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
    return consumeSessionPages(this.journal, this.projectId, sessionId, new SessionProjectionAccumulator({
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
    return consumeSessionPages(
      this.journal,
      this.projectId,
      sessionId,
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
    return consumeSessionPages(this.journal, this.projectId, sessionId, new AuditProjectionAccumulator({
      projectId: this.projectId,
      sessionId,
      afterSequence: options.afterSequence ?? 0,
      limit: options.limit ?? 100,
    }, true));
  }

  async get(sessionId: string): Promise<JournalSessionView | null> {
    requireSessionId(sessionId);
    const state = await this.journal.getSessionState(this.projectId, sessionId);
    if (state === null) return null;
    const skillConfiguration: SessionSkillConfiguration = state.skillConfiguration ?? Object.freeze({
      schemaVersion: 1,
      projectId: this.projectId,
      sessionId,
      revision: 0,
      definitions: Object.freeze([]),
      updatedAt: state.index.createdAt,
    });
    return deepFreeze({
      schemaVersion: 1,
      ...state.index,
      ...(state.modelBinding === null ? {} : { modelBinding: publicModelBinding(state.modelBinding) }),
      skillConfiguration,
    });
  }

  async list(options: {
    filter?: JournalSessionListFilter;
    visibility?: JournalSessionVisibility;
    limit: number;
    cursor?: string;
  }): Promise<JournalSessionListPage> {
    const filter = options.filter ?? 'active';
    const visibility = options.visibility ?? 'public';
    if (filter !== 'active' && filter !== 'archived' && filter !== 'all') {
      throw new ProjectionError('LIMIT_INVALID', 'Session list filter is invalid.');
    }
    if (visibility !== 'public' && visibility !== 'internal') {
      throw new ProjectionError('LIMIT_INVALID', 'Session list visibility is invalid.');
    }
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 1_000) {
      throw new ProjectionError('LIMIT_INVALID', 'Session list limit must be between 1 and 1000.');
    }
    const before = options.cursor === undefined
      ? undefined
      : decodeSessionCursor(options.cursor, this.projectId, filter, visibility);
    const rows = await this.journal.listSessionIndexes({
      projectId: this.projectId,
      ...(filter === 'all' ? {} : { archived: filter === 'archived' }),
      visibility,
      ...(before === undefined ? {} : { before }),
      limit: options.limit + 1,
    });
    const hasMore = rows.length > options.limit;
    const items = rows.slice(0, options.limit);
    const last = items.at(-1);
    return deepFreeze({
      items,
      hasMore,
      ...(hasMore && last !== undefined
        ? { nextCursor: encodeSessionCursor(this.projectId, filter, visibility, last) }
        : {}),
    });
  }

  setArchived(
    command: Omit<SetSessionArchivedCommand, 'projectId'>,
  ): Promise<SessionArchiveProjection> {
    return openSessionStateCommitter(this.journal).setArchived({
      ...command,
      projectId: this.projectId,
    });
  }

  configureSkills(
    command: Omit<ConfigureSessionSkillsCommand, 'projectId'>,
  ): Promise<SessionSkillConfiguration> {
    return openSessionStateCommitter(this.journal).configureSkills({
      ...command,
      projectId: this.projectId,
    });
  }

  bootstrap(input: Readonly<{
    sessionId: string;
    commandId: string;
    model: PersistedModelRuntimeBinding;
    definitions: readonly SessionSkillDefinition[];
  }>): Promise<SessionBootstrapProjection> {
    return openSessionStateCommitter(this.journal).bootstrap({
      projectId: this.projectId,
      sessionId: input.sessionId,
      commandId: input.commandId,
      expectedModelRevision: 0,
      expectedSkillRevision: 0,
      model: input.model,
      definitions: input.definitions,
    });
  }

  async skillConfiguration(sessionId: string): Promise<SessionSkillConfiguration | null> {
    requireSessionId(sessionId);
    return await this.journal.getSessionSkillConfiguration(this.projectId, sessionId);
  }

  async resolveSkillDefinitions(
    sessionId: string,
    explicit: readonly SessionSkillDefinition[] | undefined,
  ): Promise<readonly SessionSkillDefinition[]> {
    requireSessionId(sessionId);
    if (explicit !== undefined) return deepFreeze(structuredClone(explicit));
    const persisted = await this.skillConfiguration(sessionId);
    return persisted?.definitions ?? Object.freeze([]);
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
      const page = await this.journal.readSession({
        projectId: this.projectId, sessionId, afterSequence: cursor, limit: 1_000,
      });
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

async function consumeSessionPages<T>(
  journal: AgentJournal,
  projectId: string,
  sessionId: string,
  accumulator: { accept(event: AgentEvent): boolean; finish(): T },
): Promise<T> {
  let readCursor = 0;
  while (true) {
    const page = await journal.readSession({
      projectId, sessionId, afterSequence: readCursor, limit: 1_000,
    });
    if (page.length === 0) return accumulator.finish();
    for (const event of page) {
      if (!accumulator.accept(event)) return accumulator.finish();
      readCursor = event.sequence;
    }
  }
}

function publicModelBinding(binding: SessionModelBinding): JournalSessionModelBindingView {
  const primary = binding.model.descriptor.primary;
  return deepFreeze({
    revision: binding.revision,
    connectionId: primary.route.connectionId,
    modelId: primary.route.modelId,
    parameters: structuredClone(primary.generation),
    updatedAt: binding.updatedAt,
  });
}

function encodeSessionCursor(
  projectId: string,
  filter: JournalSessionListFilter,
  visibility: JournalSessionVisibility,
  item: SessionIndexProjection,
): string {
  return Buffer.from(JSON.stringify({
    version: 2,
    projectId,
    filter,
    visibility,
    updatedAt: item.updatedAt,
    lastActivitySequence: item.lastActivitySequence,
    sessionId: item.sessionId,
  }), 'utf8').toString('base64url');
}

function decodeSessionCursor(
  cursor: string,
  projectId: string,
  filter: JournalSessionListFilter,
  visibility: JournalSessionVisibility,
): SessionIndexCursorKey {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new AgentJournalError('INVALID_ARGUMENT', 'Session list cursor is invalid.');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentJournalError('INVALID_ARGUMENT', 'Session list cursor is invalid.');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [
    'filter', 'lastActivitySequence', 'projectId', 'sessionId', 'updatedAt', 'version', 'visibility',
  ].sort();
  if (
    keys.length !== expected.length || keys.some((key, index) => key !== expected[index]) ||
    record.version !== 2 || record.projectId !== projectId || record.filter !== filter ||
    record.visibility !== visibility ||
    typeof record.updatedAt !== 'string' || !record.updatedAt.trim() ||
    typeof record.sessionId !== 'string' || !record.sessionId.trim() ||
    !Number.isSafeInteger(record.lastActivitySequence) || Number(record.lastActivitySequence) < 0
  ) {
    throw new AgentJournalError('INVALID_ARGUMENT', 'Session list cursor scope is invalid.');
  }
  return {
    updatedAt: record.updatedAt,
    lastActivitySequence: Number(record.lastActivitySequence),
    sessionId: record.sessionId,
  };
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}
