import {
  PREPARED_TOOL_INTENT_REVISION,
  createRuntimeCommandToolResult,
  expectedToolError,
  type AgentToolPermissionFacts,
  type InvocationLimits,
  type PreparedToolIntent,
  type RuntimeCommandProjection,
  type ToolInvocationContribution,
  type ToolPrepareContext,
  type ToolRegistry,
} from '@dbagent/core-agent';
import { assertPortableValue, type PortableValue } from '@dbagent/shared';

const MAX_CHILD_ID_CHARS = 256;
const MAX_TASK_CHARS = 4_096;
const MAX_REASON_CHARS = 2_048;
const MAX_CURSOR_CHARS = 1_024;
const MAX_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
const MAX_LIST_CHILDREN = 100;
const MAX_PORTABLE_BYTES = 64 * 1024;
const MAX_PORTABLE_DEPTH = 8;
const MAX_PORTABLE_CONTAINER_ENTRIES = 64;
const MAX_PORTABLE_NODES = 512;
const MAX_PORTABLE_STRING_CHARS = 8_192;
const MAX_PORTABLE_KEY_CHARS = 256;

const MUTATION_LIMITS = Object.freeze({
  timeoutMs: 30_000,
  maxInputBytes: 96 * 1024,
  maxOutputBytes: 64 * 1024,
  maxArtifactBytes: 64 * 1024,
  maxDepth: MAX_PORTABLE_DEPTH,
  maxRecords: MAX_PORTABLE_NODES,
});
const READ_LIMITS = Object.freeze({
  timeoutMs: 35_000,
  maxInputBytes: 96 * 1024,
  maxOutputBytes: 96 * 1024,
  maxArtifactBytes: 96 * 1024,
  maxDepth: MAX_PORTABLE_DEPTH,
  maxRecords: MAX_LIST_CHILDREN,
});

type SubagentToolName =
  | 'subagent_spawn'
  | 'subagent_list'
  | 'subagent_wait'
  | 'subagent_message'
  | 'subagent_stop';

type PublicChild = Readonly<{
  id: string;
  status: RuntimeChild['status'];
  revision: number;
}>;

type WaitCursor = Readonly<{ id: string; revision: number }>;
type RuntimeChild = RuntimeCommandProjection['children'][number];

/** Runtime construction is owned by the internal Agent host. */
export type SubagentToolOptions = Readonly<Record<string, never>>;

/**
 * Compatibility registration for isolated Registry construction. Hosts should
 * publish these as deferred contributions, not include them in the baseline.
 */
export function registerSubagentTools(
  registry: ToolRegistry,
  _options: SubagentToolOptions = {},
): void {
  void _options;
  for (const contribution of createSubagentToolContributions()) {
    registry.registerInvocation(contribution.definition, contribution.runtime);
  }
}

/** Deferred Runtime coordination Tools. They never define a child baseline. */
export function createSubagentToolContributions(): readonly ToolInvocationContribution[] {
  return Object.freeze([
    subagentSpawnContribution(),
    subagentListContribution(),
    subagentWaitContribution(),
    subagentMessageContribution(),
    subagentStopContribution(),
  ]);
}

function subagentSpawnContribution(): ToolInvocationContribution {
  return contribution({
    name: 'subagent_spawn',
    description: 'Start one bounded child task. The child inherits the Runtime baseline Tools.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['task'],
      properties: {
        task: { type: 'string', minLength: 1, maxLength: MAX_TASK_CHARS },
        context: portableValueSchema(MAX_PORTABLE_DEPTH),
      },
    },
    access: 'write', concurrency: 'write', recoveryClass: 'idempotent', limits: MUTATION_LIMITS,
    prepare(input, context) {
      const task = requiredText(input.task, 'task', MAX_TASK_CHARS);
      const childContext = input.context === undefined ? null : boundedPortableValue(input.context, 'context');
      return preparedIntent({
        context, input: { task, context: childContext },
        targetIdentity: { kind: 'runtime-child-collection', runId: context.runId },
        access: 'write', concurrency: 'write', recoveryClass: 'idempotent',
        resourceKeys: [`children:${context.runId}`], action: 'Start one child task.',
      });
    },
    execute(input) {
      const task = requiredText(input.task, 'prepared task', MAX_TASK_CHARS);
      const context = boundedPortableValue(input.context, 'prepared context');
      return createRuntimeCommandToolResult({
        command: { kind: 'child.start', payload: { task, context } },
        result: { status: 'ok', summary: 'Child task start was accepted.', accepted: true },
      });
    },
  });
}

