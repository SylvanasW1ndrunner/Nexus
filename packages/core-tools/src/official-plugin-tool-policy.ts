import type { ToolDangerLevel, ToolRegistry } from '@dbagent/core-agent';
import {
  createDefaultOfficialPluginRegistry,
  type OfficialPluginApprovalPolicy,
  type OfficialPluginAuditLevel,
  type OfficialPluginManifest,
  type OfficialPluginNetworkAccess,
  type OfficialPluginPermission,
  type OfficialPluginProcessAccess,
  type OfficialPluginRegistry,
  type OfficialPluginResourceScope,
  type OfficialPluginRuntimeToolDescriptor,
  type OfficialPluginRuntimeToolResolution,
  type OfficialPluginRuntimeToolSource,
  type OfficialPluginSecretKind,
  type OfficialPluginToolContribution,
  type OfficialPluginToolResolutionOptions,
} from './official-plugin-registry.js';

export type OfficialPluginAgentToolPolicyOptions = OfficialPluginToolResolutionOptions & {
  registry?: OfficialPluginRegistry;
  runtimeTools?: OfficialPluginRuntimeToolDescriptor[];
  toolRegistry?: Pick<ToolRegistry, 'list'>;
  skillAllowedTools?: string[];
};

export type OfficialPluginAgentToolPolicy = {
  agentAllowedToolNames: string[];
  pluginAllowedToolNames: string[];
  blockedByPluginToolNames: string[];
  blockedBySkillToolNames: string[];
  toolPermissions: OfficialPluginAgentToolPermission[];
  runtimeResolution: OfficialPluginRuntimeToolResolution;
};

export type OfficialPluginAgentToolPermission = {
  toolName: string;
  pluginId: string;
  pluginName: string;
  contributionName: string;
  dynamic: boolean;
  dangerLevel: ToolDangerLevel;
  readonly: boolean;
  runtime: {
    source?: string;
    sourceId?: string;
    originalName?: string;
  };
  permissions: Array<{
    id: string;
    title: string;
    risk: ToolDangerLevel;
    readonly: boolean;
    resourceScopes: OfficialPluginResourceScope[];
    approvalPolicy: OfficialPluginApprovalPolicy;
    networkAccess: OfficialPluginNetworkAccess;
    processAccess: OfficialPluginProcessAccess;
    secretKinds: OfficialPluginSecretKind[];
    auditLevel: OfficialPluginAuditLevel;
  }>;
};

export function resolveOfficialPluginAgentTools(
  options: OfficialPluginAgentToolPolicyOptions,
): OfficialPluginAgentToolPolicy {
  const {
    registry = createDefaultOfficialPluginRegistry(),
    runtimeTools,
    toolRegistry,
    skillAllowedTools,
    ...resolutionOptions
  } = options;
  const descriptors = resolveRuntimeToolDescriptors(runtimeTools, toolRegistry);
  const runtimeResolution = registry.resolveRuntimeTools({
    ...resolutionOptions,
    runtimeTools: descriptors,
  });
  const pluginAllowedToolNames = runtimeResolution.allowedToolNames;

  if (skillAllowedTools === undefined) {
    const agentAllowedToolNames = pluginAllowedToolNames;
    return {
      agentAllowedToolNames,
      pluginAllowedToolNames,
      blockedByPluginToolNames: [],
      blockedBySkillToolNames: [],
      toolPermissions: buildAgentToolPermissions(registry, descriptors, agentAllowedToolNames, resolutionOptions),
      runtimeResolution,
    };
  }

  assertUniqueNames(skillAllowedTools, 'skill allowed tool');
  const pluginAllowed = new Set(pluginAllowedToolNames);
  const skillAllowed = new Set(skillAllowedTools);

  const agentAllowedToolNames = skillAllowedTools.filter((toolName) => pluginAllowed.has(toolName));

  return {
    agentAllowedToolNames,
    pluginAllowedToolNames,
    blockedByPluginToolNames: skillAllowedTools.filter((toolName) => !pluginAllowed.has(toolName)),
    blockedBySkillToolNames: pluginAllowedToolNames.filter((toolName) => !skillAllowed.has(toolName)),
    toolPermissions: buildAgentToolPermissions(registry, descriptors, agentAllowedToolNames, resolutionOptions),
    runtimeResolution,
  };
}

export function runtimeToolsFromToolRegistry(
  registry: Pick<ToolRegistry, 'list'>,
): OfficialPluginRuntimeToolDescriptor[] {
  return registry.list().map((tool) => {
    const source = optionalStringProperty(tool, 'source');
    const sourceId = optionalStringProperty(tool, 'sourceId');
    const originalName = optionalStringProperty(tool, 'originalName');
    return {
      name: tool.name,
      dangerLevel: tool.dangerLevel,
      ...(tool.readonly === undefined ? {} : { readonly: tool.readonly }),
      ...(source === undefined ? {} : { source }),
      ...(sourceId === undefined ? {} : { sourceId }),
      ...(originalName === undefined ? {} : { originalName }),
    };
  });
}

function resolveRuntimeToolDescriptors(
  runtimeTools: OfficialPluginRuntimeToolDescriptor[] | undefined,
  toolRegistry: Pick<ToolRegistry, 'list'> | undefined,
): OfficialPluginRuntimeToolDescriptor[] {
  if ((runtimeTools === undefined) === (toolRegistry === undefined)) {
    throw new Error('Provide exactly one of runtimeTools or toolRegistry.');
  }
  return runtimeTools ?? runtimeToolsFromToolRegistry(toolRegistry!);
}

