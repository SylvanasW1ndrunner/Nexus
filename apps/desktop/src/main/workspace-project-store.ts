import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  WorkspaceCreateRequest,
  WorkspaceFileContent,
  WorkspaceFileEntry,
  WorkspaceProject,
  WorkspaceReadFileRequest,
  WorkspaceRecentState,
  WorkspaceSavedFile,
  WorkspaceSaveSqlFileRequest,
  WorkspaceSummary,
  WorkspaceUpdateSettingsRequest,
  WorkspaceWriteFileRequest,
} from '@dbagent/shared';

const workspaceConfigRelativePath = join('.dbagent', 'workspace.json');
const defaultAssetPaths = {
  sqlLibrary: 'sql/analytics',
  scripts: 'scripts',
  docs: 'docs',
  outputs: 'outputs',
} as const;
const defaultPythonConfig = {
  mode: 'system',
  requirementsPath: 'scripts/requirements.txt',
} as const;

export class WorkspaceProjectStore {
  constructor(private readonly recentStatePath: string) {}

  async listRecent(): Promise<WorkspaceRecentState> {
    return this.loadRecentState();
  }

  async loadActive(): Promise<WorkspaceProject | undefined> {
    const state = await this.loadRecentState();
    const active = state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId);
    if (!active) return undefined;
    try {
      return this.loadProject(active.rootPath);
    } catch (error) {
      if (isMissingFileError(error)) return undefined;
      throw error;
    }
  }

  async create(request: WorkspaceCreateRequest): Promise<WorkspaceProject> {
    const name = normalizeName(request.name);
    const rootPath = normalizeRootPath(request.rootPath);
    const now = new Date().toISOString();
    const project: WorkspaceProject = {
      version: 1,
      id: randomUUID(),
      name,
      rootPath,
      ...(request.description?.trim() ? { description: request.description.trim() } : {}),
      template: request.template ?? 'standard',
      createdAt: now,
      updatedAt: now,
      connections: [],
      defaults: {
        agentMode: 'ask',
      },
      assetPaths: normalizeAssetPaths(request.assetPaths),
      python: normalizePythonConfig(request.python),
      enabledSkills: [],
      enabledMcpServers: [],
      tags: [],
    };

    await createWorkspaceStructure(project);
    await this.saveProject(project);
    await this.remember(project);
    return project;
  }

  async open(rootPath: string): Promise<WorkspaceProject> {
    const project = await this.loadProject(rootPath);
    await this.remember(project);
    return project;
  }

  async listFiles(rootPath: string): Promise<WorkspaceFileEntry[]> {
    const project = await this.loadProject(rootPath);
    const roots = uniqueTopLevelRoots(['sql', 'queries', project.assetPaths.scripts, project.assetPaths.docs, project.assetPaths.outputs]);
    const entries = await Promise.all(
      roots.map(async (directory) => {
        const absolutePath = join(project.rootPath, directory);
        try {
          const info = await stat(absolutePath);
          if (!info.isDirectory()) return undefined;
          return readDirectoryTree(project.rootPath, absolutePath, 3);
        } catch (error) {
          if (isMissingFileError(error)) return undefined;
          throw error;
        }
      }),
    );
    return entries.filter((entry): entry is WorkspaceFileEntry => Boolean(entry));
  }

  async readFile(request: WorkspaceReadFileRequest): Promise<WorkspaceFileContent> {
    const project = await this.loadProject(request.rootPath);
    const relativePath = normalizeWorkspaceRelativePath(request.relativePath);
    const absolutePath = resolveInside(project.rootPath, relativePath);
    const info = await stat(absolutePath);
    if (!info.isFile()) throw new Error('Workspace path is not a file.');
    if (info.size > 1024 * 1024) throw new Error('Workspace file is too large to open in the editor.');
    return {
      name: basename(relativePath),
      relativePath: toPortablePath(relativePath),
      content: await readFile(absolutePath, 'utf8'),
      bytes: info.size,
      updatedAt: info.mtime.toISOString(),
    };
  }

  async writeFile(request: WorkspaceWriteFileRequest): Promise<WorkspaceSavedFile> {
    const project = await this.loadProject(request.rootPath);
    const relativePath = normalizeWorkspaceRelativePath(request.relativePath);
    const absolutePath = resolveInside(project.rootPath, relativePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, request.content, 'utf8');
    const info = await stat(absolutePath);
    return {
      name: basename(relativePath),
      relativePath: toPortablePath(relativePath),
      absolutePath,
      bytes: info.size,
      updatedAt: info.mtime.toISOString(),
    };
  }

  async saveSqlFile(request: WorkspaceSaveSqlFileRequest): Promise<WorkspaceSavedFile> {
    const project = await this.loadProject(request.rootPath);
    const sql = request.sql.trim();
    if (!sql) throw new Error('SQL content is required.');
    const displayName = normalizeName(request.name);
    const relativePath = join(project.assetPaths.sqlLibrary, `${slugify(displayName)}.sql`);
    const absolutePath = resolveInside(project.rootPath, relativePath);
    const content = buildSqlFileContent({
      name: displayName,
      sql,
      ...(request.connectionId ? { connectionId: request.connectionId } : {}),
      ...(request.description ? { description: request.description } : {}),
      ...(request.tags ? { tags: request.tags } : {}),
    });
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, 'utf8');
    const info = await stat(absolutePath);
    return {
      name: displayName,
      relativePath: toPortablePath(relativePath),
      absolutePath,
      bytes: info.size,
      updatedAt: info.mtime.toISOString(),
    };
  }

  async updateSettings(request: WorkspaceUpdateSettingsRequest): Promise<WorkspaceProject> {
    const project = await this.loadProject(request.rootPath);
    const updated: WorkspaceProject = {
      ...project,
      assetPaths: {
        sqlLibrary: normalizeWorkspaceRelativeDirectory(request.assetPaths?.sqlLibrary ?? project.assetPaths.sqlLibrary),
        scripts: normalizeWorkspaceRelativeDirectory(request.assetPaths?.scripts ?? project.assetPaths.scripts),
        docs: normalizeWorkspaceRelativeDirectory(request.assetPaths?.docs ?? project.assetPaths.docs),
        outputs: normalizeWorkspaceRelativeDirectory(request.assetPaths?.outputs ?? project.assetPaths.outputs),
      },
      python: request.python ? normalizePythonConfig(request.python) : project.python,
      updatedAt: new Date().toISOString(),
    };
    await createConfiguredAssetDirectories(updated);
    await this.saveProject(updated);
    await this.remember(updated);
    return updated;
  }

  private async loadProject(rootPath: string): Promise<WorkspaceProject> {
    const normalizedRoot = normalizeRootPath(rootPath);
    const raw = await readFile(join(normalizedRoot, workspaceConfigRelativePath), 'utf8');
    const project = normalizeWorkspaceProject(JSON.parse(raw), normalizedRoot);
    return project;
  }

  private async saveProject(project: WorkspaceProject): Promise<void> {
    await writeJson(join(project.rootPath, workspaceConfigRelativePath), project);
  }

  private async remember(project: WorkspaceProject): Promise<void> {
    const state = await this.loadRecentState();
    const summary = toSummary(project);
    const workspaces = [
      summary,
      ...state.workspaces.filter((workspace) => workspace.id !== summary.id && workspace.rootPath !== summary.rootPath),
    ].slice(0, 12);
    await writeJson(this.recentStatePath, { activeWorkspaceId: summary.id, workspaces });
  }

  private async loadRecentState(): Promise<WorkspaceRecentState> {
    try {
      const state = JSON.parse(await readFile(this.recentStatePath, 'utf8')) as Partial<WorkspaceRecentState>;
      const workspaces = Array.isArray(state.workspaces)
        ? state.workspaces.map(normalizeWorkspaceSummary).filter((workspace): workspace is WorkspaceSummary => Boolean(workspace))
        : [];
      const activeWorkspaceId =
        typeof state.activeWorkspaceId === 'string' &&
        workspaces.some((workspace) => workspace.id === state.activeWorkspaceId)
          ? state.activeWorkspaceId
          : workspaces[0]?.id;
      return {
        ...(activeWorkspaceId ? { activeWorkspaceId } : {}),
        workspaces,
      };
    } catch (error) {
      if (isMissingFileError(error) || error instanceof SyntaxError) return { workspaces: [] };
      throw error;
    }
  }
}

