import { describe, expect, it, vi } from 'vitest';
import {
  CapabilityControlPlane,
  createAgentCapabilityServiceToken,
  type AgentCapabilityContextProviderContribution,
  type AgentCapabilityModuleContributions,
  type AgentCapabilityModuleRegistration,
  type ToolCatalogSnapshot,
} from '../src/index.js';
import { invocationContribution } from './fixtures/invocation-contribution.js';
import { preparedToolIntent } from './permission-audit-fixture.js';

const capabilityToolCache = new Map<string, ReturnType<typeof invocationContribution>>();
import { resolveInvocationHandler } from '../src/internal/tool-invocation-authority.js';

describe('Capability contribution transactions', () => {
  it('captures Skill, Prompt, Context Provider and invocation hooks from one module generation', async () => {
    const control = new CapabilityControlPlane();
    const firstClose = vi.fn();
    const firstContext = vi.fn(() => Promise.resolve([{
      id: 'retrieved-context',
      source: 'capability' as const,
      scope: 'turn' as const,
      priority: 10,
      revision: 'context-section-v1',
      cacheability: 'volatile' as const,
      content: [{ type: 'text' as const, text: 'context generation one' }],
      tokenEstimate: 6,
    }]));
    const secondContext = vi.fn(() => Promise.resolve([{
      id: 'retrieved-context',
      source: 'capability' as const,
      scope: 'turn' as const,
      priority: 10,
      revision: 'context-section-v2',
      cacheability: 'volatile' as const,
      content: [{ type: 'text' as const, text: 'context generation two' }],
      tokenEstimate: 6,
    }]));
    control.register({
      manifest: {
        id: 'fixture.complete-snapshot',
        version: '1.0.0',
        description: 'Complete snapshot fixture',
        capabilities: [{ id: 'fixture.complete', description: 'Complete fixture' }],
      },
      instanceId: 'primary',
      load: () => ({
        activate: () => ({
          contributions: completeGeneration('v1', firstContext),
          close: firstClose,
        }),
        refresh: () => ({
          contributions: completeGeneration('v2', secondContext),
        }),
      }),
    });
    await control.activate({ moduleId: 'fixture.complete-snapshot', instanceId: 'primary' });
    const first = control.captureRuntimeSnapshot();

    const refresh = control.refresh({
      moduleId: 'fixture.complete-snapshot',
      instanceId: 'primary',
    });
    await vi.waitFor(() =>
      expect(control.snapshot().revision).toBeGreaterThan(first.capabilities.revision),
    );

    expect(first.skillSources).toMatchObject([{ revision: 'skills-v1' }]);
    expect(first.promptSections).toMatchObject([{ revision: 'prompt-v1' }]);
    expect(first.contextProviders).toMatchObject([{ revision: 'context-v1' }]);
    expect(first.invocationHooks).toMatchObject([{ revision: 'hook-v1' }]);
    await expect(first.contextProviders[0]!.provide({
      projectId: 'project-1',
      sessionId: 'session-1',
      runId: 'run-1',
      turnId: 'turn-1',
      query: 'find relevant context',
      maxTokens: 256,
      signal: new AbortController().signal,
    })).resolves.toMatchObject([{ revision: 'context-section-v1' }]);
    expect(firstClose).not.toHaveBeenCalled();
    first.release();
    await refresh;
    expect(firstClose).toHaveBeenCalledTimes(1);

    const second = control.captureRuntimeSnapshot();
    expect(second.skillSources).toMatchObject([{ revision: 'skills-v2' }]);
    expect(second.promptSections).toMatchObject([{ revision: 'prompt-v2' }]);
    expect(second.contextProviders).toMatchObject([{ revision: 'context-v2' }]);
    expect(second.invocationHooks).toMatchObject([{ revision: 'hook-v2' }]);
    await expect(second.contextProviders[0]!.provide({
      projectId: 'project-1',
      sessionId: 'session-1',
      runId: 'run-1',
      turnId: 'turn-2',
      query: 'find relevant context',
      maxTokens: 256,
      signal: new AbortController().signal,
    })).resolves.toMatchObject([{ revision: 'context-section-v2' }]);
    second.release();
    await control.close();
  });

  it('captures tools, prompt sections and state from one committed generation', async () => {
    const control = new CapabilityControlPlane();
    control.register({
      manifest: {
        id: 'fixture.atomic-view',
        version: '1.0.0',
        description: 'Atomic view fixture',
        capabilities: [{ id: 'fixture.atomic', description: 'Atomic fixture' }],
      },
      instanceId: 'primary',
      load: () => ({
        probe: () => ({ status: 'available' }),
        activate: () => ({
          contributions: {
            tools: [capabilityTool('atomic_read', 'atomic-read@1', { generation: 1 })],
            promptSections: [capabilityPrompt('generation', 'generation one', 'prompt@1')],
            stateReferences: [{ capabilityId: 'fixture.atomic', stateId: 'fixture', version: '1' }],
          },
        }),
        refresh: () => ({
          contributions: {
            tools: [capabilityTool('atomic_read', 'atomic-read@2', { generation: 2 })],
            promptSections: [capabilityPrompt('generation', 'generation two', 'prompt@2')],
            stateReferences: [{ capabilityId: 'fixture.atomic', stateId: 'fixture', version: '2' }],
          },
        }),
      }),
    });
    await control.activate({ moduleId: 'fixture.atomic-view', instanceId: 'primary' });
    const iteration = control.captureRuntimeSnapshot();

    const refresh = control.refresh({ moduleId: 'fixture.atomic-view', instanceId: 'primary' });
    await vi.waitFor(() => expect(control.promptSections()[0]?.revision).toBe('prompt@2'));

    expect(iteration.promptSections[0]?.content).toEqual([
      { type: 'text', text: 'generation one' },
    ]);
    expect(iteration.stateReferences).toMatchObject([{ version: '1' }]);
    expect(iteration.tools.ownerId('atomic_read')).toBe('module:fixture.atomic-view:primary');
    await expect(invokeCapabilityTool(iteration.tools, 'atomic_read')).resolves.toMatchObject({ generation: 1 });
    iteration.release();
    await refresh;

    const next = control.captureRuntimeSnapshot();
    expect(next.promptSections[0]?.content).toEqual([
      { type: 'text', text: 'generation two' },
    ]);
    expect(next.stateReferences).toMatchObject([{ version: '2' }]);
    expect(next.tools.ownerId('atomic_read')).toBe('module:fixture.atomic-view:primary');
    await expect(invokeCapabilityTool(next.tools, 'atomic_read')).resolves.toMatchObject({ generation: 2 });
    next.release();
  });

  it('keeps an unchanged Tool activation revision while swapping its generation lease', async () => {
    const control = new CapabilityControlPlane();
    const stable = capabilityTool('stable_read', 'stable-read@1', { ok: true });
    const runtime = stable.runtime;
    const firstClose = vi.fn();
    control.register({
      manifest: {
        id: 'fixture.stable-tool',
        version: '1.0.0',
        description: 'Stable Tool fixture',
        capabilities: [{ id: 'fixture.stable', description: 'Stable fixture' }],
      },
      instanceId: 'primary',
      load: () => ({
        probe: () => ({ status: 'available' }),
        activate: () => ({
          contributions: {
            tools: [stable],
            stateReferences: [{ capabilityId: 'fixture.stable', stateId: 'fixture', version: '1' }],
          },
          close: firstClose,
        }),
        refresh: () => ({
          contributions: {
            tools: [{
              definition: stable.definition,
              runtime,
            }],
            stateReferences: [{ capabilityId: 'fixture.stable', stateId: 'fixture', version: '2' }],
          },
        }),
      }),
    });
    await control.activate({ moduleId: 'fixture.stable-tool', instanceId: 'primary' });
    const first = control.captureRuntimeSnapshot();
    const firstRevision = first.tools.invocationRevision('stable_read');
    const firstWrappedHandler = resolveInvocationHandler(first.tools, 'stable_read')!.execute;

    const refresh = control.refresh({ moduleId: 'fixture.stable-tool', instanceId: 'primary' });
    await vi.waitFor(() => expect(control.stateReferences()).toMatchObject([{ version: '2' }]));
    const second = control.captureRuntimeSnapshot();

    expect(second.tools.invocationRevision('stable_read')).toBe(firstRevision);
    expect(resolveInvocationHandler(second.tools, 'stable_read')!.execute)
      .not.toBe(firstWrappedHandler);
    expect(firstClose).not.toHaveBeenCalled();
    first.release();
    await refresh;
    expect(firstClose).toHaveBeenCalledTimes(1);
    await expect(invokeCapabilityTool(second.tools, 'stable_read')).resolves.toMatchObject({ ok: true });
    second.release();
    await control.close();
  });

  it('keeps one portable Capability identity across an equivalent runtime refresh', async () => {
    const control = new CapabilityControlPlane();
    const portable = capabilityTool('portable_read', 'portable-read@1', { ok: true });
    const generation = () => ({
      ...completeGeneration('v1', () => Promise.resolve([contextSection('same-context', 1)])),
      tools: [portable],
      stateReferences: [{
        capabilityId: 'database.query',
        stateId: 'fixture-state',
        version: 'state-v1',
      }],
    });
    control.register({
      ...fixtureRegistration('primary', generation()),
      load: () => ({
        probe: () => ({ status: 'available' }),
        activate: () => ({ contributions: generation() }),
        refresh: () => ({ contributions: generation() }),
      }),
    });
    await control.activate({ moduleId: 'fixture.database', instanceId: 'primary' });
    const first = control.captureRuntimeSnapshot();
    const firstIdentity = first.identity;
    expect(firstIdentity?.snapshotId).toMatch(/^capability:[a-f0-9]{64}$/u);
    expect(firstIdentity?.revision).toMatch(/^sha256:[a-f0-9]{64}$/u);
    first.release();

    await control.refresh({ moduleId: 'fixture.database', instanceId: 'primary' });
    const second = control.captureRuntimeSnapshot();
    expect(second.identity).toEqual(firstIdentity);
    second.release();
    await control.close();
  });

  it('changes Capability identity when a declared contribution revision changes', async () => {
    let version: 'v1' | 'v2' = 'v1';
    const control = new CapabilityControlPlane();
    const generation = () => ({
      ...completeGeneration(
        version,
        () => Promise.resolve([contextSection(`context-${version}`, 1)]),
      ),
      tools: [capabilityTool('revisioned_read', `revisioned-read@${version}`, { version })],
      stateReferences: [{
        capabilityId: 'database.query',
        stateId: 'fixture-state',
        version: `state-${version}`,
      }],
    });
    control.register({
      ...fixtureRegistration('primary', generation()),
      load: () => ({
        probe: () => ({ status: 'available' }),
        activate: () => ({ contributions: generation() }),
        refresh: () => ({ contributions: generation() }),
      }),
    });
    await control.activate({ moduleId: 'fixture.database', instanceId: 'primary' });
    const first = control.captureRuntimeSnapshot();
    const firstIdentity = first.identity;
    first.release();

    version = 'v2';
    await control.refresh({ moduleId: 'fixture.database', instanceId: 'primary' });
    const second = control.captureRuntimeSnapshot();
    const secondIdentity = second.identity;
    expect(secondIdentity?.snapshotId).toMatch(/^capability:[a-f0-9]{64}$/u);
    expect(secondIdentity?.revision).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(secondIdentity).not.toEqual(firstIdentity);
    second.release();
    await control.close();
  });

  it('publishes every contribution from one immutable committed generation', async () => {
    const databaseService = createAgentCapabilityServiceToken<{ target: string }>(
      'database.service',
    );
    const control = new CapabilityControlPlane();
    control.register(
      fixtureRegistration('east', {
        promptSections: [capabilityPrompt(
          'database-guidance', 'Use database tools when needed.', 'database-guidance@1',
        )],
        skillSources: [
          {
            id: 'database-skills',
            scope: 'project',
            path: 'C:/project/.schemanaut/skills',
            revision: 'database-skills@1',
          },
        ],
        services: [{ token: databaseService, value: { target: 'east' } }],
        stateReferences: [
          { capabilityId: 'database.query', stateId: 'connection', version: 'connected' },
        ],
      }),
    );
    await control.activate({ moduleId: 'fixture.database', instanceId: 'east' });

    expect(control.promptSections()[0]?.content).toEqual([
      { type: 'text', text: 'Use database tools when needed.' },
    ]);
    expect(control.skillSources()).toEqual([
      {
        id: 'module:fixture.database:east%3Adatabase-skills',
        scope: 'project',
        path: 'C:/project/.schemanaut/skills',
        revision: 'database-skills@1',
      },
    ]);
    const service = control.captureService(databaseService, {
      moduleId: 'fixture.database',
      instanceId: 'east',
    });
    expect(service?.value).toEqual({ target: 'east' });
    service?.release();
    expect(control.stateReferences()).toEqual([
      {
        capabilityId: 'database.query',
        moduleId: 'fixture.database',
        instanceId: 'east',
        stateId: 'connection',
        version: 'connected',
      },
    ]);
    expect(control.snapshot().modules[0]?.contributions).toEqual({
      tools: 0,
      skillSources: 1,
      promptSections: 1,
      contextProviders: 0,
      services: 1,
      stateReferences: 1,
      invocationHooks: 0,
    });

    const sources = control.skillSources();
    expect(Object.isFrozen(sources)).toBe(true);
    expect(Object.isFrozen(sources[0])).toBe(true);
  });

  it('rejects unknown contribution fields at the module boundary', async () => {
    const control = new CapabilityControlPlane();
    const contributions: AgentCapabilityModuleContributions = {};
    Object.assign(contributions, {
      unknownContributionKey: [{ id: 'unsupported' }],
    });
    control.register({
      manifest: {
        id: 'fixture.unknown-contribution',
        version: '1.0.0',
        description: 'Rejects the retired side-effect path.',
        capabilities: [{ id: 'fixture.output', description: 'Fixture output.' }],
      },
      instanceId: 'primary',
      load: () => ({
        activate: () => ({
          contributions,
        }),
      }),
    });

    await expect(control.activate({
      moduleId: 'fixture.unknown-contribution', instanceId: 'primary',
    })).rejects.toThrow('Capability module contributions contain unsupported fields');
  });

  it('keeps equal service tokens isolated by module instance and rejects ambiguous lookup', async () => {
    const databaseService = createAgentCapabilityServiceToken<{ target: string }>(
      'database.service',
    );
    const control = new CapabilityControlPlane();
    for (const instanceId of ['east', 'west']) {
      control.register(
        fixtureRegistration(instanceId, {
          services: [{ token: databaseService, value: { target: instanceId } }],
        }),
      );
      await control.activate({ moduleId: 'fixture.database', instanceId });
    }

    expect(() => control.captureService(databaseService)).toThrow(
      'Capability service is provided by multiple active module instances: database.service',
    );
    const west = control.captureService(databaseService, {
      moduleId: 'fixture.database',
      instanceId: 'west',
    });
    expect(west?.value).toEqual({ target: 'west' });
    west?.release();
  });

  it('keeps a service generation alive until its explicit lease is released', async () => {
    const serviceToken = createAgentCapabilityServiceToken<{ read: () => string }>(
      'fixture.service',
    );
    const close = vi.fn();
    const control = new CapabilityControlPlane();
    control.register({
      ...fixtureRegistration('primary', {}),
      load: () => ({
        activate: () => ({
          contributions: {
            services: [{ token: serviceToken, value: { read: () => 'generation-one' } }],
          },
          close,
        }),
      }),
    });
    await control.activate({ moduleId: 'fixture.database', instanceId: 'primary' });
    const service = control.captureService(serviceToken, {
      moduleId: 'fixture.database',
      instanceId: 'primary',
    });
    expect(service?.value.read()).toBe('generation-one');

    const deactivation = control.deactivate({
      moduleId: 'fixture.database',
      instanceId: 'primary',
    });
    await vi.waitFor(() => expect(control.snapshot().modules[0]?.active).toBe(false));
    expect(control.captureService(serviceToken)).toBeUndefined();
    expect(close).not.toHaveBeenCalled();

    service?.release();
    await deactivation;
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid contribution set before publishing any part of it', async () => {
    const close = vi.fn();
    const control = new CapabilityControlPlane();
    control.register({
      ...fixtureRegistration('primary', {}),
      load: () => ({
        probe: () => ({ status: 'available' }),
        activate: () => ({
          contributions: {
            promptSections: [
              capabilityPrompt('duplicate', 'First', 'duplicate@1'),
              capabilityPrompt('duplicate', 'Second', 'duplicate@2'),
            ],
            stateReferences: [
              { capabilityId: 'undeclared.capability', stateId: 'state', version: '1' },
            ],
          },
          close,
        }),
      }),
    });

    await expect(
      control.activate({ moduleId: 'fixture.database', instanceId: 'primary' }),
    ).rejects.toThrow('Prompt section is declared more than once: duplicate');
    expect(close).toHaveBeenCalledTimes(1);
    expect(control.promptSections()).toEqual([]);
    expect(control.stateReferences()).toEqual([]);
    expect(control.snapshot().modules[0]?.active).toBe(false);
  });

  it('rejects malformed revisioned contributions before publishing the generation', async () => {
    const close = vi.fn();
    const control = new CapabilityControlPlane();
    control.register({
      ...fixtureRegistration('primary', {}),
      load: () => ({
        activate: () => ({
          contributions: {
            promptSections: [{
              id: 'wrong-source',
              source: 'session' as const,
              scope: 'turn' as const,
              priority: 0,
              revision: '1',
              cacheability: 'stable' as const,
              content: [{ type: 'text' as const, text: 'not a capability section' }],
              tokenEstimate: 8,
            }],
          },
          close,
        }),
      }),
    });

    await expect(
      control.activate({ moduleId: 'fixture.database', instanceId: 'primary' }),
    ).rejects.toThrow('Module Prompt section must use capability source');
    expect(close).toHaveBeenCalledTimes(1);
    const snapshot = control.captureRuntimeSnapshot();
    expect(snapshot.promptSections).toEqual([]);
    snapshot.release();
  });

  it('validates and freezes Context Provider output at the capability boundary', async () => {
    const mutableSection = {
      id: 'retrieved-context',
      source: 'capability' as const,
      scope: 'turn' as const,
      priority: 10,
      revision: 'context-section-v1',
      cacheability: 'volatile' as const,
      content: [{ type: 'text' as const, text: 'bounded context' }],
      tokenEstimate: 6,
    };
    const control = new CapabilityControlPlane();
    control.register(fixtureRegistration('primary', {
      contextProviders: [{
        id: 'fixture-context',
        revision: 'context-v1',
        provide: () => Promise.resolve([mutableSection]),
      }],
    }));
    await control.activate({ moduleId: 'fixture.database', instanceId: 'primary' });
    const snapshot = control.captureRuntimeSnapshot();

    const output = await snapshot.contextProviders[0]!.provide(contextRequest(6));
    expect(Object.isFrozen(output)).toBe(true);
    expect(Object.isFrozen(output[0])).toBe(true);
    expect(Object.isFrozen(output[0]!.content)).toBe(true);
    expect(output[0]!.content).toEqual([{ type: 'text', text: 'bounded context' }]);
    mutableSection.content[0]!.text = 'mutated after return';
    expect(output[0]!.content).toEqual([{ type: 'text', text: 'bounded context' }]);

    snapshot.release();
    await control.close();
  });

  it.each([
    {
      name: 'non-array output',
      provide: () => Promise.resolve({} as never),
      expected: 'Context Provider output must be an array',
    },
    {
      name: 'non-capability Prompt section',
      provide: () => Promise.resolve([{
        id: 'wrong-source',
        source: 'session' as const,
        scope: 'turn' as const,
        priority: 0,
        revision: '1',
        cacheability: 'volatile' as const,
        content: [{ type: 'text' as const, text: 'invalid source' }],
        tokenEstimate: 1,
      }]),
      expected: 'Context Provider Prompt section must use capability source',
    },
    {
      name: 'duplicate section identity',
      provide: () => Promise.resolve([
        contextSection('duplicate', 1),
        contextSection('duplicate', 1),
      ]),
      expected: 'Context Provider Prompt section is declared more than once: duplicate',
    },
    {
      name: 'token estimate above the requested budget',
      provide: () => Promise.resolve([contextSection('too-large', 7)]),
      expected: 'Context Provider output exceeds the requested token budget',
    },
  ])('rejects $name returned by a Context Provider', async ({ provide, expected }) => {
    const control = new CapabilityControlPlane();
    control.register(fixtureRegistration('primary', {
      contextProviders: [{ id: 'fixture-context', revision: '1', provide }],
    }));
    await control.activate({ moduleId: 'fixture.database', instanceId: 'primary' });
    const snapshot = control.captureRuntimeSnapshot();

    await expect(snapshot.contextProviders[0]!.provide(contextRequest(6))).rejects.toThrow(expected);

    snapshot.release();
    await control.close();
  });
});

