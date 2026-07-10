import type {
  ConnectionId,
  ConnectionStatus,
  DatabaseEngine,
  QueryResultRow,
  QueryRiskLevel,
  TableDetail,
  TableSummary,
  UsageMode,
} from './domain.js';
import type { Result } from './result.js';

export const ipcChannels = {
  connection: {
    list: 'connection:list',
    test: 'connection:test',
    create: 'connection:create',
    update: 'connection:update',
    remove: 'connection:remove',
    connect: 'connection:connect',
    disconnect: 'connection:disconnect',
  },
  db: {
    executeQuery: 'db:execute-query',
    cancelQuery: 'db:cancel-query',
    queryHistory: 'db:query-history',
    createQuerySnapshot: 'db:create-query-snapshot',
    listQuerySnapshots: 'db:list-query-snapshots',
    getQuerySnapshot: 'db:get-query-snapshot',
    deleteQuerySnapshot: 'db:delete-query-snapshot',
    explainQuery: 'db:explain-query',
    listTables: 'db:list-tables',
    describeTable: 'db:describe-table',
  },
  app: {
    loadWorkspaceState: 'app:load-workspace-state',
    saveWorkspaceState: 'app:save-workspace-state',
    loadIdeSettings: 'app:load-ide-settings',
    saveIdeSettings: 'app:save-ide-settings',
    generateDiagnosticReport: 'app:generate-diagnostic-report',
  },
  workspace: {
    chooseDirectory: 'workspace:choose-directory',
    create: 'workspace:create',
    open: 'workspace:open',
    listRecent: 'workspace:list-recent',
    loadActive: 'workspace:load-active',
    listFiles: 'workspace:list-files',
    readFile: 'workspace:read-file',
    writeFile: 'workspace:write-file',
    createDirectory: 'workspace:create-directory',
    renameFile: 'workspace:rename-file',
    deleteFile: 'workspace:delete-file',
    deleteDirectory: 'workspace:delete-directory',
    saveSqlFile: 'workspace:save-sql-file',
    updateSettings: 'workspace:update-settings',
  },
  auth: {
    login: 'auth:login',
    register: 'auth:register',
    requestCode: 'auth:request-code',
    verifyCodeLogin: 'auth:verify-code-login',
    resetPassword: 'auth:reset-password',
    logout: 'auth:logout',
    status: 'auth:status',
  },
  python: {
    detect: 'python:detect',
    choosePath: 'python:choose-path',
    createEnvironment: 'python:create-environment',
    verifyDependencies: 'python:verify-dependencies',
    installDependencies: 'python:install-dependencies',
    runScript: 'python:run-script',
  },
  terminal: {
    create: 'terminal:create',
    close: 'terminal:close',
    clear: 'terminal:clear',
    resize: 'terminal:resize',
    write: 'terminal:write',
    read: 'terminal:read',
    run: 'terminal:run',
    list: 'terminal:list',
  },
  plugin: {
    list: 'plugin:list',
    install: 'plugin:install',
    uninstall: 'plugin:uninstall',
    enable: 'plugin:enable',
    disable: 'plugin:disable',
  },
  mcp: {
    list: 'mcp:list',
    upsert: 'mcp:upsert',
    remove: 'mcp:remove',
    start: 'mcp:start',
    stop: 'mcp:stop',
    startAutoStart: 'mcp:start-autostart',
    restartDue: 'mcp:restart-due',
    health: 'mcp:health',
    marketSearch: 'mcp:market-search',
    marketInstall: 'mcp:market-install',
  },
  skills: {
    match: 'skills:match',
  },
  agent: {
    toolPolicyPreview: 'agent:tool-policy-preview',
    run: 'agent:run',
    abort: 'agent:abort',
    recoverablePlans: 'agent:recoverable-plans',
    continuePlan: 'agent:continue-plan',
    restartPlan: 'agent:restart-plan',
    abandonPlan: 'agent:abandon-plan',
    recoverableCheckpoints: 'agent:recoverable-checkpoints',
    continueCheckpoint: 'agent:continue-checkpoint',
    restartCheckpoint: 'agent:restart-checkpoint',
    abandonCheckpoint: 'agent:abandon-checkpoint',
    sessions: 'agent:sessions',
    session: 'agent:session',
    updateSession: 'agent:update-session',
    archiveSession: 'agent:archive-session',
    deleteSession: 'agent:delete-session',
    forkSession: 'agent:fork-session',
    exportSession: 'agent:export-session',
    streams: 'agent:streams',
    stream: 'agent:stream',
    recoverableStreams: 'agent:recoverable-streams',
  },
  usage: {
    currentQuota: 'usage:current-quota',
    history: 'usage:history',
  },
} as const;

export type SavedConnection = {
  id: ConnectionId;
  name: string;
  engine: DatabaseEngine;
  host: string;
  port: number;
  database: string;
  username: string;
  ssl?: boolean;
  readOnly: boolean;
  connectionTimeoutMs?: number;
  statementTimeoutMs?: number;
  status: ConnectionStatus;
  createdAt: string;
  updatedAt: string;
};

export type ConnectionInput = {
  name: string;
  engine: DatabaseEngine;
  host: string;
  port: number;
  database: string;
  username: string;
  password?: string;
  ssl?: boolean;
  readOnly?: boolean;
  connectionTimeoutMs?: number;
  statementTimeoutMs?: number;
};

export type QueryRequest = {
  queryId?: string;
  connectionId: ConnectionId;
  sql: string;
  params?: unknown[];
  limit?: number;
  dryRun?: boolean;
  confirmed?: boolean;
  transactionMode?: QueryTransactionMode;
};

export type QueryTransactionMode = 'auto' | 'rollback';

export type QuerySafetyReport = {
  statementKind: string;
  riskLevel: QueryRiskLevel;
  requiresConfirmation: boolean;
  blocked: boolean;
  reasons: string[];
  performanceWarnings?: SqlPerformanceWarning[];
};

