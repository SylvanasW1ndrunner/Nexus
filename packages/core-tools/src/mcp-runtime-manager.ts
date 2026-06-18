import { McpConfigStore, type McpServerConfig } from './mcp-config-store.js';
import { McpHealthManager, type McpServerHealthState } from './mcp-health.js';
import { McpToolRegistrationManager } from './mcp-tool-registration-manager.js';
import type { McpToolSpec } from './mcp-tool-adapter.js';

export type McpRuntimeClient = {
  listTools(): Promise<McpToolSpec[]>;
  callTool(toolName: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> | unknown;
  stop(): Promise<void> | void;
};

export type McpRuntimeLauncher = (server: McpServerConfig) => Promise<McpRuntimeClient> | McpRuntimeClient;

export type McpRuntimeStartResult = {
  server: McpServerConfig;
  tools: string[];
  health: McpServerHealthState;
};

export type McpRuntimeStopResult = {
  serverId: string;
  removedTools: string[];
  health: McpServerHealthState;
};

export class McpRuntimeManager {
  private readonly clients = new Map<string, McpRuntimeClient>();

  constructor(
    private readonly options: {
      configStore: McpConfigStore;
      health: McpHealthManager;
      tools: McpToolRegistrationManager;
      launcher: McpRuntimeLauncher;
    },
  ) {}

  async start(serverId: string): Promise<McpRuntimeStartResult> {
    const server = await this.requireServer(serverId);
    if (!server.enabled) {
      return {
        server,
        tools: [],
        health: this.options.health.disable(server.id, 'MCP server is disabled.'),
      };
    }

    await this.stop(server.id);
    this.options.health.markStarting(server.id);

    try {
      const client = await this.options.launcher(server);
      const specs = await client.listTools();
      const registered = this.options.tools.registerServerTools({
        serverId: server.id,
        source: server.source === 'market' ? 'market-mcp' : 'user-mcp',
        tools: specs,
        health: this.options.health,
        callTool: ({ toolName, args, signal }) => client.callTool(toolName, args, signal),
      });
      this.clients.set(server.id, client);
      const health = this.options.health.markHealthy(server.id);
      return {
        server,
        tools: registered.map((tool) => tool.name),
        health,
      };
    } catch (error) {
      this.options.tools.unregisterServerTools(server.id);
      this.clients.delete(server.id);
      return {
        server,
        tools: [],
        health: this.options.health.markUnhealthy(server.id, errorMessage(error)),
      };
    }
  }

  async stop(serverId: string): Promise<McpRuntimeStopResult> {
    const client = this.clients.get(serverId);
    const removedTools = this.options.tools.unregisterServerTools(serverId).map((tool) => tool.name);
    this.clients.delete(serverId);
    if (client) await client.stop();
    return {
      serverId,
      removedTools,
      health: this.options.health.markStopped(serverId),
    };
  }

  async startAutoStart(): Promise<McpRuntimeStartResult[]> {
    const servers = await this.options.configStore.list();
    const results: McpRuntimeStartResult[] = [];
    for (const server of servers) {
      if (server.autoStart && server.enabled) {
        results.push(await this.start(server.id));
      }
    }
    return results;
  }

  health(serverId: string): McpServerHealthState {
    return this.options.health.get(serverId);
  }

  listHealth(): McpServerHealthState[] {
    return this.options.health.list();
  }

  isRunning(serverId: string): boolean {
    return this.clients.has(serverId);
  }

  private async requireServer(serverId: string): Promise<McpServerConfig> {
    const server = (await this.options.configStore.list()).find((item) => item.id === serverId);
    if (!server) throw new Error(`MCP server not found: ${serverId}.`);
    return server;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
