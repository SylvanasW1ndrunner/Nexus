import type { LlmTool } from '@dbagent/core-llm';
import type { PortableValue } from '@dbagent/shared';
import type { InvocationLimits, ToolAccess, ToolRecoveryClass } from './tools/tool-protocol.js';

export type AgentPermissionMode = 'default' | 'auto' | 'full-access';
export type AgentMode = AgentPermissionMode;
export type RunPolicySnapshot = Readonly<{ mode: AgentMode; revision: string }>;

export type AgentCapabilityStateReference = {
  capabilityId: string;
  moduleId: string;
  instanceId: string;
  stateId: string;
  version: string;
};

export type AgentProjectReference = {
  rootPath: string;
  configDirectory: string;
};

export type AgentProjectContext = AgentProjectReference & {
  instructionsPath: string;
  settingsPath: string;
  skillsDirectory: string;
  artifactsDirectory: string;
  instructions?: string;
};

export type ToolDangerLevel = 'safe' | 'medium' | 'high' | 'critical';
export type ToolPermissionDecision = 'allow' | 'deny' | 'ask';
export type AgentToolSource = string;
export type ToolExposure = 'direct' | 'deferred' | 'hidden' | 'disabled';
export type AgentToolId = { namespace?: string; name: string };
export type AgentToolConcurrency = 'read' | 'write' | 'exclusive';

export type ToolPermissionAction =
  | 'read'
  | 'write'
  | 'execute'
  | 'network'
  | 'delete'
  | 'database-query'
  | 'database-mutation'
  | 'database-schema'
  | 'credential'
  | 'admin'
  | 'unknown';

/** Portable, model-independent policy metadata contributed by a Tool owner. */
export type AgentToolPermissionDeclaration = Readonly<{
  actions?: readonly ToolPermissionAction[];
  paths?: readonly string[];
  hosts?: readonly string[];
  network?: boolean;
  externalWrite?: boolean;
  destructive?: boolean;
  credentials?: boolean;
  admin?: boolean;
}>;

/** Complete immutable facts evaluated at the unique Tool invocation boundary. */
export type AgentToolPermissionFacts = Readonly<{
  toolName: string;
  dangerLevel: ToolDangerLevel;
  readonly: boolean;
  access: ToolAccess;
  recoveryClass: ToolRecoveryClass;
  actions: readonly ToolPermissionAction[];
  paths: readonly string[];
  hosts: readonly string[];
  network: boolean;
  externalWrite: boolean;
  destructive: boolean;
  credentials: boolean;
  admin: boolean;
  unknownRisk: boolean;
  /** Canonical addresses and target details resolved once during prepare. */
  resolvedAddresses: readonly string[];
  targets: readonly PortableValue[];
}>;

export type AgentPermissionRule = Readonly<{
  id: string;
  decision: ToolPermissionDecision;
  tools?: readonly string[];
  actions?: readonly string[];
  paths?: readonly string[];
  hosts?: readonly string[];
}>;

export type AgentToolExecutionMetadata = {
  concurrency: AgentToolConcurrency;
  timeoutMs: number;
};

export type AgentToolFailureKind =
  | 'repairable'
  | 'timeout'
  | 'transient_dependency'
  | 'permission'
  | 'tool_unavailable'
  | 'validation'
  | 'unknown';

export type AgentToolFailurePolicy = {
  onUnknown: { failureKind: AgentToolFailureKind; retryable: boolean };
};

export type AgentToolPresentation = {
  category?: string;
  preparingMessage?: string;
  inputPreview?: { argument: string; label: string; language?: string };
};

export type AgentToolProtocolMetadata = {
  protocol: 'mcp';
  taskSupport?: 'forbidden' | 'optional' | 'required';
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
};

export type AgentToolCompletionRole = 'none' | 'supporting' | 'deliverable';
export type AgentToolCompletionPolicy = { role: AgentToolCompletionRole; group?: string };