function subagentListContribution(): ToolInvocationContribution {
  return contribution({
    name: 'subagent_list',
    description: 'Read a bounded snapshot of child tasks owned by the current parent Run.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    access: 'read', concurrency: 'read', recoveryClass: 'read', limits: READ_LIMITS,
    prepare(_input, context) {
      const state = requireRuntimeState(context);
      const children = state.children.slice(0, MAX_LIST_CHILDREN).map(publicChild);
      const omittedCount = Math.max(0, state.children.length - children.length);
      return preparedIntent({
        context, input: { children, omittedCount },
        targetIdentity: { kind: 'runtime-child-collection', runId: context.runId, revision: state.revision },
        access: 'read', concurrency: 'read', recoveryClass: 'read',
        resourceKeys: [`children:${context.runId}`], action: 'Read child task status.',
      });
    },
    execute(input) {
      const children = preparedChildren(input.children);
      const omittedCount = boundedNonNegativeInteger(input.omittedCount, 'prepared omittedCount');
      return {
        status: 'ok',
        summary: children.length === 0 ? 'No child tasks exist.' : `Read ${children.length} child task statuses.`,
        children, truncated: omittedCount > 0, omittedCount,
      };
    },
  });
}

function subagentWaitContribution(): ToolInvocationContribution {
  return contribution({
    name: 'subagent_wait',
    description: 'Wait for a child status change for a bounded interval, or read its current state with a cursor.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['id'],
      properties: {
        id: { type: 'string', minLength: 1, maxLength: MAX_CHILD_ID_CHARS },
        timeoutMs: { type: 'integer', minimum: 0, maximum: MAX_WAIT_TIMEOUT_MS },
        cursor: { type: 'string', minLength: 1, maxLength: MAX_CURSOR_CHARS },
      },
    },
    access: 'read', concurrency: 'read', recoveryClass: 'read', limits: READ_LIMITS,
    prepare(input, context) {
      const id = requiredText(input.id, 'id', MAX_CHILD_ID_CHARS);
      const child = requireOwnedChild(requireRuntimeState(context), id);
      const timeoutMs = boundedWaitTimeout(input.timeoutMs);
      const cursor = input.cursor === undefined ? undefined : parseWaitCursor(input.cursor);
      if (cursor !== undefined && cursor.id !== child.childRunId) {
        throw expectedToolError('invalid_cursor', 'The wait cursor belongs to a different child task.');
      }
      if (cursor !== undefined && cursor.revision > child.revision) {
        throw expectedToolError('invalid_cursor', 'The wait cursor is ahead of the child task revision.');
      }
      const shouldWait = child.status === 'running' && timeoutMs > 0 &&
        (cursor === undefined || cursor.revision === child.revision);
      const childProjection = publicChild(child);
      const waitCursor = encodeWaitCursor(child);
      return preparedIntent({
        context,
        input: {
          id: child.childRunId, expectedChildRevision: child.revision, timeoutMs,
          cursor: waitCursor, child: childProjection, shouldWait,
        },
        targetIdentity: childTargetIdentity(context.runId, child),
        access: 'read', concurrency: 'read', recoveryClass: 'read',
        resourceKeys: [`child:${context.runId}:${child.childRunId}`],
        action: shouldWait
          ? `Wait up to ${timeoutMs}ms for child ${child.childRunId}.`
          : `Read child ${child.childRunId} status.`,
      });
    },
    execute(input) {
      const child = preparedChild(input.child);
      const timeoutMs = boundedWaitTimeout(input.timeoutMs);
      const cursor = requiredText(input.cursor, 'prepared cursor', MAX_CURSOR_CHARS);
      const shouldWait = input.shouldWait === true;
      if (!shouldWait) return waitResult(child, timeoutMs, cursor, false);
      const id = requiredText(input.id, 'prepared id', MAX_CHILD_ID_CHARS);
      const expectedChildRevision = positiveInteger(input.expectedChildRevision, 'prepared child revision');
      return createRuntimeCommandToolResult({
        command: { kind: 'child.wait', payload: { childRunId: id, expectedChildRevision } },
        // The Host receives this sealed payload after the Journal command. It
        // must use timeoutMs/cursor when waiting and return the current child
        // state with timedOut=true when the deadline is reached.
        result: waitResult(child, timeoutMs, cursor, false),
      });
    },
  });
}

