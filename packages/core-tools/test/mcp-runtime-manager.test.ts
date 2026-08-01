import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolRegistry, isAgentToolResultEnvelope } from '@dbagent/core-agent';
import {
  createStdioMcpRuntimeLauncher,
  McpConfigStore,
  McpHealthManager,
  type McpHealthManagerOptions,
  McpRuntimeManager,
  McpToolRegistrationManager,
  type McpRuntimeLauncher,
  type McpToolSpec,
} from '../src/index.js';

const tempDirs: string[] = [];
const FIXTURE_SERVER = fileURLToPath(new URL('./fixtures/mcp-fixture-server.mjs', import.meta.url));

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
    expect(result.descriptor).toMatchObject({
      serverId: 'warehouse',
      capabilities: { tools: { listChanged: true } },
    });
    expect(result.health.status).toBe('healthy');
    expect(harness.runtime.isRunning('warehouse')).toBe(true);
    await expect(harness.runtime.ping('warehouse')).resolves.toBeUndefined();
    await expect(harness.runtime.listResources('warehouse')).resolves.toEqual([]);
    await expect(harness.runtime.listResourceTemplates('warehouse')).resolves.toEqual([]);
    await expect(harness.runtime.readResource('warehouse', 'fixture://empty')).resolves.toEqual({
      contents: [],
    });
    await expect(harness.runtime.listPrompts('warehouse')).resolves.toEqual([]);
    await expect(harness.runtime.getPrompt('warehouse', 'empty')).resolves.toEqual({
      messages: [],
    });
    const toolResult = await harness.registry
      .get('warehouse__list_tables')
      ?.handler({ schema: 'public' }, toolContext());
    expect(isAgentToolResultEnvelope(toolResult)).toBe(true);
    if (!isAgentToolResultEnvelope(toolResult)) throw new Error('Expected MCP result envelope.');
    expect(toolResult.modelProjection).toEqual({
      toolName: 'list_tables',
      args: { schema: 'public' },
    });
  });

  it('coalesces concurrent starts and keeps repeated starts idempotent', async () => {
    const harness = await runtimeHarness();
    await harness.store.upsert({
      id: 'warehouse',
      name: 'Warehouse Tools',
      command: 'node',
    });

    const first = harness.runtime.start('warehouse');
    const second = harness.runtime.start('warehouse');
    const [firstResult, secondResult] = await Promise.all([first, second]);
    const repeated = await harness.runtime.start('warehouse');

    expect(second).toBe(first);
    expect(secondResult).toEqual(firstResult);
    expect(repeated.tools).toEqual(['warehouse__list_tables']);
    expect(harness.launchedServers).toEqual(['warehouse']);
    expect(harness.stoppedClients).toEqual([]);
  });

  it('restarts a healthy client when its launch configuration changed', async () => {
    const harness = await runtimeHarness();
    await harness.store.upsert({
      id: 'warehouse',
      name: 'Warehouse Tools',
      command: 'node',
      args: ['first.mjs'],
    });
    await harness.runtime.start('warehouse');
    await harness.store.upsert({
      id: 'warehouse',
      name: 'Warehouse Tools',
      command: 'node',
      args: ['second.mjs'],
    });

    await harness.runtime.start('warehouse');

    expect(harness.launchedServers).toEqual(['warehouse', 'warehouse']);
    expect(harness.stoppedClients).toEqual(['warehouse']);
    expect(harness.runtime.isRunning('warehouse')).toBe(true);
  });

  it('serializes a start-stop-start race and leaves exactly the final client running', async () => {
    const harness = await runtimeHarness();
    await harness.store.upsert({
      id: 'warehouse',
      name: 'Warehouse Tools',
      command: 'node',
    });

    const firstStart = harness.runtime.start('warehouse');
    const stop = harness.runtime.stop('warehouse');
    const finalStart = harness.runtime.start('warehouse');
    await Promise.all([firstStart, stop, finalStart]);

    expect(harness.launchedServers).toEqual(['warehouse', 'warehouse']);
    expect(harness.stoppedClients).toEqual(['warehouse']);
    expect(harness.runtime.isRunning('warehouse')).toBe(true);
    expect(harness.registry.llmTools().map((tool) => tool.name)).toEqual([
      'warehouse__list_tables',
    ]);
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

  it('stops every running MCP server during runtime shutdown without touching inactive configs', async () => {
    const harness = await runtimeHarness();
    await harness.store.upsert({
      id: 'alpha',
      name: 'Alpha Tools',
      command: 'node',
    });
    await harness.store.upsert({
      id: 'beta',
      name: 'Beta Tools',
      command: 'node',
    });
    await harness.store.upsert({
      id: 'inactive',
      name: 'Inactive Tools',
      command: 'node',
    });
    await harness.runtime.start('beta');
    await harness.runtime.start('alpha');

    const stopped = await harness.runtime.stopAll();

    expect(stopped.map((result) => result.serverId)).toEqual(['alpha', 'beta']);
    expect(harness.stoppedClients).toEqual(['alpha', 'beta']);
    expect(harness.registry.llmTools()).toEqual([]);
    expect(harness.runtime.isRunning('alpha')).toBe(false);
    expect(harness.runtime.isRunning('beta')).toBe(false);
    expect(harness.runtime.health('inactive').status).toBe('stopped');
  });

  it('does not launch disabled MCP servers and marks them disabled', async () => {
    const harness = await runtimeHarness();
    await harness.store.upsert({
      id: 'disabled',
      name: 'Disabled',
      command: 'node',
      enabled: false,
    });

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
    await harness.store.upsert({
      id: 'disabled',
      name: 'Disabled',
      command: 'node',
      autoStart: true,
      enabled: false,
    });

    const results = await harness.runtime.startAutoStart();

    expect(results.map((result) => result.server.id)).toEqual(['auto']);
    expect(harness.launchedServers).toEqual(['auto']);
    expect(harness.registry.llmTools().map((tool) => tool.name)).toEqual(['auto__list_tables']);
  });

  it('does not auto-start servers whose autoStart flag was omitted', async () => {
    const harness = await runtimeHarness();
    await harness.store.upsert({
      id: 'manual',
      name: 'Manual',
      command: 'node',
    });

    await expect(harness.runtime.startAutoStart()).resolves.toEqual([]);
    expect(harness.launchedServers).toEqual([]);
    expect(harness.runtime.isRunning('manual')).toBe(false);
  });

  it('atomically replaces Agent tools when the MCP server emits tools/list_changed', async () => {
    const harness = await runtimeHarness();
    await harness.store.upsert({ id: 'warehouse', name: 'Warehouse Tools', command: 'node' });
    await harness.runtime.start('warehouse');

    harness.emitToolsChanged('warehouse', [
      {
        name: 'inspect_query',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
      },
    ]);

    expect(harness.registry.has('warehouse__list_tables')).toBe(false);
    expect(harness.registry.has('warehouse__inspect_query')).toBe(true);
    expect(harness.runtime.health('warehouse')).toMatchObject({
      status: 'healthy',
      healthy: true,
    });

    harness.emitToolsChanged('warehouse', new Error('malformed tool page'));

    expect(harness.registry.llmTools()).toEqual([]);
    expect(harness.runtime.health('warehouse')).toMatchObject({
      status: 'unhealthy',
      healthy: false,
      lastError: 'MCP tools refresh failed: malformed tool page',
    });
  });

  it('unregisters tools on unexpected exit and restarts due servers without exposing stale tools', async () => {
    let now = '2026-06-18T10:00:00.000Z';
    const harness = await runtimeHarness({
      health: {
        baseRestartDelayMs: 1_000,
        now: () => now,
      },
    });
    await harness.store.upsert({ id: 'warehouse', name: 'Warehouse Tools', command: 'node' });
    await harness.runtime.start('warehouse');

    const exited = harness.runtime.recordExit('warehouse', { code: 1 });

    expect(exited.removedTools).toEqual(['warehouse__list_tables']);
    expect(exited.health).toMatchObject({
      status: 'restarting',
      healthy: false,
      restartCount: 1,
      nextRestartAt: '2026-06-18T10:00:01.000Z',
    });
    expect(harness.runtime.isRunning('warehouse')).toBe(false);
    expect(harness.registry.llmTools()).toEqual([]);

    await expect(harness.runtime.restartDue('2026-06-18T10:00:00.999Z')).resolves.toEqual([]);
    expect(harness.launchedServers).toEqual(['warehouse']);

    now = '2026-06-18T10:00:01.000Z';
    const restarted = await harness.runtime.restartDue(now);

    expect(restarted).toMatchObject([
      {
        server: { id: 'warehouse' },
        tools: ['warehouse__list_tables'],
        health: { status: 'healthy', healthy: true },
      },
    ]);
    expect(harness.launchedServers).toEqual(['warehouse', 'warehouse']);
    expect(harness.runtime.isRunning('warehouse')).toBe(true);
    expect(harness.registry.llmTools().map((tool) => tool.name)).toEqual([
      'warehouse__list_tables',
    ]);
  });

  it('reacts to a real stdio process exit by removing stale Agent tools', async () => {
    const harness = await runtimeHarness({
      health: {
        baseRestartDelayMs: 1_000,
        now: () => '2026-06-18T10:00:00.000Z',
      },
      launcher: createStdioMcpRuntimeLauncher({ requestTimeoutMs: 1_000 }),
    });
    await harness.store.upsert({
      id: 'volatile',
      name: 'Volatile MCP',
      source: 'user',
      transport: 'stdio',
      command: process.execPath,
      args: [FIXTURE_SERVER, 'exit-after-list'],
      enabled: true,
      autoStart: false,
    });

    const started = await harness.runtime.start('volatile');

    expect(started.tools).toEqual([
      'volatile__echo',
      'volatile__replace_catalog',
      'volatile__logical_error',
      'volatile__slow',
      'volatile__crash',
    ]);
    expect(harness.registry.llmTools().map((tool) => tool.name)).toEqual(started.tools);

    await waitFor(() => !harness.runtime.isRunning('volatile'));

    expect(harness.registry.llmTools()).toEqual([]);
    expect(harness.runtime.health('volatile')).toMatchObject({
      status: 'restarting',
      healthy: false,
      restartCount: 1,
    });
    expect(harness.runtime.health('volatile').nextRestartAt).toBeDefined();
  });
});

