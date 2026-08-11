import type { ModelContentBlock } from '@dbagent/core-llm';
import type { AgentEvent } from '../events/agent-event.js';

export type ModelEventProjection = readonly ModelContentBlock[];

/**
 * Projects durable Host facts into semantic Model input. It deliberately has no
 * raw-event fallback: adding a Model-visible fact requires an explicit safe mapping.
 */
export function projectAgentEventForModel(event: AgentEvent): ModelEventProjection | null {
  switch (event.type) {
    case 'turn.no_progress':
      return textProjection(
        'Observation: the previous committed turn produced no new committed evidence.',
      );
    case 'plan.created':
    case 'plan.updated':
      return textProjection(`Current task plan: ${JSON.stringify(event.payload.plan)}`);
    default:
      return null;
  }
}

function textProjection(text: string): ModelEventProjection {
  return Object.freeze([Object.freeze({ type: 'text' as const, text })]);
}
