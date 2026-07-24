import type { SkillDefinition } from './types.js';

export function createDefaultBuiltinSkills(): SkillDefinition[] {
  return DEFAULT_BUILTIN_SKILLS.map(cloneSkill);
}

export function registerDefaultBuiltinSkills(registry: {
  register(skill: SkillDefinition): void;
}): void {
  for (const skill of createDefaultBuiltinSkills()) registry.register(skill);
}

const ALL_AI_SQL_TOOLS = [
  'resource_list',
  'resource_get',
  'knowledge_search',
  'sql_execute',
  'sql_explain',
  'result_read',
];

const DEFAULT_BUILTIN_SKILLS: SkillDefinition[] = [
  skill({
    name: 'query-and-answer',
    title: '查询与回答',
    description:
      '完成自然语言查询、统计、比较、聚合和数据解释；按需检索知识、浏览资源、执行 SQL，并根据真实结果回答。',
    allowedTools: ALL_AI_SQL_TOOLS,
    steps: [
      '先判断已有上下文是否足够，不足时检索知识或浏览资源',
      '生成与任务粒度相符的 SQL',
      '执行 SQL；结果较大时通过结果句柄继续读取',
      '根据真实执行结果回答，并明确必要的口径或假设',
    ],
    stopConditions: [
      '用户问题已由真实结果回答',
      '缺少无法通过现有工具获得的业务定义',
      '数据库返回不可恢复错误或用户拒绝许可',
    ],
    keywords: ['查询', '统计', '多少', '对比', '趋势', '排名', '聚合', 'sql', 'query', 'count'],
    signals: ['requires_query_and_answer'],
    executionLimits: { maxIterations: 12, maxSqlAttempts: 3 },
  }),
  skill({
    name: 'discover-schema-and-shape',
    title: '发现结构与数据形态',
    description:
      '在结构、JSON、枚举、时间范围或数据粒度不明确时，查询数据库资源并执行有限查询确认事实。',
    allowedTools: [
      'resource_list',
      'resource_get',
      'knowledge_search',
      'sql_execute',
      'result_read',
    ],
    steps: [
      '通过知识检索或资源浏览定位候选对象',
      '读取候选资源的字段、关系和业务知识',
      '必要时只执行一次代表性小结果集查询，确认 JSON 结构、枚举、时间范围或数据粒度；避免重复计数或反复读取相同形态',
      '确认目标字段后立即执行完成用户目标的查询，不停留在探索性 SQL',
      '将确认后的事实用于当前任务，不自动写入长期知识库',
    ],
    stopConditions: [
      '完成当前任务所需的结构和数据形态已经确认',
      '候选对象全部排除',
      '继续探索需要超出当前权限',
    ],
    keywords: ['表结构', '字段', 'schema', 'json', '枚举', '数据长什么样', '数据粒度', '从哪里来'],
    signals: ['requires_schema_discovery'],
    executionLimits: { maxIterations: 14, maxSqlAttempts: 4 },
  }),
  skill({
    name: 'write-and-verify',
    title: '写入并验证',
    description:
      '完成 INSERT、UPDATE、DELETE、MERGE 或 DDL；权限系统独立判断是否需要一次性许可，执行后验证影响行数或重新读取结构。',
    allowedTools: ALL_AI_SQL_TOOLS,
    steps: [
      '定位目标资源并确认写入条件',
      '生成范围明确的 DML 或 DDL',
      '调用 SQL 执行工具，由权限系统处理许可',
      '检查影响行数、返回值或重新读取最新结构',
    ],
    stopConditions: [
      '写入成功且影响范围已验证',
      '用户拒绝许可',
      '数据库拒绝操作或验证结果与目标不一致',
    ],
    keywords: [
      '插入',
      '新增',
      '更新',
      '修改',
      '删除',
      '建表',
      '改表',
      'insert',
      'update',
      'delete',
      'merge',
      'create table',
      'alter table',
      'drop table',
    ],
    signals: ['requires_write_and_verify'],
    executionLimits: { maxIterations: 12, maxSqlAttempts: 3 },
  }),
  skill({
    name: 'recover-from-sql-error',
    title: '从 SQL 错误恢复',
    description:
      'SQL 执行失败后读取数据库错误和最新结构，修正字段、方言、类型或对象引用，并在有限次数内重试。',
    allowedTools: [
      'resource_list',
      'resource_get',
      'knowledge_search',
      'sql_execute',
      'sql_explain',
    ],
    steps: [
      '根据数据库错误定位可修复原因',
      '读取最新结构或知识，避免凭空猜测字段',
      '只修改与错误直接相关的 SQL 部分',
      '在重试上限内再次执行；重复失败时停止并说明原因',
    ],
    stopConditions: [
      '修正后的 SQL 成功执行',
      '相同原因连续失败',
      '达到重试上限',
      '修正需要更高权限且用户拒绝许可',
    ],
    keywords: [
      'sql 错误',
      '执行失败',
      '字段不存在',
      '语法错误',
      '类型不匹配',
      'column does not exist',
      'syntax error',
      'relation does not exist',
    ],
    signals: ['requires_sql_error_recovery'],
    executionLimits: { maxIterations: 8, maxSqlAttempts: 3 },
  }),
];

function skill(input: {
  name: string;
  title: string;
  description: string;
  allowedTools: string[];
  steps: string[];
  stopConditions: string[];
  keywords: string[];
  signals: string[];
  executionLimits: NonNullable<SkillDefinition['executionLimits']>;
}): SkillDefinition {
  return {
    name: input.name,
    title: input.title,
    description: input.description,
    version: '1.0.0',
    author: 'DBAgent',
    tags: ['database', 'ai-sql', 'builtin'],
    systemAddition:
      '主动使用工具获得完成任务所需的事实。权限判断由运行时负责；不要因为可能需要许可而回避正确的工具调用。只陈述工具结果支持的事实，不输出隐藏推理过程。',
    allowedTools: [...input.allowedTools],
    recommendedTools: [...input.allowedTools],
    defaults: {},
    steps: input.steps,
    stopConditions: input.stopConditions,
    executionLimits: input.executionLimits,
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
    ...(skillDefinition.recommendedTools === undefined
      ? {}
      : { recommendedTools: [...skillDefinition.recommendedTools] }),
    defaults: { ...skillDefinition.defaults },
    steps: [...skillDefinition.steps],
    ...(skillDefinition.stopConditions === undefined
      ? {}
      : { stopConditions: [...skillDefinition.stopConditions] }),
    ...(skillDefinition.executionLimits === undefined
      ? {}
      : { executionLimits: { ...skillDefinition.executionLimits } }),
    naturalLanguageKeywords: [...skillDefinition.naturalLanguageKeywords],
    autoInjectWhen: [...skillDefinition.autoInjectWhen],
  };
}
