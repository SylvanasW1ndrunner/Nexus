import { createHash, randomUUID } from 'node:crypto';
import type { PortableValue } from '@dbagent/shared';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { JsonSchemaValidator } from '@modelcontextprotocol/sdk/validation';
import type {
  AgentToolCompletionPolicy,
  AgentToolPermissionFacts,
  PreparedToolIntent,
  ToolAccess,
  ToolDangerLevel,
  ToolExecuteContext,
  ToolInvocationContribution,
  ToolInvocationDefinition,
  ToolPrepareContext,
  ToolRecoveryClass,
} from '@dbagent/core-agent';
import {
  expectedToolError,
  PREPARED_TOOL_INTENT_REVISION,
  ToolExecutionError,
} from '@dbagent/core-agent';
import {
  McpToolAbortedError,
  McpToolTimeoutError,
  McpUnavailableError,
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
  execution?: { taskSupport?: 'forbidden' | 'optional' | 'required' };
  _meta?: Record<string, unknown>;
};

export type McpToolCallRequest = {
  serverId: string;
  toolName: string;
  args: Readonly<Record<string, PortableValue>>;
  signal: AbortSignal;
};

export type McpToolCall = (request: McpToolCallRequest) => unknown;

export type McpToolAdapterOptions = McpToolTimeoutOptions & {
  serverId: string;
  source: McpToolSource;
  tools: McpToolSpec[];
  callTool: McpToolCall;
  health?: McpHealthManager;
  /** Transport-level network authority, independent of Tool annotations. */
  network?: boolean;
  /** Normalized remote transport host used by enterprise host selectors. */
  host?: string;
  resolveCompletion?: (tool: McpToolSpec) => AgentToolCompletionPolicy | undefined;
  /** Exact client/catalog generation. A fresh opaque value is used when omitted. */
  generationId?: string;
};

export type AdaptedMcpToolDefinition = ToolInvocationDefinition & {
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

type McpClassification = Readonly<{
  access: ToolAccess;
  recoveryClass: ToolRecoveryClass;
  readonly: boolean;
  destructive: boolean;
  unknownRisk: boolean;
  dangerLevel: ToolDangerLevel;
}>;

type PreparedMcpCall = Readonly<{
  serverId: string;
  toolName: string;
  args: Readonly<Record<string, PortableValue>>;
  argsDigest: string;
  timeoutMs: number;
}>;

const MCP_ADAPTER_REVISION = 'mcp-adapter.v2';
const MAX_TOOL_NAME_LENGTH = 64;
const MAX_SERVER_ID_CHARS = 220;
const MAX_ORIGINAL_NAME_CHARS = 256;
const MAX_DESCRIPTION_CHARS = 16_384;
const MAX_MCP_METADATA_BYTES = 262_144;
const MAX_MCP_CATALOG_BYTES = 4_194_304;
const MAX_MCP_CATALOG_RECORDS = 50_000;
const MAX_MCP_TOOLS = 128;
const MAX_MCP_PAYLOAD_BYTES = 8_388_608;
const MAX_MCP_RAW_PAYLOAD_BYTES = 8_000_000;
const MAX_MCP_STRING_BYTES = 1_048_576;
const MAX_MCP_DEPTH = 24;
// Leave room for the adapter wrapper and prepared permission/target facts.
const MAX_MCP_RECORDS = 9_000;
const DEFAULT_MCP_TIMEOUT_MS = 60_000;
const UNKNOWN_SCHEMA: Record<string, unknown> = { type: 'object', properties: {} };
const MCP_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'summary', 'externalPayload'],
  properties: {
    status: { const: 'ok' },
    summary: { type: 'string', minLength: 1, maxLength: 4_096 },
    externalPayload: { type: 'object' },
  },
};

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