function subagentMessageContribution(): ToolInvocationContribution {
  return contribution({
    name: 'subagent_message',
    description: 'Steer one running child task at its next durable safe boundary.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['id', 'input'],
      properties: {
        id: { type: 'string', minLength: 1, maxLength: MAX_CHILD_ID_CHARS },
        input: portableValueSchema(MAX_PORTABLE_DEPTH),
      },
    },
    access: 'write', concurrency: 'write', recoveryClass: 'idempotent', limits: MUTATION_LIMITS,
    prepare(input, context) {
      const id = requiredText(input.id, 'id', MAX_CHILD_ID_CHARS);
      const child = requireRunningChild(requireRuntimeState(context), id);
      const message = boundedPortableValue(requiredInput(input, 'input'), 'input');
      return preparedIntent({
        context, input: { id: child.childRunId, expectedChildRevision: child.revision, input: message },
        targetIdentity: childTargetIdentity(context.runId, child),
        access: 'write', concurrency: 'write', recoveryClass: 'idempotent',
        resourceKeys: [`child:${context.runId}:${child.childRunId}`], action: `Steer child ${child.childRunId}.`,
      });
    },
    execute(input) {
      const id = requiredText(input.id, 'prepared id', MAX_CHILD_ID_CHARS);
      const expectedChildRevision = positiveInteger(input.expectedChildRevision, 'prepared child revision');
      const message = boundedPortableValue(requiredInput(input, 'input'), 'prepared input');
      return createRuntimeCommandToolResult({
        command: { kind: 'child.steer', payload: { childRunId: id, expectedChildRevision, input: message } },
        result: { status: 'ok', summary: 'Child steering input was accepted.', id, accepted: true },
      });
    },
  });
}

function subagentStopContribution(): ToolInvocationContribution {
  return contribution({
    name: 'subagent_stop',
    description: 'Cancel one running child task through the durable Runtime cancellation path.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['id'],
      properties: {
        id: { type: 'string', minLength: 1, maxLength: MAX_CHILD_ID_CHARS },
        reason: { type: 'string', minLength: 1, maxLength: MAX_REASON_CHARS },
      },
    },
    access: 'write', concurrency: 'write', recoveryClass: 'idempotent', limits: MUTATION_LIMITS,
    prepare(input, context) {
      const id = requiredText(input.id, 'id', MAX_CHILD_ID_CHARS);
      const child = requireRunningChild(requireRuntimeState(context), id);
      const reason = input.reason === undefined ? undefined : requiredText(input.reason, 'reason', MAX_REASON_CHARS);
      return preparedIntent({
        context,
        input: {
          id: child.childRunId, expectedChildRevision: child.revision,
          ...(reason === undefined ? {} : { reason }),
        },
        targetIdentity: childTargetIdentity(context.runId, child),
        access: 'write', concurrency: 'write', recoveryClass: 'idempotent',
        resourceKeys: [`child:${context.runId}:${child.childRunId}`], action: `Cancel child ${child.childRunId}.`,
      });
    },
    execute(input) {
      const id = requiredText(input.id, 'prepared id', MAX_CHILD_ID_CHARS);
      const expectedChildRevision = positiveInteger(input.expectedChildRevision, 'prepared child revision');
      const reason = input.reason === undefined ? undefined : requiredText(input.reason, 'prepared reason', MAX_REASON_CHARS);
      return createRuntimeCommandToolResult({
        command: {
          kind: 'child.cancel',
          payload: {
            childRunId: id, expectedChildRevision,
            ...(reason === undefined ? {} : { reason }),
          },
        },
        result: { status: 'ok', summary: 'Child cancellation was accepted.', id, accepted: true },
      });
    },
  });
}

