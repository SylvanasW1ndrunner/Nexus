import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolRegistry } from '@dbagent/core-agent';
import {
  createStdioMcpRuntimeLauncher,
  McpConfigStore,
  McpHealthManager,
  type McpHealthManagerOptions,
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
    expect(harness.registry.llmTools().map((tool) => tool.name)).toEqual(['warehouse__list_tables']);
  });

  it('reacts to a real stdio process exit by removing stale Agent tools', async () => {
    const script = await exitAfterToolsListServer();
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
      args: [script],
      enabled: true,
      autoStart: false,
    });

    const started = await harness.runtime.start('volatile');

    expect(started.tools).toEqual(['volatile__echo']);
    expect(harness.registry.llmTools().map((tool) => tool.name)).toEqual(['volatile__echo']);

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
    launcher?: (server: McpServerConfig) => McpRuntimeClient;
    health?: McpHealthManagerOptions;
  } = {},
) {
  const registry = new ToolRegistry();
  const health = new McpHealthManager(input.health);
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
          listTools() {
            return Promise.resolve([{ name: 'list_tables', annotations: { readOnlyHint: true } }]);
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

async function exitAfterToolsListServer(): Promise<string> {
  return writeScript(`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
function send(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n'); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') send(msg.id, { protocolVersion: '2024-11-05', capabilities: {} });
  if (msg.method === 'tools/list') {
    send(msg.id, { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] });
    setTimeout(() => process.exit(9), 20);
  }
});
`);
}

async function writeScript(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-mcp-runtime-process-'));
  tempDirs.push(dir);
  const path = join(dir, 'server.cjs');
  await writeFile(path, source, 'utf8');
  return path;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for condition.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
