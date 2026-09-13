import { describe, expect, it } from 'vitest';
import { createDocumentCapability } from '../src/document-capability.js';
import { available, host, unavailable } from './helpers.js';

describe('Documents capability', () => {
  it('is degraded per externally installed document CLI and publishes available operations', async () => {
    const module = await createDocumentCapability(host(name => Promise.resolve(name === 'pdfinfo' ? available() : unavailable()))).load();
    const probe = await module.probe?.();
    expect(probe).toMatchObject({ status: 'degraded' });
    const tools = (await module.activate()).contributions.tools ?? [];
    expect(tools.map(tool => tool.definition.name)).toEqual(['document_metadata']);
  });

  it('uses explicit command paths and never overwrites a target before approval', async () => {
    const prepared: Array<Record<string, unknown>> = [];
    const command = { prepare: (value: Record<string, unknown>) => { prepared.push(value); return Promise.resolve({}); } };
    const module = await createDocumentCapability(host(() => Promise.resolve(available()), command)).load();
    const tools = (await module.activate()).contributions.tools ?? [];
    const metadata = tools.find(tool => tool.definition.name === 'document_metadata');
    const extract = tools.find(tool => tool.definition.name === 'document_extract');
    const convert = tools.find(tool => tool.definition.name === 'document_convert');
    await metadata?.runtime.prepare({ input: 'package.json' }, {} as never);
    await extract?.runtime.prepare({ input: 'package.json' }, {} as never);
    await expect(convert?.runtime.prepare({ input: 'package.json', output: 'package.json' }, {} as never)).rejects.toThrow('output already exists');
    expect(prepared.map(value => value.argv)).toEqual([['package.json'], ['package.json', '-']]);
  });
});
