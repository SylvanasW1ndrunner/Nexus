export type TerminalLayoutSession = {
  id: string;
};

export function selectVisibleTerminals<T extends TerminalLayoutSession>(
  terminals: T[],
  activeTerminalId: string,
  splitTerminalId: string,
): T[] {
  const activeTerminal = terminals.find((terminal) => terminal.id === activeTerminalId) ?? terminals[0];
  const splitTerminal = terminals.find((terminal) => terminal.id === splitTerminalId && terminal.id !== activeTerminal?.id);
  return [activeTerminal, splitTerminal].filter((terminal): terminal is T => Boolean(terminal));
}

export function resolveTerminalCloseState<T extends TerminalLayoutSession>(
  terminals: T[],
  closedTerminalId: string,
  activeTerminalId: string,
  splitTerminalId: string,
): { activeTerminalId: string; splitTerminalId: string; terminals: T[] } {
  const nextTerminals = terminals.filter((terminal) => terminal.id !== closedTerminalId);
  const splitStillOpen = nextTerminals.some((terminal) => terminal.id === splitTerminalId);
  const activeStillOpen = nextTerminals.some((terminal) => terminal.id === activeTerminalId);
  const promotedSplit = splitStillOpen ? splitTerminalId : '';
  const nextActiveTerminalId = activeStillOpen ? activeTerminalId : promotedSplit || nextTerminals[0]?.id || '';
  const nextSplitTerminalId =
    splitStillOpen && splitTerminalId !== nextActiveTerminalId ? splitTerminalId : '';

  return {
    activeTerminalId: nextActiveTerminalId,
    splitTerminalId: nextSplitTerminalId,
    terminals: nextTerminals,
  };
}

export function selectTerminalOutputTarget<T extends TerminalLayoutSession>(
  terminals: T[],
  activeTerminalId: string,
): T | undefined {
  return terminals.find((terminal) => terminal.id === activeTerminalId) ?? terminals[0];
}

export function appendTerminalSession<T extends TerminalLayoutSession>(terminals: T[], terminal: T): T[] {
  return [...terminals.filter((item) => item.id !== terminal.id), terminal];
}

export function bottomPanelAfterTerminalCreate(): 'console' {
  return 'console';
}
