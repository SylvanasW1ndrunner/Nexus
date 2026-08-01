import { createHash } from 'node:crypto';
import type {
  AgentToolCompletionPolicy,
  AgentToolDefinition,
  AgentToolHandler,
  ToolDangerLevel,
  ToolRegistry,
} from '@dbagent/core-agent';
import {
  createAgentToolResultEnvelope,
  isAgentToolResultEnvelope,
} from '@dbagent/core-agent';
import {
  invokeMcpToolWithTimeout,
  type McpHealthManager,
  type McpToolTimeoutOptions,
} from './mcp-health.js';

export type McpToolSource = 'user-mcp';

export type McpToolAnnotations = Record<string, unknown> & {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

export type McpToolSpec = Record<string, unknown> & {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: McpToolAnnotations;
  execution?: {
    taskSupport?: 'forbidden' | 'optional' | 'required';
  };
  _meta?: Record<string, unknown>;
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
  resolveCompletion?: (tool: McpToolSpec) => AgentToolCompletionPolicy | undefined;
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

export class McpRemoteToolError extends Error {
  readonly code = 'MCP_REMOTE_TOOL_ERROR';

  constructor(
    readonly serverId: string,
    readonly toolName: string,
    message: string,
  ) {
    super(message);
    this.name = 'McpRemoteToolError';
  }
}

export function registerMcpTools(options: McpToolAdapterOptions): RegisteredMcpTool[] {
  const {
    registry,
    serverId,
    source,
    tools,
    callTool,
    health,
    timeoutMs,
    signal,
    resolveCompletion,
  } = options;
  const seen = new Set<string>();
  const registered: RegisteredMcpTool[] = [];
  const prepared = tools.map((tool) => {
    const completion = resolveCompletion?.(tool) ?? {
      role: 'supporting' as const,
      group: `mcp:${serverId}`,
    };
    const definition = adaptMcpToolDefinition({
      serverId,
      source,
      tool,
      usedNames: seen,
      completion,
    });
    if (timeoutMs !== undefined) {
      definition.execution = { ...definition.execution, timeoutMs };
    }
    const handler = createMcpToolHandler({
      serverId,
      originalName: tool.name,
      completion,
      callTool,
      ...(health === undefined ? {} : { health }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(signal === undefined ? {} : { signal }),
    });
    return { tool, definition, handler };
  });

  try {
    for (const { tool, definition, handler } of prepared) {
      registry.register(definition, handler);
      registered.push({
        name: definition.name,
        originalName: tool.name,
        source,
        sourceId: serverId,
      });
    }
  } catch (error) {
    for (const tool of registered) registry.unregister(tool.name);
    throw error;
  }

  return registered;
}

export function normalizeMcpToolSpec(input: unknown): McpToolSpec {
  if (!isRecord(input) || typeof input.name !== 'string' || !input.name.trim()) {
    throw new Error('Invalid MCP tool spec.');
  }
  if (input.inputSchema !== undefined && !isRecord(input.inputSchema)) {
    throw new Error(`Invalid MCP input schema for tool ${input.name}.`);
  }
  if (input.outputSchema !== undefined && !isRecord(input.outputSchema)) {
    throw new Error(`Invalid MCP output schema for tool ${input.name}.`);
  }
  if (input.annotations !== undefined && !isRecord(input.annotations)) {
    throw new Error(`Invalid MCP annotations for tool ${input.name}.`);
  }
  if (input.execution !== undefined) {
    if (!isRecord(input.execution)) {
      throw new Error(`Invalid MCP execution metadata for tool ${input.name}.`);
    }
    const taskSupport = input.execution.taskSupport;
    if (
      taskSupport !== undefined &&
      taskSupport !== 'forbidden' &&
      taskSupport !== 'optional' &&
      taskSupport !== 'required'
    ) {
      throw new Error(`Invalid MCP taskSupport for tool ${input.name}.`);
    }
  }
  return JSON.parse(JSON.stringify(input)) as McpToolSpec;
}

export function adaptMcpToolDefinition(input: {
  serverId: string;
  source: McpToolSource;
  tool: McpToolSpec;
  usedNames?: Set<string>;
  completion?: AgentToolCompletionPolicy;
}): AdaptedMcpToolDefinition {
  const originalName = input.tool.name.trim();
  if (!originalName) throw new Error('MCP tool name is required.');

  const name = uniqueToolName(namespacedToolName(input.serverId, originalName), input.usedNames);
  const inferred = inferMcpToolRisk(input.tool, input.source);

  return {
    name,
    namespace: `mcp:${input.serverId}`,
    ...(input.tool.title?.trim() ? { title: input.tool.title.trim() } : {}),
    aliases: [originalName, input.tool.title?.trim()].filter(
      (value): value is string => Boolean(value),
    ),
    tags: ['mcp', input.serverId],
    description:
      input.tool.description?.trim() || `MCP tool ${originalName} from ${input.serverId}.`,
    inputSchema: normalizeInputSchema(input.tool.inputSchema),
    ...(input.tool.outputSchema === undefined
      ? {}
      : { outputSchema: structuredClone(input.tool.outputSchema) }),
    dangerLevel: inferred.dangerLevel,
    readonly: inferred.readonly,
    requiredPermission: inferred.readonly
      ? 'read'
      : inferred.dangerLevel === 'high' || inferred.dangerLevel === 'critical'
        ? 'full'
        : 'edit',
    source: input.source,
    sourceId: input.serverId,
    originalName,
    exposure: 'deferred',
    execution: { concurrency: inferred.readonly ? 'read' : 'exclusive' },
    completion: input.completion ?? {
      role: 'supporting',
      group: `mcp:${input.serverId}`,
    },
    protocolMetadata: {
      protocol: 'mcp',
      ...(input.tool.execution?.taskSupport === undefined
        ? {}
        : { taskSupport: input.tool.execution.taskSupport }),
      ...(input.tool.annotations === undefined
        ? {}
        : { annotations: standardMcpAnnotations(input.tool.annotations) }),
    },
  };
}

export function inferMcpToolRisk(
  tool: Pick<McpToolSpec, 'name' | 'description' | 'annotations'>,
  source: McpToolSource,
): { dangerLevel: ToolDangerLevel; readonly: boolean } {
  void source;
  const text = `${tool.name} ${tool.description ?? ''}`.toLowerCase().replace(/[_-]+/g, ' ');

  if (tool.annotations?.destructiveHint) return { dangerLevel: 'high', readonly: false };

  if (
    /\b(drop|truncate|delete|remove|destroy|wipe|purge|revoke|grant|alter|create|insert|update|write)\b/.test(
      text,
    )
  ) {
    return { dangerLevel: 'high', readonly: false };
  }

  if (/\b(shell|exec|execute|command|subprocess|process|run)\b/.test(text)) {
    return { dangerLevel: 'high', readonly: false };
  }
  if (tool.annotations?.readOnlyHint === true) {
    return { dangerLevel: 'safe', readonly: true };
  }
  return { dangerLevel: 'medium', readonly: false };
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
  completion: AgentToolCompletionPolicy;
  callTool: McpToolCall;
  health?: McpHealthManager;
  timeoutMs?: number;
  signal?: AbortSignal;
}): AgentToolHandler {
  return async (args, context) => {
    input.health?.assertAvailable(input.serverId);
    const result = await invokeMcpToolWithTimeout(
      (signal) =>
        input.callTool({
          serverId: input.serverId,
          toolName: input.originalName,
          args,
          signal,
        }),
      {
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        ...((context.signal ?? input.signal) === undefined
          ? {}
          : { signal: context.signal ?? input.signal }),
      },
    );
    if (isAgentToolResultEnvelope(result)) return result;
    if (isRecord(result) && result.isError === true) {
      throw new McpRemoteToolError(
        input.serverId,
        input.originalName,
        mcpErrorMessage(result),
      );
    }
    const projection = projectMcpResult(result);
    return createAgentToolResultEnvelope({
      modelProjection: projection,
      userProjection: projection,
      durableSummary: {
        serverId: input.serverId,
        toolName: input.originalName,
        isError: false,
        result: boundedProjection(projection, 4_000),
      },
      auditEvidence: { status: 'success', resultType: 'mcp' },
      ...(input.completion.role !== 'deliverable'
        ? {}
        : {
            completionEvidence: {
              kind: 'mcp' as const,
              deliveryReady: true,
              source: 'runtime' as const,
              outcome: 'succeeded' as const,
            },
          }),
    });
  };
}

function standardMcpAnnotations(annotations: McpToolAnnotations) {
  return {
    ...(annotations.readOnlyHint === undefined
      ? {}
      : { readOnlyHint: annotations.readOnlyHint }),
    ...(annotations.destructiveHint === undefined
      ? {}
      : { destructiveHint: annotations.destructiveHint }),
    ...(annotations.idempotentHint === undefined
      ? {}
      : { idempotentHint: annotations.idempotentHint }),
    ...(annotations.openWorldHint === undefined
      ? {}
      : { openWorldHint: annotations.openWorldHint }),
  };
}

function projectMcpResult(result: unknown): unknown {
  if (!isRecord(result)) return result;
  if (result.structuredContent === undefined) return boundedProjection(result, 20_000);
  return {
    structuredContent: boundedProjection(result.structuredContent, 16_000),
    ...(result.content === undefined ? {} : { content: boundedProjection(result.content, 4_000) }),
  };
}

function boundedProjection(value: unknown, maxChars: number): unknown {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { type: typeof value, unavailable: 'non-serializable MCP result' };
  }
  if (serialized.length <= maxChars) return structuredClone(value);
  return {
    truncated: true,
    originalChars: serialized.length,
    preview: serialized.slice(0, maxChars),
  };
}

function mcpErrorMessage(result: Record<string, unknown>): string {
  if (Array.isArray(result.content)) {
    const text = result.content
      .filter(isRecord)
      .filter((item) => item.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text as string)
      .join('\n')
      .trim();
    if (text) return text;
  }
  return 'MCP server reported a tool execution error.';
}

function normalizeInputSchema(
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!schema || typeof schema !== 'object' || schema.type !== 'object')
    return { ...UNKNOWN_SCHEMA };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
