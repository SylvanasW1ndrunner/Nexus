import type { PortableValue } from '@dbagent/shared';
import type { AgentEvent, AgentEventType } from '../events/agent-event.js';
import { AGENT_EVENT_SCHEMA_REGISTRY } from '../events/event-schema-registry.js';

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

export type SessionProjectionMessage = {
  sourceSequence: number;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
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
};

export type SessionProjection = {
  schemaVersion: 1;
  projectId: string;
  sessionId: string;
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
    'run.created': { kind: 'status', phase: 'started' },
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
  const selected = validateProjectionInput(events, options);
  const messageCandidates: SessionProjectionMessage[] = [];
  const artifacts = new Map<string, SessionProjectionArtifact>();
  const runs = new Map<string, SessionProjectionRun>();
  let lastSourceSequence = options.afterSequence;

  for (const event of selected) {
    lastSourceSequence = event.sequence;
    if (event.type === 'input.received') {
      const content = publicInputText(event.payload.content);
      if (content !== undefined) {
        messageCandidates.push({
          sourceSequence: event.sequence,
          role: 'user',
          content,
          createdAt: event.occurredAt,
          runId: event.runId,
        });
      }
      continue;
    }
    if (event.type === 'run.created') {
      runs.set(event.runId, {
        runId: event.runId,
        clientRequestId: event.payload.clientRequestId,
        state: 'created',
        createdAt: event.occurredAt,
        updatedAt: event.occurredAt,
      });
      continue;
    }
    const runState = projectedRunState(event.type);
    if (runState !== undefined) {
      const run = runs.get(event.runId);
      if (run !== undefined) {
        run.state = runState;
        run.updatedAt = event.occurredAt;
      }
    }
    if (event.type === 'model_attempt_committed') {
      const text = event.payload.validatedAttempt.blocks
        .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
        .map(({ text: blockText }) => blockText)
        .join('');
      if (text.length > 0) {
        messageCandidates.push({
          sourceSequence: event.sequence,
          role: 'assistant',
          content: text,
          createdAt: event.occurredAt,
          runId: event.runId,
        });
      }
    }
    if (event.type === 'artifact.created') {
      artifacts.set(event.payload.artifactId, {
        sourceSequence: event.sequence,
        artifactId: event.payload.artifactId,
        handle: event.payload.handle,
        byteSize: event.payload.byteSize,
        mediaType: event.payload.mediaType,
        availability: event.payload.availability,
        summary: event.payload.summary,
        createdAt: event.occurredAt,
      });
    }
    if (event.type === 'artifact.expired' || event.type === 'artifact.deleted') {
      const artifact = artifacts.get(event.payload.artifactId);
      if (artifact !== undefined) {
        artifact.availability = event.type === 'artifact.expired' ? 'expired' : 'deleted';
        artifact.sourceSequence = event.sequence;
      }
    }
  }

  const messages = messageCandidates
    .filter(({ sourceSequence }) => sourceSequence > options.afterSequence)
    .slice(0, options.limit);
  const nextSourceSequence = messages.at(-1)?.sourceSequence ?? options.afterSequence;
  return {
    schemaVersion: 1,
    projectId: options.projectId,
    sessionId: options.sessionId,
    messages,
    artifacts: [...artifacts.values()].sort((a, b) => a.sourceSequence - b.sourceSequence),
    runs: [...runs.values()].sort(
      (left, right) => left.createdAt.localeCompare(right.createdAt) || left.runId.localeCompare(right.runId),
    ),
    lastSourceSequence,
    nextSourceSequence,
  };
}

export class UserActivityProjector {
  project(
    events: readonly AgentEvent[],
    options: ProjectionOptions,
  ): ProjectionPage<UserActivityEvent> {
    const selected = validateProjectionInput(events, options);
    const committedText = latestCommittedTextByRun(selected);
    const items = selected
      .filter(({ sequence }) => sequence > options.afterSequence)
      .flatMap((event) => {
        const descriptor = EVENT_TO_ACTIVITY[event.type as keyof typeof EVENT_TO_ACTIVITY];
        if (descriptor === undefined) return [];
        return [toUserActivity(event, descriptor, committedText.get(event.runId))];
      })
      .slice(0, options.limit);
    return {
      items,
      nextSourceSequence: items.at(-1)?.sourceSequence ?? options.afterSequence,
    };
  }
}

