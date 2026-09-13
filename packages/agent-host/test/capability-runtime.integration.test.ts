import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentCapabilityModuleRegistration } from '@dbagent/core-agent';
import { AgentRuntime } from '../src/agent-runtime.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe('AgentRuntime capability lifecycle', () => {
  it('loads a normal module only when activated', async () => {
    const projectDirectory = await project();
    const activate = vi.fn(() => ({ contributions: {} }));
    const module: AgentCapabilityModuleRegistration = {
      manifest: { id: 'fixture.lifecycle', version: '1', description: 'Lifecycle fixture', capabilities: [{ id: 'fixture.lifecycle', description: 'Test lifecycle' }] },
      instanceId: 'primary', load: vi.fn(() => ({ probe: () => ({ status: 'available' as const }), activate })),
    };
    const runtime = new AgentRuntime({ projectDirectory, modules: [module] });
    try {
      expect(module.load).not.toHaveBeenCalled();
      await runtime.activateModule('fixture.lifecycle', 'primary');
      expect(module.load).toHaveBeenCalledOnce();
      expect(activate).toHaveBeenCalledOnce();
      expect(runtime.status().capabilities.modules).toEqual(expect.arrayContaining([
        expect.objectContaining({ moduleId: 'fixture.lifecycle', active: true }),
      ]));
    } finally {
      await runtime.close();
    }
  });
});

async function project(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'schemanaut-capability-host-'));
  directories.push(directory);
  return directory;
}
