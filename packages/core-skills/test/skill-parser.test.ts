import { describe, expect, it } from 'vitest';
import { parseSkillDefinition, parseStructuredSkill } from '../src/index.js';

describe('parseSkillDefinition', () => {
  it('parses product-style YAML skill definitions', () => {
    const skill = parseSkillDefinition(
      [
        'name: daily_gmv_report',
        'title: 每日 GMV 报表',
        'description: 输出昨日 GMV 及环比、同比',
        'system_addition: |',
        '  你是数据分析报表助手。',
        '  输出必须包含口径说明。',
        'allowed_tools:',
        '  - query_database',
        '  - describe_table',
        '  - workspace_script:plot_gmv_trend',
        'steps:',
        '  - SELECT 昨日 GMV',
        '  - 生成 markdown 报表',
        'natural_language_keywords: [生成日报, GMV 报表]',
        'auto_inject_when:',
        '  - requires_visualization',
        'output_format: markdown',
      ].join('\n'),
      'builtin',
      'daily-gmv.yaml',
    );

    expect(skill).toMatchObject({
      name: 'daily_gmv_report',
      title: '每日 GMV 报表',
      description: '输出昨日 GMV 及环比、同比',
      systemAddition: '你是数据分析报表助手。\n输出必须包含口径说明。',
      allowedTools: ['query_database', 'describe_table', 'workspace_script:plot_gmv_trend'],
      steps: ['SELECT 昨日 GMV', '生成 markdown 报表'],
      naturalLanguageKeywords: ['生成日报', 'GMV 报表'],
      autoInjectWhen: ['requires_visualization'],
      outputFormat: 'markdown',
      source: 'builtin',
      sourcePath: 'daily-gmv.yaml',
    });
  });

  it('parses JSON skill definitions for generated save_session_as_skill output', () => {
    const skill = parseSkillDefinition(
      JSON.stringify({
        name: 'cohort_report',
        description: '生成留存 cohort 报告',
        allowed_tools: ['query_database'],
        defaults: { days: 30, includeChart: true },
        steps: ['查询 cohort', '写报告'],
        output_format: 'json',
      }),
      'workspace',
    );

    expect(skill.defaults).toEqual({ days: 30, includeChart: true });
    expect(skill.outputFormat).toBe('json');
  });

  it('rejects missing required fields and unsupported output formats', () => {
    expect(() => parseSkillDefinition('description: missing name', 'user')).toThrow('name');
    expect(() =>
      parseSkillDefinition('name: bad\n description: bad\noutput_format: html', 'user'),
    ).toThrow();
  });
});

describe('parseStructuredSkill', () => {
  it('keeps comments out of scalar values and lists', () => {
    expect(
      parseStructuredSkill(
        [
          'name: demo # comment',
          'description: "带 # 的说明"',
          'allowed_tools:',
          '  - query_database # comment',
        ].join('\n'),
      ),
    ).toEqual({
      name: 'demo',
      description: '带 # 的说明',
      allowed_tools: ['query_database'],
    });
  });
});
