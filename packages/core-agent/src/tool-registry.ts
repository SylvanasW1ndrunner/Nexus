import type { LlmTool } from '@dbagent/core-llm';
import { assertPortableValue, type PortableValue } from '@dbagent/shared';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  bindInvocationHandlerSnapshot,
  cloneInvocationHandlers,
  deleteInvocationHandler,
  replaceInvocationHandlers,
  setInvocationHandler,
} from './internal/tool-invocation-authority.js';
import type {
  AgentToolCatalogChange,
  AgentToolContribution,
  AgentToolDefinition,
  AgentToolDescriptor,
  AgentToolHandler,
  AgentToolId,
  AgentToolRuntime,
  RegisteredAgentTool,
  ToolEffect,
} from './types.js';

const TOOL_HANDLER_CONTRACT_IDENTITY = Symbol.for(
  '@dbagent/core-agent/tool-handler-contract-identity',
);
const MAX_DESCRIPTOR_CONTAINER_ENTRIES = 10_000;

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredAgentTool>();
  private readonly runtimes = new Map<string, AgentToolRuntime>();
  private readonly invocationRevisions = new Map<string, string>();
  private readonly ownerByTool = new Map<string, string>();
  private readonly toolsByOwner = new Map<string, Set<string>>();
  private readonly activeToolRevisions = new Map<string, number>();
  private readonly toolGenerations = new Map<string, number>();
  private readonly snapshotLifecycles = new Map<string, AgentToolSnapshotLifecycle>();
  private readonly listeners = new Set<(event: AgentToolCatalogChange) => void>();
  private revision = 0;

  get catalogRevision(): number {
    return this.revision;
  }

  register(definition: AgentToolDefinition, handler: AgentToolHandler): void {
    validateToolContract(definition, handler);
    if (this.tools.has(definition.name)) {
      throw new Error(`Tool already registered: ${definition.name}`);
    }
    const registered = registeredTool(definition, handler);
    const descriptor = registered.descriptor;
    this.tools.set(definition.name, registered);
    this.runtimes.set(toolIdKey(descriptor.id), {
      id: descriptor.id,
      flatName: descriptor.flatName,
      handler,
    });
    const ownerId = `direct:${definition.name}`;
    this.ownerByTool.set(definition.name, ownerId);
    this.toolsByOwner.set(ownerId, new Set([definition.name]));
    const toolRevision = (this.toolGenerations.get(definition.name) ?? 0) + 1;
    this.toolGenerations.set(definition.name, toolRevision);
    this.activeToolRevisions.set(definition.name, toolRevision);
    this.emit({
      revision: ++this.revision,
      kind: 'registered',
      toolName: definition.name,
      descriptor,
    });
  }

  /** Register a Handler that can only be called by ToolInvocationRuntime. */
  registerInvocation(
    definition: ToolInvocationDefinition,
    runtime: ToolInvocationHandlerRuntime,
  ): void {
    validateInvocationToolContract(definition, runtime);
    const guardedLegacyHandler: AgentToolHandler = () => {
      throw new Error('Invocation-only Tools must be executed by ToolInvocationRuntime.');
    };
    validateToolContract(definition, guardedLegacyHandler);
    if (this.tools.has(definition.name)) {
      throw new Error(`Tool already registered: ${definition.name}`);
    }
    const registered = registeredTool(definition, guardedLegacyHandler);
    const descriptor = registered.descriptor;
    const key = toolIdKey(descriptor.id);
    const invocationRuntime = Object.freeze({
      execute: runtime.execute,
      ...(runtime.recover === undefined ? {} : { recover: runtime.recover }),
    });
    const ownerId = `direct:${definition.name}`;
    const toolRevision = (this.toolGenerations.get(definition.name) ?? 0) + 1;
    const invocationRevision = stableInvocationRevision(descriptor, definition.handlerRevision);

    // Commit the complete catalog fact before observers can capture a snapshot.
    this.tools.set(definition.name, registered);
    this.runtimes.set(key, {
      id: descriptor.id, flatName: descriptor.flatName, handler: guardedLegacyHandler,
    });
    setInvocationHandler(this, definition.name, invocationRuntime);
    this.invocationRevisions.set(definition.name, invocationRevision);
    this.ownerByTool.set(definition.name, ownerId);
    this.toolsByOwner.set(ownerId, new Set([definition.name]));
    this.toolGenerations.set(definition.name, toolRevision);
    this.activeToolRevisions.set(definition.name, toolRevision);
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
    deleteInvocationHandler(this, name);
    this.invocationRevisions.delete(name);
    const ownerId = this.ownerByTool.get(name);
    this.ownerByTool.delete(name);
    this.activeToolRevisions.delete(name);
    this.snapshotLifecycles.delete(name);
    if (ownerId) {
      const names = this.toolsByOwner.get(ownerId);
      names?.delete(name);
      if (names?.size === 0) this.toolsByOwner.delete(ownerId);
    }
    this.emit({
      revision: ++this.revision,
      kind: 'unregistered',
      toolName: name,
      descriptor: tool.descriptor,
    });
    return true;
  }

  replaceOwnerTools(
    ownerId: string,
    contributions: readonly AgentToolContribution[],
    options: { snapshotLifecycle?: AgentToolSnapshotLifecycle } = {},
  ): void {
    const normalizedOwner = ownerId.trim();
    if (!normalizedOwner) throw new Error('Tool owner id is required.');
    const nextNames = new Set<string>();
    const prepared: RegisteredAgentTool[] = [];
    for (const contribution of contributions) {
      if (!isRecord(contribution) || !isRecord(contribution.definition)) {
        throw new Error('Tool contribution must provide a definition object.');
      }
      validateToolContract(contribution.definition, contribution.handler);
      const name = contribution.definition.name;
      if (nextNames.has(name)) throw new Error(`Tool already registered: ${name}`);
      nextNames.add(name);
      prepared.push(registeredTool(contribution.definition, contribution.handler));
    }

    const previousNames = new Set(this.toolsByOwner.get(normalizedOwner) ?? []);
    for (const name of nextNames) {
      const existingOwner = this.ownerByTool.get(name);
      if (existingOwner !== undefined && existingOwner !== normalizedOwner) {
        throw new Error(`Tool already registered: ${name}`);
      }
    }
    const unchangedNames = new Set(
      prepared
        .filter((tool) => {
          const previous = this.tools.get(tool.name);
          return previous !== undefined && sameToolContract(previous, tool);
        })
        .map((tool) => tool.name),
    );

    const nextTools = new Map(this.tools);
    const nextRuntimes = new Map(this.runtimes);
    const nextInvocationRuntimes = cloneInvocationHandlers(this);
    const nextInvocationRevisions = new Map(this.invocationRevisions);
    const nextOwnerByTool = new Map(this.ownerByTool);
    const nextActiveToolRevisions = new Map(this.activeToolRevisions);
    const nextToolGenerations = new Map(this.toolGenerations);
    const nextSnapshotLifecycles = new Map(this.snapshotLifecycles);
    for (const name of previousNames) {
      if (unchangedNames.has(name)) continue;
      const previous = nextTools.get(name);
      nextTools.delete(name);
      if (previous) {
        const key = toolIdKey(previous.descriptor.id);
        nextRuntimes.delete(key);
        nextInvocationRuntimes.delete(name);
        nextInvocationRevisions.delete(name);
      }
      nextOwnerByTool.delete(name);
      nextActiveToolRevisions.delete(name);
      nextSnapshotLifecycles.delete(name);
    }
    for (const tool of prepared) {
      nextInvocationRuntimes.delete(tool.name);
      nextInvocationRevisions.delete(tool.name);
      if (unchangedNames.has(tool.name)) {
        nextTools.set(tool.name, tool);
        nextRuntimes.set(toolIdKey(tool.descriptor.id), {
          id: tool.descriptor.id,
          flatName: tool.descriptor.flatName,
          handler: tool.handler,
        });
        nextOwnerByTool.set(tool.name, normalizedOwner);
        if (options.snapshotLifecycle) {
          nextSnapshotLifecycles.set(tool.name, options.snapshotLifecycle);
        } else {
          nextSnapshotLifecycles.delete(tool.name);
        }
        continue;
      }
      nextTools.set(tool.name, tool);
      nextRuntimes.set(toolIdKey(tool.descriptor.id), {
        id: tool.descriptor.id,
        flatName: tool.descriptor.flatName,
        handler: tool.handler,
      });
      nextOwnerByTool.set(tool.name, normalizedOwner);
      const toolRevision = (nextToolGenerations.get(tool.name) ?? 0) + 1;
      nextToolGenerations.set(tool.name, toolRevision);
      nextActiveToolRevisions.set(tool.name, toolRevision);
      if (options.snapshotLifecycle) {
        nextSnapshotLifecycles.set(tool.name, options.snapshotLifecycle);
      }
    }

    replaceMap(this.tools, nextTools);
    replaceMap(this.runtimes, nextRuntimes);
    replaceInvocationHandlers(this, nextInvocationRuntimes);
    replaceMap(this.invocationRevisions, nextInvocationRevisions);
    replaceMap(this.ownerByTool, nextOwnerByTool);
    replaceMap(this.activeToolRevisions, nextActiveToolRevisions);
    replaceMap(this.toolGenerations, nextToolGenerations);
    replaceMap(this.snapshotLifecycles, nextSnapshotLifecycles);
    if (nextNames.size === 0) this.toolsByOwner.delete(normalizedOwner);
    else this.toolsByOwner.set(normalizedOwner, nextNames);
    const added = [...nextNames].filter((name) => !previousNames.has(name)).sort();
    const updated = [...nextNames]
      .filter((name) => previousNames.has(name) && !unchangedNames.has(name))
      .sort();
    const removed = [...previousNames].filter((name) => !nextNames.has(name)).sort();
    if (added.length > 0 || updated.length > 0 || removed.length > 0) {
      this.emit({
        revision: ++this.revision,
        kind: 'owner-replaced',
        ownerId: normalizedOwner,
        added,
        updated,
        removed,
      });
    }
  }

  toolRevision(name: string): number | undefined {
    return this.activeToolRevisions.get(name);
  }

  captureSnapshot(): ToolCatalogSnapshot {
    const snapshot = new ToolCatalogSnapshot(
      this.revision,
      new Map(this.tools),
      new Map(this.runtimes),
      new Map(this.invocationRevisions),
      new Map(this.activeToolRevisions),
      new Map(this.snapshotLifecycles),
    );
    bindInvocationHandlerSnapshot(this, snapshot);
    return snapshot;
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
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Catalog observers are advisory. The mutation has already committed,
        // so an observer failure must never turn a successful transaction into
        // a reported failure or prevent later observers from seeing it.
      }
    }
  }
}