export type SqlPerformanceWarning = {
  code:
    | 'SELECT_STAR'
    | 'MISSING_LIMIT'
    | 'LEADING_WILDCARD_LIKE'
    | 'LARGE_OFFSET'
    | 'CARTESIAN_JOIN'
    | 'FUNCTION_ON_FILTER_COLUMN';
  message: string;
  severity: 'info' | 'warning';
};

export type QueryExecutionResult = {
  queryId: string;
  columns: Array<{ name: string; dataType?: string }>;
  rows: QueryResultRow[];
  rowCount: number;
  returnedRowCount?: number;
  rowLimit?: number;
  hasMore?: boolean;
  truncated?: boolean;
  elapsedMs: number;
  safety: QuerySafetyReport;
  transaction?: QueryTransactionReport;
  resultSets?: QueryResultSet[];
  messages?: QueryExecutionMessage[];
};

export type QueryTransactionReport = {
  mode: QueryTransactionMode;
  started: boolean;
  committed: boolean;
  rolledBack: boolean;
  rollbackOnly: boolean;
};

export type QueryResultSet = {
  index: number;
  command: string;
  columns: Array<{ name: string; dataType?: string }>;
  rows: QueryResultRow[];
  rowCount: number;
  returnedRowCount?: number;
  rowLimit?: number;
  hasMore?: boolean;
  truncated?: boolean;
};

export type QueryExecutionMessage = {
  level: 'info' | 'warning';
  message: string;
  statementIndex?: number;
};

export type QueryCancelRequest = {
  queryId: string;
};

export type QueryCancellationDecision =
  | 'cancel-backend'
  | 'disconnect-connection'
  | 'already-finished'
  | 'not-found';

export type QueryCancelResponse = {
  queryId: string;
  connectionId?: ConnectionId;
  decision: QueryCancellationDecision;
  backendPid?: number;
  retryAfterMs?: number;
  message: string;
};

export type QueryHistoryItem = {
  id: string;
  connectionId: ConnectionId;
  sql: string;
  status: 'success' | 'failed' | 'blocked' | 'cancelled';
  rowCount?: number;
  returnedRowCount?: number;
  rowLimit?: number;
  hasMore?: boolean;
  truncated?: boolean;
  elapsedMs?: number;
  errorMessage?: string;
  createdAt: string;
  safety: QuerySafetyReport;
  transaction?: QueryTransactionReport;
};

export type QueryHistoryRequest = {
  connectionId?: ConnectionId;
  limit?: number;
  offset?: number;
  searchText?: string;
  status?: QueryHistoryItem['status'] | QueryHistoryItem['status'][];
  riskLevel?: QueryRiskLevel | QueryRiskLevel[];
  statementKind?: string | string[];
  createdFrom?: string;
  createdTo?: string;
};

export type QuerySnapshotCellValue =
  | string
  | number
  | boolean
  | null
  | QuerySnapshotTypedValue
  | QuerySnapshotCellValue[]
  | { [key: string]: QuerySnapshotCellValue };

export type QuerySnapshotTypedValue =
  | { type: 'bigint'; value: string }
  | { type: 'date'; value: string }
  | { type: 'buffer'; encoding: 'base64'; value: string }
  | { type: 'number'; value: string };

export type QuerySnapshotRow = Record<string, QuerySnapshotCellValue>;

export type QuerySnapshot = {
  id: string;
  connectionId: ConnectionId;
  queryId: string;
  title: string;
  sql: string;
  columns: QueryExecutionResult['columns'];
  rows: QuerySnapshotRow[];
  rowCount: number;
  returnedRowCount?: number;
  rowLimit?: number;
  hasMore?: boolean;
  truncated?: boolean;
  elapsedMs: number;
  safety: QuerySafetyReport;
  tags: string[];
  note?: string;
  sourceHistoryId?: string;
  createdAt: string;
  updatedAt: string;
};

export type QuerySnapshotSummary = Omit<QuerySnapshot, 'rows'> & {
  previewRows: QuerySnapshotRow[];
};

export type CreateQuerySnapshotRequest = {
  connectionId: ConnectionId;
  sql: string;
  result: QueryExecutionResult;
  title?: string;
  tags?: string[];
  note?: string;
  sourceHistoryId?: string;
};

export type ListQuerySnapshotsRequest = {
  connectionId?: ConnectionId;
  searchText?: string;
  limit?: number;
  offset?: number;
  previewRowLimit?: number;
};

export type QuerySnapshotRequest = {
  id: string;
};

export type DeleteQuerySnapshotResponse = {
  id: string;
  deleted: boolean;
};

export type AuthStatus = {
  authenticated: boolean;
  capabilities?: AuthCapabilities;
  user?: {
    id: string;
    email: string;
    phone?: string;
    plan: 'free' | 'pro' | 'team';
  };
};

export type AuthCapabilities = {
  mode: 'local-test' | 'postgres';
  passwordLogin: boolean;
  verificationLogin: boolean;
  registration: boolean;
  passwordReset: boolean;
  testAccount: boolean;
};

export type AuthLoginRequest = {
  identifier: string;
  password: string;
};

export type AuthRegisterRequest = {
  email?: string;
  phone?: string;
  password: string;
  verificationCode: string;
};

export type AuthCodeRequest = {
  target: string;
  channel: 'email' | 'phone';
  purpose: 'register' | 'login' | 'reset-password';
};

export type AuthCodeResponse = {
  target: string;
  channel: 'email' | 'phone';
  expiresAt: string;
  devCode?: string;
};

export type AuthVerifyCodeLoginRequest = {
  target: string;
  channel: 'email' | 'phone';
  verificationCode: string;
};

export type AuthResetPasswordRequest = {
  target: string;
  channel: 'email' | 'phone';
  verificationCode: string;
  newPassword: string;
};

