import {
  createAutoExecutionPlan,
  findMatchingSkills,
  type SkillAutoExecutionPlan,
  type SkillDefinition,
  type SkillMatchCandidate,
  type SkillMatchOptions,
} from '@dbagent/core-skills';
import {
  buildAgentToolPolicyReport,
  type AgentToolPolicyReport,
} from './agent-tool-policy-report.js';
import {
  resolveRuntimeToolPolicy,
  type RuntimeToolPolicy,
  type RuntimeToolPolicyOptions,
} from './runtime-tool-policy.js';
import {
  runSkillAgent,
  type SkillAgent,
  type SkillAgentPlan,
  type SkillAgentRunOptions,
  type SkillAgentRunOptionsForAgent,
  type SkillAgentRunResult,
} from './skill-agent-runner.js';

export type AutoSkillMatchOptions = Omit<
  SkillMatchOptions,
  'userInput' | 'availableTools' | 'maxResults'
> & { diagnosticMaxResults?: number };

export type AutoSkillAgentRunOptions = Omit<
  SkillAgentRunOptionsForAgent,
  'userMessage' | 'allowedTools'
> & {
  skills: SkillDefinition[];
  userInput: string;
  toolPolicy: Omit<RuntimeToolPolicyOptions, 'skillAllowedTools'>;
  match?: AutoSkillMatchOptions;
  userMessagePrefix?: string;
};

export type AutoSkillAgentRunResult = SkillAgentRunResult & {
  autoPlan: SkillAutoExecutionPlan;
  candidates: SkillMatchCandidate[];
  preflightToolPolicy: RuntimeToolPolicy;
  preflightToolPolicyReport: AgentToolPolicyReport;
};

export class NoMatchingSkillError extends Error {
  readonly code = 'skill.no_matching_skill';
  constructor(
    message: string,
    readonly candidates: SkillMatchCandidate[],
    readonly runtimeAllowedToolNames: string[],
    readonly preflightToolPolicyReport: AgentToolPolicyReport,
  ) {
    super(message);
    this.name = 'NoMatchingSkillError';
  }
}

export async function runAutoSkillAgent(
  agent: SkillAgent,
  options: AutoSkillAgentRunOptions,
): Promise<AutoSkillAgentRunResult> {
  const preflightToolPolicy = resolveRuntimeToolPolicy(options.toolPolicy);
  const preflightToolPolicyReport = buildAgentToolPolicyReport(preflightToolPolicy);
  const candidates = diagnosticCandidates(options, preflightToolPolicy);
  const autoPlan = selectAutoSkillPlan(
    options,
    preflightToolPolicy,
    candidates,
    preflightToolPolicyReport,
  );
  const output = await runSkillAgent(agent, commonSkillOptions(options, autoPlan));
  return { ...output, autoPlan, candidates, preflightToolPolicy, preflightToolPolicyReport };
}

export function selectAutoSkillPlan(
  options: AutoSkillAgentRunOptions,
  preflightToolPolicy = resolveRuntimeToolPolicy(options.toolPolicy),
  candidates = diagnosticCandidates(options, preflightToolPolicy),
  report = buildAgentToolPolicyReport(preflightToolPolicy),
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
      'No eligible Skill matched the request and current runtime tool policy.',
      candidates,
      preflightToolPolicy.runtimeAllowedToolNames,
      report,
    );
  }
  return autoPlan;
}

function diagnosticCandidates(
  options: AutoSkillAgentRunOptions,
  policy: RuntimeToolPolicy,
): SkillMatchCandidate[] {
  return findMatchingSkills(options.skills, {
    userInput: options.userInput,
    availableTools: policy.agentAllowedToolNames,
    includeIneligible: true,
    maxResults: options.match?.diagnosticMaxResults ?? 5,
    ...(options.match?.signals === undefined ? {} : { signals: options.match.signals }),
    ...(options.match?.inferSignals === undefined ? {} : { inferSignals: options.match.inferSignals }),
    ...(options.match?.minScore === undefined ? {} : { minScore: options.match.minScore }),
  });
}

function commonSkillOptions(
  options: AutoSkillAgentRunOptions,
  autoPlan: SkillAutoExecutionPlan,
): SkillAgentRunOptions {
  return {
    providerId: options.providerId,
    model: options.model,
    skillPlan: toAgentPlan(autoPlan),
    toolPolicy: options.toolPolicy,
    ...(options.userMessagePrefix === undefined ? {} : { userMessagePrefix: options.userMessagePrefix }),
    ...(options.initialSession === undefined ? {} : { initialSession: options.initialSession }),
    ...(options.initialIteration === undefined ? {} : { initialIteration: options.initialIteration }),
    ...(options.usageMode === undefined ? {} : { usageMode: options.usageMode }),
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.userId === undefined ? {} : { userId: options.userId }),
    ...(options.maxIterations === undefined ? {} : { maxIterations: options.maxIterations }),
    ...(options.keepRecentMessages === undefined ? {} : { keepRecentMessages: options.keepRecentMessages }),
    ...(options.maxToolResultChars === undefined ? {} : { maxToolResultChars: options.maxToolResultChars }),
    ...(options.maxConsecutiveToolFailures === undefined ? {} : { maxConsecutiveToolFailures: options.maxConsecutiveToolFailures }),
    ...(options.maxToolExecutionMs === undefined ? {} : { maxToolExecutionMs: options.maxToolExecutionMs }),
    ...(options.taskSafety === undefined ? {} : { taskSafety: options.taskSafety }),
    ...(options.outputSafety === undefined ? {} : { outputSafety: options.outputSafety }),
    ...(options.knowledgeSnapshot === undefined
      ? {}
      : { knowledgeSnapshot: options.knowledgeSnapshot }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

function toAgentPlan(autoPlan: SkillAutoExecutionPlan): SkillAgentPlan {
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
    ...(skill.stopConditions === undefined
      ? {}
      : { stopConditions: skill.stopConditions }),
    ...(skill.executionLimits === undefined
      ? {}
      : { executionLimits: skill.executionLimits }),
    outputFormat,
  };
}