function contribution(input: Readonly<{
  name: SubagentToolName;
  description: string;
  inputSchema: Record<string, PortableValue>;
  access: 'read' | 'write';
  concurrency: 'read' | 'write';
  recoveryClass: 'read' | 'idempotent';
  limits: InvocationLimits;
  prepare: ToolInvocationContribution['runtime']['prepare'];
  execute: ToolInvocationContribution['runtime']['execute'];
}>): ToolInvocationContribution {
  const toolRevision = `${input.name}.v1`;
  const handlerRevision = `${input.name}.handler.v2`;
  return Object.freeze({
    definition: {
      name: input.name, description: input.description, aliases: [], tags: ['coordination', 'subagent'],
      source: 'runtime', exposure: 'deferred', dangerLevel: 'safe', readonly: input.access === 'read',
      access: input.access, recoveryClass: input.recoveryClass, permission: { actions: [input.access] },
      inputSchema: input.inputSchema, outputSchema: subagentOutputSchema(input.name), limits: input.limits,
      toolRevision, handlerRevision, intentRevision: PREPARED_TOOL_INTENT_REVISION,
      execution: { concurrency: input.concurrency, timeoutMs: input.limits.timeoutMs },
      failurePolicy: { onUnknown: { failureKind: 'unknown', retryable: false } },
      completion: { role: 'none' },
      presentation: { category: 'subagent', preparingMessage: '正在准备子任务操作。' },
    },
    runtime: {
      revision: { toolName: input.name, toolRevision, handlerRevision, intentRevision: PREPARED_TOOL_INTENT_REVISION },
      prepare: input.prepare, execute: input.execute,
    },
  } satisfies ToolInvocationContribution);
}

function preparedIntent(input: Readonly<{
  context: ToolPrepareContext;
  input: Readonly<Record<string, PortableValue>>;
  targetIdentity: PortableValue;
  access: 'read' | 'write';
  concurrency: 'read' | 'write';
  recoveryClass: 'read' | 'idempotent';
  resourceKeys: readonly string[];
  action: string;
}>): PreparedToolIntent {
  return Object.freeze({
    input: Object.freeze(structuredClone(input.input)),
    toolRevision: input.context.toolRevision, handlerRevision: input.context.handlerRevision,
    intentRevision: PREPARED_TOOL_INTENT_REVISION, targetIdentity: structuredClone(input.targetIdentity),
    generation: input.context.generation, action: { summary: input.action },
    permission: permissionFacts(input.context, input.access, input.recoveryClass, input.targetIdentity),
    access: input.access, recoveryClass: input.recoveryClass, concurrency: input.concurrency,
    resourceKeys: Object.freeze([...input.resourceKeys]), limits: input.context.limits,
  });
}

function permissionFacts(
  context: ToolPrepareContext,
  access: 'read' | 'write',
  recoveryClass: 'read' | 'idempotent',
  target: PortableValue,
): AgentToolPermissionFacts {
  return {
    toolName: context.descriptor.flatName, dangerLevel: 'safe', readonly: access === 'read', access,
    recoveryClass, actions: [access], paths: [], hosts: [], network: false, externalWrite: false,
    destructive: false, credentials: false, admin: false, unknownRisk: false, resolvedAddresses: [],
    targets: [structuredClone(target)],
  };
}

function requireRuntimeState(context: Pick<ToolPrepareContext, 'runtimeState'>): RuntimeCommandProjection {
  if (context.runtimeState === undefined) {
    throw expectedToolError('precondition', 'The Journal-backed child task state is unavailable.');
  }
  return context.runtimeState;
}

function requireOwnedChild(state: RuntimeCommandProjection, id: string): RuntimeChild {
  const child = state.children.find((candidate) => candidate.childRunId === id);
  if (child === undefined) {
    throw expectedToolError('not_found', 'The requested child task is not owned by the current parent Run.');
  }
  return child;
}

function requireRunningChild(state: RuntimeCommandProjection, id: string): RuntimeChild {
  const child = requireOwnedChild(state, id);
  if (child.status !== 'running') {
    throw expectedToolError('conflict', 'The requested child task is no longer running.');
  }
  return child;
}

function childTargetIdentity(runId: string, child: RuntimeChild): PortableValue {
  return {
    kind: 'runtime-child', runId, childRunId: child.childRunId,
    revision: child.revision, status: child.status,
  };
}

function publicChild(child: RuntimeChild): PublicChild {
  return Object.freeze({ id: child.childRunId, status: child.status, revision: child.revision });
}

function waitResult(
  child: PublicChild,
  timeoutMs: number,
  cursor: string,
  timedOut: boolean,
): Record<string, PortableValue> {
  return {
    status: timedOut ? 'partial' : 'ok',
    summary: timedOut
      ? `Child ${child.id} did not change before the wait timeout.`
      : `Child ${child.id} is ${child.status}.`,
    child, timeoutMs, cursor, timedOut,
  };
}