export type UsageSnapshot = {
  mode: UsageMode;
  windowStartedAt: string;
  windowEndsAt?: string;
  usedRounds: number;
  roundLimit?: number;
  byokTokenEstimate: number;
};

export type WorkspaceState = {
  activeConnectionId?: string;
  sqlDraft: string;
  updatedAt: string;
};

export type WorkspaceTemplate = 'minimal' | 'standard';

export type WorkspaceConnectionLink = {
  connectionId: ConnectionId;
  alias?: string;
  isDefault?: boolean;
  autoActivate?: boolean;
};

export type WorkspaceProject = {
  version: 1;
  id: string;
  name: string;
  rootPath: string;
  description?: string;
  template: WorkspaceTemplate;
  createdAt: string;
  updatedAt: string;
  connections: WorkspaceConnectionLink[];
  defaults: {
    connectionId?: ConnectionId;
    agentMode: 'ask' | 'auto' | 'full-auto' | 'readonly';
  };
  assetPaths: WorkspaceAssetPaths;
  python: WorkspacePythonConfig;
  enabledSkills: string[];
  enabledMcpServers: string[];
  tags: string[];
};

export type WorkspaceAssetPaths = {
  sqlLibrary: string;
  scripts: string;
  docs: string;
  outputs: string;
};

export type WorkspacePythonConfig = {
  mode: 'system' | 'venv' | 'conda';
  pythonPath?: string;
  venvPath?: string;
  condaEnvName?: string;
  condaPrefix?: string;
  requirementsPath: string;
};

export type IdeSettings = {
  appearance: {
    language: 'zh-CN' | 'en';
    theme: 'dark' | 'light';
    density: 'compact' | 'comfortable';
  };
  editor: {
    fontFamily: string;
    fontSize: number;
    tabSize: number;
    wordWrap: 'on' | 'off';
    minimap: boolean;
    lineNumbers: boolean;
  };
  terminal: {
    defaultShell: string;
    fontFamily: string;
    fontSize: number;
    scrollback: number;
    cursorBlink: boolean;
  };
};

export type DesktopDiagnosticReportRequest = {
  retentionDays?: number;
  maxEntryBytes?: number;
};

export type DesktopDiagnosticReportResult = {
  reportPath: string;
  artifactKind: 'directory';
  generatedAt: string;
  fileCount: number;
  totalBytes: number;
  summary: {
    configCount: number;
    logCount: number;
    crashSnapshotCount: number;
    redactionCount: number;
    omittedCount: number;
  };
};

export type McpTransport = 'stdio' | 'sse' | 'streamable-http';
export type McpServerSource = 'builtin' | 'user' | 'market';
export type McpEnvValue = string | { ref: string };
export type McpServerStatus =
  | 'stopped'
  | 'starting'
  | 'healthy'
  | 'unhealthy'
  | 'restarting'
  | 'disabled';

export type McpServerInput = {
  id?: string;
  name: string;
  source?: McpServerSource;
  transport?: McpTransport;
  autoStart?: boolean;
  enabled?: boolean;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, McpEnvValue>;
  description?: string;
  packageName?: string;
  marketEntryId?: string;
};

export type McpUpsertServerRequest = McpServerInput & {
  secrets?: Record<string, string>;
  start?: boolean;
};

export type McpSafeEnvValue = { kind: 'plain' } | { kind: 'secret-ref'; ref: string };

export type McpServerConfigPreview = {
  id: string;
  name: string;
  source: McpServerSource;
  transport: McpTransport;
  autoStart: boolean;
  enabled: boolean;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, McpSafeEnvValue>;
  description?: string;
  packageName?: string;
  marketEntryId?: string;
  installedAt: string;
  updatedAt: string;
};

export type McpResourceSamplePreview = {
  rssBytes?: number;
  cpuPercent?: number;
  sampledAt?: string;
};

export type McpServerHealthPreview = {
  serverId: string;
  status: McpServerStatus;
  healthy: boolean;
  restartCount: number;
  warnings: string[];
  lastStartedAt?: string;
  lastHealthyAt?: string;
  lastExitAt?: string;
  lastExitCode?: number;
  lastExitSignal?: string;
  lastError?: string;
  nextRestartAt?: string;
  resource?: McpResourceSamplePreview;
};

export type McpServerSummary = {
  server: McpServerConfigPreview;
  health: McpServerHealthPreview;
  tools: string[];
  running: boolean;
};

export type McpServerOperationResult = {
  serverId: string;
  server?: McpServerConfigPreview;
  tools: string[];
  removedTools: string[];
  health: McpServerHealthPreview;
  running: boolean;
  removed?: boolean;
  secretRefs?: string[];
};

export type McpMarketRequiredEnv = {
  name: string;
  title?: string;
  description?: string;
  required: boolean;
  secret: boolean;
};

export type McpMarketEntry = {
  id: string;
  marketId: string;
  name: string;
  description: string;
  publisher: string;
  categories: string[];
  transport: McpTransport;
  packageName?: string;
  rating?: number;
  downloads?: number;
  requiredEnv: McpMarketRequiredEnv[];
};

export type McpMarketSearchRequest = {
  marketId?: string;
  query?: string;
  category?: string;
  limit?: number;
};

export type McpMarketInstallRequest = {
  marketId: string;
  entryId: string;
  serverId?: string;
  name?: string;
  envPlain?: Record<string, string>;
  envSecrets?: Record<string, string>;
  autoStart?: boolean;
  enabled?: boolean;
  start?: boolean;
};

export type PythonEnvironmentInfo = {
  id: string;
  mode: WorkspacePythonConfig['mode'];
  label: string;
  pythonPath?: string;
  venvPath?: string;
  condaEnvName?: string;
  condaPrefix?: string;
  version?: string;
  valid: boolean;
  detail?: string;
};

export type PythonDetectRequest = {
  rootPath?: string;
};

export type PythonCreateEnvironmentRequest = {
  rootPath: string;
  mode: 'venv' | 'conda';
  name: string;
  pythonExecutable?: string;
};