export class ToolCatalogSnapshot {
  private readonly releases: Array<() => void>;
  private released = false;

  constructor(
    readonly catalogRevision: number,
    private readonly tools: ReadonlyMap<string, RegisteredAgentTool>,
    private readonly runtimes: ReadonlyMap<string, AgentToolRuntime>,
    private readonly invocationRevisions: ReadonlyMap<string, string>,
    private readonly revisions: ReadonlyMap<string, number>,
    lifecycles: ReadonlyMap<string, AgentToolSnapshotLifecycle>,
  ) {
    const releases: Array<() => void> = [];
    try {
      for (const lifecycle of new Set(lifecycles.values())) releases.push(lifecycle.retain());
    } catch (error) {
      for (const release of releases.reverse()) release();
      throw error;
    }
    this.releases = releases;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    for (const release of this.releases.reverse()) release();
  }

  get(name: string): RegisteredAgentTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
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

  invocationRevision(name: string): string | undefined {
    return this.invocationRevisions.get(name);
  }

  toolRevision(name: string): number | undefined {
    return this.revisions.get(name);
  }

  llmTools(allowedTools?: string[]): LlmTool[] {
    const allowed = allowedTools === undefined ? undefined : new Set(allowedTools);
    return this.list()
      .filter((tool) => allowed === undefined || allowed.has(tool.name))
      .map(toLlmTool);
  }
}

