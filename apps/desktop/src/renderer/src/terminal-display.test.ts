import { describe, expect, it } from 'vitest';
import { terminalStatusLabelKey, terminalStatusValue, terminalTabLabel } from './terminal-display.js';

describe('terminal display helpers', () => {
  it('uses the terminal session name before shell details', () => {
    expect(terminalTabLabel({ name: 'Terminal 2', shell: 'powershell.exe' })).toBe('Terminal 2');
    expect(terminalTabLabel({ name: '', shell: 'bash' })).toBe('bash');
  });

  it('formats user-visible terminal state', () => {
    expect(terminalStatusLabelKey({ running: true })).toBe('running');
    expect(terminalStatusValue({ running: true })).toBe('...');
    expect(terminalStatusLabelKey({ status: 'exited', lastExitCode: 0 })).toBe('terminalExited');
    expect(terminalStatusValue({ lastExitCode: 0 })).toBe('0');
    expect(terminalStatusLabelKey({ lastExitCode: 2 })).toBe('terminalFailed');
    expect(terminalStatusValue({ lastExitCode: 2 })).toBe('2');
    expect(terminalStatusLabelKey({})).toBe('terminalReady');
  });
});
