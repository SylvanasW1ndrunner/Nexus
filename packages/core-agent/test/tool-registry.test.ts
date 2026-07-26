import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/index.js';

describe('ToolRegistry', () => {
  it('unregisters tools so stopped dynamic sources are no longer exposed to the model', () => {
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'mcp_server__read_status',
        description: 'Read MCP status',
        inputSchema: { type: 'object' },
        dangerLevel: 'safe',
        readonly: true,
      },
      () => ({ ok: true }),
    );

    expect(registry.has('mcp_server__read_status')).toBe(true);
    expect(registry.llmTools().map((tool) => tool.name)).toEqual(['mcp_server__read_status']);

    expect(registry.unregister('mcp_server__read_status')).toBe(true);
    expect(registry.has('mcp_server__read_status')).toBe(false);
    expect(registry.get('mcp_server__read_status')).toBeUndefined();
    expect(registry.llmTools()).toEqual([]);
  });

  it('returns false when unregistering a missing tool without changing existing tools', () => {
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'query_database',
        description: 'Query database',
        inputSchema: { type: 'object' },
        dangerLevel: 'safe',
        readonly: true,
      },
      () => ({ rows: [] }),
    );

    expect(registry.unregister('missing')).toBe(false);
    expect(registry.llmTools().map((tool) => tool.name)).toEqual(['query_database']);
  });

});
