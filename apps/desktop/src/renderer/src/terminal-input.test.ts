import { describe, expect, it } from 'vitest';
import { shouldForwardTerminalData } from './terminal-input.js';

describe('terminal input forwarding', () => {
  it('drops xterm generated capability reports that shells can echo as garbage', () => {
    expect(shouldForwardTerminalData('\x1b[?1;2c')).toBe(false);
    expect(shouldForwardTerminalData('\x1b[?25h')).toBe(false);
    expect(shouldForwardTerminalData('\x1b[?2004l')).toBe(false);
    expect(shouldForwardTerminalData('\x1b[6n')).toBe(false);
    expect(shouldForwardTerminalData('\x1b[2t')).toBe(false);
    expect(shouldForwardTerminalData('\x1b[24;80R')).toBe(false);
    expect(shouldForwardTerminalData('\x1b]0;PowerShell\x07')).toBe(false);
  });

  it('keeps user input and common interactive control keys', () => {
    expect(shouldForwardTerminalData('npm test')).toBe(true);
    expect(shouldForwardTerminalData('\r')).toBe(true);
    expect(shouldForwardTerminalData('\x03')).toBe(true);
    expect(shouldForwardTerminalData('\x1b[A')).toBe(true);
    expect(shouldForwardTerminalData('\x1b[3~')).toBe(true);
  });
});
