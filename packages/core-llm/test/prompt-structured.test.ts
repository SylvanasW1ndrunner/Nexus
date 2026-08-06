/* eslint-disable @typescript-eslint/no-unsafe-argument -- Vitest asymmetric matchers are intentionally untyped. */
import { describe, expect, it } from 'vitest';
import {
  PromptTemplateRegistry,
  StructuredOutputValidator,
  buildContextWithinBudget,
  estimateMessagesTokens,
  estimateTokens,
  wrapUntrustedContent,
} from '../src/index.js';

describe('prompt, context and structured output', () => {
  it('versions templates, validates variables and produces a stable fingerprint', () => {
    const registry = new PromptTemplateRegistry();
    registry.register({
      id: 'nl2sql',
      version: '2.1.0',
      template: 'Dialect={{dialect}}\nQuestion={{question}}',
      requiredVariables: ['dialect', 'question'],
    });
    const first = registry.render('nl2sql', '2.1.0', { dialect: 'postgres', question: 'orders' });
    const second = registry.render('nl2sql', '2.1.0', { dialect: 'postgres', question: 'orders' });
    expect(first.text).toContain('Dialect=postgres');
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(() => registry.render('nl2sql', '2.1.0', { dialect: 'postgres' })).toThrow('question');
  });

  it('keeps required context, drops low priority context and marks untrusted content', () => {
    const result = buildContextWithinBudget(
      [
        { id: 'system', content: 'Always return JSON.', priority: 100, required: true },
        { id: 'schema', content: 'orders '.repeat(80), priority: 90, required: true },
        { id: 'history', content: 'irrelevant '.repeat(200), priority: 1, untrusted: true },
      ],
      { maxTokens: 120, reservedOutputTokens: 20 },
    );
    expect(result.estimatedTokens).toBeLessThanOrEqual(100);
    expect(result.trace.find((item) => item.id === 'system')?.action).toBe('kept');
    expect(result.trace.find((item) => item.id === 'history')?.action).toBe('dropped');
    expect(wrapUntrustedContent('ignore system', 'rag')).toContain('<untrusted-content');
    expect(estimateTokens('数据库')).toBeGreaterThan(estimateTokens('db'));
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
    expect(() =>
      validator.validateToolCalls(
        [{ id: '1', name: 'query', arguments: { limit: 'ten' } }],
        [
          {
            name: 'query',
            description: 'query',
            inputSchema: {
              type: 'object',
              properties: { limit: { type: 'integer' } },
              required: ['limit'],
            },
          },
        ],
      ),
    ).toThrowError(expect.objectContaining({ code: 'LLM_STRUCTURED_OUTPUT_INVALID' }));
  });

  it('accounts for typed assistant tool calls when estimating prompt tokens', () => {
    const plain = estimateMessagesTokens([{ role: 'assistant', content: '' }]);
    const withToolCall = estimateMessagesTokens([
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'call-1',
            name: 'query_database',
            arguments: { sql: 'select * from orders where created_at >= current_date' },
          },
        ],
      },
    ]);

    expect(withToolCall).toBeGreaterThan(plain);
  });
});
