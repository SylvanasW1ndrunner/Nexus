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

  it('captures an immutable Handler revision that legacy runtime lookup cannot execute', () => {
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

    expect(snapshot.getInvocationRuntime('runtime_only')).toMatchObject({ execute });
    expect(snapshot.get('runtime_only')?.descriptor).toMatchObject({
      flatName: 'runtime_only', effect: 'read',
    });
    expect(() => registry.getRuntime('runtime_only')?.handler({}, {} as never))
      .toThrow(/ToolInvocationRuntime/u);
    registry.unregister('runtime_only');
    expect(snapshot.getInvocationRuntime('runtime_only')).toMatchObject({ execute });
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
    expect(snapshots[0]?.getInvocationRuntime('atomic_runtime')).toMatchObject({ execute });
    snapshots.forEach((snapshot) => snapshot.release());
  });
});
