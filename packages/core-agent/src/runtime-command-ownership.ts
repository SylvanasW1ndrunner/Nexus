import type { RuntimeCommand } from './kernel/runtime-command.js';

/**
 * Fixed Runtime command authority by built-in Tool identity.  A sealed result
 * proves that it came through the Runtime, while this table proves that the
 * particular Tool is allowed to request the command kind.
 */
const OWNER_KINDS: Readonly<Record<string, readonly RuntimeCommand['kind'][]>> = Object.freeze({
  skill: ['skill.activate'],
  tool_search: ['discovery.activate'],
  task_plan_create: ['plan.create', 'plan.update'],
  task_update: ['plan.update'],
  subagent_spawn: ['child.start'],
  subagent_list: ['child.list'],
  subagent_wait: ['child.wait'],
  subagent_message: ['child.steer'],
  subagent_stop: ['child.cancel'],
});

export function isRuntimeCommandKindOwnedByTool(
  toolName: string,
  kind: RuntimeCommand['kind'],
): boolean {
  return OWNER_KINDS[toolName]?.includes(kind) ?? false;
}
