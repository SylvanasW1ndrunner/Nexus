import { describe, expect, it, vi } from 'vitest';
import {
  CapabilityControlPlane,
  CapabilityShutdownTimeoutError,
  ToolRegistry,
  createAgentCapabilityServiceToken,
  type ToolInvocationHandler,
  type ToolCatalogSnapshot,
} from '../src/index.js';
import { invocationContribution } from './fixtures/invocation-contribution.js';
import { preparedToolIntent } from './permission-audit-fixture.js';
import { resolveInvocationHandler } from '../src/internal/tool-invocation-authority.js';

describe('CapabilityControlPlane failure atomicity', () => {
  it('turns invalid JavaScript probe output into host diagnostics', async () => {
    const control = new CapabilityControlPlane();
    control.register({
      manifest: {
        id: 'fixture.invalid-probe',
        version: '1.0.0',
        description: 'Invalid probe fixture',
        capabilities: [{ id: 'fixture.read', description: 'Read fixture data' }],
      },
      instanceId: 'primary',
      load: () => ({
        probe: () => ({ status: 'not-a-status' }) as never,
        activate: () => ({ contributions: {} }),
      }),
    });

    await expect(control.activate({ moduleId: 'fixture.invalid-probe', instanceId: 'primary' }))
      .rejects.toThrow();

    expect(control.snapshot().modules[0]).toMatchObject({
      status: 'unavailable',
      active: false,
      lastFailure: {
        operation: 'resolve',
        message: 'Invalid capability status: not-a-status',
      },
    });
  });

  it('rejects undeclared per-capability probe state instead of silently ignoring a typo', async () => {
    const control = new CapabilityControlPlane();
    control.register({
      manifest: {
        id: 'fixture.invalid-probe-capability',
        version: '1.0.0',
        description: 'Invalid probe capability fixture',
        capabilities: [{ id: 'fixture.read', description: 'Read fixture data' }],
      },
      instanceId: 'primary',
      load: () => ({
        probe: () =>
          ({
            status: 'available',
            capabilities: { 'fixture.typo': { status: 'available' } },
          }) as never,
        activate: () => ({ contributions: {} }),
      }),
    });

    await expect(control.activate({ moduleId: 'fixture.invalid-probe-capability', instanceId: 'primary' }))
      .rejects.toThrow();

    expect(control.snapshot().modules[0]?.lastFailure).toEqual({
      operation: 'resolve',
      message: 'Capability probe returned an undeclared capability: fixture.typo',
    });
  });

  it('rejects an invalid JavaScript runtime without publishing partial state', async () => {
    const control = new CapabilityControlPlane();
    control.register({
      manifest: {
        id: 'fixture.invalid-runtime',
        version: '1.0.0',
        description: 'Invalid runtime fixture',
        capabilities: [{ id: 'fixture.read', description: 'Read fixture data' }],
      },
      instanceId: 'primary',
      load: () => ({
        probe: () => ({ status: 'available' }),
        activate: () => undefined as never,
      }),
    });

    await expect(
      control.activate({ moduleId: 'fixture.invalid-runtime', instanceId: 'primary' }),
    ).rejects.toThrow('Capability module activate() must return a runtime object');
    expect(control.snapshot().modules[0]).toMatchObject({
      status: 'available',
      active: false,
      contributions: { tools: 0, skillSources: 0 },
    });
  });

  it('disposes registration-owned resources without loading an unused module', async () => {
    const load = vi.fn(() => ({
      activate: () => ({ contributions: {} }),
    }));
    const dispose = vi.fn(() => Promise.resolve());
    const control = new CapabilityControlPlane();
    control.register({
      manifest: {
        id: 'fixture.unused-registration-resource',
        version: '1.0.0',
        description: 'Unused registration resource fixture',
        capabilities: [{ id: 'fixture.unused', description: 'Unused fixture' }],
      },
      instanceId: 'primary',
      load,
      dispose,
    });

    await control.close();

    expect(load).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('retries a registration disposer after a transient shutdown failure', async () => {
    let attempts = 0;
    const dispose = vi.fn(() => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error('temporary disposer failure'))
        : Promise.resolve();
    });
    const control = new CapabilityControlPlane();
    control.register({
      manifest: {
        id: 'fixture.retry-registration-dispose',
        version: '1.0.0',
        description: 'Retry registration disposer fixture',
        capabilities: [{ id: 'fixture.retry-dispose', description: 'Retry dispose fixture' }],
      },
      instanceId: 'primary',
      load: () => ({ activate: () => ({ contributions: {} }) }),
      dispose,
    });

    await expect(control.close()).rejects.toMatchObject({ name: 'AggregateError' });
    expect(control.snapshot()).toMatchObject({ phase: 'draining' });
    expect(control.snapshot().modules[0]).toMatchObject({
      active: false,
      draining: true,
      lastFailure: {
        operation: 'dispose',
        message: 'temporary disposer failure',
      },
    });
    await expect(control.close()).resolves.toBeUndefined();

    expect(dispose).toHaveBeenCalledTimes(2);
    expect(control.snapshot()).toMatchObject({ phase: 'closed' });
    expect(control.snapshot().modules[0]).toMatchObject({ draining: false });
  });

  it('rolls back malformed contribution collections with a stable contract error', async () => {
    const close = vi.fn();
    const control = new CapabilityControlPlane();
    control.register({
      manifest: {
        id: 'fixture.invalid-contributions',
        version: '1.0.0',
        description: 'Invalid contributions fixture',
        capabilities: [{ id: 'fixture.read', description: 'Read fixture data' }],
      },
      instanceId: 'primary',
      load: () => ({
        probe: () => ({ status: 'available' }),
        activate: () => ({
          contributions: { tools: {} as never },
          close,
        }),
      }),
    });

    await expect(
      control.activate({ moduleId: 'fixture.invalid-contributions', instanceId: 'primary' }),
    ).rejects.toThrow('Module tools must be an array.');
    expect(close).toHaveBeenCalledTimes(1);
    expect(control.snapshot().modules[0]?.active).toBe(false);
  });

  it('rejects malformed service tokens without publishing an unreachable service', async () => {
    const close = vi.fn();
    const control = new CapabilityControlPlane();
    control.register({
      manifest: {
        id: 'fixture.invalid-service',
        version: '1.0.0',
        description: 'Invalid service fixture',
        capabilities: [{ id: 'fixture.read', description: 'Read fixture data' }],
      },
      instanceId: 'primary',
      load: () => ({
        activate: () => ({
          contributions: {
            services: [{ token: { id: 42 } as never, value: { unreachable: true } }],
          },
          close,
        }),
      }),
    });

    await expect(
      control.activate({ moduleId: 'fixture.invalid-service', instanceId: 'primary' }),
    ).rejects.toThrow('Capability service token id must be a string');
    expect(close).toHaveBeenCalledTimes(1);
    expect(control.snapshot().modules[0]?.active).toBe(false);
  });

  it('withdraws an active generation when health becomes unavailable', async () => {
    let available = true;
    const close = vi.fn();
    const control = new CapabilityControlPlane();
    control.register({
      manifest: {
        id: 'fixture.health',
        version: '1.0.0',
        description: 'Health fixture',
        capabilities: [{ id: 'fixture.read', description: 'Read fixture data' }],
      },
      instanceId: 'primary',
      load: () => ({
        probe: () =>
          available
            ? { status: 'available' as const }
            : { status: 'unavailable' as const, reason: 'fixture went offline' },
        activate: () => ({
          contributions: {
            tools: [invocationTool('fixture_health_read', 'fixture_health_read@1', { ok: true })],
          },
          close,
        }),
      }),
    });
    await control.activate({ moduleId: 'fixture.health', instanceId: 'primary' });
    available = false;

    await expect(control.refresh({ moduleId: 'fixture.health', instanceId: 'primary' }))
      .rejects.toThrow('Capability module is not available');

    expect(control.tools.has('fixture_health_read')).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
    expect(control.snapshot().modules[0]).toMatchObject({
      status: 'unavailable',
      active: false,
      reason: 'fixture went offline',
    });
  });

  it('does not refresh an active generation after its probe becomes unavailable', async () => {
    let available = true;
    const refresh = vi.fn(() => ({ contributions: {} }));
    const close = vi.fn();
    const control = new CapabilityControlPlane();
    control.register({
      manifest: {
        id: 'fixture.refresh-health',
        version: '1.0.0',
        description: 'Refresh health fixture',
        capabilities: [{ id: 'fixture.read', description: 'Read fixture data' }],
      },
      instanceId: 'primary',
      load: () => ({
        probe: () =>
          available
            ? { status: 'available' as const }
            : { status: 'unavailable' as const, reason: 'fixture went offline' },
        activate: () => ({
          contributions: {
            tools: [
              invocationTool('fixture_refresh_health', 'fixture_refresh_health@1', { ok: true }),
            ],
          },
          close,
        }),
        refresh,
      }),
    });
    await control.activate({ moduleId: 'fixture.refresh-health', instanceId: 'primary' });
    available = false;

    await expect(
      control.refresh({ moduleId: 'fixture.refresh-health', instanceId: 'primary' }),
    ).rejects.toThrow('Capability module is not available');

    expect(refresh).not.toHaveBeenCalled();
    expect(control.tools.has('fixture_refresh_health')).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
    expect(control.snapshot().modules[0]).toMatchObject({
      status: 'unavailable',
      active: false,
      lastFailure: { operation: 'refresh' },
    });
  });

  it('closes a candidate runtime and commits no tools when one contribution collides', async () => {
    const tools = new ToolRegistry();
    const shared = invocationTool('shared_read', 'shared_read@1', { owner: 'kernel' });
    tools.registerInvocation(shared.definition, shared.runtime);
    const close = vi.fn();
    const control = new CapabilityControlPlane({ toolRegistry: tools });
    control.register({
      manifest: {
        id: 'schemanaut.database',
        version: '1.0.0',
        description: 'Database access',
        capabilities: [{ id: 'database.query', description: 'Execute queries' }],
      },
      instanceId: 'primary',
      load: () => ({
        probe: () => ({ status: 'available' }),
        activate: () => ({
          contributions: {
            tools: [
              invocationTool('database_query', 'database_query@1', { ok: true }),
              invocationTool('shared_read', 'shared_read@fixture-1', { ok: false }),
            ],
          },
          close,
        }),
      }),
    });

    await expect(
      control.activate({ moduleId: 'schemanaut.database', instanceId: 'primary' }),
    ).rejects.toThrow('Tool already registered: shared_read');

    expect(close).toHaveBeenCalledTimes(1);
    expect(tools.has('database_query')).toBe(false);
    expect(tools.has('shared_read')).toBe(true);
    expect(control.snapshot().modules[0]).toMatchObject({
      moduleId: 'schemanaut.database',
      active: false,
      status: 'available',
      lastFailure: {
        operation: 'activate',
        message: 'Tool already registered: shared_read',
      },
    });
  });

  it('keeps the last committed runtime when refresh validation fails', async () => {
    const tools = new ToolRegistry();
    const shared = invocationTool('shared_read', 'shared_read@1', { owner: 'kernel' });
    tools.registerInvocation(shared.definition, shared.runtime);
    const oldClose = vi.fn();
    const candidateClose = vi.fn();
    const control = new CapabilityControlPlane({ toolRegistry: tools });
    control.register({
      manifest: {
        id: 'fixture.refreshable',
        version: '1.0.0',
        description: 'Refreshable fixture',
        capabilities: [{ id: 'fixture.read', description: 'Read fixture data' }],
      },
      instanceId: 'primary',
      load: () => ({
        probe: () => ({ status: 'available' }),
        activate: () => ({
          contributions: {
            tools: [invocationTool('fixture_read', 'fixture_read@1', { version: 1 })],
          },
          close: oldClose,
        }),
        refresh: () => ({
          contributions: {
            tools: [
              invocationTool('fixture_read', 'fixture_read@2', { version: 2 }),
              invocationTool('shared_read', 'shared_read@fixture-2', { owner: 'fixture' }),
            ],
          },
          close: candidateClose,
        }),
      }),
    });
    await control.activate({ moduleId: 'fixture.refreshable', instanceId: 'primary' });

    await expect(
      control.refresh({ moduleId: 'fixture.refreshable', instanceId: 'primary' }),
    ).rejects.toThrow('Tool already registered: shared_read');

    expect(candidateClose).toHaveBeenCalledTimes(1);
    expect(oldClose).not.toHaveBeenCalled();
    await expect(invokeCurrentTool(tools, 'fixture_read')).resolves.toEqual({ version: 1 });
    expect(control.snapshot().modules[0]?.active).toBe(true);
    expect(control.snapshot().modules[0]?.lastFailure).toMatchObject({
      operation: 'refresh',
      message: 'Tool already registered: shared_read',
    });
  });

  it('removes new access, drains an in-flight call, and closes during deactivation', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = vi.fn();
    const close = vi.fn();
    const tools = new ToolRegistry();
    const control = new CapabilityControlPlane({ toolRegistry: tools });
    control.register({
      manifest: {
        id: 'fixture.draining',
        version: '1.0.0',
        description: 'Draining fixture',
        capabilities: [{ id: 'fixture.slow', description: 'Slow work' }],
      },
      instanceId: 'primary',
      load: () => ({
        probe: () => ({ status: 'available' }),
        activate: () => ({
          contributions: {
            tools: [
              invocationToolWithRuntime('fixture_slow', 'fixture_slow@1', async () => {
                  started();
                  await gate;
                  return { finished: true };
                }),
            ],
          },
          close,
        }),
      }),
    });
    await control.activate({ moduleId: 'fixture.draining', instanceId: 'primary' });
    const oldSnapshot = tools.captureSnapshot();
    const oldHandler = requiredInvocationRuntime(oldSnapshot, 'fixture_slow');
    oldSnapshot.release();
    const inFlight = oldHandler.execute({}, invocationContext());
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1));

    const deactivation = control.deactivate({
      moduleId: 'fixture.draining',
      instanceId: 'primary',
    });
    await vi.waitFor(() => expect(tools.has('fixture_slow')).toBe(false));
    expect(close).not.toHaveBeenCalled();
    await expect(oldHandler.execute({}, invocationContext())).rejects.toThrow(
      'Capability module is deactivating',
    );
    release();

    await expect(inFlight).resolves.toMatchObject({ finished: true });
    await deactivation;
    expect(close).toHaveBeenCalledTimes(1);
    expect(control.snapshot().modules[0]?.active).toBe(false);
  });

  it('keeps a captured generation callable until its model iteration releases the snapshot', async () => {
    const oldClose = vi.fn();
    const tools = new ToolRegistry();
    const control = new CapabilityControlPlane({ toolRegistry: tools });
    control.register({
      manifest: {
        id: 'fixture.snapshot-generation',
        version: '1.0.0',
        description: 'Snapshot generation fixture',
        capabilities: [{ id: 'fixture.snapshot', description: 'Snapshot work' }],
      },
      instanceId: 'primary',
      load: () => ({
        probe: () => ({ status: 'available' }),
        activate: () => ({
          contributions: {
            tools: [invocationTool('fixture_snapshot', 'fixture_snapshot@1', { version: 1 })],
          },
          close: oldClose,
        }),
        refresh: () => ({
          contributions: {
            tools: [invocationTool('fixture_snapshot', 'fixture_snapshot@2', { version: 2 })],
          },
        }),
      }),
    });
    await control.activate({ moduleId: 'fixture.snapshot-generation', instanceId: 'primary' });
    const modelIteration = tools.captureSnapshot();

    const refresh = control.refresh({
      moduleId: 'fixture.snapshot-generation',
      instanceId: 'primary',
    });
    await vi.waitFor(async () => {
      expect(await invokeCurrentTool(tools, 'fixture_snapshot')).toEqual({
        version: 2,
      });
    });
    expect(oldClose).not.toHaveBeenCalled();
    await expect(invokeSnapshotTool(modelIteration, 'fixture_snapshot')).resolves.toEqual({
      version: 1,
    });

    modelIteration.release();
    await refresh;
    expect(oldClose).toHaveBeenCalledTimes(1);
  });

  it('publishes a refresh requested by the retiring generation without waiting for itself', async () => {
    const oldClose = vi.fn();
    const control = new CapabilityControlPlane();
    let version = 1;
    control.register({
      manifest: {
        id: 'fixture.self-refresh',
        version: '1.0.0',
        description: 'Self-refreshing fixture',
        capabilities: [{ id: 'fixture.self-refresh', description: 'Refresh itself.' }],
      },
      instanceId: 'primary',
      load: () => ({
        activate: () => ({
          contributions: {
            tools: [invocationToolWithRuntime(
              'fixture_self_refresh',
              `fixture_self_refresh@${version}`,
              async () => {
                await control.refresh({
                  moduleId: 'fixture.self-refresh',
                  instanceId: 'primary',
                  retirement: 'defer',
                });
                return { published: true };
              },
            )],
          },
          close: oldClose,
        }),
        refresh: () => {
          version += 1;
          return {
            contributions: {
              tools: [invocationTool(
                'fixture_self_refresh',
                `fixture_self_refresh@${version}`,
                { version },
              )],
            },
          };
        },
      }),
    });
    await control.activate({ moduleId: 'fixture.self-refresh', instanceId: 'primary' });
    const oldGeneration = control.captureRuntimeSnapshot();
    const oldTool = requiredInvocationRuntime(oldGeneration.tools, 'fixture_self_refresh');

    await expect(oldTool.execute({}, invocationContext())).resolves.toMatchObject({ published: true });
    const currentGeneration = control.captureRuntimeSnapshot();
    await expect(invokeSnapshotTool(
      currentGeneration.tools,
      'fixture_self_refresh',
    )).resolves.toEqual({ version: 2 });
    currentGeneration.release();
    expect(oldClose).not.toHaveBeenCalled();

    oldGeneration.release();
    await vi.waitFor(() => expect(oldClose).toHaveBeenCalledTimes(1));
    await control.close();
  });

  it('pins a prompt-only module for the complete model iteration', async () => {
    const close = vi.fn();
    const control = new CapabilityControlPlane();
    control.register({
      manifest: {
        id: 'fixture.instructions-only',
        version: '1.0.0',
        description: 'Instruction-only fixture',
        capabilities: [{ id: 'fixture.guidance', description: 'Guidance' }],
      },
      instanceId: 'primary',
      load: () => ({
        probe: () => ({ status: 'available' }),
        activate: () => ({
          contributions: {
            promptSections: [{
              id: 'guidance', source: 'capability', scope: 'turn', priority: 10,
              revision: 'guidance@1', cacheability: 'stable',
              content: [{ type: 'text', text: 'Current generation guidance.' }], tokenEstimate: 4,
            }],
          },
          close,
        }),
      }),
    });
    await control.activate({ moduleId: 'fixture.instructions-only', instanceId: 'primary' });
    const iteration = control.captureRuntimeSnapshot();

    const deactivation = control.deactivate({
      moduleId: 'fixture.instructions-only',
      instanceId: 'primary',
    });
    await vi.waitFor(() => expect(control.promptSections()).toEqual([]));
    expect(iteration.promptSections.map(({ content }) => content))
      .toEqual([[{ type: 'text', text: 'Current generation guidance.' }]]);
    expect(close).not.toHaveBeenCalled();

    iteration.release();
    await deactivation;
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not close a provider while its dependent runtime keeps failing to close', async () => {
    const closeOrder: string[] = [];
    const control = new CapabilityControlPlane();
    for (const [moduleId, capabilityId, dependency] of [
      ['fixture.base', 'fixture.base.run', undefined],
      ['fixture.consumer', 'fixture.consumer.run', 'fixture.base.run'],
    ] as const) {
      control.register({
        manifest: {
          id: moduleId,
          version: '1.0.0',
          description: moduleId,
          capabilities: [{ id: capabilityId, description: capabilityId }],
          ...(dependency === undefined ? {} : { dependencies: [{ capabilityId: dependency }] }),
        },
        instanceId: 'primary',
        load: () => ({
          probe: () => ({ status: 'available' }),
          activate: () => ({
            contributions: {},
            close: () => {
              closeOrder.push(moduleId);
              throw new Error(`close failed: ${moduleId}`);
            },
          }),
        }),
      });
    }
    await control.activate({ moduleId: 'fixture.consumer', instanceId: 'primary' });

    await expect(control.close()).rejects.toMatchObject({ name: 'AggregateError' });
    expect(closeOrder).toEqual(['fixture.consumer']);
    expect(control.snapshot().modules.every((module) => !module.active)).toBe(true);
    await expect(control.close()).rejects.toMatchObject({ name: 'AggregateError' });
    expect(closeOrder).toEqual(['fixture.consumer', 'fixture.consumer']);
  });

  it('retries a transient generation close before disposing module-wide resources', async () => {
    let closeAttempts = 0;
    const failedRuntimeClose = vi.fn(() => {
      closeAttempts += 1;
      if (closeAttempts === 1) throw new Error('retired runtime close failed');
    });
    const currentRuntimeClose = vi.fn();
    const dispose = vi.fn();
    let generation = 0;
    const control = new CapabilityControlPlane();
    control.register({
      manifest: {
        id: 'fixture.retirement-cleanup',
        version: '1.0.0',
        description: 'Retirement cleanup fixture',
        capabilities: [{ id: 'fixture.cleanup', description: 'Cleanup fixture' }],
      },
      instanceId: 'primary',
      load: () => ({
        activate: () => ({ contributions: {}, close: failedRuntimeClose }),
        refresh: () => {
          generation += 1;
          return { contributions: {}, close: currentRuntimeClose };
        },
        dispose,
      }),
    });
    await control.activate({ moduleId: 'fixture.retirement-cleanup', instanceId: 'primary' });
    await control.refresh({ moduleId: 'fixture.retirement-cleanup', instanceId: 'primary' });
    expect(generation).toBe(1);

    await expect(control.close()).resolves.toBeUndefined();

    expect(failedRuntimeClose).toHaveBeenCalledTimes(2);
    expect(currentRuntimeClose).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('waits for an in-flight activation and retires it before shutdown completes', async () => {
    let releaseActivation!: () => void;
    let reportActivationStarted!: () => void;
    const activationGate = new Promise<void>((resolve) => {
      releaseActivation = resolve;
    });
    const activationStarted = new Promise<void>((resolve) => {
      reportActivationStarted = resolve;
    });
    const close = vi.fn();
    const control = new CapabilityControlPlane();
    control.register({
      manifest: {
        id: 'fixture.shutdown-race',
        version: '1.0.0',
        description: 'Shutdown race fixture',
        capabilities: [{ id: 'fixture.shutdown', description: 'Shutdown fixture' }],
      },
      instanceId: 'primary',
      load: () => ({
        probe: () => ({ status: 'available' }),
        activate: async () => {
          reportActivationStarted();
          await activationGate;
          return {
            contributions: {
              tools: [
                invocationTool('fixture_shutdown_race', 'fixture_shutdown_race@1', { ok: true }),
              ],
            },
            close,
          };
        },
      }),
    });

    const activation = control.activate({
      moduleId: 'fixture.shutdown-race',
      instanceId: 'primary',
    });
    await activationStarted;
    let shutdownSettled = false;
    const shutdown = control.close().finally(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();

    expect(shutdownSettled).toBe(false);
    releaseActivation();
    await expect(activation).rejects.toThrow('Capability activation was cancelled');
    await shutdown;

    expect(close).toHaveBeenCalledTimes(1);
    expect(control.tools.has('fixture_shutdown_race')).toBe(false);
    expect(control.snapshot().modules[0]).toMatchObject({ active: false });
  });

  it('retries cleanup of a late unpublished candidate before module disposal', async () => {
    let releaseActivation!: () => void;
    let reportActivationStarted!: () => void;
    const activationGate = new Promise<void>((resolve) => { releaseActivation = resolve; });
    const activationStarted = new Promise<void>((resolve) => { reportActivationStarted = resolve; });
    let closeAttempts = 0;
    const candidateClose = vi.fn(() => {
      closeAttempts += 1;
      if (closeAttempts === 1) throw new Error('candidate close failed once');
    });
    const dispose = vi.fn();
    const control = new CapabilityControlPlane();
    control.register({
      manifest: {
        id: 'fixture.late-candidate', version: '1.0.0', description: 'Late candidate fixture',
        capabilities: [{ id: 'fixture.late-candidate.run', description: 'Late candidate work' }],
      },
      instanceId: 'primary',
      load: () => ({
        activate: async () => {
          reportActivationStarted();
          await activationGate;
          return { contributions: {}, close: candidateClose };
        },
        dispose,
      }),
    });

    const activation = control.activate({ moduleId: 'fixture.late-candidate', instanceId: 'primary' });
    await activationStarted;
    const shutdown = control.close();
    releaseActivation();

    await expect(activation).rejects.toThrow('Capability candidate cleanup failed');
    await shutdown;
    expect(candidateClose).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(control.snapshot()).toMatchObject({ phase: 'closed' });
  });

  it('times out a non-cooperative loader, then disposes its late module without publication', async () => {
    let releaseLoad!: () => void;
    let reportLoadStarted!: () => void;
    let observedSignal: AbortSignal | undefined;
    const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve; });
    const loadStarted = new Promise<void>((resolve) => { reportLoadStarted = resolve; });
    const dispose = vi.fn();
    const control = new CapabilityControlPlane({ shutdownTimeoutMs: 20 });
    control.register({
      manifest: {
        id: 'fixture.late-loader', version: '1.0.0', description: 'Late loader fixture',
        capabilities: [{ id: 'fixture.late-loader.run', description: 'Late work' }],
      },
      instanceId: 'primary',
      load: async (context) => {
        observedSignal = context?.signal;
        reportLoadStarted();
        await loadGate;
        return {
          activate: () => ({
            contributions: {
              tools: [invocationTool('fixture_late_loader', 'fixture_late_loader@1', { ok: true })],
            },
          }),
          dispose,
        };
      },
    });

    const activation = control.activate({ moduleId: 'fixture.late-loader', instanceId: 'primary' });
    await loadStarted;
    await expect(control.close()).rejects.toBeInstanceOf(CapabilityShutdownTimeoutError);
    expect(observedSignal?.aborted).toBe(true);
    expect(control.snapshot()).toMatchObject({ phase: 'draining' });
    expect(control.snapshot().modules[0]).toMatchObject({ draining: true });

    releaseLoad();
    await expect(activation).rejects.toThrow();
    await control.close();

    expect(control.tools.has('fixture_late_loader')).toBe(false);
    expect(control.snapshot().modules[0]).toMatchObject({ active: false });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('reports a retained service lease as draining until its consumer releases it', async () => {
    const token = createAgentCapabilityServiceToken<{ value: string }>('fixture.service');
    const runtimeClose = vi.fn();
    const dispose = vi.fn();
    const control = new CapabilityControlPlane({ shutdownTimeoutMs: 20 });
    control.register({
      manifest: {
        id: 'fixture.service-pin', version: '1.0.0', description: 'Service pin fixture',
        capabilities: [{ id: 'fixture.service-pin.run', description: 'Pinned service' }],
      },
      instanceId: 'primary',
      load: () => ({
        activate: () => ({
          contributions: { services: [{ token, value: { value: 'retained' } }] },
          close: runtimeClose,
        }),
        dispose,
      }),
    });
    await control.activate({ moduleId: 'fixture.service-pin', instanceId: 'primary' });
    const service = control.captureService(token);
    expect(service?.value).toEqual({ value: 'retained' });

    await expect(control.close()).rejects.toBeInstanceOf(CapabilityShutdownTimeoutError);
    expect(control.snapshot()).toMatchObject({ phase: 'draining' });
    expect(control.snapshot().modules[0]).toMatchObject({ active: false, draining: true });
    expect(runtimeClose).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();

    service?.release();
    await control.close();
    expect(control.snapshot()).toMatchObject({ phase: 'closed' });
    expect(control.snapshot().modules[0]).toMatchObject({ draining: false });
    expect(runtimeClose).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('revokes captured Tool snapshots during host shutdown', async () => {
    const close = vi.fn();
    const control = new CapabilityControlPlane();
    control.register({
      manifest: {
        id: 'fixture.shutdown-snapshot', version: '1.0.0', description: 'Snapshot shutdown fixture',
        capabilities: [{ id: 'fixture.shutdown-snapshot.run', description: 'Snapshot work' }],
      },
      instanceId: 'primary',
      load: () => ({
        activate: () => ({
          contributions: {
            tools: [invocationTool('fixture_shutdown_snapshot', 'fixture_shutdown_snapshot@1', { ok: true })],
          },
          close,
        }),
      }),
    });
    await control.activate({ moduleId: 'fixture.shutdown-snapshot', instanceId: 'primary' });
    const snapshot = control.captureRuntimeSnapshot();
    const runtime = requiredInvocationRuntime(snapshot.tools, 'fixture_shutdown_snapshot');

    await control.close();
    await expect(runtime.execute({}, invocationContext())).rejects.toThrow('shutting down');
    snapshot.release();
    snapshot.release();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('aborts an in-flight Tool and waits for it before runtime and module cleanup', async () => {
    let releaseInvocation!: () => void;
    let reportInvocationStarted!: () => void;
    const invocationGate = new Promise<void>((resolve) => { releaseInvocation = resolve; });
    const invocationStarted = new Promise<void>((resolve) => { reportInvocationStarted = resolve; });
    let observedSignal: AbortSignal | undefined;
    const runtimeClose = vi.fn();
    const dispose = vi.fn();
    const control = new CapabilityControlPlane({ shutdownTimeoutMs: 20 });
    control.register({
      manifest: {
        id: 'fixture.shutdown-abort', version: '1.0.0', description: 'Shutdown abort fixture',
        capabilities: [{ id: 'fixture.shutdown-abort.run', description: 'Abortable work' }],
      },
      instanceId: 'primary',
      load: () => ({
        activate: () => ({
          contributions: {
            tools: [invocationToolWithRuntime(
              'fixture_shutdown_abort',
              'fixture_shutdown_abort@1',
              async (_input, context) => {
                  observedSignal = context.signal;
                  reportInvocationStarted();
                  await invocationGate;
                  return { ok: true };
              },
            )],
          },
          close: runtimeClose,
        }),
        dispose,
      }),
    });
    await control.activate({ moduleId: 'fixture.shutdown-abort', instanceId: 'primary' });
    const snapshot = control.captureRuntimeSnapshot();
    const invocation = requiredInvocationRuntime(snapshot.tools, 'fixture_shutdown_abort')
      .execute({}, invocationContext());
    await invocationStarted;
    snapshot.release();

    await expect(control.close()).rejects.toBeInstanceOf(CapabilityShutdownTimeoutError);
    expect(observedSignal?.aborted).toBe(true);
    expect(runtimeClose).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();

    releaseInvocation();
    await invocation;
    await control.close();
    expect(runtimeClose).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('never disposes module-wide resources while a runtime close keeps failing', async () => {
    const runtimeClose = vi.fn(() => {
      throw new Error('persistent runtime close failure');
    });
    const dispose = vi.fn();
    const control = new CapabilityControlPlane();
    control.register({
      manifest: {
        id: 'fixture.persistent-close', version: '1.0.0', description: 'Persistent close fixture',
        capabilities: [{ id: 'fixture.persistent-close.run', description: 'Persistent work' }],
      },
      instanceId: 'primary',
      load: () => ({
        activate: () => ({ contributions: {}, close: runtimeClose }),
        dispose,
      }),
    });
    await control.activate({ moduleId: 'fixture.persistent-close', instanceId: 'primary' });

    await expect(control.close()).rejects.toMatchObject({ name: 'AggregateError' });
    await expect(control.close()).rejects.toMatchObject({ name: 'AggregateError' });

    expect(runtimeClose).toHaveBeenCalledTimes(2);
    expect(dispose).not.toHaveBeenCalled();
    expect(control.snapshot().modules[0]?.lastFailure?.message)
      .toContain('persistent runtime close failure');
  });

  it('disposes a loaded module even when probing never activated a runtime generation', async () => {
    const dispose = vi.fn();
    const control = new CapabilityControlPlane();
    control.register({
      manifest: {
        id: 'fixture.probe-only',
        version: '1.0.0',
        description: 'Probe-only fixture',
        capabilities: [{ id: 'fixture.probe', description: 'Probe fixture' }],
      },
      instanceId: 'primary',
      load: () => ({
        probe: () => ({ status: 'unavailable', reason: 'not configured' }),
        activate: () => ({ contributions: {} }),
        dispose,
      }),
    });

    await expect(control.activate({ moduleId: 'fixture.probe-only', instanceId: 'primary' }))
      .rejects.toThrow();
    await control.close();

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('aborts and diagnoses a hung runtime teardown without starting a concurrent retry', async () => {
    let releaseClose!: () => void;
    const closeRelease = new Promise<void>((resolve) => { releaseClose = resolve; });
    let closeFinished!: () => void;
    const finished = new Promise<void>((resolve) => { closeFinished = resolve; });
    let teardownSignal: AbortSignal | undefined;
    const close = vi.fn(async (context?: { signal: AbortSignal }) => {
      teardownSignal = context?.signal;
      await closeRelease;
      closeFinished();
    });
    const control = new CapabilityControlPlane({
      shutdownTimeoutMs: 100,
      teardownTimeoutMs: 10,
    });
    control.register({
      manifest: {
        id: 'fixture.hung-runtime-close',
        version: '1.0.0',
        description: 'Hung runtime close fixture',
        capabilities: [{ id: 'fixture.hung-runtime', description: 'Hung runtime' }],
      },
      instanceId: 'primary',
      load: () => ({
        activate: () => ({ contributions: {}, close }),
      }),
    });
    await control.activate({ moduleId: 'fixture.hung-runtime-close', instanceId: 'primary' });

    await expect(control.close()).rejects.toMatchObject({ name: 'AggregateError' });
    expect(close).toHaveBeenCalledTimes(1);
    expect(teardownSignal?.aborted).toBe(true);
    expect(control.snapshot()).toMatchObject({ phase: 'draining' });
    expect(control.snapshot().modules[0]).toMatchObject({
      draining: true,
      lastFailure: {
        operation: 'dispose',
      },
    });
    expect(control.snapshot().modules[0]?.lastFailure?.message)
      .toContain('Capability teardown did not settle within');
    expect(control.snapshot().modules[0]?.lastFailure?.message)
      .toContain('fixture.hung-runtime-close (primary)');

    await expect(control.close()).rejects.toMatchObject({ name: 'AggregateError' });
    expect(close).toHaveBeenCalledTimes(1);
    releaseClose();
    await finished;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await expect(control.close()).resolves.toBeUndefined();
    expect(control.snapshot()).toMatchObject({ phase: 'closed' });
  });

  it('keeps a provider alive while its dependent generation has not closed', async () => {
    const closed: string[] = [];
    let releaseConsumer!: () => void;
    let consumerFinished!: () => void;
    const consumerRelease = new Promise<void>((resolve) => { releaseConsumer = resolve; });
    const finished = new Promise<void>((resolve) => { consumerFinished = resolve; });
    const control = new CapabilityControlPlane({ shutdownTimeoutMs: 100, teardownTimeoutMs: 10 });
    control.register({
      manifest: {
        id: 'fixture.close-provider', version: '1.0.0', description: 'Provider',
        capabilities: [{ id: 'fixture.close-base', description: 'Base' }],
      },
      instanceId: 'primary',
      load: () => ({
        activate: () => ({
          contributions: {},
          close: () => { closed.push('provider'); },
        }),
      }),
    });
    control.register({
      manifest: {
        id: 'fixture.close-consumer', version: '1.0.0', description: 'Consumer',
        capabilities: [{ id: 'fixture.close-consumer', description: 'Consumer' }],
        dependencies: [{ capabilityId: 'fixture.close-base' }],
      },
      instanceId: 'primary',
      load: () => ({
        activate: () => ({
          contributions: {},
          close: async () => {
            await consumerRelease;
            closed.push('consumer');
            consumerFinished();
          },
        }),
      }),
    });
    await control.activate({ moduleId: 'fixture.close-consumer', instanceId: 'primary' });

    await expect(control.close()).rejects.toMatchObject({ name: 'AggregateError' });
    expect(closed).toEqual([]);

    releaseConsumer();
    await finished;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await expect(control.close()).resolves.toBeUndefined();
    expect(closed).toEqual(['consumer', 'provider']);
  });

  it('treats lifecycle abort during probe as shutdown, not module failure', async () => {
    let probeStarted!: () => void;
    const started = new Promise<void>((resolve) => { probeStarted = resolve; });
    const control = new CapabilityControlPlane({ shutdownTimeoutMs: 100 });
    control.register({
      manifest: {
        id: 'fixture.cancelled-probe',
        version: '1.0.0',
        description: 'Cancelled probe fixture',
        capabilities: [{ id: 'fixture.cancelled-probe', description: 'Cancelled probe' }],
      },
      instanceId: 'primary',
      load: () => ({
        probe: (context) => new Promise((_resolve, reject) => {
          const abort = () => reject(
            context?.signal.reason instanceof Error
              ? context.signal.reason
              : new Error(String(context?.signal.reason)),
          );
          if (context?.signal.aborted) abort();
          else context?.signal.addEventListener('abort', abort, { once: true });
          probeStarted();
        }),
        activate: () => ({ contributions: {} }),
      }),
    });

    const activation = control.activate({ moduleId: 'fixture.cancelled-probe', instanceId: 'primary' });
    await started;
    const shutdown = control.close();
    await expect(activation).rejects.toThrow();
    await expect(shutdown).resolves.toBeUndefined();

    expect(control.snapshot().modules[0]).toMatchObject({
      status: 'unloaded',
      active: false,
      draining: false,
    });
    expect(control.snapshot().modules[0]?.lastFailure).toBeUndefined();
  });

  it('keeps a host-visible diagnostic when module-level disposal fails', async () => {
    const control = new CapabilityControlPlane();
    control.register({
      manifest: {
        id: 'fixture.dispose-failure',
        version: '1.0.0',
        description: 'Dispose failure fixture',
        capabilities: [{ id: 'fixture.dispose', description: 'Dispose fixture' }],
      },
      instanceId: 'primary',
      load: () => ({
        probe: () => ({ status: 'unavailable', reason: 'probe only' }),
        activate: () => ({ contributions: {} }),
        dispose: () => {
          throw new Error('fixture dispose failed');
        },
      }),
    });
    await expect(control.activate({ moduleId: 'fixture.dispose-failure', instanceId: 'primary' }))
      .rejects.toThrow();

    await expect(control.close()).rejects.toMatchObject({ name: 'AggregateError' });
    expect(control.snapshot().modules[0]?.lastFailure).toEqual({
      operation: 'dispose',
      message: 'fixture dispose failed',
    });
  });
});

function invocationContext(intent = preparedToolIntent().intent) {
  return {
    projectId: 'project-1',
    sessionId: 'session-1',
    runId: 'run-1',
    turnId: 'turn-1',
    invocationId: 'invocation-1',
    idempotencyKey: 'idempotency-1',
    fencingToken: 1,
    authorization: {
      policyMode: 'default' as const, policyDecision: 'allow' as const, policyRevision: 'permission-policy:test', matchedRuleIds: [],
      permission: permissionFacts('capability_tool'),
    },
    discoverableTools: [],
    discoverableCapabilities: [],
    reportProgress: () => undefined,
    hostId: 'host-1', intent, deadline: '2026-09-10T00:01:00.000Z',
    signal: new AbortController().signal,
  };
}

function permissionFacts(toolName: string) {
  return { toolName, dangerLevel: 'safe' as const, readonly: true, access: 'read' as const, recoveryClass: 'read' as const,
    unknownRisk: false, resolvedAddresses: [] as const, targets: [] as const,
    actions: ['read'] as const, paths: [] as const, hosts: [] as const, network: false,
    externalWrite: false, destructive: false, credentials: false, admin: false };
}

function invocationTool(
  name: string,
  handlerRevision: string,
  result: Readonly<Record<string, unknown>>,
) {
  return invocationToolWithRuntime(name, handlerRevision, () => result);
}

function invocationToolWithRuntime(
  name: string,
  handlerRevision: string,
  execute: ToolInvocationHandler,
) {
  const contribution = invocationContribution(name, {}, { toolRevision: handlerRevision, handlerRevision });
  return { definition: contribution.definition, runtime: { ...contribution.runtime, execute } };
}

function requiredInvocationRuntime(snapshot: ToolCatalogSnapshot, name: string) {
  const runtime = resolveInvocationHandler(snapshot, name);
  if (runtime === undefined) throw new Error(`Missing Invocation Handler: ${name}`);
  return runtime;
}

async function invokeSnapshotTool(snapshot: ToolCatalogSnapshot, name: string): Promise<unknown> {
  const intent = preparedToolIntent({ toolName: name }).intent;
  return await requiredInvocationRuntime(snapshot, name).execute({}, invocationContext(intent));
}

async function invokeCurrentTool(registry: ToolRegistry, name: string): Promise<unknown> {
  const snapshot = registry.captureSnapshot();
  try {
    return await invokeSnapshotTool(snapshot, name);
  } finally {
    snapshot.release();
  }
}
