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
  type McpMarketProvider,
  type McpRuntimeClient,
  type McpServerConfig,
  type StaticMcpMarketEntry,
} from '@dbagent/core-tools';
import { DesktopMcpMarketService } from './mcp-market-service.js';
import { DesktopMcpService, type McpSecretStore } from './mcp-service.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('DesktopMcpMarketService', () => {
  it('searches market providers and installs an entry through DesktopMcpService', async () => {
    const harness = await createHarness();

    await expect(harness.market.search({ query: 'secure' })).resolves.toMatchObject([
      {
        id: 'secure-tools',
        marketId: 'fixture-market',
        requiredEnv: [{ name: 'API_TOKEN', required: true, secret: true }],
      },
    ]);

    const installed = await harness.market.install({
      marketId: 'fixture-market',
      entryId: 'secure-tools',
      serverId: 'secure-prod',
      envSecrets: { API_TOKEN: 'secret-token' },
      start: true,
    });

    expect(installed).toMatchObject({
      serverId: 'secure-prod',
      running: true,
      tools: ['secure-prod__echo'],
      server: {
        source: 'market',
        marketEntryId: 'secure-tools',
        env: { API_TOKEN: { kind: 'secret-ref', ref: 'mcp:secure-prod:env:API_TOKEN' } },
      },
    });
    expect(harness.secrets.values.get('mcp:secure-prod:env:API_TOKEN')).toBe('secret-token');
    expect(harness.registry.llmTools().map((tool) => tool.name)).toEqual(['secure-prod__echo']);
  });

  it('rejects installs that omit required secret env values before writing config', async () => {
    const harness = await createHarness();

    await expect(
      harness.market.install({
        marketId: 'fixture-market',
        entryId: 'secure-tools',
      }),
    ).rejects.toThrow('MCP market entry requires env API_TOKEN.');
    await expect(harness.mcp.list()).resolves.toEqual([]);
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
  const runtime = new McpRuntimeManager({
    configStore,
    health,
    tools,
    launcher: (server) => fakeClient(server),
  });
  const secrets = new MemorySecretStore();
  const mcp = new DesktopMcpService({ configStore, runtime, tools, secrets });
  const market = new DesktopMcpMarketService(
    [fixtureProvider()],
    mcp,
  );
  return { market, mcp, registry, secrets };
}

function fixtureProvider(): McpMarketProvider {
  const entry = secureEntry();
  return {
    id: 'fixture-market',
    name: 'Fixture Market',
    search() {
      return [entry];
    },
    getInstallTemplate(entryId) {
      if (entryId !== entry.id) throw new Error(`MCP market entry not found: ${entryId}.`);
      return {
        entryId: entry.id,
        marketId: 'fixture-market',
        server: { ...entry.install.server, args: [...(entry.install.server.args ?? [])] },
        requiredEnv: entry.requiredEnv.map((item) => ({ ...item })),
      };
    },
  };
}

function fakeClient(server: McpServerConfig): McpRuntimeClient {
  return {
    listTools() {
      return Promise.resolve([
        {
          name: 'echo',
          description: `Echo from ${server.id}`,
          inputSchema: { type: 'object' },
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

function secureEntry(): StaticMcpMarketEntry {
  return {
    id: 'secure-tools',
    marketId: 'fixture-market',
    name: 'Secure Tools',
    description: 'Secure fixture MCP tools.',
    publisher: 'DBAgent Test',
    categories: ['security'],
    transport: 'stdio',
    packageName: '@example/secure-tools',
    requiredEnv: [{ name: 'API_TOKEN', required: true, secret: true }],
    install: {
      server: {
        id: 'secure-tools',
        name: 'Secure Tools',
        source: 'market',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@example/secure-tools'],
        autoStart: false,
        enabled: true,
        packageName: '@example/secure-tools',
      },
    },
  };
}

async function configPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-desktop-mcp-market-'));
  tempDirs.push(dir);
  return join(dir, 'mcp.json');
}
