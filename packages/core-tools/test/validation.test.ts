import { describe, expect, it } from 'vitest';
import { ToolExecutionError } from '@dbagent/core-agent';
import { optionalPositiveInteger, optionalString, requireString } from '../src/validation.js';

describe('Tool argument validation', () => {
  it.each([
    ['requireString', 'The "query" argument is invalid.', () => requireString({ query: '' }, 'query')],
    ['optionalString', 'The "query" argument is invalid.', () => optionalString({ query: 42 }, 'query')],
    ['optionalPositiveInteger', 'The "limit" argument is invalid.', () => optionalPositiveInteger({ limit: 0 }, 'limit')],
  ])('returns a typed actionable invalid-input error for %s', (_name, expectedSummary, validate) => {
    try {
      validate();
      throw new Error('Expected validation to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(ToolExecutionError);
      expect(error).toMatchObject({
        fact: {
          code: 'TOOL_INPUT_INVALID',
          category: 'validation',
          retryable: false,
          outcome: 'not_applied',
        },
      });
      expect((error as Error).message).toBe(expectedSummary);
    }
  });
});
