import type { LlmProviderProtocolProfile, LlmTool } from '@dbagent/core-llm';
import type { ToolRegistry } from './tool-registry.js';
import type { AgentToolActivation, AgentToolDescriptor } from './types.js';

export type ToolDiscoveryMode = 'client' | 'native' | 'disabled';

export type ToolExposurePlan = {
  catalogRevision: number;
  discoveryMode: ToolDiscoveryMode;
  modelTools: LlmTool[];
  nativeDeferredTools: LlmTool[];
  discoverable: AgentToolDescriptor[];
};

export type ToolExposurePlanInput = {
  registry: ToolRegistry;
  allowedTools?: readonly string[];
  pinnedTools?: readonly string[];
  activations?: readonly AgentToolActivation[];
  checkpointSequence?: number;
  taskPhase?: string;
  dynamicDiscovery?: boolean;
  providerProfile?: LlmProviderProtocolProfile;
  preferNativeDeferredTools?: boolean;
  maxDirectSchemaChars?: number;
};

export class ToolExposurePlanner {
  plan(input: ToolExposurePlanInput): ToolExposurePlan {
    const allowed =
      input.allowedTools === undefined ? undefined : new Set(input.allowedTools);
    const pinned = new Set(input.pinnedTools ?? []);
    const dynamicDiscovery = input.dynamicDiscovery !== false;
    const descriptors = input.registry
      .listDescriptors()
      .filter((tool) => allowed === undefined || allowed.has(tool.flatName))
      .filter((tool) => tool.exposure !== 'disabled');
    const discoverable = descriptors.filter((tool) => tool.exposure === 'deferred');
    const validActivations = new Set(
      (input.activations ?? [])
        .filter(
          (activation) =>
            activation.catalogRevision === input.registry.catalogRevision &&
            activation.checkpointSequence === input.checkpointSequence &&
            activation.taskPhase === input.taskPhase,
        )
        .map((activation) => activation.toolName),
    );

    const nativeDeferred =
      dynamicDiscovery &&
      input.preferNativeDeferredTools === true &&
      input.providerProfile?.capabilities.nativeDeferredTools === 'supported';
    const discoveryMode: ToolDiscoveryMode = !dynamicDiscovery
      ? 'disabled'
      : nativeDeferred
        ? 'native'
        : 'client';

    const directCandidates = descriptors.filter((tool) => {
      if (tool.exposure === 'hidden') return false;
      if (tool.exposure === 'direct' || pinned.has(tool.flatName)) return true;
      if (!dynamicDiscovery) return tool.exposure === 'deferred';
      return validActivations.has(tool.flatName);
    });
    const direct = applySchemaBudget(
      directCandidates,
      pinned,
      input.maxDirectSchemaChars ?? Number.POSITIVE_INFINITY,
    );

    return {
      catalogRevision: input.registry.catalogRevision,
      discoveryMode,
      modelTools: direct.map(toLlmTool),
      nativeDeferredTools: nativeDeferred ? discoverable.map(toLlmTool) : [],
      discoverable,
    };
  }
}

function applySchemaBudget(
  descriptors: AgentToolDescriptor[],
  pinned: ReadonlySet<string>,
  maxChars: number,
): AgentToolDescriptor[] {
  let consumed = 0;
  const selected: AgentToolDescriptor[] = [];
  for (const descriptor of descriptors) {
    const size = JSON.stringify({
      name: descriptor.flatName,
      description: descriptor.description,
      inputSchema: descriptor.inputSchema,
      outputSchema: descriptor.outputSchema,
    }).length;
    if (pinned.has(descriptor.flatName) || consumed + size <= maxChars) {
      selected.push(descriptor);
      consumed += size;
    }
  }
  return selected;
}

function toLlmTool(tool: AgentToolDescriptor): LlmTool {
  return {
    name: tool.flatName,
    ...(tool.id.namespace === undefined ? {} : { namespace: tool.id.namespace }),
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
  };
}
