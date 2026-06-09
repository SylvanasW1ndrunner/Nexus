import type { TranslationKey } from './i18n.js';

export type TerminalActionId = 'new' | 'split' | 'clear' | 'close' | 'toggle-maximize';

export type TerminalActionItem = {
  id: TerminalActionId;
  labelKey: TranslationKey;
  enabled: boolean;
};

export function buildTerminalActionMenu(input: { hasActiveTerminal: boolean; maximized: boolean }): TerminalActionItem[] {
  return [
    { id: 'new', labelKey: 'newTerminal', enabled: true },
    { id: 'split', labelKey: 'splitTerminal', enabled: input.hasActiveTerminal },
    { id: 'clear', labelKey: 'clear', enabled: input.hasActiveTerminal },
    { id: 'close', labelKey: 'close', enabled: input.hasActiveTerminal },
    { id: 'toggle-maximize', labelKey: input.maximized ? 'restorePanel' : 'maximizePanel', enabled: true },
  ];
}
