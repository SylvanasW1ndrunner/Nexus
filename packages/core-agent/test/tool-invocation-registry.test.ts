import { describe, expect, it } from 'vitest';
import {
  ToolCatalogSnapshot,
  ToolRegistry,
  createAgentToolResultEnvelope,
} from '../src/index.js';
import { resolveInvocationHandler } from '../src/internal/tool-invocation-authority.js';

describe('invocation-only Tool registry boundary', () => {
  it('rejects cyclic, accessor-backed, undefined and invalid revision metadata before fingerprinting', () => {
    const cyclic: Record<string, unknown> = { type: 'object' };
    cyclic.self = cyclic;
    let getterCalls = 0;
    const accessorSchema: Record<string, unknown> = {};
    Object.defineProperty(accessorSchema, 'type', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'object';
      },
    });
    const oversizedSparse: unknown[] = [];
    oversizedSparse.length = 2 ** 32 - 1;
    const cases = [
      { schema: cyclic, handlerRevision: 'fixture@1' },
      { schema: accessorSchema, handlerRevision: 'fixture@1' },
      { schema: { type: 'object', invalid: undefined }, handlerRevision: 'fixture@1' },
      { schema: { type: 'object', values: oversizedSparse }, handlerRevision: 'fixture@1' },
      { schema: { type: 'object' }, handlerRevision: '' },
    ];

    for (const [index, invalid] of cases.entries()) {
      const registry = new ToolRegistry();
      expect(() => registry.registerInvocation({
        name: `invalid_${index}`, description: 'invalid fixture', dangerLevel: 'safe',
        readonly: true, effect: 'read', handlerRevision: invalid.handlerRevision,
        requiredPermission: 'read', exposure: 'direct', execution: { concurrency: 'read' },
        inputSchema: invalid.schema,
      }, { execute: () => ({ ok: true }) })).toThrow();
      expect(registry.list()).toEqual([]);
    }
    expect(getterCalls).toBe(0);
  });

  it('captures an immutable Handler revision without retaining the raw Handler publicly', () => {
    const registry = new ToolRegistry();
    const execute = () => createAgentToolResultEnvelope({
      modelProjection: { ok: true }, durableSummary: { ok: true },
    });
    registry.registerInvocation({
      name: 'runtime_only', description: 'runtime-only fixture', dangerLevel: 'safe',
      readonly: true, effect: 'read', handlerRevision: 'runtime_only@1',
      requiredPermission: 'read', exposure: 'direct',
      execution: { concurrency: 'read' }, inputSchema: { type: 'object' },
    }, { execute });
    const snapshot = registry.captureSnapshot();

    expect(containsReference(registry, execute)).toBe(false);
    expect(containsReference(snapshot, execute)).toBe(false);
    expect('getInvocationRuntime' in snapshot).toBe(false);
    expect(snapshot.get('runtime_only')?.descriptor).toMatchObject({
      flatName: 'runtime_only', effect: 'read',
    });
    expect(() => registry.getRuntime('runtime_only')?.handler({}, {} as never))
      .toThrow(/ToolInvocationRuntime/u);
    registry.unregister('runtime_only');
    snapshot.release();
  });

  it('publishes registration only after the invocation Handler is atomically visible', () => {
    const registry = new ToolRegistry();
    const snapshots: ReturnType<ToolRegistry['captureSnapshot']>[] = [];
    registry.subscribe(() => snapshots.push(registry.captureSnapshot()));
    const execute = () => createAgentToolResultEnvelope({
      modelProjection: { ok: true }, durableSummary: { ok: true },
    });

    registry.registerInvocation({
      name: 'atomic_runtime', description: 'atomic fixture', dangerLevel: 'safe',
      readonly: true, effect: 'read', handlerRevision: 'atomic_runtime@1',
      requiredPermission: 'read', exposure: 'direct',
      execution: { concurrency: 'read' }, inputSchema: { type: 'object' },
    }, { execute });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.get('atomic_runtime')?.descriptor).toMatchObject({
      flatName: 'atomic_runtime', effect: 'read',
    });
    expect(containsReference(snapshots[0], execute)).toBe(false);
    snapshots.forEach((snapshot) => snapshot.release());
  });

  it('keeps one Invocation generation when lifecycle retain re-enters unregister/register', async () => {
    const registry = new ToolRegistry();
    const lifecycleReleases: string[] = [];
    let replaceDuringRetain = true;
    registry.replaceOwnerTools('lifecycle-owner', [{
      definition: legacyDefinition('lifecycle_trigger', 'trigger-v1'),
      handler: () => ({ trigger: true }),
    }], {
      snapshotLifecycle: {
        retain: () => {
          if (replaceDuringRetain) {
            replaceDuringRetain = false;
            expect(registry.unregister('generation_probe')).toBe(true);
            registerInvocationGeneration(registry, 'v2');
          }
          return () => lifecycleReleases.push('trigger');
        },
      },
    });
    registerInvocationGeneration(registry, 'v1');

    const oldSnapshot = registry.captureSnapshot();
    const newSnapshot = registry.captureSnapshot();
    try {
      expect(oldSnapshot.get('generation_probe')?.descriptor.description).toBe('generation-v1');
      expect(oldSnapshot.toolRevision('generation_probe')).toBe(1);
      expect(oldSnapshot.invocationRevision('generation_probe')).toContain('generation_probe@v1');
      expect(await invokeSnapshotHandler(oldSnapshot, 'generation_probe')).toMatchObject({
        modelProjection: { generation: 'v1' },
      });

      expect(newSnapshot.get('generation_probe')?.descriptor.description).toBe('generation-v2');
      expect(newSnapshot.toolRevision('generation_probe')).toBe(2);
      expect(newSnapshot.invocationRevision('generation_probe')).toContain('generation_probe@v2');
      expect(await invokeSnapshotHandler(newSnapshot, 'generation_probe')).toMatchObject({
        modelProjection: { generation: 'v2' },
      });
    } finally {
      oldSnapshot.release();
      newSnapshot.release();
    }
    expect(lifecycleReleases).toEqual(['trigger', 'trigger']);
  });

  it('keeps descriptor, revision, Handler and lifecycle in one replaceOwnerTools generation', async () => {
    const registry = new ToolRegistry();
    const retained: string[] = [];
    const released: string[] = [];
    let replaceDuringRetain = true;
    const lifecycle = (generation: string) => ({
      retain: () => {
        retained.push(generation);
        return () => released.push(generation);
      },
    });
    registry.replaceOwnerTools('trigger-owner', [{
      definition: legacyDefinition('owner_trigger', 'trigger-v1'),
      handler: () => ({ trigger: true }),
    }], {
      snapshotLifecycle: {
        retain: () => {
          retained.push('trigger');
          if (replaceDuringRetain) {
            replaceDuringRetain = false;
            registry.replaceOwnerTools('replaceable-owner', [{
              definition: legacyDefinition('replaceable_tool', 'owned-v2'),
              handler: () => ({ generation: 'v2' }),
            }], { snapshotLifecycle: lifecycle('v2') });
          }
          return () => released.push('trigger');
        },
      },
    });
    registry.replaceOwnerTools('replaceable-owner', [{
      definition: legacyDefinition('replaceable_tool', 'owned-v1'),
      handler: () => ({ generation: 'v1' }),
    }], { snapshotLifecycle: lifecycle('v1') });

    const oldSnapshot = registry.captureSnapshot();
    expect(oldSnapshot.get('replaceable_tool')?.descriptor.description).toBe('owned-v1');
    expect(oldSnapshot.toolRevision('replaceable_tool')).toBe(1);
    expect(await invokeLegacyHandler(oldSnapshot, 'replaceable_tool')).toEqual({ generation: 'v1' });
    expect(retained).toEqual(['trigger', 'v1']);

    const newSnapshot = registry.captureSnapshot();
    expect(newSnapshot.get('replaceable_tool')?.descriptor.description).toBe('owned-v2');
    expect(newSnapshot.toolRevision('replaceable_tool')).toBe(2);
    expect(await invokeLegacyHandler(newSnapshot, 'replaceable_tool')).toEqual({ generation: 'v2' });
    expect(retained).toEqual(['trigger', 'v1', 'trigger', 'v2']);

    oldSnapshot.release();
    newSnapshot.release();
    expect(released).toEqual(['v1', 'trigger', 'v2', 'trigger']);
  });

  it('releases every acquired lifecycle and preserves retain plus cleanup failures', () => {
    const registry = new ToolRegistry();
    const calls: string[] = [];
    const retainFailure = new Error('retain-three');
    const cleanupFailure = new Error('release-one');
    registerLifecycleTool(registry, 'owner-1', 'lifecycle_1', {
      retain: () => {
        calls.push('retain-1');
        return () => {
          calls.push('release-1');
          throw cleanupFailure;
        };
      },
    });
    registerLifecycleTool(registry, 'owner-2', 'lifecycle_2', {
      retain: () => {
        calls.push('retain-2');
        return () => calls.push('release-2');
      },
    });
    registerLifecycleTool(registry, 'owner-3', 'lifecycle_3', {
      retain: () => {
        calls.push('retain-3');
        throw retainFailure;
      },
    });

    let failure: unknown;
    try {
      registry.captureSnapshot();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([retainFailure, cleanupFailure]);
    expect((failure as Error & { cause?: unknown }).cause).toBe(retainFailure);
    expect(calls).toEqual(['retain-1', 'retain-2', 'retain-3', 'release-2', 'release-1']);
  });

  it('aggregates normal release failures after calling every release exactly once', () => {
    const registry = new ToolRegistry();
    const calls: string[] = [];
    const releaseThreeFailure = new Error('release-three');
    const releaseOneFailure = new Error('release-one');
    for (const [index, failure] of [releaseOneFailure, undefined, releaseThreeFailure].entries()) {
      const ordinal = index + 1;
      registerLifecycleTool(registry, `owner-${ordinal}`, `normal_release_${ordinal}`, {
        retain: () => {
          calls.push(`retain-${ordinal}`);
          return () => {
            calls.push(`release-${ordinal}`);
            if (failure !== undefined) throw failure;
          };
        },
      });
    }
    const snapshot = registry.captureSnapshot();

    let failure: unknown;
    try {
      snapshot.release();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([releaseThreeFailure, releaseOneFailure]);
    expect(calls).toEqual([
      'retain-1', 'retain-2', 'retain-3', 'release-3', 'release-2', 'release-1',
    ]);
    expect(() => snapshot.release()).not.toThrow();
    expect(calls).toHaveLength(6);
  });

  it('rejects a non-function lifecycle release and cleans every earlier lease immediately', () => {
    const registry = new ToolRegistry();
    const calls: string[] = [];
    registerLifecycleTool(registry, 'owner-1', 'valid_release', {
      retain: () => {
        calls.push('retain-1');
        return () => calls.push('release-1');
      },
    });
    registerLifecycleTool(registry, 'owner-2', 'invalid_release', {
      retain: () => {
        calls.push('retain-2');
        return undefined as never;
      },
    });
    registerLifecycleTool(registry, 'owner-3', 'must_not_retain', {
      retain: () => {
        calls.push('retain-3');
        return () => calls.push('release-3');
      },
    });

    expect(() => registry.captureSnapshot()).toThrow(TypeError);
    expect(calls).toEqual(['retain-1', 'retain-2', 'release-1']);
  });

  it('does not allow public construction of a partial Tool snapshot', () => {
    expect(() => {
      Reflect.construct(ToolCatalogSnapshot, []);
    }).toThrow('ToolCatalogSnapshot can only be created by ToolRegistry.captureSnapshot().');
  });
});