export type PythonVerifyDependenciesRequest = {
  rootPath: string;
  config: WorkspacePythonConfig;
  modules: string[];
  timeoutMs?: number;
};

export type PythonDependencyCheck = {
  module: string;
  installed: boolean;
  detail?: string;
};

export type PythonVerifyDependenciesResult = {
  command: string;
  cwd: string;
  valid: boolean;
  checks: PythonDependencyCheck[];
  elapsedMs: number;
  stdout: string;
  stderr: string;
};

export type PythonInstallDependenciesRequest = {
  rootPath: string;
  config: WorkspacePythonConfig;
  requirementsPath?: string;
  packages?: string[];
  timeoutMs?: number;
  upgrade?: boolean;
};

export type PythonRunScriptRequest = {
  rootPath: string;
  config: WorkspacePythonConfig;
  code?: string;
  relativePath?: string;
  timeoutMs?: number;
};

export type PythonRunResult = {
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
};

export type TerminalSession = {
  id: string;
  name: string;
  cwd?: string;
  createdAt: string;
  shell?: string;
  pid?: number;
  status?: 'running' | 'exited';
  lastCommand?: string;
  lastExitCode?: number | null;
};

export type TerminalWriteRequest = {
  terminalId: string;
  data: string;
};

export type TerminalResizeRequest = {
  terminalId: string;
  cols: number;
  rows: number;
};

export type TerminalReadRequest = {
  terminalId: string;
  cursor: number;
};

export type TerminalReadResult = {
  terminalId: string;
  chunk: string;
  cursor: number;
  status: 'running' | 'exited';
  exitCode?: number | null;
};

export type TerminalRunRequest = {
  terminalId: string;
  command: string;
  cwd?: string;
  timeoutMs?: number;
};

export type PluginManifest = {
  id: string;
  name: string;
  publisher: string;
  version: string;
  description: string;
  official: boolean;
  builtin: boolean;
  enabled: boolean;
  installed: boolean;
  categories: Array<'database' | 'python' | 'visualization' | 'export' | 'productivity'>;
  activationEvents: string[];
  contributes: {
    commands?: Array<{
      id: string;
      title: string;
      category: string;
    }>;
    views?: Array<{
      id: string;
      title: string;
      location: 'left-sidebar' | 'right-sidebar' | 'bottom-panel' | 'settings';
    }>;
    configuration?: Array<{
      key: string;
      type: 'string' | 'number' | 'boolean' | 'enum';
      title: string;
      defaultValue: string | number | boolean;
      enumValues?: string[];
    }>;
  };
};

export type AgentMode = 'ask' | 'auto' | 'full-auto' | 'readonly';

export type AgentRunStrategy = 'auto' | 'react' | 'plan-execute';

export type AgentToolDangerLevel = 'safe' | 'medium' | 'high' | 'critical';

export type AgentToolPolicyRequest = {
  mode?: AgentMode;
  enabledPluginIds?: string[];
  disabledPluginIds?: string[];
  readonlyOnly?: boolean;
  allowedPermissions?: string[];
  maxDangerLevel?: AgentToolDangerLevel;
};

export type AgentToolPolicyPreview = {
  allowedToolNames: string[];
  blockedToolNames: string[];
  blockedToolDetails: AgentToolPolicyBlockPreview[];
  staticToolNames: string[];
  dynamicToolNames: string[];
  missingStaticToolNames: string[];
  missingStaticToolDetails: AgentMissingStaticToolPreview[];
  blockedByPluginToolDetails: AgentToolPolicyBlockPreview[];
  blockedBySkillToolDetails: AgentToolPolicyBlockPreview[];
  toolPermissions: AgentToolPermissionPreview[];
};

export type AgentToolPolicyBlockReason =
  | 'plugin-disabled'
  | 'static-tool-source-mismatch'
  | 'readonly-required'
  | 'danger-level-exceeds-limit'
  | 'permission-not-allowed'
  | 'no-plugin-contribution'
  | 'runtime-tool-missing'
  | 'skill-tool-not-allowed';

export type AgentToolPolicyBlockPreview = {
  toolName: string;
  blockedBy?: 'plugin' | 'skill';
  reason: AgentToolPolicyBlockReason;
  message: string;
  runtime?: {
    dangerLevel: AgentToolDangerLevel;
    readonly?: boolean;
    source?: string;
    sourceId?: string;
    originalName?: string;
  };
  pluginId?: string;
  pluginName?: string;
  contributionName?: string;
  dynamic?: boolean;
  contributionDangerLevel?: AgentToolDangerLevel;
  contributionReadonly?: boolean;
  requiredPermissions?: string[];
  allowedPermissions?: string[];
  maxDangerLevel?: AgentToolDangerLevel;
};

export type AgentMissingStaticToolPreview = {
  toolName: string;
  pluginId: string;
  pluginName: string;
  contributionName: string;
  requiredPermissions: string[];
  dangerLevel: AgentToolDangerLevel;
  readonly: boolean;
};

export type AgentToolPermissionPreview = {
  toolName: string;
  pluginId: string;
  pluginName: string;
  contributionName: string;
  dynamic: boolean;
  dangerLevel: AgentToolDangerLevel;
  readonly: boolean;
  runtime: {
    source?: string;
    sourceId?: string;
    originalName?: string;
  };
  permissions: Array<{
    id: string;
    title: string;
    risk: AgentToolDangerLevel;
    readonly: boolean;
    resourceScopes: string[];
    approvalPolicy: 'never' | 'mode-dependent' | 'always';
    networkAccess: 'none' | 'local' | 'remote';
    processAccess: 'none' | 'managed-child-process' | 'external-service';
    secretKinds: string[];
    auditLevel: 'none' | 'metadata' | 'metadata-and-arguments';
  }>;
};

export type AgentSkillSummary = {
  name: string;
  title?: string;
  description: string;
  source: 'builtin' | 'user' | 'workspace';
  sourcePath?: string;
  allowedTools: string[];
  outputFormat: 'markdown' | 'json' | 'text';
};

