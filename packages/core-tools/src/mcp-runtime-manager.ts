import type { McpConfigStore, McpServerConfig } from './mcp-config-store.js';
import type { McpHealthManager, McpServerHealthState } from './mcp-health.js';
import type { McpToolRegistrationManager } from './mcp-tool-registration-manager.js';
import type { McpToolSpec } from './mcp-tool-adapter.js';

export type McpServerDescriptor = {
  serverId: string;
  transport: McpServerConfig['transport'];
  capabilities: Record<string, unknown>;
  serverInfo?: Record<string, unknown>;
  instructions?: string;
};

export type McpResourceSpec = Record<string, unknown> & {
  uri: string;
  name: string;
};

export type McpResourceTemplateSpec = Record<string, unknown> & {
  uriTemplate: string;
  name: string;
};

export type McpPromptSpec = Record<string, unknown> & {
  name: string;
};

export type McpReadResourceResult = Record<string, unknown> & {
  contents: unknown[];
};

export type McpGetPromptResult = Record<string, unknown> & {
  messages: unknown[];
};

export type McpListChangedEvent<T> =
  | { items: T[]; error?: never }
  | { items?: never; error: Error };

export type McpRuntimeClient = {
  describe(): McpServerDescriptor;
  ping(signal?: AbortSignal): Promise<void>;
  listTools(): Promise<McpToolSpec[]>;
  callTool(toolName: string, args: Record<string, unknown>, signal: AbortSignal): unknown;
  listResources(signal?: AbortSignal): Promise<McpResourceSpec[]>;
  listResourceTemplates(signal?: AbortSignal): Promise<McpResourceTemplateSpec[]>;
  readResource(uri: string, signal?: AbortSignal): Promise<McpReadResourceResult>;
  listPrompts(signal?: AbortSignal): Promise<McpPromptSpec[]>;
  getPrompt(
    name: string,
    args?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<McpGetPromptResult>;
  stop(): Promise<void> | void;
  onExit?(handler: (event: McpRuntimeExitEvent) => void): () => void;
  onToolsChanged?(handler: (event: McpListChangedEvent<McpToolSpec>) => void): () => void;
  onResourcesChanged?(handler: (event: McpListChangedEvent<McpResourceSpec>) => void): () => void;
  onPromptsChanged?(handler: (event: McpListChangedEvent<McpPromptSpec>) => void): () => void;
};

export type McpRuntimeLauncher = (
  server: McpServerConfig,
) => Promise<McpRuntimeClient> | McpRuntimeClient;

export type McpRuntimeExitEvent = {
  code?: number;
  signal?: string;
  errorMessage?: string;
  stderrPreview?: string;
  at?: string;
};

export type McpRuntimeStartResult = {
  server: McpServerConfig;
  tools: string[];
  descriptor?: McpServerDescriptor;
  health: McpServerHealthState;
};

export type McpRuntimeStopResult = {
  serverId: string;
  removedTools: string[];
  health: McpServerHealthState;
};

export type McpRuntimeExitResult = {
  serverId: string;
  removedTools: string[];
  health: McpServerHealthState;
};

export class McpRuntimeManager {
  private readonly clients = new Map<
    string,
    {
      client: McpRuntimeClient;
      server: McpServerConfig;
      unsubscribers: Array<() => void>;
    }
  >();
  private readonly lifecycleTails = new Map<string, Promise<void>>();
  private readonly coalescibleStarts = new Map<string, Promise<McpRuntimeStartResult>>();

  constructor(
    private readonly options: {
      configStore: McpConfigStore;
      health: McpHealthManager;
      tools: McpToolRegistrationManager;
      launcher: McpRuntimeLauncher;
    },
  ) {}

  start(serverId: string): Promise<McpRuntimeStartResult> {
    const pending = this.coalescibleStarts.get(serverId);
    if (pending) return pending;

    const operation = this.enqueueLifecycle(serverId, () => this.startUnlocked(serverId));
    this.coalescibleStarts.set(serverId, operation);
    const clear = () => {
      if (this.coalescibleStarts.get(serverId) === operation) {
        this.coalescibleStarts.delete(serverId);
      }
    };
    void operation.then(clear, clear);
    return operation;
  }

  private async startUnlocked(serverId: string): Promise<McpRuntimeStartResult> {
    const server = await this.requireServer(serverId);
    if (!server.enabled) {
      await this.stopUnlocked(server.id);
      return {
        server,
        tools: [],
        health: this.options.health.disable(server.id, 'MCP server is disabled.'),
      };
    }

    const running = this.clients.get(server.id);
    if (
      running &&
      this.options.health.get(server.id).status === 'healthy' &&
      sameLaunchConfiguration(running.server, server)
    ) {
      return {
        server,
        tools: this.options.tools.listServerTools(server.id).map((tool) => tool.name),
        descriptor: running.client.describe(),
        health: this.options.health.get(server.id),
      };
    }
    if (running) await this.stopUnlocked(server.id);
    this.options.health.markStarting(server.id);

    let client: McpRuntimeClient | undefined;
    try {
      const launchedClient = await this.options.launcher(server);
      client = launchedClient;
      const specs = await launchedClient.listTools();
      const registered = this.options.tools.registerServerTools({
        serverId: server.id,
        source: 'user-mcp',
        tools: specs,
        health: this.options.health,
        callTool: ({ toolName, args, signal }) => launchedClient.callTool(toolName, args, signal),
      });
      const running = {
        client: launchedClient,
        server,
        unsubscribers: [] as Array<() => void>,
      };
      this.clients.set(server.id, running);
      const unsubscribeExit = launchedClient.onExit?.((event) => {
        const running = this.clients.get(server.id);
        if (running?.client !== launchedClient) return;
        this.recordExit(server.id, event);
      });
      if (unsubscribeExit) running.unsubscribers.push(unsubscribeExit);
      const unsubscribeTools = launchedClient.onToolsChanged?.((event) => {
        this.handleToolsChanged(server.id, launchedClient, event);
      });
      if (unsubscribeTools) running.unsubscribers.push(unsubscribeTools);
      const health = this.options.health.markHealthy(server.id);
      return {
        server,
        tools: registered.map((tool) => tool.name),
        descriptor: launchedClient.describe(),
        health,
      };
    } catch (error) {
      this.options.tools.unregisterServerTools(server.id);
      this.clients.delete(server.id);
      if (client) {
        try {
          await client.stop();
        } catch {
          // The original startup error is the useful failure.
        }
      }
      return {
        server,
        tools: [],
        health: this.options.health.markUnhealthy(server.id, errorMessage(error)),
      };
    }
  }

  stop(serverId: string): Promise<McpRuntimeStopResult> {
    // A start queued after this stop must not be coalesced with an earlier start.
    this.coalescibleStarts.delete(serverId);
    return this.enqueueLifecycle(serverId, () => this.stopUnlocked(serverId));
  }

  private async stopUnlocked(serverId: string): Promise<McpRuntimeStopResult> {
    const running = this.clients.get(serverId);
    const removedTools = this.options.tools
      .unregisterServerTools(serverId)
      .map((tool) => tool.name);
    this.clients.delete(serverId);
    for (const unsubscribe of running?.unsubscribers ?? []) unsubscribe();
    if (running) await running.client.stop();
    return {
      serverId,
      removedTools,
      health: this.options.health.markStopped(serverId),
    };
  }

  async stopAll(): Promise<McpRuntimeStopResult[]> {
    const serverIds = [...new Set([...this.clients.keys(), ...this.coalescibleStarts.keys()])].sort(
      (left, right) => left.localeCompare(right),
    );
    const results: McpRuntimeStopResult[] = [];
    for (const serverId of serverIds) {
      results.push(await this.stop(serverId));
    }
    return results;
  }

  recordExit(
    serverId: string,
    input: { code?: number; signal?: string; errorMessage?: string; at?: string } = {},
  ): McpRuntimeExitResult {
    const running = this.clients.get(serverId);
    for (const unsubscribe of running?.unsubscribers ?? []) unsubscribe();
    const removedTools = this.options.tools
      .unregisterServerTools(serverId)
      .map((tool) => tool.name);
    this.clients.delete(serverId);
    return {
      serverId,
      removedTools,
      health: this.options.health.recordExit(serverId, input),
    };
  }

  async restartDue(now: string = new Date().toISOString()): Promise<McpRuntimeStartResult[]> {
    const due = this.options.health
      .list()
      .filter(
        (state) =>
          state.status === 'restarting' &&
          state.nextRestartAt !== undefined &&
          Date.parse(state.nextRestartAt) <= Date.parse(now),
      );
    const results: McpRuntimeStartResult[] = [];
    for (const state of due) {
      results.push(await this.start(state.serverId));
    }
    return results;
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

  describe(serverId: string): McpServerDescriptor {
    return this.requireRunning(serverId).describe();
  }

  async ping(serverId: string, signal?: AbortSignal): Promise<void> {
    this.options.health.assertAvailable(serverId);
    await this.requireRunning(serverId).ping(signal);
  }

  async listResources(serverId: string, signal?: AbortSignal): Promise<McpResourceSpec[]> {
    this.options.health.assertAvailable(serverId);
    return this.requireRunning(serverId).listResources(signal);
  }

  async listResourceTemplates(
    serverId: string,
    signal?: AbortSignal,
  ): Promise<McpResourceTemplateSpec[]> {
    this.options.health.assertAvailable(serverId);
    return this.requireRunning(serverId).listResourceTemplates(signal);
  }

  async readResource(
    serverId: string,
    uri: string,
    signal?: AbortSignal,
  ): Promise<McpReadResourceResult> {
    this.options.health.assertAvailable(serverId);
    return this.requireRunning(serverId).readResource(uri, signal);
  }

  async listPrompts(serverId: string, signal?: AbortSignal): Promise<McpPromptSpec[]> {
    this.options.health.assertAvailable(serverId);
    return this.requireRunning(serverId).listPrompts(signal);
  }

  async getPrompt(
    serverId: string,
    name: string,
    args?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<McpGetPromptResult> {
    this.options.health.assertAvailable(serverId);
    return this.requireRunning(serverId).getPrompt(name, args, signal);
  }

  onResourcesChanged(
    serverId: string,
    handler: (event: McpListChangedEvent<McpResourceSpec>) => void,
  ): () => void {
    return this.requireRunning(serverId).onResourcesChanged?.(handler) ?? (() => {});
  }

  onPromptsChanged(
    serverId: string,
    handler: (event: McpListChangedEvent<McpPromptSpec>) => void,
  ): () => void {
    return this.requireRunning(serverId).onPromptsChanged?.(handler) ?? (() => {});
  }

  private async requireServer(serverId: string): Promise<McpServerConfig> {
    const server = (await this.options.configStore.list()).find((item) => item.id === serverId);
    if (!server) throw new Error(`MCP server not found: ${serverId}.`);
    return server;
  }

  private enqueueLifecycle<T>(serverId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleTails.get(serverId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.lifecycleTails.set(serverId, tail);
    void tail.then(() => {
      if (this.lifecycleTails.get(serverId) === tail) {
        this.lifecycleTails.delete(serverId);
      }
    });
    return result;
  }

  private requireRunning(serverId: string): McpRuntimeClient {
    const running = this.clients.get(serverId);
    if (!running) throw new Error(`MCP server is not running: ${serverId}.`);
    return running.client;
  }

  private handleToolsChanged(
    serverId: string,
    client: McpRuntimeClient,
    event: McpListChangedEvent<McpToolSpec>,
  ): void {
    const running = this.clients.get(serverId);
    if (running?.client !== client) return;

    if (event.error) {
      this.options.tools.unregisterServerTools(serverId);
      this.options.health.markUnhealthy(
        serverId,
        `MCP tools refresh failed: ${event.error.message}`,
      );
      return;
    }

    try {
      this.options.tools.registerServerTools({
        serverId,
        source: 'user-mcp',
        tools: event.items,
        health: this.options.health,
        callTool: ({ toolName, args, signal }) => client.callTool(toolName, args, signal),
      });
      this.options.health.markHealthy(serverId);
    } catch (error) {
      this.options.tools.unregisterServerTools(serverId);
      this.options.health.markUnhealthy(
        serverId,
        `MCP tools refresh failed: ${errorMessage(error)}`,
      );
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameLaunchConfiguration(left: McpServerConfig, right: McpServerConfig): boolean {
  return (
    JSON.stringify(projectLaunchConfiguration(left)) ===
    JSON.stringify(projectLaunchConfiguration(right))
  );
}

function projectLaunchConfiguration(server: McpServerConfig): Record<string, unknown> {
  return {
    transport: server.transport,
    command: server.command,
    args: server.args,
    cwd: server.cwd,
    url: server.url,
    env: server.env,
    headers: server.headers,
  };
}