function normalizeWorkspaceProject(input: unknown, rootPath: string): WorkspaceProject {
  if (!isRecord(input)) throw new Error('Invalid workspace.json: expected an object.');
  if (input.version !== 1) throw new Error('Invalid workspace.json: unsupported version.');
  if (typeof input.id !== 'string' || input.id.trim() === '') throw new Error('Invalid workspace.json: missing id.');
  if (typeof input.name !== 'string' || input.name.trim() === '') throw new Error('Invalid workspace.json: missing name.');
  if (typeof input.createdAt !== 'string' || typeof input.updatedAt !== 'string') {
    throw new Error('Invalid workspace.json: missing timestamps.');
  }

  return {
    version: 1,
    id: input.id,
    name: input.name.trim(),
    rootPath,
    ...(typeof input.description === 'string' && input.description.trim()
      ? { description: input.description.trim() }
      : {}),
    template: input.template === 'minimal' ? 'minimal' : 'standard',
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    connections: Array.isArray(input.connections) ? input.connections.filter(isWorkspaceConnectionLink) : [],
    defaults: {
      agentMode: normalizeAgentMode(isRecord(input.defaults) ? input.defaults.agentMode : undefined),
      ...(isRecord(input.defaults) && typeof input.defaults.connectionId === 'string'
        ? { connectionId: input.defaults.connectionId }
        : {}),
    },
    assetPaths: normalizeAssetPaths(input.assetPaths),
    python: normalizePythonConfig(input.python),
    enabledSkills: Array.isArray(input.enabledSkills)
      ? input.enabledSkills.filter((item): item is string => typeof item === 'string')
      : [],
    enabledMcpServers: Array.isArray(input.enabledMcpServers)
      ? input.enabledMcpServers.filter((item): item is string => typeof item === 'string')
      : [],
    tags: Array.isArray(input.tags) ? input.tags.filter((item): item is string => typeof item === 'string') : [],
  };
}

