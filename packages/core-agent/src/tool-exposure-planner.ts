import type { LlmTool } from '@dbagent/core-llm';
import type { ToolCatalogSnapshot, ToolRegistry } from './tool-registry.js';
import type { AgentToolDescriptor } from './types.js';
import type { RuntimeToolActivation } from './kernel/runtime-command.js';
import { BASE_TOOL_MANIFEST, isBaseToolName } from './base-tool-manifest.js';

export type ToolDiscoveryMode = 'client';

export type ToolExposurePlan = {
  catalogRevision: number;
  discoveryMode: ToolDiscoveryMode;
  modelTools: LlmTool[];
  discoverable: AgentToolDescriptor[];
  /** Complete searchable catalog for this Turn, excluding hidden/disabled Tools. */
  catalog: AgentToolDescriptor[];
};

export type ToolExposurePlanInput = {
  registry: Pick<
    ToolRegistry | ToolCatalogSnapshot,
    'catalogRevision' | 'listDescriptors'
  >;
  allowedTools?: readonly string[];
  /** Durable activations projected before this Turn was captured. */
  activeTools?: readonly RuntimeToolActivation[];
  /**
   * Exact active Skill frontmatter activation set captured for this Turn.
   * When present, it constrains the already exact-activated deferred Tool set;
   * it neither promotes deferred Tools nor hides direct Tools.
  */
  skillAllowedTools?: readonly string[];
  maxDirectSchemaChars?: number;
};

export class ToolExposurePlanner {
  plan(input: ToolExposurePlanInput): ToolExposurePlan {
    const allowed = input.allowedTools === undefined ? undefined : new Set(input.allowedTools);
    const active = new Map(
      (input.activeTools ?? []).map((activation) => [activation.name, activation]),
    );
    const skillAllowed = new Set(input.skillAllowedTools ?? []);
    const allDescriptors = input.registry.listDescriptors();
    const baseline = BASE_TOOL_MANIFEST.flatMap(({ name, schemaRevision }) => {
      const descriptor = allDescriptors.find((tool) => tool.flatName === name);
      if (descriptor === undefined) throw new Error(`Runtime baseline Tool is missing: ${name}`);
      if (descriptor.exposure !== 'direct' || descriptor.toolRevision !== schemaRevision) {
        throw new Error(`Runtime baseline Tool revision/exposure is invalid: ${name}`);
      }
      return [descriptor];
    });
    const descriptors = allDescriptors
      .filter((tool) => !isBaseToolName(tool.flatName))
      .filter((tool) => allowed === undefined || allowed.has(tool.flatName))
      .filter((tool) => tool.exposure !== 'disabled');
    const discoverable = descriptors.filter((tool) => tool.exposure === 'deferred');
    const catalog = [...baseline, ...descriptors.filter((tool) => tool.exposure !== 'hidden')];
    const discoveryMode: ToolDiscoveryMode = 'client';

    const directCandidates = descriptors.filter((tool) => {
      if (tool.exposure === 'hidden') return false;
      if (tool.exposure === 'direct') return true;
      const durableActivation = active.get(tool.flatName);
      const exactlyActivated = (
        durableActivation?.toolRevision === tool.toolRevision &&
        durableActivation.handlerRevision === tool.handlerRevision
      );
      return exactlyActivated && (
        input.skillAllowedTools === undefined || skillAllowed.has(tool.flatName)
      );
    });
    const direct = applySchemaBudget(
      directCandidates,
      input.maxDirectSchemaChars ?? Number.POSITIVE_INFINITY,
    );

    return {
      catalogRevision: input.registry.catalogRevision,
      discoveryMode,
      modelTools: [...baseline, ...direct].map(toLlmTool),
      discoverable,
      catalog,
    };
  }
}

function applySchemaBudget(
  descriptors: AgentToolDescriptor[],
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
    if (consumed + size <= maxChars) {
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
