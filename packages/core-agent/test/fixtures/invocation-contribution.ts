import type { PortableValue } from '@dbagent/shared';
import type { ToolInvocationContribution } from '../../src/tool-registry.js';
import { PREPARED_TOOL_INTENT_REVISION, type ToolAccess, type ToolRecoveryClass } from '../../src/tools/tool-protocol.js';
import { preparedToolIntent } from '../permission-audit-fixture.js';

/** Current-contract test contribution: bounded prepare plus a plain Handler payload. */
export function invocationContribution(
  name: string,
  payload: PortableValue = {},
  options: Readonly<{
    toolRevision?: string;
    handlerRevision?: string;
    exposure?: 'direct' | 'deferred' | 'hidden' | 'disabled';
    access?: ToolAccess;
    recoveryClass?: ToolRecoveryClass;
    timeoutMs?: number;
  }> = {},
): ToolInvocationContribution {
  const toolRevision = options.toolRevision ?? `${name}@1`;
  const handlerRevision = options.handlerRevision ?? `${name}-handler@1`;
  const recoveryClass = options.recoveryClass ?? 'read';
  const access = options.access ?? (recoveryClass === 'read' ? 'read' : 'write');
  const readonly = access === 'read';
  const concurrency = readonly ? 'read' as const : 'write' as const;
  const timeoutMs = options.timeoutMs ?? 1_000;
  return {
    definition: {
      name, description: `Fixture Tool ${name}.`,
      inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'object' },
      dangerLevel: readonly ? 'safe' : 'medium', readonly, source: 'unknown',
      exposure: options.exposure ?? 'deferred', access, recoveryClass,
      toolRevision, handlerRevision, intentRevision: PREPARED_TOOL_INTENT_REVISION,
      limits: { timeoutMs, maxInputBytes: 4_096, maxOutputBytes: 65_536, maxArtifactBytes: 1_048_576, maxDepth: 8, maxRecords: 128 },
      execution: { concurrency, timeoutMs },
      failurePolicy: { onUnknown: { failureKind: 'unknown', retryable: false } },
    },
    runtime: {
      revision: { toolName: name, toolRevision, handlerRevision, intentRevision: PREPARED_TOOL_INTENT_REVISION },
      prepare: () => preparedToolIntent({
        toolName: name, toolRevision, handlerRevision, recoveryClass, timeoutMs,
      }).intent,
      execute: () => payload,
    },
  };
}
