import { describe, expect, it } from 'vitest';
import { createForgeCapability } from '../src/forge-capability.js';
import { available, host, unavailable } from './helpers.js';

describe('Forge capability', () => {
  it('requires an external client choice when gh and glab are both present', async () => {
    const module = await createForgeCapability(host(name => Promise.resolve(name === 'gh' || name === 'glab' ? available() : unavailable()))).load();
    const probe = await module.probe?.();
    expect(probe?.activation?.selection).toBe('choice_required');
    expect(probe?.activation?.candidates.map(candidate => candidate.candidateId)).toEqual(['gh', 'glab']);
    await expect(module.activate()).rejects.toThrow('requires selection of an externally available CLI');
  });

  it('publishes seven Forge tools with network facts and one external write', async () => {
    const module = await createForgeCapability(host(name => Promise.resolve(name === 'gh' ? available() : unavailable()))).load();
    const runtime = await module.activate();
    const tools = runtime.contributions.tools ?? [];
    expect(tools).toHaveLength(7);
    expect(tools.filter(tool => tool.definition.name !== 'forge_pr_create').every(tool => tool.definition.access === 'external')).toBe(true);
    expect(tools.find(tool => tool.definition.name === 'forge_pr_create')?.definition.recoveryClass).toBe('non_idempotent');
  });

  it('preserves an explicit glab choice through refresh and uses safe permission facts', async () => {
    const prepared: Array<Record<string, unknown>> = [];
    const command = { prepare: (input: Record<string, unknown>) => { prepared.push(input); return Promise.resolve({}); } };
    const module = await createForgeCapability(host(name => Promise.resolve(name === 'gh' || name === 'glab' ? available() : unavailable()), command)).load();
    const runtime = await module.resolve?.('glab');
    const refreshed = await module.refresh?.(runtime!);
    expect(refreshed).not.toBe(runtime);
    const checks = refreshed?.contributions.tools?.find(tool => tool.definition.name === 'forge_checks');
    await checks?.runtime.prepare({ number: 42 }, {} as never);
    await refreshed?.contributions.tools?.find(tool => tool.definition.name === 'forge_pr_create')?.runtime.prepare({ title: 'title', body: 'body', base: 'main', head: 'topic', draft: true }, {} as never);
    expect(prepared[0]).toMatchObject({
      argv: ['ci', 'get', '--merge-request=42', '--output', 'json'],
      requested: { network: true, externalWrite: false, credentials: false },
      permission: { actions: ['read', 'network'] },
    });
    expect(prepared[1]?.argv).toContain('--draft');
  });

  it('uses bounded gh argv and permission facts for every Forge command', async () => {
    const prepared: Array<Record<string, unknown>> = [];
    const command = { prepare: (input: Record<string, unknown>) => { prepared.push(input); return Promise.resolve({}); }, execute: () => Promise.resolve({ status: 'ok', process: { exitCode: 1 }, spool: { stdout: { text: '{"state":"pending"}' } } }) };
    const module = await createForgeCapability(host(name => Promise.resolve(name === 'gh' ? available() : unavailable()), command)).load();
    const tools = (await module.activate()).contributions.tools ?? [];
    const prepare = async (name: string, input: Record<string, unknown>) => tools.find(tool => tool.definition.name === name)?.runtime.prepare(input as never, {} as never);
    await prepare('forge_status', {});
    await prepare('forge_issue_list', { limit: 2 });
    await prepare('forge_issue_view', { number: 3 });
    await prepare('forge_pr_list', { limit: 4 });
    await prepare('forge_pr_view', { number: 5 });
    await prepare('forge_checks', { number: 6 });
    await prepare('forge_pr_create', { title: 'title', body: 'body', base: 'main', head: 'topic', draft: true });
    expect(prepared.map(item => item.argv)).toEqual([
      ['repo', 'view', '--json', 'nameWithOwner,url,viewerPermission'],
      ['issue', 'list', '--limit', '2', '--json', 'number,title,state,url'],
      ['issue', 'view', '3', '--json', 'number,title,body,state,url,author,labels'],
      ['pr', 'list', '--limit', '4', '--json', 'number,title,state,url,headRefName,baseRefName'],
      ['pr', 'view', '5', '--json', 'number,title,body,state,url,headRefName,baseRefName'],
      ['pr', 'checks', '6', '--json', 'name,state,workflow,link'],
      ['pr', 'create', '--title', 'title', '--body', 'body', '--base', 'main', '--head', 'topic', '--draft'],
    ]);
    expect(prepared.every(item => (item.requested as Record<string, unknown>).credentials === false)).toBe(true);
    expect(prepared[6]).toMatchObject({ requested: { network: true, externalWrite: true } });
    const checks = tools.find(tool => tool.definition.name === 'forge_checks');
    await expect(checks?.runtime.execute({}, {} as never)).resolves.toMatchObject({ structured: { state: 'pending' } });
  });
});
