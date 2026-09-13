import type {
  LlmConnectionManager,
  LlmConnectionDiscovery,
  LlmCatalogModel,
  LlmEffectiveParameters,
  LlmModelCatalogFilter,
  LlmModelSelection,
  LlmChatRequest,
  LlmGenerationConfig,
  LlmMetricsSnapshot,
} from '@dbagent/core-llm';
import type {
  AgentCapabilityModuleRegistration,
  AgentCapabilitySnapshot,
  AgentMode,
  AgentRunLimits,
  ToolQuestion,
  ToolQuestionAnswer,
  ToolDangerLevel,
  ToolExposure,
  UserActivityEvent,
} from '@dbagent/core-agent';
import type { SkillCatalogEntry, SkillOverlay, SkillRefreshResult } from '@dbagent/core-skills';
import type {
  AgentWebAdapter,
  McpSecretResolver,
  McpServerInput,
  McpServerSource,
  McpServerStatus,
  McpTransport,
  ProcessRuntime,
} from '@dbagent/core-tools';
import type { UsageTracker } from '@dbagent/core-usage';
import type {
  PortableValue,
  UsageSnapshot,
} from '@dbagent/shared';
import type { UsageProjectionStatus } from '@dbagent/core-usage';
import type { ProjectSettingsStore } from './project-settings.js';
import type {
  GlobalConfigStore,
  GlobalPermissionRule,
  GlobalSecretResolver,
} from './global-config.js';

export type AgentSystemPrompt = Readonly<{
  mode: 'append' | 'replace';
  content: string;
}>;

/** Public bounds for the Runtime-owned durable child scheduler. */
export type AgentSubagentSchedulerConfig = Readonly<{
  maxConcurrentChildren?: number;
  maxDepth?: number;
  maxChildrenPerRoot?: number;
  maxTurnsPerChild?: number;
}>;

type AgentRuntimeBaseOptions = {
  /** Seeds only a newly created Session; it is never a Runtime-wide active model. */
  newSessionModel?: LlmModelSelection;
  tenantId?: string;
  stateDatabasePath?: string;
  projectDirectory?: string;
  userSkillsDirectory?: string;
  /**
   * Default Session-private Markdown Skills copied into each newly created
   * Session. Restored Sessions keep their own persisted overlay.
   */
  sessionSkills?: SkillOverlay[];
  /** Default user-controlled role instructions. Runtime protocol and permissions remain enforced. */
  systemPrompt?: AgentSystemPrompt;
  /** Optional capability guidance layered below the role and above Project instructions. */
  capabilityInstructions?: string[];
  /** Optional allow-list applied to every Agent run unless overridden per run. */
  allowedTools?: string[];
  /** Enables the durable ask_user barrier for an interactive Host such as Terminal. */
  interactive?: boolean;
  /** Lazily start trusted MCP configurations marked autoStart. Disabled by default. */
  autoStartMcp?: boolean;
  /** Bounds applied by the Runtime-owned durable child scheduler. */
  subagentScheduler?: AgentSubagentSchedulerConfig;
  /** Professional capabilities. Registration reads only static manifests. */
  modules?: readonly AgentCapabilityModuleRegistration[];
};

/** Private workspace host dependencies; no external SDK compatibility contract. */
export type AgentRuntimeOptions = AgentRuntimeBaseOptions & Readonly<{
  llmManager?: LlmConnectionManager;
  globalConfigStore?: GlobalConfigStore;
  /** Resolves host-owned secure references from the global config without exposing secret values. */
  globalSecretResolver?: GlobalSecretResolver;
  settingsStore?: ProjectSettingsStore;
  usageTracker?: UsageTracker;
  /** Closed with the owning runtime. */
  processRuntime?: ProcessRuntime;
  webAdapter?: AgentWebAdapter;
  mcpSecretResolver?: McpSecretResolver;
}>;

export type AgentRunInput = {
  message: string;
  /** Stable caller identity used to make Run creation idempotent. */
  clientRequestId?: string;
  sessionId?: string;
  /** Required when creating a Session unless the host supplied newSessionModel. */
  model?: LlmModelSelection;
  /** Session-level model parameters persisted with a new or explicitly switched model. */
  sessionParameters?: LlmGenerationConfig;
  /** Per-Run request parameters merged over the persisted Session model binding. */
  generation?: LlmGenerationConfig;
  /**
   * Session-private Markdown Skills for a new Session. This overrides the
   * Runtime default and cannot be supplied when resuming a Session.
   */
  sessionSkills?: SkillOverlay[];
  systemPrompt?: AgentSystemPrompt;
  capabilityInstructions?: string[];
  allowedTools?: string[];
  /** Cancels only preparation before the durable Run ingress is committed. */
  signal?: AbortSignal;
};


