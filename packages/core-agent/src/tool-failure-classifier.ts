import type { AgentToolFailureKind } from './types.js';

export type AgentToolFailureClassification = {
  failureKind: AgentToolFailureKind;
  retryable: boolean;
};

export function classifyAgentToolFailure(message: string): AgentToolFailureClassification {
  const text = message.toLocaleLowerCase();

  if (
    includesAny(text, [
      'permission denied',
      'not allowed',
      'requires explicit confirmation',
      'blocked by connection policy',
    ])
  ) {
    return { failureKind: 'permission', retryable: false };
  }

  if (includesAny(text, ['timed out', 'timeout', '执行超时', '超时'])) {
    return { failureKind: 'timeout', retryable: true };
  }

  if (
    includesAny(text, ['tool is not registered', 'not registered', 'unavailable', 'not active'])
  ) {
    return { failureKind: 'tool_unavailable', retryable: false };
  }

  if (
    includesAny(text, [
      'column',
      'does not exist',
      'syntax error',
      'relation',
      'undefined_column',
      'undefined table',
      'sql is empty',
      'single-statement',
      '不存在',
      '未定义的列',
      '未定义的表',
      '关系不存在',
      '语法错误',
      '字段不存在',
    ])
  ) {
    return { failureKind: 'sql_repairable', retryable: true };
  }

  if (
    includesAny(text, [
      'connection terminated',
      'connection reset',
      'network',
      'econnreset',
      'etimedout',
      'deadlock',
      'could not serialize',
      'temporarily unavailable',
    ])
  ) {
    return { failureKind: 'transient_dependency', retryable: true };
  }

  if (includesAny(text, ['invalid', 'malformed', 'required', 'must be'])) {
    return { failureKind: 'validation', retryable: false };
  }

  return { failureKind: 'unknown', retryable: false };
}

/**
 * Classifies a failure with the tool contract as an additional signal.
 *
 * Database error text is not stable across drivers, server locales, or hosted
 * gateways. A failed SQL execution/explain call is therefore repairable even
 * when its localized message does not match one of the text patterns above.
 */
export function classifyAgentToolExecutionFailure(
  toolName: string,
  message: string,
): AgentToolFailureClassification {
  const classification = classifyAgentToolFailure(message);
  if (
    classification.failureKind === 'unknown' &&
    (toolName === 'sql_execute' || toolName === 'sql_explain')
  ) {
    return { failureKind: 'sql_repairable', retryable: true };
  }

  return classification;
}

function includesAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}
