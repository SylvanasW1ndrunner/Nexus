import type { LlmMessage, LlmUsage } from '@dbagent/core-llm';
import type { AgentMessage, AgentMessageDraft, AgentSession } from './types.js';

export function createAgentSession(input: {
  id: string;
  title: string;
  mode: AgentSession['mode'];
  userId?: string;
  knowledgeSnapshot?: AgentSession['knowledgeSnapshot'];
  project?: AgentSession['project'];
  activeSkills?: AgentSession['activeSkills'];
  sessionSkills?: AgentSession['sessionSkills'];
  subagentDepth?: number;
  now: () => string;
}): AgentSession {
  return {
    id: input.id,
    title: input.title,
    ...(input.userId === undefined ? {} : { userId: input.userId }),
    mode: input.mode,
    messages: [],
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    ...(input.project === undefined ? {} : { project: structuredClone(input.project) }),
    ...(input.activeSkills === undefined
      ? {}
      : { activeSkills: structuredClone(input.activeSkills) }),
    ...(input.sessionSkills === undefined
      ? {}
      : { sessionSkills: structuredClone(input.sessionSkills) }),
    ...(input.knowledgeSnapshot === undefined
      ? {}
      : { knowledgeSnapshot: structuredClone(input.knowledgeSnapshot) }),
    ...(input.subagentDepth === undefined ? {} : { subagentDepth: input.subagentDepth }),
    aborted: false,
  };
}

export function appendMessage(session: AgentSession, message: AgentMessage): void {
  session.messages.push(message);
}

export function createMessage(message: AgentMessageDraft, now: () => string): AgentMessage {
  return { ...message, createdAt: now() };
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

/**
 * Creates an independent child Session from the parent's durable working
 * context. Runtime system messages, task plans, tool activations, result
 * handles and artifacts are intentionally not shared.
 */
export function forkAgentSessionForSubagent(input: {
  parent: AgentSession;
  id: string;
  title: string;
  depth: number;
  now: () => string;
}): AgentSession {
  const checkpoint = input.parent.contextCheckpoint;
  let seenConversationMessages = 0;
  const recentMessages = input.parent.messages.filter((message) => {
    if (message.role === 'system') return false;
    seenConversationMessages += 1;
    return (
      checkpoint === undefined ||
      seenConversationMessages > checkpoint.coveredConversationMessageCount
    );
  });
  const messages: AgentMessage[] = [];
  if (checkpoint?.summary.trim()) {
    messages.push(
      createMessage(
        {
          role: 'system',
          content: `Forked parent context checkpoint:\n${checkpoint.summary.trim()}`,
        },
        input.now,
      ),
    );
  }
  messages.push(...structuredClone(recentMessages));
  return {
    id: input.id,
    title: input.title,
    ...(input.parent.userId === undefined ? {} : { userId: input.parent.userId }),
    mode: input.parent.mode,
    messages,
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    ...(input.parent.project === undefined
      ? {}
      : { project: structuredClone(input.parent.project) }),
    ...(input.parent.activeSkills === undefined
      ? {}
      : { activeSkills: structuredClone(input.parent.activeSkills) }),
    ...(input.parent.sessionSkills === undefined
      ? {}
      : { sessionSkills: structuredClone(input.parent.sessionSkills) }),
    ...(input.parent.knowledgeSnapshot === undefined
      ? {}
      : { knowledgeSnapshot: structuredClone(input.parent.knowledgeSnapshot) }),
    subagentDepth: input.depth,
    aborted: false,
  };
}
