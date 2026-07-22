import type {
  SkillAutoExecutionPlan,
  SkillAutoInjectSignal,
  SkillDefinition,
  SkillExecutionPlan,
  SkillMatchCandidate,
  SkillMatchOptions,
  SkillMatchReason,
} from './types.js';

const SCORES = { keyword: 10, signal: 8, name: 6, title: 6, description: 4 } as const;

export function findMatchingSkills(
  skills: SkillDefinition[],
  options: SkillMatchOptions,
): SkillMatchCandidate[] {
  const userInput = normalizeText(options.userInput);
  if (!userInput) return [];
  const availableTools = new Set(options.availableTools ?? []);
  const signals = new Set([
    ...(options.signals ?? []).map(normalizeText),
    ...((options.inferSignals ?? true) ? inferSkillSignals(options.userInput) : []).map(normalizeText),
  ]);

  return skills
    .map((skill) => matchSkill(skill, userInput, availableTools, signals))
    .filter((candidate) => candidate.score >= (options.minScore ?? 1))
    .filter((candidate) => options.includeIneligible === true || candidate.eligible)
    .sort(compareCandidates)
    .slice(0, options.maxResults ?? Number.POSITIVE_INFINITY);
}

export function createAutoExecutionPlan(
  skills: SkillDefinition[],
  options: SkillMatchOptions,
): SkillAutoExecutionPlan | undefined {
  const candidate = findMatchingSkills(skills, { ...options, maxResults: 1 })[0];
  return candidate
    ? { candidate, plan: createPlanFromCandidate(candidate, options.userInput) }
    : undefined;
}

export function inferSkillSignals(userInput: string): SkillAutoInjectSignal[] {
  const text = normalizeText(userInput);
  const signals = new Set<string>();
  addSignal(signals, text, 'requires_nl2sql', ['sql', '查询', '查一下', '统计', '多少', 'natural language']);
  addSignal(signals, text, 'requires_schema_context', ['schema', '表结构', '字段', '业务口径', '数据字典']);
  addSignal(signals, text, 'requires_sql_explain', ['explain', '执行计划', 'sql 优化', '查询很慢']);
  addSignal(signals, text, 'requires_health_check', ['健康检查', '数据库健康', 'health check']);
  addSignal(signals, text, 'requires_slow_query_diagnosis', ['慢查询', 'slow query', 'pg_stat_statements']);
  addSignal(signals, text, 'requires_lock_diagnosis', ['锁等待', '死锁', '阻塞', 'blocked query', 'lock']);
  addSignal(signals, text, 'requires_long_transaction_diagnosis', ['长事务', 'long transaction', 'idle in transaction']);
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
    if (userInput.includes(normalizeText(keyword))) {
      reasons.push({ type: 'keyword', value: keyword, score: SCORES.keyword });
    }
  }
  for (const signal of skill.autoInjectWhen) {
    if (signals.has(normalizeText(signal))) {
      reasons.push({ type: 'auto_inject_signal', value: signal, score: SCORES.signal });
    }
  }
  if (userInput.includes(normalizeText(skill.name))) {
    reasons.push({ type: 'name', value: skill.name, score: SCORES.name });
  }
  if (skill.title && userInput.includes(normalizeText(skill.title))) {
    reasons.push({ type: 'title', value: skill.title, score: SCORES.title });
  }
  if (descriptionMatches(userInput, skill.description)) {
    reasons.push({ type: 'description', value: skill.description, score: SCORES.description });
  }

  const checkAvailability = availableTools.size > 0;
  const available = skill.allowedTools.filter((tool) => !checkAvailability || availableTools.has(tool));
  const missing = checkAvailability
    ? skill.allowedTools.filter((tool) => !availableTools.has(tool))
    : [];
  return {
    skill,
    score: reasons.reduce((sum, reason) => sum + reason.score, 0),
    reasons,
    matchedSignals: skill.autoInjectWhen.filter((signal) => signals.has(normalizeText(signal))),
    availableTools: available,
    missingTools: missing,
    eligible: missing.length === 0,
  };
}

function createPlanFromCandidate(
  candidate: SkillMatchCandidate,
  userInput: string,
): SkillExecutionPlan {
  return {
    skill: candidate.skill,
    userInput: renderDefaults(userInput, candidate.skill.defaults),
    ...(candidate.skill.systemAddition
      ? { systemAddition: candidate.skill.systemAddition }
      : {}),
    allowedTools: candidate.availableTools,
    steps: candidate.skill.steps,
    outputFormat: candidate.skill.outputFormat,
  };
}

function compareCandidates(left: SkillMatchCandidate, right: SkillMatchCandidate): number {
  if (left.eligible !== right.eligible) return left.eligible ? -1 : 1;
  if (right.score !== left.score) return right.score - left.score;
  return left.skill.name.localeCompare(right.skill.name);
}

function addSignal(
  signals: Set<string>,
  text: string,
  signal: string,
  keywords: string[],
): void {
  if (keywords.some((keyword) => text.includes(normalizeText(keyword)))) signals.add(signal);
}

function descriptionMatches(userInput: string, description: string): boolean {
  return normalizeText(description)
    .split(/\s+/)
    .filter((token) => token.length >= 3)
    .some((token) => userInput.includes(token));
}

function normalizeText(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

function renderDefaults(
  input: string,
  defaults: Record<string, string | number | boolean>,
): string {
  return input.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key: string) =>
    defaults[key] === undefined ? match : String(defaults[key]),
  );
}