export class AuditProjector {
  project(
    events: readonly AgentEvent[],
    options: ProjectionOptions,
  ): ProjectionPage<AuditProjectionEvent> {
    const items = validateProjectionInput(events, options)
      .filter(({ sequence }) => sequence > options.afterSequence)
      .slice(0, options.limit)
      .map((event) => ({
        sourceSequence: event.sequence,
        eventId: event.eventId,
        projectId: event.projectId,
        sessionId: event.sessionId,
        runId: event.runId,
        type: event.type,
        occurredAt: event.occurredAt,
        payload: structuredClone(event.payload),
        ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
        ...(event.attemptId === undefined ? {} : { attemptId: event.attemptId }),
        ...(event.invocationId === undefined ? {} : { invocationId: event.invocationId }),
        ...(event.parentEventId === undefined ? {} : { parentEventId: event.parentEventId }),
      }));
    return {
      items,
      nextSourceSequence: items.at(-1)?.sourceSequence ?? options.afterSequence,
    };
  }
}

function validateProjectionInput(
  events: readonly AgentEvent[],
  options: ProjectionOptions,
): AgentEvent[] {
  requireProjectionOptions(options);
  const eventIds = new Map<string, AgentEvent>();
  const runs = new Map<string, { projectId: string; sessionId: string; inputSeen: boolean }>();
  let previousSequence = 0;
  for (const event of events) {
    if (event.projectId !== options.projectId) {
      throw new ProjectionError('PROJECT_MISMATCH', 'Projection input crossed Project boundary.');
    }
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= previousSequence) {
      throw new ProjectionError('SEQUENCE_INVALID', 'Source sequence must be strictly monotonic.');
    }
    previousSequence = event.sequence;
    if (event.schemaVersion !== AGENT_EVENT_SCHEMA_REGISTRY[event.type].schemaVersion) {
      throw new ProjectionError('SCHEMA_INVALID', 'Projection input was not upcast to current schema.');
    }
    if (eventIds.has(event.eventId)) {
      throw new ProjectionError('CAUSALITY_INVALID', 'Event identity is duplicated.');
    }
    if (event.parentEventId !== undefined) {
      const parent = eventIds.get(event.parentEventId);
      if (
        parent === undefined ||
        parent.projectId !== event.projectId ||
        parent.sessionId !== event.sessionId ||
        parent.runId !== event.runId ||
        parent.sequence >= event.sequence
      ) {
        throw new ProjectionError('CAUSALITY_INVALID', 'Event parent causality is invalid.');
      }
    }
    if (event.type === 'input.received') {
      const existing = runs.get(event.runId);
      if (existing !== undefined) {
        throw new ProjectionError('RUN_CAUSALITY_INVALID', 'Run input is duplicated.');
      }
      runs.set(event.runId, {
        projectId: event.projectId,
        sessionId: event.sessionId,
        inputSeen: true,
      });
    } else {
      const run = runs.get(event.runId);
      if (
        run === undefined ||
        run.projectId !== event.projectId ||
        run.sessionId !== event.sessionId ||
        !run.inputSeen
      ) {
        throw new ProjectionError('RUN_CAUSALITY_INVALID', 'Event Run causality is invalid.');
      }
    }
    eventIds.set(event.eventId, event);
  }
  return events.filter(({ sessionId }) => sessionId === options.sessionId);
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
          artifactId: event.payload.artifactId,
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
        artifactRefs: [...event.payload.evidenceRefs],
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
    case 'run.created':
      return { ...base, summary: 'Run created.' };
    case 'run.started':
      return { ...base, summary: 'Run started.' };
    case 'run.resumed':
      return { ...base, summary: 'Run resumed.' };
    default:
      return { ...base, summary: descriptor.kind };
  }
}

function latestCommittedTextByRun(events: readonly AgentEvent[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const event of events) {
    if (event.type !== 'model_attempt_committed') continue;
    const text = event.payload.validatedAttempt.blocks
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('');
    if (text.length > 0) result.set(event.runId, text);
  }
  return result;
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
