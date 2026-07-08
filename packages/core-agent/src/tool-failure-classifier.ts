import type { AgentToolFailureKind } from './types.js';

export type AgentToolFailureClassification = {
  failureKind: AgentToolFailureKind;
  retryable: boolean;
};

export function classifyAgentToolFailure(message: string): AgentToolFailureClassification {
  const text = message.toLocaleLowerCase();

  if (includesAny(text, ['permission denied', 'not allowed', 'requires explicit confirmation', 'blocked by connection policy'])) {
    return { failureKind: 'permission', retryable: false };
  }

  if (includesAny(text, ['timed out', 'timeout', '执行超时', '超时'])) {
    return { failureKind: 'timeout', retryable: true };
  }

  if (includesAny(text, ['tool is not registered', 'not registered', 'unavailable', 'not active'])) {
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

function includesAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}
