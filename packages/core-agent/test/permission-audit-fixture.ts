import type { ToolInvocationJournalCommand } from '../src/events/agent-journal.js';
import { preparedIntentDigest } from '../src/tools/prepared-invocation.js';
import { PREPARED_TOOL_INTENT_REVISION, type PreparedToolIntent, type ToolAccess, type ToolRecoveryClass } from '../src/tools/tool-protocol.js';

type PermissionAudit = Extract<ToolInvocationJournalCommand, { action: 'validate' }>['permissionAudit'];
type ExecutionPermissionAudit = Extract<ToolInvocationJournalCommand, { action: 'start' }>['permissionAudit'];

export function permissionAudit(
  decision: 'allow' | 'ask' | 'deny',
  recoveryClass: ToolRecoveryClass = 'read',
  toolName = 'query_database',
): PermissionAudit {
  const access: ToolAccess = recoveryClass === 'read' ? 'read' : 'write';
  return {
    mode: 'default',
    policyRevision: 'permission-policy:test',
    matchedRuleIds: [],
    facts: {
      toolName, dangerLevel: recoveryClass === 'read' ? 'safe' : 'medium',
      readonly: recoveryClass === 'read', access, recoveryClass,
      actions: [recoveryClass === 'read' ? 'read' : 'write'],
      paths: [], hosts: [], network: false, externalWrite: false, destructive: false,
      credentials: false, admin: false, unknownRisk: false, resolvedAddresses: [], targets: [],
    },
  };
}

export function executionPermissionAudit(
  recoveryClass: ToolRecoveryClass = 'read',
  toolName = 'query_database',
  dangerLevel?: 'safe' | 'medium' | 'high' | 'critical',
): ExecutionPermissionAudit {
  const audit = permissionAudit('allow', recoveryClass, toolName);
  return {
    ...audit,
    ...(dangerLevel === undefined ? {} : { facts: { ...audit.facts, dangerLevel } }),
    decision: 'allow',
  };
}

/** A bounded prepared intent for Journal-level lifecycle fixtures. */
export function preparedToolIntent(options: Readonly<{
  toolName?: string;
  toolRevision?: string;
  handlerRevision?: string;
  recoveryClass?: ToolRecoveryClass;
  actionSummary?: string;
  timeoutMs?: number;
}> = {}): Readonly<{ intent: PreparedToolIntent; intentDigest: string }> {
  const toolName = options.toolName ?? 'query_database';
  const recoveryClass = options.recoveryClass ?? 'read';
  const access: ToolAccess = recoveryClass === 'read' ? 'read' : 'write';
  const readonly = access === 'read';
  const intent: PreparedToolIntent = {
    input: {},
    toolRevision: options.toolRevision ?? `${toolName}@1`,
    handlerRevision: options.handlerRevision ?? `${toolName}-handler@1`,
    intentRevision: PREPARED_TOOL_INTENT_REVISION,
    targetIdentity: { toolName },
    generation: 'fixture-generation@1',
    action: { summary: options.actionSummary ?? `Execute ${toolName}.` },
    permission: {
      toolName,
      dangerLevel: readonly ? 'safe' : 'medium',
      readonly,
      access,
      recoveryClass,
      actions: [readonly ? 'read' : 'write'],
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
    access,
    recoveryClass,
    concurrency: readonly ? 'read' : 'write',
    resourceKeys: [`fixture:${toolName}`],
    limits: {
      timeoutMs: options.timeoutMs ?? 1_000,
      maxInputBytes: 4_096,
      maxOutputBytes: 65_536,
      maxArtifactBytes: 1_048_576,
      maxDepth: 8,
      maxRecords: 128,
    },
  };
  return { intent, intentDigest: preparedIntentDigest(intent) };
}
