import { LlmProviderError } from '@dbagent/core-llm';

export type DatabaseCapabilityErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_CONFIGURED'
  | 'LLM_REQUEST_FAILED'
  | 'LLM_RESPONSE_INVALID'
  | 'ABORTED'
  | 'INTERNAL_ERROR'
  | 'CONNECTION_FAILED'
  | 'SCHEMA_NOT_INDEXED'
  | 'SQL_BLOCKED'
  | 'RUN_NOT_FOUND'
  | 'RUN_NOT_EXECUTABLE'
  | 'QUERY_FAILED';

/** A Capability-local failure: generic Agent errors do not leak into this package. */
export class DatabaseCapabilityError extends Error {
  constructor(
    readonly code: DatabaseCapabilityErrorCode,
    message: string,
    readonly retryable = false,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'DatabaseCapabilityError';
  }
}

export function asDatabaseCapabilityError(error: unknown): DatabaseCapabilityError {
  if (error instanceof DatabaseCapabilityError) return error;
  if (error instanceof LlmProviderError) {
    if (error.code === 'LLM_ABORTED') {
      return new DatabaseCapabilityError('ABORTED', '任务已取消。');
    }
    if (error.code === 'LLM_STRUCTURED_OUTPUT_INVALID' || error.code === 'LLM_BAD_RESPONSE') {
      return new DatabaseCapabilityError('LLM_RESPONSE_INVALID', error.message, error.retryable);
    }
    return new DatabaseCapabilityError('LLM_REQUEST_FAILED', error.message, error.retryable);
  }
  if (error instanceof Error && (error.name === 'AbortError' ||
    ('code' in error && (error as { code?: unknown }).code === 'LLM_ABORTED'))) {
    return new DatabaseCapabilityError('ABORTED', '任务已取消。');
  }
  return new DatabaseCapabilityError(
    'INTERNAL_ERROR', error instanceof Error ? error.message : '发生未知错误。',
  );
}