function legacyDefinition(name: string, description: string) {
  return {
    name,
    description,
    dangerLevel: 'safe' as const,
    readonly: true,
    requiredPermission: 'read' as const,
    exposure: 'direct' as const,
    execution: { concurrency: 'read' as const },
    inputSchema: { type: 'object' },
  };
}

function registerLifecycleTool(
  registry: ToolRegistry,
  ownerId: string,
  name: string,
  snapshotLifecycle: { retain(): () => void },
): void {
  registry.replaceOwnerTools(ownerId, [{
    definition: legacyDefinition(name, name),
    handler: () => ({ name }),
  }], { snapshotLifecycle });
}

function registerInvocationGeneration(registry: ToolRegistry, generation: 'v1' | 'v2'): void {
  registry.registerInvocation({
    name: 'generation_probe', description: `generation-${generation}`, dangerLevel: 'safe',
    readonly: true, effect: 'read', handlerRevision: `generation_probe@${generation}`,
    requiredPermission: 'read', exposure: 'direct',
    execution: { concurrency: 'read' }, inputSchema: { type: 'object' },
  }, {
    execute: () => createAgentToolResultEnvelope({
      modelProjection: { generation }, durableSummary: { generation },
    }),
  });
}

async function invokeSnapshotHandler(snapshot: ToolCatalogSnapshot, name: string): Promise<unknown> {
  const runtime = resolveInvocationHandler(snapshot, name);
  if (runtime === undefined) throw new Error(`Missing Invocation Handler: ${name}`);
  return await runtime.execute({}, {
    projectId: 'project-a', sessionId: 'session-a', runId: 'run-a', turnId: 'turn-a',
    invocationId: 'invocation-a', idempotencyKey: 'idempotency-a', fencingToken: 1,
    signal: new AbortController().signal,
  });
}

async function invokeLegacyHandler(snapshot: ToolCatalogSnapshot, name: string): Promise<unknown> {
  const runtime = snapshot.getRuntime(name);
  if (runtime === undefined) throw new Error(`Missing legacy Handler: ${name}`);
  return await runtime.handler({}, {} as never);
}

function containsReference(root: unknown, target: unknown, seen = new Set<unknown>()): boolean {
  if (root === target) return true;
  if ((typeof root !== 'object' && typeof root !== 'function') || root === null) return false;
  if (seen.has(root)) return false;
  seen.add(root);
  if (root instanceof Map) {
    for (const [key, value] of root) {
      if (containsReference(key, target, seen) || containsReference(value, target, seen)) return true;
    }
  }
  if (root instanceof Set) {
    for (const value of root) if (containsReference(value, target, seen)) return true;
  }
  for (const key of Reflect.ownKeys(root)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(root, key);
    if (
      descriptor !== undefined && 'value' in descriptor &&
      containsReference(descriptor.value, target, seen)
    ) return true;
  }
  const prototype = Reflect.getPrototypeOf(root) as unknown;
  return prototype !== null && containsReference(prototype, target, seen);
}
