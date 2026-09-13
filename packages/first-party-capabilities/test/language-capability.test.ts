import { describe, expect, it } from 'vitest';
import { createLanguageCapability } from '../src/language-capability.js';
import { available, host, unavailable } from './helpers.js';

describe('Language capability', () => {
  it('reports unavailable, degraded, and explicit backend choices from PATH discovery only', async () => {
    const calls: string[] = [];
    const missing = await createLanguageCapability(host(name => { calls.push(name); return Promise.resolve(unavailable()); })).load();
    expect(calls).toEqual([]);
    await expect(missing.probe?.()).resolves.toMatchObject({ status: 'unavailable' });
    const module = await createLanguageCapability(host(name => Promise.resolve(name === 'ruff' || name === 'ctags' ? available() : unavailable()))).load();
    const probe = await module.probe?.();
    expect(probe).toMatchObject({ status: 'degraded' });
    expect(probe?.activation?.candidates.map(candidate => candidate.candidateId)).toEqual(['ruff', 'ctags']);
  });

  it('contributes only the selected backend subcapabilities and preserves selection through refresh', async () => {
    const prepared: Array<Record<string, unknown>> = [];
    const module = await createLanguageCapability(host(name => Promise.resolve(name === 'ruff' || name === 'cargo' ? available() : unavailable()), { prepare: (input: Record<string, unknown>) => { prepared.push(input); return Promise.resolve({}); } })).load();
    const runtime = await module.resolve?.('ruff');
    expect(runtime?.contributions.tools?.map(tool => tool.definition.name)).toEqual(['language_diagnostics', 'language_format']);
    const refreshed = await module.refresh?.(runtime!);
    await refreshed?.contributions.tools?.find(tool => tool.definition.name === 'language_format')?.runtime.prepare({ path: 'src/app.py' }, {} as never);
    expect(prepared[0]).toMatchObject({ argv: ['format', 'src/app.py'], requested: { externalWrite: false, unknownRisk: true, credentials: false }, permission: { access: 'write', dangerLevel: 'high' } });
  });

  it('uses backend-specific diagnostics risk facts and explicit path-limited format argv', async () => {
    const prepared: Array<Record<string, unknown>> = [];
    const command = { prepare: (input: Record<string, unknown>) => { prepared.push(input); return Promise.resolve({}); } };
    const cargo = await createLanguageCapability(host(name => Promise.resolve(name === 'cargo' ? available() : unavailable()), command)).load();
    const cargoTool = (await cargo.activate()).contributions.tools?.find(tool => tool.definition.name === 'language_diagnostics');
    await cargoTool?.runtime.prepare({}, {} as never);
    expect(prepared[0]).toMatchObject({ argv: ['check', '--message-format=json'], requested: { unknownRisk: true }, permission: { dangerLevel: 'high', actions: ['read', 'execute', 'unknown'] } });
    const gofmt = await createLanguageCapability(host(name => Promise.resolve(name === 'gofmt' ? available() : unavailable()), command)).load();
    const format = (await gofmt.activate()).contributions.tools?.find(tool => tool.definition.name === 'language_format');
    await format?.runtime.prepare({ path: 'main.go' }, {} as never);
    expect(prepared[1]?.argv).toEqual(['-w', 'main.go']);
    await expect(format?.runtime.prepare({ path: '../outside.go' }, {} as never)).rejects.toThrow('Path argument must stay inside the workspace');
  });
});
