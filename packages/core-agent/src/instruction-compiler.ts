import type { LlmMessage } from '@dbagent/core-llm';
import { renderAgentTaskPlanContext } from './task-plan.js';
import type {
  AgentRunOptions,
  AgentSession,
  AgentSkillCatalogEntry,
  AgentSystemPrompt,
} from './types.js';

export const AGENT_RUNTIME_PROTOCOL_INSTRUCTIONS = [
  'Use the provider tool-calling protocol for actions; never print tool-call markup as ordinary text.',
  'Treat tool results as evidence. Never claim that an external action succeeded unless the Runtime returned a successful result.',
  'Host permissions, allowed-tool policy, cancellation, timeouts and execution ordering are enforced by the Runtime.',
  'Use tool_search when the currently visible tools do not cover a needed capability.',
  'Large results remain in result, process or artifact stores. Read only the bounded projection needed for the next decision.',
].join('\n');

export const DEFAULT_AGENT_ROLE_INSTRUCTIONS = [
  'You are SchemaNaut, a general-purpose agent with optional professional capability packages.',
  'Understand the user goal, inspect real facts through available tools, choose a practical path, act, observe the result, and adjust until the requested outcome is genuinely delivered.',
  'Use a concise working plan only when it helps multi-step execution. Plans guide work; actual tool outcomes determine completion.',
  'Explore autonomously when information is missing, but do not repeat an unchanged action after it produced the same observation.',
  'After a successful deliverable action, compare its evidence with the user goal. Continue only for a concrete unmet requirement; otherwise finalize. Verification should test a specific uncertainty instead of restarting broad exploration.',
  'Use files, processes, web, databases, MCP services, Skills and sub-agents according to the capabilities available in this run.',
  'Keep user-facing progress and final answers useful and concise. Do not expose hidden reasoning or internal catalog/index/checkpoint state.',
].join('\n');

export type CompileAgentInstructionsInput = {
  session: AgentSession;
  systemPrompt?: AgentSystemPrompt;
  managedInstructions?: readonly string[];
  capabilityInstructions?: readonly string[];
  projectInstructions?: string;
  preferenceMessages?: readonly LlmMessage[];
  skillCatalog?: readonly AgentSkillCatalogEntry[];
  maxSkillCatalogChars?: number;
};

export function compileAgentInstructions(input: CompileAgentInstructionsInput): LlmMessage[] {
  const customPrompt = normalizeSystemPrompt(input.systemPrompt);
  const role = customPrompt?.mode === 'replace' ? customPrompt.content : DEFAULT_AGENT_ROLE_INSTRUCTIONS;
  const messages: LlmMessage[] = [
    systemLayer('runtime_protocol', AGENT_RUNTIME_PROTOCOL_INSTRUCTIONS),
    systemLayer('agent_role', role),
  ];
  pushInstructionList(messages, 'managed_policy', input.managedInstructions);
  pushInstructionList(messages, 'capability_instructions', input.capabilityInstructions);
  if (customPrompt?.mode === 'append') {
    messages.push(systemLayer('user_system_instructions', customPrompt.content));
  }
  if (input.projectInstructions?.trim()) {
    messages.push(systemLayer('project_instructions', input.projectInstructions.trim()));
  }
  messages.push(...(input.preferenceMessages ?? []).map((message) => ({ ...message })));

  const catalog = renderSkillCatalog(input.skillCatalog ?? [], input.maxSkillCatalogChars ?? 12_000);
  if (catalog) messages.push(systemLayer('available_skills', catalog));
  for (const skill of input.session.activeSkills ?? []) {
    messages.push({
      role: 'system',
      content: [
        `<activated_skill name="${xmlAttribute(skill.name)}" scope="${xmlAttribute(skill.scope)}">`,
        skill.instructions,
        '</activated_skill>',
      ].join('\n'),
    });
  }
  const plan = renderAgentTaskPlanContext(input.session.taskPlan);
  if (plan) messages.push({ role: 'system', content: plan });
  return messages;
}

export function instructionOptionsFromRun(
  options: AgentRunOptions,
): Pick<
  CompileAgentInstructionsInput,
  | 'systemPrompt'
  | 'managedInstructions'
  | 'capabilityInstructions'
  | 'projectInstructions'
  | 'skillCatalog'
> {
  return {
    ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
    ...(options.managedInstructions === undefined
      ? {}
      : { managedInstructions: options.managedInstructions }),
    ...(options.capabilityInstructions === undefined
      ? {}
      : { capabilityInstructions: options.capabilityInstructions }),
    ...(options.projectInstructions === undefined
      ? {}
      : { projectInstructions: options.projectInstructions }),
    ...(options.skillCatalog === undefined ? {} : { skillCatalog: options.skillCatalog }),
  };
}

function normalizeSystemPrompt(value: AgentSystemPrompt | undefined): AgentSystemPrompt | undefined {
  if (!value) return undefined;
  const content = value.content.trim();
  if (!content) throw new Error('Agent system prompt content is required.');
  return { mode: value.mode, content };
}

function systemLayer(name: string, content: string): LlmMessage {
  return { role: 'system', content: `<${name}>\n${content}\n</${name}>` };
}

function pushInstructionList(
  messages: LlmMessage[],
  name: string,
  values: readonly string[] | undefined,
): void {
  const content = (values ?? []).map((value) => value.trim()).filter(Boolean).join('\n');
  if (content) messages.push(systemLayer(name, content));
}

function renderSkillCatalog(catalog: readonly AgentSkillCatalogEntry[], maxChars: number): string {
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 12_000;
  const lines: string[] = [];
  let chars = 0;
  for (const skill of catalog) {
    const line = `- ${skill.name} [${skill.scope}]: ${skill.description}`;
    if (lines.length > 0 && chars + line.length + 1 > limit) break;
    lines.push(line.slice(0, Math.max(0, limit - chars)));
    chars += line.length + 1;
  }
  return lines.join('\n');
}

function xmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .slice(0, 200);
}
