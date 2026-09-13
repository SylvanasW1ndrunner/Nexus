import { describe, expect, it } from 'vitest';
import { adaptMcpToolDefinition, prepareMcpTools } from '../src/index.js';

describe('MCP prepared adapter', () => {
  it('uses MCP annotations as the normalized external permission contract', () => {
    const definition = adaptMcpToolDefinition({ serverId: 'warehouse', source: 'user-mcp', generationId: 'generation-a', tool: { name: 'list_tables', annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }, inputSchema: { type: 'object' } } });
    expect(definition).toMatchObject({ name: 'warehouse__list_tables', exposure: 'deferred', readonly: true, access: 'external', recoveryClass: 'read', permission: { network: false, externalWrite: false }, protocolMetadata: { annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } } });
  });

  it('rejects malformed metadata and oversized catalogs before registration', () => {
    expect(() => prepareMcpTools({ serverId: 'fixture', source: 'user-mcp', tools: [{ name: 'bad', annotations: { readOnlyHint: 'yes' } } as never], callTool: () => ({}) })).toThrow(/annotation/i);
    expect(() => prepareMcpTools({ serverId: 'fixture', source: 'user-mcp', tools: Array.from({ length: 129 }, (_, index) => ({ name: `tool_${index}` })), callTool: () => ({}) })).toThrow(/128-Tool limit/);
  });

  it('declares a bounded external payload output and generation-bound handler', () => {
    const prepared = prepareMcpTools({ serverId: 'fixture', source: 'user-mcp', generationId: 'generation-a', tools: [{ name: 'probe', annotations: { readOnlyHint: true, openWorldHint: false } }], callTool: () => ({ rows: [{ id: 1 }] }) });
    expect(prepared.contributions[0]?.definition.outputSchema).toMatchObject({ required: ['status', 'summary', 'externalPayload'] });
    expect(prepared.contributions[0]?.definition.handlerRevision).toContain('mcp-handler.v2');
  });
});
