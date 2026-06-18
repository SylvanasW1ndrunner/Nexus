import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolRegistry } from '@dbagent/core-agent';
import {
  McpConfigStore,
  McpHealthManager,
  McpRuntimeManager,
  McpToolRegistrationManager,
  type McpRuntimeClient,
  type McpServerConfig,
} from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('McpRuntimeManager', () => {
  it('starts an enabled MCP server, lists tools, registers them and invokes through ToolRegistry', async () => {
    const harness = await runtimeHarness();

    await harness.store.upsert({
      id: 'warehouse',
      name: 'Warehouse Tools',
      command: 'node',
      enabled: true,
      autoStart: true,
    });

    const result = await harness.runtime.start('warehouse');

    expect(result.tools).toEqual(['warehouse__list_tables']);
    expect(result.health.status).toBe('healthy');
    expect(harness.runtime.isRunning('warehouse')).toBe(true);
    await expect(
      harness.registry.get('warehouse__list_tables')?.handler({ schema: 'public' }, toolContext()),
    ).resolves.toEqual({
      toolName: 'list_tables',
      args: { schema: 'public' },
    });
  });

  it('stops a running MCP server and removes its tools from Agent exposure', async () => {
    const harness = await runtimeHarness();
    await harness.store.upsert({ id: 'warehouse', name: 'Warehouse Tools', command: 'node' });
    await harness.runtime.start('warehouse');

    const stopped = await harness.runtime.stop('warehouse');

    expect(stopped.removedTools).toEqual(['warehouse__list_tables']);
    expect(stopped.health.status).toBe('stopped');
    expect(harness.runtime.isRunning('warehouse')).toBe(false);
    expect(harness.registry.llmTools()).toEqual([]);
    expect(harness.stoppedClients).toEqual(['warehouse']);
  });

  it('does not launch disabled MCP servers and marks them disabled', async () => {
    const harness = await runtimeHarness();
    await harness.store.upsert({ id: 'disabled', name: 'Disabled', command: 'node', enabled: false });

    const result = await harness.runtime.start('disabled');

    expect(result.tools).toEqual([]);
    expect(result.health.status).toBe('disabled');
    expect(harness.launchedServers).toEqual([]);
    expect(harness.registry.llmTools()).toEqual([]);
  });

  it('marks failed starts unhealthy and does not leave half-registered tools', async () => {
    const harness = await runtimeHarness({
      launcher: () => {
        throw new Error('spawn ENOENT');
      },
    });
    await harness.store.upsert({ id: 'broken', name: 'Broken', command: 'missing' });

    const result = await harness.runtime.start('broken');

    expect(result.health).toMatchObject({
      status: 'unhealthy',
      healthy: false,
      lastError: 'spawn ENOENT',
    });
    expect(harness.registry.llmTools()).toEqual([]);
  });

  it('starts only enabled autoStart servers', async () => {
    const harness = await runtimeHarness();
    await harness.store.upsert({ id: 'auto', name: 'Auto', command: 'node', autoStart: true });
    await harness.store.upsert({ id: 'manual', name: 'Manual', command: 'node', autoStart: false });
    await harness.store.upsert({ id: 'disabled', name: 'Disabled', command: 'node', autoStart: true, enabled: false });

    const results = await harness.runtime.startAutoStart();

    expect(results.map((result) => result.server.id)).toEqual(['auto']);
    expect(harness.launchedServers).toEqual(['auto']);
    expect(harness.registry.llmTools().map((tool) => tool.name)).toEqual(['auto__list_tables']);
  });
});

async function runtimeHarness(input: { launcher?: (server: McpServerConfig) => McpRuntimeClient } = {}) {
  const registry = new ToolRegistry();
  const health = new McpHealthManager();
  const store = new McpConfigStore(await configPath(), { includeBuiltinDefaults: false });
  const tools = new McpToolRegistrationManager(registry);
  const launchedServers: string[] = [];
  const stoppedClients: string[] = [];
  const runtime = new McpRuntimeManager({
    configStore: store,
    health,
    tools,
    launcher:
      input.launcher ??
      ((server) => {
        launchedServers.push(server.id);
        return {
          async listTools() {
            return [{ name: 'list_tables', annotations: { readOnlyHint: true } }];
          },
          callTool(toolName, args) {
            return { toolName, args };
          },
          stop() {
            stoppedClients.push(server.id);
          },
        };
      }),
  });
  return { registry, health, store, runtime, launchedServers, stoppedClients };
}

async function configPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-mcp-runtime-'));
  tempDirs.push(dir);
  return join(dir, 'mcp.json');
}

function toolContext() {
  return {
    session: {
      id: 'session_mcp_runtime',
      title: 'mcp runtime',
      mode: 'readonly' as const,
      strategy: 'react' as const,
      messages: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      aborted: false,
    },
  };
}