function fixtureRegistration(
  instanceId: string,
  contributions: Record<string, unknown>,
): AgentCapabilityModuleRegistration {
  return {
    manifest: {
      id: 'fixture.database',
      version: '1.0.0',
      description: 'Database fixture',
      capabilities: [{ id: 'database.query', description: 'Query a database' }],
    },
    instanceId,
    load: () => ({
      probe: () => ({ status: 'available' }),
      activate: () => ({ contributions }),
    }),
  };
}

function capabilityTool(name: string, handlerRevision: string, result: Record<string, unknown>) {
  const key = `${name}:${handlerRevision}:${JSON.stringify(result)}`;
  const existing = capabilityToolCache.get(key);
  if (existing !== undefined) return existing;
  const contribution = invocationContribution(name, result as never, { toolRevision: handlerRevision, handlerRevision });
  capabilityToolCache.set(key, contribution);
  return contribution;
}

async function invokeCapabilityTool(snapshot: ToolCatalogSnapshot, name: string): Promise<unknown> {
  const runtime = resolveInvocationHandler(snapshot, name);
  if (runtime === undefined) throw new Error(`Missing Capability Invocation Handler: ${name}`);
  const intent = preparedToolIntent({ toolName: name }).intent;
  return await runtime.execute({}, {
    projectId: 'project-1', sessionId: 'session-1', runId: 'run-1', turnId: 'turn-1',
    invocationId: 'invocation-1', idempotencyKey: 'idempotency-1', fencingToken: 1,
    authorization: {
      policyMode: 'default' as const, policyDecision: 'allow' as const, policyRevision: 'permission-policy:test', matchedRuleIds: [],
      permission: permissionFacts('capability_tool'),
    },
    discoverableTools: [],
    discoverableCapabilities: [],
    reportProgress: () => undefined,
    hostId: 'host-1', intent, deadline: '2026-09-10T00:01:00.000Z',
    signal: new AbortController().signal,
  });
}

