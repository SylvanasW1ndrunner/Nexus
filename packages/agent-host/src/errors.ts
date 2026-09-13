import { LlmProviderError } from '@dbagent/core-llm';

export type AgentRuntimeErrorCode =
  | 'INVALID_INPUT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'COMMAND_CONFLICT'
  | 'APPROVAL_DECISION_CONFLICT'
  | 'OUTCOME_RESOLUTION_CONFLICT'
  | 'RISKY_RETRY_AUTHORIZATION_CONFLICT'
  | 'RUN_NOT_FOUND'
  | 'RUN_STATE_INVALID'
  | 'NOT_CONFIGURED'
  | 'LLM_REQUEST_FAILED'
  | 'LLM_RESPONSE_INVALID'
  | 'RUNTIME_DRIVER_FAILED'
  | 'ABORTED'
  | 'INTERNAL_ERROR';

export class AgentRuntimeError<Code extends string = AgentRuntimeErrorCode> extends Error {
  constructor(
    readonly code: Code,
    message: string,
    readonly retryable = false,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'AgentRuntimeError';
  }
}

/**
 * Normalizes failures at the Agent delivery boundary without assigning them
 * to any particular Capability.
 */
export function asAgentRuntimeError(error: unknown): AgentRuntimeError {
  if (error instanceof AgentRuntimeError) {
    return new AgentRuntimeError(error.code as AgentRuntimeErrorCode, error.message, error.retryable, error.detail);
  }
  if (error instanceof LlmProviderError) {
    if (error.code === 'LLM_ABORTED') {
      return new AgentRuntimeError('ABORTED', '任务已取消。', false);
    }
    if (error.code === 'LLM_STRUCTURED_OUTPUT_INVALID' || error.code === 'LLM_BAD_RESPONSE') {
      return new AgentRuntimeError('LLM_RESPONSE_INVALID', error.message, error.retryable);
    }
    return new AgentRuntimeError('LLM_REQUEST_FAILED', error.message, error.retryable);
  }
  if (isAbortLike(error)) {
    return new AgentRuntimeError('ABORTED', '任务已取消。', false);
  }
  return new AgentRuntimeError(
    'INTERNAL_ERROR',
    error instanceof Error ? error.message : '发生未知错误。',
    false,
  );
}

function isAbortLike(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError') return true;
  return 'code' in error && (error as { code?: unknown }).code === 'LLM_ABORTED';
}
