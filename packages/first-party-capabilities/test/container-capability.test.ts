import { describe, expect, it } from 'vitest';
import { createContainerCapability } from '../src/container-capability.js';
import { available, host, unavailable } from './helpers.js';

describe('Container capability', () => {
  it('probes only PATH discovery and requires a daemon client choice when both are present', async () => {
    const calls: string[] = [];
    const module = await createContainerCapability(host(name => { calls.push(name); return Promise.resolve(available()); })).load();
    expect(calls).toEqual([]);
    const probe = await module.probe?.();
    expect(calls).toEqual(['docker', 'podman']);
    expect(probe?.activation?.selection).toBe('choice_required');
    await expect(module.activate()).rejects.toThrow('requires selection of an externally available CLI');
  });

  it('reports an actionable unavailable daemon client without contacting a daemon', async () => {
    const module = await createContainerCapability(host(() => Promise.resolve(unavailable()))).load();
    const probe = await module.probe?.();
    expect(probe).toMatchObject({ status: 'unavailable' });
    expect(probe?.reason).toContain('Install docker or podman externally');
  });

  it('uses fixed docker argv and high daemon permission facts for every operation', async () => {
    const prepared: Array<Record<string, unknown>> = [];
    const module = await createContainerCapability(host(name => Promise.resolve(name === 'docker' ? available() : unavailable()), { prepare: (input: Record<string, unknown>) => { prepared.push(input); return Promise.resolve({}); } })).load();
    const tools = (await module.activate()).contributions.tools ?? [];
    const prepare = async (name: string, input: Record<string, unknown>) => tools.find(tool => tool.definition.name === name)?.runtime.prepare(input as never, {} as never);
    await prepare('container_list', {});
    await prepare('container_inspect', { container: 'api-1' });
    await prepare('container_logs', { container: 'api-1', tail: 12 });
    await prepare('container_exec', { container: 'api-1', command: ['node', '--version'] });
    await prepare('container_compose', { action: 'up', file: 'compose.yaml', services: ['api'] });
    expect(prepared.map(item => item.argv)).toEqual([
      ['ps', '--all', '--format', 'json'], ['inspect', 'api-1'], ['logs', '--tail', '12', 'api-1'], ['exec', 'api-1', 'node', '--version'], ['compose', '--file', 'compose.yaml', 'up', '--detach', 'api'],
    ]);
    expect(prepared.every(item => JSON.stringify(item.hostTargets) === JSON.stringify(['container-daemon']))).toBe(true);
    expect(prepared.slice(0, 3).every(item => (item.requested as Record<string, unknown>).admin === true && (item.requested as Record<string, unknown>).unknownRisk === true && (item.requested as Record<string, unknown>).network === true)).toBe(true);
    expect(prepared.every(item => (item.resourceKeys as string[]).includes('host:container-daemon'))).toBe(true);
    expect(prepared.slice(3).every(item => (item.requested as Record<string, unknown>).externalWrite === true && (item.permission as Record<string, unknown>).dangerLevel === 'high')).toBe(true);
  });

  it('rejects option-like container names and compose down service injection', async () => {
    const module = await createContainerCapability(host(name => Promise.resolve(name === 'docker' ? available() : unavailable()), { prepare: () => Promise.resolve({}) })).load();
    const tools = (await module.activate()).contributions.tools ?? [];
    await expect(tools.find(tool => tool.definition.name === 'container_exec')?.runtime.prepare({ container: '--host', command: ['id'] }, {} as never)).rejects.toThrow('container is invalid');
    await expect(tools.find(tool => tool.definition.name === 'container_compose')?.runtime.prepare({ action: 'down', services: ['api'] }, {} as never)).rejects.toThrow('compose down does not accept services');
  });
});
