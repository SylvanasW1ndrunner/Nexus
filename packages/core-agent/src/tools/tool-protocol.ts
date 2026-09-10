import type { PortableValue } from '@dbagent/shared';
import type { AgentToolConcurrency, AgentToolDescriptor, AgentToolPermissionFacts, RunPolicySnapshot } from '../types.js';
import type { ToolInvocationExecutionContext } from '../tool-registry.js';

export type ToolAccess = 'read' | 'write' | 'external' | 'destructive';
export type ToolRecoveryClass = 'read' | 'idempotent' | 'transactional' | 'non_idempotent';
export const PREPARED_TOOL_INTENT_REVISION = 'prepared-tool-intent.v1';

/** Hard ceilings, not defaults: every contribution must explicitly choose its own limits. */
export const TOOL_PROTOCOL_BOUNDS = Object.freeze({
  nameChars: 128,
  revisionChars: 128,
  descriptionChars: 16_384,
  labelChars: 256,
  labels: 64,
  descriptorBytes: 1_048_576,
  schemaBytes: 262_144,
  depth: 32,
  containerEntries: 10_000,
  actionChars: 4_096,
  resourceKeys: 128,
  resourceKeyChars: 4_096,
  facts: 128,
  factChars: 8_192,
  intentBytes: 16_777_216,
  /** The full intent plus bounded Journal identity and policy metadata. */
  journalEventBytes: 17_825_792,
  timeoutMs: 86_400_000,
  inputBytes: 8_388_608,
  outputBytes: 67_108_864,
  artifactBytes: 1_073_741_824,
});

export type InvocationLimits = Readonly<{
  timeoutMs: number;
  maxInputBytes: number;
  maxOutputBytes: number;
  maxArtifactBytes: number;
  maxDepth: number;
  maxRecords: number;
}>;

export type ToolActionSummary = Readonly<{ summary: string }>;

/** Contains only durable data. Open files, sockets and leases belong to execute. */
export type PreparedToolIntent<T extends PortableValue = Readonly<Record<string, PortableValue>>> = Readonly<{
  input: T;
  toolRevision: string;
  handlerRevision: string;
  intentRevision: typeof PREPARED_TOOL_INTENT_REVISION;
  targetIdentity: PortableValue;
  /** Runtime stamps the actual Run policy before persisting a new intent. */
  runPolicy?: RunPolicySnapshot;
  /** Host/backend generation selected during prepare, revalidated before execute. */
  generation: string;
  action: ToolActionSummary;
  permission: AgentToolPermissionFacts;
  access: ToolAccess;
  recoveryClass: ToolRecoveryClass;
  concurrency: AgentToolConcurrency;
  resourceKeys: readonly string[];
  limits: InvocationLimits;
}>;

/** No authorization or execution authority exists before prepare has completed. */
export type ToolPrepareContext = Readonly<Pick<ToolInvocationExecutionContext,
  'projectId' | 'sessionId' | 'runId' | 'turnId' | 'invocationId' | 'idempotencyKey' |
  'runtimeState' | 'discoverableTools' | 'discoverableCapabilities' | 'signal'
> & {
  hostId: string;
  runPolicy: RunPolicySnapshot;
  generation: string;
  descriptor: Readonly<AgentToolDescriptor>;
  toolRevision: string;
  handlerRevision: string;
  intentRevision: typeof PREPARED_TOOL_INTENT_REVISION;
  limits: InvocationLimits;
}>;

export type ToolExecuteContext<T extends PortableValue = Readonly<Record<string, PortableValue>>> =
  ToolInvocationExecutionContext & Readonly<{
    hostId: string;
    intent: PreparedToolIntent<T>;
    /** Persisted absolute deadline; recovery must not reset this clock. */
    deadline: string;
  }>;

export function assertInvocationLimits(value: InvocationLimits): void {
  if (value === null || typeof value !== 'object') throw new TypeError('Tool limits are required.');
  const ceilings: InvocationLimits = {
    timeoutMs: TOOL_PROTOCOL_BOUNDS.timeoutMs,
    maxInputBytes: TOOL_PROTOCOL_BOUNDS.inputBytes,
    maxOutputBytes: TOOL_PROTOCOL_BOUNDS.outputBytes,
    maxArtifactBytes: TOOL_PROTOCOL_BOUNDS.artifactBytes,
    maxDepth: TOOL_PROTOCOL_BOUNDS.depth,
    maxRecords: TOOL_PROTOCOL_BOUNDS.containerEntries,
  };
  for (const key of Object.keys(ceilings) as Array<keyof InvocationLimits>) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 1 || value[key] > ceilings[key]) {
      throw new TypeError(`Tool limits.${key} must be an integer from 1 to ${ceilings[key]}.`);
    }
  }
}
