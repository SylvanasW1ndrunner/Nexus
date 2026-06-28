import type { SkillDefinition } from './types.js';

export function createDefaultBuiltinSkills(): SkillDefinition[] {
  return DEFAULT_BUILTIN_SKILLS.map(cloneSkill);
}

export function registerDefaultBuiltinSkills(registry: { register(skill: SkillDefinition): void }): void {
  for (const skill of createDefaultBuiltinSkills()) {
    registry.register(skill);
  }
}

const DEFAULT_BUILTIN_SKILLS: SkillDefinition[] = [
  {
    name: 'generate_schema_doc',
    title: '生成 Schema 文档',
    description: '根据当前数据库 schema 生成表、字段、关系和业务口径说明。',
    systemAddition: '优先检索 schema，输出结构化 Markdown 文档，明确未知口径和需要用户确认的字段。',
    allowedTools: ['search_schema', 'build_schema_context', 'list_tables', 'describe_table', 'write_workspace_file'],
    defaults: {},
    steps: ['检索相关 schema', '整理表和字段说明', '补充关系和风险提示', '写入工作区文档'],
    outputFormat: 'markdown',
    naturalLanguageKeywords: ['schema 文档', '表结构文档', '数据字典', '字段说明', '数据库文档'],
    autoInjectWhen: ['requires_schema_documentation'],
    source: 'builtin',
  },
  {
    name: 'optimize_sql',
    title: 'SQL 优化建议',
    description: '分析 SQL 的执行风险、性能问题和可改写方向。',
    systemAddition: '必须先做 SQL 预审或 Explain，再给出可验证的优化建议；不要直接执行写入 SQL。',
    allowedTools: ['audit_sql', 'search_schema', 'build_schema_context', 'query_database'],
    defaults: {},
    steps: ['识别 SQL 操作类型', '检索相关 schema', '检查执行风险和性能提示', '给出优化建议和验证方式'],
    outputFormat: 'markdown',
    naturalLanguageKeywords: ['SQL 优化', '慢查询', '为什么慢', '优化查询', 'EXPLAIN', 'query plan'],
    autoInjectWhen: ['requires_sql_optimization'],
    source: 'builtin',
  },
  {
    name: 'daily_gmv_report',
    title: '每日 GMV 日报',
    description: '查询订单指标，生成每日 GMV、同比环比、异常解释和后续分析建议。',
    systemAddition: '所有指标必须说明口径；如果 schema 无法确认退款、取消或币种字段，需要显式标记不确定性。',
    allowedTools: ['search_schema', 'query_database', 'write_workspace_file'],
    defaults: { date: 'yesterday' },
    steps: ['检索订单、支付、退款相关 schema', '查询 GMV 和对比指标', '解释异常变化', '写入工作区日报'],
    outputFormat: 'markdown',
    naturalLanguageKeywords: ['昨日 GMV', 'GMV 日报', '每日 GMV', '销售日报', '经营日报'],
    autoInjectWhen: [],
    source: 'builtin',
  },
  {
    name: 'data_analysis',
    title: 'Python 数据分析',
    description: '使用 SQL 和 Python 完成建模、预测、可视化或多步骤数据分析。',
    systemAddition: '优先用 SQL 获取必要样本，再把可复现分析逻辑写入工作区脚本；输出时说明数据口径、假设和误差来源。',
    allowedTools: ['search_schema', 'query_database', 'write_workspace_file', 'workspace_script:run_python_analysis'],
    defaults: {},
    steps: ['检索相关 schema', '查询分析所需数据', '生成或运行 Python 分析脚本', '解释结果并保存制品'],
    outputFormat: 'markdown',
    naturalLanguageKeywords: ['Python 数据分析', '建模预测', '趋势图', '训练模型', '机器学习分析'],
    autoInjectWhen: ['requires_visualization', 'requires_python', 'requires_modeling', 'requires_multi_step_pipeline'],
    source: 'builtin',
  },
  {
    name: 'generate_er_diagram',
    title: '生成 ER 图说明',
    description: '根据 schema 和外键关系生成 ER 图所需的结构化说明和 Mermaid 草图。',
    systemAddition: '如果缺少外键，应基于字段名只提出可能关系，不要把推测关系当作事实。',
    allowedTools: ['search_schema', 'build_schema_context', 'list_tables', 'describe_table', 'write_workspace_file'],
    defaults: {},
    steps: ['检索核心业务表', '整理主键和外键关系', '生成 Mermaid ER 草图', '写入工作区文档'],
    outputFormat: 'markdown',
    naturalLanguageKeywords: ['ER 图', '实体关系图', '表关系图', '数据库关系图', 'Mermaid ER'],
    autoInjectWhen: ['requires_schema_documentation'],
    source: 'builtin',
  },
];

function cloneSkill(skill: SkillDefinition): SkillDefinition {
  return {
    ...skill,
    allowedTools: [...skill.allowedTools],
    defaults: { ...skill.defaults },
    steps: [...skill.steps],
    naturalLanguageKeywords: [...skill.naturalLanguageKeywords],
    autoInjectWhen: [...skill.autoInjectWhen],
  };
}
