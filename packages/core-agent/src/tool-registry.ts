import type { LlmTool } from '@dbagent/core-llm';
import { assertPortableValue, type PortableValue } from '@dbagent/shared';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { BASE_TOOL_MANIFEST, isBaseToolName } from './base-tool-manifest.js';
import {
  assertInvocationLimits,
  PREPARED_TOOL_INTENT_REVISION,
  TOOL_PROTOCOL_BOUNDS,
  type PreparedToolIntent,
  type ToolExecuteContext,
  type ToolPrepareContext,
} from './tools/tool-protocol.js';
import {
  bindInvocationHandlerSnapshot,
  cloneInvocationHandlers,
  deleteInvocationHandler,
  replaceInvocationHandlers,
  setInvocationHandler,
  unbindInvocationHandlerSnapshot,
} from './internal/tool-invocation-authority.js';
import type {
  AgentToolCatalogChange,
  AgentToolDefinition,
  AgentToolDescriptor,
  AgentToolId,
} from './types.js';
import type { AgentMode, AgentToolPermissionFacts, ToolPermissionDecision } from './types.js';
import type { AgentCapabilityDiscoveryManifestEntry } from './capability-types.js';
import type { RuntimeCommandProjection } from './kernel/runtime-command.js';
import { sameInvocationHandler } from './internal/tool-invocation-handler-identity.js';

const MAX_DESCRIPTOR_CONTAINER_ENTRIES = 10_000;
const MAX_VALIDATED_SCHEMA_CACHE_ENTRIES = 1_024;
const validatedSchemaCache = new Set<string>();
const BASELINE_OWNER = 'runtime:baseline';

type CatalogAgentTool = Readonly<{
  name: string;
  /** Registry-minted owner identity; never accepted from a Tool contribution. */
  ownerId: string;
  namespace?: string;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
  outputSchema?: Readonly<Record<string, unknown>>;
  descriptor: AgentToolDescriptor;
}>;

export class ToolRegistry {
  private readonly tools = new Map<string, CatalogAgentTool>();
  private readonly invocationRevisions = new Map<string, string>();
  /** Retained after removal so a schema revision cannot be rebound within this Host. */
  private readonly schemaDigests = new Map<string, string>();
  private readonly ownerByTool = new Map<string, string>();
  private readonly toolsByOwner = new Map<string, Set<string>>();
  private readonly activeToolGenerations = new Map<string, number>();
  private readonly toolGenerations = new Map<string, number>();
  private readonly snapshotLifecycles = new Map<string, AgentToolSnapshotLifecycle>();
  /** Names reserved by the Runtime for trusted Turn-local overlays. */
  private readonly reservedNames = new Set<string>();
  private readonly listeners = new Set<(event: AgentToolCatalogChange) => void>();
  private readonly notificationDeferrals: Array<{ events: AgentToolCatalogChange[] }> = [];
  private revision = 0;

  constructor(private readonly options: { revisionResolver?: ToolRevisionResolver } = {}) {}

  get catalogRevision(): number {
    return this.revision;
  }

  reserveName(name: string): void {
    const normalized = name.trim();
    if (!normalized) throw new Error('Reserved Tool name is required.');
    assertNotBaseTool(normalized);
    if (this.tools.has(normalized)) {
      throw new Error(`Cannot reserve an already registered Tool: ${normalized}`);
    }
    this.reservedNames.add(normalized);
  }

  registerInvocation(
    definition: ToolInvocationDefinition,
    runtime: ToolInvocationHandlerRuntime,
  ): void {
    assertNotBaseTool(definition.name);
    validateInvocationToolContract(definition, runtime);
    this.assertUnreserved(definition.name);
    if (this.tools.has(definition.name)) {
      throw new Error(`Tool already registered: ${definition.name}`);
    }
    const ownerId = `direct:${definition.name}`;
    const registered = catalogTool(definition, ownerId);
    const descriptor = registered.descriptor;
    this.assertSchemaRevision(descriptor);
    const invocationRuntime = freezeInvocationRuntime(runtime);
    const toolGeneration = (this.toolGenerations.get(definition.name) ?? 0) + 1;
    const invocationRevision = stableInvocationRevision(descriptor, definition.handlerRevision);

    // Commit the complete catalog fact before observers can capture a snapshot.
    this.tools.set(definition.name, registered);
    this.rememberSchemaRevision(descriptor);
    setInvocationHandler(this, definition.name, invocationRuntime);
    this.invocationRevisions.set(definition.name, invocationRevision);
    this.ownerByTool.set(definition.name, ownerId);
    this.toolsByOwner.set(ownerId, new Set([definition.name]));
    this.toolGenerations.set(definition.name, toolGeneration);
    this.activeToolGenerations.set(definition.name, toolGeneration);
    this.emit({
      revision: ++this.revision,
      kind: 'registered',
      toolName: definition.name,
      descriptor,
    });
  }

