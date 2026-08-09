import { assertPortableValue, type PortableValue } from '@dbagent/shared';
import type {
  AgentMessage,
  AgentRunRecord,
  AgentRunRecordStatus,
  AgentSession,
} from '../types.js';
import type { AgentEvent, AgentEventType } from '../events/agent-event.js';
import {
  AGENT_EVENT_SCHEMA_REGISTRY,
  validateAndRedactEventPayload,
} from '../events/event-schema-registry.js';

export type ProjectionErrorCode =
  | 'PROJECT_MISMATCH'
  | 'SEQUENCE_INVALID'
  | 'SCHEMA_INVALID'
  | 'CAUSALITY_INVALID'
  | 'RUN_CAUSALITY_INVALID'
  | 'LIMIT_INVALID';

export class ProjectionError extends Error {
  constructor(
    readonly code: ProjectionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProjectionError';
  }
}

export type SessionProjectionMessage = AgentMessage & {
  sourceSequence: number;
  runId: string;
};

export type SessionProjectionArtifact = {
  sourceSequence: number;
  artifactId: string;
  handle: string;
  byteSize: number | null;
  mediaType: string;
  availability: 'available' | 'legacy-unavailable' | 'expired' | 'deleted';
  summary: string;
  createdAt: string;
};

export type SessionProjectionRun = {
  runId: string;
  clientRequestId: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  terminal?: boolean;
  legacyRecord?: AgentRunRecord;
};

export type SessionProjectionLegacySession = {
  session: AgentSession;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
};

export type SessionProjection = {
  schemaVersion: 1;
  projectId: string;
  sessionId: string;
  title?: string;
  userId?: string | null;
  mode?: string;
  legacySession?: SessionProjectionLegacySession;
  messages: SessionProjectionMessage[];
  artifacts: SessionProjectionArtifact[];
  runs: SessionProjectionRun[];
  lastSourceSequence: number;
  nextSourceSequence: number;
};

export type UserActivityEvent = {
  schemaVersion: 1;
  sourceSequence: number;
  activityId: string;
  runId: string;
  kind: 'status' | 'model-preview' | 'tool' | 'approval' | 'result' | 'artifact' | 'final';
  phase: 'started' | 'progress' | 'succeeded' | 'failed' | 'waiting' | 'discarded';
  summary: string;
  detail?: PortableValue;
  replaceKey?: string;
  artifactRefs?: string[];
  evidenceRefs?: string[];
  createdAt: string;
};

export type ProjectionPage<T> = {
  items: T[];
  nextSourceSequence: number;
};

export type ProjectionOptions = {
  projectId: string;
  sessionId: string;
  afterSequence: number;
  limit: number;
};

export type AuditProjectionEvent = {
  sourceSequence: number;
  eventId: string;
  projectId: string;
  sessionId: string;
  runId: string;
  type: AgentEventType;
  occurredAt: string;
  payload: PortableValue;
  turnId?: string;
  attemptId?: string;
  invocationId?: string;
  parentEventId?: string;
};

type ActivityDescriptor = {
  kind: UserActivityEvent['kind'];
  phase: UserActivityEvent['phase'];
};

export const EVENT_TO_ACTIVITY = Object.freeze(
  {
    'run.started': { kind: 'status', phase: 'started' },
    'run.resumed': { kind: 'status', phase: 'started' },
    'run.input_requested': { kind: 'status', phase: 'waiting' },
    'run.limit_reached': { kind: 'status', phase: 'waiting' },
    'run.failed': { kind: 'status', phase: 'failed' },
    'run.cancelled': { kind: 'status', phase: 'failed' },
    'run.interrupted': { kind: 'status', phase: 'failed' },
    model_delta_batch: { kind: 'model-preview', phase: 'progress' },
    model_attempt_discarded: { kind: 'model-preview', phase: 'discarded' },
    'tool.proposed': { kind: 'tool', phase: 'started' },
    'tool.approval_requested': { kind: 'approval', phase: 'waiting' },
    'tool.progress': { kind: 'tool', phase: 'progress' },
    'tool.succeeded': { kind: 'result', phase: 'succeeded' },
    'tool.failed': { kind: 'result', phase: 'failed' },
    'tool.cancelled': { kind: 'result', phase: 'failed' },
    'tool.outcome_unknown': { kind: 'result', phase: 'waiting' },
    'artifact.created': { kind: 'artifact', phase: 'succeeded' },
    'artifact.expired': { kind: 'artifact', phase: 'failed' },
    'artifact.deleted': { kind: 'artifact', phase: 'failed' },
    'run.completed': { kind: 'final', phase: 'succeeded' },
  } satisfies Partial<Record<AgentEventType, ActivityDescriptor>>,
);

