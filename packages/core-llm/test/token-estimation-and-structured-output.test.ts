/* eslint-disable @typescript-eslint/no-unsafe-argument -- Vitest asymmetric matchers are intentionally untyped. */
import { describe, expect, it } from 'vitest';
import {
  StructuredOutputValidator,
  estimateLegacyMessagesTokens,
  estimateTextTokens,
} from '../src/index.js';

describe('token estimation and structured output', () => {
  it('uses a deterministic multilingual fallback estimate', () => {
    expect(estimateTextTokens('数据库')).toBeGreaterThan(estimateTextTokens('db'));
    expect(estimateTextTokens('')).toBe(0);
    expect(estimateTextTokens('select 1')).toBeGreaterThan(0);
  });

  it('accounts for typed assistant tool calls in normalized messages', () => {
    const plain = estimateLegacyMessagesTokens([{ role: 'assistant', content: '' }]);
    const withToolCall = estimateLegacyMessagesTokens([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{
          id: 'call-1',
          name: 'query_database',
          arguments: { sql: 'select * from orders where created_at >= current_date' },
        }],
      },
    ]);

    expect(withToolCall).toBeGreaterThan(plain);
  });

  it('accepts fenced valid JSON and rejects invalid output and tool arguments', () => {
    const validator = new StructuredOutputValidator();
    const schema = {
      type: 'object',
      properties: { sql: { type: 'string', minLength: 1 } },
      required: ['sql'],
      additionalProperties: false,
    };
    expect(validator.parseAndValidate<{ sql: string }>('```json\n{"sql":"select 1"}\n```', schema)).toEqual({
      value: { sql: 'select 1' },
      repaired: true,
    });
    expect(() => validator.parseAndValidate('{"sql":1}', schema)).toThrowError(
      expect.objectContaining({ code: 'LLM_STRUCTURED_OUTPUT_INVALID' }),
    );
    expect(() => validator.validateToolCalls(
      [{ id: '1', name: 'query', arguments: { limit: 'ten' } }],
      [{
        name: 'query',
        description: 'query',
        inputSchema: {
          type: 'object',
          properties: { limit: { type: 'integer' } },
          required: ['limit'],
        },
      }],
    )).toThrowError(expect.objectContaining({ code: 'LLM_STRUCTURED_OUTPUT_INVALID' }));
  });
});
