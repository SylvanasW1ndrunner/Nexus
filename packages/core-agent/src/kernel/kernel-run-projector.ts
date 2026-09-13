import { createHash } from 'node:crypto';
import type { AgentEvent } from '../events/agent-event.js';
import type { ToolScheduleDecision } from '../tools/tool-scheduler.js';
import type { KernelRunProjection } from './run-controller.js';

export type CreateKernelRunProjectionInput = Readonly<{
  projectId: string;
  sessionId: string;
  runId: string;
  environmentBindingId: string | null;
  createdAt: string;
}>;

export function createKernelRunProjection(
  input: CreateKernelRunProjectionInput,
): KernelRunProjection {
  return Object.freeze({
    schemaVersion: 1,
    projectId: input.projectId,
    sessionId: input.sessionId,
    runId: input.runId,
    state: 'created',
    revision: 1,
    environmentBindingId: input.environmentBindingId,
    currentTurnId: null,
    turnSnapshotId: null,
    currentAttemptId: null,
    waitReason: null,
    evidenceRevision: 0,
    evidenceDigest: null,
    noProgressCount: 0,
    finalContentRef: null,
    deliveryStatus: null,
    updatedAt: input.createdAt,
  });
}

/** One pure reducer shared by online commits and Journal replay. */
export function projectKernelRunEvent(
  current: KernelRunProjection,
  event: AgentEvent,
): KernelRunProjection {
  if (
    event.projectId !== current.projectId || event.sessionId !== current.sessionId ||
    event.runId !== current.runId
  ) {
    throw new TypeError('Kernel event identity does not match its Run projection.');
  }
  let next: KernelRunProjection;
  switch (event.type) {
    case 'run.environment_bound':
      next = { ...current, environmentBindingId: event.payload.environmentBindingId };
      break;
    case 'run.started':
      next = current.environmentBindingId === null
        ? increment(current, event, { state: 'Preparing', waitReason: null })
        : { ...current, state: 'Preparing', waitReason: null, updatedAt: event.occurredAt };
      break;
    case 'run.resumed':
      next = increment(current, event, {
        state: event.payload.resumeState,
        waitReason: null,
        ...(event.payload.clearTurn === true
          ? { currentTurnId: null, turnSnapshotId: null, currentAttemptId: null }
          : {}),
      });
      break;
    case 'run.steered':
      next = increment(current, event, {
        state: 'Preparing', waitReason: null, currentTurnId: null,
        turnSnapshotId: null, currentAttemptId: null,
      });
      break;
    case 'turn.started':
      next = increment(current, event, {
        state: 'Preparing', currentTurnId: event.turnId ?? null,
        turnSnapshotId: event.payload.turnSnapshotId ?? null,
        currentAttemptId: null, waitReason: null,
      });
      break;
    case 'turn.context_compiled':
      next = increment(current, event, { state: 'CallingModel', waitReason: null });
      break;
    case 'model_attempt_started':
      next = increment(current, event, {
        state: 'ReceivingModel', currentAttemptId: event.attemptId ?? null,
      });
      break;
    case 'model_attempt_discarded':
      next = increment(current, event, {
        state: current.state === 'Cancelling' ? 'Cancelling' : 'CallingModel',
        currentAttemptId: null,
      });
      break;
    case 'model_attempt_committed':
      next = increment(current, event, {
        state: event.payload.validatedAttempt.blocks.some(
          (block) => block.type === 'tool-call-draft',
        ) ? 'ResolvingActions' : 'Finalizing',
        currentAttemptId: null, waitReason: null,
      });
      break;
    case 'run.input_requested':
      next = increment(current, event, {
        state: 'AwaitingUser', waitReason: event.payload.reason,
      });
      break;
    case 'run.cancel_requested':
      next = increment(current, event, { state: 'Cancelling', waitReason: null });
      break;
    case 'run.limit_reached':
      next = increment(current, event, { state: 'LimitReached', waitReason: null });
      break;
    case 'run.interrupted':
      next = increment(current, event, { state: 'Interrupted', waitReason: null });
      break;
    case 'turn.no_progress':
      next = increment(current, event, {
        state: 'Preparing', noProgressCount: current.noProgressCount + 1,
      });
      break;
    case 'context.compaction_requested':
      next = increment(current, event, {});
      break;
    case 'runtime.command_applied':
      next = increment(current, event, {});
      break;
    case 'context.compaction_started':
      next = increment(current, event, { state: 'Compacting' });
      break;
    case 'context.compacted':
      next = increment(current, event, { state: 'Preparing' });
      break;
    case 'context.compaction_failed':
      next = increment(current, event, { state: 'Interrupted', waitReason: null });
      break;
    case 'tool.observed':
    case 'tool.outcome_resolved':
      next = {
        ...current,
        evidenceRevision: current.evidenceRevision + 1,
        evidenceDigest: evidenceDigest(current.evidenceDigest, event),
        updatedAt: event.occurredAt,
      };
      break;
    case 'tool.waiting_for_user':
    case 'tool.timed_out':
    case 'tool.unsupported_revision':
    case 'tool.permission_evaluated':
    case 'tool.prepared':
    case 'tool.approval_requested':
    case 'tool.authorized':
    case 'tool.denied':
    case 'tool.started':
    case 'tool.progress':
    case 'tool.hook_rejected':
    case 'tool.hook_warning':
    case 'tool.succeeded':
    case 'tool.failed':
    case 'tool.cancelled':
    case 'tool.unknown':
    case 'tool.outcome_resolution_requested':
    case 'tool.retry_authorized':
      next = { ...current, updatedAt: event.occurredAt };
      break;
    case 'tool.transition_committed': {
      const protectedState = isProtectedToolState(current, event.payload.action);
      const state = event.payload.schedule.state === 'TurnReadyToClose'
        ? 'ApplyingObservations'
        : event.payload.schedule.state;
      next = increment(current, event, protectedState
        ? {}
        : {
            state,
            waitReason: event.payload.schedule.state === 'AwaitingUser'
              ? event.payload.schedule.reason
              : null,
          });
      break;
    }
    case 'delivery.decided':
      next = {
        ...current,
        state: event.payload.outcome === 'revision-requested' ? 'Preparing' : current.state,
        evidenceRevision: event.payload.evidenceRevision,
        deliveryStatus: event.payload.status,
        updatedAt: event.occurredAt,
      };
      break;
    case 'turn.closed':
      next = event.payload.reason === 'revision-requested' || event.payload.reason === 'observed'
        ? increment(current, event, {
            state: 'Preparing', currentTurnId: null, turnSnapshotId: null,
            currentAttemptId: null, waitReason: null,
          })
        : current;
      break;
    case 'run.completed':
      next = increment(current, event, {
        state: 'Completed', currentAttemptId: null, waitReason: null,
        finalContentRef: event.payload.finalContentRef,
        deliveryStatus: event.payload.deliveryStatus,
      });
      break;
    case 'run.failed':
      next = increment(current, event, {
        state: 'Failed', currentAttemptId: null, waitReason: null,
      });
      break;
    case 'run.cancelled':
      next = increment(current, event, {
        state: 'Cancelled', currentAttemptId: null, waitReason: null,
      });
      break;
    default:
      next = current;
      break;
  }
  return Object.freeze(next);
}

