import type { LlmMessage, LlmTool, LlmToolCall, LlmUsage } from '@dbagent/core-llm';
import type { UsageMode } from '@dbagent/shared';
import type { AgentAuditLogWriter } from './audit-log-store.js';
import type { AgentCheckpointWriter } from './checkpoint-store.js';
import type { AgentSessionWriter } from './session-store.js';
import type { AgentStreamStore } from './stream-store.js';

export type AgentMode = 'ask' | 'auto' | 'full-auto' | 'readonly';

export type AgentStrategy = 'react' | 'plan-execute';

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
  mode: AgentMode;
  strategy: AgentStrategy;
  messages: AgentMessage[];
  tokenUsage: LlmUsage;
  aborted: boolean;
};

export type AgentRunStatus =
  | 'done'
  | 'aborted'
  | 'max_iterations_reached'
  | 'permission_denied'
  | 'safety_blocked'
  | 'tool_failed'
  | 'quota_exceeded';

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
  initialSession?: AgentSession;
  initialIteration?: number;
  allowedTools?: string[];
  usageMode?: UsageMode;
  mode?: AgentMode;
  maxIterations?: number;
  tokenBudget?: number;
  contextWindowTokens?: number;
  keepRecentMessages?: number;
  maxToolResultChars?: number;
  maxConsecutiveToolFailures?: number;
  maxToolExecutionMs?: number;
  taskSafety?: AgentTaskSafetyPolicy;
  outputSafety?: AgentOutputSafetyPolicy;
  signal?: AbortSignal;
};

export type AgentPlanStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export type AgentPlanStep = {
  id: string;
  title: string;
  instruction: string;
  status: AgentPlanStepStatus;
  dependsOn?: string[];
  resultSummary?: string;
  failureReason?: string;
  runStatus?: AgentRunStatus;
  iterations?: number;
  toolExecutions?: AgentToolExecutionRecord[];
};

export type AgentPlan = {
  id: string;
  title: string;
  goal: string;
  createdAt: string;
  steps: AgentPlanStep[];
  plannerModelText: string;
};

export type AgentPlanExecutionStatus = 'done' | 'aborted' | 'failed' | 'planning_failed';

export type AgentPlanExecuteOptions = AgentRunOptions & {
  maxPlanSteps?: number;
  stopOnStepFailure?: boolean;
  initialPlan?: AgentPlan;
  initialExecutedSteps?: number;
  initialTotalIterations?: number;
};

export type AgentPlanExecuteResult = {
  status: AgentPlanExecutionStatus;
  plan: AgentPlan;
  session?: AgentSession;
  finalText: string;
  executedSteps: number;
  totalIterations: number;
  toolExecutions: AgentToolExecutionRecord[];
  contextCompression?: AgentContextCompressionReport[];
};

export type AgentPlanExecutionSnapshotStatus =
  | AgentPlanExecutionStatus
  | 'running'
  | 'abandoned';

export type AgentPlanExecutionSnapshot = {
  planId: string;
  status: AgentPlanExecutionSnapshotStatus;
  plan: AgentPlan;
  session?: AgentSession;
  finalText: string;
  executedSteps: number;
  totalIterations: number;
  toolExecutions: AgentToolExecutionRecord[];
  contextCompression?: AgentContextCompressionReport[];
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
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
  | 'workspace'
  | 'workspace-script'
  | 'user-mcp'
  | 'market-mcp'
  | 'skill'
  | 'official'
  | 'unknown';

export type AgentToolDefinition = LlmTool & {
  dangerLevel: ToolDangerLevel;
  readonly?: boolean;
  source?: AgentToolSource;
  sourceId?: string;
  originalName?: string;
};

export type AgentToolApproval = {
  granted: true;
  source: 'approval-provider';
  toolCallId: string;
  toolName: string;
  approvedAt: string;
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
};

export type ApprovalProvider = (request: PermissionRequest) => Promise<boolean> | boolean;

export type AgentRunDependencies = {
  now?: () => string;
  createSessionId?: () => string;
  checkpointStore?: AgentCheckpointWriter;
  sessionStore?: AgentSessionWriter;
  streamStore?: AgentStreamStore;
  auditLog?: AgentAuditLogWriter;
};

export type AgentContextCompressionLevel =
  | 'none'
  | 'tool-summary'
  | 'archive-early-messages';

export type AgentContextCompressionPhase =
  | 'healthy'
  | 'warning'
  | 'soft_compressed'
  | 'hard_compressed'
  | 'over_budget';

export type AgentContextCompressionStep = {
  type: Exclude<AgentContextCompressionLevel, 'none'>;
  beforeTokenEstimate: number;
  afterTokenEstimate: number;
  affectedMessageCount: number;
};

export type AgentContextCompressionReport = {
  phase: AgentContextCompressionPhase;
  level: AgentContextCompressionLevel;
  originalTokenEstimate: number;
  finalTokenEstimate: number;
  maxPromptTokens: number;
  warningThresholdTokens: number;
  softCompressionThresholdTokens: number;
  hardCompressionThresholdTokens: number;
  retainedMessageCount: number;
  toolCount: number;
  archivedMessageCount: number;
  summarizedToolResultCount: number;
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
    kind: 'official' | 'workspace' | 'manual';
    pluginId?: string;
    relativePath?: string;
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
