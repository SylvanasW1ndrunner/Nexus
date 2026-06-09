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
