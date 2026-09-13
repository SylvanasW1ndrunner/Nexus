import type { ToolExecutionErrorFact } from '../events/agent-event.js';

const MAX_TOOL_EXECUTION_SUMMARY_CHARS = 4_096;

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
  constructor(readonly fact: ToolExecutionErrorFact, summary?: string) {
    super(fact.code, normalizeToolErrorSummary(summary, fact.code), fact);
    this.name = 'ToolExecutionError';
  }
}

export type ExpectedToolErrorKind =
  | 'invalid_argument'
  | 'invalid_cursor'
  | 'not_found'
  | 'conflict'
  | 'precondition'
  | 'external'
  | 'limit';

/**
 * Maps an explicitly recognized, user-actionable boundary failure into the
 * persisted Tool contract. Unexpected exceptions retain their bounded
 * diagnostic so callers can report the underlying external failure.
 */
export function expectedToolError(
  kind: ExpectedToolErrorKind,
  summary: string,
  options: { retryable?: boolean; outcome?: ToolExecutionErrorFact['outcome'] } = {},
): ToolExecutionError {
  const outcome = options.outcome ?? 'not_applied';
  const retryable = options.retryable ?? false;
  switch (kind) {
    case 'invalid_argument':
      return new ToolExecutionError({ code: 'TOOL_INPUT_INVALID', category: 'validation', retryable: false, outcome }, summary);
    case 'invalid_cursor':
      return new ToolExecutionError({ code: 'invalid_cursor', category: 'validation', retryable: false, outcome }, summary);
    case 'not_found':
      return new ToolExecutionError({ code: 'TOOL_RESOURCE_NOT_FOUND', category: 'unavailable', retryable: false, outcome }, summary);
    case 'conflict':
      return new ToolExecutionError({ code: 'TOOL_CONFLICT', category: 'conflict', retryable: false, outcome }, summary);
    case 'precondition':
      return new ToolExecutionError({ code: 'TOOL_PRECONDITION_FAILED', category: 'precondition', retryable, outcome }, summary);
    case 'external':
      return new ToolExecutionError({ code: 'TOOL_EXTERNAL_FAILED', category: 'external', retryable, outcome }, summary);
    case 'limit':
      return new ToolExecutionError({ code: 'TOOL_LIMIT_EXCEEDED', category: 'limit', retryable: false, outcome }, summary);
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
  }, errorMessage(input.error));
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
    case 'invalid_cursor':
      return 'The tool arguments do not match its schema.';
    case 'TOOL_RESOURCE_NOT_FOUND':
      return 'The requested resource is unavailable.';
    case 'target_changed':
      return 'The prepared target changed before execution.';
    case 'conflict':
    case 'TOOL_CONFLICT':
      return 'The requested operation conflicts with current state.';
    case 'TOOL_PRECONDITION_FAILED':
      return 'The tool requires a prerequisite that is not satisfied.';
    case 'TOOL_EXTERNAL_FAILED':
      return 'An external dependency could not complete the request.';
    case 'TOOL_LIMIT_EXCEEDED':
      return 'The request exceeds a supported limit.';
    case 'TOOL_PERMISSION_DENIED':
      return 'The tool was denied by an external permission boundary.';
    case 'OUTCOME_RESOLVED_FAILED':
      return 'The interrupted tool was resolved as failed.';
  }
}

function normalizeToolErrorSummary(
  value: string | undefined,
  code: ToolExecutionErrorFact['code'],
): string {
  const fallback = safeToolErrorSummary(code);
  const normalized = value === undefined
    ? fallback
    : value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim();
  if (normalized.length === 0) return fallback;
  if (normalized.length <= MAX_TOOL_EXECUTION_SUMMARY_CHARS) return normalized;
  const marker = '… [truncated]';
  let end = MAX_TOOL_EXECUTION_SUMMARY_CHARS - marker.length;
  if (end > 0 && isHighSurrogate(normalized.charCodeAt(end - 1))) end -= 1;
  return `${normalized.slice(0, end).trimEnd()}${marker}`;
}

function errorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : undefined;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