export type AgentSkillMatchReason = {
  type: 'keyword' | 'auto_inject_signal' | 'name' | 'title' | 'description';
  value: string;
  score: number;
};

export type AgentSkillMatchCandidate = {
  skill: AgentSkillSummary;
  score: number;
  reasons: AgentSkillMatchReason[];
  matchedSignals: string[];
  availableTools: string[];
  missingTools: string[];
  eligible: boolean;
};

export type SkillsMatchRequest = AgentToolPolicyRequest & {
  userInput: string;
  signals?: string[];
  inferSignals?: boolean;
  includeIneligible?: boolean;
  maxResults?: number;
  minScore?: number;
};

export type SkillsMatchResponse = {
  userInput: string;
  toolPolicy: AgentToolPolicyPreview;
  candidates: AgentSkillMatchCandidate[];
  selectedSkill?: AgentSkillMatchCandidate;
};

export type AgentRunRequest = SkillsMatchRequest & {
  runId?: string;
  providerId: string;
  model: string;
  strategy?: AgentRunStrategy;
  usageMode?: UsageMode;
  maxIterations?: number;
  maxPlanSteps?: number;
  stopOnStepFailure?: boolean;
  tokenBudget?: number;
  contextWindowTokens?: number;
  keepRecentMessages?: number;
  maxToolResultChars?: number;
  maxConsecutiveToolFailures?: number;
  maxToolExecutionMs?: number;
  userMessagePrefix?: string;
};

export type AgentToolExecution = {
  toolCallId: string;
  toolName: string;
  status: 'success' | 'denied' | 'failed';
  durationMs: number;
  resultPreview: string;
};

export type AgentPlanStepSnapshot = {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  resultSummary?: string;
  failureReason?: string;
  runStatus?: string;
  iterations?: number;
};

export type AgentRunPlanSummary = {
  id: string;
  title: string;
  goal: string;
  createdAt: string;
  steps: AgentPlanStepSnapshot[];
};

export type AgentPlanRecoveryAction = 'continue' | 'restart' | 'abandon';

export type AgentPlanRecoverySummary = {
  planId: string;
  sessionId?: string;
  title: string;
  goal: string;
  interruptedStepId?: string;
  interruptedStepTitle?: string;
  completedStepCount: number;
  failedStepCount: number;
  skippedStepCount: number;
  pendingStepCount: number;
  executedSteps: number;
  totalIterations: number;
  startedAt: string;
  updatedAt: string;
  lastResultText?: string;
  lastToolError?: string;
  resumePrompt: string;
  actions: AgentPlanRecoveryAction[];
};

export type AgentRecoverablePlansResponse = {
  plans: AgentPlanRecoverySummary[];
};

export type AgentCheckpointRecoveryAction = 'continue' | 'restart' | 'abandon';

export type AgentCheckpointRecoverySummary = {
  sessionId: string;
  title: string;
  userMessage: string;
  interruptedIteration: number;
  startedAt: string;
  updatedAt: string;
  completedToolCount: number;
  failedToolCount: number;
  deniedToolCount: number;
  lastAssistantText?: string;
  lastToolError?: string;
  resumePrompt: string;
  actions: AgentCheckpointRecoveryAction[];
};

export type AgentRecoverableCheckpointsResponse = {
  checkpoints: AgentCheckpointRecoverySummary[];
};

export type AgentRunResponse = {
  runId: string;
  strategy: Exclude<AgentRunStrategy, 'auto'>;
  status:
    | 'done'
    | 'aborted'
    | 'max_iterations_reached'
    | 'permission_denied'
    | 'safety_blocked'
    | 'tool_failed'
    | 'quota_exceeded'
    | 'planning_failed'
    | 'no_matching_skill'
    | 'failed';
  sessionId?: string;
  finalText: string;
  iterations: number;
  executedSteps?: number;
  totalIterations?: number;
  plan?: AgentRunPlanSummary;
  toolExecutions: AgentToolExecution[];
  toolPolicy: AgentToolPolicyPreview;
  candidates: AgentSkillMatchCandidate[];
  selectedSkill?: AgentSkillMatchCandidate;
  renderedUserMessage?: string;
  errorMessage?: string;
};

export type AgentContinuePlanRequest = AgentToolPolicyRequest & {
  planId: string;
  runId?: string;
  providerId: string;
  model: string;
  userMessage?: string;
  usageMode?: UsageMode;
  mode?: AgentMode;
  maxIterations?: number;
  maxPlanSteps?: number;
  stopOnStepFailure?: boolean;
  tokenBudget?: number;
  contextWindowTokens?: number;
  keepRecentMessages?: number;
  maxToolResultChars?: number;
  maxConsecutiveToolFailures?: number;
  maxToolExecutionMs?: number;
};

export type AgentContinuePlanResponse = AgentRunResponse & {
  recoveryPlan?: AgentPlanRecoverySummary;
  abandonedSnapshot: boolean;
};

export type AgentRestartPlanRequest = AgentContinuePlanRequest;

export type AgentRestartPlanResponse = AgentContinuePlanResponse;

export type AgentAbortRequest = {
  runId: string;
};

export type AgentAbortResponse = {
  runId: string;
  aborted: boolean;
  message: string;
};

export type AgentAbandonPlanRequest = {
  planId: string;
  reason?: string;
};

export type AgentAbandonPlanResponse = {
  planId: string;
  abandoned: boolean;
  message: string;
};

export type AgentContinueCheckpointRequest = AgentToolPolicyRequest & {
  sessionId: string;
  runId?: string;
  providerId: string;
  model: string;
  userMessage?: string;
  usageMode?: UsageMode;
  mode?: AgentMode;
  maxIterations?: number;
  tokenBudget?: number;
  contextWindowTokens?: number;
  keepRecentMessages?: number;
  maxToolResultChars?: number;
  maxConsecutiveToolFailures?: number;
  maxToolExecutionMs?: number;
};