function assertUniqueNames(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`Duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

const dangerRank: Record<ToolDangerLevel, number> = {
  safe: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

function buildAgentToolPermissions(
  registry: OfficialPluginRegistry,
  runtimeTools: OfficialPluginRuntimeToolDescriptor[],
  agentAllowedToolNames: string[],
  options: OfficialPluginToolResolutionOptions,
): OfficialPluginAgentToolPermission[] {
  const runtimeByName = new Map(runtimeTools.map((tool) => [tool.name, tool]));
  return agentAllowedToolNames.map((toolName) => {
    const runtimeTool = runtimeByName.get(toolName);
    if (!runtimeTool) throw new Error(`Allowed tool is missing from runtime descriptors: ${toolName}`);
    const match = findMatchingContribution(registry, runtimeTool, options);
    if (!match) throw new Error(`Allowed tool has no official plugin contribution: ${toolName}`);
    const permissionById = new Map(match.manifest.permissions.map((permission) => [permission.id, permission]));
    return {
      toolName,
      pluginId: match.manifest.id,
      pluginName: match.manifest.name,
      contributionName: match.contribution.name,
      dynamic: match.contribution.dynamic === true,
      dangerLevel: runtimeTool.dangerLevel,
      readonly: runtimeTool.readonly === true,
      runtime: {
        ...(runtimeTool.source === undefined ? {} : { source: runtimeTool.source }),
        ...(runtimeTool.sourceId === undefined ? {} : { sourceId: runtimeTool.sourceId }),
        ...(runtimeTool.originalName === undefined ? {} : { originalName: runtimeTool.originalName }),
      },
      permissions: match.contribution.permissions.map((permissionId) =>
        toToolPermissionSnapshot(assertPermission(permissionById, permissionId, match.manifest.id)),
      ),
    };
  });
}

function findMatchingContribution(
  registry: OfficialPluginRegistry,
  runtimeTool: OfficialPluginRuntimeToolDescriptor,
  options: OfficialPluginToolResolutionOptions,
): { manifest: OfficialPluginManifest; contribution: OfficialPluginToolContribution } | undefined {
  const staticToolNames = new Set(registry.resolveToolContributions(options).toolNames);
  for (const manifest of registry.listEnabled(options)) {
    for (const contribution of manifest.tools) {
      if (!contributionPassesResolutionOptions(contribution, options)) continue;
      if (staticContributionMatchesRuntimeTool(contribution, runtimeTool)) return { manifest, contribution };
      if (!staticToolNames.has(runtimeTool.name) && dynamicContributionMatchesRuntimeTool(contribution, runtimeTool)) {
        return { manifest, contribution };
      }
    }
  }
  return undefined;
}

function contributionPassesResolutionOptions(
  contribution: OfficialPluginToolContribution,
  options: OfficialPluginToolResolutionOptions,
): boolean {
  if (options.readonlyOnly === true && !contribution.readonly) return false;
  if (options.maxDangerLevel && dangerRank[contribution.dangerLevel] > dangerRank[options.maxDangerLevel]) return false;
  if (
    options.allowedPermissions !== undefined &&
    !contribution.permissions.every((permission) => options.allowedPermissions!.includes(permission))
  ) {
    return false;
  }
  return true;
}

function staticContributionMatchesRuntimeTool(
  contribution: OfficialPluginToolContribution,
  runtimeTool: OfficialPluginRuntimeToolDescriptor,
): boolean {
  if (contribution.dynamic || contribution.name !== runtimeTool.name) return false;
  if (runtimeTool.source === undefined || runtimeTool.source === 'official') return true;
  return (
    contribution.runtimeSources !== undefined &&
    contribution.runtimeSources.includes(runtimeTool.source as OfficialPluginRuntimeToolSource)
  );
}

function dynamicContributionMatchesRuntimeTool(
  contribution: OfficialPluginToolContribution,
  runtimeTool: OfficialPluginRuntimeToolDescriptor,
): boolean {
  if (!contribution.dynamic) return false;
  if (contribution.runtimeSources && contribution.runtimeSources.length > 0) {
    return (
      runtimeTool.source !== undefined &&
      contribution.runtimeSources.includes(runtimeTool.source as OfficialPluginRuntimeToolSource)
    );
  }
  if (contribution.name.endsWith('*')) return runtimeTool.name.startsWith(contribution.name.slice(0, -1));
  return false;
}

function assertPermission(
  permissionById: Map<string, OfficialPluginPermission>,
  permissionId: string,
  pluginId: string,
): OfficialPluginPermission {
  const permission = permissionById.get(permissionId);
  if (!permission) throw new Error(`Tool references unknown permission ${permissionId} in ${pluginId}.`);
  return permission;
}

function toToolPermissionSnapshot(
  permission: OfficialPluginPermission,
): OfficialPluginAgentToolPermission['permissions'][number] {
  return {
    id: permission.id,
    title: permission.title,
    risk: permission.risk,
    readonly: permission.readonly,
    resourceScopes: [...permission.resourceScopes],
    approvalPolicy: permission.approvalPolicy,
    networkAccess: permission.networkAccess,
    processAccess: permission.processAccess,
    secretKinds: [...permission.secretKinds],
    auditLevel: permission.auditLevel,
  };
}

function optionalStringProperty(value: object, key: string): string | undefined {
  const property = (value as Record<string, unknown>)[key];
  return typeof property === 'string' ? property : undefined;
}
