import type { AgentRunOptions, AgentRunResult } from '@dbagent/core-agent';
import {
  buildAgentToolPolicyReport,
  type AgentToolPolicyReport,
} from './agent-tool-policy-report.js';
import {
  resolveRuntimeToolPolicy,
  type RuntimeToolPolicy,
  type RuntimeToolPolicyOptions,
} from './runtime-tool-policy.js';

export type SkillAgentPlan = {
  skill?: { name: string; title?: string; description?: string };
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

export type SkillAgent = {
  run(options: SkillAgentRunOptionsForAgent): Promise<AgentRunResult>;
};

export type SkillAgentRunOptions = Omit<
  SkillAgentRunOptionsForAgent,
  'userMessage' | 'allowedTools'
> & {
  skillPlan: SkillAgentPlan;
  toolPolicy: Omit<RuntimeToolPolicyOptions, 'skillAllowedTools'>;
  userMessagePrefix?: string;
};

export type SkillAgentRunResult = {
  strategy: 'react';
  result: AgentRunResult;
  toolPolicy: RuntimeToolPolicy;
  toolPolicyReport: AgentToolPolicyReport;
  renderedUserMessage: string;
};

export async function runSkillAgent(
  agent: SkillAgent,
  options: SkillAgentRunOptions,
): Promise<SkillAgentRunResult> {
  const toolPolicy = resolveRuntimeToolPolicy({
    ...options.toolPolicy,
    skillAllowedTools: options.skillPlan.allowedTools,
  });
  const toolPolicyReport = buildAgentToolPolicyReport(toolPolicy);
  const renderedUserMessage = renderSkillAgentUserMessage(
    options.skillPlan,
    options.userMessagePrefix,
  );
  const result = await agent.run(
    buildRunOptions(options, renderedUserMessage, toolPolicy.agentAllowedToolNames),
  );
  return { strategy: 'react', result, toolPolicy, toolPolicyReport, renderedUserMessage };
}

export function renderSkillAgentUserMessage(plan: SkillAgentPlan, prefix?: string): string {
  const lines: string[] = [];
  if (prefix?.trim()) lines.push(prefix.trim(), '');
  if (plan.skill) {
    lines.push(`当前 Skill：${plan.skill.title ?? plan.skill.name}`);
    if (plan.skill.description?.trim()) lines.push(`说明：${plan.skill.description.trim()}`);
    lines.push('');
  }
  if (plan.systemAddition?.trim()) lines.push('约束与说明：', plan.systemAddition.trim(), '');
  if (plan.steps?.length) {
    lines.push('建议步骤：', ...plan.steps.map((step, index) => `${index + 1}. ${step}`), '');
  }
  if (plan.outputFormat) lines.push(`输出格式：${plan.outputFormat}`, '');
  lines.push('用户任务：', plan.userInput);
  return lines.join('\n').trim();
}

function buildRunOptions(
  options: SkillAgentRunOptions,
  userMessage: string,
  allowedTools: string[],
): SkillAgentRunOptionsForAgent {
  return {
    providerId: options.providerId,
    model: options.model,
    userMessage,
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
    ...(options.maxConsecutiveToolFailures === undefined ? {} : { maxConsecutiveToolFailures: options.maxConsecutiveToolFailures }),
    ...(options.maxToolExecutionMs === undefined ? {} : { maxToolExecutionMs: options.maxToolExecutionMs }),
    ...(options.taskSafety === undefined ? {} : { taskSafety: options.taskSafety }),
    ...(options.outputSafety === undefined ? {} : { outputSafety: options.outputSafety }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}
