import type { LlmMessage, LlmTool, LlmToolCall, LlmUsage } from '@dbagent/core-llm';
import type { UsageMode } from '@dbagent/shared';
import type { AgentAuditLogWriter } from './audit-log-store.js';
import type { AgentCheckpointWriter } from './checkpoint-store.js';
import type { AgentSessionWriter } from './session-store.js';
import type { AgentStreamStore } from './stream-store.js';

export type AgentAccessMode = 'read' | 'edit' | 'full';

/**
 * `ask`, `auto`, `full-auto`, and `readonly` remain accepted while callers
 * migrate. New database-facing APIs should use read/edit/full.
 */
export type AgentMode =
  | AgentAccessMode
  | 'ask'
  | 'auto'
  | 'full-auto'
  | 'readonly';

export type AgentStrategy = 'react';

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
  strategy: AgentStrategy;
  messages: AgentMessage[];
  tokenUsage: LlmUsage;
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

export type AgentRunStatus =
  | 'done'
  | 'aborted'
  | 'max_iterations_reached'
  | 'permission_denied'
  | 'safety_blocked'
  | 'tool_failed';

export type AgentRunResult = {
  status: AgentRunStatus;
  session: AgentSession;
  finalText: string;
  iterations: number;
  toolExecutions: AgentToolExecutionRecord[];
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
  taskSafety?: AgentTaskSafetyPolicy;
  outputSafety?: AgentOutputSafetyPolicy;
  signal?: AbortSignal;
};

export type AgentTaskSafetyPolicy =
  | false
  | {
      pii?: 'block' | 'allow';
      blockedFinalText?: string;
      extraSensitiveTerms?: string[];
      extraExtractionVerbs?: string[];
    };

export type AgentOutputSafetyPolicy =
  | false
  | {
      pii?: 'redact' | 'block' | 'allow';
      replacementText?: string;
      blockedToolResultText?: string;
      blockedFinalText?: string;
      extraSensitiveKeys?: string[];
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
  resolveRequiredPermission?: (
    args: Record<string, unknown>,
  ) => AgentAccessMode;
};

export type AgentToolApproval = {
  granted: true;
  source: 'approval-provider';
  toolCallId: string;
  toolName: string;
  approvedAt: string;
  requestId?: string;
  approvedBy?: string;
  reason?: string;
};

export type AgentToolContext = {
  session: AgentSession;
  signal?: AbortSignal;
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
  redacted?: boolean;
  blocked?: boolean;
  redactionReasons?: AgentOutputRedactionReason[];
  approval?: AgentToolApprovalRecord;
};

export type AgentToolApprovalRecord = {
  source: 'approval-provider';
  requestId?: string;
  approvedAt?: string;
  approvedBy?: string;
  reason?: string;
};

export type AgentOutputRedactionReason =
  | 'sensitive_key'
  | 'email'
  | 'phone'
  | 'id_card'
  | 'secret';

export type AgentToolFailureKind =
  | 'sql_repairable'
  | 'timeout'
  | 'transient_dependency'
  | 'output_safety'
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
  blocked?: boolean;
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
  redacted?: boolean;
  blocked?: boolean;
  redactionReasons?: AgentOutputRedactionReason[];
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
