import type { LlmMessage, LlmTool, LlmToolCall, LlmUsage } from '@dbagent/core-llm';
import type { UsageMode } from '@dbagent/shared';
import type { LlmGenerationConfig } from '@dbagent/core-llm';
import type { AgentAuditLogWriter } from './audit-log-store.js';
import type { AgentCheckpointWriter } from './checkpoint-store.js';
import type { AgentSessionWriter } from './session-store.js';
import type { AgentStreamStore } from './stream-store.js';
import type { AgentRunCoordinator } from './run-coordinator.js';
import type { AgentToolExecutionHook } from './tool-execution-router.js';

export type AgentAccessMode = 'read' | 'edit' | 'full';
export type AgentMode = AgentAccessMode;

export type AgentMessage =
  | { role: 'user'; content: string; createdAt: string }
  | { role: 'assistant'; content: string; toolCalls?: LlmToolCall[]; createdAt: string }
  | { role: 'tool'; toolCallId: string; toolName: string; content: string; createdAt: string }
  | { role: 'system'; content: string; createdAt: string };

export type AgentMessageDraft =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: LlmToolCall[] }
  | { role: 'tool'; toolCallId: string; toolName: string; content: string }
  | { role: 'system'; content: string };

export type AgentSession = {
  id: string;
  title: string;
  userId?: string;
  mode: AgentMode;
  messages: AgentMessage[];
  tokenUsage: LlmUsage;
  project?: AgentProjectReference;
  taskPlan?: AgentTaskPlan;
  artifacts?: AgentArtifactReference[];
  activeTools?: string[];
  /** Catalog-scoped deferred tool activations. `activeTools` is retained for legacy Sessions. */
  toolActivations?: AgentToolActivation[];
  activeSkills?: AgentActivatedSkill[];
  /**
   * Private Markdown Skill overlays owned by this Session. Trusted runtimes
   * persist them with the Session; user-facing projections must omit them.
   */
  sessionSkills?: AgentSessionSkillOverlay[];
  /** Internal nesting level used to bound recursive sub-agent spawning. */
  subagentDepth?: number;
  knowledgeSnapshot?: AgentKnowledgeSnapshotReference;
  contextCheckpoint?: AgentContextCheckpoint;
  aborted: boolean;
};

export type AgentKnowledgeSnapshotReference = {
  connectionId: string;
  knowledgeSnapshotId: string;
  catalogRootHash: string;
  retrievalProfileId: string;
  indexVersion: string;
};

export type AgentRunStatus = 'done' | 'aborted' | 'max_iterations_reached';

export type AgentCompletionPhase = 'verify' | 'finalize' | 'done';

export type AgentCompletionVerification = {
  verified: boolean;
  deliveryReady: boolean;
  finalResponseReady: boolean;
  phase: AgentCompletionPhase;
  unresolvedTaskIds: string[];
  missing: string[];
  evidenceKinds: AgentToolCompletionEvidence['kind'][];
};

export type AgentRunResult = {
  runId: string;
  status: AgentRunStatus;
  session: AgentSession;
  finalText: string;
  iterations: number;
  toolExecutions: AgentToolExecutionRecord[];
  events?: AgentUserEvent[];
  artifacts?: AgentArtifactReference[];
  completion?: AgentCompletionVerification;
  contextCompression?: AgentContextCompressionReport[];
};

export type AgentRunRecordStatus =
  | 'running'
  | 'done'
  | 'aborted'
  | 'failed'
  | 'interrupted'
  | 'max_iterations_reached';

export type AgentRunRecord = {
  runId: string;
  sessionId: string;
  status: AgentRunRecordStatus;
  phase: 'act' | AgentCompletionPhase;
  iteration: number;
  finalText: string;
  toolExecutions: Array<{
    toolName: string;
    status: AgentToolExecutionRecord['status'];
    completionRole?: AgentToolCompletionRole;
    completionGroup?: string;
    completionEvidence?: AgentToolCompletionEvidence;
  }>;
  completion?: AgentCompletionVerification;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
};

export type AgentRunStore = {
  saveRun(record: AgentRunRecord): Promise<void>;
  getRun(runId: string): Promise<AgentRunRecord | undefined>;
  listRuns(sessionId?: string, limit?: number): Promise<AgentRunRecord[]>;
  recoverInterrupted(now?: string): Promise<number>;
};

