import type { PortableValue } from '@dbagent/shared';
import type {
  PersistedModelRuntimeBinding,
  SessionModelBinding,
} from '../kernel/session-model-binding.js';

export const SESSION_JOURNAL_EVENT_TYPES = [
  'session.model_bound',
  'session.archive_set',
  'session.skills_configured',
] as const;

export type SessionJournalEventType = (typeof SESSION_JOURNAL_EVENT_TYPES)[number];

export interface SessionJournalEventPayloadMap {
  'session.model_bound': SessionModelBinding;
  'session.archive_set': Readonly<{ revision: number; archived: boolean }>;
  'session.skills_configured': Readonly<{
    revision: number;
    definitions: readonly SessionSkillDefinition[];
  }>;
}

export type SessionJournalEvent<T extends SessionJournalEventType = SessionJournalEventType> =
  T extends SessionJournalEventType ? Readonly<{
    schemaVersion: 1;
    projectId: string;
    sessionId: string;
    sequence: number;
    eventId: string;
    type: T;
    payload: SessionJournalEventPayloadMap[T];
    occurredAt: string;
  }> : never;

export type StoredSessionJournalEvent = Readonly<{
  schemaVersion: number;
  projectId: string;
  sessionId: string;
  sequence: number;
  eventId: string;
  type: string;
  payload: PortableValue;
  occurredAt: string;
}>;

export type SessionArchiveProjection = Readonly<{
  schemaVersion: 1;
  projectId: string;
  sessionId: string;
  revision: number;
  archived: boolean;
  updatedAt: string;
}>;

export type SessionSkillConfiguration = Readonly<{
  schemaVersion: 1;
  projectId: string;
  sessionId: string;
  revision: number;
  definitions: readonly SessionSkillDefinition[];
  updatedAt: string;
}>;

/** core-agent-owned persisted shape; the host maps it to core-skills SkillOverlay. */
export type SessionSkillDefinition = Readonly<{
  content: string;
  sourcePath?: string;
}>;

export type SessionIndexProjection = Readonly<{
  projectId: string;
  sessionId: string;
  /** User-created top-level Sessions are roots; Runtime-created children are delegated. */
  kind: 'root' | 'delegated';
  /** Internal delegated Sessions remain addressable but are excluded from normal lists. */
  visibility: 'public' | 'internal';
  parentRunId?: string;
  parentSessionId?: string;
  archiveRevision: number;
  archived: boolean;
  title?: string;
  createdAt: string;
  updatedAt: string;
  lastActivitySequence: number;
  runCount: number;
}>;

export type SessionStateProjection = Readonly<{
  index: SessionIndexProjection;
  modelBinding: SessionModelBinding | null;
  skillConfiguration: SessionSkillConfiguration | null;
}>;

export type SessionIndexCursorKey = Readonly<{
  updatedAt: string;
  lastActivitySequence: number;
  sessionId: string;
}>;

export type ListSessionIndexesInput = Readonly<{
  projectId: string;
  archived?: boolean;
  visibility?: 'public' | 'internal';
  before?: SessionIndexCursorKey;
  limit: number;
}>;

export type SetSessionArchivedCommand = Readonly<{
  projectId: string;
  sessionId: string;
  commandId: string;
  expectedRevision: number;
  archived: boolean;
}>;

export type ConfigureSessionSkillsCommand = Readonly<{
  projectId: string;
  sessionId: string;
  commandId: string;
  expectedRevision: number;
  definitions: readonly SessionSkillDefinition[];
}>;

export type BootstrapSessionCommand = Readonly<{
  projectId: string;
  sessionId: string;
  commandId: string;
  expectedModelRevision: 0;
  expectedSkillRevision: 0;
  model: PersistedModelRuntimeBinding;
  definitions: readonly SessionSkillDefinition[];
}>;

export type SessionBootstrapProjection = Readonly<{
  modelBinding: SessionModelBinding;
  skillConfiguration: SessionSkillConfiguration;
}>;

export type SessionStateCommand = SetSessionArchivedCommand | ConfigureSessionSkillsCommand;
export type SessionStateCommitter = Readonly<{
  bootstrap(command: BootstrapSessionCommand): Promise<SessionBootstrapProjection>;
  setArchived(command: SetSessionArchivedCommand): Promise<SessionArchiveProjection>;
  configureSkills(command: ConfigureSessionSkillsCommand): Promise<SessionSkillConfiguration>;
}>;

export function upcastSessionJournalEvent(stored: StoredSessionJournalEvent): SessionJournalEvent {
  if (stored.schemaVersion !== 1) {
    throw new Error(`UNSUPPORTED_SESSION_EVENT_SCHEMA:${stored.type}:${stored.schemaVersion}`);
  }
  if (!SESSION_JOURNAL_EVENT_TYPES.includes(stored.type as SessionJournalEventType)) {
    throw new Error(`UNKNOWN_SESSION_EVENT_TYPE:${stored.type}`);
  }
  validateSessionJournalPayload(stored.type as SessionJournalEventType, stored.payload);
  return structuredClone(stored) as SessionJournalEvent;
}

export function validateSessionJournalPayload(
  type: SessionJournalEventType,
  payload: PortableValue,
): void {
  const record = requireRecord(payload);
  switch (type) {
    case 'session.model_bound':
      requireExactKeys(record, [
        'schemaVersion', 'projectId', 'sessionId', 'revision', 'model', 'updatedAt',
      ]);
      requirePositiveRevision(record['revision']!);
      requireText(record['projectId']!);
      requireText(record['sessionId']!);
      requireText(record['updatedAt']!);
      requireRecord(record['model']!);
      return;
    case 'session.archive_set':
      requireExactKeys(record, ['revision', 'archived']);
      requirePositiveRevision(record['revision']!);
      if (typeof record['archived'] !== 'boolean') throw new TypeError('Session archived must be boolean.');
      return;
    case 'session.skills_configured':
      requireExactKeys(record, ['revision', 'definitions']);
      requirePositiveRevision(record['revision']!);
      if (!Array.isArray(record['definitions'])) {
        throw new TypeError('Session Skill definitions must be an array.');
      }
      for (const value of record['definitions']) {
        const definition = requireRecord(value);
        requireExactKeys(
          definition,
          definition['sourcePath'] === undefined ? ['content'] : ['content', 'sourcePath'],
        );
        requireText(definition['content']!);
        if (definition['sourcePath'] !== undefined) requireText(definition['sourcePath']);
      }
      return;
  }
}

function requireRecord(value: PortableValue): Record<string, PortableValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Session event payload must be an object.');
  }
  return value;
}

function requireExactKeys(record: Record<string, PortableValue>, expected: readonly string[]): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`Session event payload keys are invalid: ${actual.join(',')}.`);
  }
}

function requirePositiveRevision(value: PortableValue): void {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError('Session event revision must be a positive integer.');
  }
}

function requireText(value: PortableValue): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('Session event text must be non-empty.');
  }
}