export type AgentContinueCheckpointResponse = AgentRunResponse & {
  recoveryCheckpoint?: AgentCheckpointRecoverySummary;
  abandonedCheckpointCount: number;
};

export type AgentRestartCheckpointRequest = AgentContinueCheckpointRequest;

export type AgentRestartCheckpointResponse = AgentContinueCheckpointResponse;

export type AgentAbandonCheckpointRequest = {
  sessionId: string;
  reason?: string;
};

export type AgentAbandonCheckpointResponse = {
  sessionId: string;
  abandonedCheckpointCount: number;
  message: string;
};

export type AgentSessionMessage =
  | { role: 'user'; content: string; createdAt: string }
  | {
      role: 'assistant';
      content: string;
      toolCalls?: Array<{ id: string; name: string; arguments: unknown }>;
      createdAt: string;
    }
  | { role: 'tool'; toolCallId: string; toolName: string; content: string; createdAt: string }
  | { role: 'system'; content: string; createdAt: string };

export type AgentSessionSummary = {
  id: string;
  title: string;
  mode: AgentMode;
  strategy: Exclude<AgentRunStrategy, 'auto'>;
  archived: boolean;
  messageCount: number;
  toolMessageCount: number;
  tokenUsage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  createdAt: string;
  updatedAt: string;
  lastMessageAt?: string;
};

export type AgentSessionDetail = AgentSessionSummary & {
  messages: AgentSessionMessage[];
  aborted: boolean;
};

export type AgentSessionsRequest = {
  archived?: boolean;
  query?: string;
  limit?: number;
  offset?: number;
};

export type AgentSessionsResponse = {
  sessions: AgentSessionSummary[];
};

export type AgentSessionRequest = {
  sessionId: string;
};

export type AgentUpdateSessionRequest = AgentSessionRequest & {
  title?: string;
  mode?: AgentMode;
  aborted?: boolean;
};

export type AgentArchiveSessionRequest = AgentSessionRequest & {
  archived?: boolean;
};

export type AgentDeleteSessionResponse = {
  sessionId: string;
  deleted: boolean;
};

export type AgentForkSessionRequest = AgentSessionRequest & {
  fromMessageIndex: number;
  newSessionId?: string;
  title?: string;
};

export type AgentExportSessionRequest = AgentSessionRequest & {
  format: 'json' | 'markdown';
};

export type AgentExportSessionResponse = {
  sessionId: string;
  format: AgentExportSessionRequest['format'];
  content: string;
};

export type AgentStreamStatus = 'streaming' | 'complete' | 'incomplete' | 'failed' | 'aborted';

export type AgentStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call-delta'; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: 'tool-call'; toolCall: { id: string; name: string; arguments: unknown } }
  | { type: 'usage'; usage: AgentSessionSummary['tokenUsage'] }
  | {
      type: 'finish';
      response: {
        text: string;
        toolCalls: Array<{ id: string; name: string; arguments: unknown }>;
        usage?: AgentSessionSummary['tokenUsage'];
      };
      reason?: string;
    };

export type AgentStreamChunk = {
  sequence: number;
  event: AgentStreamEvent;
  createdAt: string;
};

export type AgentStreamSummary = {
  id: string;
  sessionId: string;
  roundId?: string;
  providerId: string;
  model: string;
  status: AgentStreamStatus;
  text: string;
  toolCallCount: number;
  chunkCount: number;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  errorMessage?: string;
};

export type AgentStreamDetail = AgentStreamSummary & {
  toolCalls: Array<{ id: string; name: string; arguments: unknown }>;
  usage?: AgentSessionSummary['tokenUsage'];
  chunks: AgentStreamChunk[];
};

export type AgentStreamsRequest = {
  sessionId: string;
};

export type AgentStreamRequest = {
  streamId: string;
};

export type AgentStreamsResponse = {
  streams: AgentStreamSummary[];
};

export type WorkspaceSummary = Pick<
  WorkspaceProject,
  'id' | 'name' | 'rootPath' | 'description' | 'template' | 'updatedAt' | 'tags'
>;

export type WorkspaceRecentState = {
  activeWorkspaceId?: string;
  workspaces: WorkspaceSummary[];
};

export type WorkspaceCreateRequest = {
  name: string;
  rootPath: string;
  description?: string;
  template?: WorkspaceTemplate;
  assetPaths?: Partial<WorkspaceAssetPaths>;
  python?: Partial<WorkspacePythonConfig>;
};

export type WorkspaceOpenRequest = {
  rootPath: string;
};

export type WorkspaceFileEntry = {
  name: string;
  relativePath: string;
  type: 'directory' | 'file';
  children?: WorkspaceFileEntry[];
};

export type WorkspaceSaveSqlFileRequest = {
  rootPath: string;
  name: string;
  sql: string;
  connectionId?: ConnectionId;
  description?: string;
  tags?: string[];
};

export type WorkspaceSavedFile = {
  name: string;
  relativePath: string;
  absolutePath: string;
  bytes: number;
  updatedAt: string;
};

export type WorkspaceUpdateSettingsRequest = {
  rootPath: string;
  assetPaths?: Partial<WorkspaceAssetPaths>;
  python?: Partial<WorkspacePythonConfig>;
};

export type WorkspaceReadFileRequest = {
  rootPath: string;
  relativePath: string;
};

export type WorkspaceWriteFileRequest = {
  rootPath: string;
  relativePath: string;
  content: string;
};

export type WorkspaceCreateDirectoryRequest = {
  rootPath: string;
  relativePath: string;
};

export type WorkspaceCreatedDirectory = {
  name: string;
  relativePath: string;
  absolutePath: string;
  updatedAt: string;
};

export type WorkspaceRenameFileRequest = {
  rootPath: string;
  fromRelativePath: string;
  toRelativePath: string;
};