export type AgentRunOptions = {
  providerId: string;
  model: string;
  userMessage: string;
  userId?: string;
  initialSession?: AgentSession;
  initialIteration?: number;
  allowedTools?: string[];
  /** Tools that remain directly visible even when dynamic discovery is enabled. */
  pinnedTools?: string[];
  usageMode?: UsageMode;
  mode?: AgentMode;
  knowledgeSnapshot?: AgentKnowledgeSnapshotReference;
  /** Provider-neutral generation options inherited by normal, finalization and compaction calls. */
  generation?: LlmGenerationConfig;
  maxIterations?: number;
  keepRecentMessages?: number;
  maxToolResultChars?: number;
  maxConsecutiveToolFailures?: number;
  maxToolExecutionMs?: number;
  project?: AgentProjectReference;
  projectInstructions?: string;
  systemPrompt?: AgentSystemPrompt;
  managedInstructions?: string[];
  capabilityInstructions?: string[];
  dynamicToolDiscovery?: boolean;
  skillCatalog?: AgentSkillCatalogEntry[];
  activatedSkills?: AgentActivatedSkill[];
  /** Session-private Markdown Skill overlays copied into a newly created Session. */
  sessionSkills?: AgentSessionSkillOverlay[];
  /** Internal nesting level used to bound recursive sub-agent spawning. */
  subagentDepth?: number;
  eventSink?: AgentUserEventSink;
  signal?: AbortSignal;
};

export type AgentSystemPrompt = {
  mode: 'append' | 'replace';
  content: string;
};

export type ToolDangerLevel = 'safe' | 'medium' | 'high' | 'critical';

export type ToolPermissionDecision = 'allow' | 'deny' | 'ask';

export type AgentToolSource =
  | 'database'
  | 'schema-rag'
  | 'user-mcp'
  | 'skill'
  | 'builtin'
  | 'unknown';

export type ToolExposure = 'direct' | 'deferred' | 'hidden' | 'disabled';

export type AgentToolId = {
  namespace?: string;
  name: string;
};

export type AgentToolConcurrency = 'read' | 'write' | 'exclusive';

