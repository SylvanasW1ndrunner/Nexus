import { BASE_TOOL_MANIFEST } from '../../src/base-tool-manifest.js';
import { ToolRegistry } from '../../src/tool-registry.js';
import type { ToolInvocationHandler } from '../../src/tool-registry.js';
import { PREPARED_TOOL_INTENT_REVISION } from '../../src/tools/tool-protocol.js';

/** Publishes the immutable complete Runtime baseline for catalog-facing tests. */
export function fixedBaselineRegistry(options: Readonly<{
  handlers?: Readonly<Record<string, ToolInvocationHandler>>;
}> = {}): ToolRegistry {
  const registry = new ToolRegistry();
  registry.publishBaselineInvocations(BASE_TOOL_MANIFEST.map(({ name, schemaRevision }) => {
    const handlerRevision = `${schemaRevision}:handler@1`;
    return {
      definition: {
        name,
        description: `Fixed Runtime Tool ${name}.`,
        inputSchema: { type: 'object', additionalProperties: false },
        outputSchema: { type: 'object' },
        dangerLevel: 'safe' as const,
        readonly: true,
        source: 'runtime' as const,
        exposure: 'direct' as const,
        access: 'read' as const,
        recoveryClass: 'read' as const,
        limits: {
          timeoutMs: 1_000,
          maxInputBytes: 4_096,
          maxOutputBytes: 65_536,
          maxArtifactBytes: 1_048_576,
          maxDepth: 8,
          maxRecords: 128,
        },
        toolRevision: schemaRevision,
        handlerRevision,
        intentRevision: PREPARED_TOOL_INTENT_REVISION,
        execution: { concurrency: 'read' as const, timeoutMs: 1_000 },
        failurePolicy: { onUnknown: { failureKind: 'unknown' as const, retryable: false } },
      },
      runtime: {
        revision: {
          toolName: name,
          toolRevision: schemaRevision,
          handlerRevision,
          intentRevision: PREPARED_TOOL_INTENT_REVISION,
        },
        prepare: (input, context) => ({
          input,
          toolRevision: context.toolRevision,
          handlerRevision: context.handlerRevision,
          intentRevision: context.intentRevision,
          targetIdentity: { toolName: name },
          generation: context.generation,
          action: { summary: `Execute fixed Tool ${name}.` },
          permission: {
            toolName: name,
            dangerLevel: 'safe',
            readonly: true,
            access: 'read',
            recoveryClass: 'read',
            actions: [],
            paths: [],
            hosts: [],
            network: false,
            externalWrite: false,
            destructive: false,
            credentials: false,
            admin: false,
            unknownRisk: false,
            resolvedAddresses: [],
            targets: [],
          },
          access: 'read',
          recoveryClass: 'read',
          concurrency: 'read',
          resourceKeys: [`runtime:${name}`],
          limits: context.limits,
        }),
        execute: options.handlers?.[name] ?? (() => ({})),
      },
    };
  }));
  return registry;
}
