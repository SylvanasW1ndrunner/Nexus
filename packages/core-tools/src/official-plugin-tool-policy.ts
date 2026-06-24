import type { ToolRegistry } from '@dbagent/core-agent';
import {
  createDefaultOfficialPluginRegistry,
  type OfficialPluginRegistry,
  type OfficialPluginRuntimeToolDescriptor,
  type OfficialPluginRuntimeToolResolution,
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
  runtimeResolution: OfficialPluginRuntimeToolResolution;
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
    return {
      agentAllowedToolNames: pluginAllowedToolNames,
      pluginAllowedToolNames,
      blockedByPluginToolNames: [],
      blockedBySkillToolNames: [],
      runtimeResolution,
    };
  }

  assertUniqueNames(skillAllowedTools, 'skill allowed tool');
  const pluginAllowed = new Set(pluginAllowedToolNames);
  const skillAllowed = new Set(skillAllowedTools);

  return {
    agentAllowedToolNames: skillAllowedTools.filter((toolName) => pluginAllowed.has(toolName)),
    pluginAllowedToolNames,
    blockedByPluginToolNames: skillAllowedTools.filter((toolName) => !pluginAllowed.has(toolName)),
    blockedBySkillToolNames: pluginAllowedToolNames.filter((toolName) => !skillAllowed.has(toolName)),
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

function optionalStringProperty(value: object, key: string): string | undefined {
  const property = (value as Record<string, unknown>)[key];
  return typeof property === 'string' ? property : undefined;
}