export type WorkspaceDeleteFileRequest = {
  rootPath: string;
  relativePath: string;
};

export type WorkspaceDeletedFile = {
  relativePath: string;
};

export type WorkspaceDeleteDirectoryRequest = {
  rootPath: string;
  relativePath: string;
};

export type WorkspaceDeletedDirectory = {
  relativePath: string;
};

export type WorkspaceFileContent = {
  name: string;
  relativePath: string;
  content: string;
  bytes: number;
  updatedAt: string;
};

export type IpcRequestMap = {
  'connection:list': void;
  'connection:test': ConnectionInput;
  'connection:create': ConnectionInput;
  'connection:update': { id: ConnectionId; patch: Partial<ConnectionInput> };
  'connection:remove': { id: ConnectionId };
  'connection:connect': { id: ConnectionId };
  'connection:disconnect': { id: ConnectionId };
  'db:execute-query': QueryRequest;
  'db:cancel-query': QueryCancelRequest;
  'db:query-history': QueryHistoryRequest;
  'db:create-query-snapshot': CreateQuerySnapshotRequest;
  'db:list-query-snapshots': ListQuerySnapshotsRequest;
  'db:get-query-snapshot': QuerySnapshotRequest;
  'db:delete-query-snapshot': QuerySnapshotRequest;
  'db:explain-query': QueryRequest;
  'db:list-tables': { connectionId: ConnectionId };
  'db:describe-table': { connectionId: ConnectionId; schema: string; table: string };
  'auth:login': AuthLoginRequest;
  'auth:register': AuthRegisterRequest;
  'auth:request-code': AuthCodeRequest;
  'auth:verify-code-login': AuthVerifyCodeLoginRequest;
  'auth:reset-password': AuthResetPasswordRequest;
  'auth:logout': void;
  'auth:status': void;
  'python:detect': PythonDetectRequest;
  'python:choose-path': { title?: string; mode: 'file' | 'directory' };
  'python:create-environment': PythonCreateEnvironmentRequest;
  'python:verify-dependencies': PythonVerifyDependenciesRequest;
  'python:install-dependencies': PythonInstallDependenciesRequest;
  'python:run-script': PythonRunScriptRequest;
  'terminal:create': { cwd?: string; name?: string };
  'terminal:close': { id: string };
  'terminal:clear': { id: string };
  'terminal:resize': TerminalResizeRequest;
  'terminal:write': TerminalWriteRequest;
  'terminal:read': TerminalReadRequest;
  'terminal:run': TerminalRunRequest;
  'terminal:list': void;
  'plugin:list': void;
  'plugin:install': { id: string };
  'plugin:uninstall': { id: string };
  'plugin:enable': { id: string };
  'plugin:disable': { id: string };
  'mcp:list': void;
  'mcp:upsert': McpUpsertServerRequest;
  'mcp:remove': { id: string; deleteSecrets?: boolean };
  'mcp:start': { id: string };
  'mcp:stop': { id: string };
  'mcp:start-autostart': void;
  'mcp:restart-due': { now?: string } | undefined;
  'mcp:health': void;
  'mcp:market-search': McpMarketSearchRequest | undefined;
  'mcp:market-install': McpMarketInstallRequest;
  'skills:match': SkillsMatchRequest;
  'agent:tool-policy-preview': AgentToolPolicyRequest;
  'agent:run': AgentRunRequest;
  'agent:abort': AgentAbortRequest;
  'agent:recoverable-plans': void;
  'agent:continue-plan': AgentContinuePlanRequest;
  'agent:restart-plan': AgentRestartPlanRequest;
  'agent:abandon-plan': AgentAbandonPlanRequest;
  'agent:recoverable-checkpoints': void;
  'agent:continue-checkpoint': AgentContinueCheckpointRequest;
  'agent:restart-checkpoint': AgentRestartCheckpointRequest;
  'agent:abandon-checkpoint': AgentAbandonCheckpointRequest;
  'agent:sessions': AgentSessionsRequest | undefined;
  'agent:session': AgentSessionRequest;
  'agent:update-session': AgentUpdateSessionRequest;
  'agent:archive-session': AgentArchiveSessionRequest;
  'agent:delete-session': AgentSessionRequest;
  'agent:fork-session': AgentForkSessionRequest;
  'agent:export-session': AgentExportSessionRequest;
  'agent:streams': AgentStreamsRequest;
  'agent:stream': AgentStreamRequest;
  'agent:recoverable-streams': void;
  'usage:current-quota': void;
  'usage:history': { limit?: number };
  'app:load-workspace-state': void;
  'app:save-workspace-state': WorkspaceState;
  'app:load-ide-settings': void;
  'app:save-ide-settings': Partial<IdeSettings>;
  'app:generate-diagnostic-report': DesktopDiagnosticReportRequest | undefined;
  'workspace:choose-directory': { title?: string; buttonLabel?: string };
  'workspace:create': WorkspaceCreateRequest;
  'workspace:open': WorkspaceOpenRequest;
  'workspace:list-recent': void;
  'workspace:load-active': void;
  'workspace:list-files': { rootPath: string };
  'workspace:read-file': WorkspaceReadFileRequest;
  'workspace:write-file': WorkspaceWriteFileRequest;
  'workspace:create-directory': WorkspaceCreateDirectoryRequest;
  'workspace:rename-file': WorkspaceRenameFileRequest;
  'workspace:delete-file': WorkspaceDeleteFileRequest;
  'workspace:delete-directory': WorkspaceDeleteDirectoryRequest;
  'workspace:save-sql-file': WorkspaceSaveSqlFileRequest;
  'workspace:update-settings': WorkspaceUpdateSettingsRequest;
};

