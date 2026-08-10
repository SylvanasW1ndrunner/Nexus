import type { ToolExecutionErrorFact } from '../events/agent-event.js';

export type ToolInvocationErrorCode =
  | ToolExecutionErrorFact['code']
  | 'TOOL_NOT_FOUND'
  | 'TOOL_REVISION_MISMATCH'
  | 'TOOL_INPUT_INVALID'
  | 'APPROVAL_BINDING_MISMATCH'
  | 'APPROVAL_DECISION_CONFLICT'
  | 'OUTCOME_RESOLUTION_CONFLICT'
  | 'INVOCATION_CONFLICT'
  | 'LEASE_LOST';

export class ToolInvocationError extends Error {
  constructor(
    readonly code: ToolInvocationErrorCode,
    message: string,
    readonly execution?: ToolExecutionErrorFact,
  ) {
    super(message);
    this.name = 'ToolInvocationError';
  }
}

export class ToolExecutionError extends ToolInvocationError {
  constructor(readonly fact: ToolExecutionErrorFact) {
    super(fact.code, safeToolErrorSummary(fact.code), fact);
    this.name = 'ToolExecutionError';
  }
}

export function adaptToolHandlerFailure(input: {
  error: unknown;
  timedOut: boolean;
  cancelled: boolean;
}): ToolExecutionError {
  if (input.error instanceof ToolExecutionError) return input.error;
  if (input.timedOut) {
    return new ToolExecutionError({
      code: 'TOOL_TIMEOUT', category: 'timeout', retryable: true, outcome: 'not_applied',
    });
  }
  if (input.cancelled) {
    return new ToolExecutionError({
      code: 'TOOL_CANCELLED', category: 'cancelled', retryable: false, outcome: 'not_applied',
    });
  }
  return new ToolExecutionError({
    code: 'HANDLER_FAILED', category: 'internal', retryable: false, outcome: 'unknown',
  });
}

export function invalidToolResultError(): ToolExecutionError {
  return new ToolExecutionError({
    code: 'INVALID_TOOL_RESULT', category: 'contract', retryable: false, outcome: 'unknown',
  });
}

export function safeToolErrorSummary(code: ToolExecutionErrorFact['code']): string {
  switch (code) {
    case 'TOOL_TIMEOUT':
      return 'The tool timed out.';
    case 'TOOL_CANCELLED':
      return 'The tool was cancelled.';
    case 'INVALID_TOOL_RESULT':
      return 'The tool returned an invalid result.';
    case 'HANDLER_FAILED':
      return 'The tool could not complete.';
    case 'TOOL_NOT_FOUND':
      return 'The tool is unavailable in this snapshot.';
    case 'TOOL_REVISION_MISMATCH':
      return 'The tool revision no longer matches this invocation.';
    case 'TOOL_INPUT_INVALID':
      return 'The tool arguments do not match its schema.';
    case 'OUTCOME_RESOLVED_FAILED':
      return 'The interrupted tool was resolved as failed.';
  }
}
