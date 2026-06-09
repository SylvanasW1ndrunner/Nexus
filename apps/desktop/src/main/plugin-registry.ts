import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { PluginManifest } from '@dbagent/shared';

const officialPlugins: PluginManifest[] = [
  {
    id: 'dbagent.postgres',
    name: 'PostgreSQL Toolkit',
    publisher: 'DBAgent',
    version: '0.1.0',
    description: 'PostgreSQL connection, schema inspection, query execution, and query analysis.',
    official: true,
    builtin: true,
    enabled: true,
    installed: true,
    categories: ['database'],
    activationEvents: ['onDatabase:postgres'],
    contributes: {
      commands: [
        { id: 'dbagent.postgres.connect', title: 'Connect to PostgreSQL', category: 'Database' },
        { id: 'dbagent.postgres.explain', title: 'Explain SQL', category: 'Database' },
      ],
      views: [{ id: 'dbagent.postgres.schema', title: 'PostgreSQL Schema', location: 'left-sidebar' }],
      configuration: [
        {
          key: 'postgres.statementTimeoutMs',
          type: 'number',
          title: 'Statement timeout',
          defaultValue: 30000,
        },
      ],
    },
  },
  {
    id: 'dbagent.python-runner',
    name: 'Python Runner',
    publisher: 'DBAgent',
    version: '0.1.0',
    description: 'Local Python environment detection, venv/conda setup, and script execution.',
    official: true,
    builtin: true,
    enabled: true,
    installed: true,
    categories: ['python'],
    activationEvents: ['onLanguage:python', 'onWorkspaceContains:requirements.txt'],
    contributes: {
      commands: [
        { id: 'dbagent.python.detect', title: 'Detect Python Environments', category: 'Python' },
        { id: 'dbagent.python.createVenv', title: 'Create Virtual Environment', category: 'Python' },
      ],
      views: [{ id: 'dbagent.python.environments', title: 'Python Environments', location: 'settings' }],
      configuration: [
        {
          key: 'python.defaultMode',
          type: 'enum',
          title: 'Default Python mode',
          defaultValue: 'system',
          enumValues: ['system', 'venv', 'conda'],
        },
      ],
    },
  },
  {
    id: 'dbagent.result-export',
    name: 'Result Export',
    publisher: 'DBAgent',
    version: '0.1.0',
    description: 'CSV, Excel, and JSON exports for SQL result sets.',
    official: true,
    builtin: true,
    enabled: true,
    installed: true,
    categories: ['export'],
    activationEvents: ['onResultSet'],
    contributes: {
      commands: [
        { id: 'dbagent.result.exportCsv', title: 'Export CSV', category: 'Results' },
        { id: 'dbagent.result.exportJson', title: 'Export JSON', category: 'Results' },
      ],
      views: [{ id: 'dbagent.result.export', title: 'Result Export', location: 'bottom-panel' }],
      configuration: [
        {
          key: 'resultExport.includeHeaders',
          type: 'boolean',
          title: 'Include column headers',
          defaultValue: true,
        },
      ],
    },
  },
  {
    id: 'dbagent.chart-preview',
    name: 'Chart Preview',
    publisher: 'DBAgent',
    version: '0.1.0',
    description: 'Official placeholder for result visualization and chart previews.',
    official: true,
    builtin: false,
    enabled: false,
    installed: false,
    categories: ['visualization'],
    activationEvents: ['onResultSet'],
    contributes: {
      commands: [{ id: 'dbagent.chart.preview', title: 'Preview Chart', category: 'Visualization' }],
      views: [{ id: 'dbagent.chart.preview', title: 'Chart Preview', location: 'bottom-panel' }],
      configuration: [
        {
          key: 'chartPreview.defaultChart',
          type: 'enum',
          title: 'Default chart type',
          defaultValue: 'bar',
          enumValues: ['bar', 'line', 'scatter'],
        },
      ],
    },
  },
];

type PluginState = Record<string, { installed: boolean; enabled: boolean }>;

export class PluginRegistry {
  constructor(private readonly statePath: string) {}

  async list(): Promise<PluginManifest[]> {
    const state = await this.loadState();
    return officialPlugins.map((plugin) => ({
      ...plugin,
      installed: state[plugin.id]?.installed ?? plugin.installed,
      enabled: state[plugin.id]?.enabled ?? plugin.enabled,
    }));
  }

  async install(id: string): Promise<PluginManifest> {
    const plugin = await this.find(id);
    const state = await this.loadState();
    state[id] = { installed: true, enabled: true };
    await this.saveState(state);
    return { ...plugin, installed: true, enabled: true };
  }

  async uninstall(id: string): Promise<PluginManifest> {
    const plugin = await this.find(id);
    if (plugin.builtin) throw new Error(`Built-in plugin ${id} cannot be uninstalled.`);
    const state = await this.loadState();
    state[id] = { installed: false, enabled: false };
    await this.saveState(state);
    return { ...plugin, installed: false, enabled: false };
  }

  async enable(id: string): Promise<PluginManifest> {
    const plugin = await this.find(id);
    if (!plugin.installed) throw new Error(`Plugin ${id} must be installed before it can be enabled.`);
    const state = await this.loadState();
    state[id] = { installed: true, enabled: true };
    await this.saveState(state);
    return { ...plugin, installed: true, enabled: true };
  }

  async disable(id: string): Promise<PluginManifest> {
    const plugin = await this.find(id);
    if (!plugin.installed) throw new Error(`Plugin ${id} is not installed.`);
    const state = await this.loadState();
    state[id] = { installed: true, enabled: false };
    await this.saveState(state);
    return { ...plugin, installed: true, enabled: false };
  }

  private async find(id: string): Promise<PluginManifest> {
    const plugin = (await this.list()).find((item) => item.id === id);
    if (!plugin) throw new Error(`Plugin ${id} is not registered.`);
    return plugin;
  }

  private async loadState(): Promise<PluginState> {
    try {
      return JSON.parse(await readFile(this.statePath, 'utf8')) as PluginState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return {};
      throw error;
    }
  }

  private async saveState(state: PluginState): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    const tempPath = `${this.statePath}.${process.pid}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(tempPath, this.statePath);
  }
}
