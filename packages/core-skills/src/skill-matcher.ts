import type {
  SkillAutoExecutionPlan,
  SkillAutoInjectSignal,
  SkillDefinition,
  SkillExecutionPlan,
  SkillMatchCandidate,
  SkillMatchOptions,
  SkillMatchReason,
} from './types.js';

const DEFAULT_MIN_SCORE = 1;
const KEYWORD_SCORE = 10;
const SIGNAL_SCORE = 8;
const NAME_SCORE = 6;
const TITLE_SCORE = 6;
const DESCRIPTION_SCORE = 4;

export function findMatchingSkills(skills: SkillDefinition[], options: SkillMatchOptions): SkillMatchCandidate[] {
  const userInput = normalizeText(options.userInput);
  if (!userInput) return [];

  const availableTools = new Set(options.availableTools ?? []);
  const signals = new Set([
    ...(options.signals ?? []).map(normalizeSignal),
    ...((options.inferSignals ?? true) ? inferSkillSignals(options.userInput).map(normalizeSignal) : []),
  ]);
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;

  return skills
    .map((skill) => matchSkill(skill, userInput, availableTools, signals))
    .filter((candidate) => candidate.score >= minScore)
    .filter((candidate) => options.includeIneligible === true || candidate.eligible)
    .sort(compareCandidates)
    .slice(0, options.maxResults ?? Number.POSITIVE_INFINITY);
}

export function createAutoExecutionPlan(
  skills: SkillDefinition[],
  options: SkillMatchOptions,
): SkillAutoExecutionPlan | undefined {
  const [candidate] = findMatchingSkills(skills, { ...options, maxResults: 1 });
  if (!candidate) return undefined;
  return {
    candidate,
    plan: createPlanFromCandidate(candidate, options.userInput),
  };
}

export function inferSkillSignals(userInput: string): SkillAutoInjectSignal[] {
  const text = normalizeText(userInput);
  const signals = new Set<SkillAutoInjectSignal>();

  if (containsAny(text, ['可视化', '图表', '画图', '趋势图', '折线图', '柱状图', 'plot', 'chart', 'visualize'])) {
    signals.add('requires_visualization');
  }
  if (containsAny(text, ['python', '脚本', 'notebook', 'pandas', 'numpy', '机器学习', '建模', '预测', '聚类', '训练'])) {
    signals.add('requires_python');
  }
  if (containsAny(text, ['机器学习', '建模', '预测', '聚类', '分类', '回归', '训练', 'model', 'forecast'])) {
    signals.add('requires_modeling');
  }
  if (containsAny(text, ['流水线', '多步骤', 'etl', 'pipeline', '清洗', '特征工程', '自动化报告'])) {
    signals.add('requires_multi_step_pipeline');
  }
  if (containsAny(text, ['schema 文档', '表结构文档', '数据字典', '字段说明', 'schema documentation'])) {
    signals.add('requires_schema_documentation');
  }
  if (containsAny(text, ['sql 优化', 'explain', '慢查询', '为什么慢', '优化查询', 'query plan'])) {
    signals.add('requires_sql_optimization');
  }

  return [...signals];
}

function matchSkill(
  skill: SkillDefinition,
  userInput: string,
  availableTools: Set<string>,
  signals: Set<string>,
): SkillMatchCandidate {
  const reasons: SkillMatchReason[] = [];
  for (const keyword of skill.naturalLanguageKeywords) {
    const normalized = normalizeText(keyword);
    if (normalized && userInput.includes(normalized)) {
      reasons.push({ type: 'keyword', value: keyword, score: KEYWORD_SCORE });
    }
  }

  for (const signal of skill.autoInjectWhen) {
    const normalized = normalizeSignal(signal);
    if (signals.has(normalized)) {
      reasons.push({ type: 'auto_inject_signal', value: signal, score: SIGNAL_SCORE });
    }
  }

  if (userInput.includes(normalizeText(skill.name))) {
    reasons.push({ type: 'name', value: skill.name, score: NAME_SCORE });
  }
  if (skill.title && userInput.includes(normalizeText(skill.title))) {
    reasons.push({ type: 'title', value: skill.title, score: TITLE_SCORE });
  }
  if (skill.description && containsMeaningfulToken(userInput, skill.description)) {
    reasons.push({ type: 'description', value: skill.description, score: DESCRIPTION_SCORE });
  }

  const available = skill.allowedTools.filter((tool) => availableTools.size === 0 || availableTools.has(tool));
  const missing = availableTools.size === 0 ? [] : skill.allowedTools.filter((tool) => !availableTools.has(tool));

  return {
    skill,
    score: reasons.reduce((total, reason) => total + reason.score, 0),
    reasons,
    matchedSignals: skill.autoInjectWhen.filter((signal) => signals.has(normalizeSignal(signal))),
    availableTools: available,
    missingTools: missing,
    eligible: missing.length === 0,
  };
}

function createPlanFromCandidate(candidate: SkillMatchCandidate, userInput: string): SkillExecutionPlan {
  return {
    skill: candidate.skill,
    userInput: renderDefaults(userInput, candidate.skill.defaults),
    ...(candidate.skill.systemAddition ? { systemAddition: candidate.skill.systemAddition } : {}),
    allowedTools: candidate.availableTools,
    steps: candidate.skill.steps,
    outputFormat: candidate.skill.outputFormat,
  };
}

function compareCandidates(left: SkillMatchCandidate, right: SkillMatchCandidate): number {
  if (left.eligible !== right.eligible) return left.eligible ? -1 : 1;
  if (right.score !== left.score) return right.score - left.score;
  if (right.availableTools.length !== left.availableTools.length) {
    return right.availableTools.length - left.availableTools.length;
  }
  return left.skill.name.localeCompare(right.skill.name);
}

function containsMeaningfulToken(userInput: string, value: string): boolean {
  return normalizeText(value)
    .split(/\s+/)
    .filter((token) => token.length >= 3)
    .some((token) => userInput.includes(token));
}

function containsAny(text: string, candidates: string[]): boolean {
  return candidates.some((candidate) => text.includes(normalizeText(candidate)));
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeSignal(signal: string): string {
  return signal.trim().toLowerCase();
}

function renderDefaults(input: string, defaults: Record<string, string | number | boolean>): string {
  return input.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key: string) =>
    defaults[key] === undefined ? match : String(defaults[key]),
  );
}