export function prepareMcpTools(options: McpToolAdapterOptions): {
  tools: RegisteredMcpTool[];
  contributions: ToolInvocationContribution[];
} {
  const serverId = normalizeServerId(options.serverId);
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const generationId = boundedGenerationId(options.generationId ?? randomUUID());
  const host = normalizeHost(options.host);
  const seen = new Set<string>();
  const tools = normalizeMcpToolCatalog(options.tools);
  const prepared = tools.map((tool) => {
    const completion = options.resolveCompletion?.(tool) ?? {
      role: 'supporting' as const,
      group: `mcp:${serverId}`,
    };
    const definition = adaptMcpToolDefinition({
      serverId,
      source: options.source,
      tool,
      usedNames: seen,
      completion,
      generationId,
      timeoutMs,
      ...(options.network === undefined ? {} : { network: options.network }),
      ...(host === undefined ? {} : { host }),
    });
    const runtime = createMcpToolRuntime({
      serverId,
      originalName: tool.name,
      definition,
      classification: classifyMcpTool(tool),
      callTool: options.callTool,
      ...(options.health === undefined ? {} : { health: options.health }),
      ...(options.signal === undefined ? {} : { parentSignal: options.signal }),
      network: options.network === true || tool.annotations?.openWorldHint !== false,
      ...(host === undefined ? {} : { host }),
      ...(tool.outputSchema === undefined
        ? {}
        : { outputValidator: compileMcpOutputValidator(tool.name, tool.outputSchema) }),
    });
    return { tool, definition, runtime };
  });
  return {
    tools: prepared.map(({ tool, definition }) => ({
      name: definition.name,
      originalName: tool.name,
      source: options.source,
      sourceId: serverId,
    })),
    contributions: prepared.map(({ definition, runtime }) => ({ definition, runtime })),
  };
}

export function mcpOwnerId(serverId: string): string {
  return `mcp:${encodeURIComponent(normalizeServerId(serverId))}`;
}

export function normalizeMcpToolSpec(input: unknown): McpToolSpec {
  const snapshot = snapshotMcpValue(input, MAX_MCP_METADATA_BYTES);
  if (!isRecord(snapshot)) throw new Error('Invalid MCP tool spec.');
  const spec = snapshot as Record<string, PortableValue>;
  if (typeof spec.name !== 'string' || !validBoundedText(spec.name, MAX_ORIGINAL_NAME_CHARS)) {
    throw new Error('Invalid MCP tool spec.');
  }
  for (const [key, max] of [['title', MAX_ORIGINAL_NAME_CHARS], ['description', MAX_DESCRIPTION_CHARS]] as const) {
    const value = spec[key];
    if (value !== undefined && (typeof value !== 'string' || !validBoundedText(value, max))) {
      throw new Error(`Invalid MCP ${key} for tool ${spec.name}.`);
    }
  }
  if (spec.inputSchema !== undefined && !isRecord(spec.inputSchema)) {
    throw new Error(`Invalid MCP input schema for tool ${spec.name}.`);
  }
  if (spec.outputSchema !== undefined && !isRecord(spec.outputSchema)) {
    throw new Error(`Invalid MCP output schema for tool ${spec.name}.`);
  }
  if (spec.annotations !== undefined) {
    if (!isRecord(spec.annotations)) {
      throw new Error(`Invalid MCP annotations for tool ${spec.name}.`);
    }
    const annotations = spec.annotations as Record<string, PortableValue>;
    for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
      if (annotations[key] !== undefined && typeof annotations[key] !== 'boolean') {
        throw new Error(`Invalid MCP annotation ${key} for tool ${spec.name}.`);
      }
    }
  }
  if (spec.execution !== undefined) {
    if (!isRecord(spec.execution)) {
      throw new Error(`Invalid MCP execution metadata for tool ${spec.name}.`);
    }
    const taskSupport = (spec.execution as Record<string, PortableValue>).taskSupport;
    if (taskSupport !== undefined && taskSupport !== 'forbidden' &&
      taskSupport !== 'optional' && taskSupport !== 'required') {
      throw new Error(`Invalid MCP taskSupport for tool ${spec.name}.`);
    }
  }
  return snapshot as McpToolSpec;
}

/** Strict bounded snapshot for other MCP control-plane metadata. */
export function snapshotMcpMetadata(value: unknown): PortableValue {
  return snapshotMcpValue(value, MAX_MCP_METADATA_BYTES);
}

