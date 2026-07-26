import type { LlmMessage, LlmTool, LlmToolCall, LlmUsage } from '@dbagent/core-llm';
import type { UsageMode } from '@dbagent/shared';
import type { AgentAuditLogWriter } from './audit-log-store.js';
import type { AgentCheckpointWriter } from './checkpoint-store.js';
import type { AgentSessionWriter } from './session-store.js';
import type { AgentStreamStore } from './stream-store.js';
import type { AgentRunCoordinator } from './run-coordinator.js';

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

export type AgentRunResult = {
  status: AgentRunStatus;
  session: AgentSession;
  finalText: string;
  iterations: number;
  toolExecutions: AgentToolExecutionRecord[];
  events?: AgentUserEvent[];
  artifacts?: AgentArtifactReference[];
  completion?: {
    verified: boolean;
    unresolvedTaskIds: string[];
  };
  contextCompression?: AgentContextCompressionReport[];
};

export type AgentRunOptions = {
  providerId: string;
  model: string;
  userMessage: string;
  userId?: string;
  initialSession?: AgentSession;
  initialIteration?: number;
  allowedTools?: string[];
  usageMode?: UsageMode;
  mode?: AgentMode;
  knowledgeSnapshot?: AgentKnowledgeSnapshotReference;
  maxIterations?: number;
  keepRecentMessages?: number;
  maxToolResultChars?: number;
  maxConsecutiveToolFailures?: number;
  maxToolExecutionMs?: number;
  project?: AgentProjectReference;
  projectInstructions?: string;
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

export type ToolDangerLevel = 'safe' | 'medium' | 'high' | 'critical';

export type ToolPermissionDecision = 'allow' | 'deny' | 'ask';

export type AgentToolSource =
  | 'database'
  | 'schema-rag'
  | 'user-mcp'
  | 'skill'
  | 'builtin'
  | 'unknown';

export type AgentToolDefinition = LlmTool & {
  dangerLevel: ToolDangerLevel;
  readonly?: boolean;
  source?: AgentToolSource;
  sourceId?: string;
  originalName?: string;
  requiredPermission?: AgentAccessMode;
  resolveRequiredPermission?: (args: Record<string, unknown>) => AgentAccessMode;
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
};

export type AgentToolHandler = (
  args: Record<string, unknown>,
  context: AgentToolContext,
) => unknown;

export type RegisteredAgentTool = AgentToolDefinition & {
  handler: AgentToolHandler;
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
  checkpointStore?: AgentCheckpointWriter;
  sessionStore?: AgentSessionWriter;
  streamStore?: AgentStreamStore;
  auditLog?: AgentAuditLogWriter;
  runCoordinator?: AgentRunCoordinator;
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
  | 'approval-required'
  | 'sql-executed'
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
  sql?: string;
  artifact?: AgentArtifactReference;
  metrics?: {
    durationMs?: number;
    rowCount?: number;
    affectedRows?: number;
  };
};

export type AgentUserEventDraft = Omit<AgentUserEvent, 'id' | 'sessionId' | 'createdAt'>;

export type AgentUserEventSink = (event: AgentUserEvent) => void | Promise<void>;

export type AgentSubagentStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export type AgentSubagentRecord = {
  id: string;
  parentSessionId: string;
  childSessionId?: string;
  task: string;
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
  modelContextTokens: number;
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
  modelContextTokens: number;
  reservedOutputTokens: number;
  availablePromptTokens: number;
  warningThresholdTokens: number;
  compactionThresholdTokens: number;
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
