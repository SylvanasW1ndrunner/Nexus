import { describe, expect, it } from 'vitest';
import { resolvePluginCommandAction } from './plugin-command-handler.js';

describe('plugin command action mapping', () => {
  it('maps official plugin commands to controlled IDE actions', () => {
    expect(resolvePluginCommandAction('dbagent.postgres.connect')).toBe('open-settings');
    expect(resolvePluginCommandAction('dbagent.postgres.explain')).toBe('explain-sql');
    expect(resolvePluginCommandAction('dbagent.python.runCurrentFile')).toBe('run-python');
    expect(resolvePluginCommandAction('dbagent.python.createVenv')).toBe('create-venv');
    expect(resolvePluginCommandAction('dbagent.python.detect')).toBe('detect-python');
    expect(resolvePluginCommandAction('dbagent.result.exportCsv')).toBe('export-csv');
    expect(resolvePluginCommandAction('dbagent.result.exportExcel')).toBe('export-excel');
    expect(resolvePluginCommandAction('dbagent.result.exportJson')).toBe('export-json');
    expect(resolvePluginCommandAction('dbagent.chart.preview')).toBe('preview-chart');
  });

  it('keeps unknown plugin commands unbound until a handler is explicitly registered', () => {
    expect(resolvePluginCommandAction('dbagent.unknown.run')).toBe('unbound');
  });
});
