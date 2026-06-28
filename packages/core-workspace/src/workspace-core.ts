import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { parseWorkspaceScriptTool } from './script-tool-parser.js';
import { normalizeWorkspaceDirectory, normalizeWorkspaceRelativePath, resolveInsideWorkspace, toPortablePath } from './path-utils.js';
import type {
  WorkspaceAssetPaths,
  WorkspaceConfig,
  WorkspaceCreateInput,
  WorkspaceConnectionLink,
  WorkspaceFileEntry,
  WorkspacePythonConfig,
  WorkspaceSavedFile,
  WorkspaceScriptTool,
} from './types.js';

const configPath = join('.dbagent', 'workspace.json');

const defaultAssetPaths: WorkspaceAssetPaths = {
  sqlLibrary: 'sql/analytics',
  scripts: 'scripts',
  docs: 'docs',
  outputs: 'outputs',
  skills: 'skills',
};

const defaultPython: WorkspacePythonConfig = {
  mode: 'system',
  requirementsPath: 'scripts/requirements.txt',
  timeoutSeconds: 300,
  networkAllowed: false,
};

export class WorkspaceCore {
  async create(input: WorkspaceCreateInput): Promise<WorkspaceConfig> {
    const now = new Date().toISOString();
    const workspace: WorkspaceConfig = {
      version: 1,
      id: randomUUID(),
      name: normalizeName(input.name),
      rootPath: resolve(input.rootPath),
      ...(input.description?.trim() ? { description: input.description.trim() } : {}),
      template: input.template ?? 'standard',
      createdAt: now,
      updatedAt: now,
      connections: input.connections ?? [],
      defaults: {
        agentMode: 'ask',
        ...(input.connections?.find((connection) => connection.isDefault)?.connectionId
          ? { connectionId: input.connections.find((connection) => connection.isDefault)!.connectionId }
          : {}),
      },
      assetPaths: normalizeAssetPaths(input.assetPaths),
      python: normalizePython(input.python),
      enabledSkills: [],
      enabledMcpServers: [],
      tags: input.tags ?? [],
    };

    await createStructure(workspace);
    await this.saveConfig(workspace);
    return workspace;
  }

  async open(rootPath: string): Promise<WorkspaceConfig> {
    const absoluteRoot = resolve(rootPath);
    const raw = await readFile(join(absoluteRoot, configPath), 'utf8');
    return normalizeConfig(JSON.parse(raw), absoluteRoot);
  }

  async writeFile(rootPath: string, relativePath: string, content: string): Promise<WorkspaceSavedFile> {
    const absolutePath = resolveInsideWorkspace(rootPath, relativePath);
    await atomicWriteText(absolutePath, content);
    const info = await stat(absolutePath);
    return {
      relativePath: normalizeWorkspaceRelativePath(relativePath),
      absolutePath,
      bytes: info.size,
      updatedAt: info.mtime.toISOString(),
    };
  }

  async readFile(rootPath: string, relativePath: string, maxBytes = 1024 * 1024): Promise<string> {
    const absolutePath = resolveInsideWorkspace(rootPath, relativePath);
    const info = await stat(absolutePath);
    if (!info.isFile()) throw new Error('Workspace path is not a file.');
    if (info.size > maxBytes) throw new Error('Workspace file is too large to read.');
    return readFile(absolutePath, 'utf8');
  }

  async listFiles(rootPath: string, relativePath = '.'): Promise<WorkspaceFileEntry[]> {
    const root = resolve(rootPath);
    const start = relativePath === '.' ? root : resolveInsideWorkspace(root, relativePath);
    return listDirectory(root, start, 4);
  }

