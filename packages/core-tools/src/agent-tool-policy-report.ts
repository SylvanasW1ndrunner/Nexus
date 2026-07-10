import { decideAutomaticPermission, type AgentMode, type ToolDangerLevel } from '@dbagent/core-agent';
import type {
  OfficialPluginAgentToolBlockDetail,
  OfficialPluginAgentToolPermission,
  OfficialPluginAgentToolPolicy,
} from './official-plugin-tool-policy.js';
import type {
  OfficialPluginApprovalPolicy,
  OfficialPluginAuditLevel,
  OfficialPluginNetworkAccess,
  OfficialPluginProcessAccess,
  OfficialPluginResourceScope,
  OfficialPluginSecretKind,
} from './official-plugin-registry.js';

export type AgentToolPolicyReportOptions = {
  mode?: AgentMode;
};

export type AgentToolPolicyReport = {
  mode: AgentMode;
  allowedTools: AgentToolPolicyAllowedToolReport[];
  blockedTools: AgentToolPolicyBlockedToolReport[];
  missingStaticTools: AgentToolPolicyMissingStaticToolReport[];
  summary: AgentToolPolicyReportSummary;
};

export type AgentToolPolicyAllowedToolReport = {
  toolName: string;
  pluginId: string;
  pluginName: string;
  contributionName: string;
  dynamic: boolean;
  dangerLevel: ToolDangerLevel;
  readonly: boolean;
  automaticDecision: 'allow' | 'deny' | 'ask';
  requiresApproval: boolean;
  permissionIds: string[];
  resourceScopes: OfficialPluginResourceScope[];
  approvalPolicies: OfficialPluginApprovalPolicy[];
  networkAccess: OfficialPluginNetworkAccess[];
  processAccess: OfficialPluginProcessAccess[];
  secretKinds: OfficialPluginSecretKind[];
  auditLevels: OfficialPluginAuditLevel[];
};

export type AgentToolPolicyBlockedToolReport = {
  toolName: string;
  blockedBy: 'plugin' | 'skill';
  reason: OfficialPluginAgentToolBlockDetail['reason'];
  message: string;
  pluginId?: string;
  contributionName?: string;
  dangerLevel?: ToolDangerLevel;
  readonly?: boolean;
  source?: string;
  sourceId?: string;
  originalName?: string;
};

export type AgentToolPolicyMissingStaticToolReport = {
  toolName: string;
  pluginId: string;
  pluginName: string;
  contributionName: string;
  dangerLevel: ToolDangerLevel;
  readonly: boolean;
  requiredPermissions: string[];
};

export type AgentToolPolicyReportSummary = {
  allowedToolCount: number;
  blockedToolCount: number;
  blockedByPluginCount: number;
  blockedBySkillCount: number;
  missingStaticToolCount: number;
  writeCapableAllowedToolCount: number;
  highRiskAllowedToolCount: number;
  approvalRequiredToolNames: string[];
  deniedByModeToolNames: string[];
  remoteNetworkToolNames: string[];
  processAccessToolNames: string[];
  secretKinds: OfficialPluginSecretKind[];
  metadataAndArgumentsAuditToolNames: string[];
};

export function buildAgentToolPolicyReport(
  policy: OfficialPluginAgentToolPolicy,
  options: AgentToolPolicyReportOptions = {},
): AgentToolPolicyReport {
  const mode = options.mode ?? 'ask';
  const allowedTools = policy.toolPermissions.map((tool) => toAllowedToolReport(tool, mode));
  const blockedTools = [
    ...policy.blockedByPluginToolDetails,
    ...policy.blockedBySkillToolDetails,
  ].map(toBlockedToolReport);
  const missingStaticTools = policy.runtimeResolution.missingStaticToolDetails.map((detail) => ({
    toolName: detail.toolName,
    pluginId: detail.pluginId,
    pluginName: detail.pluginName,
    contributionName: detail.contributionName,
    dangerLevel: detail.dangerLevel,
    readonly: detail.readonly,
    requiredPermissions: [...detail.requiredPermissions],
  }));

  return {
    mode,
    allowedTools,
    blockedTools,
    missingStaticTools,
    summary: buildSummary(allowedTools, blockedTools, missingStaticTools),
  };
}

