import { describe, expect, it } from 'vitest';
import {
  createDefaultBuiltinSkills,
  findMatchingSkills,
  inferSkillSignals,
} from '../src/index.js';

describe('AI SQL Skill matching', () => {
  it('matches schema/data-shape exploration and enforces tool availability', () => {
    const availableTools = [
      'resource_list',
      'resource_get',
      'knowledge_search',
      'sql_execute',
      'result_read',
    ];
    const candidates = findMatchingSkills(createDefaultBuiltinSkills(), {
      userInput: '先看看 Kafka 事件表的 JSON 字段长什么样，再提取省份',
      availableTools,
    });

    expect(candidates[0]?.skill.name).toBe('discover-schema-and-shape');
    expect(candidates[0]?.eligible).toBe(true);
    expect(candidates[0]?.availableTools).toEqual(availableTools);
  });

  it('reports a matched workflow and all unavailable tools for diagnostics', () => {
    const candidates = findMatchingSkills(createDefaultBuiltinSkills(), {
      userInput: '这个字段不存在的 SQL 错误怎么修复',
      availableTools: ['knowledge_search'],
      includeIneligible: true,
    });

    expect(candidates[0]).toMatchObject({
      skill: { name: 'recover-from-sql-error' },
      eligible: false,
      missingTools: [
        'resource_list',
        'resource_get',
        'sql_execute',
        'sql_explain',
      ],
    });
  });

  it('infers a default query workflow for ordinary requests and explicit recovery signals', () => {
    expect(inferSkillSignals('统计过去 30 天订单金额')).toContain(
      'requires_query_and_answer',
    );
    expect(inferSkillSignals('column does not exist')).toContain(
      'requires_sql_error_recovery',
    );
    expect(inferSkillSignals('帮我处理一下这个需求')).toEqual([
      'requires_query_and_answer',
    ]);
  });
});
