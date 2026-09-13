import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CapabilityControlPlane, ToolRegistry } from '@dbagent/core-agent';
import type { PortableValue } from '@dbagent/shared';
import { resolveInvocationHandler } from '../../core-agent/dist/internal/tool-invocation-authority.js';
import {
  createStdioMcpRuntimeLauncher,
  McpConfigStore,
  McpHealthManager,
  type McpHealthManagerOptions,
  type McpRuntimeAvailabilityEvent,
  type McpRuntimeExitEvent,
  type McpRuntimeGenerationPublication,
  McpRuntimeManager,
  McpToolRegistrationManager,
  type McpRuntimeClient,
  type McpRuntimeLauncher,
  type McpToolSpec,
} from '../src/index.js';

const tempDirs: string[] = [];
const FIXTURE_SERVER = fileURLToPath(new URL('./fixtures/mcp-fixture-server.mjs', import.meta.url));

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('McpRuntimeManager', () => {
  it('starts an enabled MCP server, lists tools, registers Invocation Handlers and invokes them', async () => {
    const harness = await runtimeHarness();

    await harness.store.upsert({
      id: 'warehouse',
      name: 'Warehouse Tools',
      command: 'node',
      enabled: true,
      autoStart: true,
    });

    const result = await harness.runtime.start('warehouse');

    expect(result.tools).toEqual(['warehouse__list_tables']);
    expect(result.descriptor).toMatchObject({
      serverId: 'warehouse',
      capabilities: { tools: { listChanged: true } },
    });
    expect(result.health.status).toBe('healthy');
    expect(harness.availabilityEvents).toEqual([{ serverId: 'warehouse', status: 'ready' }]);
    expect(harness.runtime.isRunning('warehouse')).toBe(true);
    await expect(harness.runtime.ping('warehouse')).resolves.toBeUndefined();
    await expect(harness.runtime.listResources('warehouse')).resolves.toEqual([]);
    await expect(harness.runtime.listResourceTemplates('warehouse')).resolves.toEqual([]);
    await expect(harness.runtime.readResource('warehouse', 'fixture://empty')).resolves.toEqual({
      contents: [],
    });
    await expect(harness.runtime.listPrompts('warehouse')).resolves.toEqual([]);
    await expect(harness.runtime.getPrompt('warehouse', 'empty')).resolves.toEqual({
      messages: [],
    });
    const toolResult = await invokeRegistered(harness.registry, 'warehouse__list_tables', {
      schema: 'public',
    });
    expect(toolResult).toMatchObject({ externalPayload: {
      toolName: 'list_tables',
      args: { schema: 'public' },
    } });
  });

  it('publishes remote transport network and host permission facts', async () => {
    const harness = await runtimeHarness();
    await harness.store.upsert({
      id: 'warehouse',
      name: 'Warehouse Tools',
      transport: 'streamable-http',
      url: 'https://MCP.Example.com/v1/tools',
      enabled: true,
      autoStart: false,
    });

    await harness.runtime.start('warehouse');

    expect(harness.registry.get('warehouse__list_tables')?.descriptor.permission).toMatchObject({
      network: true,
      hosts: ['mcp.example.com'],
    });
  });

  it('coalesces concurrent starts and keeps repeated starts idempotent', async () => {
    const harness = await runtimeHarness();
    await harness.store.upsert({
      id: 'warehouse',
      name: 'Warehouse Tools',
      command: 'node',
    });

    const first = harness.runtime.start('warehouse');
    const second = harness.runtime.start('warehouse');
    const [firstResult, secondResult] = await Promise.all([first, second]);
    const repeated = await harness.runtime.start('warehouse');

    expect(second).toBe(first);
    expect(secondResult).toEqual(firstResult);
    expect(repeated.tools).toEqual(['warehouse__list_tables']);
    expect(harness.launchedServers).toEqual(['warehouse']);
    expect(harness.stoppedClients).toEqual([]);
  });

  it('does not report startup complete before availability consumers commit the provider state', async () => {
    let releaseAvailability!: () => void;
    const availabilityGate = new Promise<void>((resolve) => {
      releaseAvailability = resolve;
    });
    let availabilityEntered = false;
    const harness = await runtimeHarness({
      async onPublicationEvent(event) {
        if (event.status !== 'ready') return;
        availabilityEntered = true;
        await availabilityGate;
      },
    });
    await harness.store.upsert({
      id: 'warehouse',
      name: 'Warehouse Tools',
      command: 'node',
    });

    let settled = false;
    const started = harness.runtime.start('warehouse').finally(() => {
      settled = true;
    });
    await waitFor(() => availabilityEntered);

    expect(settled).toBe(false);
    expect(harness.availabilityEvents).toEqual([{ serverId: 'warehouse', status: 'ready' }]);
    expect(harness.registry.llmTools()).toEqual([]);

    releaseAvailability();
    await expect(started).resolves.toMatchObject({
      tools: ['warehouse__list_tables'],
      health: { status: 'healthy' },
    });
    expect(settled).toBe(true);
  });

  it('publishes MCP catalog and capability snapshots as one generation for start, refresh, stop, and exit', async () => {
    const registry = new ToolRegistry();
    const control = new CapabilityControlPlane({ toolRegistry: registry });
    let releaseGate: (() => void) | undefined;
    let enteredGate: (() => void) | undefined;
    let gate: Promise<void> | undefined;
    const blockNextPublication = () => {
      gate = new Promise<void>((resolve) => { releaseGate = resolve; });
      return new Promise<void>((resolve) => { enteredGate = resolve; });
    };
    const harness = await runtimeHarness({
      registry,
      async onGenerationPublished(publication) {
        if (gate) {
          enteredGate?.();
          await gate;
          gate = undefined;
        }
        const providerId = `mcp:${publication.event.serverId}`;
        await control.publishExternalProviderGeneration(
          publication.event.status === 'stopped'
            ? { removeProviderId: providerId, commit: publication.commit, rollback: publication.rollback }
            : {
                provider: {
                  providerId,
                  description: 'fixture MCP tools',
                  capabilities: [{ id: 'mcp.tools', description: 'fixture' }],
                  status: publication.event.status === 'ready' ? 'available' : 'unavailable',
                  active: publication.event.status === 'ready',
                },
                commit: publication.commit,
                rollback: publication.rollback,
              },
        );
      },
    });
    await harness.store.upsert({ id: 'warehouse', name: 'Warehouse Tools', command: 'node' });

    let entered = blockNextPublication();
    const started = harness.runtime.start('warehouse');
    await entered;
    assertGeneration(control, [], false);
    expect(harness.runtime.health('warehouse').status).toBe('starting');
    releaseGate?.();
    await started;
    assertGeneration(control, ['warehouse__list_tables'], true);
    expect(harness.runtime.health('warehouse').status).toBe('healthy');

    entered = blockNextPublication();
    harness.emitToolsChanged('warehouse', [{ name: 'inspect_query', inputSchema: { type: 'object', properties: {} } }]);
    await entered;
    assertGeneration(control, ['warehouse__list_tables'], true);
    expect(harness.runtime.health('warehouse').status).toBe('healthy');
    releaseGate?.();
    await waitFor(() => registry.has('warehouse__inspect_query'));
    assertGeneration(control, ['warehouse__inspect_query'], true);

    entered = blockNextPublication();
    const stopped = harness.runtime.stop('warehouse');
    await entered;
    assertGeneration(control, ['warehouse__inspect_query'], true);
    expect(harness.runtime.health('warehouse').status).toBe('healthy');
    releaseGate?.();
    await stopped;
    assertGeneration(control, [], false);

    await harness.runtime.start('warehouse');
    entered = blockNextPublication();
    const exited = harness.runtime.recordExit('warehouse', { code: 1 });
    await entered;
    assertGeneration(control, ['warehouse__list_tables'], true);
    expect(harness.runtime.health('warehouse').status).toBe('healthy');
    releaseGate?.();
    await exited;
    assertGeneration(control, [], false);
  });

  it('fails startup without publishing tools when the client exits during subscription setup', async () => {
    const harness = await runtimeHarness({
      exitOnSubscribe: { code: 1, errorMessage: 'fixture exited during startup' },
    });
    await harness.store.upsert({ id: 'warehouse', name: 'Warehouse Tools', command: 'node' });

    const started = await harness.runtime.start('warehouse');

    expect(started.tools).toEqual([]);
    expect(started.health).toMatchObject({
      status: 'unhealthy',
      healthy: false,
      lastError: 'fixture exited during startup',
    });
    expect(harness.runtime.isRunning('warehouse')).toBe(false);
    expect(harness.registry.llmTools()).toEqual([]);
    expect(harness.availabilityEvents.at(-1)).toEqual({
      serverId: 'warehouse',
      status: 'unavailable',
      reason: 'fixture exited during startup',
    });
  });

  it('atomically retracts a just-published candidate that exits before startup completes', async () => {
    const registry = new ToolRegistry();
    const control = new CapabilityControlPlane({ toolRegistry: registry });
    const emitExit = (serverId: string, event: McpRuntimeExitEvent): void => {
      harness.emitExit(serverId, event);
    };
    const harness = await runtimeHarness({
      registry,
      async onGenerationPublished(publication) {
        const providerId = `mcp:${publication.event.serverId}`;
        await control.publishExternalProviderGeneration({
          provider: {
            providerId,
            description: 'fixture',
            capabilities: [{ id: 'mcp.tools', description: 'fixture' }],
            status: publication.event.status === 'ready' ? 'available' : 'unavailable',
            active: publication.event.status === 'ready',
          },
          commit: publication.commit,
          rollback: publication.rollback,
        });
        if (publication.event.status === 'ready') {
          emitExit(publication.event.serverId, { code: 1, errorMessage: 'candidate exited' });
        }
      },
    });
    await harness.store.upsert({ id: 'warehouse', name: 'Warehouse Tools', command: 'node' });

    await expect(harness.runtime.start('warehouse')).resolves.toMatchObject({
      tools: [], health: { status: 'unhealthy' },
    });
    assertGeneration(control, [], false);
    expect(harness.registry.llmTools()).toEqual([]);
    expect(harness.runtime.isRunning('warehouse')).toBe(false);
    expect(harness.availabilityEvents.map((event) => event.status)).toEqual(['ready', 'unavailable']);
  });

  it('rolls back a prepared startup generation when ready publication fails', async () => {
    const harness = await runtimeHarness({
      onPublicationEvent(event) {
        if (event.status === 'ready') throw new Error('control-plane unavailable');
      },
    });
    await harness.store.upsert({ id: 'warehouse', name: 'Warehouse Tools', command: 'node' });

    const started = await harness.runtime.start('warehouse');

    expect(started).toMatchObject({ tools: [], health: { status: 'unhealthy' } });
    expect(harness.registry.llmTools()).toEqual([]);
    expect(harness.runtime.isRunning('warehouse')).toBe(false);
  });

  it('rejects startup when ready and unavailable generation publication both fail', async () => {
    const harness = await runtimeHarness({
      onPublicationEvent(event) {
        if (event.status === 'ready' || event.status === 'unavailable') {
          throw new Error('control-plane unavailable');
        }
      },
    });
    await harness.store.upsert({ id: 'warehouse', name: 'Warehouse Tools', command: 'node' });

    await expect(harness.runtime.start('warehouse')).rejects.toThrow(
      'MCP startup and unavailable publication both failed',
    );
    expect(harness.registry.llmTools()).toEqual([]);
    expect(harness.runtime.isRunning('warehouse')).toBe(false);
    expect(harness.runtime.health('warehouse')).toMatchObject({ status: 'starting' });
  });

  it('restarts a healthy client when its launch configuration changed', async () => {
    const harness = await runtimeHarness();
    await harness.store.upsert({
      id: 'warehouse',
      name: 'Warehouse Tools',
      command: 'node',
      args: ['first.mjs'],
    });
    await harness.runtime.start('warehouse');
    await harness.store.upsert({
      id: 'warehouse',
      name: 'Warehouse Tools',
      command: 'node',
      args: ['second.mjs'],
    });

    await harness.runtime.start('warehouse');

    expect(harness.launchedServers).toEqual(['warehouse', 'warehouse']);
    expect(harness.stoppedClients).toEqual(['warehouse']);
    expect(harness.runtime.isRunning('warehouse')).toBe(true);
  });

  it('keeps the ready generation when a changed launch configuration cannot start', async () => {
    const harness = await runtimeHarness({ failLaunchAfter: 2 });
    await harness.store.upsert({
      id: 'warehouse', name: 'Warehouse Tools', command: 'node', args: ['first.mjs'],
    });
    await harness.runtime.start('warehouse');
    await harness.store.upsert({
      id: 'warehouse', name: 'Warehouse Tools', command: 'node', args: ['second.mjs'],
    });

    const result = await harness.runtime.start('warehouse');

    expect(result).toMatchObject({
      tools: ['warehouse__list_tables'], health: { status: 'healthy', healthy: true },
    });
    expect(harness.runtime.isRunning('warehouse')).toBe(true);
    expect(harness.registry.llmTools().map((tool) => tool.name)).toEqual([
      'warehouse__list_tables',
    ]);
    expect(harness.stoppedClients).toEqual([]);
  });

  it('preserves an unhealthy prior generation when replacement launch fails', async () => {
    const harness = await runtimeHarness({ failLaunchAfter: 2 });
    await harness.store.upsert({ id: 'warehouse', name: 'Warehouse Tools', command: 'node' });
    await harness.runtime.start('warehouse');
    harness.health.markUnhealthy('warehouse', 'remote transport unavailable');

    const result = await harness.runtime.start('warehouse');

    expect(result.health).toMatchObject({ status: 'unhealthy', healthy: false });
    expect(harness.registry.has('warehouse__list_tables')).toBe(true);
    await expect(invokeRegistered(harness.registry, 'warehouse__list_tables', {})).rejects.toMatchObject({
      fact: { code: 'TOOL_PRECONDITION_FAILED', outcome: 'not_applied' },
    });
  });

  it('preserves a restarting prior generation when replacement preparation fails', async () => {
    const harness = await runtimeHarness({ failLaunchAfter: 2 });
    await harness.store.upsert({ id: 'warehouse', name: 'Warehouse Tools', command: 'node' });
    await harness.runtime.start('warehouse');
    harness.health.recordExit('warehouse', { code: 1, errorMessage: 'transient exit' });

    const result = await harness.runtime.start('warehouse');

    expect(result.health).toMatchObject({ status: 'restarting', healthy: false, restartCount: 1 });
    expect(harness.registry.has('warehouse__list_tables')).toBe(true);
  });

  it('ignores a queued exit from a replaced client while still honoring the current client exit', async () => {
    const stopped: string[] = [];
    let launches = 0;
    let releaseReplacementDiscovery!: () => void;
    let enterReplacementDiscovery!: () => void;
    let emitFirstExit!: (event: McpRuntimeExitEvent) => void;
    let emitReplacementExit!: (event: McpRuntimeExitEvent) => void;
    const replacementDiscoveryEntered = new Promise<void>((resolve) => {
      enterReplacementDiscovery = resolve;
    });
    const harness = await runtimeHarness({
      launcher: (server) => {
        launches += 1;
        if (launches === 1) {
          return {
            ...lifecycleClient(server.id, stopped, 'first_catalog'),
            stop() {
              stopped.push('first');
            },
            onExit(handler) {
              emitFirstExit = handler;
              return () => undefined;
            },
          };
        }
        if (launches === 2) {
          return {
            ...lifecycleClient(server.id, stopped, 'replacement_catalog'),
            listTools() {
              enterReplacementDiscovery();
              return new Promise<McpToolSpec[]>((resolve) => {
                releaseReplacementDiscovery = () => resolve([
                  { name: 'replacement_catalog', annotations: { readOnlyHint: true } },
                ]);
              });
            },
            stop() {
              stopped.push('replacement');
            },
            onExit(handler) {
              emitReplacementExit = handler;
              return () => undefined;
            },
          };
        }
        throw new Error('Unexpected replacement launch.');
      },
    });
    await harness.store.upsert({
      id: 'warehouse', name: 'Warehouse Tools', command: 'node', args: ['first.mjs'],
    });
    await harness.runtime.start('warehouse');
    await harness.store.upsert({
      id: 'warehouse', name: 'Warehouse Tools', command: 'node', args: ['replacement.mjs'],
    });

    const replacement = harness.runtime.start('warehouse');
    await replacementDiscoveryEntered;
    emitFirstExit({ code: 1 });
    releaseReplacementDiscovery();
    await replacement;

    // This start is an ordered lifecycle barrier: the first client's queued
    // exit must have been observed before the current catalog is asserted.
    const current = await harness.runtime.start('warehouse');
    expect(current.tools).toEqual(['warehouse__replacement_catalog']);
    expect(launches).toBe(2);
    expect(harness.registry.llmTools().map((tool) => tool.name)).toEqual([
      'warehouse__replacement_catalog',
    ]);
    expect(stopped).not.toContain('replacement');

    emitReplacementExit({ code: 1 });
    await waitFor(() => !harness.runtime.isRunning('warehouse'));
    expect(harness.registry.llmTools()).toEqual([]);
  });

  it('serializes a start-stop-start race and leaves exactly the final client running', async () => {
    const harness = await runtimeHarness();
    await harness.store.upsert({
      id: 'warehouse',
      name: 'Warehouse Tools',
      command: 'node',
    });

    const firstStart = harness.runtime.start('warehouse');
    const stop = harness.runtime.stop('warehouse');
    const finalStart = harness.runtime.start('warehouse');
    await expect(firstStart).rejects.toThrow('MCP startup was cancelled: warehouse.');
    await Promise.all([stop, finalStart]);

    expect(harness.launchedServers).toEqual(['warehouse']);
    expect(harness.stoppedClients).toEqual([]);
    expect(harness.runtime.isRunning('warehouse')).toBe(true);
    expect(harness.registry.llmTools().map((tool) => tool.name)).toEqual([
      'warehouse__list_tables',
    ]);
  });

  it('cancels a late launcher before stop and keeps a later start authoritative', async () => {
    let resolveLateClient!: (client: McpRuntimeClient) => void;
    let launches = 0;
    const stopped: string[] = [];
    const harness = await runtimeHarness({
      launcher: (server) => {
        launches += 1;
        if (launches === 1) {
          return new Promise<McpRuntimeClient>((resolve) => {
            resolveLateClient = resolve;
          });
        }
        return lifecycleClient(server.id, stopped, 'fresh_tool');
      },
    });
    await harness.store.upsert({ id: 'warehouse', name: 'Warehouse Tools', command: 'node' });

    const firstStart = harness.runtime.start('warehouse');
    await waitFor(() => launches === 1);
    const stop = harness.runtime.stop('warehouse');
    const replacementStart = harness.runtime.start('warehouse');
    await Promise.all([firstStart, stop, replacementStart]);

    expect(harness.runtime.isRunning('warehouse')).toBe(true);
    expect(harness.registry.llmTools().map((tool) => tool.name)).toEqual(['warehouse__fresh_tool']);
    resolveLateClient(lifecycleClient('warehouse', stopped, 'late_tool'));
    await waitFor(() => stopped.includes('warehouse'));
    expect(harness.registry.llmTools().map((tool) => tool.name)).toEqual(['warehouse__fresh_tool']);
    expect(harness.runtime.isRunning('warehouse')).toBe(true);
  });

  it('bounds initial tool discovery and records cleanup without publishing a partial generation', async () => {
    const stopped: string[] = [];
    const harness = await runtimeHarness({
      startupTimeoutMs: 10,
      launcher: (server) => ({
        ...lifecycleClient(server.id, stopped),
        listTools: () => new Promise(() => undefined),
        stop: () => {
          stopped.push(server.id);
          return new Promise<void>(() => undefined);
        },
      }),
    });
    await harness.store.upsert({ id: 'warehouse', name: 'Warehouse Tools', command: 'node' });

    const result = await harness.runtime.start('warehouse');

    expect(result).toMatchObject({ tools: [], health: { status: 'unhealthy', healthy: false } });
    expect(result.health.lastError).toContain('client cleanup is still pending');
    expect(harness.registry.llmTools()).toEqual([]);
    expect(harness.runtime.isRunning('warehouse')).toBe(false);
    expect(stopped).toEqual(['warehouse']);
  });

  it('stops a running MCP server and removes its tools from Agent exposure', async () => {
    const harness = await runtimeHarness();
    await harness.store.upsert({ id: 'warehouse', name: 'Warehouse Tools', command: 'node' });
    await harness.runtime.start('warehouse');

    const stopped = await harness.runtime.stop('warehouse');

    expect(stopped.removedTools).toEqual(['warehouse__list_tables']);
    expect(stopped.health.status).toBe('stopped');
    expect(harness.runtime.isRunning('warehouse')).toBe(false);
    expect(harness.registry.llmTools()).toEqual([]);
    expect(harness.stoppedClients).toEqual(['warehouse']);
    expect(harness.availabilityEvents.at(-1)).toEqual({
      serverId: 'warehouse',
      status: 'stopped',
    });
  });

  it('stops every running MCP server during runtime shutdown without touching inactive configs', async () => {
    const harness = await runtimeHarness();
    await harness.store.upsert({
      id: 'alpha',
      name: 'Alpha Tools',
      command: 'node',
    });
    await harness.store.upsert({
      id: 'beta',
      name: 'Beta Tools',
      command: 'node',
    });
    await harness.store.upsert({
      id: 'inactive',
      name: 'Inactive Tools',
      command: 'node',
    });
    await harness.runtime.start('beta');
    await harness.runtime.start('alpha');

    const stopped = await harness.runtime.stopAll();

    expect(stopped.map((result) => result.serverId)).toEqual(['alpha', 'beta']);
    expect(harness.stoppedClients).toEqual(['alpha', 'beta']);
    expect(harness.registry.llmTools()).toEqual([]);
    expect(harness.runtime.isRunning('alpha')).toBe(false);
    expect(harness.runtime.isRunning('beta')).toBe(false);
    expect(harness.runtime.health('inactive').status).toBe('stopped');
  });

  it('does not launch disabled MCP servers and marks them disabled', async () => {
    const harness = await runtimeHarness();
    await harness.store.upsert({
      id: 'disabled',
      name: 'Disabled',
      command: 'node',
      enabled: false,
    });

    const result = await harness.runtime.start('disabled');

    expect(result.tools).toEqual([]);
    expect(result.health.status).toBe('disabled');
    expect(harness.launchedServers).toEqual([]);
    expect(harness.registry.llmTools()).toEqual([]);
  });

  it('marks failed starts unhealthy and does not leave half-registered tools', async () => {
    const harness = await runtimeHarness({
      launcher: () => {
        throw new Error('spawn ENOENT');
      },
    });
    await harness.store.upsert({ id: 'broken', name: 'Broken', command: 'missing' });

    const result = await harness.runtime.start('broken');

    expect(result.health).toMatchObject({
      status: 'unhealthy',
      healthy: false,
      lastError: 'spawn ENOENT',
    });
    expect(harness.registry.llmTools()).toEqual([]);
  });

  it('starts only enabled autoStart servers', async () => {
    const harness = await runtimeHarness();
    await harness.store.upsert({ id: 'auto', name: 'Auto', command: 'node', autoStart: true });
    await harness.store.upsert({ id: 'manual', name: 'Manual', command: 'node', autoStart: false });
    await harness.store.upsert({
      id: 'disabled',
      name: 'Disabled',
      command: 'node',
      autoStart: true,
      enabled: false,
    });

    const results = await harness.runtime.startAutoStart();

    expect(results.map((result) => result.server.id)).toEqual(['auto']);
    expect(harness.launchedServers).toEqual(['auto']);
    expect(harness.registry.llmTools().map((tool) => tool.name)).toEqual(['auto__list_tables']);
  });

  it('cancels an admitted auto-start discovery without publishing tools or admitting later servers', async () => {
    const stopped: string[] = [];
    const launched: string[] = [];
    let listToolsSignal: AbortSignal | undefined;
    let releaseTools!: () => void;
    let enteredListTools!: () => void;
    const listToolsEntered = new Promise<void>((resolve) => {
      enteredListTools = resolve;
    });
    const harness = await runtimeHarness({
      launcher: (server) => {
        launched.push(server.id);
        return {
          ...lifecycleClient(server.id, stopped),
          listTools(signal) {
            listToolsSignal = signal;
            enteredListTools();
            return new Promise<McpToolSpec[]>((resolve) => {
              releaseTools = () => resolve([{ name: 'list_tables', annotations: { readOnlyHint: true } }]);
            });
          },
        };
      },
    });
    await harness.store.upsert({ id: 'alpha', name: 'Alpha', command: 'node', autoStart: true });
    await harness.store.upsert({ id: 'beta', name: 'Beta', command: 'node', autoStart: true });
    const caller = new AbortController();

    const started = harness.runtime.startAutoStart(caller.signal);
    await listToolsEntered;
    caller.abort(new Error('caller cancelled auto-start'));
    releaseTools();

    await expect(started).rejects.toThrow('caller cancelled auto-start');
    expect(listToolsSignal?.aborted).toBe(true);
    expect(stopped).toEqual(['alpha']);
    expect(harness.registry.llmTools()).toEqual([]);
    expect(harness.runtime.isRunning('alpha')).toBe(false);
    expect(launched).toEqual(['alpha']);
  });

  it('does not auto-start servers whose autoStart flag was omitted', async () => {
    const harness = await runtimeHarness();
    await harness.store.upsert({
      id: 'manual',
      name: 'Manual',
      command: 'node',
    });

    await expect(harness.runtime.startAutoStart()).resolves.toEqual([]);
    expect(harness.launchedServers).toEqual([]);
    expect(harness.runtime.isRunning('manual')).toBe(false);
  });

  it('atomically replaces Agent tools when the MCP server emits tools/list_changed', async () => {
    const harness = await runtimeHarness();
    await harness.store.upsert({ id: 'warehouse', name: 'Warehouse Tools', command: 'node' });
    await harness.runtime.start('warehouse');

    harness.emitToolsChanged('warehouse', [
      {
        name: 'inspect_query',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
      },
    ]);

    await waitFor(() => harness.registry.has('warehouse__inspect_query'));
    expect(harness.registry.has('warehouse__list_tables')).toBe(false);
    expect(harness.registry.has('warehouse__inspect_query')).toBe(true);
    expect(harness.runtime.health('warehouse')).toMatchObject({
      status: 'healthy',
      healthy: true,
    });

    harness.emitToolsChanged('warehouse', new Error('malformed tool page'));

    await waitFor(() => harness.availabilityEvents.at(-1)?.reason !== undefined);
    expect(harness.registry.llmTools().map((tool) => tool.name)).toEqual([
      'warehouse__inspect_query',
    ]);
    expect(harness.runtime.health('warehouse')).toMatchObject({
      status: 'healthy',
      healthy: true,
    });
    expect(harness.availabilityEvents.at(-1)).toEqual({
      serverId: 'warehouse',
      status: 'ready',
      reason: 'MCP tool catalog refresh failed; the previous catalog remains available.',
    });
  });

  it('restores the prior generation when refresh ready publication fails', async () => {
    let failRefreshPublication = false;
    const harness = await runtimeHarness({
      onPublicationEvent(event) {
        if (failRefreshPublication && event.status === 'ready') {
          throw new Error('control-plane unavailable');
        }
      },
    });
    await harness.store.upsert({ id: 'warehouse', name: 'Warehouse Tools', command: 'node' });
    await harness.runtime.start('warehouse');
    failRefreshPublication = true;

    harness.emitToolsChanged('warehouse', [
      {
        name: 'inspect_query',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
      },
    ]);

    await waitFor(() => harness.availabilityEvents.length === 2);
    expect(harness.availabilityEvents.at(-1)).toEqual({ serverId: 'warehouse', status: 'ready' });
    expect(harness.registry.has('warehouse__list_tables')).toBe(true);
    expect(harness.registry.has('warehouse__inspect_query')).toBe(false);
    await expect(invokeRegistered(harness.registry, 'warehouse__list_tables', {})).resolves.toMatchObject({
      externalPayload: { toolName: 'list_tables', args: {} },
    });
    expect(harness.runtime.health('warehouse')).toMatchObject({ status: 'healthy', healthy: true });
  });

  it('serializes changed catalogs and publishes each only after availability commits', async () => {
    let readyCount = 0;
    let releaseFirstChange!: () => void;
    let reportFirstChange!: () => void;
    const firstChangeGate = new Promise<void>((resolve) => {
      releaseFirstChange = resolve;
    });
    const firstChangeEntered = new Promise<void>((resolve) => {
      reportFirstChange = resolve;
    });
    const harness = await runtimeHarness({
      async onPublicationEvent(event) {
        if (event.status !== 'ready') return;
        readyCount += 1;
        if (readyCount !== 2) return;
        reportFirstChange();
        await firstChangeGate;
      },
    });
    await harness.store.upsert({ id: 'warehouse', name: 'Warehouse Tools', command: 'node' });
    await harness.runtime.start('warehouse');

    harness.emitToolsChanged('warehouse', [
      {
        name: 'first_catalog',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
      },
    ]);
    await firstChangeEntered;
    expect(harness.registry.has('warehouse__list_tables')).toBe(true);
    expect(harness.registry.has('warehouse__first_catalog')).toBe(false);

    harness.emitToolsChanged('warehouse', [
      {
        name: 'second_catalog',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
      },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(readyCount).toBe(2);
    expect(harness.registry.has('warehouse__second_catalog')).toBe(false);

    releaseFirstChange();
    await waitFor(() => harness.registry.has('warehouse__second_catalog'));
    expect(harness.registry.has('warehouse__first_catalog')).toBe(false);
    expect(readyCount).toBe(3);
  });

  it('unregisters tools on unexpected exit and restarts due servers without exposing stale tools', async () => {
    let now = '2026-06-18T10:00:00.000Z';
    const harness = await runtimeHarness({
      health: {
        baseRestartDelayMs: 1_000,
        now: () => now,
      },
    });
    await harness.store.upsert({ id: 'warehouse', name: 'Warehouse Tools', command: 'node' });
    await harness.runtime.start('warehouse');

    const exited = await harness.runtime.recordExit('warehouse', { code: 1 });

    expect(exited.removedTools).toEqual(['warehouse__list_tables']);
    expect(exited.health).toMatchObject({
      status: 'restarting',
      healthy: false,
      restartCount: 1,
      nextRestartAt: '2026-06-18T10:00:01.000Z',
    });
    expect(harness.runtime.isRunning('warehouse')).toBe(false);
    expect(harness.registry.llmTools()).toEqual([]);

    await expect(harness.runtime.restartDue('2026-06-18T10:00:00.999Z')).resolves.toEqual([]);
    expect(harness.launchedServers).toEqual(['warehouse']);

    now = '2026-06-18T10:00:01.000Z';
    const restarted = await harness.runtime.restartDue(now);

    expect(restarted).toMatchObject([
      {
        server: { id: 'warehouse' },
        tools: ['warehouse__list_tables'],
        health: { status: 'healthy', healthy: true },
      },
    ]);
    expect(harness.launchedServers).toEqual(['warehouse', 'warehouse']);
    expect(harness.runtime.isRunning('warehouse')).toBe(true);
    expect(harness.registry.llmTools().map((tool) => tool.name)).toEqual([
      'warehouse__list_tables',
    ]);
  });

  it('fails closed locally when an unexpected-exit generation cannot be published', async () => {
    let rejectUnavailable = false;
    const harness = await runtimeHarness({
      onPublicationEvent(event) {
        if (rejectUnavailable && event.status === 'unavailable') {
          throw new Error('control-plane unavailable');
        }
      },
    });
    await harness.store.upsert({ id: 'warehouse', name: 'Warehouse Tools', command: 'node' });
    await harness.runtime.start('warehouse');
    rejectUnavailable = true;

    await expect(harness.runtime.recordExit('warehouse', { code: 1 })).rejects.toThrow(
      'control-plane unavailable',
    );
    expect(harness.runtime.health('warehouse')).toMatchObject({ status: 'unhealthy', healthy: false });
    await expect(invokeRegistered(harness.registry, 'warehouse__list_tables', {})).rejects.toMatchObject({
      fact: { code: 'TOOL_PRECONDITION_FAILED', outcome: 'not_applied' },
    });
  });

  it('reacts to a real stdio process exit by removing stale Agent tools', async () => {
    const harness = await runtimeHarness({
      health: {
        baseRestartDelayMs: 1_000,
        now: () => '2026-06-18T10:00:00.000Z',
      },
      launcher: createStdioMcpRuntimeLauncher({ requestTimeoutMs: 1_000 }),
    });
    await harness.store.upsert({
      id: 'volatile',
      name: 'Volatile MCP',
      source: 'user',
      transport: 'stdio',
      command: process.execPath,
      args: [FIXTURE_SERVER],
      enabled: true,
      autoStart: false,
    });

    const started = await harness.runtime.start('volatile');

    expect(started.tools).toEqual([
      'volatile__echo',
      'volatile__replace_catalog',
      'volatile__logical_error',
      'volatile__slow',
      'volatile__crash',
    ]);
    expect(harness.registry.llmTools().map((tool) => tool.name)).toEqual(started.tools);

    await expect(invokeRegistered(harness.registry, 'volatile__crash', {})).rejects.toThrow();
    await waitFor(() => !harness.runtime.isRunning('volatile'));

    expect(harness.registry.llmTools()).toEqual([]);
    expect(harness.runtime.health('volatile')).toMatchObject({
      status: 'restarting',
      healthy: false,
      restartCount: 1,
    });
    expect(harness.runtime.health('volatile').nextRestartAt).toBeDefined();
  });
});

async function runtimeHarness(
  input: {
    launcher?: McpRuntimeLauncher;
    startupTimeoutMs?: number;
    health?: McpHealthManagerOptions;
    exitOnSubscribe?: McpRuntimeExitEvent;
    failLaunchAfter?: number;
    registry?: ToolRegistry;
    onPublicationEvent?: (event: McpRuntimeAvailabilityEvent) => void | Promise<void>;
    onGenerationPublished?: (publication: McpRuntimeGenerationPublication) => void | Promise<void>;
  } = {},
) {
  const registry = input.registry ?? new ToolRegistry();
  const health = new McpHealthManager(input.health);
  const store = new McpConfigStore(await configPath());
  const tools = new McpToolRegistrationManager(registry);
  const launchedServers: string[] = [];
  const stoppedClients: string[] = [];
  const availabilityEvents: Array<{
    serverId: string;
    status: 'ready' | 'unavailable' | 'disabled' | 'stopped';
    reason?: string;
  }> = [];
  const toolChangeHandlers = new Map<
    string,
    (event: { items: McpToolSpec[] } | { error: Error }) => void
  >();
  const exitHandlers = new Map<string, (event: McpRuntimeExitEvent) => void>();
  const runtime = new McpRuntimeManager({
    configStore: store,
    health,
    tools,
    ...(input.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: input.startupTimeoutMs }),
    async onGenerationPublished(publication: McpRuntimeGenerationPublication) {
      availabilityEvents.push(publication.event);
      if (input.onGenerationPublished) {
        await input.onGenerationPublished(publication);
        return;
      }
      await input.onPublicationEvent?.(publication.event);
      publication.commit();
    },
    launcher:
      input.launcher ??
      ((server) => {
        launchedServers.push(server.id);
        if (input.failLaunchAfter !== undefined && launchedServers.length >= input.failLaunchAfter) {
          throw new Error('replacement launch failed');
        }
        return {
          describe() {
            return {
              serverId: server.id,
              transport: server.transport,
              capabilities: { tools: { listChanged: true } },
              serverInfo: { name: server.name, version: '1.0.0' },
            };
          },
          ping() {
            return Promise.resolve();
          },
          listTools() {
            return Promise.resolve([{ name: 'list_tables', annotations: { readOnlyHint: true } }]);
          },
          callTool(toolName, args) {
            return { toolName, args };
          },
          stop() {
            stoppedClients.push(server.id);
          },
          listResources() {
            return Promise.resolve([]);
          },
          listResourceTemplates() {
            return Promise.resolve([]);
          },
          readResource() {
            return Promise.resolve({ contents: [] });
          },
          listPrompts() {
            return Promise.resolve([]);
          },
          getPrompt() {
            return Promise.resolve({ messages: [] });
          },
          onToolsChanged(handler) {
            toolChangeHandlers.set(server.id, handler);
            return () => toolChangeHandlers.delete(server.id);
          },
          onExit(handler) {
            exitHandlers.set(server.id, handler);
            if (input.exitOnSubscribe) handler(input.exitOnSubscribe);
            return () => exitHandlers.delete(server.id);
          },
        };
      }),
  });
  return {
    registry,
    health,
    store,
    runtime,
    launchedServers,
    stoppedClients,
    availabilityEvents,
    emitToolsChanged(serverId: string, input: McpToolSpec[] | Error) {
      const handler = toolChangeHandlers.get(serverId);
      if (!handler) throw new Error(`Missing tools change handler for ${serverId}.`);
      if (input instanceof Error) handler({ error: input });
      else handler({ items: input });
    },
    emitExit(serverId: string, event: McpRuntimeExitEvent) {
      const handler = exitHandlers.get(serverId);
      if (!handler) throw new Error(`Missing exit handler for ${serverId}.`);
      handler(event);
    },
  };
}

function lifecycleClient(serverId: string, stopped: string[], toolName = 'list_tables'): McpRuntimeClient {
  return {
    describe() {
      return {
        serverId,
        transport: 'stdio',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: serverId, version: '1.0.0' },
      };
    },
    ping() {
      return Promise.resolve();
    },
    listTools() {
      return Promise.resolve([{ name: toolName, annotations: { readOnlyHint: true } }]);
    },
    callTool(toolName, args) {
      return { toolName, args };
    },
    stop() {
      stopped.push(serverId);
    },
    listResources() {
      return Promise.resolve([]);
    },
    listResourceTemplates() {
      return Promise.resolve([]);
    },
    readResource() {
      return Promise.resolve({ contents: [] });
    },
    listPrompts() {
      return Promise.resolve([]);
    },
    getPrompt() {
      return Promise.resolve({ messages: [] });
    },
  };
}

