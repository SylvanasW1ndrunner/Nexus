import { describe, expect, it } from 'vitest';
import { shouldCloseAuthDialog, shouldInitializeIdeShell } from './ide-shell-startup.js';

describe('IDE shell startup after authentication', () => {
  it('does not initialize shell processes before authentication', () => {
    expect(shouldInitializeIdeShell({ authenticated: false, initialized: false })).toBe(false);
  });

  it('initializes the IDE shell once after authentication', () => {
    expect(shouldInitializeIdeShell({ authenticated: true, initialized: false })).toBe(true);
    expect(shouldInitializeIdeShell({ authenticated: true, initialized: true })).toBe(false);
  });

  it('keeps the auth dialog open until a real authenticated status is returned', () => {
    expect(shouldCloseAuthDialog({ authenticated: false })).toBe(false);
    expect(shouldCloseAuthDialog({ authenticated: true })).toBe(true);
  });
});
