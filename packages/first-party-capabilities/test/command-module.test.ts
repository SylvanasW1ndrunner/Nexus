import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCommandCapabilityRegistration } from '../src/command-module.js';
import { available, host } from './helpers.js';

describe('command capability module', () => {
  it('publishes external reads as readonly while serializing their external execution', async () => {
    const registration = createCommandCapabilityRegistration({
      moduleId: 'test.command.external-read', capabilityId: 'test.command.external-read', instanceId: 'test', version: '1', description: 'test command', executables: ['test-cli'],
      operations: [{ name: 'test_external_read', description: 'test', inputSchema: { type: 'object' }, argv: () => ['status'], output: 'stable-text', permission: { access: 'external', recoveryClass: 'read', dangerLevel: 'medium', actions: ['read', 'network'], network: true, externalWrite: false, destructive: false, admin: false, unknownRisk: false } }],
    }, host(() => Promise.resolve(available())));

    const tool = (await (await registration.load()).activate()).contributions.tools?.[0];

    expect(tool?.definition).toMatchObject({
      readonly: true,
      access: 'external',
      recoveryClass: 'read',
      execution: { concurrency: 'exclusive' },
    });
  });

  it('returns an ordinary bounded external error for malformed CLI JSON', async () => {
    const command = { execute: () => Promise.resolve({ status: 'ok', spool: { stdout: { text: '{broken' } } }) };
    const registration = createCommandCapabilityRegistration({
      moduleId: 'test.command', capabilityId: 'test.command', instanceId: 'test', version: '1', description: 'test command', executables: ['test-cli'],
      operations: [{ name: 'test_json', description: 'test', inputSchema: { type: 'object' }, argv: () => ['status'], output: 'json', permission: { access: 'external', recoveryClass: 'read', dangerLevel: 'medium', actions: ['read', 'network'], network: true, externalWrite: false, destructive: false, admin: false, unknownRisk: false } }],
    }, host(() => Promise.resolve(available()), command));
    const module = await registration.load();
    const runtime = await module.activate();
    const tool = runtime.contributions.tools?.[0];
    await expect(tool?.runtime.execute({}, {} as never)).rejects.toThrow('invalid structured output');
  });

  it.each([
    ['a non-zero exit', { status: 'ok', process: { exitCode: 3 }, spool: { stdout: { text: 'nonzero stdout' }, stderr: { text: 'nonzero stderr' } } }, 'nonzero stdout'],
    ['partial output', { status: 'partial', process: { exitCode: 0 }, spool: { stdout: { text: 'partial stdout' }, stderr: { text: 'partial stderr' } } }, 'partial stderr'],
  ])('returns an external failure before parsing JSON for %s', async (_name, result, diagnostic) => {
    const command = { execute: () => Promise.resolve(result) };
    const registration = createCommandCapabilityRegistration({
      moduleId: 'test.command.outcome', capabilityId: 'test.command.outcome', instanceId: 'test', version: '1', description: 'test command', executables: ['test-cli'],
      operations: [{ name: 'test_json_outcome', description: 'test', inputSchema: { type: 'object' }, argv: () => ['status'], output: 'json', permission: { access: 'external', recoveryClass: 'read', dangerLevel: 'medium', actions: ['read', 'network'], network: true, externalWrite: false, destructive: false, admin: false, unknownRisk: false } }],
    }, host(() => Promise.resolve(available()), command));
    const tool = (await (await registration.load()).activate()).contributions.tools?.[0];
    await expect(tool?.runtime.execute({}, {} as never)).rejects.toThrow(diagnostic);
  });

  it('cancels and bounds a probe using the lifecycle context', async () => {
    const registration = createCommandCapabilityRegistration({
      moduleId: 'test.command.probe', capabilityId: 'test.command.probe', instanceId: 'test', version: '1', description: 'test command', executables: ['slow-cli'],
      operations: [],
    }, host(async () => await new Promise<never>(() => undefined)));
    const module = await registration.load();
    await expect(module.probe?.({ signal: AbortSignal.abort() })).rejects.toThrow('cancelled');
    await expect(module.probe?.({ signal: new AbortController().signal, deadline: new Date(Date.now() - 1).toISOString() })).rejects.toThrow('timed out');
  });

  it('reports partial external installation as degraded with an actionable reason when requested', async () => {
    const registration = createCommandCapabilityRegistration({
      moduleId: 'test.command.degraded', capabilityId: 'test.command.degraded', instanceId: 'test', version: '1', description: 'test command', executables: ['one', 'two'], degradeWhenPartialAvailability: true,
      operations: [],
    }, host(name => Promise.resolve(name === 'one' ? available() : { status: 'unavailable', reason: 'not_found', diagnostic: 'install it' })));
    const probe = await (await registration.load()).probe?.();
    expect(probe).toMatchObject({ status: 'degraded' });
    expect(probe?.reason).toContain('install the remaining external CLI choices');
  });

  it('rejects command path targets outside the workspace before calling the Host command port', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'schemanaut-command-workspace-'));
    const outside = await mkdtemp(join(tmpdir(), 'schemanaut-command-outside-'));
    try {
      const outsideFile = join(outside, 'input.txt'); await writeFile(outsideFile, 'outside');
      let prepared = false;
      const registration = createCommandCapabilityRegistration({
        moduleId: 'test.command.path', capabilityId: 'test.command.path', instanceId: 'test', version: '1', description: 'test command', executables: ['test-cli'],
        operations: [{ name: 'test_path', description: 'test', inputSchema: { type: 'object' }, argv: () => ['inspect', outsideFile], pathInputs: () => [outsideFile], output: 'stable-text', permission: { access: 'read', recoveryClass: 'read', dangerLevel: 'safe', actions: ['read'], network: false, externalWrite: false, destructive: false, admin: false, unknownRisk: false } }],
      }, { ...host(() => Promise.resolve(available()), { prepare: () => { prepared = true; return Promise.resolve({} as never); } }), workspaceRoot: workspace });
      const tool = (await (await registration.load()).activate()).contributions.tools?.[0];
      expect(tool).toBeDefined();
      if (!tool) throw new Error('test_path was not contributed');
      await expect(tool.runtime.prepare({}, {} as never)).rejects.toThrow('inside the workspace');
      expect(prepared).toBe(false);
    } finally {
      await Promise.all([rm(workspace, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
    }
  });
});