export type AgentToolExecutionMetadata = {
  concurrency: AgentToolConcurrency;
  timeoutMs?: number;
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

export type AgentToolDescriptor = {
  id: AgentToolId;
  /** Provider-compatible name. It remains unique inside one Runtime catalog. */
  flatName: string;
  title?: string;
  description: string;
  aliases: string[];
  tags: string[];
  inputSchema: LlmTool['inputSchema'];
  outputSchema?: LlmTool['outputSchema'];
  dangerLevel: ToolDangerLevel;
  readonly: boolean;
  source: AgentToolSource;
  sourceId?: string;
  exposure: ToolExposure;
  requiredPermission?: AgentAccessMode;
  execution: AgentToolExecutionMetadata;
  completion?: AgentToolCompletionPolicy;
  protocolMetadata?: AgentToolProtocolMetadata;
};

export type AgentToolCompletionRole = 'none' | 'supporting' | 'deliverable';

export type AgentToolCompletionPolicy = {
  role: AgentToolCompletionRole;
  group?: string;
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
  requiredPermission?: AgentAccessMode;
  resolveRequiredPermission?: (args: Record<string, unknown>) => AgentAccessMode;
  exposure?: ToolExposure;
  execution?: Partial<AgentToolExecutionMetadata>;
  completion?: AgentToolCompletionPolicy;
  protocolMetadata?: AgentToolProtocolMetadata;
};

export type AgentToolApproval = {
  granted: true;
  source: 'approval-provider';
  /** The Session that owns this approval. It cannot authorize another Session. */
  sessionId: string;
  toolCallId: string;
  toolName: string;
  /** Exact access level approved for this Tool Call. */
  grantedPermission: AgentAccessMode;
  approvedAt: string;
  requestId?: string;
  approvedBy?: string;
  reason?: string;
};

export type AgentToolInvocation = {
  toolCallId: string;
  toolName: string;
  requiredPermission: AgentAccessMode;
};

export type AgentToolExecutionGrantClaim = AgentToolInvocation & {
  sessionId: string;
};

/**
 * Ephemeral, single-use authority for one approved Tool Call.
 *
 * This object is deliberately not persisted in Session state or public audit
 * records. A tool must claim it with the exact Session, Tool Call, tool name,
 * and permission that were approved.
 */
export type AgentToolExecutionGrant = {
  scope: 'single-tool-call';
  sessionId: string;
  toolCallId: string;
  toolName: string;
  grantedPermission: AgentAccessMode;
  claim: (input: AgentToolExecutionGrantClaim) => AgentToolApproval | undefined;
};

export type AgentToolContext = {
  session: AgentSession;
  /** Tools permitted by the current run policy, if it restricts the registry. */
  allowedTools?: readonly string[];
  /**
   * Signal for the complete parent Agent run. Unlike `signal`, this remains
   * valid after a fire-and-monitor tool handler returns.
   */
  runSignal?: AbortSignal;
  signal?: AbortSignal;
  /** Identity and computed permission of the Tool Call currently being executed. */
  invocation?: AgentToolInvocation;
  /** Present only for the currently approved Tool Call and consumable once. */
  executionGrant?: AgentToolExecutionGrant;
  /** Approval provenance for tool-specific handling and internal audit. */
  approval?: AgentToolApproval;
  /** Scope used when a discovery tool activates a deferred schema. */
  toolActivationScope?: {
    catalogRevision: number;
    checkpointSequence?: number;
    taskPhase?: string;
    activatedAt: string;
  };
};

export type AgentToolHandler = (
  args: Record<string, unknown>,
  context: AgentToolContext,
) => unknown;

export type RegisteredAgentTool = AgentToolDefinition & {
  descriptor: AgentToolDescriptor;
  handler: AgentToolHandler;
};

export type AgentToolRuntime = {
  id: AgentToolId;
  flatName: string;
  handler: AgentToolHandler;
};

export type AgentToolCatalogChange = {
  revision: number;
  kind: 'registered' | 'unregistered';
  toolName: string;
  descriptor?: AgentToolDescriptor;
};

export type AgentToolActivation = {
  toolName: string;
  catalogRevision: number;
  checkpointSequence?: number;
  taskPhase?: string;
  activatedAt: string;
};

export type AgentToolCompletionEvidence = {
  kind:
    | 'database-result'
    | 'database-write'
    | 'artifact'
    | 'file'
    | 'process'
    | 'mcp'
    | 'subagent'
    | 'generic';
  deliveryReady: boolean;
  outcome?: 'pending' | 'succeeded' | 'failed' | 'cancelled';
  /** Deterministic runtime evidence; omitted only for legacy/custom tools. */
  source?: 'runtime';
  executionId?: string;
  statementKinds?: string[];
  requiredPermission?: AgentAccessMode;
  rowCount?: number;
  returnedRowCount?: number;
  schemaRefresh?: 'not-required' | 'refreshed' | 'failed' | 'rolled-back';
  transactionOutcome?: 'committed' | 'rolled-back' | 'not-started';
};

export type AgentToolResultEnvelope = {
  type: 'schemanaut.agent-tool-result.v1';
  modelProjection: unknown;
  userProjection?: unknown;
  durableSummary: unknown;
  auditEvidence?: AgentToolAuditEvidence;
  completionEvidence?: AgentToolCompletionEvidence;
};

export type AgentToolAuditEvidence = {
  status: 'success' | 'denied' | 'failed';
  durationMs?: number;
  resultType?: string;
  argumentSummary?: string;
  failureKind?: AgentToolFailureKind;
};

export type AgentToolExecutionRecord = {
  toolCallId: string;
  toolName: string;
  status: 'success' | 'denied' | 'failed';
  durationMs: number;
  argumentPreview?: string;
  resultPreview: string;
  failureKind?: AgentToolFailureKind;
  retryable?: boolean;
  approval?: AgentToolApprovalRecord;
  completionEvidence?: AgentToolCompletionEvidence;
  completionRole?: AgentToolCompletionRole;
  completionGroup?: string;
};

export type AgentToolApprovalRecord = {
  source: 'approval-provider';
  requestId?: string;
  approvedAt?: string;
  approvedBy?: string;
  reason?: string;
};

export type AgentToolFailureKind =
  | 'sql_repairable'
  | 'timeout'
  | 'transient_dependency'
  | 'permission'
  | 'tool_unavailable'
  | 'validation'
  | 'unknown';

export type PermissionRequest = {
  mode: AgentMode;
  tool: AgentToolDefinition;
  toolCall: LlmToolCall;
  sessionId?: string;
  sessionTitle?: string;
  signal?: AbortSignal;
};

export type ApprovalProviderResult =
  | boolean
  | {
      approved: boolean;
      requestId?: string;
      approvedAt?: string;
      approvedBy?: string;
      reason?: string;
    };

export type ApprovalProvider = (
  request: PermissionRequest,
) => Promise<ApprovalProviderResult> | ApprovalProviderResult;

export type AgentRunDependencies = {
  now?: () => string;
  createSessionId?: () => string;
  createRunId?: () => string;
  checkpointStore?: AgentCheckpointWriter;
  sessionStore?: AgentSessionWriter;
  runStore?: AgentRunStore;
  streamStore?: AgentStreamStore;
  auditLog?: AgentAuditLogWriter;
  runCoordinator?: AgentRunCoordinator;
  toolHooks?: AgentToolExecutionHook[];
};

export type AgentProjectReference = {
  rootPath: string;
  configDirectory: string;
};

export type AgentProjectContext = AgentProjectReference & {
  instructionsPath: string;
  settingsPath: string;
  localSettingsPath: string;
  mcpConfigPath: string;
  skillsDirectory: string;
  sqlDirectory: string;
  artifactsDirectory: string;
  instructions?: string;
};

export type AgentTaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export type AgentTaskEvidence = {
  kind: 'tool-result' | 'database-result' | 'artifact' | 'user-confirmation' | 'observation';
  summary: string;
  reference?: string;
  createdAt: string;
};

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
  source: 'agent' | 'tool' | 'database-export' | 'subagent';
};