export function projectSession(
  events: readonly AgentEvent[],
  options: ProjectionOptions,
): SessionProjection {
  const accumulator = new SessionProjectionAccumulator(options);
  for (const event of events) {
    if (!accumulator.accept(event)) break;
  }
  return accumulator.finish();
}

export class UserActivityProjector {
  project(
    events: readonly AgentEvent[],
    options: ProjectionOptions,
  ): ProjectionPage<UserActivityEvent> {
    const accumulator = new UserActivityProjectionAccumulator(options);
    for (const event of events) {
      if (!accumulator.accept(event)) break;
    }
    return accumulator.finish();
  }
}

export class AuditProjector {
  project(
    events: readonly AgentEvent[],
    options: ProjectionOptions,
  ): ProjectionPage<AuditProjectionEvent> {
    const accumulator = new AuditProjectionAccumulator(options);
    for (const event of events) {
      if (!accumulator.accept(event)) break;
    }
    return accumulator.finish();
  }
}

type Scope = { projectId: string; sessionId: string; runId: string; sequence: number };
type RunScope = Scope & { clientRequestId?: string; createdAt?: string };
type TurnScope = Scope & { turnId: string };
type AttemptScope = TurnScope & { attemptId: string };
type InvocationScope = AttemptScope & { invocationId: string };
export type ProjectionRetainedScopes = {
  runs: number;
  turns: number;
  attempts: number;
  invocations: number;
  finalText: number;
};

type TerminalProjectionSnapshot = {
  run: RunScope | undefined;
  finalText: string | undefined;
};

export class ProjectionEventValidator {
  readonly #projectId: string;
  readonly #targetSessionId: string | undefined;
  readonly #trustedJournal: boolean;
  readonly #events = new Map<string, Scope>();
  readonly #runs = new Map<string, RunScope>();
  readonly #turns = new Map<string, TurnScope>();
  readonly #attempts = new Map<string, AttemptScope>();
  readonly #invocations = new Map<string, InvocationScope>();
  readonly #finalText = new Map<string, { runId: string; turnId: string; text: string }>();
  #previousSequence = 0;

  constructor(
    projectId: string,
    options: { targetSessionId?: string; trustedJournal?: boolean } = {},
  ) {
    if (!projectId.trim()) throw new ProjectionError('LIMIT_INVALID', 'Project is required.');
    this.#projectId = projectId;
    this.#targetSessionId = options.targetSessionId;
    this.#trustedJournal = options.trustedJournal ?? false;
  }

