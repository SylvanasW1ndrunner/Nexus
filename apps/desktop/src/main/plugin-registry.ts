import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
    enabled: true,
    installed: true,
    categories: ['database'],
  },
  {
    id: 'dbagent.python-runner',
    name: 'Python Runner',
    publisher: 'DBAgent',
    version: '0.1.0',
    description: 'Local Python environment detection, venv/conda setup, and script execution.',
    official: true,
    enabled: true,
    installed: true,
    categories: ['python'],
  },
  {
    id: 'dbagent.result-export',
    name: 'Result Export',
    publisher: 'DBAgent',
    version: '0.1.0',
    description: 'CSV, Excel, and JSON exports for SQL result sets.',
    official: true,
    enabled: true,
    installed: true,
    categories: ['export'],
  },
  {
    id: 'dbagent.chart-preview',
    name: 'Chart Preview',
    publisher: 'DBAgent',
    version: '0.1.0',
    description: 'Official placeholder for result visualization and chart previews.',
    official: true,
    enabled: false,
    installed: false,
    categories: ['visualization'],
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
    const state = await this.loadState();
    state[id] = { installed: false, enabled: false };
    await this.saveState(state);
    return { ...plugin, installed: false, enabled: false };
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
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }

  private async saveState(state: PluginState): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    await writeFile(this.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }
}