export type AgentRunResult = Readonly<{
  runId: string;
  sessionId: string;
  status: 'completed' | 'failed' | 'cancelled' | 'limit_reached' | 'interrupted';
  finalText: string;
  finalContentRef?: string;
  deliveryStatus?: 'not-required' | 'verified' | 'unverified';
  /** Exact immutable evidence snapshot revision adopted by the final delivery. */
  evidenceRevision: number;
  evidenceRefs: readonly string[];
  /** Present only for failed or interrupted Runs; sourced from the terminal Journal fact. */
  error?: Readonly<{ code: string; detail?: PortableValue }>;
}>;

export type AgentRunEventOptions = Readonly<{
  afterSequence?: number;
  signal?: AbortSignal;
}>;

export type AgentSteeringInput = Readonly<{
  message: string;
  clientRequestId?: string;
}>;

export type AgentApprovalDecision = Readonly<{
  approvalId: string;
  decision: 'approve' | 'deny';
  reason?: string;
}>;

export type AgentOutcomeResolution = Readonly<{
  invocationId: string;
  outcome: 'succeeded' | 'failed';
  summary: string;
}>;

export type AgentRiskyRetryAuthorization = Readonly<{
  invocationId: string;
  reason: string;
  clientRequestId?: string;
}>;

export type AgentPendingQuestion = Readonly<{
  invocationId: string;
  questionId: string;
  questionRevision: number;
  questions: readonly ToolQuestion[];
  deadline: string | null;
}>;

export type AgentQuestionAnswerInput = Readonly<{
  invocationId: string;
  questionId: string;
  questionRevision: number;
  answers: readonly ToolQuestionAnswer[];
  /** Stable identity for retrying the same logical answer. */
  clientRequestId?: string;
}>;

export type AgentQuestionCancelInput = Readonly<{
  invocationId: string;
  questionId: string;
  questionRevision: number;
  reason?: string;
  /** Stable identity for retrying the same logical cancellation. */
  clientRequestId?: string;
}>;

export type AgentRunResultOptions = Readonly<{
  signal?: AbortSignal;
}>;

export interface AgentRunHandle {
  readonly runId: string;
  readonly sessionId: string;
  events(options?: AgentRunEventOptions): AsyncIterable<UserActivityEvent>;
  result(options?: AgentRunResultOptions): Promise<AgentRunResult>;
  steer(input: AgentSteeringInput): Promise<void>;
  approve(input: AgentApprovalDecision): Promise<void>;
  resolveOutcome(input: AgentOutcomeResolution): Promise<void>;
  authorizeRiskyRetry(input: AgentRiskyRetryAuthorization): Promise<void>;
  pendingQuestions(): Promise<readonly AgentPendingQuestion[]>;
  answerQuestion(input: AgentQuestionAnswerInput): Promise<void>;
  cancelQuestion(input: AgentQuestionCancelInput): Promise<void>;
  cancel(reason?: string): Promise<void>;
  resume(limits?: AgentRunLimits): Promise<void>;
  compact(): Promise<void>;
}

export type { UserActivityEvent };

/**
 * User-facing conversation view. Internal tool messages, tool calls,
 * knowledge hashes and activated Skill instructions are deliberately omitted.
 */
export type AgentSessionView = {
  sessionId: string;
  title?: string;
  archived: boolean;
  runCount: number;
  messages: Array<{
    role: 'user' | 'assistant';
    content: string;
    createdAt: string;
  }>;
  model?: {
    connectionId: string;
    modelId: string;
    parameters?: LlmGenerationConfig;
  };
  skillRevision: number;
  createdAt: string;
  updatedAt: string;
};

export type AgentSessionListInput = {
  filter?: 'active' | 'archived' | 'all';
  limit?: number;
  cursor?: string;
};
export type AgentSessionListItem = {
  sessionId: string;
  title?: string;
  archived: boolean;
  runCount: number;
  createdAt: string;
  updatedAt: string;
};
export type AgentSessionListPage = Readonly<{
  items: readonly AgentSessionListItem[];
  hasMore: boolean;
  nextCursor?: string;
}>;
export type ConfigureSessionSkillsInput = Readonly<{
  sessionId: string;
  definitions: readonly SkillOverlay[];
  /** Optional optimistic-concurrency guard. Defaults to the latest visible revision. */
  expectedRevision?: number;
}>;
export type AgentSkillCatalogEntry = SkillCatalogEntry;

