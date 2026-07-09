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
} from '@dbagent/core-tools';
import { DesktopMcpService, type McpSecretStore } from './mcp-service.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('DesktopMcpService', () => {
  it('saves secret env refs, starts an MCP server, and exposes only sanitized config', async () => {
    const harness = await createHarness();

    const result = await harness.service.upsert({
      id: 'company-tools',
      name: 'Company Tools',
      command: 'node',
      env: { PUBLIC_MODE: 'readonly' },
      secrets: { API_TOKEN: 'token-from-user' },
      start: true,
    });

    expect(result).toMatchObject({
      serverId: 'company-tools',
      tools: ['company-tools__echo'],
      running: true,
      health: { status: 'healthy', healthy: true },
      server: {
        env: {
          PUBLIC_MODE: { kind: 'plain' },
          API_TOKEN: { kind: 'secret-ref', ref: 'mcp:company-tools:env:API_TOKEN' },
        },
      },
    });
    expect(harness.secrets.values.get('mcp:company-tools:env:API_TOKEN')).toBe('token-from-user');
    expect(await harness.service.resolveSecret('mcp:company-tools:env:API_TOKEN')).toBe('token-from-user');
    expect(harness.registry.llmTools().map((tool) => tool.name)).toEqual(['company-tools__echo']);
    expect(await harness.service.list()).toMatchObject([
      {
        server: { id: 'company-tools', env: { API_TOKEN: { kind: 'secret-ref' } } },
        tools: ['company-tools__echo'],
        running: true,
      },
    ]);
  });

  it('stops and removes MCP servers without leaving stale Agent tools', async () => {
    const harness = await createHarness();
    await harness.service.upsert({
      id: 'warehouse',
      name: 'Warehouse',
      command: 'node',
      secrets: { API_TOKEN: 'secret' },
      start: true,
    });

    const stopped = await harness.service.stop('warehouse');

    expect(stopped).toMatchObject({
      serverId: 'warehouse',
      removedTools: ['warehouse__echo'],
      running: false,
      health: { status: 'stopped', healthy: false },
    });
    expect(harness.registry.llmTools()).toEqual([]);

    const removed = await harness.service.remove({ id: 'warehouse', deleteSecrets: true });

    expect(removed).toMatchObject({
      serverId: 'warehouse',
      removed: true,
      running: false,
      secretRefs: ['mcp:warehouse:env:API_TOKEN'],
    });
    expect(harness.secrets.values.has('mcp:warehouse:env:API_TOKEN')).toBe(false);
    await expect(harness.service.list()).resolves.toEqual([]);
  });

  it('marks disabled servers disabled and does not launch them', async () => {
    const harness = await createHarness();

    const result = await harness.service.upsert({
      id: 'disabled',
      name: 'Disabled',
      command: 'node',
      enabled: false,
      start: true,
    });

    expect(result).toMatchObject({
      serverId: 'disabled',
      tools: [],
      removedTools: [],
      running: false,
      health: { status: 'stopped', healthy: false },
    });
    await expect(harness.service.start('disabled')).resolves.toMatchObject({
      health: { status: 'disabled', healthy: false },
      tools: [],
      running: false,
    });
    expect(harness.launchedServers).toEqual([]);
  });
});

async function createHarness() {
  const registry = new ToolRegistry();
  const configStore = new McpConfigStore(await configPath(), {
    includeBuiltinDefaults: false,
    now: () => '2026-07-09T10:00:00.000Z',
  });
  const health = new McpHealthManager({ now: () => '2026-07-09T10:00:00.000Z' });
  const tools = new McpToolRegistrationManager(registry);
  const launchedServers: string[] = [];
  const runtime = new McpRuntimeManager({
    configStore,
    health,
    tools,
    launcher(server) {
      launchedServers.push(server.id);
      return fakeClient(server);
    },
  });
  const secrets = new MemorySecretStore();
  const service = new DesktopMcpService({ configStore, runtime, tools, secrets });
  return { service, registry, secrets, launchedServers };
}

function fakeClient(server: McpServerConfig): McpRuntimeClient {
  return {
    listTools() {
      return Promise.resolve([
        {
          name: 'echo',
          description: `Echo from ${server.id}`,
          inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
          annotations: { readOnlyHint: true },
        },
      ]);
    },
    callTool(toolName, args) {
      return { toolName, args };
    },
    stop() {
      return Promise.resolve();
    },
  };
}

class MemorySecretStore implements McpSecretStore {
  readonly values = new Map<string, string>();

  save(ref: string, value: string): Promise<void> {
    this.values.set(ref, value);
    return Promise.resolve();
  }

  load(ref: string): Promise<string | undefined> {
    return Promise.resolve(this.values.get(ref));
  }

  remove(ref: string): Promise<void> {
    this.values.delete(ref);
    return Promise.resolve();
  }
}

async function configPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-desktop-mcp-service-'));
  tempDirs.push(dir);
  return join(dir, 'mcp.json');
}
