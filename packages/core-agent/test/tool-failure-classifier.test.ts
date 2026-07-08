import { describe, expect, it } from 'vitest';
import { classifyAgentToolFailure } from '../src/index.js';

describe('classifyAgentToolFailure', () => {
  it.each([
    ['column missing_column does not exist', 'sql_repairable', true],
    ['工具 query_database 执行超时（5000ms）。', 'timeout', true],
    ['connection reset by peer', 'transient_dependency', true],
    ['Permission denied.', 'permission', false],
    ['Tool is not registered.', 'tool_unavailable', false],
    ['Invalid connectionId must be a string.', 'validation', false],
  ] as const)('classifies %s', (message, failureKind, retryable) => {
    expect(classifyAgentToolFailure(message)).toEqual({ failureKind, retryable });
  });
});
