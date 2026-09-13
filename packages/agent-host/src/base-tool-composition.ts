import {
  BASE_TOOL_MANIFEST,
  type ToolInvocationContribution,
  type ToolRegistry,
} from '@dbagent/core-agent';

/**
 * Host-owned composition boundary for the invariant first-turn Tool surface.
 *
 * Callers must supply every canonical contribution in manifest order. A
 * backend that is unavailable still supplies its own canonical descriptor and
 * an unavailable runtime payload; this layer never invents a generic schema
 * or replaces a Tool independently.
 */
export function publishHostBaseToolGeneration(
  registry: ToolRegistry,
  contributions: readonly ToolInvocationContribution[],
): void {
  if (contributions.length !== BASE_TOOL_MANIFEST.length) {
    throw new TypeError(
      `Host baseline requires ${BASE_TOOL_MANIFEST.length} canonical Tool contributions.`,
    );
  }
  for (const [index, manifest] of BASE_TOOL_MANIFEST.entries()) {
    if (contributions[index]?.definition.name !== manifest.name) {
      throw new TypeError(`Host baseline entry ${index} must be ${manifest.name}.`);
    }
  }
  registry.publishBaselineInvocations(contributions);
}
