import { describe, expect, it } from 'vitest';
import { agentPanelActions } from './agent-panel.js';

describe('agent panel shell', () => {
  it('keeps the right sidebar header to one Agent surface with three actions', () => {
    expect(agentPanelActions()).toEqual([
      { id: 'history', icon: 'history', labelKey: 'conversationHistory' },
      { id: 'settings', icon: 'settings', labelKey: 'agentPanelSettings' },
      { id: 'new-conversation', icon: 'new-chat', labelKey: 'newConversation' },
    ]);
  });
});
