import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PluginRegistry } from './plugin-registry.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('PluginRegistry', () => {
  it('lists official plugins and persists install state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dbagent-plugins-'));
    tempDirs.push(dir);
    const registry = new PluginRegistry(join(dir, 'plugins.json'));

    const plugins = await registry.list();
    const pythonPlugin = plugins.find((plugin) => plugin.id === 'dbagent.python-runner');
    expect(pythonPlugin?.official).toBe(true);
    expect(pythonPlugin?.builtin).toBe(true);
    expect(pythonPlugin?.contributes.commands?.some((command) => command.id === 'dbagent.python.detect')).toBe(true);

    const installed = await registry.install('dbagent.chart-preview');
    expect(installed.installed).toBe(true);

    const reloaded = new PluginRegistry(join(dir, 'plugins.json'));
    expect((await reloaded.list()).find((plugin) => plugin.id === 'dbagent.chart-preview')?.installed).toBe(true);
  });

  it('enables and disables installed plugins without uninstalling them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dbagent-plugins-'));
    tempDirs.push(dir);
    const registry = new PluginRegistry(join(dir, 'plugins.json'));

    await registry.install('dbagent.chart-preview');
    const disabled = await registry.disable('dbagent.chart-preview');
    expect(disabled.installed).toBe(true);
    expect(disabled.enabled).toBe(false);

    const enabled = await registry.enable('dbagent.chart-preview');
    expect(enabled.installed).toBe(true);
    expect(enabled.enabled).toBe(true);
  });

  it('does not uninstall built-in official plugins', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dbagent-plugins-'));
    tempDirs.push(dir);
    const registry = new PluginRegistry(join(dir, 'plugins.json'));

    await expect(registry.uninstall('dbagent.postgres')).rejects.toThrow('cannot be uninstalled');
  });

  it('ignores corrupt state so the plugin marketplace can still open', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dbagent-plugins-'));
    tempDirs.push(dir);
    const statePath = join(dir, 'plugins.json');
    await writeFile(statePath, '{ broken json', 'utf8');

    const plugins = await new PluginRegistry(statePath).list();
    expect(plugins.some((plugin) => plugin.id === 'dbagent.postgres')).toBe(true);
  });
});
