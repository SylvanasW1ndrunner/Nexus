import { describe, expect, it } from 'vitest';
import { archiveConversation, buildConversationTitle, createWelcomeMessage, type AgentMessage } from './agent-chat.js';

describe('agent chat state helpers', () => {
  it('builds a concise title from the first user message', () => {
    const messages: AgentMessage[] = [
      createWelcomeMessage('ready'),
      {
        id: 'user-1',
        role: 'user',
        content: '分析最近 30 天订单退款率和渠道变化趋势',
      },
    ];

    expect(buildConversationTitle(messages, '新对话')).toBe('分析最近 30 天订单退款率和渠道变化趋势');
  });

  it('archives only conversations with user content', () => {
    expect(archiveConversation([], [createWelcomeMessage('ready')], '新对话', 100)).toEqual([]);

    const archived = archiveConversation(
      [],
      [
        createWelcomeMessage('ready'),
        { id: 'user-1', role: 'user', content: '检查慢 SQL' },
      ],
      '新对话',
      100,
    );

    expect(archived).toHaveLength(1);
    expect(archived[0]?.id).toBe('conversation-100');
    expect(archived[0]?.title).toBe('检查慢 SQL');
  });

  it('keeps the newest twenty archived conversations', () => {
    const history = Array.from({ length: 20 }, (_, index) => ({
      id: `old-${index}`,
      title: `old-${index}`,
      messages: [{ id: `message-${index}`, role: 'user' as const, content: `old-${index}` }],
      updatedAt: index,
    }));

    const archived = archiveConversation(history, [{ id: 'user-new', role: 'user', content: '新的问题' }], '新对话', 1000);

    expect(archived).toHaveLength(20);
    expect(archived[0]?.title).toBe('新的问题');
    expect(archived.some((conversation) => conversation.id === 'old-19')).toBe(false);
  });
});
