export type SkillSource = 'builtin' | 'imported' | 'organization';

export type SkillDefinition = {
  name: string;
  title?: string;
  description: string;
  version?: string;
  author?: string;
  tags: string[];
  systemAddition?: string;
  allowedTools: string[];
  recommendedTools?: string[];
  defaults: Record<string, string | number | boolean>;
  steps: string[];
  stopConditions?: string[];
  executionLimits?: {
    maxIterations?: number;
    maxSqlAttempts?: number;
  };
  outputFormat: 'markdown' | 'json' | 'text';
  naturalLanguageKeywords: string[];
  autoInjectWhen: string[];
  source: SkillSource;
  sourcePath?: string;
  bundleRoot?: string;
};

export type SkillLoadResult = {
  skills: SkillDefinition[];
  errors: Array<{ path: string; message: string }>;
};

export type SkillExecutionPlan = {
  skill: SkillDefinition;
  userInput: string;
  systemAddition?: string;
  allowedTools: string[];
  steps: string[];
  outputFormat: SkillDefinition['outputFormat'];
};

export type SkillAutoInjectSignal = string;

export type SkillMatchReason = {
  type: 'keyword' | 'auto_inject_signal' | 'name' | 'title' | 'description';
  value: string;
  score: number;
};

export type SkillMatchCandidate = {
  skill: SkillDefinition;
  score: number;
  reasons: SkillMatchReason[];
  matchedSignals: SkillAutoInjectSignal[];
  availableTools: string[];
  missingTools: string[];
  eligible: boolean;
};

export type SkillMatchOptions = {
  userInput: string;
  availableTools?: string[];
  signals?: SkillAutoInjectSignal[];
  inferSignals?: boolean;
  includeIneligible?: boolean;
  maxResults?: number;
  minScore?: number;
};

export type SkillAutoExecutionPlan = {
  candidate: SkillMatchCandidate;
  plan: SkillExecutionPlan;
};