async function configPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dbagent-mcp-runtime-'));
  tempDirs.push(dir);
  return join(dir, 'mcp.json');
}

async function invokeRegistered(
  registry: ToolRegistry,
  name: string,
  args: Record<string, PortableValue>,
) {
  const snapshot = registry.captureSnapshot();
  try {
    const runtime = resolveInvocationHandler(snapshot, name);
    if (runtime === undefined) throw new Error(`Missing Invocation Handler: ${name}`);
    const prepareContext = {
      projectId: 'project_mcp', sessionId: 'session_mcp', runId: 'run_mcp', turnId: 'turn_mcp',
      invocationId: `invocation_${name}`, idempotencyKey: `idempotency_${name}`,
      hostId: 'local', descriptor: { flatName: name }, toolRevision: snapshot.get(name)!.descriptor.toolRevision,
      handlerRevision: snapshot.get(name)!.descriptor.handlerRevision, intentRevision: snapshot.get(name)!.descriptor.intentRevision,
      generation: 1, limits: snapshot.get(name)!.descriptor.limits, signal: new AbortController().signal,
    };
    const intent = await runtime.prepare(args, prepareContext as never);
    return await runtime.execute(intent.input, { ...prepareContext, intent, deadline: new Date(Date.now() + 60_000).toISOString() } as never);
  } finally {
    snapshot.release();
  }
}


function assertGeneration(
  control: CapabilityControlPlane,
  tools: string[],
  available: boolean,
): void {
  const snapshot = control.captureRuntimeSnapshot();
  try {
    expect(snapshot.tools.llmTools().map((tool) => tool.name)).toEqual(tools);
    expect(snapshot.capabilities.externalProviders.some((provider) =>
      provider.providerId === 'mcp:warehouse' && provider.active,
    )).toBe(available);
  } finally {
    snapshot.release();
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for condition.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