function normalizeMcpToolCatalog(input: unknown): McpToolSpec[] {
  if (!Array.isArray(input)) throw new TypeError('MCP Tool catalog must be an array.');
  let keys: Array<string | symbol>;
  let prototype: unknown;
  try {
    prototype = Object.getPrototypeOf(input);
    keys = Reflect.ownKeys(input);
  } catch {
    throw new TypeError('MCP Tool catalog must expose plain data entries.');
  }
  if (prototype !== Array.prototype) {
    throw new TypeError('MCP Tool catalog must be a plain-data array.');
  }
  if (input.length > MAX_MCP_TOOLS) {
    throw new TypeError(`MCP Tool catalog exceeds the ${MAX_MCP_TOOLS}-Tool limit.`);
  }
  if (keys.length !== input.length + 1 || keys.some((key) =>
    typeof key === 'symbol' || key !== 'length' &&
    (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(key)))) {
    throw new TypeError('MCP Tool catalog must be a dense plain-data array.');
  }
  const result: McpToolSpec[] = [];
  let bytes = 2;
  let records = 0;
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError('MCP Tool catalog must contain enumerable data entries.');
    }
    const tool = normalizeMcpToolSpec(descriptor.value);
    bytes += Buffer.byteLength(JSON.stringify(tool), 'utf8') + (index === 0 ? 0 : 1);
    records += countPortableRecords(tool as unknown as PortableValue);
    if (bytes > MAX_MCP_CATALOG_BYTES || records > MAX_MCP_CATALOG_RECORDS) {
      throw new TypeError('MCP Tool catalog exceeds its aggregate metadata boundary.');
    }
    result.push(tool);
  }
  return result;
}

export function adaptMcpToolDefinition(input: {
  serverId: string;
  source: McpToolSource;
  tool: McpToolSpec;
  usedNames?: Set<string>;
  completion?: AgentToolCompletionPolicy;
  network?: boolean;
  host?: string;
  generationId?: string;
  timeoutMs?: number;
}): AdaptedMcpToolDefinition {
  const serverId = normalizeServerId(input.serverId);
  const tool = normalizeMcpToolSpec(input.tool);
  const originalName = tool.name;
  const generationId = boundedGenerationId(input.generationId ?? randomUUID());
  const timeoutMs = normalizeTimeout(input.timeoutMs);
  const host = normalizeHost(input.host);
  const name = uniqueToolName(namespacedToolName(serverId, originalName), input.usedNames);
  const classification = classifyMcpTool(tool);
  // MCP defines openWorldHint as true when omitted. Treat an undeclared stdio
  // Tool conservatively as network-capable; only an explicit false narrows it.
  const network = input.network === true || tool.annotations?.openWorldHint !== false;
  const actions = permissionActions(classification, network);
  const toolRevision = semanticRevision('mcp-tool.v2', { serverId, originalName, tool });
  const handlerRevision = semanticRevision('mcp-handler.v2', {
    adapter: MCP_ADAPTER_REVISION,
    serverId,
    originalName,
    generationId,
    timeoutMs,
    network,
    host: host ?? null,
  });
  const limits = {
    timeoutMs,
    maxInputBytes: 1_048_576,
    maxOutputBytes: 262_144,
    maxArtifactBytes: MAX_MCP_PAYLOAD_BYTES,
    maxDepth: 32,
    maxRecords: 10_000,
  };

  return {
    name,
    namespace: `mcp:${serverId}`,
    ...(tool.title ? { title: tool.title } : {}),
    aliases: uniqueLabels([originalName, tool.title]),
    tags: ['mcp', serverId],
    description: tool.description || `MCP tool ${originalName} from ${serverId}.`,
    inputSchema: normalizeInputSchema(tool.inputSchema),
    outputSchema: structuredClone(MCP_OUTPUT_SCHEMA),
    dangerLevel: classification.dangerLevel,
    readonly: classification.readonly,
    permission: {
      actions,
      network,
      ...(host === undefined ? {} : { hosts: [host] }),
      externalWrite: !classification.readonly,
      destructive: classification.destructive,
    },
    access: classification.access,
    recoveryClass: classification.recoveryClass,
    limits,
    toolRevision,
    handlerRevision,
    intentRevision: PREPARED_TOOL_INTENT_REVISION,
    source: input.source,
    sourceId: serverId,
    originalName,
    exposure: 'deferred',
    // MCP does not standardize strong resource identities. Even annotated reads
    // remain exclusive until a server-specific adapter can prove one.
    execution: { concurrency: 'exclusive', timeoutMs },
    failurePolicy: { onUnknown: { failureKind: 'unknown', retryable: false } },
    completion: input.completion ?? { role: 'supporting', group: `mcp:${serverId}` },
    presentation: {
      category: 'mcp',
      preparingMessage: `调用 MCP 工具 ${tool.title || originalName}（${serverId}）。`,
    },
    protocolMetadata: {
      protocol: 'mcp',
      ...(tool.execution?.taskSupport === undefined ? {} : { taskSupport: tool.execution.taskSupport }),
      ...(tool.annotations === undefined ? {} : { annotations: standardMcpAnnotations(tool.annotations) }),
    },
  };
}

