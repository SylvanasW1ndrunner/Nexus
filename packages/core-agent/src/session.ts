import type { LlmMessage, LlmUsage } from '@dbagent/core-llm';
import type { AgentMessage, AgentMessageDraft, AgentSession } from './types.js';

export function createAgentSession(input: {
  id: string;
  title: string;
  mode: AgentSession['mode'];
  now: () => string;
}): AgentSession {
  return {
    id: input.id,
    title: input.title,
    mode: input.mode,
    strategy: 'react',
    messages: [],
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    aborted: false,
  };
}

export function appendMessage(session: AgentSession, message: AgentMessage): void {
  session.messages.push(message);
}

export function createMessage(message: AgentMessageDraft, now: () => string): AgentMessage {
  return { ...message, createdAt: now() } as AgentMessage;
}

export function toLlmMessages(session: AgentSession): LlmMessage[] {
  return session.messages.map((message) => {
    if (message.role === 'tool') {
      return {
        role: 'tool',
        content: message.content,
        toolCallId: message.toolCallId,
      };
    }
    return {
      role: message.role,
      content: message.content,
    };
  });
}

export function addUsage(session: AgentSession, usage?: LlmUsage): void {
  if (!usage) return;
  session.tokenUsage = {
    promptTokens: session.tokenUsage.promptTokens + usage.promptTokens,
    completionTokens: session.tokenUsage.completionTokens + usage.completionTokens,
    totalTokens: session.tokenUsage.totalTokens + usage.totalTokens,
  };
}