  unregister(name: string): boolean {
    assertNotBaseTool(name);
    const tool = this.tools.get(name);
    if (!tool) return false;
    this.tools.delete(name);
    deleteInvocationHandler(this, name);
    this.invocationRevisions.delete(name);
    const ownerId = this.ownerByTool.get(name);
    this.ownerByTool.delete(name);
    this.activeToolGenerations.delete(name);
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

  replaceOwnerInvocations(
    ownerId: string,
    contributions: readonly ToolInvocationContribution[],
    options: { snapshotLifecycle?: AgentToolSnapshotLifecycle } = {},
  ): void {
    if (ownerId.trim() === BASELINE_OWNER) throw new TypeError('Use publishBaselineInvocations for the Runtime baseline.');
    for (const contribution of contributions) assertNotBaseTool(contribution.definition.name);
    this.#publishOwnerInvocations(ownerId, contributions, options);
  }

  /** Host-only composition seam: initial publication and backend generation refresh are both atomic. */
  publishBaselineInvocations(
    contributions: readonly ToolInvocationContribution[],
    options: { snapshotLifecycle?: AgentToolSnapshotLifecycle } = {},
  ): void {
    if (contributions.length !== BASE_TOOL_MANIFEST.length) {
      throw new TypeError(`Baseline publication requires all ${BASE_TOOL_MANIFEST.length} Tool contributions.`);
    }
    for (const [index, expected] of BASE_TOOL_MANIFEST.entries()) {
      const contribution = contributions[index];
      if (contribution?.definition.name !== expected.name) {
        throw new TypeError(`Baseline entry ${index} must be ${expected.name}.`);
      }
      const previous = this.tools.get(expected.name)?.descriptor;
      if (previous !== undefined) {
        const next = descriptorFromDefinition(contribution.definition);
        if (!isDeepStrictEqual({ ...previous, handlerRevision: next.handlerRevision }, next)) {
          throw new TypeError(`Baseline refresh may only change the handler revision: ${expected.name}`);
        }
      }
    }
    this.#publishOwnerInvocations(BASELINE_OWNER, contributions, options);
  }

  #publishOwnerInvocations(
    ownerId: string,
    contributions: readonly ToolInvocationContribution[],
    options: { snapshotLifecycle?: AgentToolSnapshotLifecycle },
  ): void {
    const normalizedOwner = ownerId.trim();
    if (!normalizedOwner) throw new Error('Tool owner id is required.');
    const nextNames = new Set<string>();
    const prepared: Array<{
      tool: CatalogAgentTool;
      runtime: ToolInvocationHandlerRuntime;
      invocationRevision: string;
    }> = [];
    for (const contribution of contributions) {
      if (
        !isRecord(contribution) || !isRecord(contribution.definition) ||
        !isRecord(contribution.runtime)
      ) {
        throw new Error('Invocation Tool contribution must provide definition and runtime objects.');
      }
      validateInvocationToolContract(contribution.definition, contribution.runtime);
      const name = contribution.definition.name;
      this.assertUnreserved(name);
      if (nextNames.has(name)) throw new Error(`Tool already registered: ${name}`);
      nextNames.add(name);
      const tool = catalogTool(contribution.definition, normalizedOwner);
      this.assertSchemaRevision(tool.descriptor);
      prepared.push({
        tool,
        runtime: freezeInvocationRuntime(contribution.runtime),
        invocationRevision: stableInvocationRevision(
          tool.descriptor,
          contribution.definition.handlerRevision,
        ),
      });
    }

    const previousNames = new Set(this.toolsByOwner.get(normalizedOwner) ?? []);
    for (const name of nextNames) {
      const existingOwner = this.ownerByTool.get(name);
      if (existingOwner !== undefined && existingOwner !== normalizedOwner) {
        throw new Error(`Tool already registered: ${name}`);
      }
    }
    const currentInvocationHandlers = cloneInvocationHandlers(this);
    for (const { tool, runtime } of prepared) {
      const current = currentInvocationHandlers.get(tool.name);
      if (current !== undefined && sameRevision(current.revision, runtime.revision) &&
        (!sameInvocationHandler(current.prepare, runtime.prepare) ||
          !sameInvocationHandler(current.execute, runtime.execute) ||
          !sameInvocationHandler(current.recover, runtime.recover) ||
          !sameInvocationHandler(current.retainResult, runtime.retainResult))) {
        throw new TypeError(`Changed Tool handlers require a new handlerRevision: ${tool.name}`);
      }
    }
    const unchangedNames = new Set(prepared.filter(({ tool, invocationRevision }) => {
      const previous = this.tools.get(tool.name);
      return previous !== undefined && currentInvocationHandlers.has(tool.name) &&
        isDeepStrictEqual(previous.descriptor, tool.descriptor) &&
        this.invocationRevisions.get(tool.name) === invocationRevision;
    }).map(({ tool }) => tool.name));

    const nextTools = new Map(this.tools);
    const nextInvocationRuntimes = new Map(currentInvocationHandlers);
    const nextInvocationRevisions = new Map(this.invocationRevisions);
    const nextOwnerByTool = new Map(this.ownerByTool);
    const nextActiveToolGenerations = new Map(this.activeToolGenerations);
    const nextToolGenerations = new Map(this.toolGenerations);
    const nextSnapshotLifecycles = new Map(this.snapshotLifecycles);
    for (const name of previousNames) {
      if (unchangedNames.has(name)) continue;
      nextTools.delete(name);
      nextInvocationRuntimes.delete(name);
      nextInvocationRevisions.delete(name);
      nextOwnerByTool.delete(name);
      nextActiveToolGenerations.delete(name);
      nextSnapshotLifecycles.delete(name);
    }
    for (const { tool, runtime, invocationRevision } of prepared) {
      nextTools.set(tool.name, tool);
      nextInvocationRuntimes.set(tool.name, runtime);
      nextInvocationRevisions.set(tool.name, invocationRevision);
      nextOwnerByTool.set(tool.name, normalizedOwner);
      if (!unchangedNames.has(tool.name)) {
        const toolGeneration = (nextToolGenerations.get(tool.name) ?? 0) + 1;
        nextToolGenerations.set(tool.name, toolGeneration);
        nextActiveToolGenerations.set(tool.name, toolGeneration);
      }
      if (options.snapshotLifecycle === undefined) nextSnapshotLifecycles.delete(tool.name);
      else nextSnapshotLifecycles.set(tool.name, options.snapshotLifecycle);
    }

    replaceMap(this.tools, nextTools);
    for (const { tool } of prepared) this.rememberSchemaRevision(tool.descriptor);
    replaceInvocationHandlers(this, nextInvocationRuntimes);
    replaceMap(this.invocationRevisions, nextInvocationRevisions);
    replaceMap(this.ownerByTool, nextOwnerByTool);
    replaceMap(this.activeToolGenerations, nextActiveToolGenerations);
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

  toolGeneration(name: string): number | undefined {
    return this.activeToolGenerations.get(name);
  }

  /** Never substitutes a newer handler. The returned catalog owns its generation lease. */
  resolveRevision(reference: ToolRevisionReference): ToolRevisionResolution {
    validateRevisionReference(reference);
    if (reference.intentRevision !== PREPARED_TOOL_INTENT_REVISION) {
      return { status: 'unsupported_revision', revision: Object.freeze({ ...reference }) };
    }
    const current = this.tools.get(reference.toolName);
    const handler = cloneInvocationHandlers(this).get(reference.toolName);
    if (current !== undefined && handler !== undefined && sameRevision(handler.revision, reference)) {
      return { status: 'supported', catalog: this.captureSnapshot() };
    }
    const resolved = this.options.revisionResolver?.resolve(Object.freeze({ ...reference }));
    if (resolved === undefined) return { status: 'unsupported_revision', revision: Object.freeze({ ...reference }) };
    const { contribution } = resolved;
    validateInvocationToolContract(contribution.definition, contribution.runtime, 'recovery');
    if (!sameRevision(contribution.runtime.revision, reference)) {
      throw new TypeError('Host revision resolver returned a different Tool revision.');
    }
    const tool = catalogTool(contribution.definition, resolved.ownerId);
    this.assertSchemaRevision(tool.descriptor);
    return { status: 'supported', catalog: createToolCatalogSnapshot({
      catalogRevision: this.revision,
      tools: new Map([[tool.name, tool]]),
      invocationHandlers: new Map([[tool.name, freezeInvocationRuntime(contribution.runtime)]]),
      invocationRevisions: new Map([[tool.name, stableInvocationRevision(tool.descriptor, reference.handlerRevision)]]),
      generations: new Map(),
      lifecycles: resolved.snapshotLifecycle === undefined ? new Map() : new Map([[tool.name, resolved.snapshotLifecycle]]),
    }) };
  }

  captureSnapshot(): ToolCatalogSnapshot {
    // Capture every generation-bearing map before invoking any external
    // lifecycle callback. A re-entrant retain() may mutate the live Registry,
    // but it cannot splice a new Handler into this immutable generation.
    const captured: ToolCatalogSnapshotCapture = {
      catalogRevision: this.revision,
      tools: new Map(this.tools),
      invocationHandlers: cloneInvocationHandlers(this),
      invocationRevisions: new Map(this.invocationRevisions),
      generations: new Map(this.activeToolGenerations),
      lifecycles: new Map(this.snapshotLifecycles),
    };
    return createToolCatalogSnapshot(captured);
  }

  get(name: string): CatalogAgentTool | undefined {
    return this.tools.get(name);
  }

  list(): CatalogAgentTool[] {
    return [...this.tools.values()];
  }

  listDescriptors(): AgentToolDescriptor[] {
    return this.list().map((tool) => structuredClone(tool.descriptor));
  }

  subscribe(listener: (event: AgentToolCatalogChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Host publication primitive. Mutations remain immediately readable, but
   * observers are notified only after the enclosing composite generation has
   * finished updating its companion control-plane state.
   */
  deferCatalogNotifications(): { commitNotifications(): void; discardNotifications(): void } {
    const frame = { events: [] as AgentToolCatalogChange[] };
    this.notificationDeferrals.push(frame);
    let settled = false;
    const settle = (publish: boolean) => {
      if (settled) return;
      settled = true;
      const current = this.notificationDeferrals.pop();
      if (current !== frame) {
        throw new Error('Tool catalog notification deferrals must settle in stack order.');
      }
      if (!publish) return;
      const parent = this.notificationDeferrals.at(-1);
      if (parent) parent.events.push(...frame.events);
      else for (const event of frame.events) this.notify(event);
    };
    return {
      commitNotifications: () => settle(true),
      discardNotifications: () => settle(false),
    };
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  llmTools(allowedTools?: string[]): LlmTool[] {
    const allowed = allowedTools === undefined ? undefined : new Set(allowedTools);
    return this.list()
      .filter((tool) => isBaseToolName(tool.name) || allowed === undefined || allowed.has(tool.name))
      .map((tool) => ({
        name: tool.name,
        ...(tool.namespace === undefined ? {} : { namespace: tool.namespace }),
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
      }));
  }

  private emit(event: AgentToolCatalogChange): void {
    const frame = this.notificationDeferrals.at(-1);
    if (frame) {
      frame.events.push(event);
      return;
    }
    this.notify(event);
  }

  private assertUnreserved(name: string): void {
    if (this.reservedNames.has(name)) {
      throw new Error(`Tool name is reserved by the Agent Runtime: ${name}`);
    }
  }

  private assertSchemaRevision(descriptor: AgentToolDescriptor): void {
    const key = `${descriptor.flatName}:${descriptor.toolRevision}`;
    const previous = this.schemaDigests.get(key);
    if (previous !== undefined && previous !== schemaDigest(descriptor)) {
      throw new TypeError(`Tool schema changed without a new toolRevision: ${descriptor.flatName}`);
    }
  }

  private rememberSchemaRevision(descriptor: AgentToolDescriptor): void {
    this.schemaDigests.set(`${descriptor.flatName}:${descriptor.toolRevision}`, schemaDigest(descriptor));
  }

  private notify(event: AgentToolCatalogChange): void {
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
  private constructor() {
    throw new TypeError(
      'ToolCatalogSnapshot can only be created by ToolRegistry.captureSnapshot().',
    );
  }

  get catalogRevision(): number {
    return requireToolCatalogSnapshotState(this).catalogRevision;
  }

  release(): void {
    const state = requireToolCatalogSnapshotState(this);
    if (state.released) return;
    state.released = true;
    if (state.executionPins > 0) return;
    const failures = releaseSnapshotLifecycles(state.releases);
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        'Tool snapshot lifecycle release failed.',
        { cause: failures[0] },
      );
    }
  }

  /** Keep the captured backend generations alive until actual invocation work has drained. */
  retainExecution(): () => void {
    const state = requireToolCatalogSnapshotState(this);
    if (state.released) throw new TypeError('Cannot retain a released Tool snapshot.');
    state.executionPins += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.executionPins -= 1;
      if (state.released && state.executionPins === 0) {
        const failures = releaseSnapshotLifecycles(state.releases);
        if (failures.length) throw new AggregateError(failures, 'Tool generation drain cleanup failed.');
      }
    };
  }

  get(name: string): CatalogAgentTool | undefined {
    return requireToolCatalogSnapshotState(this).tools.get(name);
  }

  ownerId(name: string): string | undefined {
    return requireToolCatalogSnapshotState(this).tools.get(name)?.ownerId;
  }

  has(name: string): boolean {
    return requireToolCatalogSnapshotState(this).tools.has(name);
  }

  list(): CatalogAgentTool[] {
    return [...requireToolCatalogSnapshotState(this).tools.values()];
  }

  listDescriptors(): AgentToolDescriptor[] {
    return this.list().map((tool) => structuredClone(tool.descriptor));
  }

  invocationRevision(name: string): string | undefined {
    return requireToolCatalogSnapshotState(this).invocationRevisions.get(name);
  }

  toolGeneration(name: string): number | undefined {
    return requireToolCatalogSnapshotState(this).generations.get(name);
  }

  supportsRevision(reference: ToolRevisionReference): boolean {
    validateRevisionReference(reference);
    const handler = cloneInvocationHandlers(this).get(reference.toolName);
    return handler !== undefined && sameRevision(handler.revision, reference);
  }

  llmTools(allowedTools?: string[]): LlmTool[] {
    const allowed = allowedTools === undefined ? undefined : new Set(allowedTools);
    return this.list()
      .filter((tool) => isBaseToolName(tool.name) || allowed === undefined || allowed.has(tool.name))
      .map(toLlmTool);
  }
}

/**
 * Builds one immutable per-Turn catalog overlay without mutating a shared
 * Registry. This is for Run-private handlers (for example Session Skills)
 * whose captured data must never bleed into another Run's snapshot.
 */
export function overlayToolCatalogSnapshot(
  base: ToolCatalogSnapshot,
  contribution: ToolInvocationContribution,
): ToolCatalogSnapshot {
  const state = requireToolCatalogSnapshotState(base);
  const definition = contribution.definition;
  assertNotBaseTool(definition.name);
  validateInvocationToolContract(definition, contribution.runtime);
  if (state.tools.has(definition.name)) {
    throw new Error(`Turn-local Tool already exists in the captured catalog: ${definition.name}`);
  }
  const tool = catalogTool(definition, `runtime:overlay:${definition.name}`);
  const tools = new Map(state.tools);
  tools.set(tool.name, tool);
  const handlers = cloneInvocationHandlers(base);
  handlers.set(tool.name, freezeInvocationRuntime(contribution.runtime));
  const invocationRevisions = new Map(state.invocationRevisions);
  invocationRevisions.set(
    tool.name,
    stableInvocationRevision(tool.descriptor, definition.handlerRevision),
  );
  const generations = new Map(state.generations);
  generations.set(tool.name, 1);
  const overlay = createToolCatalogSnapshot({
    catalogRevision: state.catalogRevision,
    tools,
    invocationHandlers: handlers,
    invocationRevisions,
    generations,
    lifecycles: parentSnapshotLifecycle(base),
  });
  // The derived snapshot owns the parent's execution pin from this point.  A
  // caller may still release the original snapshot again; release is
  // intentionally idempotent.
  base.release();
  return overlay;
}

/**
 * Rebinds one fixed baseline Tool to data captured for this exact Turn.
 *
 * Only the handler revision may differ.  Schema, classification, exposure and
 * every other descriptor field remain build-owned by the baseline manifest.
 * The returned snapshot consumes the supplied snapshot on success and keeps
 * all of its backend generations alive until the derived snapshot is released.
 */
export function replaceCapturedBaseToolInvocation(
  base: ToolCatalogSnapshot,
  contribution: ToolInvocationContribution,
): ToolCatalogSnapshot {
  const state = requireToolCatalogSnapshotState(base);
  const definition = contribution.definition;
  if (!isBaseToolName(definition.name)) {
    throw new TypeError(`Turn-local baseline replacement requires a fixed Tool: ${definition.name}`);
  }
  validateInvocationToolContract(definition, contribution.runtime);
  const current = state.tools.get(definition.name);
  if (current === undefined) {
    throw new Error(`Runtime baseline Tool is missing from the captured catalog: ${definition.name}`);
  }
  const replacement = catalogTool(definition, current.ownerId);
  if (!isDeepStrictEqual(
    { ...current.descriptor, handlerRevision: replacement.descriptor.handlerRevision },
    replacement.descriptor,
  )) {
    throw new TypeError(
      `Turn-local baseline replacement may only change handlerRevision: ${definition.name}`,
    );
  }

  const tools = new Map(state.tools);
  tools.set(replacement.name, replacement);
  const handlers = cloneInvocationHandlers(base);
  handlers.set(replacement.name, freezeInvocationRuntime(contribution.runtime));
  const invocationRevisions = new Map(state.invocationRevisions);
  invocationRevisions.set(
    replacement.name,
    stableInvocationRevision(replacement.descriptor, definition.handlerRevision),
  );
  const rebound = createToolCatalogSnapshot({
    catalogRevision: state.catalogRevision,
    tools,
    invocationHandlers: handlers,
    invocationRevisions,
    generations: new Map(state.generations),
    lifecycles: parentSnapshotLifecycle(base),
  });
  base.release();
  return rebound;
}

function parentSnapshotLifecycle(
  base: ToolCatalogSnapshot,
): ReadonlyMap<string, AgentToolSnapshotLifecycle> {
  return new Map([[
    '__captured_parent__',
    Object.freeze({ retain: () => base.retainExecution() }),
  ]]);
}

type ToolCatalogSnapshotCapture = Readonly<{
  catalogRevision: number;
  tools: ReadonlyMap<string, CatalogAgentTool>;
  invocationHandlers: ReadonlyMap<string, ToolInvocationHandlerRuntime>;
  invocationRevisions: ReadonlyMap<string, string>;
  generations: ReadonlyMap<string, number>;
  lifecycles: ReadonlyMap<string, AgentToolSnapshotLifecycle>;
}>;

type ToolCatalogSnapshotState = Readonly<{
  catalogRevision: number;
  tools: ReadonlyMap<string, CatalogAgentTool>;
  invocationRevisions: ReadonlyMap<string, string>;
  generations: ReadonlyMap<string, number>;
  releases: Array<() => void>;
}> & { released: boolean; executionPins: number };

const toolCatalogSnapshotStates = new WeakMap<ToolCatalogSnapshot, ToolCatalogSnapshotState>();

function createToolCatalogSnapshot(captured: ToolCatalogSnapshotCapture): ToolCatalogSnapshot {
  const snapshot = Object.create(ToolCatalogSnapshot.prototype) as ToolCatalogSnapshot;
  const state: ToolCatalogSnapshotState = {
    catalogRevision: captured.catalogRevision,
    tools: captured.tools,
    invocationRevisions: captured.invocationRevisions,
    generations: captured.generations,
    releases: [],
    released: false,
    executionPins: 0,
  };
  toolCatalogSnapshotStates.set(snapshot, state);
  bindInvocationHandlerSnapshot(snapshot, captured.invocationHandlers);
  try {
    for (const lifecycle of new Set(captured.lifecycles.values())) {
      const release = lifecycle.retain();
      if (typeof release !== 'function') {
        throw new TypeError('Tool snapshot lifecycle retain() must return a release function.');
      }
      state.releases.push(release);
    }
  } catch (retainFailure) {
    unbindInvocationHandlerSnapshot(snapshot);
    toolCatalogSnapshotStates.delete(snapshot);
    const cleanupFailures = releaseSnapshotLifecycles(state.releases);
    if (cleanupFailures.length === 0) throw retainFailure;
    throw new AggregateError(
      [retainFailure, ...cleanupFailures],
      'Tool snapshot lifecycle retain failed and cleanup also failed.',
      { cause: retainFailure },
    );
  }
  return Object.freeze(snapshot);
}

function requireToolCatalogSnapshotState(snapshot: ToolCatalogSnapshot): ToolCatalogSnapshotState {
  const state = toolCatalogSnapshotStates.get(snapshot);
  if (state === undefined) {
    throw new TypeError('ToolCatalogSnapshot is not bound to an internal snapshot generation.');
  }
  return state;
}

function releaseSnapshotLifecycles(releases: Array<() => void>): unknown[] {
  const failures: unknown[] = [];
  while (releases.length > 0) {
    const release = releases.pop();
    if (release === undefined) continue;
    try {
      release();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
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
  /** Stable timestamp of this execution attempt, suitable for deterministic replay output. */
  startedAt?: string;
  /** Immutable control-plane state captured immediately before this Handler starts. */
  runtimeState?: RuntimeCommandProjection;
  /** Run-lifetime cancellation for detached work; never includes per-Invocation timeout. */
  runSignal?: AbortSignal;
  /** Effective authority already decided by the Journal-backed Invocation runtime. */
  authorization: ToolInvocationAuthorization;
  /** Immutable catalog captured with this Turn; never a live Registry view. */
  discoverableTools: readonly Readonly<AgentToolDescriptor>[];
  /** Static semantic Capability manifest captured with this Turn. */
  discoverableCapabilities: readonly AgentCapabilityDiscoveryManifestEntry[];
  /**
   * Publishes a short user-facing execution status through the authoritative
   * Tool lifecycle. The Runtime batches and persists it; Handlers
   * never receive Journal write authority. Calls after cancellation or a
   * terminal fact are intentionally ignored.
   */
  reportProgress(summary: string): void;
  signal: AbortSignal;
}>;

export type ToolInvocationAuthorization = Readonly<{
  policyMode: AgentMode;
  policyDecision: ToolPermissionDecision;
  policyRevision: string;
  permission: AgentToolPermissionFacts;
  matchedRuleIds: readonly string[];
  /** Present only for an exact, persisted, approved one-time request. */
  approvalId?: string;
}>;

export type ToolInvocationHandler<Result = unknown> = (
  prepared: Readonly<Record<string, PortableValue>>,
  context: ToolExecuteContext,
) => Result | Promise<Result>;

export type ToolInvocationRecoveryHandler<Result = unknown> = (
  prepared: Readonly<Record<string, PortableValue>>,
  context: ToolExecuteContext,
) => Result | Promise<Result>;

/**
 * Domain-owned result content exposed after the ordinary Tool payload passes
 * validation. Only the Runtime may stage it and issue content/evidence refs.
 */
export type ToolRetainedResultContent = Readonly<{
  mediaType: string;
  source: AsyncIterable<Uint8Array>;
  expectedByteSize?: number;
  expectedChecksum?: string;
  /** Stable identity revalidated by the Handler's own result store. */
  identity?: string;
}>;

export type ToolResultRetentionHandler = (
  payload: PortableValue,
  context: ToolExecuteContext,
) => ToolRetainedResultContent | undefined | Promise<ToolRetainedResultContent | undefined>;

export type ToolInvocationHandlerRuntime = Readonly<{
  /** Explicit binding checked before publication; not inferred from a tool name. */
  revision: ToolRevisionReference;
  prepare(
    input: Readonly<Record<string, PortableValue>>,
    context: ToolPrepareContext,
  ): PreparedToolIntent | Promise<PreparedToolIntent>;
  execute: ToolInvocationHandler;
  recover?: ToolInvocationRecoveryHandler;
  retainResult?: ToolResultRetentionHandler;
}>;

export type ToolInvocationContribution = Readonly<{
  definition: ToolInvocationDefinition;
  runtime: ToolInvocationHandlerRuntime;
}>;

export type ToolRevisionReference = Readonly<{
  toolName: string;
  toolRevision: string;
  handlerRevision: string;
  intentRevision: string;
}>;

/** Host supplies supported historical code and its backend lease after restart, or returns undefined. */
export type ToolRevisionResolver = Readonly<{
  resolve(reference: ToolRevisionReference): Readonly<{
    contribution: ToolInvocationContribution;
    /** Stable owner identity originally used to publish this revision. */
    ownerId: string;
    snapshotLifecycle?: AgentToolSnapshotLifecycle;
  }> | undefined;
}>;

export type ToolRevisionResolution =
  | Readonly<{ status: 'supported'; catalog: ToolCatalogSnapshot }>
  | Readonly<{ status: 'unsupported_revision'; revision: ToolRevisionReference }>;

export type ToolInvocationDefinition = AgentToolDefinition & {
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
    outputSchema: structuredClone(definition.outputSchema),
    dangerLevel: definition.dangerLevel,
    readonly,
    source: definition.source ?? 'unknown',
    ...(definition.sourceId === undefined ? {} : { sourceId: definition.sourceId }),
    exposure: definition.exposure ?? 'deferred',
    ...(definition.permission === undefined
      ? {}
      : { permission: structuredClone(definition.permission) }),
    access: definition.access,
    recoveryClass: definition.recoveryClass,
    limits: structuredClone(definition.limits),
    toolRevision: definition.toolRevision,
    handlerRevision: definition.handlerRevision,
    intentRevision: definition.intentRevision,
    execution: {
      concurrency,
      timeoutMs: definition.execution.timeoutMs,
    },
    failurePolicy: structuredClone(definition.failurePolicy),
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

function catalogTool(definition: AgentToolDefinition, ownerId: string): CatalogAgentTool {
  const normalizedOwner = ownerId.trim();
  if (!normalizedOwner || normalizedOwner.length > 512) {
    throw new TypeError('Tool owner id is invalid.');
  }
  const descriptor = deepFreeze(descriptorFromDefinition(definition));
  return deepFreeze({
    name: descriptor.flatName,
    ownerId: normalizedOwner,
    ...(descriptor.id.namespace === undefined ? {} : { namespace: descriptor.id.namespace }),
    description: descriptor.description,
    inputSchema: descriptor.inputSchema,
    ...(descriptor.outputSchema === undefined ? {} : { outputSchema: descriptor.outputSchema }),
    descriptor,
  });
}

function validateInvocationToolContract(
  definition: ToolInvocationDefinition,
  runtime: ToolInvocationHandlerRuntime,
  purpose: 'publication' | 'recovery' = 'publication',
): void {
  assertPlainDataObject(definition, 'Invocation Tool definition');
  boundedText(definition.name, 'name', TOOL_PROTOCOL_BOUNDS.nameChars);
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u.test(definition.name)) {
    throw new TypeError(`Invalid Tool name: ${definition.name}`);
  }
  boundedText(definition.description, 'description', TOOL_PROTOCOL_BOUNDS.descriptionChars);
  for (const key of ['handlerRevision', 'toolRevision', 'intentRevision'] as const) {
    boundedText(definition[key], key, TOOL_PROTOCOL_BOUNDS.revisionChars);
  }
  if (definition.intentRevision !== PREPARED_TOOL_INTENT_REVISION) {
    throw new TypeError(`Unsupported Tool intent revision: ${definition.intentRevision}`);
  }
  for (const key of ['effect', 'resolveEffect', 'resolvePermission']) {
    if (Object.hasOwn(definition, key)) throw new TypeError(`Removed Tool contract field: ${key}`);
  }
  for (const key of ['aliases', 'tags'] as const) {
    const labels = definition[key] ?? [];
    if (!Array.isArray(labels) || labels.length > TOOL_PROTOCOL_BOUNDS.labels ||
      new Set(labels).size !== labels.length) throw new TypeError(`Invalid Tool ${key}.`);
    for (const label of labels) boundedText(label, key, TOOL_PROTOCOL_BOUNDS.labelChars);
  }
  for (const key of ['title', 'sourceId', 'namespace', 'originalName'] as const) {
    if (definition[key] !== undefined) boundedText(definition[key], key, TOOL_PROTOCOL_BOUNDS.labelChars);
  }
  boundedText(definition.source, 'source', TOOL_PROTOCOL_BOUNDS.labelChars);
  if (!['safe', 'medium', 'high', 'critical'].includes(definition.dangerLevel) ||
    !['direct', 'deferred', 'hidden', 'disabled'].includes(definition.exposure ?? 'deferred') ||
    typeof definition.readonly !== 'boolean') throw new TypeError('Invalid Tool descriptor classification.');
  assertInvocationLimits(definition.limits);
  if (!isRecord(definition.execution) || definition.execution.timeoutMs !== definition.limits.timeoutMs) {
    throw new TypeError('Tool execution timeout must equal its invocation limit.');
  }
  validateClassifications(definition);
  validatePermissionDeclaration(definition);
  const failure = definition.failurePolicy?.onUnknown;
  if (failure === undefined || typeof failure.retryable !== 'boolean' ||
    !['repairable', 'timeout', 'transient_dependency', 'permission', 'tool_unavailable',
      'validation', 'unknown'].includes(failure.failureKind)) {
    throw new TypeError('Tool failure/retry policy must be complete.');
  }
  if (failure.retryable && ['transactional', 'non_idempotent'].includes(definition.recoveryClass)) {
    throw new TypeError('A Tool with uncertain side effects cannot automatically retry unknown outcomes.');
  }
  if (!isRecord(runtime) || typeof runtime.prepare !== 'function' || typeof runtime.execute !== 'function') {
    throw new Error(`Invocation Tool prepare and execute Handlers are required: ${definition.name}`);
  }
  assertPlainDataObject(runtime, 'Invocation Tool runtime');
  validateRevisionReference(runtime.revision);
  if (!sameRevision(runtime.revision, {
    toolName: definition.name,
    toolRevision: definition.toolRevision,
    handlerRevision: definition.handlerRevision,
    intentRevision: definition.intentRevision,
  })) throw new TypeError('Tool handler binding does not match its declared revisions.');
  if (runtime.recover !== undefined && typeof runtime.recover !== 'function') {
    throw new Error(`Invocation Tool recover Handler must be a function: ${definition.name}`);
  }
  if (runtime.retainResult !== undefined && typeof runtime.retainResult !== 'function') {
    throw new Error(`Invocation Tool retainResult Handler must be a function: ${definition.name}`);
  }
  const metadata = strictPortableSnapshot({
    inputSchema: definition.inputSchema,
    ...(definition.outputSchema === undefined ? {} : { outputSchema: definition.outputSchema }),
    aliases: definition.aliases ?? [],
    tags: definition.tags ?? [],
    execution: definition.execution ?? {},
    ...(definition.permission === undefined ? {} : { permission: definition.permission }),
    ...(definition.failurePolicy === undefined ? {} : { failurePolicy: definition.failurePolicy }),
    ...(definition.completion === undefined ? {} : { completion: definition.completion }),
    ...(definition.presentation === undefined ? {} : { presentation: definition.presentation }),
    ...(definition.protocolMetadata === undefined
      ? {}
      : { protocolMetadata: definition.protocolMetadata }),
  }, `Invocation Tool ${definition.name} descriptor`);
  assertByteLimit(metadata, TOOL_PROTOCOL_BOUNDS.descriptorBytes, 'Tool metadata');
  validateSchema(definition.inputSchema, 'input');
  validateSchema(definition.outputSchema, 'output');
  if (purpose === 'publication' && isBaseToolName(definition.name)) {
    const baseline = BASE_TOOL_MANIFEST.find(({ name }) => name === definition.name);
    if (definition.exposure !== 'direct' || definition.toolRevision !== baseline?.schemaRevision ||
      definition.namespace !== undefined || definition.source !== 'runtime' ||
      (definition.aliases?.length ?? 0) !== 0) {
      throw new TypeError(`Tool does not match the Runtime baseline: ${definition.name}`);
    }
  }
  const descriptor = descriptorFromDefinition(definition);
  assertByteLimit(strictPortableSnapshot(descriptor, 'Tool descriptor'),
    TOOL_PROTOCOL_BOUNDS.descriptorBytes, 'Tool descriptor');
}

function freezeInvocationRuntime(
  runtime: ToolInvocationHandlerRuntime,
): ToolInvocationHandlerRuntime {
  return Object.freeze({
    revision: Object.freeze({ ...runtime.revision }),
    prepare: runtime.prepare,
    execute: runtime.execute,
    ...(runtime.recover === undefined ? {} : { recover: runtime.recover }),
    ...(runtime.retainResult === undefined ? {} : { retainResult: runtime.retainResult }),
  });
}

function assertNotBaseTool(name: string): void {
  if (isBaseToolName(name)) {
    throw new TypeError(`Baseline Tool ${name} can only be published through publishBaselineInvocations.`);
  }
}

function validateRevisionReference(reference: ToolRevisionReference): void {
  if (!isRecord(reference)) throw new TypeError('An exact Tool handler revision binding is required.');
  assertPlainDataObject(reference, 'Tool handler revision');
  for (const key of ['toolName', 'toolRevision', 'handlerRevision', 'intentRevision'] as const) {
    boundedText(reference[key], key, TOOL_PROTOCOL_BOUNDS.revisionChars);
  }
}

function sameRevision(left: ToolRevisionReference, right: ToolRevisionReference): boolean {
  return left.toolName === right.toolName && left.toolRevision === right.toolRevision &&
    left.handlerRevision === right.handlerRevision && left.intentRevision === right.intentRevision;
}

function boundedText(value: unknown, label: string, max: number): asserts value is string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > max ||
    containsDisallowedControlCharacter(value)) {
    throw new TypeError(`Tool ${label} must contain 1–${max} bounded text characters.`);
  }
}

function containsDisallowedControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x08 || code === 0x0b || code === 0x0c || code >= 0x0e && code <= 0x1f) return true;
  }
  return false;
}

