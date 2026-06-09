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
    queryHistory: 'db:query-history',
    explainQuery: 'db:explain-query',
    listTables: 'db:list-tables',
    describeTable: 'db:describe-table',
  },
  app: {
    loadWorkspaceState: 'app:load-workspace-state',
    saveWorkspaceState: 'app:save-workspace-state',
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
    runScript: 'python:run-script',
  },
  terminal: {
    create: 'terminal:create',
    close: 'terminal:close',
    run: 'terminal:run',
    list: 'terminal:list',
  },
  plugin: {
    list: 'plugin:list',
    install: 'plugin:install',
    uninstall: 'plugin:uninstall',
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
  connectionId: ConnectionId;
  sql: string;
  limit?: number;
  dryRun?: boolean;
  confirmed?: boolean;
};

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
  elapsedMs: number;
  safety: QuerySafetyReport;
};

export type QueryHistoryItem = {
  id: string;
  connectionId: ConnectionId;
  sql: string;
  status: 'success' | 'failed' | 'blocked';
  rowCount?: number;
  elapsedMs?: number;
  errorMessage?: string;
  createdAt: string;
  safety: QuerySafetyReport;
};

export type AuthStatus = {
  authenticated: boolean;
  user?: {
    id: string;
    email: string;
    phone?: string;
    plan: 'free' | 'pro' | 'team';
  };
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

export type PythonRunScriptRequest = {
  rootPath: string;
  config: WorkspacePythonConfig;
  code: string;
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
  lastCommand?: string;
  lastExitCode?: number | null;
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
  enabled: boolean;
  installed: boolean;
  categories: Array<'database' | 'python' | 'visualization' | 'export' | 'productivity'>;
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
  'db:query-history': { connectionId?: ConnectionId; limit?: number };
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
  'python:run-script': PythonRunScriptRequest;
  'terminal:create': { cwd?: string; name?: string };
  'terminal:close': { id: string };
  'terminal:run': TerminalRunRequest;
  'terminal:list': void;
  'plugin:list': void;
  'plugin:install': { id: string };
  'plugin:uninstall': { id: string };
  'usage:current-quota': void;
  'usage:history': { limit?: number };
  'app:load-workspace-state': void;
  'app:save-workspace-state': WorkspaceState;
  'workspace:choose-directory': { title?: string; buttonLabel?: string };
  'workspace:create': WorkspaceCreateRequest;
  'workspace:open': WorkspaceOpenRequest;
  'workspace:list-recent': void;
  'workspace:load-active': void;
  'workspace:list-files': { rootPath: string };
  'workspace:read-file': WorkspaceReadFileRequest;
  'workspace:write-file': WorkspaceWriteFileRequest;
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
  'db:query-history': Result<QueryHistoryItem[]>;
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
  'python:run-script': Result<PythonRunResult>;
  'terminal:create': Result<TerminalSession>;
  'terminal:close': Result<{ id: string }>;
  'terminal:run': Result<PythonRunResult>;
  'terminal:list': Result<TerminalSession[]>;
  'plugin:list': Result<PluginManifest[]>;
  'plugin:install': Result<PluginManifest>;
  'plugin:uninstall': Result<PluginManifest>;
  'usage:current-quota': Result<UsageSnapshot>;
  'usage:history': Result<UsageSnapshot[]>;
  'app:load-workspace-state': Result<WorkspaceState | undefined>;
  'app:save-workspace-state': Result<WorkspaceState>;
  'workspace:choose-directory': Result<{ path?: string }>;
  'workspace:create': Result<WorkspaceProject>;
  'workspace:open': Result<WorkspaceProject>;
  'workspace:list-recent': Result<WorkspaceRecentState>;
  'workspace:load-active': Result<WorkspaceProject | undefined>;
  'workspace:list-files': Result<WorkspaceFileEntry[]>;
  'workspace:read-file': Result<WorkspaceFileContent>;
  'workspace:write-file': Result<WorkspaceSavedFile>;
  'workspace:save-sql-file': Result<WorkspaceSavedFile>;
  'workspace:update-settings': Result<WorkspaceProject>;
};

export type IpcChannel = keyof IpcRequestMap;