  async saveSql(input: {
    rootPath: string;
    name: string;
    sql: string;
    connectionId?: string;
    description?: string;
    tags?: string[];
  }): Promise<WorkspaceSavedFile> {
    const workspace = await this.open(input.rootPath);
    const sql = input.sql.trim();
    if (!sql) throw new Error('SQL content is required.');
    const relativePath = `${workspace.assetPaths.sqlLibrary}/${slugify(input.name)}.sql`;
    return this.writeFile(
      input.rootPath,
      relativePath,
      buildSqlFile({
        name: normalizeName(input.name),
        sql,
        ...(input.connectionId ? { connectionId: input.connectionId } : {}),
        ...(input.description ? { description: input.description } : {}),
        ...(input.tags ? { tags: input.tags } : {}),
      }),
    );
  }

  async discoverScriptTools(rootPath: string): Promise<WorkspaceScriptTool[]> {
    const workspace = await this.open(rootPath);
    const scriptsRoot = resolveInsideWorkspace(rootPath, workspace.assetPaths.scripts);
    const files = await collectPythonFiles(workspace.rootPath, scriptsRoot);
    const tools = await Promise.all(
      files.map(async (absolutePath) => {
        const relativePath = toPortablePath(relative(workspace.rootPath, absolutePath));
        return parseWorkspaceScriptTool(relativePath, await readFile(absolutePath, 'utf8'));
      }),
    );
    return tools.filter((tool): tool is WorkspaceScriptTool => Boolean(tool));
  }

  private async saveConfig(workspace: WorkspaceConfig): Promise<void> {
    await atomicWriteText(join(workspace.rootPath, configPath), `${JSON.stringify(workspace, null, 2)}\n`);
  }
}

async function createStructure(workspace: WorkspaceConfig): Promise<void> {
  const directories =
    workspace.template === 'minimal'
      ? ['.dbagent', 'queries', 'scripts', 'docs', 'outputs', 'skills']
      : [
          '.dbagent',
          'queries/_drafts',
          'sql/analytics',
          'sql/ops',
          'scripts/_runs',
          'skills',
          'docs/reports',
          'outputs',
          'notebooks',
        ];
  await Promise.all([...directories, ...Object.values(workspace.assetPaths), dirname(workspace.python.requirementsPath)].map((dir) => mkdir(join(workspace.rootPath, dir), { recursive: true })));
  await atomicWriteText(join(workspace.rootPath, workspace.python.requirementsPath), '# DBAgent workspace dependencies\npandas\nnumpy\n', { overwrite: false });
}

async function atomicWriteText(path: string, content: string, options: { overwrite?: boolean } = {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  if (options.overwrite === false) {
    try {
      await stat(path);
      return;
    } catch {
      // continue
    }
  }
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, content, 'utf8');
  await rename(tempPath, path);
}

async function listDirectory(rootPath: string, absolutePath: string, depth: number): Promise<WorkspaceFileEntry[]> {
  if (depth <= 0) return [];
  const entries = await readdir(absolutePath, { withFileTypes: true });
  const visible = entries.filter((entry) => !entry.name.startsWith('.'));
  const result = await Promise.all(
    visible
      .sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name))
      .map(async (entry) => {
        const child = join(absolutePath, entry.name);
        const relativePath = toPortablePath(relative(rootPath, child));
        if (entry.isDirectory()) {
          return {
            name: entry.name,
            relativePath,
            type: 'directory' as const,
            children: await listDirectory(rootPath, child, depth - 1),
          };
        }
        return { name: entry.name, relativePath, type: 'file' as const };
      }),
  );
  return result;
}

async function collectPythonFiles(rootPath: string, absolutePath: string): Promise<string[]> {
  const entries = await listDirectory(rootPath, absolutePath, 8);
  const files: string[] = [];
  collect(entries, files, rootPath);
  return files.map((relativePath) => resolve(rootPath, relativePath));
}

function collect(entries: WorkspaceFileEntry[], files: string[], rootPath: string): void {
  for (const entry of entries) {
    if (entry.type === 'file' && entry.relativePath.endsWith('.py')) files.push(entry.relativePath);
    for (const child of entry.children ?? []) collect([child], files, rootPath);
  }
}