export function projectKernelSchedule(
  current: KernelRunProjection,
  decision: ToolScheduleDecision,
  occurredAt: string,
): KernelRunProjection {
  const state = decision.state === 'TurnReadyToClose' ? 'ApplyingObservations' : decision.state;
  return Object.freeze({
    ...current,
    state,
    waitReason: decision.state === 'AwaitingUser' ? decision.reason : null,
    updatedAt: occurredAt,
  });
}

function isProtectedToolState(
  current: KernelRunProjection,
  action: Extract<AgentEvent, { type: 'tool.transition_committed' }>['payload']['action'],
): boolean {
  if (current.state === 'AwaitingUser') {
    return action !== 'decide-approval' && action !== 'resolve-outcome' && action !== 'settle-question';
  }
  return current.state === 'Finalizing' || current.state === 'Cancelling' ||
    current.state === 'LimitReached' || current.state === 'Interrupted' ||
    current.state === 'Completed' || current.state === 'Failed' ||
    current.state === 'Cancelled';
}

function increment(
  current: KernelRunProjection,
  event: AgentEvent,
  patch: Partial<KernelRunProjection>,
): KernelRunProjection {
  return {
    ...current,
    ...patch,
    revision: current.revision + 1,
    updatedAt: event.occurredAt,
  };
}

function evidenceDigest(previousDigest: string | null, event: AgentEvent): string {
  return createHash('sha256').update(canonicalJson({
    previousDigest,
    eventType: event.type,
    invocationId: event.invocationId ?? null,
    payload: event.payload,
  })).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new TypeError('Kernel evidence contains a non-JSON value.');
    }
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
  ).join(',')}}`;
}