export type AgentToolSnapshotLifecycle = {
  /** Retain one immutable Tool snapshot and return an idempotent release. */
  retain(): () => void;
};

export type ToolInvocationExecutionContext = Readonly<{
  projectId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  invocationId: string;
  idempotencyKey: string;
  fencingToken: number;
  signal: AbortSignal;
}>;

export type ToolInvocationHandler<Result = unknown> = (
  args: Readonly<Record<string, unknown>>,
  context: ToolInvocationExecutionContext,
) => Result | Promise<Result>;

export type ToolInvocationRecoveryHandler<Result = unknown> = (
  args: Readonly<Record<string, unknown>>,
  context: ToolInvocationExecutionContext,
) => Result | Promise<Result>;

export type ToolInvocationHandlerRuntime = Readonly<{
  execute: ToolInvocationHandler;
  recover?: ToolInvocationRecoveryHandler;
}>;

export type ToolInvocationDefinition = AgentToolDefinition & {
  effect: ToolEffect;
  /** Stable semantic revision supplied by the Handler owner, independent of process order. */
  handlerRevision: string;
};

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
    effect: definition.effect ?? 'legacy-undeclared',
    execution: {
      concurrency,
      ...(definition.execution?.timeoutMs === undefined
        ? {}
        : { timeoutMs: definition.execution.timeoutMs }),
    },
    ...(definition.failurePolicy === undefined
      ? {}
      : { failurePolicy: structuredClone(definition.failurePolicy) }),
    ...(definition.completion === undefined
      ? {}
      : { completion: structuredClone(definition.completion) }),
    ...(definition.presentation === undefined
      ? {}
      : { presentation: structuredClone(definition.presentation) }),
    ...(definition.protocolMetadata === undefined
      ? {}
      : { protocolMetadata: structuredClone(definition.protocolMetadata) }),
  };
}

