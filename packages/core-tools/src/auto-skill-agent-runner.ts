import {
  createAutoExecutionPlan,
  findMatchingSkills,
  type SkillAutoExecutionPlan,
  type SkillDefinition,
  type SkillMatchCandidate,
  type SkillMatchOptions,
} from '@dbagent/core-skills';
import {
  resolveOfficialPluginAgentTools,
  type OfficialPluginAgentToolPolicy,
  type OfficialPluginAgentToolPolicyOptions,
} from './official-plugin-tool-policy.js';
import {
  runSkillAgent,
  type SkillAgent,
  type SkillAgentPlan,
  type SkillAgentRunOptionsForAgent,
  type SkillAgentRunResult,
} from './skill-agent-runner.js';

export type AutoSkillMatchOptions = Omit<SkillMatchOptions, 'userInput' | 'availableTools' | 'maxResults'> & {
  diagnosticMaxResults?: number;
};

export type AutoSkillAgentRunOptions = Omit<SkillAgentRunOptionsForAgent, 'userMessage' | 'allowedTools'> & {
  skills: SkillDefinition[];
  userInput: string;
  toolPolicy: Omit<OfficialPluginAgentToolPolicyOptions, 'skillAllowedTools'>;
  match?: AutoSkillMatchOptions;
  userMessagePrefix?: string;
};

export type AutoSkillAgentRunResult = SkillAgentRunResult & {
  autoPlan: SkillAutoExecutionPlan;
  candidates: SkillMatchCandidate[];
  preflightToolPolicy: OfficialPluginAgentToolPolicy;
};

export class NoMatchingSkillError extends Error {
  readonly code = 'skill.no_matching_skill';
  readonly candidates: SkillMatchCandidate[];
  readonly pluginAllowedToolNames: string[];

  constructor(message: string, candidates: SkillMatchCandidate[], pluginAllowedToolNames: string[]) {
    super(message);
    this.name = 'NoMatchingSkillError';
    this.candidates = candidates;
    this.pluginAllowedToolNames = pluginAllowedToolNames;
  }
}

export async function runAutoSkillAgent(
  agent: SkillAgent,
  options: AutoSkillAgentRunOptions,
): Promise<AutoSkillAgentRunResult> {
  const preflightToolPolicy = resolveOfficialPluginAgentTools(options.toolPolicy);
  const candidates = buildDiagnosticCandidates(options, preflightToolPolicy);
  const autoPlan = selectAutoSkillPlan(options, preflightToolPolicy, candidates);
  const output = await runSkillAgent(agent, {
    providerId: options.providerId,
    model: options.model,
    skillPlan: toSkillAgentPlan(autoPlan),
    toolPolicy: options.toolPolicy,
    ...(options.userMessagePrefix === undefined ? {} : { userMessagePrefix: options.userMessagePrefix }),
    ...(options.usageMode === undefined ? {} : { usageMode: options.usageMode }),
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.maxIterations === undefined ? {} : { maxIterations: options.maxIterations }),
    ...(options.tokenBudget === undefined ? {} : { tokenBudget: options.tokenBudget }),
    ...(options.contextWindowTokens === undefined ? {} : { contextWindowTokens: options.contextWindowTokens }),
    ...(options.keepRecentMessages === undefined ? {} : { keepRecentMessages: options.keepRecentMessages }),
    ...(options.maxToolResultChars === undefined ? {} : { maxToolResultChars: options.maxToolResultChars }),
    ...(options.maxConsecutiveToolFailures === undefined
      ? {}
      : { maxConsecutiveToolFailures: options.maxConsecutiveToolFailures }),
    ...(options.maxToolExecutionMs === undefined ? {} : { maxToolExecutionMs: options.maxToolExecutionMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  return {
    ...output,
    autoPlan,
    candidates,
    preflightToolPolicy,
  };
}

export function selectAutoSkillPlan(
  options: AutoSkillAgentRunOptions,
  preflightToolPolicy = resolveOfficialPluginAgentTools(options.toolPolicy),
  candidates = buildDiagnosticCandidates(options, preflightToolPolicy),
): SkillAutoExecutionPlan {
  const autoPlan = createAutoExecutionPlan(options.skills, {
    userInput: options.userInput,
    availableTools: preflightToolPolicy.agentAllowedToolNames,
    ...(options.match?.signals === undefined ? {} : { signals: options.match.signals }),
    ...(options.match?.inferSignals === undefined ? {} : { inferSignals: options.match.inferSignals }),
    ...(options.match?.minScore === undefined ? {} : { minScore: options.match.minScore }),
  });

  if (!autoPlan) {
    throw new NoMatchingSkillError(
      'No eligible Skill matched the user input and current tool policy.',
      candidates,
      preflightToolPolicy.agentAllowedToolNames,
    );
  }

  return autoPlan;
}

function buildDiagnosticCandidates(
  options: AutoSkillAgentRunOptions,
  preflightToolPolicy: OfficialPluginAgentToolPolicy,
): SkillMatchCandidate[] {
  return findMatchingSkills(options.skills, {
    userInput: options.userInput,
    availableTools: preflightToolPolicy.agentAllowedToolNames,
    includeIneligible: true,
    maxResults: options.match?.diagnosticMaxResults ?? 5,
    ...(options.match?.signals === undefined ? {} : { signals: options.match.signals }),
    ...(options.match?.inferSignals === undefined ? {} : { inferSignals: options.match.inferSignals }),
    ...(options.match?.minScore === undefined ? {} : { minScore: options.match.minScore }),
  });
}

function toSkillAgentPlan(autoPlan: SkillAutoExecutionPlan): SkillAgentPlan {
  const { skill, userInput, systemAddition, allowedTools, steps, outputFormat } = autoPlan.plan;
  return {
    skill: {
      name: skill.name,
      ...(skill.title === undefined ? {} : { title: skill.title }),
      description: skill.description,
    },
    userInput,
    ...(systemAddition === undefined ? {} : { systemAddition }),
    allowedTools,
    steps,
    outputFormat,
  };
}
