import type { SkillDefinition } from './types.js';

export function createDefaultBuiltinSkills(): SkillDefinition[] {
  return DEFAULT_BUILTIN_SKILLS.map(cloneSkill);
}

export function registerDefaultBuiltinSkills(registry: {
  register(skill: SkillDefinition): void;
}): void {
  for (const skill of createDefaultBuiltinSkills()) registry.register(skill);
}

const DEFAULT_BUILTIN_SKILLS: SkillDefinition[] = [
  skill({
    name: 'nl2sql_query',
    title: '自然语言查询',
    description: '根据 Schema、业务口径和用户问题生成安全的只读 SQL，并返回可解释结果。',
    allowedTools: ['search_schema', 'build_schema_context', 'audit_sql', 'query_database'],
    steps: ['检索相关 Schema 与业务口径', '生成并审计只读 SQL', '执行查询', '说明口径、假设与结果'],
    keywords: ['自然语言转 SQL', '帮我查询', '数据查询', 'text to sql'],
    signals: ['requires_nl2sql'],
  }),
  skill({
    name: 'schema_context_enrichment',
    title: 'Schema 与业务知识补全',
    description: '检查表、字段、关系和业务术语，识别 NL2SQL 所需的上下文缺口。',
    allowedTools: ['list_schemas', 'list_tables', 'describe_table', 'search_schema', 'build_schema_context'],
    steps: ['定位相关对象', '核对字段与关系', '列出业务口径缺口', '形成可复用上下文建议'],
    keywords: ['Schema 补全', '数据字典', '业务口径', '表结构'],
    signals: ['requires_schema_context'],
  }),
  skill({
    name: 'explain_sql',
    title: 'SQL 执行计划分析',
    description: '审计只读 SQL 并分析 PostgreSQL EXPLAIN 计划，给出可验证的优化建议。',
    allowedTools: ['audit_sql', 'search_schema', 'explain_query'],
    steps: ['审计 SQL', '获取执行计划', '识别扫描、连接与估算风险', '给出验证步骤'],
    keywords: ['SQL 优化', '执行计划', 'EXPLAIN', '查询很慢'],
    signals: ['requires_sql_explain'],
  }),
  skill({
    name: 'database_health_check',
    title: '数据库健康检查',
    description: '汇总 PostgreSQL 连接、事务、缓存和活动会话指标并解释异常。',
    allowedTools: ['database_health_snapshot'],
    steps: ['采集健康快照', '识别异常指标', '区分事实与推断', '给出低风险处置建议'],
    keywords: ['数据库健康检查', '数据库健康', 'health check'],
    signals: ['requires_health_check'],
  }),
  skill({
    name: 'slow_query_diagnosis',
    title: '慢查询诊断',
    description: '基于 pg_stat_statements 与执行上下文定位高耗时 SQL，并给出验证建议。',
    allowedTools: ['diagnose_slow_queries', 'explain_query'],
    steps: ['筛选高耗时查询', '分析调用次数与平均耗时', '检查执行计划', '给出优化与回归验证建议'],
    keywords: ['慢查询', 'slow query', 'pg_stat_statements'],
    signals: ['requires_slow_query_diagnosis'],
  }),
  skill({
    name: 'lock_diagnosis',
    title: '锁等待诊断',
    description: '识别 PostgreSQL 锁等待、阻塞链和相关会话，不自动终止连接。',
    allowedTools: ['diagnose_locks'],
    steps: ['采集锁与会话', '构建阻塞关系', '标记影响范围', '给出需审批的处置选项'],
    keywords: ['锁等待', '阻塞链', '死锁', 'blocked query'],
    signals: ['requires_lock_diagnosis'],
  }),
  skill({
    name: 'long_transaction_diagnosis',
    title: '长事务诊断',
    description: '识别运行时间过长或 idle in transaction 的会话并评估影响。',
    allowedTools: ['diagnose_long_transactions'],
    steps: ['采集长事务', '核对状态与持续时间', '评估锁和膨胀风险', '给出需审批的处置选项'],
    keywords: ['长事务', 'long transaction', 'idle in transaction'],
    signals: ['requires_long_transaction_diagnosis'],
  }),
];

function skill(input: {
  name: string;
  title: string;
  description: string;
  allowedTools: string[];
  steps: string[];
  keywords: string[];
  signals: string[];
}): SkillDefinition {
  return {
    name: input.name,
    title: input.title,
    description: input.description,
    version: '1.0.0',
    author: 'DBAgent',
    tags: ['database'],
    systemAddition: '只陈述工具结果能够支持的事实；涉及写操作、终止会话或配置变更时必须请求显式审批。',
    allowedTools: input.allowedTools,
    defaults: {},
    steps: input.steps,
    outputFormat: 'markdown',
    naturalLanguageKeywords: input.keywords,
    autoInjectWhen: input.signals,
    source: 'builtin',
  };
}

function cloneSkill(skillDefinition: SkillDefinition): SkillDefinition {
  return {
    ...skillDefinition,
    tags: [...skillDefinition.tags],
    allowedTools: [...skillDefinition.allowedTools],
    defaults: { ...skillDefinition.defaults },
    steps: [...skillDefinition.steps],
    naturalLanguageKeywords: [...skillDefinition.naturalLanguageKeywords],
    autoInjectWhen: [...skillDefinition.autoInjectWhen],
  };
}