function registeredTool(
  definition: AgentToolDefinition,
  handler: AgentToolHandler,
): RegisteredAgentTool {
  const descriptor = deepFreeze(descriptorFromDefinition(definition));
  return deepFreeze({
    name: descriptor.flatName,
    ...(descriptor.id.namespace === undefined ? {} : { namespace: descriptor.id.namespace }),
    ...(definition.originalName?.trim() ? { originalName: descriptor.id.name } : {}),
    ...(descriptor.title === undefined ? {} : { title: descriptor.title }),
    description: descriptor.description,
    inputSchema: descriptor.inputSchema,
    ...(descriptor.outputSchema === undefined ? {} : { outputSchema: descriptor.outputSchema }),
    aliases: [...descriptor.aliases],
    tags: [...descriptor.tags],
    dangerLevel: descriptor.dangerLevel,
    readonly: descriptor.readonly,
    source: descriptor.source,
    ...(descriptor.sourceId === undefined ? {} : { sourceId: descriptor.sourceId }),
    ...(descriptor.requiredPermission === undefined
      ? {}
      : { requiredPermission: descriptor.requiredPermission }),
    ...(definition.resolveRequiredPermission === undefined
      ? {}
      : { resolveRequiredPermission: definition.resolveRequiredPermission }),
    exposure: descriptor.exposure,
    execution: descriptor.execution,
    ...(descriptor.failurePolicy === undefined ? {} : { failurePolicy: descriptor.failurePolicy }),
    ...(descriptor.completion === undefined ? {} : { completion: descriptor.completion }),
    ...(descriptor.presentation === undefined ? {} : { presentation: descriptor.presentation }),
    ...(descriptor.protocolMetadata === undefined
      ? {}
      : { protocolMetadata: descriptor.protocolMetadata }),
    descriptor,
    handler,
  });
}

