import { describe, expect, it } from 'vitest';
import { resolveTerminalCloseState, selectVisibleTerminals } from './terminal-layout.js';

describe('terminal panel layout', () => {
  const terminals = [{ id: 'one' }, { id: 'two' }, { id: 'three' }];

  it('shows the active terminal first', () => {
    expect(selectVisibleTerminals(terminals, 'two', '').map((terminal) => terminal.id)).toEqual(['two']);
  });

  it('falls back to the first terminal when the active id is missing', () => {
    expect(selectVisibleTerminals(terminals, 'missing', '').map((terminal) => terminal.id)).toEqual(['one']);
  });

  it('adds a second terminal when split id points to another session', () => {
    expect(selectVisibleTerminals(terminals, 'one', 'three').map((terminal) => terminal.id)).toEqual(['one', 'three']);
  });

  it('does not duplicate the active terminal in split mode', () => {
    expect(selectVisibleTerminals(terminals, 'one', 'one').map((terminal) => terminal.id)).toEqual(['one']);
  });

  it('promotes the split terminal when the active terminal is closed', () => {
    expect(resolveTerminalCloseState(terminals, 'one', 'one', 'three')).toEqual({
      activeTerminalId: 'three',
      splitTerminalId: '',
      terminals: [{ id: 'two' }, { id: 'three' }],
    });
  });

  it('clears split mode when the split terminal is closed', () => {
    expect(resolveTerminalCloseState(terminals, 'three', 'one', 'three')).toEqual({
      activeTerminalId: 'one',
      splitTerminalId: '',
      terminals: [{ id: 'one' }, { id: 'two' }],
    });
  });

  it('falls back to an empty terminal state when the last terminal is closed', () => {
    expect(resolveTerminalCloseState([{ id: 'one' }], 'one', 'one', '')).toEqual({
      activeTerminalId: '',
      splitTerminalId: '',
      terminals: [],
    });
  });
});
