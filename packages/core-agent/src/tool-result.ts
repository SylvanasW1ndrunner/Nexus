import type { AgentToolCompletionEvidence, AgentToolResultEnvelope } from './types.js';

const AGENT_TOOL_RESULT_ENVELOPE = 'schemanaut.agent-tool-result.v1';

export function createAgentToolResultEnvelope(input: {
  modelProjection: unknown;
  durableSummary: unknown;
  completionEvidence?: AgentToolCompletionEvidence;
}): AgentToolResultEnvelope {
  return {
    type: AGENT_TOOL_RESULT_ENVELOPE,
    modelProjection: input.modelProjection,
    durableSummary: input.durableSummary,
    ...(input.completionEvidence === undefined
      ? {}
      : { completionEvidence: input.completionEvidence }),
  };
}

export function isAgentToolResultEnvelope(value: unknown): value is AgentToolResultEnvelope {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as { type?: unknown }).type === AGENT_TOOL_RESULT_ENVELOPE &&
    Object.hasOwn(value, 'modelProjection') &&
    Object.hasOwn(value, 'durableSummary')
  );
}
