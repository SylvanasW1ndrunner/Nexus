import { LlmProviderError } from '@dbagent/core-llm';

export type DatabaseAgentErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_CONFIGURED'
  | 'CONNECTION_FAILED'
  | 'SCHEMA_NOT_INDEXED'
  | 'LLM_REQUEST_FAILED'
  | 'LLM_RESPONSE_INVALID'
  | 'SQL_BLOCKED'
  | 'RUN_NOT_FOUND'
  | 'RUN_NOT_EXECUTABLE'
  | 'QUERY_FAILED'
  | 'ABORTED'
  | 'INTERNAL_ERROR';

export class DatabaseAgentError extends Error {
  constructor(
    readonly code: DatabaseAgentErrorCode,
    message: string,
    readonly retryable = false,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'DatabaseAgentError';
  }
}

export function asDatabaseAgentError(error: unknown): DatabaseAgentError {
  if (error instanceof DatabaseAgentError) return error;
  if (error instanceof LlmProviderError) {
    if (error.code === 'LLM_ABORTED') {
      return new DatabaseAgentError('ABORTED', '任务已取消。', false);
    }
    if (error.code === 'LLM_STRUCTURED_OUTPUT_INVALID' || error.code === 'LLM_BAD_RESPONSE') {
      return new DatabaseAgentError('LLM_RESPONSE_INVALID', error.message, error.retryable);
    }
    return new DatabaseAgentError('LLM_REQUEST_FAILED', error.message, error.retryable);
  }
  if (isAbortLike(error)) {
    return new DatabaseAgentError('ABORTED', '任务已取消。', false);
  }
  return new DatabaseAgentError(
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