  accept(event: AgentEvent): void {
    if (event.projectId !== this.#projectId) {
      throw new ProjectionError('PROJECT_MISMATCH', 'Projection input crossed Project boundary.');
    }
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= this.#previousSequence) {
      throw new ProjectionError('SEQUENCE_INVALID', 'Source sequence must be strictly monotonic.');
    }
    this.#previousSequence = event.sequence;
    if (this.#trustedJournal && event.sessionId !== this.#targetSessionId) return;
    const descriptor = AGENT_EVENT_SCHEMA_REGISTRY[event.type];
    if (event.schemaVersion !== descriptor.schemaVersion) {
      throw new ProjectionError('SCHEMA_INVALID', 'Projection input was not upcast to current schema.');
    }
    try {
      validateAndRedactEventPayload(event.type, event.payload);
    } catch (error) {
      throw new ProjectionError(
        'SCHEMA_INVALID',
        `Projection payload is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!this.#trustedJournal && this.#events.has(event.eventId)) {
      throw new ProjectionError('CAUSALITY_INVALID', 'Event identity is duplicated.');
    }
    if (!this.#trustedJournal && event.parentEventId !== undefined) {
      const parent = this.#events.get(event.parentEventId);
      if (!sameScope(parent, event) || parent.sequence >= event.sequence) {
        throw new ProjectionError('CAUSALITY_INVALID', 'Event parent causality is invalid.');
      }
    }
    if (event.type === 'input.received') {
      if (this.#runs.has(event.runId)) {
        throw new ProjectionError('RUN_CAUSALITY_INVALID', 'Run input is duplicated.');
      }
      this.#runs.set(event.runId, {
        ...scopeOf(event),
        clientRequestId: event.payload.clientRequestId,
      });
    } else {
      const run = this.#runs.get(event.runId);
      if (!sameScope(run, event)) {
        throw new ProjectionError('RUN_CAUSALITY_INVALID', 'Event Run causality is invalid.');
      }
      if (event.type === 'run.created') {
        if (run.clientRequestId !== event.payload.clientRequestId) {
          throw new ProjectionError(
            'RUN_CAUSALITY_INVALID',
            'Run creation disagrees with the accepted input request.',
          );
        }
        run.createdAt = event.occurredAt;
      }
    }
    this.#validateTurnAttemptInvocation(event);
    if (event.type === 'run.completed') this.resolveFinalText(event);
    if (!this.#trustedJournal) this.#events.set(event.eventId, scopeOf(event));
  }

  run(runId: string): RunScope | undefined { return this.#runs.get(runId); }

  retainedScopes(): ProjectionRetainedScopes {
    return {
      runs: this.#runs.size,
      turns: this.#turns.size,
      attempts: this.#attempts.size,
      invocations: this.#invocations.size,
      finalText: this.#finalText.size,
    };
  }

  resolveFinalText(event: Extract<AgentEvent, { type: 'run.completed' }>): string {
    const parsed = /^turn:([^:]+):text:(\d+)$/u.exec(event.payload.finalContentRef);
    const resolved = parsed === null ? undefined : this.#finalText.get(event.payload.finalContentRef);
    if (parsed === null || resolved === undefined || resolved.runId !== event.runId ||
      resolved.turnId !== parsed[1]) {
      throw new ProjectionError('CAUSALITY_INVALID', 'Run finalContentRef does not resolve exactly.');
    }
    return resolved.text;
  }

  releaseTerminal(event: AgentEvent): TerminalProjectionSnapshot | undefined {
    if (!this.#trustedJournal || !isTerminalRunEvent(event.type)) return undefined;
    const snapshot: TerminalProjectionSnapshot = {
      run: this.#runs.get(event.runId),
      finalText: event.type === 'run.completed' ? this.resolveFinalText(event) : undefined,
    };
    this.#runs.delete(event.runId);
    for (const [key, scope] of this.#turns) {
      if (scope.runId === event.runId) this.#turns.delete(key);
    }
    for (const [key, scope] of this.#attempts) {
      if (scope.runId === event.runId) this.#attempts.delete(key);
    }
    for (const [key, scope] of this.#invocations) {
      if (scope.runId === event.runId) this.#invocations.delete(key);
    }
    for (const [key, scope] of this.#finalText) {
      if (scope.runId === event.runId) this.#finalText.delete(key);
    }
    return snapshot;
  }

  #validateTurnAttemptInvocation(event: AgentEvent): void {
    if (event.type === 'turn.started') {
      if (event.turnId === undefined || this.#turns.has(event.turnId)) {
        throw new ProjectionError('CAUSALITY_INVALID', 'Turn identity is missing or duplicated.');
      }
      this.#turns.set(event.turnId, { ...scopeOf(event), turnId: event.turnId });
    } else if (event.turnId !== undefined && !sameScope(this.#turns.get(event.turnId), event)) {
      throw new ProjectionError('CAUSALITY_INVALID', 'Event Turn ownership is invalid.');
    }

    if (event.attemptId !== undefined) {
      if (event.turnId === undefined) {
        throw new ProjectionError('CAUSALITY_INVALID', 'Attempt is missing Turn ownership.');
      }
      if (event.type === 'model_attempt_started') {
        if (this.#attempts.has(event.attemptId)) {
          throw new ProjectionError('CAUSALITY_INVALID', 'Attempt identity is duplicated.');
        }
        this.#attempts.set(event.attemptId, {
          ...scopeOf(event), turnId: event.turnId, attemptId: event.attemptId,
        });
      } else if (event.type === 'model_attempt_committed') {
        if (event.payload.validatedAttempt.attemptId !== event.attemptId) {
          throw new ProjectionError('CAUSALITY_INVALID', 'Committed Attempt outer identity disagrees.');
        }
        const existing = this.#attempts.get(event.attemptId);
        if (existing !== undefined && (!sameScope(existing, event) || existing.turnId !== event.turnId)) {
          throw new ProjectionError('CAUSALITY_INVALID', 'Committed Attempt ownership is invalid.');
        }
        if (existing === undefined) {
          this.#attempts.set(event.attemptId, {
            ...scopeOf(event), turnId: event.turnId, attemptId: event.attemptId,
          });
        }
        event.payload.validatedAttempt.blocks.forEach((block, index) => {
          if (block.type === 'text') {
            this.#finalText.set(`turn:${event.turnId}:text:${index}`, {
              runId: event.runId, turnId: event.turnId!, text: block.text,
            });
          }
        });
      } else {
        const attempt = this.#attempts.get(event.attemptId);
        if (!sameScope(attempt, event) || attempt.turnId !== event.turnId) {
          throw new ProjectionError('CAUSALITY_INVALID', 'Event Attempt ownership is invalid.');
        }
      }
    }

    if (event.invocationId !== undefined) {
      if (event.turnId === undefined || event.attemptId === undefined) {
        throw new ProjectionError('CAUSALITY_INVALID', 'Invocation is missing Attempt ownership.');
      }
      if (event.type === 'tool.proposed') {
        if (event.payload.invocationId !== event.invocationId || this.#invocations.has(event.invocationId)) {
          throw new ProjectionError('CAUSALITY_INVALID', 'Tool proposal Invocation identity is invalid.');
        }
        this.#invocations.set(event.invocationId, {
          ...scopeOf(event), turnId: event.turnId, attemptId: event.attemptId,
          invocationId: event.invocationId,
        });
      } else {
        const payloadInvocationId = invocationIdFromPayload(event.payload);
        if (payloadInvocationId !== undefined && payloadInvocationId !== event.invocationId) {
          throw new ProjectionError(
            'CAUSALITY_INVALID',
            'Tool payload Invocation identity disagrees with its outer identity.',
          );
        }
        const invocation = this.#invocations.get(event.invocationId);
        if (!sameScope(invocation, event) || invocation.turnId !== event.turnId ||
          invocation.attemptId !== event.attemptId) {
          throw new ProjectionError('CAUSALITY_INVALID', 'Event Invocation ownership is invalid.');
        }
      }
    }
  }
}

export class SessionProjectionAccumulator {
  readonly #options: ProjectionOptions;
  readonly #validator: ProjectionEventValidator;
  readonly #messages: SessionProjectionMessage[] = [];
  readonly #artifacts = new Map<string, SessionProjectionArtifact>();
  readonly #runs = new Map<string, SessionProjectionRun>();
  readonly #hiddenRuns = new Set<string>();
  #legacyMetadata: {
    title: string;
    userId: string | null;
    mode: string;
    legacySession?: SessionProjectionLegacySession;
  } | undefined;
  #cursor: number;

  constructor(options: ProjectionOptions, trustedJournal = false) {
    requireProjectionOptions(options);
    this.#options = options;
    this.#validator = new ProjectionEventValidator(options.projectId, {
      targetSessionId: options.sessionId,
      trustedJournal,
    });
    this.#cursor = options.afterSequence;
  }

  accept(event: AgentEvent): boolean {
    this.#validator.accept(event);
    const terminal = event.sessionId === this.#options.sessionId
      ? this.#validator.releaseTerminal(event)
      : undefined;
    if (event.sessionId !== this.#options.sessionId) {
      this.#cursor = Math.max(this.#cursor, event.sequence);
      return true;
    }
    if (event.sequence <= this.#options.afterSequence) return true;
    if (wouldOverflowSessionPage(
      event,
      this.#messages,
      this.#artifacts,
      this.#runs,
      terminal?.run ?? this.#validator.run(event.runId),
      this.#options.limit,
    )) {
      return false;
    }
    this.#cursor = event.sequence;
    this.#apply(event, terminal?.run);
    return true;
  }

  retainedScopes(): ProjectionRetainedScopes {
    return this.#validator.retainedScopes();
  }

  finish(): SessionProjection {
    return {
      schemaVersion: 1,
      projectId: this.#options.projectId,
      sessionId: this.#options.sessionId,
      ...(this.#legacyMetadata === undefined ? {} : this.#legacyMetadata),
      messages: [...this.#messages],
      artifacts: [...this.#artifacts.values()].sort((a, b) => a.sourceSequence - b.sourceSequence),
      runs: [...this.#runs.values()].sort(
        (left, right) => left.createdAt.localeCompare(right.createdAt) || left.runId.localeCompare(right.runId),
      ),
      lastSourceSequence: this.#cursor,
      nextSourceSequence: this.#cursor,
    };
  }

  #apply(event: AgentEvent, terminalRun?: RunScope): void {
    if (event.type === 'input.received') {
      const content = publicInputText(event.payload.content);
      if (content !== undefined) this.#messages.push(sessionMessage(event, 'user', content));
    } else if (event.type === 'model_attempt_committed') {
      const content = committedText(event);
      if (content.length > 0) this.#messages.push(sessionMessage(event, 'assistant', content));
    } else if (event.type === 'legacy.imported' && event.payload.entityType === 'session') {
      const imported = structuredClone(event.payload.record);
      this.#legacyMetadata = {
        title: imported.session.title,
        userId: imported.session.userId ?? null,
        mode: imported.session.mode,
        legacySession: imported,
      };
    } else if (event.type === 'legacy.imported' && event.payload.entityType === 'message') {
      const message = legacySessionMessage(event);
      this.#messages.push(message);
      if (this.#legacyMetadata?.legacySession !== undefined) {
        this.#legacyMetadata.legacySession.session.messages.push(
          structuredClone(event.payload.record),
        );
      }
    }
    if (event.type === 'artifact.created') {
      this.#artifacts.set(event.payload.artifactId, {
        sourceSequence: event.sequence,
        artifactId: event.payload.artifactId,
        handle: event.payload.handle,
        byteSize: event.payload.byteSize,
        mediaType: event.payload.mediaType,
        availability: event.payload.availability,
        summary: event.payload.summary,
        createdAt: event.occurredAt,
      });
    } else if (event.type === 'artifact.expired' || event.type === 'artifact.deleted') {
      const artifact = this.#artifacts.get(event.payload.artifactId);
      if (artifact !== undefined) {
        artifact.availability = event.type === 'artifact.expired' ? 'expired' : 'deleted';
        artifact.sourceSequence = event.sequence;
      }
    }
    if (event.type === 'run.created') {
      this.#runs.set(event.runId, {
        runId: event.runId,
        clientRequestId: event.payload.clientRequestId,
        state: 'created',
        createdAt: event.occurredAt,
        updatedAt: event.occurredAt,
      });
    } else if (event.type === 'legacy.imported' && event.payload.entityType === 'run') {
      this.#hiddenRuns.add(event.runId);
      this.#runs.delete(event.runId);
      const record = structuredClone(event.payload.record);
      this.#runs.set(record.runId, {
        runId: record.runId,
        clientRequestId: `legacy:${record.runId}`,
        state: legacyRunRecordState(record.status),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        terminal: true,
        legacyRecord: record,
      });
      return;
    } else if (event.type === 'legacy.imported') {
      this.#hiddenRuns.add(event.runId);
      this.#runs.delete(event.runId);
    } else if (!this.#hiddenRuns.has(event.runId)) {
      const state = projectedRunState(event.type);
      if (state !== undefined) {
        const existing = this.#runs.get(event.runId);
        const run = terminalRun ?? this.#validator.run(event.runId);
        if (existing !== undefined) {
          existing.state = state;
          existing.updatedAt = event.occurredAt;
        } else if (run?.clientRequestId !== undefined && run.createdAt !== undefined) {
          this.#runs.set(event.runId, {
            runId: event.runId, clientRequestId: run.clientRequestId, state,
            createdAt: run.createdAt, updatedAt: event.occurredAt,
          });
        }
      }
    }
  }
}

export class UserActivityProjectionAccumulator {
  readonly #options: ProjectionOptions;
  readonly #validator: ProjectionEventValidator;
  readonly #items: UserActivityEvent[] = [];
  readonly #legacyCarrierRuns = new Set<string>();
  #cursor: number;

  constructor(options: ProjectionOptions, trustedJournal = false) {
    requireProjectionOptions(options);
    this.#options = options;
    this.#validator = new ProjectionEventValidator(options.projectId, {
      targetSessionId: options.sessionId,
      trustedJournal,
    });
    this.#cursor = options.afterSequence;
  }

  accept(event: AgentEvent): boolean {
    this.#validator.accept(event);
    const terminal = event.sessionId === this.#options.sessionId
      ? this.#validator.releaseTerminal(event)
      : undefined;
    if (event.sessionId !== this.#options.sessionId || event.sequence <= this.#options.afterSequence) {
      if (event.sessionId !== this.#options.sessionId) {
        this.#cursor = Math.max(this.#cursor, event.sequence);
      }
      return true;
    }
    if (event.type === 'legacy.imported') this.#legacyCarrierRuns.add(event.runId);
    const descriptor = event.type === 'legacy.imported'
      ? legacyActivityDescriptor(event.payload.entityType)
      : this.#legacyCarrierRuns.has(event.runId)
        ? undefined
        : EVENT_TO_ACTIVITY[event.type as keyof typeof EVENT_TO_ACTIVITY];
    if (descriptor !== undefined) {
      if (this.#items.length >= this.#options.limit) return false;
      const finalText = event.type === 'run.completed'
        ? terminal?.finalText ?? this.#validator.resolveFinalText(event)
        : undefined;
      this.#items.push(toUserActivity(event, descriptor, finalText));
    }
    this.#cursor = Math.max(this.#cursor, event.sequence);
    return true;
  }

  retainedScopes(): ProjectionRetainedScopes {
    return this.#validator.retainedScopes();
  }

  finish(): ProjectionPage<UserActivityEvent> {
    return { items: [...this.#items], nextSourceSequence: this.#cursor };
  }
}

export class AuditProjectionAccumulator {
  readonly #options: ProjectionOptions;
  readonly #validator: ProjectionEventValidator;
  readonly #items: AuditProjectionEvent[] = [];
  #cursor: number;

  constructor(options: ProjectionOptions, trustedJournal = false) {
    requireProjectionOptions(options);
    this.#options = options;
    this.#validator = new ProjectionEventValidator(options.projectId, {
      targetSessionId: options.sessionId,
      trustedJournal,
    });
    this.#cursor = options.afterSequence;
  }

  accept(event: AgentEvent): boolean {
    this.#validator.accept(event);
    if (event.sessionId === this.#options.sessionId) this.#validator.releaseTerminal(event);
    if (event.sessionId === this.#options.sessionId && event.sequence > this.#options.afterSequence) {
      if (this.#items.length >= this.#options.limit) return false;
      this.#items.push(toAuditEvent(event));
    }
    this.#cursor = Math.max(this.#cursor, event.sequence);
    return true;
  }

  finish(): ProjectionPage<AuditProjectionEvent> {
    return { items: [...this.#items], nextSourceSequence: this.#cursor };
  }
}

function requireProjectionOptions(options: ProjectionOptions): void {
  if (!options.projectId.trim() || !options.sessionId.trim()) {
    throw new ProjectionError('LIMIT_INVALID', 'Project and Session are required.');
  }
  if (!Number.isSafeInteger(options.afterSequence) || options.afterSequence < 0) {
    throw new ProjectionError('LIMIT_INVALID', 'afterSequence must be non-negative.');
  }
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 1_000) {
    throw new ProjectionError('LIMIT_INVALID', 'Projection limit must be between 1 and 1000.');
  }
}

function toUserActivity(
  event: AgentEvent,
  descriptor: ActivityDescriptor,
  finalText: string | undefined,
): UserActivityEvent {
  const base = {
    schemaVersion: 1 as const,
    sourceSequence: event.sequence,
    activityId: `activity:${event.sequence}:${descriptor.kind}`,
    runId: event.runId,
    kind: descriptor.kind,
    phase: descriptor.phase,
    createdAt: event.occurredAt,
  };
  switch (event.type) {
    case 'legacy.imported':
      switch (event.payload.entityType) {
        case 'message':
          return {
            ...base,
            runId: event.payload.sourceRunId,
            summary: event.payload.record.content,
            detail: {
              entityType: 'message',
              role: event.payload.record.role,
              sourceRunId: event.payload.sourceRunId,
            },
          };
        case 'run':
          return {
            ...base,
            runId: event.payload.record.runId,
            summary: event.payload.record.finalText || `Legacy run ${event.payload.record.status}.`,
            detail: {
              entityType: 'run',
              record: portableProjectionPayload(event.payload.record),
            },
          };
        case 'session':
        case 'preference':
        case 'checkpoint':
        case 'subagent':
        case 'diagnostic':
        case 'archive':
          throw new ProjectionError('SCHEMA_INVALID', 'Legacy entity is not a User Activity fact.');
        default:
          return projectionAssertNever(event.payload);
      }
    case 'model_delta_batch':
      return {
        ...base,
        summary: previewText(event.payload.blocks),
        replaceKey: event.attemptId ?? `preview:${event.runId}`,
      };
    case 'model_attempt_discarded':
      return {
        ...base,
        summary: 'Tentative model output was discarded.',
        replaceKey: event.attemptId ?? `preview:${event.runId}`,
      };
    case 'tool.proposed':
      return {
        ...base,
        summary: `Tool proposed: ${event.payload.name}`,
        detail: { name: event.payload.name },
      };
    case 'tool.approval_requested':
      return { ...base, summary: event.payload.summary };
    case 'tool.progress':
      return { ...base, summary: event.payload.summary };
    case 'tool.succeeded':
    case 'tool.failed':
    case 'tool.cancelled':
    case 'tool.outcome_unknown':
      return { ...base, summary: event.payload.summary };
    case 'artifact.created':
      return {
        ...base,
        summary: event.payload.summary,
        detail: {
          handle: event.payload.handle,
          mediaType: event.payload.mediaType,
          byteSize: event.payload.byteSize,
          availability: event.payload.availability,
        },
        artifactRefs: [event.payload.handle],
      };
    case 'artifact.expired':
      return { ...base, summary: 'Artifact expired.' };
    case 'artifact.deleted':
      return { ...base, summary: 'Artifact deleted.' };
    case 'run.completed':
      return {
        ...base,
        summary: finalText ?? 'Run completed.',
        evidenceRefs: [...event.payload.evidenceRefs],
      };
    case 'run.input_requested':
      return { ...base, summary: `Input required: ${event.payload.reason}` };
    case 'run.limit_reached':
      return { ...base, summary: `Run limit reached: ${event.payload.limit}` };
    case 'run.failed':
    case 'run.interrupted':
      return { ...base, summary: event.payload.code };
    case 'run.cancelled':
      return { ...base, summary: event.payload.reason ?? 'Run cancelled.' };
    case 'run.started':
      return { ...base, summary: 'Run started.' };
    case 'run.resumed':
      return { ...base, summary: 'Run resumed.' };
    default:
      return { ...base, summary: descriptor.kind };
  }
}

function legacyActivityDescriptor(
  entityType: Extract<AgentEvent, { type: 'legacy.imported' }>['payload']['entityType'],
): ActivityDescriptor | undefined {
  switch (entityType) {
    case 'message': return { kind: 'result', phase: 'succeeded' };
    case 'run': return { kind: 'final', phase: 'succeeded' };
    case 'session':
    case 'preference':
    case 'checkpoint':
    case 'subagent':
    case 'diagnostic':
    case 'archive':
      return undefined;
    default:
      return projectionAssertNever(entityType);
  }
}

function projectionAssertNever(value: never): never {
  throw new ProjectionError('SCHEMA_INVALID', `Unhandled projection discriminant: ${String(value)}.`);
}

function sameScope(scope: Scope | undefined, event: AgentEvent): scope is Scope {
  return scope !== undefined &&
    scope.projectId === event.projectId &&
    scope.sessionId === event.sessionId &&
    scope.runId === event.runId;
}

function scopeOf(event: AgentEvent): Scope {
  return {
    projectId: event.projectId,
    sessionId: event.sessionId,
    runId: event.runId,
    sequence: event.sequence,
  };
}

function invocationIdFromPayload(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const invocationId = 'invocationId' in payload ? payload.invocationId : undefined;
  return typeof invocationId === 'string' ? invocationId : undefined;
}

function committedText(event: Extract<AgentEvent, { type: 'model_attempt_committed' }>): string {
  return event.payload.validatedAttempt.blocks
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

function sessionMessage(
  event: AgentEvent,
  role: 'user' | 'assistant',
  content: string,
): SessionProjectionMessage {
  return {
    sourceSequence: event.sequence,
    role,
    content,
    createdAt: event.occurredAt,
    runId: event.runId,
  };
}

function legacySessionMessage(
  event: Extract<AgentEvent, { type: 'legacy.imported' }>,
): SessionProjectionMessage {
  if (event.payload.entityType !== 'message') {
    throw new ProjectionError('SCHEMA_INVALID', 'Expected a legacy message fact.');
  }
  return {
    ...structuredClone(event.payload.record),
    sourceSequence: event.sequence,
    runId: event.payload.sourceRunId,
  };
}

function legacyRunRecordState(status: AgentRunRecordStatus): string {
  switch (status) {
    case 'done': return 'Completed';
    case 'aborted': return 'Cancelled';
    case 'failed': return 'Failed';
    case 'running':
    case 'interrupted': return 'Interrupted';
    case 'max_iterations_reached': return 'Failed';
  }
}

function toAuditEvent(event: AgentEvent): AuditProjectionEvent {
  return {
    sourceSequence: event.sequence,
    eventId: event.eventId,
    projectId: event.projectId,
    sessionId: event.sessionId,
    runId: event.runId,
    type: event.type,
    occurredAt: event.occurredAt,
    payload: portableProjectionPayload(event.payload),
    ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
    ...(event.attemptId === undefined ? {} : { attemptId: event.attemptId }),
    ...(event.invocationId === undefined ? {} : { invocationId: event.invocationId }),
    ...(event.parentEventId === undefined ? {} : { parentEventId: event.parentEventId }),
  };
}

function portableProjectionPayload(value: unknown): PortableValue {
  assertPortableValue(value);
  return value;
}

function wouldOverflowSessionPage(
  event: AgentEvent,
  messages: readonly SessionProjectionMessage[],
  artifacts: ReadonlyMap<string, SessionProjectionArtifact>,
  runs: ReadonlyMap<string, SessionProjectionRun>,
  run: RunScope | undefined,
  limit: number,
): boolean {
  if (event.type === 'input.received' && publicInputText(event.payload.content) !== undefined) {
    return messages.length >= limit;
  }
  if (event.type === 'model_attempt_committed' && committedText(event).length > 0) {
    return messages.length >= limit;
  }
  if (event.type === 'legacy.imported' && event.payload.entityType === 'message') {
    return messages.length >= limit;
  }
  if (event.type === 'artifact.created' && !artifacts.has(event.payload.artifactId)) {
    return artifacts.size >= limit;
  }
  const state = projectedRunState(event.type);
  return state !== undefined && !runs.has(event.runId) &&
    run?.clientRequestId !== undefined && runs.size >= limit;
}

function isTerminalRunEvent(type: AgentEventType): boolean {
  return type === 'run.completed' || type === 'run.failed' || type === 'run.cancelled';
}

function previewText(blocks: PortableValue[]): string {
  return blocks
    .flatMap((block) => {
      if (block === null || typeof block !== 'object' || Array.isArray(block)) return [];
      const record = block as Record<string, PortableValue>;
      return record.type === 'text' && typeof record.text === 'string' ? [record.text] : [];
    })
    .join('');
}

function publicInputText(content: PortableValue): string | undefined {
  if (typeof content === 'string') return content;
  const record = content as Record<string, PortableValue>;
  if (
    content !== null &&
    typeof content === 'object' &&
    !Array.isArray(content) &&
    typeof record.text === 'string'
  ) {
    return record.text;
  }
  return undefined;
}

function projectedRunState(type: AgentEventType): string | undefined {
  const states: Partial<Record<AgentEventType, string>> = {
    'run.started': 'Preparing',
    'run.resumed': 'Preparing',
    'run.input_requested': 'AwaitingUser',
    'run.cancel_requested': 'Cancelling',
    'run.limit_reached': 'LimitReached',
    'run.completed': 'Completed',
    'run.failed': 'Failed',
    'run.cancelled': 'Cancelled',
    'run.interrupted': 'Interrupted',
  };
  return states[type];
}
