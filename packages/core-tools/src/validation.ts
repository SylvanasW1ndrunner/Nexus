import { ToolExecutionError } from '@dbagent/core-agent';

export function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw invalidToolArgumentError(key);
  }
  return value;
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalidToolArgumentError(key);
  return value;
}

export function optionalPositiveInteger(
  args: Record<string, unknown>,
  key: string,
  fallback?: number,
): number | undefined {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw invalidToolArgumentError(key);
  }
  return value;
}

function invalidToolArgumentError(key: string): ToolExecutionError {
  return new ToolExecutionError({
    code: 'TOOL_INPUT_INVALID',
    category: 'validation',
    retryable: false,
    outcome: 'not_applied',
  }, `The "${key}" argument is invalid.`);
}
