import { describe, expect, it } from 'vitest';
import {
  ToolRegistry,
  createAgentToolResultEnvelope,
} from '../src/index.js';

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
});

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
