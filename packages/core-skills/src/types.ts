export type SkillSource = 'builtin' | 'user' | 'workspace';

export type SkillDefinition = {
  name: string;
  title?: string;
  description: string;
  systemAddition?: string;
  allowedTools: string[];
  defaults: Record<string, string | number | boolean>;
  steps: string[];
  outputFormat: 'markdown' | 'json' | 'text';
  naturalLanguageKeywords: string[];
  autoInjectWhen: string[];
  source: SkillSource;
  sourcePath?: string;
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
