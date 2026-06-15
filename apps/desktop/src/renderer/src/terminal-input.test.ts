import { describe, expect, it } from 'vitest';
import { shouldForwardTerminalData } from './terminal-input.js';

describe('terminal input forwarding', () => {
  it('forwards xterm generated terminal reports because shells can wait for them before showing a prompt', () => {
    expect(shouldForwardTerminalData('\x1b[?1;2c')).toBe(true);
    expect(shouldForwardTerminalData('\x1b[>0;276;0c')).toBe(true);
    expect(shouldForwardTerminalData('\x1b[?25h')).toBe(true);
    expect(shouldForwardTerminalData('\x1b[?2004l')).toBe(true);
    expect(shouldForwardTerminalData('\x1b[6n')).toBe(true);
    expect(shouldForwardTerminalData('\x1b[2t')).toBe(true);
    expect(shouldForwardTerminalData('\x1b[24;80R')).toBe(true);
    expect(shouldForwardTerminalData('\x1b]0;PowerShell\x07')).toBe(true);
  });

  it('keeps user input and common interactive control keys', () => {
    expect(shouldForwardTerminalData('npm test')).toBe(true);
    expect(shouldForwardTerminalData('\r')).toBe(true);
    expect(shouldForwardTerminalData('\x03')).toBe(true);
    expect(shouldForwardTerminalData('\x1b[A')).toBe(true);
    expect(shouldForwardTerminalData('\x1b[3~')).toBe(true);
  });

  it('drops empty writes only', () => {
    expect(shouldForwardTerminalData('')).toBe(false);
  });
});
