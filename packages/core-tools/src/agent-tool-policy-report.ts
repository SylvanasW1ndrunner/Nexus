import type {
  RuntimeToolBlockDetail,
  RuntimeToolPermission,
  RuntimeToolPolicy,
} from './runtime-tool-policy.js';

export type AgentToolPolicyReport = {
  generatedAt: string;
  allowedTools: RuntimeToolPermission[];
  blockedTools: RuntimeToolBlockDetail[];
  summary: {
    allowedToolCount: number;
    blockedToolCount: number;
    blockedByPolicyCount: number;
    blockedBySkillCount: number;
    readonlyAllowedToolCount: number;
    writeCapableAllowedToolCount: number;
    approvalRequiredToolNames: string[];
    sources: string[];
  };
};

export function buildAgentToolPolicyReport(
  policy: RuntimeToolPolicy,
  options: { generatedAt?: string } = {},
): AgentToolPolicyReport {
  const blockedTools = [
    ...policy.blockedByPolicyToolDetails,
    ...policy.blockedBySkillToolDetails,
  ];
  return {
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    allowedTools: policy.toolPermissions,
    blockedTools,
    summary: {
      allowedToolCount: policy.toolPermissions.length,
      blockedToolCount: blockedTools.length,
      blockedByPolicyCount: policy.blockedByPolicyToolDetails.length,
      blockedBySkillCount: policy.blockedBySkillToolDetails.length,
      readonlyAllowedToolCount: policy.toolPermissions.filter((tool) => tool.readonly === true).length,
      writeCapableAllowedToolCount: policy.toolPermissions.filter((tool) => tool.readonly !== true).length,
      approvalRequiredToolNames: policy.toolPermissions
        .filter((tool) => tool.approvalRequired)
        .map((tool) => tool.name),
      sources: [...new Set(policy.toolPermissions.map((tool) => tool.source ?? 'unknown'))].sort(),
    },
  };
}
