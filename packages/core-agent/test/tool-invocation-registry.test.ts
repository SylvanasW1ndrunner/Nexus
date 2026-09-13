import { describe, expect, it } from 'vitest';
import {
  BASE_TOOL_MANIFEST,
  ToolCatalogSnapshot,
  ToolRegistry,
} from '../src/index.js';
import { resolveInvocationHandler } from '../src/internal/tool-invocation-authority.js';
import { invocationContribution as fixtureContribution } from './fixtures/invocation-contribution.js';

describe('invocation-only Tool registry boundary', () => {
  it('reports the current complete baseline size when publication is incomplete', () => {
    const registry = new ToolRegistry();
    expect(() => registry.publishBaselineInvocations([])).toThrow(
      `Baseline publication requires all ${BASE_TOOL_MANIFEST.length} Tool contributions.`,
    );
  });

  it('checks the private output envelope boundary even after the same input schema was validated', () => {
    const registry = new ToolRegistry();
    const schema = { type: 'object', description: 'schemanaut.agent-tool-result.v1' };
    const input = fixtureContribution('cached_input_schema');
    registry.registerInvocation({ ...input.definition, inputSchema: schema }, input.runtime);

    const output = fixtureContribution('cached_output_schema');
    expect(() => registry.registerInvocation({
      ...output.definition,
      outputSchema: { ...schema },
    }, output.runtime)).toThrow('Tool output schemas cannot declare the Runtime private result envelope.');
    expect(registry.list().map(({ name }) => name)).toEqual(['cached_input_schema']);
  });

  it('cannot seed the schema cache with different descriptor and property-read values', () => {
    const registry = new ToolRegistry();
    const invalidSchema = { type: 'invalid-schema-type', description: 'proxy-cache-seed' };
    const divergentSchema = new Proxy(invalidSchema, {
      get(target, key): unknown {
        return key === 'type' ? 'object' : Reflect.get(target, key);
      },
    });
    const seed = fixtureContribution('proxy_cache_seed');
    expect(() => registry.registerInvocation({
      ...seed.definition,
      inputSchema: divergentSchema,
    }, seed.runtime)).toThrow();

    const ordinary = fixtureContribution('ordinary_invalid_schema');
    expect(() => registry.registerInvocation({
      ...ordinary.definition,
      inputSchema: { ...invalidSchema },
    }, ordinary.runtime)).toThrow();
    expect(registry.list()).toEqual([]);
  });

  it('atomically replaces one owner with revisioned Invocation Tool generations', () => {
    const registry = new ToolRegistry();
    const events: string[][] = [];
    registry.subscribe((event) => {
      if (event.kind === 'owner-replaced') events.push([
        ...event.added.map((name) => `add:${name}`),
        ...event.updated.map((name) => `update:${name}`),
        ...event.removed.map((name) => `remove:${name}`),
      ]);
    });
    registry.replaceOwnerInvocations('module:fixture:primary', [
      invocationContribution('read_alpha', 'alpha@1', 'v1'),
      invocationContribution('read_beta', 'beta@1', 'v1'),
    ]);
    const first = registry.captureSnapshot();

    registry.replaceOwnerInvocations('module:fixture:primary', [
      invocationContribution('read_alpha', 'alpha@2', 'v2'),
      invocationContribution('read_gamma', 'gamma@1', 'v1'),
    ]);
    const second = registry.captureSnapshot();
    try {
      expect(first.list().map(({ name }) => name).sort()).toEqual(['read_alpha', 'read_beta']);
      expect(first.invocationRevision('read_alpha')).toContain('alpha@1');
      expect(first.get('read_alpha')?.descriptor.handlerRevision).toBe('alpha@1');
      expect(second.list().map(({ name }) => name).sort()).toEqual(['read_alpha', 'read_gamma']);
      expect(second.invocationRevision('read_alpha')).toContain('alpha@2');
      expect(second.get('read_alpha')?.descriptor.handlerRevision).toBe('alpha@2');
      expect(resolveInvocationHandler(second, 'read_beta')).toBeUndefined();
    } finally {
      first.release();
      second.release();
    }
    expect(events).toEqual([
      ['add:read_alpha', 'add:read_beta'],
      ['add:read_gamma', 'update:read_alpha', 'remove:read_beta'],
    ]);
  });

  it('publishes no owner mutation when one Invocation contribution is invalid', () => {
    const registry = new ToolRegistry();
    registry.replaceOwnerInvocations('module:fixture:primary', [
      invocationContribution('stable_tool', 'stable@1', 'v1'),
    ]);
    const beforeRevision = registry.catalogRevision;

    expect(() => registry.replaceOwnerInvocations('module:fixture:primary', [
      invocationContribution('replacement_tool', 'replacement@1', 'v2'),
      {
        definition: {
          ...invocationContribution('invalid_tool', 'invalid@1', 'v2').definition,
          handlerRevision: '',
        },
        runtime: fixtureContribution('invalid_tool').runtime,
      },
    ])).toThrow(/handlerRevision/i);

    const snapshot = registry.captureSnapshot();
    try {
      expect(registry.catalogRevision).toBe(beforeRevision);
      expect(snapshot.list().map(({ name }) => name)).toEqual(['stable_tool']);
      expect(snapshot.invocationRevision('stable_tool')).toContain('stable@1');
    } finally {
      snapshot.release();
    }
  });

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
        ...fixtureContribution(`invalid_${index}`, {}).definition,
        name: `invalid_${index}`, description: 'invalid fixture', dangerLevel: 'safe',
        handlerRevision: invalid.handlerRevision,
        inputSchema: invalid.schema,
      }, fixtureContribution(`invalid_${index}`, {}).runtime)).toThrow();
      expect(registry.list()).toEqual([]);
    }
    expect(getterCalls).toBe(0);
  });

  it('captures an immutable Handler revision without retaining the raw Handler publicly', () => {
    const registry = new ToolRegistry();
    const contribution = fixtureContribution('runtime_only', { ok: true }, { exposure: 'direct' });
    const execute = contribution.runtime.execute;
    registry.registerInvocation(contribution.definition, contribution.runtime);
    const snapshot = registry.captureSnapshot();

    expect(containsReference(registry, execute)).toBe(false);
    expect(containsReference(snapshot, execute)).toBe(false);
    expect('getInvocationRuntime' in snapshot).toBe(false);
    expect(snapshot.get('runtime_only')?.descriptor).toMatchObject({
      flatName: 'runtime_only', recoveryClass: 'read', access: 'read',
    });
    expect('getRuntime' in registry).toBe(false);
    registry.unregister('runtime_only');
    snapshot.release();
  });

  it('publishes registration only after the invocation Handler is atomically visible', () => {
    const registry = new ToolRegistry();
    const snapshots: ReturnType<ToolRegistry['captureSnapshot']>[] = [];
    registry.subscribe(() => snapshots.push(registry.captureSnapshot()));
    const contribution = fixtureContribution('atomic_runtime', { ok: true }, { exposure: 'direct' });
    const execute = contribution.runtime.execute;
    registry.registerInvocation(contribution.definition, contribution.runtime);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.get('atomic_runtime')?.descriptor).toMatchObject({
      flatName: 'atomic_runtime', recoveryClass: 'read', access: 'read',
    });
    expect(containsReference(snapshots[0], execute)).toBe(false);
    snapshots.forEach((snapshot) => snapshot.release());
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

function registerLifecycleTool(
  registry: ToolRegistry,
  ownerId: string,
  name: string,
  snapshotLifecycle: { retain(): () => void },
): void {
  const contribution = fixtureContribution(name, { name }, {
    handlerRevision: name,
    exposure: 'direct',
  });
  registry.replaceOwnerInvocations(ownerId, [{
    definition: {
      ...contribution.definition,
      description: name,
    },
    runtime: contribution.runtime,
  }], { snapshotLifecycle });
}

function invocationContribution(name: string, handlerRevision: string, generation: string) {
  return fixtureContribution(name, { generation }, { handlerRevision, exposure: 'direct' });
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
