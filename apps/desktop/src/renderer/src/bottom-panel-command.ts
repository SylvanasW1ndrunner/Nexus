import type { BottomPanelId } from './bottom-panel.js';

export type BottomPanelCommandAction =
  | { type: 'show-panel'; panel: BottomPanelId }
  | { type: 'open-terminal' }
  | { type: 'unbound' };

const bottomPanelCommands: Record<string, BottomPanelCommandAction> = {
  'core.showProblems': { type: 'show-panel', panel: 'problems' },
  'core.showResults': { type: 'show-panel', panel: 'results' },
  'core.showTerminal': { type: 'open-terminal' },
  'core.showPorts': { type: 'show-panel', panel: 'ports' },
};

export function resolveBottomPanelCommandAction(commandId: string): BottomPanelCommandAction {
  return bottomPanelCommands[commandId] ?? { type: 'unbound' };
}
