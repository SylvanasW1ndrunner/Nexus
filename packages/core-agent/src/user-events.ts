import { randomUUID } from 'node:crypto';
import type { AgentUserEvent, AgentUserEventDraft, AgentUserEventSink } from './types.js';

export class AgentUserEventProjector {
  constructor(
    private readonly sink?: AgentUserEventSink,
    private readonly options: {
      now?: () => string;
      createId?: () => string;
    } = {},
  ) {}

  async emit(sessionId: string, draft: AgentUserEventDraft): Promise<AgentUserEvent> {
    const event: AgentUserEvent = {
      id: this.options.createId?.() ?? randomUUID(),
      sessionId,
      type: draft.type,
      message: requireText(draft.message),
      createdAt: this.options.now?.() ?? new Date().toISOString(),
      ...(draft.toolName === undefined ? {} : { toolName: draft.toolName }),
      ...(draft.sql === undefined ? {} : { sql: draft.sql }),
      ...(draft.command === undefined ? {} : { command: draft.command }),
      ...(draft.artifact === undefined ? {} : { artifact: structuredClone(draft.artifact) }),
      ...(draft.metrics === undefined ? {} : { metrics: structuredClone(draft.metrics) }),
    };
    if (isUserRelevantAgentEvent(event)) {
      await this.sink?.(structuredClone(event));
    }
    return event;
  }
}

export function isUserRelevantAgentEvent(event: AgentUserEvent): boolean {
  return (
    event.message.trim().length > 0 &&
    !/(tool.?call.?id|catalog.?root.?hash|subtree.?hash|node.?id|retrieval.?score|action.?signature)/i.test(
      `${event.message} ${event.sql ?? ''}`,
    )
  );
}

function requireText(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error('Agent user event message is required.');
  return normalized;
}
