import { createHash } from 'node:crypto';
import type { AgentToolDefinition, AgentToolHandler, ToolDangerLevel, ToolRegistry } from '@dbagent/core-agent';
import {
  invokeMcpToolWithTimeout,
  type McpHealthManager,
  type McpToolTimeoutOptions,
} from './mcp-health.js';

export type McpToolSource = 'user-mcp' | 'market-mcp';

export type McpToolAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

export type McpToolSpec = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: McpToolAnnotations;
};

export type McpToolCallRequest = {
  serverId: string;
  toolName: string;
  args: Record<string, unknown>;
  signal: AbortSignal;
};

export type McpToolCall = (request: McpToolCallRequest) => unknown;

export type McpToolAdapterOptions = McpToolTimeoutOptions & {
  registry: ToolRegistry;
  serverId: string;
  source: McpToolSource;
  tools: McpToolSpec[];
  callTool: McpToolCall;
  health?: McpHealthManager;
};

export type AdaptedMcpToolDefinition = AgentToolDefinition & {
  source: McpToolSource;
  sourceId: string;
  originalName: string;
};

export type RegisteredMcpTool = {
  name: string;
  originalName: string;
  source: McpToolSource;
  sourceId: string;
};

const MAX_TOOL_NAME_LENGTH = 64;
const UNKNOWN_SCHEMA: Record<string, unknown> = { type: 'object', properties: {} };

export function registerMcpTools(options: McpToolAdapterOptions): RegisteredMcpTool[] {
  const { registry, serverId, source, tools, callTool, health, timeoutMs, signal } = options;
  const seen = new Set<string>();
  const registered: RegisteredMcpTool[] = [];

  for (const tool of tools) {
    const definition = adaptMcpToolDefinition({ serverId, source, tool, usedNames: seen });
    const handler = createMcpToolHandler({
      serverId,
      originalName: tool.name,
      callTool,
      ...(health === undefined ? {} : { health }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(signal === undefined ? {} : { signal }),
    });
    registry.register(definition, handler);
    registered.push({
      name: definition.name,
      originalName: tool.name,
      source,
      sourceId: serverId,
    });
  }

  return registered;
}

export function adaptMcpToolDefinition(input: {
  serverId: string;
  source: McpToolSource;
  tool: McpToolSpec;
  usedNames?: Set<string>;
}): AdaptedMcpToolDefinition {
  const originalName = input.tool.name.trim();
  if (!originalName) throw new Error('MCP tool name is required.');

  const name = uniqueToolName(namespacedToolName(input.serverId, originalName), input.usedNames);
  const inferred = inferMcpToolRisk(input.tool, input.source);

  return {
    name,
    description: input.tool.description?.trim() || `MCP tool ${originalName} from ${input.serverId}.`,
    inputSchema: normalizeInputSchema(input.tool.inputSchema),
    dangerLevel: inferred.dangerLevel,
    readonly: inferred.readonly,
    source: input.source,
    sourceId: input.serverId,
    originalName,
  };
}

export function inferMcpToolRisk(
  tool: Pick<McpToolSpec, 'name' | 'description' | 'annotations'>,
  source: McpToolSource,
): { dangerLevel: ToolDangerLevel; readonly: boolean } {
  const text = `${tool.name} ${tool.description ?? ''}`.toLowerCase().replace(/[_-]+/g, ' ');

  if (tool.annotations?.destructiveHint) return { dangerLevel: 'high', readonly: false };
  if (tool.annotations?.readOnlyHint) return { dangerLevel: 'safe', readonly: true };

  if (/\b(drop|truncate|delete|remove|destroy|wipe|purge|revoke|grant|alter|create|insert|update|write)\b/.test(text)) {
    return { dangerLevel: 'high', readonly: false };
  }

  if (/\b(shell|exec|execute|command|subprocess|process|run)\b/.test(text)) {
    return { dangerLevel: 'high', readonly: false };
  }

  if (/\b(list|get|read|search|find|describe|inspect|fetch|query|select|show)\b/.test(text)) {
    return { dangerLevel: 'safe', readonly: true };
  }

  return source === 'market-mcp'
    ? { dangerLevel: 'high', readonly: false }
    : { dangerLevel: 'medium', readonly: false };
}

export function namespacedToolName(serverId: string, toolName: string): string {
  const prefix = sanitizeToolNamePart(serverId);
  const suffix = sanitizeToolNamePart(toolName);
  const base = `${prefix}__${suffix}`;
  if (base.length <= MAX_TOOL_NAME_LENGTH) return base;

  const hash = createHash('sha256').update(base).digest('hex').slice(0, 8);
  const available = MAX_TOOL_NAME_LENGTH - hash.length - 3;
  return `${base.slice(0, available)}__${hash}`;
}

function createMcpToolHandler(input: {
  serverId: string;
  originalName: string;
  callTool: McpToolCall;
  health?: McpHealthManager;
  timeoutMs?: number;
  signal?: AbortSignal;
}): AgentToolHandler {
  return async (args, context) => {
    input.health?.assertAvailable(input.serverId);
    return invokeMcpToolWithTimeout(
      (signal) =>
        input.callTool({
          serverId: input.serverId,
          toolName: input.originalName,
          args,
          signal,
        }),
      {
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        ...((context.signal ?? input.signal) === undefined ? {} : { signal: context.signal ?? input.signal }),
      },
    );
  };
}

function normalizeInputSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!schema || typeof schema !== 'object' || schema.type !== 'object') return { ...UNKNOWN_SCHEMA };
  return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
}

function sanitizeToolNamePart(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_TOOL_NAME_LENGTH);
  return sanitized || 'mcp';
}

function uniqueToolName(base: string, usedNames?: Set<string>): string {
  if (!usedNames || !usedNames.has(base)) {
    usedNames?.add(base);
    return base;
  }

  for (let index = 2; index < 100; index += 1) {
    const suffix = `_${index}`;
    const candidate = `${base.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length)}${suffix}`;
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
  }

  throw new Error(`Too many MCP tools share the same normalized name: ${base}`);
}