function normalizeWorkspaceSummary(input: unknown): WorkspaceSummary | undefined {
  if (!isRecord(input)) return undefined;
  if (typeof input.id !== 'string' || typeof input.name !== 'string' || typeof input.rootPath !== 'string') return undefined;
  if (typeof input.updatedAt !== 'string') return undefined;
  return {
    id: input.id,
    name: input.name,
    rootPath: normalizeRootPath(input.rootPath),
    ...(typeof input.description === 'string' && input.description.trim()
      ? { description: input.description.trim() }
      : {}),
    template: input.template === 'minimal' ? 'minimal' : 'standard',
    updatedAt: input.updatedAt,
    tags: Array.isArray(input.tags) ? input.tags.filter((item): item is string => typeof item === 'string') : [],
  };
}

function isWorkspaceConnectionLink(input: unknown): input is WorkspaceProject['connections'][number] {
  if (!isRecord(input) || typeof input.connectionId !== 'string') return false;
  if (input.alias !== undefined && typeof input.alias !== 'string') return false;
  if (input.isDefault !== undefined && typeof input.isDefault !== 'boolean') return false;
  if (input.autoActivate !== undefined && typeof input.autoActivate !== 'boolean') return false;
  return true;
}

async function createWorkspaceStructure(project: WorkspaceProject): Promise<void> {
  const directories =
    project.template === 'minimal'
      ? ['.dbagent', 'sql/_drafts', 'scripts', 'docs', 'outputs']
      : [
          '.dbagent',
          'queries/_drafts',
          'sql/analytics',
          'sql/ops',
          'sql/_drafts',
          'scripts/_runs',
          'skills',
          'docs/reports',
          'outputs',
          'notebooks',
        ];

  await Promise.all(directories.map((directory) => mkdir(join(project.rootPath, directory), { recursive: true })));
  await createConfiguredAssetDirectories(project);
  await writeStarterFiles(project);
}

