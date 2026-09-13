import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry, type AgentCapabilityDiscoveryManifestEntry } from '@dbagent/core-agent';
import { createToolSearchToolContribution, registerAgentRuntimeTools } from '../src/index.js';
import { createBaselineTestRegistry, executeInvocationTools } from './tool-invocation-test-harness.js';

function registryWithRuntimeControls() {
  const registry = new ToolRegistry();
  registerAgentRuntimeTools(registry);
  return registry;
}

describe('runtime coordination tools', () => {
  it('registers only current deferred task tools and direct tool search', () => {
    const registry = registryWithRuntimeControls();
    const snapshot = registry.captureSnapshot();
    expect(snapshot.list().map(({ name }) => name)).toEqual(['task_plan_create', 'task_update', 'task_list']);
    const search = createToolSearchToolContribution();
    expect(search.definition).toMatchObject({ name: 'tool_search', exposure: 'direct', access: 'external', recoveryClass: 'idempotent', aliases: [] });
    expect(JSON.stringify(search.definition.inputSchema)).toContain('select');
    expect(JSON.stringify(search.definition.inputSchema)).toContain('query');
    expect(registry.get('task_plan_create')?.descriptor).toMatchObject({ exposure: 'deferred', access: 'write', recoveryClass: 'idempotent' });
    snapshot.release();
  });

  it('uses bounded deferred Runtime Command schemas for task plans', () => {
    const registry = registryWithRuntimeControls();
    expect(registry.get('task_plan_create')?.inputSchema).toMatchObject({ required: ['goal', 'tasks'] });
    expect(registry.get('task_update')?.inputSchema).toMatchObject({ required: ['taskId'] });
    expect(JSON.stringify(registry.get('task_list')?.inputSchema)).not.toContain('pinnedTools');
  });

  it('uses mutually exclusive query and exact select activation without aliases', () => {
    const search = createToolSearchToolContribution();
    expect(Array.isArray(search.definition.inputSchema.oneOf)).toBe(true);
    expect(search.definition.inputSchema.oneOf).toHaveLength(2);
    expect(JSON.stringify(search.definition.inputSchema)).not.toContain('tool_describe');
  });

  it('activates one shared Capability target once, then treats it as active', async () => {
    const activate = vi.fn(() => Promise.resolve({ status: 'activated' as const }));
    const baseline = await createBaselineTestRegistry({
      capabilityActivator: { revision: 'test-activator.v1', activate },
    });
    const capabilities = sharedTargetCapabilities();
    try {
      const first = await executeInvocationTools(baseline.registry, [
        { name: 'tool_search', arguments: { select: [{ name: 'database_query' }, { name: 'database_analysis' }] } },
      ], { discoverableCapabilities: capabilities });
      try {
        expect(activate).toHaveBeenCalledTimes(1);
        expect(activate).toHaveBeenCalledWith(expect.objectContaining({
          name: 'database_query',
          target: { moduleId: 'database', instanceId: 'primary' },
        }));
        const projection = await first.journal.getRuntimeCommandProjection({
          projectId: 'project-tools', sessionId: 'session-tools', runId: first.runId,
        });
        expect(projection?.discoveredCapabilities).toEqual([
          { moduleId: 'database', instanceId: 'primary' },
        ]);
        const second = await executeInvocationTools(baseline.registry, [
          { name: 'tool_search', arguments: { select: [{ name: 'database_query' }] } },
        ], {
          discoverableCapabilities: capabilities,
          continuation: {
            directory: first.directory,
            journal: first.journal,
            runId: first.runId,
            lease: first.lease,
          },
        });
        try {
          expect(activate).toHaveBeenCalledTimes(1);
          expect(JSON.stringify(second.observations)).toContain('already_active');
        } finally {
          await second.dispose();
        }
      } finally {
        // The continuation owns the shared journal directory when it exists.
      }
    } finally {
      await baseline.dispose();
    }
  });
});

function sharedTargetCapabilities(): readonly AgentCapabilityDiscoveryManifestEntry[] {
  const target = { moduleId: 'database', instanceId: 'primary' };
  return [
    {
      name: 'database_query',
      description: 'Query an externally configured database.',
      status: 'available',
      target,
    },
    {
      name: 'database_analysis',
      description: 'Analyze the same externally configured database.',
      status: 'available',
      target,
    },
  ];
}
