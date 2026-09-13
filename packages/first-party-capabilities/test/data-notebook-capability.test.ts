import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PreparedToolIntent, ToolExecuteContext, ToolInvocationContribution, ToolPrepareContext } from '@dbagent/core-agent';
import { createDataNotebookCapability } from '../src/data-notebook-capability.js';
import { available, host, unavailable } from './helpers.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe('Data and Notebook capability', () => {
  it('keeps bounded profile and inspect available when jupyter is absent', async () => {
    const module = await createDataNotebookCapability(host(() => Promise.resolve(unavailable()))).load();
    expect(await module.probe?.()).toMatchObject({ status: 'degraded' });
    expect((await module.activate()).contributions.tools?.map(tool => tool.definition.name)).toEqual(['data_profile', 'notebook_inspect']);
  });

  it('profiles JSON/CSV and inspects notebook cells without external execution', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'schemanaut-data-')); directories.push(directory);
    const json = join(directory, 'data.json'); const csv = join(directory, 'data.csv'); const notebook = join(directory, 'sample.ipynb');
    await writeFile(json, '[{"id":1},{"id":2}]'); await writeFile(csv, 'id,name\n1,one\n'); await writeFile(notebook, JSON.stringify({ nbformat: 4, cells: [{ cell_type: 'code' }, { cell_type: 'markdown' }] }));
    const module = await createDataNotebookCapability({ ...host(() => Promise.resolve(unavailable())), workspaceRoot: directory }).load();
    const tools = (await module.activate()).contributions.tools ?? [];
    const profile = tools.find(tool => tool.definition.name === 'data_profile'); const inspect = tools.find(tool => tool.definition.name === 'notebook_inspect');
    expect(profile).toBeDefined();
    expect(inspect).toBeDefined();
    if (!profile || !inspect) throw new Error('expected data tools were not contributed');
    await expect(invoke(profile, { input: 'data.json' })).resolves.toMatchObject({ kind: 'json', records: 2 });
    await expect(invoke(profile, { input: 'data.csv' })).resolves.toMatchObject({ kind: 'csv', columns: 2 });
    await expect(invoke(inspect, { input: 'sample.ipynb' })).resolves.toMatchObject({ cells: 2, cellTypes: { code: 1, markdown: 1 } });
  });

  it('rejects paths outside the workspace and replacements after prepare', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'schemanaut-data-')); directories.push(directory);
    const outside = await mkdtemp(join(tmpdir(), 'schemanaut-data-outside-')); directories.push(outside);
    await writeFile(join(directory, 'data.json'), '[1]');
    await writeFile(join(outside, 'outside.json'), '[2]');
    const module = await createDataNotebookCapability({ ...host(() => Promise.resolve(unavailable())), workspaceRoot: directory }).load();
    const profile = (await module.activate()).contributions.tools?.find(tool => tool.definition.name === 'data_profile');
    expect(profile).toBeDefined();
    if (!profile) throw new Error('data_profile was not contributed');
    await expect(profile.runtime.prepare({ input: join(outside, 'outside.json') }, prepareContext(profile.definition))).rejects.toThrow('inside the workspace');
    const prepared = await profile.runtime.prepare({ input: 'data.json' }, prepareContext(profile.definition));
    await rename(join(directory, 'data.json'), join(directory, 'data.original.json'));
    await writeFile(join(directory, 'data.json'), '[3]');
    await expect(profile.runtime.execute(prepared.input, executeContext(prepared))).rejects.toThrow('changed after approval');
  });

  it('honors cancellation before native data I/O', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'schemanaut-data-')); directories.push(directory);
    await writeFile(join(directory, 'data.json'), '[1]');
    const module = await createDataNotebookCapability({ ...host(() => Promise.resolve(unavailable())), workspaceRoot: directory }).load();
    const profile = (await module.activate()).contributions.tools?.find(tool => tool.definition.name === 'data_profile');
    expect(profile).toBeDefined();
    if (!profile) throw new Error('data_profile was not contributed');
    const prepared = await profile.runtime.prepare({ input: 'data.json' }, prepareContext(profile.definition));
    const controller = new AbortController(); controller.abort();
    await expect(profile.runtime.execute(prepared.input, executeContext(prepared, controller.signal))).rejects.toThrow('cancelled');
  });

  it('adds Jupyter execution only when externally available and creates no output at prepare', async () => {
    const prepared: Array<Record<string, unknown>> = [];
    const command = { prepare: (value: Record<string, unknown>) => { prepared.push(value); return Promise.resolve({}); } };
    const module = await createDataNotebookCapability(host(name => Promise.resolve(name === 'jupyter' ? available() : unavailable()), command)).load();
    const run = (await module.activate()).contributions.tools?.find(tool => tool.definition.name === 'notebook_run');
    await run?.runtime.prepare({ input: 'package.json', output: 'task5b-notebook-output.ipynb' }, {} as never);
    expect(run?.definition).toMatchObject({ access: 'write', recoveryClass: 'non_idempotent', dangerLevel: 'high' });
    expect(prepared[0]).toMatchObject({ argv: ['nbconvert', '--to', 'notebook', '--execute', '--output', 'task5b-notebook-output.ipynb', 'package.json'], requested: { unknownRisk: true, credentials: false } });
  });
});

function prepareContext(definition: { name: string; toolRevision: string; handlerRevision: string; intentRevision: string; limits: unknown }): ToolPrepareContext {
  return { hostId: 'host', projectId: 'project', sessionId: 'session', runId: 'run', turnId: 'turn', invocationId: 'invocation', idempotencyKey: 'key', runtimeState: {}, discoverableTools: [], discoverableCapabilities: [], descriptor: { flatName: definition.name }, runPolicy: { mode: 'default', revision: 'run-policy.v1' }, generation: 'data-generation@1', toolRevision: definition.toolRevision, handlerRevision: definition.handlerRevision, intentRevision: definition.intentRevision, limits: definition.limits, signal: new AbortController().signal } as never;
}
function executeContext(intent: PreparedToolIntent, signal = new AbortController().signal): ToolExecuteContext { return { hostId: 'host', projectId: 'project', sessionId: 'session', runId: 'run', turnId: 'turn', invocationId: 'invocation', idempotencyKey: 'key', runtimeState: {}, discoverableTools: [], discoverableCapabilities: [], intent, signal, deadline: new Date(Date.now() + 10_000).toISOString() } as never; }
async function invoke(tool: ToolInvocationContribution, input: Record<string, string>) { const prepared = await tool.runtime.prepare(input, prepareContext(tool.definition)); return tool.runtime.execute(prepared.input, executeContext(prepared)); }