function sameToolContract(left: RegisteredAgentTool, right: RegisteredAgentTool): boolean {
  return (
    toolHandlerContractIdentity(left.handler) === toolHandlerContractIdentity(right.handler) &&
    left.resolveRequiredPermission === right.resolveRequiredPermission &&
    isDeepStrictEqual(left.descriptor, right.descriptor)
  );
}

function toolHandlerContractIdentity(handler: AgentToolHandler): AgentToolHandler {
  const identity = Reflect.get(handler, TOOL_HANDLER_CONTRACT_IDENTITY) as unknown;
  return typeof identity === 'function' ? (identity as AgentToolHandler) : handler;
}

function validateToolContract(definition: AgentToolDefinition, handler: AgentToolHandler): void {
  if (!isRecord(definition)) throw new Error('Tool definition must be an object.');
  if (typeof definition.name !== 'string' || !definition.name.trim()) {
    throw new Error('Tool name is required.');
  }
  if (typeof definition.description !== 'string' || !definition.description.trim()) {
    throw new Error(`Tool description is required: ${definition.name}`);
  }
  if (!isRecord(definition.inputSchema)) {
    throw new Error(`Tool inputSchema must be an object: ${definition.name}`);
  }
  if (definition.outputSchema !== undefined && !isRecord(definition.outputSchema)) {
    throw new Error(`Tool outputSchema must be an object: ${definition.name}`);
  }
  if (!['safe', 'medium', 'high', 'critical'].includes(definition.dangerLevel)) {
    throw new Error(`Invalid Tool dangerLevel: ${definition.name}`);
  }
  if (typeof handler !== 'function') {
    throw new Error(`Tool handler must be a function: ${definition.name}`);
  }
}