function preparedChildren(value: PortableValue | undefined): PublicChild[] {
  if (!Array.isArray(value) || value.length > MAX_LIST_CHILDREN) {
    throw expectedToolError('precondition', 'Prepared child list is invalid.');
  }
  return value.map(preparedChild);
}

function preparedChild(value: PortableValue | undefined): PublicChild {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw expectedToolError('precondition', 'Prepared child state is invalid.');
  }
  const record = value as Record<string, PortableValue>;
  const id = requiredText(record.id, 'prepared child id', MAX_CHILD_ID_CHARS);
  const revision = positiveInteger(record.revision, 'prepared child revision');
  const status = record.status;
  if (
    status !== 'running' && status !== 'completed' && status !== 'failed' &&
    status !== 'cancelled' && status !== 'limit_reached' && status !== 'interrupted'
  ) {
    throw expectedToolError('precondition', 'Prepared child status is invalid.');
  }
  return Object.freeze({ id, revision, status });
}

function requiredInput(input: Readonly<Record<string, PortableValue>>, name: string): PortableValue {
  const value = input[name];
  if (value === undefined) throw expectedToolError('invalid_argument', `${name} is required.`);
  return value;
}

function requiredText(value: PortableValue | undefined, name: string, maximum: number): string {
  if (typeof value !== 'string') {
    throw expectedToolError('invalid_argument', `${name} must be a bounded string.`);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw expectedToolError('limit', `${name} must contain 1-${maximum} characters.`);
  }
  if (Buffer.byteLength(normalized, 'utf8') > maximum * 4) {
    throw expectedToolError('limit', `${name} exceeds its UTF-8 byte limit.`);
  }
  return normalized;
}

function boundedWaitTimeout(value: PortableValue | undefined): number {
  const timeoutMs = value === undefined ? DEFAULT_WAIT_TIMEOUT_MS : value;
  if (
    typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 0 || timeoutMs > MAX_WAIT_TIMEOUT_MS
  ) {
    throw expectedToolError('invalid_argument', `timeoutMs must be an integer from 0 to ${MAX_WAIT_TIMEOUT_MS}.`);
  }
  return timeoutMs;
}

function positiveInteger(value: PortableValue | undefined, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw expectedToolError('precondition', `${name} is invalid.`);
  }
  return value;
}

function boundedNonNegativeInteger(value: PortableValue | undefined, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_LIST_CHILDREN) {
    throw expectedToolError('precondition', `${name} is invalid.`);
  }
  return value;
}

function boundedPortableValue(value: unknown, name: string): PortableValue {
  try {
    assertPortableValue(value);
  } catch {
    throw expectedToolError('invalid_argument', `${name} must be a portable value.`);
  }
  const portable = value;
  const limits = { nodes: 0 };
  assertPortableBounds(portable, name, 0, limits);
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(portable), 'utf8');
  } catch {
    throw expectedToolError('invalid_argument', `${name} must be serializable.`);
  }
  if (bytes > MAX_PORTABLE_BYTES) {
    throw expectedToolError('limit', `${name} exceeds the ${MAX_PORTABLE_BYTES}-byte limit.`);
  }
  return structuredClone(portable);
}

