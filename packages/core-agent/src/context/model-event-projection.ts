import type { ModelContentBlock, ModelMessage } from '@dbagent/core-llm';
import type { PortableValue } from '@dbagent/shared';
import type { AgentEvent, AgentEventType } from '../events/agent-event.js';

export type ModelEventProjection = readonly ModelContentBlock[];

export type ModelHistoryProjectionOptions = Readonly<{
  currentRunId: string;
  includeCurrentRunOpaque?: boolean;
}>;

/**
 * The durable facts the unified history projector can consume. Keeping this
 * list beside the projector lets Journal queries skip unrelated diagnostic and
 * Host-only traffic without creating a second semantic mapping.
 */
export const MODEL_HISTORY_EVENT_TYPES = Object.freeze([
  'input.received',
  'run.steered',
  'model_attempt_committed',
  'tool.proposed',
  'tool.observed',
  'tool.outcome_resolved',
  'delivery.decided',
  'turn.closed',
  'turn.no_progress',
  'plan.created',
  'plan.updated',
] as const satisfies readonly AgentEventType[]);

/**
 * Returns the last source sequence that does not split a canonical Tool call
 * from its Observation. Incremental checkpoints may cover only this prefix.
 */
export function latestSafeModelHistorySequence(
  events: readonly AgentEvent[],
  initialSequence: number,
): number {
  const calls = new Map<string, string>();
  const pendingCallIds = new Set<string>();
  let safeSequence = initialSequence;
  for (const event of events) {
    if (event.type === 'model_attempt_committed') {
      const correlations = new Map(
        event.payload.protocolEnvelope.correlations.map((item) => [item.draftCallKey, item.callId]),
      );
      let opened = false;
      for (const block of event.payload.validatedAttempt.blocks) {
        if (block.type !== 'tool-call-draft') continue;
        const callId = correlations.get(block.draftCallKey);
        if (callId === undefined) throw new TypeError('Committed Tool draft has no call identity.');
        pendingCallIds.add(callId);
        opened = true;
      }
      if (!opened && pendingCallIds.size === 0) safeSequence = event.sequence;
      continue;
    }
    if (event.type === 'tool.proposed') {
      calls.set(event.payload.invocationId, event.payload.callId);
      continue;
    }
    if (event.type === 'tool.observed') {
      const callId = calls.get(event.payload.invocationId);
      if (callId !== undefined && event.payload.outcome !== 'unknown') {
        pendingCallIds.delete(callId);
        if (pendingCallIds.size === 0) safeSequence = event.sequence;
      }
      continue;
    }
    if (event.type === 'tool.outcome_resolved') {
      const callId = calls.get(event.payload.invocationId);
      if (callId !== undefined) pendingCallIds.delete(callId);
      if (callId !== undefined && pendingCallIds.size === 0) safeSequence = event.sequence;
      continue;
    }
    if (pendingCallIds.size === 0) safeSequence = event.sequence;
  }
  return safeSequence;
}

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
    case 'delivery.decided':
      return event.payload.outcome === 'revision-requested' &&
        event.payload.observation !== undefined
        ? textProjection(
            `Delivery revision observation: ${portableText(event.payload.observation)}`,
          )
        : null;
    default:
      return null;
  }
}

/**
 * Projects ordered committed Journal facts into the only canonical conversation history.
 * Tentative stream/protocol diagnostics and Host-only identity fields have no fallback mapping.
 */
export function projectAgentHistoryForModel(
  events: readonly AgentEvent[],
  options?: ModelHistoryProjectionOptions,
): readonly ModelMessage[] {
  const calls = new Map<string, string>();
  const resolvedInvocations = new Set(events
    .filter((event) => event.type === 'tool.outcome_resolved')
    .map((event) => event.payload.invocationId));
  const messages: ModelMessage[] = [];
  for (const event of events) {
    if (event.type === 'input.received' || event.type === 'run.steered') {
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: portableText(event.payload.content) }],
      });
      continue;
    }
    if (event.type === 'model_attempt_committed') {
      const includeOpaque =
        options?.includeCurrentRunOpaque === true &&
        event.runId === options.currentRunId;
      const correlations = new Map(
        event.payload.protocolEnvelope.correlations.map((item) => [item.draftCallKey, item.callId]),
      );
      const blocks: ModelContentBlock[] = [];
      for (const block of event.payload.validatedAttempt.blocks) {
        if (block.type === 'provider-opaque') {
          if (includeOpaque) blocks.push(structuredClone(block));
          continue;
        }
        if (
          block.type === 'reasoning-summary' &&
          block.derivedFromOpaqueRef !== undefined &&
          !includeOpaque
        ) {
          blocks.push({ type: 'reasoning-summary', text: block.text });
          continue;
        }
        if (block.type !== 'tool-call-draft') {
          blocks.push(structuredClone(block));
          continue;
        }
        const callId = correlations.get(block.draftCallKey);
        if (callId === undefined) throw new TypeError('Committed Tool draft has no call identity.');
        blocks.push({
          type: 'tool-call', callId, name: block.name, arguments: structuredClone(block.arguments),
        });
      }
      if (blocks.length > 0) messages.push({ role: 'assistant', content: blocks });
      continue;
    }
    if (event.type === 'tool.proposed') {
      calls.set(event.payload.invocationId, event.payload.callId);
      continue;
    }
    if (event.type === 'tool.observed') {
      if (
        event.payload.outcome === 'unknown' &&
        resolvedInvocations.has(event.payload.invocationId)
      ) {
        continue;
      }
      const callId = calls.get(event.payload.invocationId);
      if (callId === undefined) throw new TypeError('Tool Observation has no committed call identity.');
      const output = event.payload.modelProjection ?? {
        summary: event.payload.summary,
        evidenceRefs: event.payload.evidenceRefs,
        outcome: event.payload.outcome,
      };
      messages.push({
        role: 'tool',
        content: [{
          type: 'tool-result', callId, output: structuredClone(output),
          isError: event.payload.outcome !== 'succeeded',
        }],
      });
      continue;
    }
    if (event.type === 'tool.outcome_resolved') {
      const callId = calls.get(event.payload.invocationId);
      if (callId === undefined) {
        throw new TypeError('Resolved Tool outcome has no committed call identity.');
      }
      const output = event.payload.modelProjection ?? {
        summary: event.payload.summary,
        evidenceRefs: event.payload.evidenceRefs,
        outcome: event.payload.outcome,
      };
      messages.push({
        role: 'tool',
        content: [{
          type: 'tool-result', callId, output: structuredClone(output),
          isError: event.payload.outcome === 'failed',
        }],
      });
      continue;
    }
    const projected = projectAgentEventForModel(event);
    if (projected !== null) {
      messages.push({ role: 'user', content: projected.map((block) => structuredClone(block)) });
    }
  }
  return Object.freeze(messages.map((message) => {
    const content = message.content.map((block) => Object.freeze(structuredClone(block)));
    Object.freeze(content);
    return Object.freeze({ role: message.role, content });
  }));
}

function textProjection(text: string): ModelEventProjection {
  return Object.freeze([Object.freeze({ type: 'text' as const, text })]);
}

function portableText(value: PortableValue): string {
  if (typeof value === 'string') return value;
  const text = JSON.stringify(value);
  if (text === undefined || text.length > 256_000) {
    throw new TypeError('Agent input is not bounded semantic text.');
  }
  return text;
}