export function namespacedToolName(serverId: string, toolName: string): string {
  const prefix = sanitizeToolNamePart(normalizeServerId(serverId));
  if (!validBoundedText(toolName, MAX_ORIGINAL_NAME_CHARS)) throw new Error('MCP tool name is invalid.');
  const suffix = sanitizeToolNamePart(toolName);
  const base = `${prefix}__${suffix}`;
  if (base.length <= MAX_TOOL_NAME_LENGTH) return base;
  const hash = createHash('sha256').update(base).digest('hex').slice(0, 8);
  const available = MAX_TOOL_NAME_LENGTH - hash.length - 3;
  return `${base.slice(0, available)}__${hash}`;
}

function createMcpToolRuntime(input: {
  serverId: string;
  originalName: string;
  definition: AdaptedMcpToolDefinition;
  classification: McpClassification;
  callTool: McpToolCall;
  health?: McpHealthManager;
  parentSignal?: AbortSignal;
  network?: boolean;
  host?: string;
  outputValidator?: JsonSchemaValidator<unknown>;
}): ToolInvocationContribution['runtime'] {
  const revision = Object.freeze({
    toolName: input.definition.name,
    toolRevision: input.definition.toolRevision,
    handlerRevision: input.definition.handlerRevision,
    intentRevision: PREPARED_TOOL_INTENT_REVISION,
  });
  const execute = async (
    prepared: Readonly<Record<string, PortableValue>>,
    context: ToolExecuteContext,
  ): Promise<PortableValue> => executeMcpCall(input, readPreparedMcpCall(prepared, context), context);
  return {
    revision,
    prepare: (args, context) => prepareMcpCall(input, args, context),
    execute,
    // Recovery only receives persisted input. The kernel never uses this path
    // for non-idempotent MCP calls, which remain unknown after interruption.
    recover: execute,
  };
}

function prepareMcpCall(
  input: Parameters<typeof createMcpToolRuntime>[0],
  args: Readonly<Record<string, PortableValue>>,
  context: ToolPrepareContext,
): PreparedToolIntent {
  let capturedArgs: PortableValue;
  try {
    capturedArgs = snapshotMcpValue(args, context.limits.maxInputBytes);
  } catch (error) {
    throw expectedToolError(
      error instanceof McpPayloadBoundaryError && error.kind === 'limit' ? 'limit' : 'invalid_argument',
      'MCP tool arguments exceed the supported portable-data boundary.',
    );
  }
  if (!isRecord(capturedArgs)) throw expectedToolError('invalid_argument', 'MCP tool arguments must be an object.');
  const argsDigest = digestPortable(capturedArgs);
  const prepared: PreparedMcpCall = Object.freeze({
    serverId: input.serverId,
    toolName: input.originalName,
    args: capturedArgs,
    argsDigest,
    // Runtime persists the corresponding absolute deadline next to this intent.
    timeoutMs: context.limits.timeoutMs,
  });
  if (Buffer.byteLength(JSON.stringify(prepared), 'utf8') > context.limits.maxInputBytes) {
    throw expectedToolError('limit', 'MCP tool arguments leave no room for the prepared invocation identity.');
  }
  const network = input.network === true;
  const hosts = input.host === undefined ? [] : [input.host];
  const facts: AgentToolPermissionFacts = {
    toolName: context.descriptor.flatName,
    dangerLevel: input.classification.dangerLevel,
    readonly: input.classification.readonly,
    access: input.classification.access,
    recoveryClass: input.classification.recoveryClass,
    actions: permissionActions(input.classification, network),
    paths: [],
    hosts,
    network,
    externalWrite: !input.classification.readonly,
    destructive: input.classification.destructive,
    credentials: false,
    admin: false,
    unknownRisk: input.classification.unknownRisk,
    resolvedAddresses: [],
    targets: [{
      kind: 'mcp-tool', serverId: input.serverId, toolName: input.originalName,
      argsDigest, generation: context.generation, handlerRevision: context.handlerRevision,
    }],
  };
  return {
    input: prepared,
    toolRevision: context.toolRevision,
    handlerRevision: context.handlerRevision,
    intentRevision: context.intentRevision,
    targetIdentity: {
      kind: 'mcp-tool', serverId: input.serverId, toolName: input.originalName,
      argsDigest, generation: context.generation, handlerRevision: context.handlerRevision,
    },
    generation: context.generation,
    action: { summary: `Call MCP tool ${input.serverId}/${input.originalName}.` },
    permission: facts,
    access: facts.access,
    recoveryClass: facts.recoveryClass,
    concurrency: 'exclusive',
    resourceKeys: [],
    limits: { ...context.limits },
  };
}

