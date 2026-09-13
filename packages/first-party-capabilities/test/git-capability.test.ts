import { describe, expect, it } from 'vitest';
import { createGitCapability } from '../src/git-capability.js';
import { available, host, unavailable } from './helpers.js';

describe('Git capability', () => {
  it('is unavailable with an actionable external CLI diagnostic', async () => {
    const module = await createGitCapability(host(() => Promise.resolve(unavailable()))).load();
    const probe = await module.probe?.();
    expect(probe).toMatchObject({ status: 'unavailable' });
    expect(probe?.reason).toContain('Install git externally');
  });

  it('publishes exactly six deferred Git tools without remote commands', async () => {
    const module = await createGitCapability(host(() => Promise.resolve(available()))).load();
    const runtime = await module.activate();
    const tools = runtime.contributions.tools ?? [];
    expect(tools.map(tool => tool.definition.name)).toEqual(['git_status', 'git_diff', 'git_log', 'git_show', 'git_stage', 'git_commit']);
    expect(tools.every(tool => tool.definition.exposure === 'direct')).toBe(true);
    expect(tools.flatMap(tool => tool.definition.name.includes('remote') ? [tool.definition.name] : [])).toEqual([]);
    expect(tools.find(tool => tool.definition.name === 'git_commit')?.definition.recoveryClass).toBe('non_idempotent');
  });

  it('rejects a git-show ref that could be interpreted as an option', async () => {
    const module = await createGitCapability(host(() => Promise.resolve(available()), { prepare: () => Promise.resolve({}) })).load();
    const tool = (await module.activate()).contributions.tools?.find(candidate => candidate.definition.name === 'git_show');
    await expect(tool?.runtime.prepare({ ref: '--upload-pack=bad' }, {} as never)).rejects.toThrow('ref cannot begin with a dash');
  });

  it('rejects path traversal before command preparation', async () => {
    const module = await createGitCapability(host(() => Promise.resolve(available()), { prepare: () => Promise.resolve({}) })).load();
    const tool = (await module.activate()).contributions.tools?.find(candidate => candidate.definition.name === 'git_stage');
    await expect(tool?.runtime.prepare({ paths: ['../outside'] }, {} as never)).rejects.toThrow('Path argument must stay inside the workspace');
  });

  it('uses isolated argv and operation facts for every Git command', async () => {
    const prepared: Array<Record<string, unknown>> = [];
    const module = await createGitCapability(host(() => Promise.resolve(available()), { prepare: (input: Record<string, unknown>) => { prepared.push(input); return Promise.resolve({}); } })).load();
    const tools = (await module.activate()).contributions.tools ?? [];
    const prepare = async (name: string, input: Record<string, unknown>) => tools.find(tool => tool.definition.name === name)?.runtime.prepare(input as never, {} as never);
    await prepare('git_status', {});
    await prepare('git_diff', { staged: true, context: 7, path: 'package.json' });
    await prepare('git_log', { limit: 3 });
    await prepare('git_show', { ref: 'HEAD' });
    await prepare('git_stage', { paths: ['package.json'] });
    await prepare('git_commit', { message: 'test commit' });
    expect(prepared.map(item => item.argv)).toEqual([
      ['-c', 'core.fsmonitor=false', '--no-optional-locks', '--no-pager', 'status', '--porcelain=v2', '--branch'],
      ['-c', 'core.fsmonitor=false', '--no-optional-locks', '--no-pager', 'diff', '--staged', '--unified=7', '--no-ext-diff', '--no-textconv', '--', 'package.json'],
      ['-c', 'core.fsmonitor=false', '--no-optional-locks', '--no-pager', 'log', '--max-count=3', '--format=%H%x09%an%x09%ad%x09%s', '--date=iso-strict'],
      ['-c', 'core.fsmonitor=false', '--no-optional-locks', '--no-pager', 'show', '--no-ext-diff', '--no-textconv', '--format=fuller', 'HEAD'],
      ['-c', 'core.fsmonitor=false', '--no-pager', 'add', '--', 'package.json'],
      ['-c', 'core.fsmonitor=false', '--no-pager', 'commit', '-m', 'test commit'],
    ]);
    expect(prepared[4]).toMatchObject({ requested: { unknownRisk: true, credentials: false, network: false }, permission: { dangerLevel: 'high' } });
    expect(prepared[5]).toMatchObject({ requested: { unknownRisk: true, credentials: false, network: false }, permission: { dangerLevel: 'high' } });
  });
});