function toAllowedToolReport(
  tool: OfficialPluginAgentToolPermission,
  mode: AgentMode,
): AgentToolPolicyAllowedToolReport {
  const automaticDecision = decideAutomaticPermission(mode, {
    dangerLevel: tool.dangerLevel,
    readonly: tool.readonly,
  });
  return {
    toolName: tool.toolName,
    pluginId: tool.pluginId,
    pluginName: tool.pluginName,
    contributionName: tool.contributionName,
    dynamic: tool.dynamic,
    dangerLevel: tool.dangerLevel,
    readonly: tool.readonly,
    automaticDecision,
    requiresApproval:
      automaticDecision === 'ask' ||
      tool.permissions.some((permission) => permission.approvalPolicy === 'always'),
    permissionIds: tool.permissions.map((permission) => permission.id),
    resourceScopes: unique(tool.permissions.flatMap((permission) => permission.resourceScopes)),
    approvalPolicies: unique(tool.permissions.map((permission) => permission.approvalPolicy)),
    networkAccess: unique(tool.permissions.map((permission) => permission.networkAccess)),
    processAccess: unique(tool.permissions.map((permission) => permission.processAccess)),
    secretKinds: unique(tool.permissions.flatMap((permission) => permission.secretKinds)),
    auditLevels: unique(tool.permissions.map((permission) => permission.auditLevel)),
  };
}

function toBlockedToolReport(
  detail: OfficialPluginAgentToolBlockDetail,
): AgentToolPolicyBlockedToolReport {
  return {
    toolName: detail.toolName,
    blockedBy: detail.blockedBy,
    reason: detail.reason,
    message: detail.message,
    ...(detail.pluginId === undefined ? {} : { pluginId: detail.pluginId }),
    ...(detail.contributionName === undefined ? {} : { contributionName: detail.contributionName }),
    ...(detail.runtime?.dangerLevel === undefined ? {} : { dangerLevel: detail.runtime.dangerLevel }),
    ...(detail.runtime?.readonly === undefined ? {} : { readonly: detail.runtime.readonly }),
    ...(detail.runtime?.source === undefined ? {} : { source: detail.runtime.source }),
    ...(detail.runtime?.sourceId === undefined ? {} : { sourceId: detail.runtime.sourceId }),
    ...(detail.runtime?.originalName === undefined ? {} : { originalName: detail.runtime.originalName }),
  };
}

function buildSummary(
  allowedTools: AgentToolPolicyAllowedToolReport[],
  blockedTools: AgentToolPolicyBlockedToolReport[],
  missingStaticTools: AgentToolPolicyMissingStaticToolReport[],
): AgentToolPolicyReportSummary {
  return {
    allowedToolCount: allowedTools.length,
    blockedToolCount: blockedTools.length,
    blockedByPluginCount: blockedTools.filter((tool) => tool.blockedBy === 'plugin').length,
    blockedBySkillCount: blockedTools.filter((tool) => tool.blockedBy === 'skill').length,
    missingStaticToolCount: missingStaticTools.length,
    writeCapableAllowedToolCount: allowedTools.filter((tool) => !tool.readonly).length,
    highRiskAllowedToolCount: allowedTools.filter((tool) =>
      tool.dangerLevel === 'high' || tool.dangerLevel === 'critical',
    ).length,
    approvalRequiredToolNames: allowedTools
      .filter((tool) => tool.requiresApproval)
      .map((tool) => tool.toolName),
    deniedByModeToolNames: allowedTools
      .filter((tool) => tool.automaticDecision === 'deny')
      .map((tool) => tool.toolName),
    remoteNetworkToolNames: allowedTools
      .filter((tool) => tool.networkAccess.includes('remote'))
      .map((tool) => tool.toolName),
    processAccessToolNames: allowedTools
      .filter((tool) => tool.processAccess.some((access) => access !== 'none'))
      .map((tool) => tool.toolName),
    secretKinds: unique(allowedTools.flatMap((tool) => tool.secretKinds)),
    metadataAndArgumentsAuditToolNames: allowedTools
      .filter((tool) => tool.auditLevels.includes('metadata-and-arguments'))
      .map((tool) => tool.toolName),
  };
}

function unique<T extends string>(values: T[]): T[] {
  return [...new Set(values)];
}
