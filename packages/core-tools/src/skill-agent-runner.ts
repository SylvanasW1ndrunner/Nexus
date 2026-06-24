import type { AgentRunOptions, AgentRunResult } from '@dbagent/core-agent';
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

export type SkillAgent = {
  run(options: SkillAgentRunOptionsForAgent): Promise<AgentRunResult>;
};

export type SkillAgentRunOptions = Omit<SkillAgentRunOptionsForAgent, 'userMessage' | 'allowedTools'> & {
  skillPlan: SkillAgentPlan;
  toolPolicy: Omit<OfficialPluginAgentToolPolicyOptions, 'skillAllowedTools'>;
  userMessagePrefix?: string;
};

export type SkillAgentRunResult = {
  result: AgentRunResult;
  toolPolicy: OfficialPluginAgentToolPolicy;
  renderedUserMessage: string;
};

export async function runSkillAgent(agent: SkillAgent, options: SkillAgentRunOptions): Promise<SkillAgentRunResult> {
  const toolPolicy = resolveOfficialPluginAgentTools({
    ...options.toolPolicy,
    skillAllowedTools: options.skillPlan.allowedTools,
  });
  const renderedUserMessage = renderSkillAgentUserMessage(options.skillPlan, options.userMessagePrefix);
  const agentRunOptions: SkillAgentRunOptionsForAgent = {
    providerId: options.providerId,
    model: options.model,
    userMessage: renderedUserMessage,
    allowedTools: toolPolicy.agentAllowedToolNames,
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
  };
  const result = await agent.run(agentRunOptions);

  return {
    result,
    toolPolicy,
    renderedUserMessage,
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
