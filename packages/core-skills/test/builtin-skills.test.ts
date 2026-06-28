import { describe, expect, it } from 'vitest';
import { createDefaultBuiltinSkills, registerDefaultBuiltinSkills, SkillRegistry } from '../src/index.js';

describe('default builtin Skills', () => {
  it('loads the official builtin Skill set with stable names and sources', () => {
    const skills = createDefaultBuiltinSkills();

    expect(skills.map((skill) => skill.name)).toEqual([
      'generate_schema_doc',
      'optimize_sql',
      'daily_gmv_report',
      'data_analysis',
      'generate_er_diagram',
    ]);
    expect(skills.every((skill) => skill.source === 'builtin')).toBe(true);
    expect(skills.every((skill) => skill.description.trim().length > 0)).toBe(true);
    expect(skills.every((skill) => skill.steps.length > 0)).toBe(true);
  });

  it('protects builtin definitions from caller mutation', () => {
    const first = createDefaultBuiltinSkills();
    first[0]?.allowedTools.push('mutated_tool');
    first[0]!.defaults.extra = 'mutated';

    const second = createDefaultBuiltinSkills();

    expect(second[0]?.allowedTools).not.toContain('mutated_tool');
    expect(second[0]?.defaults).not.toHaveProperty('extra');
  });

  it('registers builtins into a registry and matches realistic user tasks', () => {
    const registry = new SkillRegistry();
    registerDefaultBuiltinSkills(registry);

    expect(registry.list().map((skill) => skill.name)).toEqual([
      'daily_gmv_report',
      'data_analysis',
      'generate_er_diagram',
      'generate_schema_doc',
      'optimize_sql',
    ]);

    expect(
      registry.createAutoExecutionPlan({
        userInput: '请生成昨日 GMV 日报',
        availableTools: ['search_schema', 'query_database', 'write_workspace_file'],
      })?.candidate.skill.name,
    ).toBe('daily_gmv_report');
    expect(
      registry.createAutoExecutionPlan({
        userInput: '这个 SQL 为什么慢，请看 EXPLAIN 并优化查询',
        availableTools: ['audit_sql', 'search_schema', 'build_schema_context', 'query_database'],
      })?.candidate.skill.name,
    ).toBe('optimize_sql');
    expect(
      registry.createAutoExecutionPlan({
        userInput: '用 Python 建模预测下周 GMV，并画趋势图',
        availableTools: [
          'search_schema',
          'query_database',
          'write_workspace_file',
          'workspace_script:run_python_analysis',
        ],
      })?.candidate.skill.name,
    ).toBe('data_analysis');
  });
});