function assertByteLimit(value: PortableValue, max: number, label: string): void {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > max) {
    throw new TypeError(`${label} exceeds ${max} bytes.`);
  }
}

function validateSchema(value: unknown, label: string): void {
  if (!isRecord(value)) throw new TypeError(`Tool ${label} schema must be an object.`);
  const schema = strictPortableSnapshot(value, `${label} schema`);
  if (!isRecord(schema)) throw new TypeError(`Tool ${label} schema must be an object.`);
  assertByteLimit(schema, TOOL_PROTOCOL_BOUNDS.schemaBytes, `${label} schema`);
  const schemaText = JSON.stringify(schema);
  if ('$async' in schema && schema.$async === true) {
    throw new TypeError('Tool schemas must validate synchronously.');
  }
  if (label === 'output' && schemaText.includes('schemanaut.agent-tool-result.v1')) {
    throw new TypeError('Tool output schemas cannot declare the Runtime private result envelope.');
  }
  // Only successful compilation is shared; label-specific checks still run on every call.
  if (validatedSchemaCache.has(schemaText)) return;
  // A fresh compiler isolates schema IDs across independent contribution owners.
  const compiler = new Ajv2020({
    strictSchema: true, strictTypes: false, allowUnionTypes: true,
    coerceTypes: false, useDefaults: false, removeAdditional: false,
  });
  compiler.compile(schema);
  if (validatedSchemaCache.size >= MAX_VALIDATED_SCHEMA_CACHE_ENTRIES) {
    validatedSchemaCache.clear();
  }
  validatedSchemaCache.add(schemaText);
}