async function createConfiguredAssetDirectories(project: WorkspaceProject): Promise<void> {
  const directories = [
    ...Object.values(project.assetPaths),
    dirname(project.python.requirementsPath),
    ...(project.python.mode === 'venv' && project.python.venvPath ? [project.python.venvPath] : []),
  ];
  await Promise.all(directories.map((directory) => mkdir(join(project.rootPath, directory), { recursive: true })));
}

async function writeStarterFiles(project: WorkspaceProject): Promise<void> {
  const files: Array<[string, string]> = [
    [
      'sql/README.md',
      `# ${project.name} SQL 库\n\n这里保存可复用 SQL。建议在 SQL 文件头部写入 @name、@description、@connection 和 @tags。\n`,
    ],
    [
      project.python.requirementsPath,
      '# DBAgent workspace script dependencies\npandas\nnumpy\n',
    ],
    ['docs/README.md', `# ${project.name} 文档\n\n这里保存 Schema 文档、ER 图、分析报告和人工整理资料。\n`],
  ];

  await Promise.all(files.map(([path, content]) => writeTextIfMissing(join(project.rootPath, path), content)));
}

async function readDirectoryTree(
  workspaceRoot: string,
  absolutePath: string,
  depth: number,
): Promise<WorkspaceFileEntry> {
  const relativePath = toPortablePath(relative(workspaceRoot, absolutePath));
  const name = relativePath.includes('/') ? relativePath.split('/').at(-1)! : relativePath;
  if (depth <= 0) return { name, relativePath, type: 'directory', children: [] };
  const children = await readdir(absolutePath, { withFileTypes: true });
  const visibleChildren = children
    .filter((entry) => !entry.name.startsWith('.'))
    .sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name));
  const childEntries = await Promise.all(
    visibleChildren.map(async (entry) => {
      const childPath = join(absolutePath, entry.name);
      const childRelativePath = toPortablePath(relative(workspaceRoot, childPath));
      if (entry.isDirectory()) return readDirectoryTree(workspaceRoot, childPath, depth - 1);
      return {
        name: entry.name,
        relativePath: childRelativePath,
        type: 'file' as const,
      };
    }),
  );
  return { name, relativePath, type: 'directory', children: childEntries };
}

function buildSqlFileContent({
  name,
  sql,
  connectionId,
  description,
  tags,
}: {
  name: string;
  sql: string;
  connectionId?: string;
  description?: string;
  tags?: string[];
}): string {
  const metadata = [
    `-- @name: ${name}`,
    ...(description?.trim() ? [`-- @description: ${description.trim()}`] : []),
    ...(connectionId ? [`-- @connection: ${connectionId}`] : []),
    ...(tags?.length ? [`-- @tags: [${tags.map((tag) => tag.trim()).filter(Boolean).join(', ')}]`] : []),
    `-- @updated: ${new Date().toISOString()}`,
  ];
  return `${metadata.join('\n')}\n\n${sql}\n`;
}