async function runtimeHarness(
  input: {
    launcher?: McpRuntimeLauncher;
    health?: McpHealthManagerOptions;
  } = {},
) {
  const registry = new ToolRegistry();
  const health = new McpHealthManager(input.health);
  const store = new McpConfigStore(await configPath());
  const tools = new McpToolRegistrationManager(registry);
  const launchedServers: string[] = [];
  const stoppedClients: string[] = [];
  const toolChangeHandlers = new Map<
    string,
    (event: { items: McpToolSpec[] } | { error: Error }) => void
  >();
  const runtime = new McpRuntimeManager({
    configStore: store,
    health,
    tools,
    launcher:
      input.launcher ??
      ((server) => {
        launchedServers.push(server.id);
        return {
          describe() {
            return {
              serverId: server.id,
              transport: server.transport,
              capabilities: { tools: { listChanged: true } },
              serverInfo: { name: server.name, version: '1.0.0' },
            };
          },
          ping() {
            return Promise.resolve();
          },
          listTools() {
            return Promise.resolve([{ name: 'list_tables', annotations: { readOnlyHint: true } }]);
          },
          callTool(toolName, args) {
            return { toolName, args };
          },
          stop() {
            stoppedClients.push(server.id);
          },
          listResources() {
            return Promise.resolve([]);
          },
          listResourceTemplates() {
            return Promise.resolve([]);
          },
          readResource() {
            return Promise.resolve({ contents: [] });
          },
          listPrompts() {
            return Promise.resolve([]);
          },
          getPrompt() {
            return Promise.resolve({ messages: [] });
          },
          onToolsChanged(handler) {
            toolChangeHandlers.set(server.id, handler);
            return () => toolChangeHandlers.delete(server.id);
          },
        };
      }),
  });
  return {
    registry,
    health,
    store,
    runtime,
    launchedServers,
    stoppedClients,
    emitToolsChanged(serverId: string, input: McpToolSpec[] | Error) {
      const handler = toolChangeHandlers.get(serverId);
      if (!handler) throw new Error(`Missing tools change handler for ${serverId}.`);
      if (input instanceof Error) handler({ error: input });
      else handler({ items: input });
    },
  };
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
      mode: 'read' as const,
      messages: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      aborted: false,
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for condition.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
