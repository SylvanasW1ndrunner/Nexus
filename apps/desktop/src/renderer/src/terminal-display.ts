import type { TerminalSession } from '@dbagent/shared';
import type { TranslationKey } from './i18n.js';

export function terminalTabLabel(terminal: Pick<TerminalSession, 'name' | 'shell'>): string {
  if (terminal.name?.trim()) return terminal.name.trim();
  return terminal.shell?.trim() || 'Terminal';
}

export function terminalStatusLabelKey(
  terminal: Pick<TerminalSession, 'status' | 'lastExitCode'> & { running?: boolean },
): TranslationKey {
  if (terminal.running) return 'running';
  if (terminal.status === 'exited') return 'terminalExited';
  if (terminal.lastExitCode !== undefined && terminal.lastExitCode !== null && terminal.lastExitCode !== 0) return 'terminalFailed';
  return 'terminalReady';
}

export function terminalStatusValue(terminal: Pick<TerminalSession, 'lastExitCode'> & { running?: boolean }): string {
  if (terminal.running) return '...';
  if (terminal.lastExitCode === undefined || terminal.lastExitCode === null) return '';
  return String(terminal.lastExitCode);
}

export function normalizeTerminalName(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}