export type AgentSkillScope = 'system' | 'user' | 'project' | 'session';

export type AgentSkillCatalogEntry = {
  name: string;
  description: string;
  scope: AgentSkillScope;
};

export type AgentActivatedSkill = AgentSkillCatalogEntry & {
  instructions: string;
};

export type AgentSessionSkillOverlay = {
  /** Complete Agent Skills-compatible SKILL.md content. */
  content: string;
  /** Optional diagnostic source label; never exposed to the model. */
  sourcePath?: string;
};

export type AgentUserEventType =
  | 'goal-understood'
  | 'plan-updated'
  | 'exploring'
  | 'sql-prepared'
  | 'command-prepared'
  | 'approval-required'
  | 'sql-executed'
  | 'command-executed'
  | 'tool-failed'
  | 'correcting'
  | 'artifact-created'
  | 'completed'
  | 'needs-user-input';

export type AgentUserEvent = {
  id: string;
  sessionId: string;
  type: AgentUserEventType;
  message: string;
  createdAt: string;
  toolName?: string;
  sql?: string;
  command?: string;
  artifact?: AgentArtifactReference;
  metrics?: {
    durationMs?: number;
    rowCount?: number;
    affectedRows?: number;
    exitCode?: number | null;
  };
};

export type AgentUserEventDraft = Omit<AgentUserEvent, 'id' | 'sessionId' | 'createdAt'>;

export type AgentUserEventSink = (event: AgentUserEvent) => void | Promise<void>;

export type AgentSubagentStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type AgentSubagentContextStrategy = 'fresh' | 'fork';

