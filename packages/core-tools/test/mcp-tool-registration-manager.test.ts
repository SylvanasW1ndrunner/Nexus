import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '@dbagent/core-agent';
import { McpHealthManager, McpToolRegistrationManager } from '../src/index.js';

describe('McpToolRegistrationManager', () => {
  it('registers and unregisters all tools for a stopped MCP server', () => {
    const registry = new ToolRegistry();
    const manager = new McpToolRegistrationManager(registry);
    const health = new McpHealthManager();
    health.markHealthy('warehouse');

    const registered = manager.registerServerTools({
      serverId: 'warehouse',
      source: 'user-mcp',
      health,
      tools: [
        { name: 'list_tables', annotations: { readOnlyHint: true } },
        { name: 'describe_table', annotations: { readOnlyHint: true } },
      ],
      callTool: () => ({ ok: true }),
    });

    expect(registered.map((tool) => tool.name)).toEqual([
      'warehouse__list_tables',
      'warehouse__describe_table',
    ]);
    expect(registry.llmTools().map((tool) => tool.name)).toEqual([
      'warehouse__list_tables',
      'warehouse__describe_table',
    ]);
    expect(manager.listServerTools('warehouse')).toHaveLength(2);

    expect(manager.unregisterServerTools('warehouse').map((tool) => tool.name)).toEqual([
      'warehouse__list_tables',
      'warehouse__describe_table',
    ]);
    expect(registry.llmTools()).toEqual([]);
    expect(manager.listServerTools('warehouse')).toEqual([]);
  });

  it('replaces tools when an MCP server restarts with a changed tool list', () => {
    const registry = new ToolRegistry();
    const manager = new McpToolRegistrationManager(registry);

    manager.registerServerTools({
      serverId: 'company-tools',
      source: 'user-mcp',
      tools: [{ name: 'old_tool', annotations: { readOnlyHint: true } }],
      callTool: () => 'old',
    });
    manager.registerServerTools({
      serverId: 'company-tools',
      source: 'user-mcp',
      tools: [{ name: 'new_tool', annotations: { readOnlyHint: true } }],
      callTool: () => 'new',
    });

    expect(registry.has('company-tools__old_tool')).toBe(false);
    expect(registry.has('company-tools__new_tool')).toBe(true);
    expect(manager.listAll().map((tool) => tool.name)).toEqual(['company-tools__new_tool']);
  });

  it('rolls back partially registered tools when a malformed MCP tool list fails', () => {
    const registry = new ToolRegistry();
    const manager = new McpToolRegistrationManager(registry);
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

    expect(() =>
      manager.registerServerTools({
        serverId: 'broken',
        source: 'user-mcp',
        tools: [
          { name: 'read_status', annotations: { readOnlyHint: true } },
          { name: '   ', annotations: { readOnlyHint: true } },
        ],
        callTool: () => ({ ok: true }),
      }),
    ).toThrow('MCP tool name is required');

    expect(registry.llmTools().map((tool) => tool.name)).toEqual(['query_database']);
    expect(manager.listServerTools('broken')).toEqual([]);
  });

  it('rolls back only tools from the failed MCP registration when ToolRegistry reports a collision', () => {
    const registry = new ToolRegistry();
    const manager = new McpToolRegistrationManager(registry);
    registry.register(
      {
        name: 'broken__second',
        description: 'Existing unrelated tool',
        inputSchema: { type: 'object' },
        dangerLevel: 'safe',
        readonly: true,
      },
      () => ({ source: 'existing' }),
    );

    expect(() =>
      manager.registerServerTools({
        serverId: 'broken',
        source: 'user-mcp',
        tools: [
          { name: 'first', inputSchema: { type: 'object' } },
          { name: 'second', inputSchema: { type: 'object' } },
        ],
        callTool: () => ({ ok: true }),
      }),
    ).toThrow('Tool already registered: broken__second');

    expect(registry.has('broken__first')).toBe(false);
    expect(registry.has('broken__second')).toBe(true);
    expect(manager.listServerTools('broken')).toEqual([]);
  });
});
