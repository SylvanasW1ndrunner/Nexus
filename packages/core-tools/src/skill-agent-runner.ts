import type {
  AgentPlanExecuteOptions,
  AgentPlanExecuteResult,
  AgentRunOptions,
  AgentRunResult,
  AgentStrategy,
} from '@dbagent/core-agent';
import {
  buildAgentToolPolicyReport,
  type AgentToolPolicyReport,
} from './agent-tool-policy-report.js';
import {
  resolveOfficialPluginAgentTools,
  type OfficialPluginAgentToolPolicy,
  type OfficialPluginAgentToolPolicyOptions,
} from './official-plugin-tool-policy.js';

export type SkillAgentPlan = {
  skill?: {
    name: string;
    title?: string;
    description?: string;
  };
  userInput: string;
  systemAddition?: string;
  allowedTools: string[];
  steps?: string[];
  outputFormat?: 'markdown' | 'json' | 'text';
};

export type SkillAgentRunOptionsForAgent = AgentRunOptions & {
  maxConsecutiveToolFailures?: number;
  maxToolExecutionMs?: number;
};

export type SkillPlanExecuteRunOptionsForAgent = AgentPlanExecuteOptions & {
  maxConsecutiveToolFailures?: number;
  maxToolExecutionMs?: number;
};

export type SkillAgent = {
  run(options: SkillAgentRunOptionsForAgent): Promise<AgentRunResult>;
};

export type SkillPlanExecuteAgent = {
  run(options: SkillPlanExecuteRunOptionsForAgent): Promise<AgentPlanExecuteResult>;
};

export type SkillAgentRunStrategy = AgentStrategy;

export type SkillAgentRunOptions = Omit<SkillAgentRunOptionsForAgent, 'userMessage' | 'allowedTools'> & {
  skillPlan: SkillAgentPlan;
  toolPolicy: Omit<OfficialPluginAgentToolPolicyOptions, 'skillAllowedTools'>;
  userMessagePrefix?: string;
  strategy?: 'react';
};

export type SkillPlanExecuteRunOptions = Omit<SkillPlanExecuteRunOptionsForAgent, 'userMessage' | 'allowedTools'> & {
  skillPlan: SkillAgentPlan;
  toolPolicy: Omit<OfficialPluginAgentToolPolicyOptions, 'skillAllowedTools'>;
  userMessagePrefix?: string;
  strategy: 'plan-execute';
};

export type SkillAgentRunResult = {
  strategy: 'react';
  result: AgentRunResult;
  toolPolicy: OfficialPluginAgentToolPolicy;
  toolPolicyReport: AgentToolPolicyReport;
  renderedUserMessage: string;
};

export type SkillPlanExecuteRunResult = {
  strategy: 'plan-execute';
  result: AgentPlanExecuteResult;
  toolPolicy: OfficialPluginAgentToolPolicy;
  toolPolicyReport: AgentToolPolicyReport;
  renderedUserMessage: string;
};

export type SkillAgentStrategyRunOptions = SkillAgentRunOptions | SkillPlanExecuteRunOptions;

export type SkillAgentStrategyRunResult = SkillAgentRunResult | SkillPlanExecuteRunResult;

export function runSkillAgent(agent: SkillAgent, options: SkillAgentRunOptions): Promise<SkillAgentRunResult>;
export function runSkillAgent(
  agent: SkillPlanExecuteAgent,
  options: SkillPlanExecuteRunOptions,
): Promise<SkillPlanExecuteRunResult>;
export async function runSkillAgent(
  agent: SkillAgent | SkillPlanExecuteAgent,
  options: SkillAgentStrategyRunOptions,
): Promise<SkillAgentStrategyRunResult> {
  const toolPolicy = resolveOfficialPluginAgentTools({
    ...options.toolPolicy,
    skillAllowedTools: options.skillPlan.allowedTools,
  });
  const toolPolicyReport = buildAgentToolPolicyReport(
    toolPolicy,
    options.mode === undefined ? {} : { mode: options.mode },
  );
  const renderedUserMessage = renderSkillAgentUserMessage(options.skillPlan, options.userMessagePrefix);
  if (options.strategy === 'plan-execute') {
    const agentRunOptions: SkillPlanExecuteRunOptionsForAgent = {
      ...buildCommonAgentRunOptions(options, renderedUserMessage, toolPolicy.agentAllowedToolNames),
      ...(options.maxPlanSteps === undefined ? {} : { maxPlanSteps: options.maxPlanSteps }),
      ...(options.stopOnStepFailure === undefined ? {} : { stopOnStepFailure: options.stopOnStepFailure }),
      ...(options.initialPlan === undefined ? {} : { initialPlan: options.initialPlan }),
      ...(options.initialExecutedSteps === undefined ? {} : { initialExecutedSteps: options.initialExecutedSteps }),
      ...(options.initialTotalIterations === undefined ? {} : { initialTotalIterations: options.initialTotalIterations }),
    };
    const result = await (agent as SkillPlanExecuteAgent).run(agentRunOptions);

    return {
      strategy: 'plan-execute',
      result,
      toolPolicy,
      toolPolicyReport,
      renderedUserMessage,
    };
  }

  const agentRunOptions: SkillAgentRunOptionsForAgent = buildCommonAgentRunOptions(
    options,
    renderedUserMessage,
    toolPolicy.agentAllowedToolNames,
  );
  const result = await (agent as SkillAgent).run(agentRunOptions);

  return {
    strategy: 'react',
    result,
    toolPolicy,
    toolPolicyReport,
    renderedUserMessage,
  };
}

function buildCommonAgentRunOptions(
  options: SkillAgentStrategyRunOptions,
  renderedUserMessage: string,
  allowedTools: string[],
): SkillAgentRunOptionsForAgent {
  return {
    providerId: options.providerId,
    model: options.model,
    userMessage: renderedUserMessage,
    allowedTools,
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

export function renderSkillAgentUserMessage(plan: SkillAgentPlan, prefix?: string): string {
  const lines: string[] = [];
  if (prefix?.trim()) lines.push(prefix.trim(), '');
  if (plan.skill) {
    lines.push(`当前 Skill: ${plan.skill.title ?? plan.skill.name}`);
    if (plan.skill.description?.trim()) lines.push(`Skill 说明: ${plan.skill.description.trim()}`);
    lines.push('');
  }
  if (plan.systemAddition?.trim()) {
    lines.push('Skill 系统补充要求:', plan.systemAddition.trim(), '');
  }
  if (plan.steps && plan.steps.length > 0) {
    lines.push('Skill 执行步骤:');
    plan.steps.forEach((step, index) => {
      lines.push(`${index + 1}. ${step}`);
    });
    lines.push('');
  }
  if (plan.outputFormat) {
    lines.push(`期望输出格式: ${plan.outputFormat}`, '');
  }
  lines.push('用户任务:', plan.userInput);
  return lines.join('\n').trim();
}