function permissionFacts(toolName: string) {
  return { toolName, dangerLevel: 'safe' as const, readonly: true, access: 'read' as const, recoveryClass: 'read' as const,
    unknownRisk: false, resolvedAddresses: [] as const, targets: [] as const, actions: ['read'] as const, paths: [] as const, hosts: [] as const, network: false,
    externalWrite: false, destructive: false, credentials: false, admin: false };
}

function completeGeneration(
  version: 'v1' | 'v2',
  provide: AgentCapabilityContextProviderContribution['provide'],
) {
  return {
    skillSources: [{
      id: 'fixture-skills',
      scope: 'project' as const,
      path: 'C:/project/.schemanaut/skills',
      revision: `skills-${version}`,
    }],
    promptSections: [{
      id: 'fixture-guidance',
      source: 'capability' as const,
      scope: 'turn' as const,
      priority: 20,
      revision: `prompt-${version}`,
      cacheability: 'stable' as const,
      content: [{ type: 'text' as const, text: `prompt generation ${version}` }],
      tokenEstimate: 5,
    }],
    contextProviders: [{
      id: 'fixture-context',
      revision: `context-${version}`,
      provide,
    }],
    invocationHooks: [{
      id: 'fixture-hook',
      revision: `hook-${version}`,
      before: () => undefined,
    }],
  };
}

function contextRequest(maxTokens: number) {
  return {
    projectId: 'project-1',
    sessionId: 'session-1',
    runId: 'run-1',
    turnId: 'turn-1',
    query: 'find relevant context',
    maxTokens,
    signal: new AbortController().signal,
  };
}

function contextSection(id: string, tokenEstimate: number) {
  return {
    id,
    source: 'capability' as const,
    scope: 'turn' as const,
    priority: 0,
    revision: '1',
    cacheability: 'volatile' as const,
    content: [{ type: 'text' as const, text: id }],
    tokenEstimate,
  };
}

function capabilityPrompt(id: string, text: string, revision: string) {
  return {
    id,
    source: 'capability' as const,
    scope: 'turn' as const,
    priority: 10,
    revision,
    cacheability: 'stable' as const,
    content: [{ type: 'text' as const, text }],
    tokenEstimate: Math.max(1, Math.ceil(text.length / 4)),
  };
}