export type IpcResponseMap = {
  'connection:list': Result<SavedConnection[]>;
  'connection:test': Result<{ success: true; latencyMs: number }>;
  'connection:create': Result<SavedConnection>;
  'connection:update': Result<SavedConnection>;
  'connection:remove': Result<{ id: ConnectionId }>;
  'connection:connect': Result<SavedConnection>;
  'connection:disconnect': Result<SavedConnection>;
  'db:execute-query': Result<QueryExecutionResult>;
  'db:cancel-query': Result<QueryCancelResponse>;
  'db:query-history': Result<QueryHistoryItem[]>;
  'db:create-query-snapshot': Result<QuerySnapshot>;
  'db:list-query-snapshots': Result<QuerySnapshotSummary[]>;
  'db:get-query-snapshot': Result<QuerySnapshot>;
  'db:delete-query-snapshot': Result<DeleteQuerySnapshotResponse>;
  'db:explain-query': Result<QueryExecutionResult>;
  'db:list-tables': Result<TableSummary[]>;
  'db:describe-table': Result<TableDetail>;
  'auth:login': Result<AuthStatus>;
  'auth:register': Result<AuthStatus>;
  'auth:request-code': Result<AuthCodeResponse>;
  'auth:verify-code-login': Result<AuthStatus>;
  'auth:reset-password': Result<AuthStatus>;
  'auth:logout': Result<AuthStatus>;
  'auth:status': Result<AuthStatus>;
  'python:detect': Result<PythonEnvironmentInfo[]>;
  'python:choose-path': Result<{ path?: string }>;
  'python:create-environment': Result<PythonEnvironmentInfo>;
  'python:verify-dependencies': Result<PythonVerifyDependenciesResult>;
  'python:install-dependencies': Result<PythonRunResult>;
  'python:run-script': Result<PythonRunResult>;
  'terminal:create': Result<TerminalSession>;
  'terminal:close': Result<{ id: string }>;
  'terminal:clear': Result<{ id: string }>;
  'terminal:resize': Result<{ id: string; cols: number; rows: number }>;
  'terminal:write': Result<{ id: string }>;
  'terminal:read': Result<TerminalReadResult>;
  'terminal:run': Result<PythonRunResult>;
  'terminal:list': Result<TerminalSession[]>;
  'plugin:list': Result<PluginManifest[]>;
  'plugin:install': Result<PluginManifest>;
  'plugin:uninstall': Result<PluginManifest>;
  'plugin:enable': Result<PluginManifest>;
  'plugin:disable': Result<PluginManifest>;
  'mcp:list': Result<McpServerSummary[]>;
  'mcp:upsert': Result<McpServerOperationResult>;
  'mcp:remove': Result<McpServerOperationResult>;
  'mcp:start': Result<McpServerOperationResult>;
  'mcp:stop': Result<McpServerOperationResult>;
  'mcp:start-autostart': Result<McpServerOperationResult[]>;
  'mcp:restart-due': Result<McpServerOperationResult[]>;
  'mcp:health': Result<McpServerHealthPreview[]>;
  'mcp:market-search': Result<McpMarketEntry[]>;
  'mcp:market-install': Result<McpServerOperationResult>;
  'skills:match': Result<SkillsMatchResponse>;
  'agent:tool-policy-preview': Result<AgentToolPolicyPreview>;
  'agent:run': Result<AgentRunResponse>;
  'agent:abort': Result<AgentAbortResponse>;
  'agent:recoverable-plans': Result<AgentRecoverablePlansResponse>;
  'agent:continue-plan': Result<AgentContinuePlanResponse>;
  'agent:restart-plan': Result<AgentRestartPlanResponse>;
  'agent:abandon-plan': Result<AgentAbandonPlanResponse>;
  'agent:recoverable-checkpoints': Result<AgentRecoverableCheckpointsResponse>;
  'agent:continue-checkpoint': Result<AgentContinueCheckpointResponse>;
  'agent:restart-checkpoint': Result<AgentRestartCheckpointResponse>;
  'agent:abandon-checkpoint': Result<AgentAbandonCheckpointResponse>;
  'agent:sessions': Result<AgentSessionsResponse>;
  'agent:session': Result<AgentSessionDetail>;
  'agent:update-session': Result<AgentSessionSummary>;
  'agent:archive-session': Result<AgentSessionSummary>;
  'agent:delete-session': Result<AgentDeleteSessionResponse>;
  'agent:fork-session': Result<AgentSessionDetail>;
  'agent:export-session': Result<AgentExportSessionResponse>;
  'agent:streams': Result<AgentStreamsResponse>;
  'agent:stream': Result<AgentStreamDetail>;
  'agent:recoverable-streams': Result<AgentStreamsResponse>;
  'usage:current-quota': Result<UsageSnapshot>;
  'usage:history': Result<UsageSnapshot[]>;
  'app:load-workspace-state': Result<WorkspaceState | undefined>;
  'app:save-workspace-state': Result<WorkspaceState>;
  'app:load-ide-settings': Result<IdeSettings>;
  'app:save-ide-settings': Result<IdeSettings>;
  'app:generate-diagnostic-report': Result<DesktopDiagnosticReportResult>;
  'workspace:choose-directory': Result<{ path?: string }>;
  'workspace:create': Result<WorkspaceProject>;
  'workspace:open': Result<WorkspaceProject>;
  'workspace:list-recent': Result<WorkspaceRecentState>;
  'workspace:load-active': Result<WorkspaceProject | undefined>;
  'workspace:list-files': Result<WorkspaceFileEntry[]>;
  'workspace:read-file': Result<WorkspaceFileContent>;
  'workspace:write-file': Result<WorkspaceSavedFile>;
  'workspace:create-directory': Result<WorkspaceCreatedDirectory>;
  'workspace:rename-file': Result<WorkspaceSavedFile>;
  'workspace:delete-file': Result<WorkspaceDeletedFile>;
  'workspace:delete-directory': Result<WorkspaceDeletedDirectory>;
  'workspace:save-sql-file': Result<WorkspaceSavedFile>;
  'workspace:update-settings': Result<WorkspaceProject>;
};

export type IpcChannel = keyof IpcRequestMap;
