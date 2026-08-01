import type { LlmTool } from '@dbagent/core-llm';
import type {
  AgentToolCatalogChange,
  AgentToolDefinition,
  AgentToolDescriptor,
  AgentToolHandler,
  AgentToolId,
  AgentToolRuntime,
  RegisteredAgentTool,
} from './types.js';

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredAgentTool>();
  private readonly runtimes = new Map<string, AgentToolRuntime>();
  private readonly listeners = new Set<(event: AgentToolCatalogChange) => void>();
  private revision = 0;

  get catalogRevision(): number {
    return this.revision;
  }

  register(definition: AgentToolDefinition, handler: AgentToolHandler): void {
    if (!definition.name.trim()) {
      throw new Error('Tool name is required.');
    }
    if (this.tools.has(definition.name)) {
      throw new Error(`Tool already registered: ${definition.name}`);
    }
    const descriptor = descriptorFromDefinition(definition);
    this.tools.set(definition.name, { ...definition, descriptor, handler });
    this.runtimes.set(toolIdKey(descriptor.id), {
      id: descriptor.id,
      flatName: descriptor.flatName,
      handler,
    });
    this.emit({
      revision: ++this.revision,
      kind: 'registered',
      toolName: definition.name,
      descriptor,
    });
  }

  unregister(name: string): boolean {
    const tool = this.tools.get(name);
    if (!tool) return false;
    this.tools.delete(name);
    this.runtimes.delete(toolIdKey(tool.descriptor.id));
    this.emit({
      revision: ++this.revision,
      kind: 'unregistered',
      toolName: name,
      descriptor: tool.descriptor,
    });
    return true;
  }

  get(name: string): RegisteredAgentTool | undefined {
    return this.tools.get(name);
  }

  list(): RegisteredAgentTool[] {
    return [...this.tools.values()];
  }

  listDescriptors(): AgentToolDescriptor[] {
    return this.list().map((tool) => structuredClone(tool.descriptor));
  }

  getRuntime(id: AgentToolId | string): AgentToolRuntime | undefined {
    if (typeof id === 'string') {
      const registered = this.tools.get(id);
      return registered ? this.runtimes.get(toolIdKey(registered.descriptor.id)) : undefined;
    }
    return this.runtimes.get(toolIdKey(id));
  }

  subscribe(listener: (event: AgentToolCatalogChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
        ...(tool.namespace === undefined ? {} : { namespace: tool.namespace }),
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
      }));
  }

  private emit(event: AgentToolCatalogChange): void {
    for (const listener of this.listeners) listener(event);
  }
}

function descriptorFromDefinition(definition: AgentToolDefinition): AgentToolDescriptor {
  const readonly = definition.readonly === true;
  const concurrency = definition.execution?.concurrency ?? (readonly ? 'read' : 'write');
  const id: AgentToolId = {
    ...(definition.namespace?.trim() ? { namespace: definition.namespace.trim() } : {}),
    name: definition.originalName?.trim() || definition.name,
  };
  return {
    id,
    flatName: definition.name,
    ...(definition.title?.trim() ? { title: definition.title.trim() } : {}),
    description: definition.description,
    aliases: uniqueStrings(definition.aliases),
    tags: uniqueStrings(definition.tags),
    inputSchema: structuredClone(definition.inputSchema),
    ...(definition.outputSchema === undefined
      ? {}
      : { outputSchema: structuredClone(definition.outputSchema) }),
    dangerLevel: definition.dangerLevel,
    readonly,
    source: definition.source ?? 'unknown',
    ...(definition.sourceId === undefined ? {} : { sourceId: definition.sourceId }),
    exposure: definition.exposure ?? 'deferred',
    ...(definition.requiredPermission === undefined
      ? {}
      : { requiredPermission: definition.requiredPermission }),
    execution: {
      concurrency,
      ...(definition.execution?.timeoutMs === undefined
        ? {}
        : { timeoutMs: definition.execution.timeoutMs }),
    },
    ...(definition.completion === undefined
      ? {}
      : { completion: structuredClone(definition.completion) }),
    ...(definition.protocolMetadata === undefined
      ? {}
      : { protocolMetadata: structuredClone(definition.protocolMetadata) }),
  };
}

function toolIdKey(id: AgentToolId): string {
  return `${id.namespace ?? ''}\u0000${id.name}`;
}

function uniqueStrings(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
