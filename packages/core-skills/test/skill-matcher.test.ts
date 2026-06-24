import { describe, expect, it } from 'vitest';
import {
  createAutoExecutionPlan,
  findMatchingSkills,
  inferSkillSignals,
  parseSkillDefinition,
  SkillRegistry,
} from '../src/index.js';

describe('Skill auto matching', () => {
  it('selects the best Skill by natural language keywords and preserves allowed tool order', () => {
    const skills = [dailyReportSkill(), schemaDocSkill(), dataAnalysisSkill()];

    const candidates = findMatchingSkills(skills, {
      userInput: '请生成昨日 GMV 日报，并给出同比和环比',
      availableTools: ['search_schema', 'query_database', 'write_workspace_file'],
    });

    expect(candidates.map((candidate) => candidate.skill.name)).toEqual(['daily_gmv_report']);
    expect(candidates[0]).toMatchObject({
      score: 20,
      eligible: true,
      availableTools: ['search_schema', 'query_database', 'write_workspace_file'],
      missingTools: [],
      reasons: [
        { type: 'keyword', value: '昨日 GMV' },
        { type: 'keyword', value: '日报' },
      ],
    });
  });

  it('auto-injects the Python data analysis Skill from inferred visualization and modeling signals', () => {
    const skills = [dailyReportSkill(), dataAnalysisSkill()];

    const plan = createAutoExecutionPlan(skills, {
      userInput: '用 Python 建模预测下周 GMV，并画趋势图',
      availableTools: ['search_schema', 'query_database', 'workspace_script:run_python_analysis'],
    });

    expect(plan?.candidate.skill.name).toBe('data_analysis');
    expect(plan?.candidate.matchedSignals).toEqual([
      'requires_visualization',
      'requires_python',
      'requires_modeling',
    ]);
    expect(plan?.plan).toMatchObject({
      userInput: '用 Python 建模预测下周 GMV，并画趋势图',
      allowedTools: ['search_schema', 'query_database', 'workspace_script:run_python_analysis'],
      outputFormat: 'markdown',
    });
  });

  it('keeps ineligible Skills out by default and can report missing tools for diagnostics', () => {
    const skills = [dataAnalysisSkill()];

    expect(
      findMatchingSkills(skills, {
        userInput: '用 Python 训练一个预测模型',
        availableTools: ['search_schema', 'query_database'],
      }),
    ).toEqual([]);

    const [candidate] = findMatchingSkills(skills, {
      userInput: '用 Python 训练一个预测模型',
      availableTools: ['search_schema', 'query_database'],
      includeIneligible: true,
    });

    expect(candidate).toMatchObject({
      skill: { name: 'data_analysis' },
      eligible: false,
      availableTools: ['search_schema', 'query_database'],
      missingTools: ['workspace_script:run_python_analysis'],
    });
  });

  it('exposes matching through SkillRegistry and applies defaults in auto execution plans', () => {
    const registry = new SkillRegistry();
    registry.register(dailyReportSkill());
    registry.register(dataAnalysisSkill());

    const autoPlan = registry.createAutoExecutionPlan({
      userInput: '生成 {date} 的 GMV 报表',
      availableTools: ['search_schema', 'query_database', 'write_workspace_file'],
    });

    expect(autoPlan?.candidate.skill.name).toBe('daily_gmv_report');
    expect(autoPlan?.plan.userInput).toBe('生成 yesterday 的 GMV 报表');
    expect(autoPlan?.plan.allowedTools).toEqual(['search_schema', 'query_database', 'write_workspace_file']);
  });

  it('infers stable product signals from user wording', () => {
    expect(inferSkillSignals('输出 schema 文档，并解释字段说明')).toEqual(['requires_schema_documentation']);
    expect(inferSkillSignals('这个 SQL 为什么慢，请看 EXPLAIN 优化查询')).toEqual(['requires_sql_optimization']);
    expect(inferSkillSignals('清洗数据并做 ETL pipeline')).toEqual(['requires_multi_step_pipeline']);
  });
});

function dailyReportSkill() {
  return parseSkillDefinition(
    JSON.stringify({
      name: 'daily_gmv_report',
      title: '每日 GMV 报表',
      description: '生成每日 GMV、同比、环比和口径说明。',
      system_addition: '以数据分析师口吻输出。',
      natural_language_keywords: ['昨日 GMV', '日报', 'GMV 报表'],
      allowed_tools: ['search_schema', 'query_database', 'write_workspace_file'],
      defaults: { date: 'yesterday' },
      steps: ['检索订单 schema', '查询 GMV', '写入报告'],
      output_format: 'markdown',
    }),
    'builtin',
  );
}

function schemaDocSkill() {
  return parseSkillDefinition(
    JSON.stringify({
      name: 'schema_doc',
      title: 'Schema 文档',
      description: '生成数据库 schema 文档和字段说明。',
      natural_language_keywords: ['schema 文档', '表结构文档', '数据字典'],
      auto_inject_when: ['requires_schema_documentation'],
      allowed_tools: ['search_schema', 'describe_table', 'write_workspace_file'],
      steps: ['检索 schema', '生成文档'],
      output_format: 'markdown',
    }),
    'builtin',
  );
}

function dataAnalysisSkill() {
  return parseSkillDefinition(
    JSON.stringify({
      name: 'data_analysis',
      title: 'Python 数据分析',
      description: '用 Python 脚本完成 SQL 之外的分析、建模和可视化任务。',
      natural_language_keywords: ['Python 数据分析', '建模预测', '可视化'],
      auto_inject_when: ['requires_visualization', 'requires_python', 'requires_modeling'],
      allowed_tools: ['search_schema', 'query_database', 'workspace_script:run_python_analysis'],
      steps: ['检索数据', '运行 Python 分析脚本', '解释结果'],
      output_format: 'markdown',
    }),
    'builtin',
  );
}
