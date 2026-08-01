import { describe, expect, it } from 'vitest';
import { classifyAgentToolExecutionFailure, classifyAgentToolFailure } from '../src/index.js';

describe('classifyAgentToolFailure', () => {
  it.each([
    ['column missing_column does not exist', 'sql_repairable', true],
    ['工具 query_database 执行超时（5000ms）。', 'timeout', true],
    ['connection reset by peer', 'transient_dependency', true],
    ['Permission denied.', 'permission', false],
    ['Tool is not registered.', 'tool_unavailable', false],
    ['Invalid connectionId must be a string.', 'validation', false],
  ] as const)('classifies %s', (message: string, failureKind: string, retryable: boolean) => {
    expect(classifyAgentToolFailure(message)).toEqual({ failureKind, retryable });
  });
});

describe('classifyAgentToolExecutionFailure', () => {
  it('uses the SQL tool contract when a driver returns an opaque localized error', () => {
    expect(
      classifyAgentToolExecutionFailure('sql_execute', '数据库请求失败（代码 42703）'),
    ).toEqual({
      failureKind: 'sql_repairable',
      retryable: true,
    });
  });

  it('does not make unrelated opaque tool failures retryable', () => {
    expect(classifyAgentToolExecutionFailure('file_read', 'unexpected failure')).toEqual({
      failureKind: 'unknown',
      retryable: false,
    });
  });
});
