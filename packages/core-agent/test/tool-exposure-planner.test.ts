import { describe, expect, it } from 'vitest';
import {
  ToolExposurePlanner,
  ToolRegistry,
} from '../src/index.js';
import { resolveLlmProviderProtocolProfile } from '@dbagent/core-llm';

describe('ToolExposurePlanner', () => {
  it('keeps direct tools visible and activates deferred tools only for the current catalog/checkpoint/phase', () => {
    const registry = catalog();
    const planner = new ToolExposurePlanner();
    const plan = planner.plan({
      registry,
      checkpointSequence: 3,
      taskPhase: 'act',
      activations: [
        {
          toolName: 'deferred_read',
          catalogRevision: registry.catalogRevision,
          checkpointSequence: 3,
          taskPhase: 'act',
          activatedAt: '2026-08-01T00:00:00.000Z',
        },
        {
          toolName: 'stale_read',
          catalogRevision: registry.catalogRevision - 1,
          checkpointSequence: 3,
          taskPhase: 'act',
          activatedAt: '2026-08-01T00:00:00.000Z',
        },
      ],
    });

    expect(plan.modelTools.map((tool) => tool.name)).toEqual(['always_read', 'deferred_read']);
    expect(plan.discoverable.map((tool) => tool.flatName)).toEqual([
      'deferred_read',
      'stale_read',
    ]);
    expect(plan.modelTools.map((tool) => tool.name)).not.toContain('hidden_runtime');
    expect(plan.modelTools.map((tool) => tool.name)).not.toContain('disabled_tool');
  });

  it('uses client discovery for unknown proxies and only emits native deferred specs when declared', () => {
    const registry = catalog();
    const planner = new ToolExposurePlanner();

    const proxyPlan = planner.plan({
      registry,
      providerProfile: resolveLlmProviderProtocolProfile({
        protocol: 'openai-compatible-proxy',
        source: 'user-declaration',
      }),
    });
    expect(proxyPlan.nativeDeferredTools).toEqual([]);
    expect(proxyPlan.discoveryMode).toBe('client');

    const officialPlan = planner.plan({
      registry,
      preferNativeDeferredTools: true,
      providerProfile: resolveLlmProviderProtocolProfile({
        protocol: 'openai-responses',
        source: 'builtin',
        capabilities: { nativeDeferredTools: 'supported' },
      }),
    });
    expect(officialPlan.discoveryMode).toBe('native');
    expect(officialPlan.nativeDeferredTools.map((tool) => tool.name)).toEqual([
      'deferred_read',
      'stale_read',
    ]);
  });

  it('applies allowed tools before every exposure decision', () => {
    const registry = catalog();
    const plan = new ToolExposurePlanner().plan({
      registry,
      allowedTools: ['deferred_read'],
      dynamicDiscovery: false,
    });

    expect(plan.modelTools.map((tool) => tool.name)).toEqual(['deferred_read']);
    expect(plan.discoverable.map((tool) => tool.flatName)).toEqual(['deferred_read']);
  });
});

function catalog() {
  const registry = new ToolRegistry();
  add(registry, 'always_read', 'direct');
  add(registry, 'deferred_read', 'deferred');
  add(registry, 'stale_read', 'deferred');
  add(registry, 'hidden_runtime', 'hidden');
  add(registry, 'disabled_tool', 'disabled');
  return registry;
}

function add(
  registry: ToolRegistry,
  name: string,
  exposure: 'direct' | 'deferred' | 'hidden' | 'disabled',
) {
  registry.register(
    {
      name,
      description: name,
      inputSchema: { type: 'object' },
      dangerLevel: 'safe',
      readonly: true,
      exposure,
    },
    () => undefined,
  );
}
