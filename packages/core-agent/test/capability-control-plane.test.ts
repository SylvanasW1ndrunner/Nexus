import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as agent from '../src/index.js';
import { invocationContribution } from './fixtures/invocation-contribution.js';

describe('CapabilityControlPlane', () => {
  it('re-probes an active module on every explicit activation', async () => {
    let probeCount = 0;
    const control = new agent.CapabilityControlPlane();
    control.register({
      manifest: {
        id: 'fixture.fresh-probe', version: '1.0.0', description: 'Fresh external probe.',
        capabilities: [{ id: 'fixture.fresh-probe', description: 'Probe availability.' }],
      },
      instanceId: 'primary',
      load: () => ({
        probe: () => {
          probeCount += 1;
          return { status: 'available' as const };
        },
        activate: () => ({ contributions: {} }),
      }),
    });

    await control.activate({ moduleId: 'fixture.fresh-probe', instanceId: 'primary' });
    await control.activate({ moduleId: 'fixture.fresh-probe', instanceId: 'primary' });

    expect(probeCount).toBe(2);
  });

  it('activates after an external prerequisite becomes available on a later probe', async () => {
    let prerequisiteReady = false;
    const activate = vi.fn(() => ({ contributions: {} }));
    const control = new agent.CapabilityControlPlane();
    control.register({
      manifest: {
        id: 'fixture.external-prerequisite', version: '1.0.0', description: 'External prerequisite.',
        capabilities: [{ id: 'fixture.external-prerequisite', description: 'External availability.' }],
      },
      instanceId: 'primary',
      load: () => ({
        probe: () => prerequisiteReady
          ? { status: 'available' as const }
          : {
              status: 'unavailable' as const,
              reason: 'Install the external CLI. api_key=sk-secretvalue\0then retry.',
            },
        activate,
      }),
    });

    const unavailable = control.activate({
      moduleId: 'fixture.external-prerequisite', instanceId: 'primary',
    });
    await expect(unavailable).rejects.toThrow('Install the external CLI.');
    await expect(unavailable).rejects.toThrow('Configure the prerequisite outside SchemaNaut');
    await expect(unavailable).rejects.toThrow('sk-secretvalue');
    await expect(unavailable).rejects.not.toThrow('\0');

    prerequisiteReady = true;
    await control.activate({ moduleId: 'fixture.external-prerequisite', instanceId: 'primary' });

    expect(activate).toHaveBeenCalledTimes(1);
    expect(control.snapshot().modules[0]).toMatchObject({ status: 'available', active: true });
  });

  it('bounds thrown probe and activation diagnostics before exposing them', async () => {
    const privatePath = join(homedir(), 'private', 'credentials.json');
    const thrownDiagnostic =
      `External setup failed at ${privatePath}; authorization=Bearer super-secret-token\0retry.`;
    const probeControl = new agent.CapabilityControlPlane();
    probeControl.register({
      manifest: {
        id: 'fixture.thrown-probe', version: '1.0.0', description: 'Thrown probe diagnostic.',
        capabilities: [{ id: 'fixture.thrown-probe', description: 'Probe failure.' }],
      },
      instanceId: 'primary',
      load: () => ({
        probe: () => { throw new Error(thrownDiagnostic); },
        activate: () => ({ contributions: {} }),
      }),
    });

    const probeFailure = await probeControl.activate({
      moduleId: 'fixture.thrown-probe', instanceId: 'primary',
    }).catch((error: unknown) => error);
    expect(probeFailure).toBeInstanceOf(Error);
    const probeSnapshot = probeControl.snapshot().modules[0]!;
    const probeVisible = [
      (probeFailure as Error).message,
      probeSnapshot.reason,
      probeSnapshot.lastFailure?.message,
    ].filter((value): value is string => value !== undefined).join('\n');
    expect(probeVisible).toContain('External setup failed');
    expect(probeVisible).toContain('super-secret-token');
    expect(probeVisible).toContain(homedir());
    expect(probeVisible).not.toContain('\0');

    const activationControl = new agent.CapabilityControlPlane();
    activationControl.register({
      manifest: {
        id: 'fixture.thrown-activation', version: '1.0.0', description: 'Thrown activation diagnostic.',
        capabilities: [{ id: 'fixture.thrown-activation', description: 'Activation failure.' }],
      },
      instanceId: 'primary',
      load: () => ({
        activate: () => { throw new Error(thrownDiagnostic); },
      }),
    });

    const activationFailure = await activationControl.activate({
      moduleId: 'fixture.thrown-activation', instanceId: 'primary',
    }).catch((error: unknown) => error);
    expect(activationFailure).toBeInstanceOf(Error);
    const activationVisible = [
      (activationFailure as Error).message,
      activationControl.snapshot().modules[0]?.lastFailure?.message,
    ].filter((value): value is string => value !== undefined).join('\n');
    expect(activationVisible).toContain('External setup failed');
    expect(activationVisible).toContain('super-secret-token');
    expect(activationVisible).toContain(homedir());
    expect(activationVisible).not.toContain('\0');
  });

  it('reports a bounded shutdown timeout and finishes cleanup after a Context Provider drains', async () => {
    const control = new agent.CapabilityControlPlane({ shutdownTimeoutMs: 20 });
    let releaseProvider!: () => void;
    let reportStarted!: () => void;
    const started = new Promise<void>((resolve) => { reportStarted = resolve; });
    const pending = new Promise<readonly never[]>((resolve) => { releaseProvider = () => resolve([]); });
    const close = vi.fn();
    const dispose = vi.fn();
    control.register({
      manifest: {
        id: 'fixture.retiring-context', version: '1.0.0', description: 'Retiring context fixture.',
        capabilities: [{ id: 'fixture.retiring-context', description: 'Context.' }],
      },
      instanceId: 'primary',
      load: () => ({
        activate: () => ({
          contributions: {
            contextProviders: [{
              id: 'never-settles', revision: '1',
              provide: async () => { reportStarted(); return await pending; },
            }],
          },
          close,
        }),
        dispose,
      }),
    });
    await control.activate({ moduleId: 'fixture.retiring-context', instanceId: 'primary' });
    const snapshot = control.captureRuntimeSnapshot();
    const provider = snapshot.contextProviders[0]!;
    const call = provider.provide({
      projectId: 'project', sessionId: 'session', runId: 'run', turnId: 'turn', query: 'query',
      maxTokens: 10, signal: new AbortController().signal,
    });
    await started;
    snapshot.release();
    await expect(control.close()).rejects.toBeInstanceOf(agent.CapabilityShutdownTimeoutError);
    expect(close).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    releaseProvider();
    await call;
    await control.close();
    expect(close).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid or duplicate static declarations before loading code', () => {
    const control = new agent.CapabilityControlPlane();
    const load = vi.fn(() => ({ activate: () => ({ contributions: {} }) }));

    expect(() =>
      control.register({
        manifest: {
          id: ' ',
          version: '1.0.0',
          description: 'Invalid',
          capabilities: [{ id: 'valid.capability', description: 'Valid' }],
        },
        instanceId: 'primary',
        load,
      }),
    ).toThrow('Module id is required');
    expect(() =>
      control.register({
        manifest: {
          id: 'fixture.duplicate-capability',
          version: '1.0.0',
          description: 'Invalid',
          capabilities: [
            { id: 'fixture.read', description: 'Read' },
            { id: 'fixture.read', description: 'Read again' },
          ],
        },
        instanceId: 'primary',
        load,
      }),
    ).toThrow('Capability is declared more than once: fixture.read');
    expect(() =>
      control.register({
        manifest: {
          id: 'fixture.self-dependent',
          version: '1.0.0',
          description: 'Invalid',
          capabilities: [{ id: 'fixture.read', description: 'Read' }],
          dependencies: [{ capabilityId: 'fixture.read' }],
        },
        instanceId: 'primary',
        load,
      }),
    ).toThrow('Module cannot require its own capability: fixture.read');
    expect(() =>
      control.register({
        manifest: {
          id: 'fixture.empty',
          version: '1.0.0',
          description: 'Invalid',
          capabilities: [],
        },
        instanceId: 'primary',
        load,
      }),
    ).toThrow('Capability module must declare at least one capability');
    expect(() =>
      control.register({
        manifest: {
          id: 'fixture.invalid-loader',
          version: '1.0.0',
          description: 'Invalid',
          capabilities: [{ id: 'fixture.read', description: 'Read' }],
        },
        instanceId: 'primary',
        load: 'not-a-function',
      } as unknown as agent.AgentCapabilityModuleRegistration),
    ).toThrow('Capability module loader must be a function');
    expect(() =>
      control.register({
        manifest: {
          id: 'fixture.invalid-enabled',
          version: '1.0.0',
          description: 'Invalid',
          capabilities: [{ id: 'fixture.read', description: 'Read' }],
        },
        instanceId: 'primary',
        enabled: 'yes',
        load,
      } as unknown as agent.AgentCapabilityModuleRegistration),
    ).toThrow('Capability module registration does not support enabled');

    control.register({
      manifest: {
        id: 'fixture.valid',
        version: '1.0.0',
        description: 'Valid',
        capabilities: [{ id: 'fixture.read', description: 'Read' }],
      },
      instanceId: 'primary',
      load,
    });
    expect(() =>
      control.register({
        manifest: {
          id: 'fixture.valid',
          version: '2.0.0',
          description: 'Duplicate',
          capabilities: [{ id: 'fixture.write', description: 'Write' }],
        },
        instanceId: 'primary',
        load,
      }),
    ).toThrow('Capability module is already registered: fixture.valid');
    expect(load).not.toHaveBeenCalled();
  });

  it('keeps registration unloaded without lifecycle bypass APIs', () => {
    const control = new agent.CapabilityControlPlane();
    const load = vi.fn(() => ({ activate: () => ({ contributions: {} }) }));

    control.register({
      manifest: {
        id: 'fixture.unloaded',
        version: '1.0.0',
        description: 'An explicitly host-activated fixture.',
        capabilities: [{ id: 'fixture.unloaded.read', description: 'Read fixture data.' }],
      },
      instanceId: 'primary',
      load,
    });

    expect(load).not.toHaveBeenCalled();
    expect(control.snapshot().modules).toMatchObject([{
      moduleId: 'fixture.unloaded', active: false, status: 'unloaded',
    }]);
    expect('setEnabled' in control).toBe(false);
    expect('activateForQuery' in control).toBe(false);
    expect('collectOutput' in control).toBe(false);
  });

  it('rejects malformed external provider contracts before mutating availability', async () => {
    const control = new agent.CapabilityControlPlane();

    await expect(
      control.upsertExternalProvider({
        providerId: 'fixture.external',
        description: 'External fixture',
        capabilities: [{ id: 'fixture.external.read', description: 'Read' }],
        status: 'available',
        active: 'yes',
      } as unknown as agent.AgentExternalCapabilityProvider),
    ).rejects.toThrow('External capability provider active must be a boolean');
    expect(control.snapshot().externalProviders).toEqual([]);
  });

  it('discovers static manifest metadata without loading module code', () => {
    const load = vi.fn();
    const control = new agent.CapabilityControlPlane();
    control.register({
      manifest: {
        id: 'schemanaut.database',
        version: '1.0.0',
        description: 'Database access',
        capabilities: [{ id: 'database.query', description: 'Execute database queries' }],
      },
      instanceId: 'primary',
      load,
    });

    expect(load).not.toHaveBeenCalled();
    expect(control.captureDiscoveryManifest()).toEqual([{
      name: 'database.query',
      description: 'Execute database queries',
      status: 'unloaded',
      target: { moduleId: 'schemanaut.database', instanceId: 'primary' },
    }]);
    expect(control.snapshot().modules).toMatchObject([
      {
        moduleId: 'schemanaut.database',
        instanceId: 'primary',
        status: 'unloaded',
        active: false,
      },
    ]);
  });

  it('removes an activated module from later discovery manifests', async () => {
    const control = new agent.CapabilityControlPlane();
    control.register({
      manifest: {
        id: 'fixture.discover-once', version: '1.0.0', description: 'Discover once.',
        capabilities: [{ id: 'fixture.discover-once.read', description: 'Read once.' }],
      },
      instanceId: 'primary',
      load: () => ({ activate: () => ({ contributions: {} }) }),
    });

    await control.activate({ moduleId: 'fixture.discover-once', instanceId: 'primary' });

    expect(control.captureDiscoveryManifest()).toEqual([]);
  });

  it('resolves module and per-capability availability independently', async () => {
    const control = new agent.CapabilityControlPlane();
    control.register({
      manifest: {
        id: 'schemanaut.database',
        version: '1.0.0',
        description: 'Database access',
        capabilities: [
          { id: 'database.query', description: 'Execute database queries' },
          { id: 'database.schema', description: 'Retrieve indexed schema knowledge' },
        ],
      },
      instanceId: 'primary',
      load: () => ({
        probe: () => ({
          status: 'available',
          capabilities: {
            'database.query': { status: 'available' },
            'database.schema': { status: 'degraded', reason: 'index-refreshing' },
          },
        }),
        activate: () => ({ contributions: {} }),
      }),
    });

    await control.activate({ moduleId: 'schemanaut.database', instanceId: 'primary' });

    expect(control.snapshot()).toMatchObject({
      modules: [
        {
          moduleId: 'schemanaut.database',
          instanceId: 'primary',
          status: 'available',
          active: true,
          capabilities: [
            { capabilityId: 'database.query', status: 'available' },
            {
              capabilityId: 'database.schema',
              status: 'degraded',
              reason: 'index-refreshing',
            },
          ],
        },
      ],
      capabilities: [
        { capabilityId: 'database.query', status: 'available' },
        { capabilityId: 'database.schema', status: 'degraded' },
      ],
    });
  });

  it('projects an external adapter provider without pretending it is a Module', async () => {
    const control = new agent.CapabilityControlPlane();
    await control.upsertExternalProvider({
      providerId: 'mcp:warehouse',
      description: 'Warehouse MCP tools',
      capabilities: [{ id: 'mcp.tools', description: 'External MCP tools' }],
      status: 'available',
      active: true,
    });

    expect(control.snapshot()).toMatchObject({
      modules: [],
      externalProviders: [
        {
          providerId: 'mcp:warehouse',
          status: 'available',
          active: true,
          capabilities: [{ capabilityId: 'mcp.tools', status: 'available' }],
        },
      ],
      capabilities: [{ capabilityId: 'mcp.tools', status: 'available' }],
    });
    expect(control.satisfies([{ capabilityId: 'mcp.tools' }], { activeOnly: true })).toBe(true);

    await control.upsertExternalProvider({
      providerId: 'mcp:warehouse',
      description: 'Warehouse MCP tools',
      capabilities: [{ id: 'mcp.tools', description: 'External MCP tools' }],
      status: 'unavailable',
      active: false,
      reason: 'server stopped unexpectedly',
    });
    expect(control.satisfies([{ capabilityId: 'mcp.tools' }])).toBe(false);
    await expect(control.removeExternalProvider('mcp:warehouse')).resolves.toBe(true);
    expect(control.snapshot().externalProviders).toEqual([]);
  });

  it('defers catalog observers until a provider and its tools form one generation', async () => {
    const tools = new agent.ToolRegistry();
    const control = new agent.CapabilityControlPlane({ toolRegistry: tools });
    const observed: Array<{ tools: string[]; available: boolean }> = [];
    tools.subscribe(() => {
      const snapshot = control.captureRuntimeSnapshot();
      try {
        observed.push({
          tools: snapshot.tools.llmTools().map((tool) => tool.name),
          available: snapshot.capabilities.externalProviders.some((provider) =>
            provider.providerId === 'mcp:warehouse' && provider.active,
          ),
        });
      } finally {
        snapshot.release();
      }
    });

    await control.publishExternalProviderGeneration({
      provider: {
        providerId: 'mcp:warehouse', description: 'fixture',
        capabilities: [{ id: 'mcp.tools', description: 'fixture' }], status: 'available', active: true,
      },
      commit: () => tools.replaceOwnerInvocations('mcp:warehouse', [
        capabilityTool('warehouse__list_tables', 'fixture-r1', 'fixture', {}),
      ]),
      rollback: () => tools.replaceOwnerInvocations('mcp:warehouse', []),
    });

    expect(observed).toEqual([{ tools: ['warehouse__list_tables'], available: true }]);

    await control.publishExternalProviderGeneration({
      removeProviderId: 'mcp:warehouse',
      commit: () => tools.replaceOwnerInvocations('mcp:warehouse', []),
      rollback: () => undefined,
    });
    expect(observed.at(-1)).toEqual({ tools: [], available: false });
  });

  it('publishes module state and every contribution before synchronous catalog observers run', async () => {
    const tools = new agent.ToolRegistry();
    const control = new agent.CapabilityControlPlane({ toolRegistry: tools });
    const observed: Array<{
      active: boolean;
      tools: string[];
      prompt: string[];
      skillSources: number;
    }> = [];
    control.register({
      manifest: {
        id: 'fixture.atomic-module', version: '1.0.0', description: 'Atomic module publication.',
        capabilities: [{ id: 'fixture.atomic-module', description: 'Atomic module capability.' }],
      },
      instanceId: 'primary',
      load: () => ({
        activate: () => ({
          contributions: {
            tools: [capabilityTool('fixture_atomic_read', 'fixture-atomic@1', 'Atomic read.', {})],
            skillSources: [{ id: 'fixture-atomic-skills', scope: 'project', path: '/fixture', revision: '1' }],
            promptSections: [promptSection('fixture-atomic-prompt', 'ATOMIC_PROMPT')],
          },
        }),
      }),
    });
    tools.subscribe(() => {
      const snapshot = control.captureRuntimeSnapshot();
      try {
        observed.push({
          active: snapshot.capabilities.modules.some((module) =>
            module.moduleId === 'fixture.atomic-module' && module.active),
          tools: snapshot.tools.llmTools().map((tool) => tool.name),
          prompt: snapshot.promptSections.flatMap((section) => section.content)
            .filter((content) => content.type === 'text').map((content) => content.text),
          skillSources: snapshot.skillSources.length,
        });
      } finally {
        snapshot.release();
      }
    });

    await control.activate({ moduleId: 'fixture.atomic-module', instanceId: 'primary' });
    expect(observed).toEqual([{
      active: true,
      tools: ['fixture_atomic_read'],
      prompt: ['ATOMIC_PROMPT'],
      skillSources: 1,
    }]);

    await control.deactivate({ moduleId: 'fixture.atomic-module', instanceId: 'primary' });
    expect(observed.at(-1)).toEqual({ active: false, tools: [], prompt: [], skillSources: 0 });
  });

  it('owner-qualifies module-local contribution identities in a composite snapshot', async () => {
    const control = new agent.CapabilityControlPlane();
    for (const moduleId of ['fixture.local-alpha', 'fixture.local-beta']) {
      control.register({
        manifest: {
          id: moduleId, version: '1.0.0', description: 'Local identity fixture.',
          capabilities: [{ id: `${moduleId}.read`, description: 'Read.' }],
        },
        instanceId: 'primary',
        load: () => ({ activate: () => ({
          contributions: {
            promptSections: [promptSection('same-local-id', `PROMPT:${moduleId}`)],
            contextProviders: [{
              id: 'same-local-id', revision: '1',
              provide: () => [promptSection('same-result', `CONTEXT:${moduleId}`)],
            }],
            invocationHooks: [{ id: 'same-local-id', revision: '1', before: () => undefined }],
          },
        }) }),
      });
      await control.activate({ moduleId, instanceId: 'primary' });
    }

    const snapshot = control.captureRuntimeSnapshot();
    try {
      expect(new Set(snapshot.promptSections.map((section) => section.id)).size)
        .toBe(snapshot.promptSections.length);
      expect(new Set(snapshot.contextProviders.map((provider) => provider.id)).size)
        .toBe(snapshot.contextProviders.length);
      expect(new Set(snapshot.invocationHooks.map((hook) => hook.id)).size)
        .toBe(snapshot.invocationHooks.length);
      const returned = await Promise.all(snapshot.contextProviders.map(async (provider) => await provider.provide({
        projectId: 'project', sessionId: 'session', runId: 'run', turnId: 'turn', query: 'query',
        maxTokens: 100, signal: new AbortController().signal,
      })));
      expect(new Set(returned.flat().map((section) => section.id)).size).toBe(2);
    } finally {
      snapshot.release();
    }
  });

  it('runs host compensation before deferred catalog observers see a failed publication', async () => {
    const tools = new agent.ToolRegistry();
    const control = new agent.CapabilityControlPlane({ toolRegistry: tools });
    let health = 'starting';
    const observed: Array<{ tools: string[]; provider: boolean; health: string }> = [];
    tools.subscribe(() => {
      const snapshot = control.captureRuntimeSnapshot();
      try {
        observed.push({
          tools: snapshot.tools.llmTools().map((tool) => tool.name),
          provider: snapshot.capabilities.externalProviders.length > 0,
          health,
        });
      } finally {
        snapshot.release();
      }
    });

    await expect(control.publishExternalProviderGeneration({
      provider: {
        providerId: 'mcp:warehouse', description: 'fixture',
        capabilities: [{ id: 'mcp.tools', description: 'fixture' }], status: 'available', active: true,
      },
      commit: () => {
        health = 'healthy';
        tools.replaceOwnerInvocations('mcp:warehouse', [
          capabilityTool('warehouse__list_tables', 'fixture-r1', 'fixture', {}),
        ]);
        throw new Error('finalize failed');
      },
      rollback: () => {
        health = 'starting';
        tools.replaceOwnerInvocations('mcp:warehouse', []);
      },
    })).rejects.toThrow('finalize failed');

    expect(observed).toEqual([]);
    expect(control.snapshot().externalProviders).toEqual([]);
    expect(tools.llmTools()).toEqual([]);
    expect(health).toBe('starting');
  });

  it('restores the provider and raises a fatal publication error when compensation itself fails', async () => {
    const tools = new agent.ToolRegistry();
    const control = new agent.CapabilityControlPlane({ toolRegistry: tools });
    const observed: string[] = [];
    tools.subscribe(() => observed.push('catalog-change'));
    await expect(control.publishExternalProviderGeneration({
      provider: {
        providerId: 'mcp:warehouse', description: 'fixture',
        capabilities: [{ id: 'mcp.tools', description: 'fixture' }], status: 'available', active: true,
      },
      commit: () => { throw new Error('commit failed'); },
      rollback: () => { throw new Error('rollback failed'); },
    })).rejects.toThrow('Capability generation compensation failed');
    expect(observed).toEqual([]);
    expect(() => control.snapshot()).toThrow(agent.CapabilityPublicationPoisonedError);
    await expect(control.publishExternalProviderGeneration({
      provider: {
        providerId: 'mcp:other', description: 'fixture',
        capabilities: [{ id: 'mcp.tools', description: 'fixture' }], status: 'available', active: true,
      },
      commit: () => undefined,
      rollback: () => undefined,
    })).rejects.toThrow(agent.CapabilityPublicationPoisonedError);
  });

  it('activates required capability providers before their dependent module', async () => {
    const order: string[] = [];
    const control = new agent.CapabilityControlPlane();
    control.register({
      manifest: {
        id: 'schemanaut.storage',
        version: '1.0.0',
        description: 'Durable storage',
        capabilities: [{ id: 'storage.sqlite', description: 'SQLite state storage' }],
      },
      instanceId: 'local',
      load: () => ({
        probe: () => ({ status: 'available' }),
        activate: () => {
          order.push('storage');
          return { contributions: {} };
        },
      }),
    });
    control.register({
      manifest: {
        id: 'schemanaut.database',
        version: '1.0.0',
        description: 'Database access',
        capabilities: [{ id: 'database.query', description: 'Execute queries' }],
        dependencies: [{ capabilityId: 'storage.sqlite' }],
      },
      instanceId: 'primary',
      load: () => ({
        probe: () => ({ status: 'available' }),
        activate: () => {
          order.push('database');
          return { contributions: {} };
        },
      }),
    });

    const activate = Reflect.get(control, 'activate') as
      | ((input: { moduleId: string; instanceId: string }) => Promise<unknown>)
      | undefined;
    expect(activate).toBeTypeOf('function');
    await activate!.call(control, {
      moduleId: 'schemanaut.database',
      instanceId: 'primary',
    });

    expect(order).toEqual(['storage', 'database']);
    expect(control.snapshot().modules).toMatchObject([
      { moduleId: 'schemanaut.database', instanceId: 'primary', active: true },
      { moduleId: 'schemanaut.storage', instanceId: 'local', active: true },
    ]);
  });

  it('accepts an active external adapter as a dependency provider', async () => {
    const control = new agent.CapabilityControlPlane();
    await control.upsertExternalProvider({
      providerId: 'mcp:fixture',
      description: 'Fixture external provider',
      capabilities: [{ id: 'fixture.external', description: 'External capability' }],
      status: 'available',
      active: true,
    });
    control.register({
      manifest: {
        id: 'fixture.consumer',
        version: '1.0.0',
        description: 'Consumer',
        capabilities: [{ id: 'fixture.consumer', description: 'Consumer capability' }],
        dependencies: [{ capabilityId: 'fixture.external' }],
      },
      instanceId: 'primary',
      load: () => ({
        probe: () => ({ status: 'available' }),
        activate: () => ({ contributions: {} }),
      }),
    });

    await control.activate({ moduleId: 'fixture.consumer', instanceId: 'primary' });

    expect(control.snapshot().modules[0]).toMatchObject({
      active: true,
      capabilities: [{ capabilityId: 'fixture.consumer', status: 'available' }],
    });
    expect(control.satisfies([{ capabilityId: 'fixture.consumer' }], { activeOnly: true })).toBe(
      true,
    );
  });

  it('rolls back a candidate when its external dependency disappears during activation', async () => {
    let releaseActivation!: () => void;
    let reportActivationStarted!: () => void;
    const activationGate = new Promise<void>((resolve) => {
      releaseActivation = resolve;
    });
    const activationStarted = new Promise<void>((resolve) => {
      reportActivationStarted = resolve;
    });
    const closeCandidate = vi.fn();
    const control = new agent.CapabilityControlPlane();
    await control.upsertExternalProvider({
      providerId: 'mcp:fixture',
      description: 'Fixture external provider',
      capabilities: [{ id: 'fixture.external', description: 'External capability' }],
      status: 'available',
      active: true,
    });
    control.register({
      manifest: {
        id: 'fixture.consumer',
        version: '1.0.0',
        description: 'Consumer',
        capabilities: [{ id: 'fixture.consumer', description: 'Consumer capability' }],
        dependencies: [{ capabilityId: 'fixture.external' }],
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
                capabilityTool(
                  'fixture_racy_consumer',
                  'fixture_racy_consumer@1',
                  'Must never leak after dependency loss.',
                  { ok: true },
                ),
              ],
            },
            close: closeCandidate,
          };
        },
      }),
    });

    const activation = control.activate({ moduleId: 'fixture.consumer', instanceId: 'primary' });
    await activationStarted;
    await control.removeExternalProvider('mcp:fixture');
    releaseActivation();

    await expect(activation).rejects.toThrow(
      'Required capability is unavailable: fixture.external',
    );
    expect(closeCandidate).toHaveBeenCalledTimes(1);
    expect(control.tools.has('fixture_racy_consumer')).toBe(false);
    expect(control.snapshot().modules[0]).toMatchObject({ active: false });
  });

  it('rolls back a refresh candidate when its external dependency disappears in flight', async () => {
    let releaseRefresh!: () => void;
    let reportRefreshStarted!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const refreshStarted = new Promise<void>((resolve) => {
      reportRefreshStarted = resolve;
    });
    const oldClose = vi.fn();
    const candidateClose = vi.fn();
    const control = new agent.CapabilityControlPlane();
    await control.upsertExternalProvider({
      providerId: 'mcp:fixture',
      description: 'Fixture external provider',
      capabilities: [{ id: 'fixture.external', description: 'External capability' }],
      status: 'available',
      active: true,
    });
    control.register({
      manifest: {
        id: 'fixture.refresh-consumer',
        version: '1.0.0',
        description: 'Refresh consumer',
        capabilities: [{ id: 'fixture.consumer', description: 'Consumer capability' }],
        dependencies: [{ capabilityId: 'fixture.external' }],
      },
      instanceId: 'primary',
      load: () => ({
        probe: () => ({ status: 'available' }),
        activate: () => ({
          contributions: {
            tools: [
              capabilityTool(
                'fixture_refresh_consumer',
                'fixture_refresh_consumer@1',
                'Read from the current generation.',
                { generation: 1 },
              ),
            ],
          },
          close: oldClose,
        }),
        refresh: async () => {
          reportRefreshStarted();
          await refreshGate;
          return {
            contributions: {
              tools: [
                capabilityTool(
                  'fixture_refresh_consumer',
                  'fixture_refresh_consumer@2',
                  'Read from the candidate generation.',
                  { generation: 2 },
                ),
              ],
            },
            close: candidateClose,
          };
        },
      }),
    });
    await control.activate({ moduleId: 'fixture.refresh-consumer', instanceId: 'primary' });
    const catalogChanges: string[] = [];
    control.tools.subscribe((event) => catalogChanges.push(event.kind));

    const refresh = control.refresh({
      moduleId: 'fixture.refresh-consumer',
      instanceId: 'primary',
    });
    await refreshStarted;
    const removal = control.removeExternalProvider('mcp:fixture');
    releaseRefresh();

    await expect(refresh).rejects.toThrow('Required capability is unavailable: fixture.external');
    await removal;
    expect(candidateClose).toHaveBeenCalledTimes(1);
    expect(oldClose).toHaveBeenCalledTimes(1);
    expect(catalogChanges).toEqual(['owner-replaced']);
    expect(control.tools.has('fixture_refresh_consumer')).toBe(false);
    expect(control.snapshot().modules[0]).toMatchObject({ active: false });
  });

  it('withdraws dependents before an external capability removal completes', async () => {
    const close = vi.fn();
    const control = new agent.CapabilityControlPlane();
    await control.upsertExternalProvider({
      providerId: 'mcp:fixture',
      description: 'Fixture external provider',
      capabilities: [{ id: 'fixture.external', description: 'External capability' }],
      status: 'available',
      active: true,
    });
    control.register({
      manifest: {
        id: 'fixture.consumer',
        version: '1.0.0',
        description: 'Consumer',
        capabilities: [{ id: 'fixture.consumer', description: 'Consumer capability' }],
        dependencies: [{ capabilityId: 'fixture.external' }],
      },
      instanceId: 'primary',
      load: () => ({
        probe: () => ({ status: 'available' }),
        activate: () => ({
          contributions: {
            tools: [
              capabilityTool(
                'fixture_external_consumer',
                'fixture_external_consumer@1',
                'Consume the external capability.',
                { ok: true },
              ),
            ],
          },
          close,
        }),
      }),
    });
    await control.activate({ moduleId: 'fixture.consumer', instanceId: 'primary' });
    expect(control.tools.has('fixture_external_consumer')).toBe(true);

    await expect(control.removeExternalProvider('mcp:fixture')).resolves.toBe(true);

    expect(control.tools.has('fixture_external_consumer')).toBe(false);
    expect(control.snapshot().modules[0]).toMatchObject({ active: false });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('validates the entire dependency graph before activating any module', async () => {
    const activated: string[] = [];
    const control = new agent.CapabilityControlPlane();
    control.register({
      manifest: {
        id: 'fixture.storage',
        version: '1.0.0',
        description: 'Storage',
        capabilities: [{ id: 'storage.local', description: 'Local storage' }],
      },
      instanceId: 'local',
      load: () => ({
        probe: () => ({ status: 'available' }),
        activate: () => {
          activated.push('storage');
          return { contributions: {} };
        },
      }),
    });
    control.register({
      manifest: {
        id: 'fixture.consumer',
        version: '1.0.0',
        description: 'Consumer',
        capabilities: [{ id: 'consumer.run', description: 'Run' }],
        dependencies: [{ capabilityId: 'storage.local' }, { capabilityId: 'missing.capability' }],
      },
      instanceId: 'primary',
      load: () => ({
        probe: () => ({ status: 'available' }),
        activate: () => {
          activated.push('consumer');
          return { contributions: {} };
        },
      }),
    });

    await expect(
      control.activate({ moduleId: 'fixture.consumer', instanceId: 'primary' }),
    ).rejects.toThrow('Required capability is unavailable: missing.capability');
    expect(activated).toEqual([]);
    expect(control.snapshot().modules.every((module) => !module.active)).toBe(true);
    expect(
      control
        .snapshot()
        .capabilities.find((capability) => capability.capabilityId === 'consumer.run'),
    ).toEqual({ capabilityId: 'consumer.run', status: 'unavailable' });
  });

  it('rejects dependency cycles before activating either participant', async () => {
    const activated: string[] = [];
    const control = new agent.CapabilityControlPlane();
    control.register({
      manifest: {
        id: 'fixture.a',
        version: '1.0.0',
        description: 'A',
        capabilities: [{ id: 'fixture.a.run', description: 'A' }],
        dependencies: [{ capabilityId: 'fixture.b.run' }],
      },
      instanceId: 'one',
      load: () => ({
        probe: () => ({ status: 'available' }),
        activate: () => {
          activated.push('a');
          return { contributions: {} };
        },
      }),
    });
    control.register({
      manifest: {
        id: 'fixture.b',
        version: '1.0.0',
        description: 'B',
        capabilities: [{ id: 'fixture.b.run', description: 'B' }],
        dependencies: [{ capabilityId: 'fixture.a.run' }],
      },
      instanceId: 'one',
      load: () => ({
        probe: () => ({ status: 'available' }),
        activate: () => {
          activated.push('b');
          return { contributions: {} };
        },
      }),
    });

    await expect(control.activate({ moduleId: 'fixture.a', instanceId: 'one' })).rejects.toThrow(
      'Capability dependency cycle',
    );
    expect(activated).toEqual([]);
  });

  it('keeps separate state for multiple instances of one module', async () => {
    const counts = new Map<string, number>();
    const control = new agent.CapabilityControlPlane();
    for (const instanceId of ['east', 'west']) {
      control.register({
        manifest: {
          id: 'fixture.database',
          version: '1.0.0',
          description: 'Database',
          capabilities: [{ id: 'database.query', description: 'Query' }],
        },
        instanceId,
        load: () => ({
          probe: () => ({ status: 'available' }),
          activate: () => {
            counts.set(instanceId, (counts.get(instanceId) ?? 0) + 1);
            return { contributions: {} };
          },
        }),
      });
    }

    await control.activate({ moduleId: 'fixture.database', instanceId: 'east' });
    expect(counts).toEqual(new Map([['east', 1]]));
    expect(control.snapshot().modules).toMatchObject([
      { instanceId: 'east', active: true },
      { instanceId: 'west', active: false },
    ]);
  });

  it('coalesces concurrent load and activation for one module instance', async () => {
    let releaseActivation!: () => void;
    const activationGate = new Promise<void>((resolve) => {
      releaseActivation = resolve;
    });
    const activateModule = vi.fn(async () => {
      await activationGate;
      return { contributions: {} };
    });
    const load = vi.fn(() => ({
      probe: () => ({ status: 'available' as const }),
      activate: activateModule,
    }));
    const control = new agent.CapabilityControlPlane();
    control.register({
      manifest: {
        id: 'schemanaut.database',
        version: '1.0.0',
        description: 'Database access',
        capabilities: [{ id: 'database.query', description: 'Execute queries' }],
      },
      instanceId: 'primary',
      load,
    });

    const first = control.activate({
      moduleId: 'schemanaut.database',
      instanceId: 'primary',
    });
    const second = control.activate({
      moduleId: 'schemanaut.database',
      instanceId: 'primary',
    });
    await vi.waitFor(() => expect(activateModule).toHaveBeenCalledTimes(1));
    releaseActivation();
    await Promise.all([first, second]);

    expect(load).toHaveBeenCalledTimes(1);
    expect(activateModule).toHaveBeenCalledTimes(1);
    expect(control.snapshot().modules[0]?.active).toBe(true);
  });

  it('isolates loader failures and can recover availability on a later resolve', async () => {
    let attempts = 0;
    const control = new agent.CapabilityControlPlane();
    control.register({
      manifest: {
        id: 'fixture.flaky',
        version: '1.0.0',
        description: 'Flaky fixture',
        capabilities: [{ id: 'fixture.flaky.run', description: 'Run' }],
      },
      instanceId: 'primary',
      load: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary loader failure');
        return { probe: () => ({ status: 'available' }), activate: () => ({ contributions: {} }) };
      },
    });
    control.register({
      manifest: {
        id: 'fixture.healthy',
        version: '1.0.0',
        description: 'Healthy fixture',
        capabilities: [{ id: 'fixture.healthy.run', description: 'Run' }],
      },
      instanceId: 'primary',
      load: () => ({
        probe: () => ({ status: 'available' }),
        activate: () => ({ contributions: {} }),
      }),
    });

    await expect(control.activate({
      moduleId: 'fixture.flaky', instanceId: 'primary',
    })).rejects.toThrow('Capability module is not available');
    await control.activate({ moduleId: 'fixture.healthy', instanceId: 'primary' });
    expect(control.snapshot().modules).toMatchObject([
      { moduleId: 'fixture.flaky', status: 'unavailable', reason: 'temporary loader failure' },
      { moduleId: 'fixture.healthy', status: 'available' },
    ]);

    await control.activate({ moduleId: 'fixture.flaky', instanceId: 'primary' });
    expect(control.snapshot().modules[0]).toMatchObject({
      moduleId: 'fixture.flaky',
      status: 'available',
    });
    expect(attempts).toBe(2);
  });

  it('publishes a deeply immutable snapshot detached from caller-owned manifest objects', () => {
    const manifest = {
      id: 'schemanaut.database',
      version: '1.0.0',
      description: 'Database access',
      capabilities: [{ id: 'database.query', description: 'Execute queries' }],
    };
    const control = new agent.CapabilityControlPlane();
    control.register({
      manifest,
      instanceId: 'primary',
      load: () => ({ activate: () => ({ contributions: {} }) }),
    });
    manifest.id = 'caller-mutated';
    manifest.capabilities[0]!.id = 'caller-mutated.query';

    const snapshot = control.snapshot();
    expect(snapshot.modules[0]).toMatchObject({
      moduleId: 'schemanaut.database',
      version: '1.0.0',
      capabilities: [{ capabilityId: 'database.query' }],
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.modules)).toBe(true);
    expect(Object.isFrozen(snapshot.modules[0]?.capabilities)).toBe(true);
    expect(() => {
      (snapshot.modules as unknown[]).push({});
    }).toThrow(TypeError);
    expect(() => {
      (snapshot.modules[0]!.capabilities[0] as { status: string }).status = 'available';
    }).toThrow(TypeError);
  });

  it('answers generic capability requirements without assigning business semantics', async () => {
    const control = new agent.CapabilityControlPlane();
    control.register({
      manifest: {
        id: 'fixture.provider',
        version: '1.0.0',
        description: 'Generic provider',
        capabilities: [
          { id: 'any.domain.read', description: 'Read an arbitrary domain' },
          { id: 'any.domain.write', description: 'Write an arbitrary domain' },
        ],
      },
      instanceId: 'primary',
      load: () => ({
        probe: () => ({
          status: 'available',
          capabilities: {
            'any.domain.read': { status: 'available' },
            'any.domain.write': { status: 'unavailable', reason: 'not configured' },
          },
        }),
        activate: () => ({ contributions: {} }),
      }),
    });

    expect(control.satisfies([{ capabilityId: 'any.domain.read' }])).toBe(false);
    await control.activate({ moduleId: 'fixture.provider', instanceId: 'primary' });
    expect(control.satisfies([{ capabilityId: 'any.domain.read' }])).toBe(true);
    expect(control.satisfies([{ capabilityId: 'any.domain.write' }])).toBe(false);
    expect(control.satisfies([{ capabilityId: 'missing.domain' }])).toBe(false);
  });

  it('deactivates active dependents before their only capability provider', async () => {
    const closed: string[] = [];
    const control = new agent.CapabilityControlPlane();
    control.register({
      manifest: {
        id: 'fixture.provider',
        version: '1.0.0',
        description: 'Provider',
        capabilities: [{ id: 'fixture.base', description: 'Base capability' }],
      },
      instanceId: 'only',
      load: () => ({
        probe: () => ({ status: 'available' }),
        activate: () => ({
          contributions: {},
          close: () => {
            closed.push('provider');
          },
        }),
      }),
    });
    control.register({
      manifest: {
        id: 'fixture.consumer',
        version: '1.0.0',
        description: 'Consumer',
        capabilities: [{ id: 'fixture.consumer', description: 'Consumer capability' }],
        dependencies: [{ capabilityId: 'fixture.base' }],
      },
      instanceId: 'primary',
      load: () => ({
        probe: () => ({ status: 'available' }),
        activate: () => ({
          contributions: {},
          close: () => {
            closed.push('consumer');
          },
        }),
      }),
    });
    await control.activate({ moduleId: 'fixture.consumer', instanceId: 'primary' });

    await control.deactivate({ moduleId: 'fixture.provider', instanceId: 'only' });

    expect(closed).toEqual(['consumer', 'provider']);
    expect(control.snapshot().modules).toMatchObject([
      { moduleId: 'fixture.consumer', active: false },
      { moduleId: 'fixture.provider', active: false },
    ]);
  });

  it('keeps an active dependent running when an alternate active provider remains', async () => {
    const closed: string[] = [];
    const control = new agent.CapabilityControlPlane();
    const provider = (instanceId: string) => ({
      manifest: {
        id: 'fixture.provider',
        version: '1.0.0',
        description: 'Provider',
        capabilities: [{ id: 'fixture.base', description: 'Base capability' }],
      },
      instanceId,
      load: () => ({
        probe: () => ({ status: 'available' as const }),
        activate: () => ({
          contributions: {},
          close: () => {
            closed.push(`provider:${instanceId}`);
          },
        }),
      }),
    });
    control.register(provider('alpha'));
    control.register(provider('beta'));
    control.register({
      manifest: {
        id: 'fixture.consumer',
        version: '1.0.0',
        description: 'Consumer',
        capabilities: [{ id: 'fixture.consumer', description: 'Consumer capability' }],
        dependencies: [{ capabilityId: 'fixture.base' }],
      },
      instanceId: 'primary',
      load: () => ({
        probe: () => ({ status: 'available' }),
        activate: () => ({
          contributions: {},
          close: () => {
            closed.push('consumer');
          },
        }),
      }),
    });
    await control.activate({ moduleId: 'fixture.provider', instanceId: 'alpha' });
    await control.activate({ moduleId: 'fixture.provider', instanceId: 'beta' });
    await control.activate({ moduleId: 'fixture.consumer', instanceId: 'primary' });

    await control.deactivate({ moduleId: 'fixture.provider', instanceId: 'alpha' });

    expect(closed).toEqual(['provider:alpha']);
    expect(control.snapshot().modules).toMatchObject([
      { moduleId: 'fixture.consumer', active: true },
      { moduleId: 'fixture.provider', instanceId: 'alpha', active: false },
      { moduleId: 'fixture.provider', instanceId: 'beta', active: true },
    ]);
  });

  it('closes a dependent before a replacement provider activated after it', async () => {
    const closed: string[] = [];
    const control = new agent.CapabilityControlPlane();
    const provider = (instanceId: string) => ({
      manifest: {
        id: 'fixture.shutdown-provider',
        version: '1.0.0',
        description: 'Shutdown provider',
        capabilities: [{ id: 'fixture.shutdown-base', description: 'Base capability' }],
      },
      instanceId,
      load: () => ({
        probe: () => ({ status: 'available' as const }),
        activate: () => ({
          contributions: {},
          close: () => { closed.push(`provider:${instanceId}`); },
        }),
      }),
    });
    control.register(provider('alpha'));
    control.register(provider('beta'));
    control.register({
      manifest: {
        id: 'fixture.shutdown-consumer',
        version: '1.0.0',
        description: 'Shutdown consumer',
        capabilities: [{ id: 'fixture.shutdown-consumer', description: 'Consumer' }],
        dependencies: [{ capabilityId: 'fixture.shutdown-base' }],
      },
      instanceId: 'primary',
      load: () => ({
        probe: () => ({ status: 'available' as const }),
        activate: () => ({
          contributions: {},
          close: () => { closed.push('consumer'); },
        }),
      }),
    });

    await control.activate({ moduleId: 'fixture.shutdown-provider', instanceId: 'alpha' });
    await control.activate({ moduleId: 'fixture.shutdown-consumer', instanceId: 'primary' });
    await control.activate({ moduleId: 'fixture.shutdown-provider', instanceId: 'beta' });
    await control.deactivate({ moduleId: 'fixture.shutdown-provider', instanceId: 'alpha' });
    await control.close();

    expect(closed).toEqual(['provider:alpha', 'consumer', 'provider:beta']);
  });

  it('withdraws active contributions when a later availability probe becomes unavailable', async () => {
    let available = true;
    const closed: string[] = [];
    const control = new agent.CapabilityControlPlane();
    control.register({
      manifest: {
        id: 'fixture.provider',
        version: '1.0.0',
        description: 'Provider',
        capabilities: [{ id: 'fixture.base', description: 'Base capability' }],
      },
      instanceId: 'primary',
      load: () => ({
        probe: () => ({
          status: available ? ('available' as const) : ('unavailable' as const),
          ...(available ? {} : { reason: 'dependency offline' }),
        }),
        activate: () => ({
          contributions: { promptSections: [promptSection('base', 'Base guidance.')] },
          close: () => {
            closed.push('provider');
          },
        }),
      }),
    });
    control.register({
      manifest: {
        id: 'fixture.consumer',
        version: '1.0.0',
        description: 'Consumer',
        capabilities: [{ id: 'fixture.consumer', description: 'Consumer capability' }],
        dependencies: [{ capabilityId: 'fixture.base' }],
      },
      instanceId: 'primary',
      load: () => ({
        probe: () => ({ status: 'available' }),
        activate: () => ({
          contributions: { promptSections: [promptSection('consumer', 'Consumer guidance.')] },
          close: () => {
            closed.push('consumer');
          },
        }),
      }),
    });
    await control.activate({ moduleId: 'fixture.consumer', instanceId: 'primary' });
    expect(control.promptSections().map(({ content }) => content)).toEqual([
      [{ type: 'text', text: 'Base guidance.' }],
      [{ type: 'text', text: 'Consumer guidance.' }],
    ]);

    available = false;
    await expect(control.refresh({ moduleId: 'fixture.provider', instanceId: 'primary' }))
      .rejects.toThrow('Capability module is not available');

    expect(closed).toEqual(['consumer', 'provider']);
    expect(control.promptSections()).toEqual([]);
    expect(control.snapshot().modules).toMatchObject([
      { moduleId: 'fixture.consumer', active: false },
      { moduleId: 'fixture.provider', status: 'unavailable', active: false },
    ]);
  });

  it('keeps a dependent active when one unhealthy provider has an active replacement', async () => {
    let alphaAvailable = true;
    const closed: string[] = [];
    const control = new agent.CapabilityControlPlane();
    for (const instanceId of ['alpha', 'beta']) {
      control.register({
        manifest: {
          id: 'fixture.provider',
          version: '1.0.0',
          description: 'Provider',
          capabilities: [{ id: 'fixture.base', description: 'Base capability' }],
        },
        instanceId,
        load: () => ({
          probe: () => ({
            status:
              instanceId === 'alpha' && !alphaAvailable
                ? ('unavailable' as const)
                : ('available' as const),
          }),
          activate: () => ({
            contributions: {},
            close: () => {
              closed.push(`provider:${instanceId}`);
            },
          }),
        }),
      });
    }
    control.register({
      manifest: {
        id: 'fixture.consumer',
        version: '1.0.0',
        description: 'Consumer',
        capabilities: [{ id: 'fixture.consumer', description: 'Consumer capability' }],
        dependencies: [{ capabilityId: 'fixture.base' }],
      },
      instanceId: 'primary',
      load: () => ({
        probe: () => ({ status: 'available' }),
        activate: () => ({
          contributions: {},
          close: () => {
            closed.push('consumer');
          },
        }),
      }),
    });
    await control.activate({ moduleId: 'fixture.provider', instanceId: 'alpha' });
    await control.activate({ moduleId: 'fixture.provider', instanceId: 'beta' });
    await control.activate({ moduleId: 'fixture.consumer', instanceId: 'primary' });

    alphaAvailable = false;
    await expect(control.refresh({ moduleId: 'fixture.provider', instanceId: 'alpha' }))
      .rejects.toThrow('Capability module is not available');

    expect(closed).toEqual(['provider:alpha']);
    expect(control.snapshot().modules).toMatchObject([
      { moduleId: 'fixture.consumer', active: true },
      { moduleId: 'fixture.provider', instanceId: 'alpha', active: false },
      { moduleId: 'fixture.provider', instanceId: 'beta', active: true },
    ]);
  });

});

function capabilityTool(
  name: string,
  handlerRevision: string,
  description: string,
  result: Readonly<Record<string, unknown>>,
) {
  const contribution = invocationContribution(name, result as never, {
    toolRevision: handlerRevision,
    handlerRevision,
    exposure: 'direct',
  });
  return {
    ...contribution,
    definition: { ...contribution.definition, description },
  };
}

function promptSection(id: string, text: string) {
  return {
    id,
    source: 'capability' as const,
    scope: 'turn' as const,
    priority: 10,
    revision: `${id}@1`,
    cacheability: 'stable' as const,
    content: [{ type: 'text' as const, text }],
    tokenEstimate: Math.max(1, Math.ceil(text.length / 4)),
  };
}
