import { describe, expect, it } from 'vitest';
import { buildTerminalActionMenu } from './terminal-actions.js';

describe('terminal action menu', () => {
  it('enables session actions when an active terminal exists', () => {
    expect(buildTerminalActionMenu({ hasActiveTerminal: true, maximized: false })).toEqual([
      { id: 'new', labelKey: 'newTerminal', enabled: true },
      { id: 'split', labelKey: 'splitTerminal', enabled: true },
      { id: 'rename', labelKey: 'renameTerminal', enabled: true },
      { id: 'clear', labelKey: 'clear', enabled: true },
      { id: 'close', labelKey: 'close', enabled: true },
      { id: 'toggle-maximize', labelKey: 'maximizePanel', enabled: true },
    ]);
  });

  it('disables terminal-specific actions when no terminal is active', () => {
    expect(buildTerminalActionMenu({ hasActiveTerminal: false, maximized: true })).toEqual([
      { id: 'new', labelKey: 'newTerminal', enabled: true },
      { id: 'split', labelKey: 'splitTerminal', enabled: false },
      { id: 'rename', labelKey: 'renameTerminal', enabled: false },
      { id: 'clear', labelKey: 'clear', enabled: false },
      { id: 'close', labelKey: 'close', enabled: false },
      { id: 'toggle-maximize', labelKey: 'restorePanel', enabled: true },
    ]);
  });
});