function normalizeConfig(input: unknown, rootPath: string): WorkspaceConfig {
  if (!isRecord(input) || input.version !== 1) throw new Error('Invalid workspace config.');
  if (typeof input.id !== 'string' || typeof input.name !== 'string') throw new Error('Invalid workspace config.');
  return {
    version: 1,
    id: input.id,
    name: normalizeName(input.name),
    rootPath,
    ...(typeof input.description === 'string' && input.description.trim() ? { description: input.description.trim() } : {}),
    template: input.template === 'minimal' ? 'minimal' : 'standard',
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : new Date().toISOString(),
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : new Date().toISOString(),
    connections: Array.isArray(input.connections) ? input.connections.filter(isConnectionLink) : [],
    defaults: isRecord(input.defaults)
      ? {
          agentMode: normalizeAgentMode(input.defaults.agentMode),
          ...(typeof input.defaults.connectionId === 'string' ? { connectionId: input.defaults.connectionId } : {}),
        }
      : { agentMode: 'ask' },
    assetPaths: normalizeAssetPaths(isRecord(input.assetPaths) ? input.assetPaths : undefined),
    python: normalizePython(isRecord(input.python) ? input.python : undefined),
    enabledSkills: Array.isArray(input.enabledSkills) ? input.enabledSkills.filter(isString) : [],
    enabledMcpServers: Array.isArray(input.enabledMcpServers) ? input.enabledMcpServers.filter(isString) : [],
    tags: Array.isArray(input.tags) ? input.tags.filter(isString) : [],
  };
}

function normalizeAssetPaths(input?: Partial<WorkspaceAssetPaths>): WorkspaceAssetPaths {
  return {
    sqlLibrary: normalizeWorkspaceDirectory(input?.sqlLibrary ?? defaultAssetPaths.sqlLibrary),
    scripts: normalizeWorkspaceDirectory(input?.scripts ?? defaultAssetPaths.scripts),
    docs: normalizeWorkspaceDirectory(input?.docs ?? defaultAssetPaths.docs),
    outputs: normalizeWorkspaceDirectory(input?.outputs ?? defaultAssetPaths.outputs),
    skills: normalizeWorkspaceDirectory(input?.skills ?? defaultAssetPaths.skills),
  };
}

function normalizePython(input?: Partial<WorkspacePythonConfig>): WorkspacePythonConfig {
  const mode = input?.mode ?? defaultPython.mode;
  return {
    mode,
    ...(input?.pythonPath ? { pythonPath: input.pythonPath } : {}),
    ...(mode === 'venv' && input?.venvPath ? { venvPath: normalizeWorkspaceDirectory(input.venvPath) } : {}),
    ...(mode === 'conda' && input?.condaEnvName ? { condaEnvName: input.condaEnvName } : {}),
    ...(mode === 'conda' && input?.condaPrefix ? { condaPrefix: input.condaPrefix } : {}),
    requirementsPath: normalizeWorkspaceRelativePath(input?.requirementsPath ?? defaultPython.requirementsPath),
    timeoutSeconds: input?.timeoutSeconds ?? defaultPython.timeoutSeconds,
    networkAllowed: input?.networkAllowed ?? defaultPython.networkAllowed,
  };
}

function buildSqlFile(input: { name: string; sql: string; connectionId?: string; description?: string; tags?: string[] }): string {
  return [
    `-- @name: ${input.name}`,
    ...(input.description ? [`-- @description: ${input.description}`] : []),
    ...(input.connectionId ? [`-- @connection: ${input.connectionId}`] : []),
    ...(input.tags?.length ? [`-- @tags: [${input.tags.join(', ')}]`] : []),
    '',
    input.sql,
    '',
  ].join('\n');
}

function normalizeName(name: string): string {
  const normalized = name.trim();
  if (!normalized) throw new Error('Workspace name is required.');
  return normalized;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '') || `query-${Date.now()}`;
}

function normalizeAgentMode(value: unknown): WorkspaceConfig['defaults']['agentMode'] {
  if (value === 'auto' || value === 'full-auto' || value === 'readonly') return value;
  return 'ask';
}

function isConnectionLink(input: unknown): input is WorkspaceConnectionLink {
  return isRecord(input) && typeof input.connectionId === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}