async function writeTextIfMissing(path: string, content: string): Promise<void> {
  try {
    await readFile(path, 'utf8');
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
    await writeFile(path, content, 'utf8');
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function toSummary(project: WorkspaceProject): WorkspaceSummary {
  return {
    id: project.id,
    name: project.name,
    rootPath: project.rootPath,
    ...(project.description ? { description: project.description } : {}),
    template: project.template,
    updatedAt: project.updatedAt,
    tags: project.tags,
  };
}

function normalizeName(name: string): string {
  const normalized = name.trim();
  if (!normalized) throw new Error('Workspace name is required.');
  return normalized;
}

function normalizeRootPath(rootPath: string): string {
  const normalized = rootPath.trim();
  if (!normalized) throw new Error('Workspace path is required.');
  return resolve(normalized);
}

function resolveInside(rootPath: string, relativePath: string): string {
  const root = normalizeRootPath(rootPath);
  const resolved = resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    throw new Error('Workspace path escapes are not allowed.');
  }
  return resolved;
}

function normalizeWorkspaceRelativePath(path: string): string {
  const normalized = path.trim().replace(/\\/g, '/');
  if (!normalized) throw new Error('Workspace file path is required.');
  if (isAbsolute(normalized) || normalized.includes('\0')) throw new Error('Invalid workspace file path.');
  const firstSegment = normalized.split('/')[0];
  if (!firstSegment || firstSegment.startsWith('.') || firstSegment === 'node_modules') {
    throw new Error('Workspace file must be inside a managed project directory.');
  }
  if (normalized.split('/').some((segment) => segment === '..')) throw new Error('Workspace path escapes are not allowed.');
  return normalized;
}

function normalizeWorkspaceRelativeDirectory(path: string): string {
  const normalized = path.trim().replace(/\\/g, '/').replace(/\/+$/g, '');
  if (!normalized) throw new Error('Workspace directory path is required.');
  if (isAbsolute(normalized) || normalized.includes('\0')) throw new Error('Invalid workspace directory path.');
  if (normalized.split('/').some((segment) => segment === '..')) throw new Error('Workspace path escapes are not allowed.');
  return normalized;
}

function normalizeAssetPaths(value: unknown): WorkspaceProject['assetPaths'] {
  if (!isRecord(value)) return { ...defaultAssetPaths };
  return {
    sqlLibrary:
      typeof value.sqlLibrary === 'string' ? normalizeWorkspaceRelativeDirectory(value.sqlLibrary) : defaultAssetPaths.sqlLibrary,
    scripts: typeof value.scripts === 'string' ? normalizeWorkspaceRelativeDirectory(value.scripts) : defaultAssetPaths.scripts,
    docs: typeof value.docs === 'string' ? normalizeWorkspaceRelativeDirectory(value.docs) : defaultAssetPaths.docs,
    outputs: typeof value.outputs === 'string' ? normalizeWorkspaceRelativeDirectory(value.outputs) : defaultAssetPaths.outputs,
  };
}

function normalizePythonConfig(value: unknown): WorkspaceProject['python'] {
  if (!isRecord(value)) return { ...defaultPythonConfig };
  const mode = value.mode === 'venv' || value.mode === 'conda' ? value.mode : defaultPythonConfig.mode;
  const pythonPath = typeof value.pythonPath === 'string' && value.pythonPath.trim() ? value.pythonPath.trim() : undefined;
  const venvPath = mode === 'venv' && typeof value.venvPath === 'string' && value.venvPath.trim()
    ? normalizeWorkspaceRelativeDirectory(value.venvPath)
    : undefined;
  const condaEnvName =
    mode === 'conda' && typeof value.condaEnvName === 'string' && value.condaEnvName.trim()
      ? value.condaEnvName.trim()
      : undefined;
  const condaPrefix =
    mode === 'conda' && typeof value.condaPrefix === 'string' && value.condaPrefix.trim()
      ? value.condaPrefix.trim()
      : undefined;
  const requirementsPath =
    typeof value.requirementsPath === 'string'
      ? normalizeWorkspaceRelativePath(value.requirementsPath)
      : defaultPythonConfig.requirementsPath;
  return {
    mode,
    ...(pythonPath ? { pythonPath } : {}),
    ...(venvPath ? { venvPath } : {}),
    ...(condaEnvName ? { condaEnvName } : {}),
    ...(condaPrefix ? { condaPrefix } : {}),
    requirementsPath,
  };
}

function uniqueTopLevelRoots(paths: string[]): string[] {
  return [...new Set(paths.map((path) => path.split(/[\\/]/)[0]).filter((path): path is string => Boolean(path)))];
}

function slugify(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || `query-${Date.now()}`;
}

function toPortablePath(path: string): string {
  return path.split(sep).join('/');
}

function normalizeAgentMode(value: unknown): WorkspaceProject['defaults']['agentMode'] {
  if (value === 'auto' || value === 'full-auto' || value === 'readonly') return value;
  return 'ask';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}
