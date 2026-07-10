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
  buildAgentToolPolicyReport,
  type AgentToolPolicyReport,
} from './agent-tool-policy-report.js';
import {
  runSkillAgent,
  type SkillAgent,
  type SkillAgentPlan,
  type SkillAgentRunOptions,
  type SkillAgentRunOptionsForAgent,
  type SkillAgentRunResult,
  type SkillPlanExecuteAgent,
  type SkillPlanExecuteRunOptionsForAgent,
  type SkillPlanExecuteRunResult,
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
  strategy?: 'react';
};

export type AutoSkillPlanExecuteRunOptions = Omit<
  SkillPlanExecuteRunOptionsForAgent,
  'userMessage' | 'allowedTools'
> & {
  skills: SkillDefinition[];
  userInput: string;
  toolPolicy: Omit<OfficialPluginAgentToolPolicyOptions, 'skillAllowedTools'>;
  match?: AutoSkillMatchOptions;
  userMessagePrefix?: string;
  strategy: 'plan-execute';
};

export type AutoSkillAgentRunResult = SkillAgentRunResult & {
  autoPlan: SkillAutoExecutionPlan;
  candidates: SkillMatchCandidate[];
  preflightToolPolicy: OfficialPluginAgentToolPolicy;
  preflightToolPolicyReport: AgentToolPolicyReport;
};

export type AutoSkillPlanExecuteRunResult = SkillPlanExecuteRunResult & {
  autoPlan: SkillAutoExecutionPlan;
  candidates: SkillMatchCandidate[];
  preflightToolPolicy: OfficialPluginAgentToolPolicy;
  preflightToolPolicyReport: AgentToolPolicyReport;
};

export type AutoSkillStrategyRunOptions = AutoSkillAgentRunOptions | AutoSkillPlanExecuteRunOptions;

export type AutoSkillStrategyRunResult = AutoSkillAgentRunResult | AutoSkillPlanExecuteRunResult;

export class NoMatchingSkillError extends Error {
  readonly code = 'skill.no_matching_skill';
  readonly candidates: SkillMatchCandidate[];
  readonly pluginAllowedToolNames: string[];
  readonly preflightToolPolicyReport: AgentToolPolicyReport;

  constructor(
    message: string,
    candidates: SkillMatchCandidate[],
    pluginAllowedToolNames: string[],
    preflightToolPolicyReport: AgentToolPolicyReport,
  ) {
    super(message);
    this.name = 'NoMatchingSkillError';
    this.candidates = candidates;
    this.pluginAllowedToolNames = pluginAllowedToolNames;
    this.preflightToolPolicyReport = preflightToolPolicyReport;
  }
}

export function runAutoSkillAgent(agent: SkillAgent, options: AutoSkillAgentRunOptions): Promise<AutoSkillAgentRunResult>;
export function runAutoSkillAgent(
  agent: SkillPlanExecuteAgent,
  options: AutoSkillPlanExecuteRunOptions,
): Promise<AutoSkillPlanExecuteRunResult>;
export async function runAutoSkillAgent(
  agent: SkillAgent | SkillPlanExecuteAgent,
  options: AutoSkillStrategyRunOptions,
): Promise<AutoSkillStrategyRunResult> {
  const preflightToolPolicy = resolveOfficialPluginAgentTools(options.toolPolicy);
  const preflightToolPolicyReport = buildAgentToolPolicyReport(
    preflightToolPolicy,
    options.mode === undefined ? {} : { mode: options.mode },
  );
  const candidates = buildDiagnosticCandidates(options, preflightToolPolicy);
  const autoPlan = selectAutoSkillPlan(options, preflightToolPolicy, candidates, preflightToolPolicyReport);
  if (options.strategy === 'plan-execute') {
    const output = await runSkillAgent(agent as SkillPlanExecuteAgent, {
      ...buildCommonSkillAgentOptions(options, autoPlan),
      strategy: 'plan-execute',
      ...(options.maxPlanSteps === undefined ? {} : { maxPlanSteps: options.maxPlanSteps }),
      ...(options.stopOnStepFailure === undefined ? {} : { stopOnStepFailure: options.stopOnStepFailure }),
      ...(options.initialPlan === undefined ? {} : { initialPlan: options.initialPlan }),
      ...(options.initialExecutedSteps === undefined ? {} : { initialExecutedSteps: options.initialExecutedSteps }),
      ...(options.initialTotalIterations === undefined ? {} : { initialTotalIterations: options.initialTotalIterations }),
    });

    return {
      ...output,
      autoPlan,
      candidates,
      preflightToolPolicy,
      preflightToolPolicyReport,
    };
  }

  const output = await runSkillAgent(agent as SkillAgent, buildCommonSkillAgentOptions(options, autoPlan));

  return {
    ...output,
    autoPlan,
    candidates,
    preflightToolPolicy,
    preflightToolPolicyReport,
  };
}

export function selectAutoSkillPlan(
  options: AutoSkillStrategyRunOptions,
  preflightToolPolicy = resolveOfficialPluginAgentTools(options.toolPolicy),
  candidates = buildDiagnosticCandidates(options, preflightToolPolicy),
  preflightToolPolicyReport = buildAgentToolPolicyReport(
    preflightToolPolicy,
    options.mode === undefined ? {} : { mode: options.mode },
  ),
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
      preflightToolPolicyReport,
    );
  }

  return autoPlan;
}

function buildDiagnosticCandidates(
  options: AutoSkillStrategyRunOptions,
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

function buildCommonSkillAgentOptions(
  options: AutoSkillStrategyRunOptions,
  autoPlan: SkillAutoExecutionPlan,
): Omit<SkillAgentRunOptions, 'strategy'> {
  return {
    providerId: options.providerId,
    model: options.model,
    skillPlan: toSkillAgentPlan(autoPlan),
    toolPolicy: options.toolPolicy,
    ...(options.userMessagePrefix === undefined ? {} : { userMessagePrefix: options.userMessagePrefix }),
    ...(options.initialSession === undefined ? {} : { initialSession: options.initialSession }),
    ...(options.initialIteration === undefined ? {} : { initialIteration: options.initialIteration }),
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
    ...(options.taskSafety === undefined ? {} : { taskSafety: options.taskSafety }),
    ...(options.outputSafety === undefined ? {} : { outputSafety: options.outputSafety }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
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