export type AgentToolDescriptor = {
  id: AgentToolId;
  flatName: string;
  title?: string;
  description: string;
  aliases: string[];
  tags: string[];
  inputSchema: LlmTool['inputSchema'];
  outputSchema: NonNullable<LlmTool['outputSchema']>;
  dangerLevel: ToolDangerLevel;
  readonly: boolean;
  source: AgentToolSource;
  sourceId?: string;
  exposure: ToolExposure;
  permission?: AgentToolPermissionDeclaration;
  access: ToolAccess;
  recoveryClass: ToolRecoveryClass;
  limits: InvocationLimits;
  toolRevision: string;
  handlerRevision: string;
  intentRevision: string;
  execution: AgentToolExecutionMetadata;
  failurePolicy: AgentToolFailurePolicy;
  completion?: AgentToolCompletionPolicy;
  presentation?: AgentToolPresentation;
  protocolMetadata?: AgentToolProtocolMetadata;
};

export type AgentToolDefinition = LlmTool & {
  namespace?: string;
  title?: string;
  aliases?: string[];
  tags?: string[];
  dangerLevel: ToolDangerLevel;
  readonly?: boolean;
  source?: AgentToolSource;
  sourceId?: string;
  originalName?: string;
  permission?: AgentToolPermissionDeclaration;
  access: ToolAccess;
  recoveryClass: ToolRecoveryClass;
  limits: InvocationLimits;
  outputSchema: NonNullable<LlmTool['outputSchema']>;
  toolRevision: string;
  handlerRevision: string;
  intentRevision: string;
  exposure?: ToolExposure;
  execution: AgentToolExecutionMetadata;
  failurePolicy: AgentToolFailurePolicy;
  completion?: AgentToolCompletionPolicy;
  presentation?: AgentToolPresentation;
  protocolMetadata?: AgentToolProtocolMetadata;
};

export type AgentToolCatalogChange =
  | { revision: number; kind: 'registered' | 'unregistered'; toolName: string; descriptor?: AgentToolDescriptor }
  | { revision: number; kind: 'owner-replaced'; ownerId: string; added: string[]; updated: string[]; removed: string[] };

export type AgentToolActivation = {
  toolName: string;
  toolGeneration: number;
  checkpointSequence?: number;
  taskPhase?: string;
  activatedAt: string;
};

export type AgentToolCompletionEvidence = {
  kind: string;
  deliveryReady: boolean;
  outcome?: 'pending' | 'succeeded' | 'failed' | 'cancelled';
  /** Runtime-minted identity of the exact Tool owner and captured generation. */
  provenance: Readonly<{
    issuer: 'runtime';
    ownerId: string;
    toolName: string;
    toolRevision: string;
    handlerRevision: string;
    intentRevision: string;
    toolSource: string;
    sourceId?: string;
    generation: string;
  }>;
  executionId?: string;
  summary?: string;
  metrics?: Readonly<Record<string, string | number | boolean | null>>;
  details?: Readonly<Record<string, PortableValue>>;
};

export type AgentToolAuditEvidence = {
  status: 'success' | 'denied' | 'failed';
  durationMs?: number;
  resultType?: string;
  argumentSummary?: string;
  failureKind?: AgentToolFailureKind;
};

export type AgentToolResultEnvelope = {
  type: 'schemanaut.agent-tool-result.v1';
  modelProjection: unknown;
  userProjection?: unknown;
  durableSummary: unknown;
  /** Provider-neutral durable evidence contributed by the Tool or Capability. */
  evidenceRefs?: readonly string[];
  auditEvidence?: AgentToolAuditEvidence;
  completionEvidence?: AgentToolCompletionEvidence;
};

export type AgentTaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';
export type AgentTaskEvidence = { kind: string; summary: string; reference?: string; createdAt: string };
export type AgentTaskItem = {
  id: string;
  title: string;
  description?: string;
  status: AgentTaskStatus;
  acceptanceCriteria: string[];
  dependsOn: string[];
  evidence: AgentTaskEvidence[];
  createdAt: string;
  updatedAt: string;
};
export type AgentTaskPlan = {
  version: 1;
  goal: string;
  tasks: AgentTaskItem[];
  createdAt: string;
  updatedAt: string;
};

export type AgentArtifactReference = {
  id: string;
  path: string;
  mediaType?: string;
  sizeBytes?: number;
  createdAt: string;
  source: string;
};
