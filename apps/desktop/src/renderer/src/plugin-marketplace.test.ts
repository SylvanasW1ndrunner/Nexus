import { describe, expect, it } from 'vitest';
import type { PluginManifest } from '@dbagent/shared';
import { filterPlugins, listPluginCategories } from './plugin-marketplace.js';

const plugins: PluginManifest[] = [
  {
    id: 'dbagent.python-runner',
    name: 'Python Runner',
    publisher: 'DBAgent',
    version: '0.1.0',
    description: 'Run Python scripts',
    official: true,
    builtin: true,
    installed: true,
    enabled: true,
    categories: ['python'],
    activationEvents: ['onLanguage:python'],
    contributes: {
      commands: [{ id: 'dbagent.python.runCurrentFile', title: 'Run Current Python File', category: 'Python' }],
      views: [],
    },
  },
  {
    id: 'dbagent.chart-preview',
    name: 'Chart Preview',
    publisher: 'DBAgent',
    version: '0.1.0',
    description: 'Visualize result sets',
    official: true,
    builtin: false,
    installed: false,
    enabled: false,
    categories: ['visualization'],
    activationEvents: ['onResultSet'],
    contributes: {
      commands: [{ id: 'dbagent.chart.preview', title: 'Preview Chart', category: 'Visualization' }],
      views: [{ id: 'dbagent.chart.preview', title: 'Chart Preview', location: 'bottom-panel' }],
    },
  },
];

describe('plugin marketplace filtering', () => {
  it('lists distinct plugin categories', () => {
    expect(listPluginCategories(plugins)).toEqual(['python', 'visualization']);
  });

  it('searches plugin command contributions', () => {
    expect(filterPlugins(plugins, { query: 'current python file', category: '', filter: 'all' }).map((plugin) => plugin.id)).toEqual([
      'dbagent.python-runner',
    ]);
  });

  it('filters by install and enable state', () => {
    expect(filterPlugins(plugins, { query: '', category: '', filter: 'installed' }).map((plugin) => plugin.id)).toEqual([
      'dbagent.python-runner',
    ]);
    expect(filterPlugins(plugins, { query: '', category: '', filter: 'enabled' }).map((plugin) => plugin.id)).toEqual([
      'dbagent.python-runner',
    ]);
  });

  it('filters by category and keeps installed plugins first', () => {
    expect(filterPlugins(plugins, { query: '', category: 'visualization', filter: 'official' }).map((plugin) => plugin.id)).toEqual([
      'dbagent.chart-preview',
    ]);
  });
});
