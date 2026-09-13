import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '@dbagent/core-agent';
import { McpToolRegistrationManager } from '../src/index.js';

describe('McpToolRegistrationManager', () => {
  it('installs and removes one server-owned prepared generation', () => {
    const registry = new ToolRegistry();
    const manager = new McpToolRegistrationManager(registry);
    expect(manager.registerServerTools({ serverId: 'warehouse', source: 'user-mcp', generationId: 'generation-a', tools: [{ name: 'list_tables', annotations: { readOnlyHint: true } }], callTool: () => ({ rows: [] }) })).toEqual([{ name: 'warehouse__list_tables', originalName: 'list_tables', source: 'user-mcp', sourceId: 'warehouse' }]);
    expect(registry.get('warehouse__list_tables')?.descriptor).toMatchObject({ exposure: 'deferred', access: 'external', recoveryClass: 'read' });
    expect(manager.unregisterServerTools('warehouse').map(({ name }) => name)).toEqual(['warehouse__list_tables']);
    expect(registry.get('warehouse__list_tables')).toBeUndefined();
  });

  it('keeps a replaced generation alive until its captured snapshot drains', async () => {
    const registry = new ToolRegistry();
    const manager = new McpToolRegistrationManager(registry);
    manager.registerServerTools({ serverId: 'warehouse', source: 'user-mcp', generationId: 'generation-a', tools: [{ name: 'probe', annotations: { readOnlyHint: true } }], callTool: () => ({ generation: 'a' }) });
    const old = registry.captureSnapshot();
    manager.registerServerTools({ serverId: 'warehouse', source: 'user-mcp', generationId: 'generation-b', tools: [{ name: 'probe', annotations: { readOnlyHint: true } }], callTool: () => ({ generation: 'b' }) });
    let drained = false;
    const drain = manager.drainServerTools('warehouse').then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    old.release();
    await drain;
    expect(drained).toBe(true);
  });
});
