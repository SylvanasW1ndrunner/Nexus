import type {
  AgentToolSource,
  ToolDangerLevel,
  ToolRegistry,
} from '@dbagent/core-agent';

export type RuntimeToolDescriptor = {
  name: string;
  dangerLevel: ToolDangerLevel;
  readonly?: boolean;
  source?: AgentToolSource;
  sourceId?: string;
  originalName?: string;
};

export type RuntimeToolPolicyOptions = {
  runtimeTools?: RuntimeToolDescriptor[];
  toolRegistry?: Pick<ToolRegistry, 'list'>;
  skillAllowedTools?: string[];
  disabledToolNames?: string[];
  maximumDangerLevel?: ToolDangerLevel;
  readonlyOnly?: boolean;
  allowedSources?: AgentToolSource[];
};

export type RuntimeToolBlockReason =
  | 'disabled'
  | 'danger-level'
  | 'readonly-required'
  | 'source-not-allowed'
  | 'runtime-tool-missing'
  | 'skill-tool-not-allowed';

export type RuntimeToolBlockDetail = {
  toolName: string;
  blockedBy: 'runtime-policy' | 'skill';
  reason: RuntimeToolBlockReason;
  message: string;
  runtime?: RuntimeToolDescriptor;
};

export type RuntimeToolPermission = RuntimeToolDescriptor & {
  approvalRequired: boolean;
};

export type RuntimeToolPolicy = {
  agentAllowedToolNames: string[];
  runtimeAllowedToolNames: string[];
  blockedByPolicyToolNames: string[];
  blockedByPolicyToolDetails: RuntimeToolBlockDetail[];
  blockedBySkillToolNames: string[];
  blockedBySkillToolDetails: RuntimeToolBlockDetail[];
  toolPermissions: RuntimeToolPermission[];
};

const dangerRank: Record<ToolDangerLevel, number> = {
  safe: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export function resolveRuntimeToolPolicy(
  options: RuntimeToolPolicyOptions,
): RuntimeToolPolicy {
  const descriptors = resolveDescriptors(options);
  assertUnique(descriptors.map((tool) => tool.name), 'runtime tool');
  if (options.skillAllowedTools) assertUnique(options.skillAllowedTools, 'Skill tool');

  const disabled = new Set(options.disabledToolNames ?? []);
  const allowedSources = options.allowedSources ? new Set(options.allowedSources) : undefined;
  const maximumDanger = dangerRank[options.maximumDangerLevel ?? 'critical'];
  const blockedByPolicyToolDetails: RuntimeToolBlockDetail[] = [];
  const runtimeAllowed: RuntimeToolDescriptor[] = [];

  for (const tool of descriptors) {
    const detail = policyBlock(tool, {
      disabled,
      ...(allowedSources === undefined ? {} : { allowedSources }),
      maximumDanger,
      readonlyOnly: options.readonlyOnly === true,
    });
    if (detail) blockedByPolicyToolDetails.push(detail);
    else runtimeAllowed.push(tool);
  }

  const runtimeAllowedNames = new Set(runtimeAllowed.map((tool) => tool.name));
  const runtimeByName = new Map(descriptors.map((tool) => [tool.name, tool]));
  const skillAllowed = options.skillAllowedTools
    ? new Set(options.skillAllowedTools)
    : undefined;
  const agentAllowedToolNames = skillAllowed
    ? options.skillAllowedTools!.filter((name) => runtimeAllowedNames.has(name))
    : runtimeAllowed.map((tool) => tool.name);
  const blockedBySkillToolDetails: RuntimeToolBlockDetail[] = [];

  if (skillAllowed) {
    for (const name of options.skillAllowedTools ?? []) {
      if (!runtimeAllowedNames.has(name) && !blockedByPolicyToolDetails.some((detail) => detail.toolName === name)) {
        blockedBySkillToolDetails.push({
          toolName: name,
          blockedBy: 'skill',
          reason: 'runtime-tool-missing',
          message: `Skill declares tool "${name}", but it is not registered in the runtime.`,
        });
      }
    }
    for (const tool of runtimeAllowed) {
      if (!skillAllowed.has(tool.name)) {
        blockedBySkillToolDetails.push({
          toolName: tool.name,
          blockedBy: 'skill',
          reason: 'skill-tool-not-allowed',
          message: `Runtime tool "${tool.name}" is not declared by the selected Skill.`,
          runtime: tool,
        });
      }
    }
  }

  const agentAllowed = new Set(agentAllowedToolNames);
  return {
    agentAllowedToolNames,
    runtimeAllowedToolNames: runtimeAllowed.map((tool) => tool.name),
    blockedByPolicyToolNames: blockedByPolicyToolDetails.map((detail) => detail.toolName),
    blockedByPolicyToolDetails,
    blockedBySkillToolNames: blockedBySkillToolDetails.map((detail) => detail.toolName),
    blockedBySkillToolDetails,
    toolPermissions: agentAllowedToolNames.map((name) => {
      const tool = runtimeByName.get(name)!;
      return {
        ...tool,
        approvalRequired: tool.readonly !== true || dangerRank[tool.dangerLevel] >= dangerRank.medium,
      };
    }).filter((tool) => agentAllowed.has(tool.name)),
  };
}

export function runtimeToolsFromRegistry(
  registry: Pick<ToolRegistry, 'list'>,
): RuntimeToolDescriptor[] {
  return registry.list().map((tool) => ({
    name: tool.name,
    dangerLevel: tool.dangerLevel,
    ...(tool.readonly === undefined ? {} : { readonly: tool.readonly }),
    ...(tool.source === undefined ? {} : { source: tool.source }),
    ...(tool.sourceId === undefined ? {} : { sourceId: tool.sourceId }),
    ...(tool.originalName === undefined ? {} : { originalName: tool.originalName }),
  }));
}

function resolveDescriptors(options: RuntimeToolPolicyOptions): RuntimeToolDescriptor[] {
  if ((options.runtimeTools === undefined) === (options.toolRegistry === undefined)) {
    throw new Error('Provide exactly one of runtimeTools or toolRegistry.');
  }
  return options.runtimeTools ?? runtimeToolsFromRegistry(options.toolRegistry!);
}

function policyBlock(
  tool: RuntimeToolDescriptor,
  policy: {
    disabled: Set<string>;
    allowedSources?: Set<AgentToolSource>;
    maximumDanger: number;
    readonlyOnly: boolean;
  },
): RuntimeToolBlockDetail | undefined {
  if (policy.disabled.has(tool.name)) {
    return blocked(tool, 'disabled', `Tool "${tool.name}" is disabled by runtime policy.`);
  }
  if (dangerRank[tool.dangerLevel] > policy.maximumDanger) {
    return blocked(tool, 'danger-level', `Tool "${tool.name}" exceeds the allowed danger level.`);
  }
  if (policy.readonlyOnly && tool.readonly !== true) {
    return blocked(tool, 'readonly-required', `Tool "${tool.name}" is not declared readonly.`);
  }
  if (policy.allowedSources && (!tool.source || !policy.allowedSources.has(tool.source))) {
    return blocked(tool, 'source-not-allowed', `Tool "${tool.name}" comes from a disallowed source.`);
  }
  return undefined;
}

function blocked(
  runtime: RuntimeToolDescriptor,
  reason: RuntimeToolBlockReason,
  message: string,
): RuntimeToolBlockDetail {
  return { toolName: runtime.name, blockedBy: 'runtime-policy', reason, message, runtime };
}

function assertUnique(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`Duplicate ${label}: ${value}`);
    seen.add(value);
  }
}