/** User-facing Skill provenance; internal revision identities intentionally stay private. */
export type AgentSkillInspection = AgentSkillCatalogEntry & Readonly<{
  sourcePath: string;
}>;

/** Sanitized Tool catalog entry; execution handlers and registry identities stay private. */
export type AgentToolSummary = Readonly<{
  name: string;
  title?: string;
  description: string;
  source: string;
  readonly: boolean;
  dangerLevel: ToolDangerLevel;
  exposure: ToolExposure;
}>;

export type AgentUsageSnapshot = UsageSnapshot;
export type AgentUsageProjectionStatus = UsageProjectionStatus;
export type AgentSkillRefreshResult = SkillRefreshResult;
export type AgentSkillListInput = {
  /** Omit for the shared system/user/Project catalog. */
  sessionId?: string;
};
export type McpServerRegistrationInput = McpServerInput;

export type McpServerSummary = {
  id: string;
  name: string;
  source: McpServerSource;
  transport: McpTransport;
  enabled: boolean;
  autoStart: boolean;
  running: boolean;
  status: McpServerStatus;
  healthy: boolean;
  warnings: string[];
};

export type McpServerStartSummary = {
  server: McpServerSummary;
  tools: string[];
};

export type McpServerStopSummary = {
  serverId: string;
  removedTools: string[];
  status: McpServerStatus;
};

export type AgentRuntimeStatus = {
  providerConfigured: boolean;
  llm: {
    modelCount: number;
    metrics: LlmMetricsSnapshot;
  };
  capabilities: AgentCapabilitySnapshot;
  connections: Array<{ id: string; name: string; endpoint: string }>;
  /** Bounded host-only diagnostics for isolated Context Provider failures. */
  contextProviderDiagnostics: Array<{ id: string; message: string }>;
  /** Global config is accepted only after model and permission consumers reconcile. */
  globalConfigSynchronization: {
    targetRevision: string;
    appliedRevision: string;
    synchronized: boolean;
    error?: 'Global configuration could not be fully applied.';
  };
};

export type LlmRuntimeCallOptions = {
  model: LlmModelSelection;
  taskType?: string;
  userId?: string;
  timeoutMs?: number;
  maxRetries?: number;
};

export type LlmRuntimeBatchItem = {
  request: LlmRuntimeChatRequest;
  options: LlmRuntimeCallOptions;
};

export type LlmRuntimeBatchOptions = {
  concurrency?: number;
};

export type SelectSessionModelInput = {
  sessionId: string;
  model: LlmModelSelection;
  parameters?: LlmGenerationConfig;
};

export type DiscoverLlmConnectionInput = {
  connectionId: string;
  inspectModelIds?: string[];
  signal?: AbortSignal;
};

export type DiscoverLlmConnectionResult = LlmConnectionDiscovery;

export type LlmConnectionSummary = {
  id: string;
  name: string;
  endpoint: string;
  hasApiKey: boolean;
  headerNames: string[];
};

export type ListLlmModelsInput = LlmModelCatalogFilter;
export type ListLlmModelsResult = LlmCatalogModel[];

export type GlobalConfigView = {
  path: string;
  revision: string;
  exists: boolean;
  connections: LlmConnectionSummary[];
  parameters: LlmGenerationConfig;
  permissionMode: AgentMode;
  requireSandbox: boolean;
  permissionRules: readonly GlobalPermissionRule[];
};

export type ProjectSettingsView = {
  path: string;
  revision: string;
  exists: boolean;
  mcpServerCount: number;
};

export type SessionLlmConfiguration = {
  model: LlmModelSelection;
  effectiveParameters: LlmEffectiveParameters;
  contextTokens: LlmCatalogModel['contextTokens'];
  maxInputTokens: LlmCatalogModel['maxInputTokens'];
  maxOutputTokens: LlmCatalogModel['maxOutputTokens'];
};

export type SetSessionParametersInput = {
  sessionId: string;
  parameters: LlmGenerationConfig;
};

/**
 * Provider-neutral direct model request supported by the canonical execution
 * path. Provider-only response formatting, metadata and reasoning-token knobs
 * are deliberately absent until every advertised protocol can preserve them.
 */
export type LlmRuntimeChatRequest = Pick<
  LlmChatRequest,
  'messages' | 'temperature' | 'topP' | 'maxTokens' | 'stop' | 'seed' | 'signal'
> & {
  tools?: Array<Pick<NonNullable<LlmChatRequest['tools']>[number], 'name' | 'description' | 'inputSchema'>>;
  reasoning?: Readonly<{ effort?: 'low' | 'medium' | 'high' }>;
};