export type AgentSubagentRecord = {
  id: string;
  parentSessionId: string;
  childSessionId?: string;
  task: string;
  contextStrategy: AgentSubagentContextStrategy;
  status: AgentSubagentStatus;
  depth: number;
  summary?: string;
  artifactReferences?: string[];
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * Durable boundary for child-Agent lifecycle records.
 *
 * The methods are intentionally synchronous because AgentSubagentPool keeps
 * get/list/stop synchronous and must recover records before it is observable.
 * AgentSessionStore implements this boundary with node:sqlite.
 */
export type AgentSubagentStore = {
  saveSubagent(record: AgentSubagentRecord): void;
  loadSubagent(id: string): AgentSubagentRecord | undefined;
  listSubagents(parentSessionId?: string): AgentSubagentRecord[];
};

export type AgentSubagentRunner = (options: AgentRunOptions) => Promise<AgentRunResult>;

export type SpawnAgentSubagentInput = {
  parentSessionId: string;
  task: string;
  contextStrategy?: AgentSubagentContextStrategy;
  depth?: number;
  options: AgentRunOptions;
};

export type AgentContextCompactionTrigger = 'auto' | 'manual';

export type AgentContextCompactionMethod = 'model' | 'deterministic-fallback';

/**
 * The active semantic checkpoint used to build the model's working context.
 *
 * `coveredConversationMessageCount` counts non-system messages in the durable
 * session history. The original messages remain untouched and exportable.
 */
export type AgentContextCheckpoint = {
  version: 1;
  sequence: number;
  trigger: AgentContextCompactionTrigger;
  method: AgentContextCompactionMethod;
  summary: string;
  coveredConversationMessageCount: number;
  sourceTokenEstimate: number;
  summaryTokenEstimate: number;
  modelContextTokens: number | null;
  createdAt: string;
  focus?: string;
};

export type AgentManualContextCompactionOptions = {
  providerId: string;
  model: string;
  session: AgentSession;
  usageMode?: UsageMode;
  focus?: string;
  allowedTools?: string[];
  generation?: LlmGenerationConfig;
  keepRecentMessages?: number;
  maxToolResultChars?: number;
  signal?: AbortSignal;
};

export type AgentContextCompactionResult = {
  status: 'compacted' | 'skipped';
  session: AgentSession;
  report: AgentContextCompressionReport;
  checkpoint?: AgentContextCheckpoint;
};

export type AgentUserPreference = {
  id: string;
  userId: string;
  key: string;
  value: string;
  confidence: number;
  sourceSessionId?: string;
  evidence?: string;
  createdAt: string;
  updatedAt: string;
};

export type AgentContextCompressionLevel =
  | 'none'
  | 'tool-output-masking'
  | 'conversation-checkpoint';

export type AgentContextCompressionPhase =
  | 'unknown_window'
  | 'healthy'
  | 'approaching_limit'
  | 'tool_outputs_masked'
  | 'compacted'
  | 'window_exceeded';

export type AgentContextCompressionStep = {
  type: Exclude<AgentContextCompressionLevel, 'none'>;
  beforeTokenEstimate: number;
  afterTokenEstimate: number;
  affectedMessageCount: number;
};

export type AgentContextCompressionReport = {
  phase: AgentContextCompressionPhase;
  level: AgentContextCompressionLevel;
  trigger: AgentContextCompactionTrigger | 'none';
  originalTokenEstimate: number;
  finalTokenEstimate: number;
  modelContextTokens: number | null;
  reservedOutputTokens: number | null;
  availablePromptTokens: number | null;
  warningThresholdTokens: number | null;
  compactionThresholdTokens: number | null;
  retainedMessageCount: number;
  toolCount: number;
  coveredConversationMessageCount: number;
  maskedToolResultCount: number;
  activeCheckpointSequence?: number;
  summaryTokenEstimate?: number;
  steps: AgentContextCompressionStep[];
  warnings: string[];
};

export type AgentContextBuildResult = {
  messages: LlmMessage[];
  tools: LlmTool[];
};

export type AgentBehaviorEvaluationCase = {
  id: string;
  userTask: string;
  expectedStatus?: AgentRunStatus;
  requiredToolCalls?: string[];
  forbiddenToolCalls?: string[];
  requiredToolStatuses?: Array<{
    toolName: string;
    status: AgentToolExecutionRecord['status'];
  }>;
  toolExpectations?: AgentBehaviorToolExpectation[];
  finalTextIncludes?: string[];
  finalTextExcludes?: string[];
  minIterations?: number;
  maxIterations?: number;
};

export type AgentBehaviorToolExpectation = {
  toolName: string;
  status?: AgentToolExecutionRecord['status'];
  minCalls?: number;
  maxCalls?: number;
  caseSensitive?: boolean;
  argumentIncludes?: string[];
  argumentExcludes?: string[];
  resultIncludes?: string[];
  resultExcludes?: string[];
};

export type AgentBehaviorEvaluationResult = {
  id: string;
  userTask: string;
  passed: boolean;
  failures: string[];
  observedStatus: AgentRunStatus;
  observedToolCalls: string[];
  observedToolDetails: AgentBehaviorObservedTool[];
  observedFinalText: string;
  observedIterations: number;
};

export type AgentBehaviorObservedTool = {
  toolCallId: string;
  toolName: string;
  status: AgentToolExecutionRecord['status'];
  argumentPreview?: string;
  resultPreview: string;
};

export type AgentBehaviorEvaluationSummary = {
  totalCases: number;
  passedCases: number;
  failedCases: number;
  passRate: number;
  results: AgentBehaviorEvaluationResult[];
};

export type AgentBehaviorEvaluationReportInput = {
  reportId?: string;
  suiteId: string;
  suiteName: string;
  summary: AgentBehaviorEvaluationSummary;
  generatedAt?: string;
  environment?: 'unit' | 'integration' | 'postgres' | 'llm-live' | 'manual';
  suiteSource?: {
    kind: 'builtin' | 'imported' | 'manual';
    skillName?: string;
    path?: string;
  };
  run?: {
    providerId?: string;
    model?: string;
    live?: boolean;
    postgres?: boolean;
    commit?: string;
  };
  notes?: string[];
};

export type AgentBehaviorEvaluationReportFile = {
  path: string;
  content: string;
  bytes: number;
};

export type AgentBehaviorEvaluationReport = {
  reportId: string;
  suiteId: string;
  suiteName: string;
  generatedAt: string;
  environment: NonNullable<AgentBehaviorEvaluationReportInput['environment']>;
  suiteSource?: AgentBehaviorEvaluationReportInput['suiteSource'];
  run: NonNullable<AgentBehaviorEvaluationReportInput['run']>;
  files: AgentBehaviorEvaluationReportFile[];
  summary: {
    totalCases: number;
    passedCases: number;
    failedCases: number;
    passRate: number;
  };
};
