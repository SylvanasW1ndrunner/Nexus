import { mkdtemp, rm } from 'node:fs/promises';
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
    expect(plugins.some((plugin) => plugin.id === 'dbagent.python-runner' && plugin.official)).toBe(true);

    const installed = await registry.install('dbagent.chart-preview');
    expect(installed.installed).toBe(true);

    const reloaded = new PluginRegistry(join(dir, 'plugins.json'));
    expect((await reloaded.list()).find((plugin) => plugin.id === 'dbagent.chart-preview')?.installed).toBe(true);
  });
});
