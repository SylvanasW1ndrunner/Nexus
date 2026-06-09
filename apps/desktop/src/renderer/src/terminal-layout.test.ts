import { describe, expect, it } from 'vitest';
import { selectVisibleTerminals } from './terminal-layout.js';

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
});
