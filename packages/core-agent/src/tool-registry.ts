import type { LlmTool } from '@dbagent/core-llm';
import type { AgentToolDefinition, AgentToolHandler, RegisteredAgentTool } from './types.js';

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredAgentTool>();

  register(definition: AgentToolDefinition, handler: AgentToolHandler): void {
    if (!definition.name.trim()) {
      throw new Error('Tool name is required.');
    }
    if (this.tools.has(definition.name)) {
      throw new Error(`Tool already registered: ${definition.name}`);
    }
    this.tools.set(definition.name, { ...definition, handler });
  }

  get(name: string): RegisteredAgentTool | undefined {
    return this.tools.get(name);
  }

  list(): RegisteredAgentTool[] {
    return [...this.tools.values()];
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  llmTools(allowedTools?: string[]): LlmTool[] {
    const allowed = allowedTools === undefined ? undefined : new Set(allowedTools);
    return this.list()
      .filter((tool) => allowed === undefined || allowed.has(tool.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
  }
}
