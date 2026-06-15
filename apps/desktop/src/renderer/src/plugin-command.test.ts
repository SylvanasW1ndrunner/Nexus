import { describe, expect, it } from 'vitest';
import type { PluginManifest } from '@dbagent/shared';
import { isPluginCommandAvailable, pluginActivationMatches, type PluginCommandContext } from './plugin-command.js';

const baseContext: PluginCommandContext = {
  activeDatabaseEngine: 'postgres',
  editorLanguage: 'sql',
  hasWorkspace: true,
  hasResult: true,
};

function plugin(overrides: Partial<PluginManifest>): PluginManifest {
  return {
    id: 'dbagent.sample',
    name: 'Sample',
    publisher: 'DBAgent',
    version: '0.1.0',
    description: 'Sample plugin',
    official: true,
    builtin: false,
    installed: true,
    enabled: true,
    categories: ['productivity'],
    activationEvents: [],
    contributes: { commands: [] },
    ...overrides,
  };
}

describe('plugin command activation', () => {
  it('blocks commands from plugins that are not installed or enabled', () => {
    const disabled = plugin({
      installed: true,
      enabled: false,
      contributes: { commands: [{ id: 'dbagent.python.detect', title: 'Detect Python', category: 'Python' }] },
    });
    const uninstalled = { ...disabled, installed: false, enabled: false };

    expect(isPluginCommandAvailable(disabled, 'dbagent.python.detect', baseContext)).toBe(false);
    expect(isPluginCommandAvailable(uninstalled, 'dbagent.python.detect', baseContext)).toBe(false);
  });

  it('enables PostgreSQL commands only for matching database context', () => {
    const postgres = plugin({
      id: 'dbagent.postgres',
      activationEvents: ['onDatabase:postgres'],
      contributes: {
        commands: [
          { id: 'dbagent.postgres.connect', title: 'Connect', category: 'Database' },
          { id: 'dbagent.postgres.explain', title: 'Explain', category: 'Database' },
        ],
      },
    });

    const noDatabaseContext = {
      editorLanguage: baseContext.editorLanguage,
      hasWorkspace: baseContext.hasWorkspace,
      hasResult: baseContext.hasResult,
    };

    expect(isPluginCommandAvailable(postgres, 'dbagent.postgres.connect', noDatabaseContext)).toBe(true);
    expect(isPluginCommandAvailable(postgres, 'dbagent.postgres.explain', baseContext)).toBe(true);
    expect(isPluginCommandAvailable(postgres, 'dbagent.postgres.explain', noDatabaseContext)).toBe(false);
  });

  it('enables Python commands for workspace Python files', () => {
    const python = plugin({
      id: 'dbagent.python-runner',
      activationEvents: ['onLanguage:python', 'onWorkspaceContains:requirements.txt'],
      contributes: {
        commands: [
          { id: 'dbagent.python.detect', title: 'Detect', category: 'Python' },
          { id: 'dbagent.python.runCurrentFile', title: 'Run', category: 'Python' },
          { id: 'dbagent.python.createVenv', title: 'Create venv', category: 'Python' },
        ],
      },
    });

    expect(isPluginCommandAvailable(python, 'dbagent.python.detect', { ...baseContext, hasWorkspace: false })).toBe(true);
    expect(isPluginCommandAvailable(python, 'dbagent.python.runCurrentFile', { ...baseContext, editorLanguage: 'python' })).toBe(true);
    expect(isPluginCommandAvailable(python, 'dbagent.python.runCurrentFile', { ...baseContext, editorLanguage: 'sql' })).toBe(false);
    expect(isPluginCommandAvailable(python, 'dbagent.python.createVenv', { ...baseContext, hasWorkspace: false })).toBe(false);
  });

  it('enables result commands only when a result set exists', () => {
    const exportPlugin = plugin({
      id: 'dbagent.result-export',
      activationEvents: ['onResultSet'],
      contributes: {
        commands: [{ id: 'dbagent.result.exportExcel', title: 'Export Excel', category: 'Results' }],
      },
    });
    const chartPlugin = plugin({
      id: 'dbagent.chart-preview',
      activationEvents: ['onResultSet'],
      contributes: {
        commands: [{ id: 'dbagent.chart.preview', title: 'Preview Chart', category: 'Visualization' }],
      },
    });

    expect(isPluginCommandAvailable(exportPlugin, 'dbagent.result.exportExcel', baseContext)).toBe(true);
    expect(isPluginCommandAvailable(exportPlugin, 'dbagent.result.exportExcel', { ...baseContext, hasResult: false })).toBe(false);
    expect(isPluginCommandAvailable(chartPlugin, 'dbagent.chart.preview', baseContext)).toBe(true);
    expect(isPluginCommandAvailable(chartPlugin, 'dbagent.chart.preview', { ...baseContext, hasResult: false })).toBe(false);
  });

  it('matches activation events from manifest context', () => {
    expect(pluginActivationMatches(plugin({ activationEvents: [] }), baseContext)).toBe(true);
    expect(pluginActivationMatches(plugin({ activationEvents: ['onLanguage:python'] }), baseContext)).toBe(false);
    expect(pluginActivationMatches(plugin({ activationEvents: ['onDatabase:postgres'] }), baseContext)).toBe(true);
    expect(pluginActivationMatches(plugin({ activationEvents: ['onWorkspaceContains:requirements.txt'] }), baseContext)).toBe(true);
  });
});
