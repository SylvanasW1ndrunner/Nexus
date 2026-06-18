import type { ToolRegistry } from '@dbagent/core-agent';
import {
  registerMcpTools,
  type McpToolAdapterOptions,
  type RegisteredMcpTool,
} from './mcp-tool-adapter.js';

export type McpServerToolRegistrationOptions = Omit<McpToolAdapterOptions, 'registry'>;

export class McpToolRegistrationManager {
  private readonly byServer = new Map<string, RegisteredMcpTool[]>();

  constructor(private readonly registry: ToolRegistry) {}

  registerServerTools(options: McpServerToolRegistrationOptions): RegisteredMcpTool[] {
    this.unregisterServerTools(options.serverId);
    const before = new Set(this.registry.list().map((tool) => tool.name));

    try {
      const registered = registerMcpTools({
        ...options,
        registry: this.registry,
      });
      this.byServer.set(options.serverId, registered);
      return registered;
    } catch (error) {
      this.rollbackNewTools(before);
      throw error;
    }
  }

  unregisterServerTools(serverId: string): RegisteredMcpTool[] {
    const registered = this.byServer.get(serverId) ?? [];
    for (const tool of registered) {
      this.registry.unregister(tool.name);
    }
    this.byServer.delete(serverId);
    return [...registered];
  }

  listServerTools(serverId: string): RegisteredMcpTool[] {
    return [...(this.byServer.get(serverId) ?? [])];
  }

  listAll(): RegisteredMcpTool[] {
    return [...this.byServer.values()].flatMap((tools) => [...tools]);
  }

  private rollbackNewTools(before: Set<string>): void {
    for (const tool of this.registry.list()) {
      if (!before.has(tool.name)) {
        this.registry.unregister(tool.name);
      }
    }
  }
}