async function executeMcpCall(
  input: Parameters<typeof createMcpToolRuntime>[0],
  prepared: PreparedMcpCall,
  context: ToolExecuteContext,
): Promise<PortableValue> {
  assertPreparedTarget(input, prepared, context);
  try {
    input.health?.assertAvailable(input.serverId);
  } catch (error) {
    if (error instanceof McpUnavailableError) {
      throw expectedToolError('precondition', 'The MCP server is currently unavailable.', { retryable: true });
    }
    throw error;
  }
  const linked = linkMcpCallSignal(context, input.parentSignal);
  let result: unknown;
  try {
    // The Journal-owned deadline is authoritative. ToolInvocationRuntime keeps
    // this actual promise in its generation drain if transport ignores abort.
    result = await input.callTool({
      serverId: input.serverId,
      toolName: input.originalName,
      args: prepared.args,
      signal: linked.signal,
    });
  } catch (error) {
    throw mapMcpCallError(error, input.classification, context, linked.deadlineElapsed());
  } finally {
    linked.close();
  }

  const rawErrorMarker = readRawMcpErrorMarker(result);
  if (rawErrorMarker === 'invalid') {
    throw expectedToolError('external', 'The MCP server returned an invalid error marker.', {
      outcome: possibleMcpOutcome(input.classification),
    });
  }
  if (rawErrorMarker === true) {
    throw expectedToolError('external', 'The MCP server reported that the tool call failed.', {
      retryable: input.classification.recoveryClass === 'read' ||
        input.classification.recoveryClass === 'idempotent',
      // isError proves failure, not absence of partial external side effects.
      outcome: possibleMcpOutcome(input.classification),
    });
  }
  let payload: PortableValue;
  try {
    payload = snapshotMcpValue(result, MAX_MCP_RAW_PAYLOAD_BYTES);
  } catch (error) {
    const outcome = possibleMcpOutcome(input.classification);
    if (error instanceof McpPayloadBoundaryError && error.kind === 'limit') {
      throw expectedToolError('limit', 'The MCP server response exceeds the supported result boundary.', { outcome });
    }
    throw expectedToolError('external', 'The MCP server returned a malformed result.', { outcome });
  }
  const outcome = possibleMcpOutcome(input.classification);
  if (!isRecord(payload)) {
    throw expectedToolError('external', 'The MCP server returned a malformed result.', { outcome });
  }
  const response = payload as Record<string, PortableValue>;
  if (response.isError !== undefined && typeof response.isError !== 'boolean') {
    throw expectedToolError('external', 'The MCP server returned an invalid error marker.', { outcome });
  }
  if (input.outputValidator !== undefined) {
    if (response.structuredContent === undefined) {
      throw expectedToolError('external', 'The MCP server omitted its declared structured output.', { outcome });
    }
    let validation: ReturnType<JsonSchemaValidator<unknown>>;
    try {
      validation = input.outputValidator(response.structuredContent);
    } catch {
      throw expectedToolError('external', 'The MCP server structured output could not be validated.', { outcome });
    }
    if (!validation.valid) {
      throw expectedToolError('external', 'The MCP server structured output violates its declared schema.', { outcome });
    }
  }
  return {
    status: 'ok',
    summary: `MCP tool ${input.originalName} completed.`,
    externalPayload: payload,
  };
}

function readPreparedMcpCall(
  value: Readonly<Record<string, PortableValue>>,
  context: ToolExecuteContext,
): PreparedMcpCall {
  if (typeof value.serverId !== 'string' || typeof value.toolName !== 'string' ||
    typeof value.argsDigest !== 'string' || typeof value.timeoutMs !== 'number' ||
    !Number.isSafeInteger(value.timeoutMs) || !isRecord(value.args) ||
    value.timeoutMs !== context.intent.limits.timeoutMs || digestPortable(value.args) !== value.argsDigest) {
    throw expectedToolError('precondition', 'The persisted MCP invocation is invalid.');
  }
  return {
    serverId: value.serverId,
    toolName: value.toolName,
    args: value.args,
    argsDigest: value.argsDigest,
    timeoutMs: value.timeoutMs,
  };
}

