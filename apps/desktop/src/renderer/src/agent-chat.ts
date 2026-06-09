export type AgentMessage = {
  id: string;
  role: 'assistant' | 'user';
  content: string;
};

export type AgentConversation = {
  id: string;
  title: string;
  messages: AgentMessage[];
  updatedAt: number;
};

export function createWelcomeMessage(content: string): AgentMessage {
  return {
    id: 'welcome',
    role: 'assistant',
    content,
  };
}

export function buildConversationTitle(messages: AgentMessage[], fallback: string): string {
  const firstUserMessage = messages.find((message) => message.role === 'user' && message.content.trim());
  const source = firstUserMessage?.content.trim() || fallback;
  return source.length > 32 ? `${source.slice(0, 32)}...` : source;
}

export function archiveConversation(
  history: AgentConversation[],
  messages: AgentMessage[],
  fallbackTitle: string,
  now: number,
): AgentConversation[] {
  const hasUserContent = messages.some((message) => message.role === 'user' && message.content.trim());
  if (!hasUserContent) return history;
  const conversation: AgentConversation = {
    id: `conversation-${now}`,
    title: buildConversationTitle(messages, fallbackTitle),
    messages,
    updatedAt: now,
  };
  return [conversation, ...history].slice(0, 20);
}