function validateClassifications(definition: ToolInvocationDefinition): void {
  const { access, recoveryClass, readonly, execution } = definition;
  if (!['read', 'write', 'external', 'destructive'].includes(access) ||
    !['read', 'idempotent', 'transactional', 'non_idempotent'].includes(recoveryClass) ||
    !['read', 'write', 'exclusive'].includes(execution.concurrency)) {
    throw new TypeError('Tool access, recoveryClass and concurrency are required.');
  }
  if ((access === 'read' && !readonly) ||
    ((access === 'write' || access === 'destructive') && readonly) ||
    (recoveryClass === 'read' && !readonly) ||
    (execution.concurrency === 'read' && access !== 'read') ||
    (readonly && execution.concurrency === 'write')) {
    throw new TypeError('Tool readonly, access, recovery and concurrency declarations conflict.');
  }
}

function validatePermissionDeclaration(definition: ToolInvocationDefinition): void {
  const permission = definition.permission;
  if (permission === undefined) return; // Actual facts are required from prepare, never inferred here.
  if (!isRecord(permission)) throw new TypeError('Tool permission declaration must be an object.');
  const actions = new Set(['read', 'write', 'execute', 'network', 'delete', 'database-query',
    'database-mutation', 'database-schema', 'credential', 'admin', 'unknown']);
  for (const key of ['actions', 'paths', 'hosts'] as const) {
    const values = permission[key];
    if (values === undefined) continue;
    if (!Array.isArray(values) || values.length > TOOL_PROTOCOL_BOUNDS.facts) {
      throw new TypeError(`Too many permission ${key}.`);
    }
    for (const value of values) {
      boundedText(value, `permission.${key}`, TOOL_PROTOCOL_BOUNDS.factChars);
      if (key === 'actions' && !actions.has(value)) throw new TypeError(`Unknown permission action: ${value}`);
    }
  }
  for (const key of ['network', 'externalWrite', 'destructive', 'credentials', 'admin'] as const) {
    if (permission[key] !== undefined && typeof permission[key] !== 'boolean') {
      throw new TypeError(`Tool permission.${key} must be boolean.`);
    }
  }
  if ((permission.destructive === true && definition.access !== 'destructive') ||
    (definition.readonly && (permission.externalWrite === true || permission.destructive === true ||
      permission.actions?.some((action) => ['write', 'delete', 'database-mutation', 'database-schema'].includes(action))))) {
    throw new TypeError('Tool static permission declaration contradicts its access.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function uniqueStrings(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function replaceMap<K, V>(target: Map<K, V>, source: ReadonlyMap<K, V>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}

function toLlmTool(tool: CatalogAgentTool): LlmTool {
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

function schemaDigest(descriptor: AgentToolDescriptor): string {
  return createHash('sha256').update(canonicalJson(strictPortableSnapshot({
    inputSchema: descriptor.inputSchema,
    outputSchema: descriptor.outputSchema,
  }, 'Tool schemas'))).digest('hex');
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
  depth = 0,
  budget = { units: 0 },
): PortableValue {
  budget.units += typeof value === 'string' ? value.length : 1;
  if (budget.units > TOOL_PROTOCOL_BOUNDS.descriptorBytes) {
    throw new TypeError(`${path} exceeds the descriptor traversal budget.`);
  }
  if (depth > TOOL_PROTOCOL_BOUNDS.depth) throw new TypeError(`${path} exceeds the descriptor depth limit.`);
  if (typeof value === 'string' && value.length > TOOL_PROTOCOL_BOUNDS.descriptorBytes) {
    throw new TypeError(`${path} exceeds the descriptor string limit.`);
  }
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
        result.push(strictPortableSnapshot(property.value, `${path}[${index}]`, ancestors, depth + 1, budget));
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
      budget.units += key.length;
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (
        property === undefined || property.get !== undefined || property.set !== undefined ||
        property.enumerable !== true
      ) {
        throw new TypeError(`${path}.${key} must be an enumerable data property.`);
      }
      result[key] = strictPortableSnapshot(property.value, `${path}.${key}`, ancestors, depth + 1, budget);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}
