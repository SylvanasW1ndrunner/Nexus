import { describe, expect, it } from 'vitest';
import { DatabaseCapabilityError, parseGeneratedSqlResponse } from '../src/index.js';

describe('database Capability SQL response parsing', () => {
  it('parses the JSON contract and tolerant SQL fence fallback', () => {
    expect(parseGeneratedSqlResponse('{"sql":"select 1","explanation":"probe","assumptions":["read only"]}')).toEqual({ sql: 'select 1', explanation: 'probe', assumptions: ['read only'] });
    expect(parseGeneratedSqlResponse('说明\n```sql\nselect 2\n```')).toEqual({ sql: 'select 2', explanation: '说明', assumptions: [] });
  });
  it('returns a Capability-local diagnostic for unusable model text', () => {
    expect(() => parseGeneratedSqlResponse('没有查询。')).toThrow(DatabaseCapabilityError);
    try { parseGeneratedSqlResponse('没有查询。'); } catch (error) { expect(error).toMatchObject({ code: 'LLM_RESPONSE_INVALID' }); }
  });
});