function assertPortableBounds(
  value: PortableValue,
  name: string,
  depth: number,
  state: { nodes: number },
): void {
  state.nodes += 1;
  if (state.nodes > MAX_PORTABLE_NODES) {
    throw expectedToolError('limit', `${name} has more than ${MAX_PORTABLE_NODES} values.`);
  }
  if (depth > MAX_PORTABLE_DEPTH) {
    throw expectedToolError('limit', `${name} exceeds depth ${MAX_PORTABLE_DEPTH}.`);
  }
  if (typeof value === 'string') {
    if (value.length > MAX_PORTABLE_STRING_CHARS) {
      throw expectedToolError('limit', `${name} contains an overlong string value.`);
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    if (value.length > MAX_PORTABLE_CONTAINER_ENTRIES) {
      throw expectedToolError('limit', `${name} contains an oversized array.`);
    }
    for (const item of value) assertPortableBounds(item, name, depth + 1, state);
    return;
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_PORTABLE_CONTAINER_ENTRIES) {
    throw expectedToolError('limit', `${name} contains an oversized object.`);
  }
  for (const [key, item] of entries) {
    if (key.length > MAX_PORTABLE_KEY_CHARS) {
      throw expectedToolError('limit', `${name} contains an overlong object key.`);
    }
    assertPortableBounds(item, name, depth + 1, state);
  }
}

function encodeWaitCursor(child: RuntimeChild): string {
  const encoded = Buffer.from(JSON.stringify({ id: child.childRunId, revision: child.revision }), 'utf8')
    .toString('base64url');
  return `subagent_wait.v1.${encoded}`;
}

function parseWaitCursor(value: PortableValue): WaitCursor {
  const encoded = requiredText(value, 'cursor', MAX_CURSOR_CHARS);
  const prefix = 'subagent_wait.v1.';
  if (!encoded.startsWith(prefix)) {
    throw expectedToolError('invalid_cursor', 'The wait cursor is invalid.');
  }
  try {
    const parsed = JSON.parse(Buffer.from(encoded.slice(prefix.length), 'base64url').toString('utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    const record = parsed as Record<string, unknown>;
    if (Object.keys(record).length !== 2 || typeof record.id !== 'string' ||
      record.id.length === 0 || record.id.length > MAX_CHILD_ID_CHARS ||
      typeof record.revision !== 'number' || !Number.isSafeInteger(record.revision) || record.revision < 1) {
      throw new Error('invalid cursor fields');
    }
    return Object.freeze({ id: record.id, revision: record.revision });
  } catch {
    throw expectedToolError('invalid_cursor', 'The wait cursor is invalid.');
  }
}

function portableValueSchema(depth: number): Record<string, PortableValue> {
  if (depth <= 0) {
    return {
      anyOf: [
        { type: 'null' }, { type: 'boolean' }, { type: 'number' },
        { type: 'string', maxLength: MAX_PORTABLE_STRING_CHARS },
      ],
    };
  }
  const child = portableValueSchema(depth - 1);
  return {
    anyOf: [
      { type: 'null' }, { type: 'boolean' }, { type: 'number' },
      { type: 'string', maxLength: MAX_PORTABLE_STRING_CHARS },
      { type: 'array', maxItems: MAX_PORTABLE_CONTAINER_ENTRIES, items: child },
      {
        type: 'object', maxProperties: MAX_PORTABLE_CONTAINER_ENTRIES,
        propertyNames: { maxLength: MAX_PORTABLE_KEY_CHARS }, additionalProperties: child,
      },
    ],
  };
}

function subagentOutputSchema(name: SubagentToolName): Record<string, PortableValue> {
  const child = {
    type: 'object', additionalProperties: false, required: ['id', 'status', 'revision'],
    properties: {
      id: { type: 'string', maxLength: MAX_CHILD_ID_CHARS },
      status: {
        type: 'string',
        enum: ['running', 'completed', 'failed', 'cancelled', 'limit_reached', 'interrupted'],
      },
      revision: { type: 'integer', minimum: 1 },
    },
  } as Record<string, PortableValue>;
  const base = {
    type: 'object', additionalProperties: false, required: ['status', 'summary'],
    properties: {
      status: { type: 'string', enum: name === 'subagent_wait' ? ['ok', 'partial'] : ['ok'] },
      summary: { type: 'string', maxLength: 1_024 }, accepted: { type: 'boolean' },
      id: { type: 'string', maxLength: MAX_CHILD_ID_CHARS }, child,
      children: { type: 'array', maxItems: MAX_LIST_CHILDREN, items: child },
      truncated: { type: 'boolean' },
      omittedCount: { type: 'integer', minimum: 0, maximum: MAX_LIST_CHILDREN },
      timeoutMs: { type: 'integer', minimum: 0, maximum: MAX_WAIT_TIMEOUT_MS },
      cursor: { type: 'string', maxLength: MAX_CURSOR_CHARS }, timedOut: { type: 'boolean' },
    },
  } as Record<string, PortableValue>;
  if (name === 'subagent_list') {
    return { ...base, required: ['status', 'summary', 'children', 'truncated', 'omittedCount'] };
  }
  if (name === 'subagent_wait') {
    return { ...base, required: ['status', 'summary', 'child', 'timeoutMs', 'cursor', 'timedOut'] };
  }
  return base;
}
