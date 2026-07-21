import { describe, expect, it } from 'vitest';
import { DatabaseAgentError, parseGeneratedSqlResponse } from '../src/index.js';

describe('parseGeneratedSqlResponse', () => {
  it('parses the preferred JSON contract', () => {
    expect(
      parseGeneratedSqlResponse(
        JSON.stringify({
          sql: 'select city, sum(amount) from orders group by city',
          explanation: '按城市汇总订单金额',
          assumptions: ['amount 使用订单币种'],
        }),
      ),
    ).toEqual({
      sql: 'select city, sum(amount) from orders group by city',
      explanation: '按城市汇总订单金额',
      assumptions: ['amount 使用订单币种'],
    });
  });

  it('accepts JSON and SQL code fences from imperfect compatible models', () => {
    expect(
      parseGeneratedSqlResponse(
        '```json\n{"sql":"select 1","explanation":"探活","assumptions":[]}\n```',
      ).sql,
    ).toBe('select 1');

    expect(parseGeneratedSqlResponse('说明\n```sql\nselect 2\n```')).toEqual({
      sql: 'select 2',
      explanation: '说明',
      assumptions: [],
    });
  });

  it('rejects output without SQL', () => {
    let thrown: unknown;
    try {
      parseGeneratedSqlResponse('我不知道应该查询什么。');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DatabaseAgentError);
    expect(thrown).toMatchObject({ code: 'LLM_RESPONSE_INVALID' });
  });
});
