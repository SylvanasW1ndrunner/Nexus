export type WorkspaceTemplate = 'minimal' | 'standard';

export type WorkspacePythonMode = 'system' | 'venv' | 'conda' | 'embedded' | 'docker';

export type WorkspacePythonConfig = {
  mode: WorkspacePythonMode;
  pythonPath?: string;
  venvPath?: string;
  condaEnvName?: string;
  condaPrefix?: string;
  requirementsPath: string;
  timeoutSeconds: number;
  networkAllowed: boolean;
};

export type WorkspaceAssetPaths = {
  sqlLibrary: string;
  scripts: string;
  docs: string;
  outputs: string;
  skills: string;
};

export type WorkspaceConnectionLink = {
  connectionId: string;
  alias?: string;
  isDefault?: boolean;
  autoActivate?: boolean;
};

export type WorkspaceConfig = {
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
    connectionId?: string;
    agentMode: 'ask' | 'auto' | 'full-auto' | 'readonly';
  };
  assetPaths: WorkspaceAssetPaths;
  python: WorkspacePythonConfig;
  enabledSkills: string[];
  enabledMcpServers: string[];
  tags: string[];
};

export type WorkspaceCreateInput = {
  name: string;
  rootPath: string;
  description?: string;
  template?: WorkspaceTemplate;
  connections?: WorkspaceConnectionLink[];
  assetPaths?: Partial<WorkspaceAssetPaths>;
  python?: Partial<WorkspacePythonConfig>;
  tags?: string[];
};

export type WorkspaceFileEntry = {
  name: string;
  relativePath: string;
  type: 'file' | 'directory';
  children?: WorkspaceFileEntry[];
};

export type WorkspaceSavedFile = {
  relativePath: string;
  absolutePath: string;
  bytes: number;
  updatedAt: string;
};

export type WorkspaceScriptTool = {
  name: string;
  description: string;
  relativePath: string;
  params: Array<{ name: string; type?: string; description?: string }>;
};