function assertPreparedTarget(
  input: Parameters<typeof createMcpToolRuntime>[0],
  prepared: PreparedMcpCall,
  context: ToolExecuteContext,
): void {
  const target = context.intent.targetIdentity;
  const targetRecord = isRecord(target) ? target as Record<string, PortableValue> : undefined;
  if (targetRecord === undefined || prepared.serverId !== input.serverId ||
    prepared.toolName !== input.originalName || targetRecord.serverId !== input.serverId ||
    targetRecord.toolName !== input.originalName || targetRecord.argsDigest !== prepared.argsDigest ||
    targetRecord.generation !== context.intent.generation ||
    targetRecord.handlerRevision !== input.definition.handlerRevision ||
    context.intent.handlerRevision !== input.definition.handlerRevision) {
    throw new ToolExecutionError({
      code: 'target_changed', category: 'precondition', retryable: true, outcome: 'not_applied',
    }, 'The prepared MCP server or tool generation changed; prepare the call again.');
  }
  const deadline = Date.parse(context.deadline);
  if (!Number.isFinite(deadline) || deadline <= Date.now()) {
    throw new ToolExecutionError({
      code: 'TOOL_TIMEOUT', category: 'timeout', retryable: true, outcome: 'not_applied',
    }, 'The persisted MCP invocation deadline expired.');
  }
  if (context.signal.aborted) {
    throw new Error('The MCP invocation boundary ended before the external call started.');
  }
}

function classifyMcpTool(tool: Pick<McpToolSpec, 'annotations'>): McpClassification {
  const annotations = tool.annotations;
  const contradictory = annotations?.readOnlyHint === true && annotations.destructiveHint === true;
  const destructive = annotations?.destructiveHint === true;
  const readonly = annotations?.readOnlyHint === true && !destructive;
  // A container or an unrelated hint is not risk semantics. Readonly=true or
  // destructive=true is decisive; a normal mutating Tool must explicitly say
  // both readonly=false and destructive=false. Everything else fails closed.
  const hasKnownMutationSemantics = annotations?.readOnlyHint === false &&
    annotations.destructiveHint === false;
  const unknownRisk = contradictory || !readonly && !destructive && !hasKnownMutationSemantics;
  const access: ToolAccess = destructive ? 'destructive' : 'external';
  const recoveryClass: ToolRecoveryClass = readonly
    ? 'read'
    : annotations?.idempotentHint === true ? 'idempotent' : 'non_idempotent';
  return {
    access,
    recoveryClass,
    readonly,
    destructive,
    unknownRisk,
    dangerLevel: destructive || unknownRisk ? 'high' : readonly ? 'safe' : 'medium',
  };
}

function permissionActions(
  classification: McpClassification,
  network: boolean,
): AgentToolPermissionFacts['actions'] {
  return uniqueLabels([
    classification.readonly ? 'read' : 'write',
    classification.destructive ? 'delete' : undefined,
    network ? 'network' : undefined,
    classification.unknownRisk ? 'unknown' : undefined,
  ]);
}

function mapMcpCallError(
  error: unknown,
  classification: McpClassification,
  context: ToolExecuteContext,
  deadlineElapsed: boolean,
): Error {
  if (error instanceof ToolExecutionError) return error;
  const outcome = possibleMcpOutcome(classification);
  if (error instanceof McpToolTimeoutError || deadlineElapsed || Date.now() >= Date.parse(context.deadline)) {
    return new ToolExecutionError({
      code: 'TOOL_TIMEOUT', category: 'timeout', retryable: true, outcome,
    }, 'The MCP tool call exceeded its persisted deadline.');
  }
  // The Invocation Runtime owns the distinction between its persisted timeout,
  // caller cancellation and lease loss. Preserve its signal cause here.
  if (context.signal.aborted) {
    return error instanceof Error ? error : new Error('The MCP tool call was interrupted.');
  }
  if (error instanceof McpToolAbortedError) {
    return new ToolExecutionError({
      code: 'TOOL_CANCELLED', category: 'cancelled', retryable: false, outcome,
    }, 'The MCP tool call was cancelled.');
  }
  if (error instanceof McpRemoteToolError) {
    return expectedToolError('external', 'The MCP server rejected the tool request.', {
      retryable: classification.recoveryClass === 'read' || classification.recoveryClass === 'idempotent',
      // This error contains no transport-stage proof that the request was
      // rejected before external side effects began.
      outcome,
    });
  }
  return expectedToolError('external', 'The MCP transport could not complete the tool request.', {
    retryable: classification.recoveryClass === 'read' || classification.recoveryClass === 'idempotent',
    outcome,
  });
}

