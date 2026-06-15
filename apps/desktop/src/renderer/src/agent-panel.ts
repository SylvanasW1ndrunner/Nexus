export type AgentPanelActionId = 'history' | 'settings' | 'new-conversation';

export type AgentPanelAction = {
  id: AgentPanelActionId;
  icon: 'history' | 'settings' | 'new-chat';
  labelKey: 'conversationHistory' | 'agentPanelSettings' | 'newConversation';
};

export function agentPanelActions(): AgentPanelAction[] {
  return [
    { id: 'history', icon: 'history', labelKey: 'conversationHistory' },
    { id: 'settings', icon: 'settings', labelKey: 'agentPanelSettings' },
    { id: 'new-conversation', icon: 'new-chat', labelKey: 'newConversation' },
  ];
}
