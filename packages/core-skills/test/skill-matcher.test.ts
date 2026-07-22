import { describe, expect, it } from 'vitest';
import { createDefaultBuiltinSkills, findMatchingSkills } from '../src/index.js';

describe('Skill matching', () => {
  it('matches database operation intent and enforces tool availability', () => {
    const candidates = findMatchingSkills(createDefaultBuiltinSkills(), {
      userInput: '帮我看一下现在有没有锁等待和阻塞链',
      availableTools: ['diagnose_locks'],
    });

    expect(candidates[0]?.skill.name).toBe('lock_diagnosis');
    expect(candidates[0]?.eligible).toBe(true);
  });

  it('reports a matched but unavailable Skill for diagnostics', () => {
    const candidates = findMatchingSkills(createDefaultBuiltinSkills(), {
      userInput: '检查一下慢查询',
      availableTools: ['query_database'],
      includeIneligible: true,
    });

    expect(candidates[0]).toMatchObject({
      skill: { name: 'slow_query_diagnosis' },
      eligible: false,
      missingTools: ['diagnose_slow_queries', 'explain_query'],
    });
  });
});