function validateInvocationToolContract(
  definition: ToolInvocationDefinition,
  runtime: ToolInvocationHandlerRuntime,
): void {
  assertPlainDataObject(definition, 'Invocation Tool definition');
  if (!['read', 'idempotent', 'transactional', 'non_idempotent'].includes(definition.effect)) {
    throw new Error(`Invocation Tool effect is required: ${definition.name}`);
  }
  if (
    typeof definition.handlerRevision !== 'string' ||
    definition.handlerRevision.trim() !== definition.handlerRevision ||
    definition.handlerRevision.length < 1 || definition.handlerRevision.length > 128
  ) {
    throw new Error(`Invocation Tool handlerRevision is required: ${definition.name}`);
  }
  if (!isRecord(runtime) || typeof runtime.execute !== 'function') {
    throw new Error(`Invocation Tool execute Handler is required: ${definition.name}`);
  }
  if (runtime.recover !== undefined && typeof runtime.recover !== 'function') {
    throw new Error(`Invocation Tool recover Handler must be a function: ${definition.name}`);
  }
  strictPortableSnapshot({
    inputSchema: definition.inputSchema,
    ...(definition.outputSchema === undefined ? {} : { outputSchema: definition.outputSchema }),
    aliases: definition.aliases ?? [],
    tags: definition.tags ?? [],
    execution: definition.execution ?? {},
    ...(definition.failurePolicy === undefined ? {} : { failurePolicy: definition.failurePolicy }),
    ...(definition.completion === undefined ? {} : { completion: definition.completion }),
    ...(definition.presentation === undefined ? {} : { presentation: definition.presentation }),
    ...(definition.protocolMetadata === undefined
      ? {}
      : { protocolMetadata: definition.protocolMetadata }),
  }, `Invocation Tool ${definition.name} descriptor`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toolIdKey(id: AgentToolId): string {
  return `${id.namespace ?? ''}\u0000${id.name}`;
}

function uniqueStrings(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function replaceMap<K, V>(target: Map<K, V>, source: ReadonlyMap<K, V>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}

function toLlmTool(tool: RegisteredAgentTool): LlmTool {
  return {
    name: tool.name,
    ...(tool.namespace === undefined ? {} : { namespace: tool.namespace }),
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
  };
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

function stableInvocationRevision(
  descriptor: AgentToolDescriptor,
  handlerRevision: string,
): string {
  const portableDescriptor = strictPortableSnapshot(descriptor, 'Invocation Tool descriptor');
  assertPortableValue(portableDescriptor, '$.toolDescriptor');
  const descriptorDigest = createHash('sha256')
    .update(canonicalJson(portableDescriptor))
    .digest('hex');
  return `${descriptorDigest}:${handlerRevision}`;
}

function canonicalJson(value: PortableValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as { [key: string]: PortableValue };
  return `{${Object.keys(record).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(record[key] ?? null)}`,
  ).join(',')}}`;
}

function assertPlainDataObject(value: object, label: string): void {
  let prototype: object | null;
  let keys: Array<string | symbol>;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    keys = Reflect.ownKeys(value);
  } catch {
    throw new TypeError(`${label} must expose plain data properties.`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  for (const key of keys) {
    if (typeof key === 'symbol') throw new TypeError(`${label} cannot contain symbol keys.`);
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (
      property === undefined || property.get !== undefined || property.set !== undefined ||
      property.enumerable !== true
    ) {
      throw new TypeError(`${label}.${key} must be a data property.`);
    }
  }
}

function strictPortableSnapshot(
  value: unknown,
  path: string,
  ancestors = new WeakSet<object>(),
): PortableValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must contain finite numbers.`);
    return value;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`${path} contains a non-portable ${typeof value} value.`);
  }
  if (ancestors.has(value)) throw new TypeError(`${path} contains a cycle.`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
      const length: unknown = lengthDescriptor?.value;
      if (
        typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 ||
        length > MAX_DESCRIPTOR_CONTAINER_ENTRIES
      ) {
        throw new TypeError(`${path} has an unsupported array length.`);
      }
      const indexKeys: string[] = [];
      for (const key of keys) {
        if (key === 'length') continue;
        if (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(key)) {
          throw new TypeError(`${path} contains unsupported array properties.`);
        }
        indexKeys.push(key);
      }
      if (indexKeys.length !== length) throw new TypeError(`${path} must be a dense array.`);
      indexKeys.sort((left, right) => Number(left) - Number(right));
      const result: PortableValue[] = [];
      for (const [index, key] of indexKeys.entries()) {
        if (Number(key) !== index) throw new TypeError(`${path} must be a dense array.`);
        const property = Object.getOwnPropertyDescriptor(value, key);
        if (
          property === undefined || property.get !== undefined || property.set !== undefined ||
          property.enumerable !== true
        ) {
          throw new TypeError(`${path}[${index}] must be a dense data property.`);
        }
        result.push(strictPortableSnapshot(property.value, `${path}[${index}]`, ancestors));
      }
      return result;
    }
    assertPlainDataObject(value, path);
    const keys = Object.keys(value);
    if (keys.length > MAX_DESCRIPTOR_CONTAINER_ENTRIES) {
      throw new TypeError(`${path} contains too many properties.`);
    }
    const result: Record<string, PortableValue> = Object.create(null) as
      Record<string, PortableValue>;
    for (const key of keys) {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (
        property === undefined || property.get !== undefined || property.set !== undefined ||
        property.enumerable !== true
      ) {
        throw new TypeError(`${path}.${key} must be an enumerable data property.`);
      }
      result[key] = strictPortableSnapshot(property.value, `${path}.${key}`, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}
