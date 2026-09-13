import { describe, expect, it } from 'vitest';
import { BASE_TOOL_MANIFEST } from '../src/base-tool-manifest.js';
import { ToolExposurePlanner } from '../src/tool-exposure-planner.js';
import { PREPARED_TOOL_INTENT_REVISION } from '../src/tools/tool-protocol.js';
import type { ToolRegistry } from '../src/tool-registry.js';
import { fixedBaselineRegistry } from './fixtures/fixed-baseline-catalog.js';
import { preparedToolIntent } from './permission-audit-fixture.js';

const baselineNames = BASE_TOOL_MANIFEST.map(({ name }) => name);

describe('ToolExposurePlanner', () => {
  it('keeps the fixed manifest visible and exposes only an exact deferred activation', () => {
    const registry = catalog();
    const deferred = descriptor(registry, 'deferred_read');
    const plan = new ToolExposurePlanner().plan({ registry, activeTools: [{
      name: deferred.flatName, toolRevision: deferred.toolRevision,
      handlerRevision: deferred.handlerRevision,
    }] });
    expect(plan.modelTools.map(({ name }) => name))
      .toEqual([...baselineNames, 'always_read', 'deferred_read']);
    expect(plan.discoverable.map(({ flatName }) => flatName)).toEqual(['deferred_read', 'stale_read']);
    expect(plan.modelTools.map(({ name }) => name)).not.toContain('hidden_runtime');
    expect(plan.modelTools.map(({ name }) => name)).not.toContain('disabled_tool');
  });

  it('retains an exact activation across unrelated catalog updates and rejects a revised Tool', () => {
    const registry = catalog();
    const activation = activationFor(registry, 'deferred_read');
    add(registry, 'unrelated_tool', 'direct');
    expect(new ToolExposurePlanner().plan({ registry, activeTools: [activation] })
      .modelTools.map(({ name }) => name)).toContain('deferred_read');
    registry.unregister('deferred_read');
    add(registry, 'deferred_read', 'deferred', 'deferred_read@2');
    expect(new ToolExposurePlanner().plan({ registry, activeTools: [activation] })
      .modelTools.map(({ name }) => name)).not.toContain('deferred_read');
  });

  it('uses the one client discovery path while retaining the fixed manifest', () => {
    const plan = new ToolExposurePlanner().plan({ registry: catalog() });
    expect(plan.discoveryMode).toBe('client');
    expect(plan.modelTools.map(({ name }) => name)).toEqual([...baselineNames, 'always_read']);
  });

  it('applies allowedTools only to non-baseline descriptors', () => {
    const registry = catalog();
    const plan = new ToolExposurePlanner().plan({
      registry, allowedTools: ['deferred_read'], activeTools: [activationFor(registry, 'deferred_read')],
    });
    expect(plan.modelTools.map(({ name }) => name)).toEqual([...baselineNames, 'deferred_read']);
  });

  it('lets Skill allowed-tools constrain an already exact activation without promoting hidden Tools', () => {
    const registry = catalog();
    const plan = new ToolExposurePlanner().plan({
      registry, activeTools: [activationFor(registry, 'deferred_read')],
      skillAllowedTools: ['deferred_read', 'hidden_runtime', 'disabled_tool'],
    });
    expect(plan.modelTools.map(({ name }) => name))
      .toEqual([...baselineNames, 'always_read', 'deferred_read']);
    expect(plan.modelTools.map(({ name }) => name)).not.toContain('stale_read');
  });
});

function catalog() {
  const registry = fixedBaselineRegistry();
  add(registry, 'always_read', 'direct');
  add(registry, 'deferred_read', 'deferred');
  add(registry, 'stale_read', 'deferred');
  add(registry, 'hidden_runtime', 'hidden');
  add(registry, 'disabled_tool', 'disabled');
  return registry;
}

function descriptor(registry: ToolRegistry, name: string) {
  const value = registry.get(name)?.descriptor;
  if (value === undefined) throw new Error(`Missing fixture Tool ${name}.`);
  return value;
}

function activationFor(registry: ToolRegistry, name: string) {
  const tool = descriptor(registry, name);
  return { name, toolRevision: tool.toolRevision, handlerRevision: tool.handlerRevision };
}

function add(
  registry: ToolRegistry,
  name: string,
  exposure: 'direct' | 'deferred' | 'hidden' | 'disabled',
  toolRevision = `${name}@1`,
) {
  const handlerRevision = `${name}-handler@1`;
  registry.registerInvocation({
    name, description: name, inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: { type: 'object' }, dangerLevel: 'safe', readonly: true, source: 'fixture',
    access: 'read', recoveryClass: 'read', exposure, toolRevision, handlerRevision,
    intentRevision: PREPARED_TOOL_INTENT_REVISION,
    limits: { timeoutMs: 1_000, maxInputBytes: 4_096, maxOutputBytes: 65_536, maxArtifactBytes: 1_048_576, maxDepth: 8, maxRecords: 128 },
    execution: { concurrency: 'read', timeoutMs: 1_000 },
    failurePolicy: { onUnknown: { failureKind: 'unknown', retryable: false } },
  }, {
    revision: { toolName: name, toolRevision, handlerRevision, intentRevision: PREPARED_TOOL_INTENT_REVISION },
    prepare: () => preparedToolIntent({ toolName: name, toolRevision, handlerRevision }).intent,
    execute: () => ({}),
  });
}
