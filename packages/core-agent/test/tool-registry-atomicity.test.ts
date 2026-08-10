import { describe, expect, it, vi } from 'vitest';
import * as agent from '../src/index.js';

describe('ToolRegistry owner transactions', () => {
  it('validates JavaScript Tool contracts before mutating the registry', () => {
    const registry = new agent.ToolRegistry();
    const beforeRevision = registry.catalogRevision;

    expect(() =>
      registry.replaceOwnerTools('module:fixture:primary', [
        {
          definition: {
            ...tool('fixture_invalid'),
            inputSchema: null as never,
          },
          handler: undefined as never,
        },
      ]),
    ).toThrow('Tool inputSchema must be an object: fixture_invalid');

    expect(registry.catalogRevision).toBe(beforeRevision);
    expect(registry.list()).toEqual([]);
  });

  it('isolates catalog observers so a committed owner transaction cannot report failure', () => {
    const registry = new agent.ToolRegistry();
    const healthyListener = vi.fn();
    registry.subscribe(() => {
      throw new Error('observer failed');
    });
    registry.subscribe(healthyListener);

    expect(() =>
      registry.replaceOwnerTools('module:fixture:primary', [
        { definition: tool('fixture_observed'), handler: () => ({ ok: true }) },
      ]),
    ).not.toThrow();

    expect(registry.has('fixture_observed')).toBe(true);
    expect(healthyListener).toHaveBeenCalledTimes(1);
  });

  it('detaches and freezes the registered contract from caller-owned nested metadata', () => {
    const registry = new agent.ToolRegistry();
    const definition = {
      ...tool('fixture_immutable'),
      presentation: { preparingMessage: 'original message' },
      execution: { concurrency: 'read' as const, timeoutMs: 250 },
    };
    registry.register(definition, () => ({ ok: true }));

    definition.presentation.preparingMessage = 'caller mutation';
    definition.execution.timeoutMs = 999;
    const registered = registry.get('fixture_immutable')!;

    expect(registered.presentation).toEqual({ preparingMessage: 'original message' });
    expect(registered.execution).toEqual({ concurrency: 'read', timeoutMs: 250 });
    expect(Object.isFrozen(registered.presentation)).toBe(true);
    expect(Object.isFrozen(registered.execution)).toBe(true);
  });

  it('rejects an owner replacement collision without publishing partial tools or revisions', () => {
    const registry = new agent.ToolRegistry();
    registry.register(tool('shared_read'), () => ({ owner: 'kernel' }));
    const beforeRevision = registry.catalogRevision;
    const listener = vi.fn();
    registry.subscribe(listener);

    const replaceOwnerTools = Reflect.get(registry, 'replaceOwnerTools') as
      | ((
          ownerId: string,
          contributions: Array<{
            definition: ReturnType<typeof tool>;
            handler: () => unknown;
          }>,
        ) => unknown)
      | undefined;
    expect(replaceOwnerTools).toBeTypeOf('function');
    expect(() =>
      replaceOwnerTools!.call(registry, 'module:database:primary', [
        { definition: tool('database_query'), handler: () => ({ ok: true }) },
        { definition: tool('shared_read'), handler: () => ({ ok: false }) },
      ]),
    ).toThrow('Tool already registered: shared_read');

    expect(registry.catalogRevision).toBe(beforeRevision);
    expect(registry.has('database_query')).toBe(false);
    expect(registry.get('shared_read')?.handler({}, toolContext())).toEqual({
      owner: 'kernel',
    });
    expect(listener).not.toHaveBeenCalled();
  });

  it('increments only replaced owner tool revisions so unrelated activations remain valid', () => {
    const registry = new agent.ToolRegistry();
    registry.replaceOwnerTools('module:database:primary', [
      { definition: tool('database_query'), handler: () => ({ version: 1 }) },
    ]);
    registry.replaceOwnerTools('mcp:git', [
      { definition: tool('git_status'), handler: () => ({ version: 1 }) },
    ]);
    const toolRevision = Reflect.get(registry, 'toolRevision') as
      | ((name: string) => number | undefined)
      | undefined;
    expect(toolRevision).toBeTypeOf('function');
    const databaseRevision = toolRevision!.call(registry, 'database_query');
    const gitRevision = toolRevision!.call(registry, 'git_status');

    registry.replaceOwnerTools('mcp:git', [
      { definition: tool('git_status'), handler: () => ({ version: 2 }) },
      { definition: tool('git_diff'), handler: () => ({ version: 1 }) },
    ]);

    expect(toolRevision!.call(registry, 'database_query')).toBe(databaseRevision);
    expect(toolRevision!.call(registry, 'git_status')).toBe((gitRevision ?? 0) + 1);
    expect(toolRevision!.call(registry, 'git_diff')).toBe(1);
  });

  it('preserves unchanged Tool revisions while moving new snapshots to the refreshed owner lease', () => {
    const registry = new agent.ToolRegistry();
    const handler = () => ({ version: 1 });
    const firstRelease = vi.fn();
    const secondRelease = vi.fn();
    const firstRetain = vi.fn(() => firstRelease);
    const secondRetain = vi.fn(() => secondRelease);
    registry.replaceOwnerTools(
      'module:database:primary',
      [{ definition: tool('database_query'), handler }],
      { snapshotLifecycle: { retain: firstRetain } },
    );
    const firstCatalogRevision = registry.catalogRevision;
    const firstToolRevision = registry.toolRevision('database_query');
    const firstSnapshot = registry.captureSnapshot();

    registry.replaceOwnerTools(
      'module:database:primary',
      [{ definition: { ...tool('database_query') }, handler }],
      { snapshotLifecycle: { retain: secondRetain } },
    );
    const secondSnapshot = registry.captureSnapshot();

    expect(registry.catalogRevision).toBe(firstCatalogRevision);
    expect(registry.toolRevision('database_query')).toBe(firstToolRevision);
    expect(firstRetain).toHaveBeenCalledTimes(1);
    expect(secondRetain).toHaveBeenCalledTimes(1);
    firstSnapshot.release();
    secondSnapshot.release();
    expect(firstRelease).toHaveBeenCalledTimes(1);
    expect(secondRelease).toHaveBeenCalledTimes(1);
  });

  it('keeps the captured handler and schema stable while the live owner is refreshed', async () => {
    const registry = new agent.ToolRegistry();
    registry.replaceOwnerTools('module:database:primary', [
      { definition: tool('database_query'), handler: () => ({ version: 1 }) },
    ]);
    const captureSnapshot = Reflect.get(registry, 'captureSnapshot') as
      | (() => {
          get(name: string): agent.RegisteredAgentTool | undefined;
          toolRevision(name: string): number | undefined;
          llmTools(): Array<{ name: string }>;
        })
      | undefined;
    expect(captureSnapshot).toBeTypeOf('function');
    const captured = captureSnapshot!.call(registry);
    const capturedRevision = captured.toolRevision('database_query');

    registry.replaceOwnerTools('module:database:primary', [
      { definition: tool('database_query'), handler: () => ({ version: 2 }) },
    ]);

    expect(captured.toolRevision('database_query')).toBe(capturedRevision);
    expect(captured.llmTools()).toMatchObject([{ name: 'database_query' }]);
    expect(await captured.get('database_query')!.handler({}, toolContext())).toEqual({
      version: 1,
    });
    expect(await registry.get('database_query')!.handler({}, toolContext())).toEqual({
      version: 2,
    });
  });

  it('executes a model response against the exact catalog snapshot used for exposure', async () => {
    const registry = new agent.ToolRegistry();
    registry.replaceOwnerTools('module:fixture:primary', [
      { definition: tool('fixture_read'), handler: () => ({ version: 1 }) },
    ]);
    const snapshot = registry.captureSnapshot();
    registry.replaceOwnerTools('module:fixture:primary', [
      { definition: tool('fixture_read'), handler: () => ({ version: 2 }) },
    ]);
    const router = new agent.ToolExecutionRouter(registry);

    const [outcome] = await router.execute({
      snapshot,
      calls: [{ id: 'call-1', name: 'fixture_read', arguments: {} }],
      context: toolContext(),
    });

    expect(outcome).toMatchObject({ status: 'success', result: { version: 1 } });
    expect(await registry.get('fixture_read')!.handler({}, toolContext())).toEqual({
      version: 2,
    });
  });
});

function tool(name: string) {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    dangerLevel: 'safe' as const,
    readonly: true,
  };
}

function toolContext(): agent.AgentToolContext {
  return {
    session: {
      id: 'tool-registry-test',
      title: 'Tool registry test',
      mode: 'read',
      messages: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      aborted: false,
    },
  };
}
