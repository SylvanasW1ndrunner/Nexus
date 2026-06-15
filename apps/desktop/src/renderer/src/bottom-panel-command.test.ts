import { describe, expect, it } from 'vitest';
import { resolveBottomPanelCommandAction } from './bottom-panel-command.js';

describe('bottom panel command actions', () => {
  it('maps core command palette commands to bottom panel actions', () => {
    expect(resolveBottomPanelCommandAction('core.showProblems')).toEqual({ type: 'show-panel', panel: 'problems' });
    expect(resolveBottomPanelCommandAction('core.showResults')).toEqual({ type: 'show-panel', panel: 'results' });
    expect(resolveBottomPanelCommandAction('core.showTerminal')).toEqual({ type: 'open-terminal' });
    expect(resolveBottomPanelCommandAction('core.showPorts')).toEqual({ type: 'show-panel', panel: 'ports' });
  });

  it('maps native menu commands to the same bottom panel actions', () => {
    expect(resolveBottomPanelCommandAction('show-problems')).toEqual({ type: 'show-panel', panel: 'problems' });
    expect(resolveBottomPanelCommandAction('show-results')).toEqual({ type: 'show-panel', panel: 'results' });
    expect(resolveBottomPanelCommandAction('show-terminal')).toEqual({ type: 'open-terminal' });
    expect(resolveBottomPanelCommandAction('show-ports')).toEqual({ type: 'show-panel', panel: 'ports' });
  });

  it('keeps unknown commands unbound', () => {
    expect(resolveBottomPanelCommandAction('core.showDebugConsole')).toEqual({ type: 'unbound' });
  });
});
