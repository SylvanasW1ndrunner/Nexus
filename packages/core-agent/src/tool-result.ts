import type {
  AgentToolAuditEvidence,
  AgentToolCompletionEvidence,
  AgentToolResultEnvelope,
} from './types.js';

const AGENT_TOOL_RESULT_ENVELOPE = 'schemanaut.agent-tool-result.v1';

export function createAgentToolResultEnvelope(input: {
  modelProjection: unknown;
  userProjection?: unknown;
  durableSummary: unknown;
  auditEvidence?: AgentToolAuditEvidence;
  completionEvidence?: AgentToolCompletionEvidence;
}): AgentToolResultEnvelope {
  return {
    type: AGENT_TOOL_RESULT_ENVELOPE,
    modelProjection: input.modelProjection,
    ...(input.userProjection === undefined ? {} : { userProjection: input.userProjection }),
    durableSummary: input.durableSummary,
    ...(input.auditEvidence === undefined ? {} : { auditEvidence: input.auditEvidence }),
    ...(input.completionEvidence === undefined
      ? {}
      : { completionEvidence: input.completionEvidence }),
  };
}

export function readAgentToolResultEnvelope(
  value: AgentToolResultEnvelope,
): AgentToolResultEnvelope {
  if (!isAgentToolResultEnvelope(value)) {
    throw new Error('Invalid Agent tool result envelope.');
  }
  return value;
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
