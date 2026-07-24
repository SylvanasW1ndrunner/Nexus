import { describe, expect, it } from 'vitest';
import {
  createDefaultBuiltinSkills,
  registerDefaultBuiltinSkills,
  SkillRegistry,
} from '../src/index.js';

const allTools = [
  'resource_list',
  'resource_get',
  'knowledge_search',
  'sql_execute',
  'sql_explain',
  'result_read',
];

describe('default AI SQL Skills', () => {
  it('contains only four generic workflows that guide the built-in tool chain', () => {
    const skills = createDefaultBuiltinSkills();
    expect(skills.map((skill) => skill.name)).toEqual([
      'query-and-answer',
      'discover-schema-and-shape',
      'write-and-verify',
      'recover-from-sql-error',
    ]);
    expect(
      skills.every(
        (skill) =>
          skill.steps.length >= 4 &&
          (skill.stopConditions?.length ?? 0) >= 3 &&
          (skill.executionLimits?.maxIterations ?? 0) > 0,
      ),
    ).toBe(true);
  });

  it('registers and matches a write workflow without embedding business policy', () => {
    const registry = new SkillRegistry();
    registerDefaultBuiltinSkills(registry);

    const plan = registry.createAutoExecutionPlan({
      userInput: '把订单 42 的状态修改为 paid，然后验证结果',
      availableTools: allTools,
    });
    expect(plan?.candidate.skill.name).toBe('write-and-verify');
    expect(plan?.candidate.eligible).toBe(true);
    expect(plan?.candidate.skill.source).toBe('builtin');
  });

  it('returns defensive copies', () => {
    const first = createDefaultBuiltinSkills();
    first[0]?.allowedTools.push('mutated');
    first[0]?.steps.push('mutated');
    expect(createDefaultBuiltinSkills()[0]?.allowedTools).not.toContain('mutated');
    expect(createDefaultBuiltinSkills()[0]?.steps).not.toContain('mutated');
  });
});