function possibleMcpOutcome(classification: McpClassification): 'not_applied' | 'unknown' {
  return classification.readonly ? 'not_applied' : 'unknown';
}

function readRawMcpErrorMarker(value: unknown): boolean | 'invalid' | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, 'isError');
  } catch {
    return 'invalid';
  }
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor) || descriptor.enumerable !== true ||
    typeof descriptor.value !== 'boolean') return 'invalid';
  return descriptor.value;
}

function linkMcpCallSignal(
  context: Pick<ToolExecuteContext, 'signal' | 'deadline'>,
  parentSignal: AbortSignal | undefined,
): { signal: AbortSignal; deadlineElapsed(): boolean; close(): void } {
  const deadline = Date.parse(context.deadline);
  if (!Number.isFinite(deadline)) throw expectedToolError('precondition', 'The persisted MCP deadline is invalid.');
  const controller = new AbortController();
  let elapsed = false;
  const abortFromContext = () => controller.abort(context.signal.reason);
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (context.signal.aborted) abortFromContext();
  else context.signal.addEventListener('abort', abortFromContext, { once: true });
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  const timer = setTimeout(() => {
    elapsed = true;
    controller.abort(new Error('MCP invocation deadline elapsed.'));
  }, Math.max(0, deadline - Date.now()));
  timer.unref?.();
  return {
    signal: controller.signal,
    deadlineElapsed: () => elapsed,
    close: () => {
      clearTimeout(timer);
      context.signal.removeEventListener('abort', abortFromContext);
      parentSignal?.removeEventListener('abort', abortFromParent);
    },
  };
}

function semanticRevision(prefix: string, value: unknown): string {
  return `${prefix}:${createHash('sha256').update(canonicalMcpJson(value)).digest('hex')}`;
}

function digestPortable(value: PortableValue): string {
  return createHash('sha256').update(canonicalMcpJson(value)).digest('hex');
}

function canonicalMcpJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('MCP data must contain finite numbers.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalMcpJson).join(',')}]`;
  if (!isRecord(value)) throw new TypeError('MCP data must be JSON-compatible.');
  return `{${Object.keys(value).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalMcpJson(value[key])}`,
  ).join(',')}}`;
}

function standardMcpAnnotations(annotations: McpToolAnnotations) {
  return {
    ...(annotations.readOnlyHint === undefined ? {} : { readOnlyHint: annotations.readOnlyHint }),
    ...(annotations.destructiveHint === undefined ? {} : { destructiveHint: annotations.destructiveHint }),
    ...(annotations.idempotentHint === undefined ? {} : { idempotentHint: annotations.idempotentHint }),
    ...(annotations.openWorldHint === undefined ? {} : { openWorldHint: annotations.openWorldHint }),
  };
}

function compileMcpOutputValidator(
  toolName: string,
  schema: Record<string, unknown>,
): JsonSchemaValidator<unknown> {
  try {
    return new AjvJsonSchemaValidator().getValidator<unknown>(schema);
  } catch {
    throw new TypeError(`MCP output schema could not be compiled for Tool ${toolName}.`);
  }
}

function countPortableRecords(root: PortableValue): number {
  const pending: PortableValue[] = [root];
  let records = 0;
  while (pending.length > 0) {
    const value = pending.pop()!;
    if (value === null || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      records += value.length;
      pending.push(...value);
    } else {
      const values = Object.values(value);
      records += values.length;
      pending.push(...values);
    }
    if (records > MAX_MCP_CATALOG_RECORDS) return records;
  }
  return records;
}

function normalizeInputSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  if (schema === undefined || schema.type !== 'object') return structuredClone(UNKNOWN_SCHEMA);
  return structuredClone(schema);
}

function normalizeTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_MCP_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 86_400_000) {
    throw new TypeError('MCP tool timeout must be an integer from 1 to 86400000 milliseconds.');
  }
  return timeout;
}

function normalizeServerId(value: string): string {
  if (typeof value !== 'string' || !validBoundedText(value, MAX_SERVER_ID_CHARS)) {
    throw new Error('MCP server id is invalid.');
  }
  return value;
}

function normalizeHost(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLocaleLowerCase();
  if (!validBoundedText(normalized, 253) || /[\s/?#@]/u.test(normalized)) {
    throw new TypeError('MCP transport host is invalid.');
  }
  return normalized;
}

function boundedGenerationId(value: string): string {
  if (typeof value !== 'string' || !validBoundedText(value, 128)) {
    throw new TypeError('MCP generation id is invalid.');
  }
  return value;
}

function validBoundedText(value: string, maxChars: number): boolean {
  return value.trim().length > 0 && value.trim() === value && value.length <= maxChars &&
    !hasUnsupportedControlCharacter(value);
}

function hasUnsupportedControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 8 || code === 11 || code === 12 || code >= 14 && code <= 31) return true;
  }
  return false;
}

function sanitizeToolNamePart(value: string): string {
  const sanitized = value.trim().replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '').slice(0, MAX_TOOL_NAME_LENGTH);
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

function uniqueLabels<T extends string>(values: readonly (T | undefined)[]): T[] {
  return [...new Set(values.filter((value): value is T => value !== undefined && value.length > 0))];
}

class McpPayloadBoundaryError extends Error {
  constructor(readonly kind: 'malformed' | 'limit') {
    super(`MCP payload ${kind}.`);
    this.name = 'McpPayloadBoundaryError';
  }
}

function snapshotMcpValue(root: unknown, maxBytes: number): PortableValue {
  let records = 0;
  let estimatedBytes = 0;
  const ancestors = new Set<object>();
  const addBytes = (bytes: number): void => {
    estimatedBytes += bytes;
    if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes > maxBytes) {
      throw new McpPayloadBoundaryError('limit');
    }
  };
  const visit = (value: unknown, depth: number): PortableValue => {
    if (depth > MAX_MCP_DEPTH) throw new McpPayloadBoundaryError('limit');
    if (value === null || typeof value === 'boolean') {
      addBytes(value === null ? 4 : value ? 4 : 5);
      return value;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new McpPayloadBoundaryError('malformed');
      addBytes(String(value).length);
      return value;
    }
    if (typeof value === 'string') {
      const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
      if (bytes > MAX_MCP_STRING_BYTES) throw new McpPayloadBoundaryError('limit');
      addBytes(bytes);
      return value;
    }
    if (typeof value !== 'object' || ancestors.has(value)) throw new McpPayloadBoundaryError('malformed');
    let prototype: unknown;
    let keys: Array<string | symbol>;
    try {
      prototype = Object.getPrototypeOf(value);
      keys = Reflect.ownKeys(value);
    } catch {
      throw new McpPayloadBoundaryError('malformed');
    }
    if (Array.isArray(value)) {
      const length = value.length;
      if (!Number.isSafeInteger(length) || length < 0 || records + length > MAX_MCP_RECORDS) {
        throw new McpPayloadBoundaryError('limit');
      }
      if (keys.some((key) => typeof key === 'symbol' || key !== 'length' &&
        (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(key)))) {
        throw new McpPayloadBoundaryError('malformed');
      }
      if (keys.length !== length + 1) throw new McpPayloadBoundaryError('malformed');
      ancestors.add(value);
      records += length;
      addBytes(2 + Math.max(0, length - 1));
      const result: PortableValue[] = [];
      try {
        for (let index = 0; index < length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
            throw new McpPayloadBoundaryError('malformed');
          }
          result.push(visit(descriptor.value, depth + 1));
        }
      } finally {
        ancestors.delete(value);
      }
      return result;
    }
    if (prototype !== Object.prototype && prototype !== null) throw new McpPayloadBoundaryError('malformed');
    if (keys.some((key) => typeof key === 'symbol')) throw new McpPayloadBoundaryError('malformed');
    if (records + keys.length > MAX_MCP_RECORDS) throw new McpPayloadBoundaryError('limit');
    ancestors.add(value);
    records += keys.length;
    addBytes(2 + Math.max(0, keys.length - 1));
    const result: Record<string, PortableValue> = Object.create(null) as Record<string, PortableValue>;
    try {
      for (const key of keys as string[]) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
          throw new McpPayloadBoundaryError('malformed');
        }
        const keyBytes = Buffer.byteLength(JSON.stringify(key), 'utf8');
        if (keyBytes > 4_096) throw new McpPayloadBoundaryError('limit');
        addBytes(keyBytes + 1);
        result[key] = visit(descriptor.value, depth + 1);
      }
    } finally {
      ancestors.delete(value);
    }
    return result;
  };
  const snapshot = visit(root, 0);
  if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > maxBytes) {
    throw new McpPayloadBoundaryError('limit');
  }
  return snapshot;
}

function isRecord(value: unknown): value is Record<string, PortableValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
