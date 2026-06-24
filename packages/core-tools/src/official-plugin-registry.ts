import type { ToolDangerLevel } from '@dbagent/core-agent';

export type OfficialPluginCategory = 'database' | 'rag' | 'workspace' | 'python' | 'mcp' | 'skill';

export type OfficialPluginSource = 'official';

export type OfficialPluginPermissionRisk = ToolDangerLevel;
export type OfficialPluginApprovalPolicy = 'never' | 'mode-dependent' | 'always';
export type OfficialPluginNetworkAccess = 'none' | 'local' | 'remote';
export type OfficialPluginProcessAccess = 'none' | 'managed-child-process' | 'external-service';
export type OfficialPluginAuditLevel = 'none' | 'metadata' | 'metadata-and-arguments';
export type OfficialPluginResourceScope =
  | 'database.connection'
  | 'rag.index'
  | 'workspace.root'
  | 'workspace.process'
  | 'mcp.server'
  | 'skill.source';
export type OfficialPluginSecretKind = 'database-password' | 'api-key' | 'mcp-env' | 'ssh-key' | 'none';

export type OfficialPluginPermission = {
  id: string;
  title: string;
  description: string;
  risk: OfficialPluginPermissionRisk;
  readonly: boolean;
  resourceScopes: OfficialPluginResourceScope[];
  approvalPolicy: OfficialPluginApprovalPolicy;
  networkAccess: OfficialPluginNetworkAccess;
  processAccess: OfficialPluginProcessAccess;
  secretKinds: OfficialPluginSecretKind[];
  auditLevel: OfficialPluginAuditLevel;
};

export type OfficialPluginToolContribution = {
  name: string;
  title: string;
  description: string;
  dangerLevel: ToolDangerLevel;
  readonly: boolean;
  permissions: string[];
  dynamic?: boolean;
  namePattern?: string;
};

export type OfficialPluginManifest = {
  id: string;
  name: string;
  version: string;
  publisher: 'DBAgent';
  source: OfficialPluginSource;
  category: OfficialPluginCategory;
  description: string;
  enabledByDefault: boolean;
  capabilities: string[];
  permissions: OfficialPluginPermission[];
  tools: OfficialPluginToolContribution[];
};

export type OfficialPluginToolResolutionOptions = {
  enabledPluginIds?: string[];
  disabledPluginIds?: string[];
  readonlyOnly?: boolean;
  allowedPermissions?: string[];
  maxDangerLevel?: ToolDangerLevel;
};

export type OfficialPluginToolResolution = {
  toolNames: string[];
  dynamicTools: OfficialPluginToolContribution[];
};

const dangerRank: Record<ToolDangerLevel, number> = {
  safe: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export class OfficialPluginRegistry {
  private readonly manifests = new Map<string, OfficialPluginManifest>();

  constructor(manifests: OfficialPluginManifest[] = DEFAULT_OFFICIAL_PLUGIN_MANIFESTS) {
    for (const manifest of manifests) {
      this.register(manifest);
    }
  }

  register(manifest: OfficialPluginManifest): void {
    validateManifest(manifest);
    if (this.manifests.has(manifest.id)) {
      throw new Error(`Official plugin is already registered: ${manifest.id}`);
    }
    for (const existing of this.manifests.values()) {
      assertNoStaticToolNameConflict(existing, manifest);
    }
    this.manifests.set(manifest.id, cloneManifest(manifest));
  }

  get(id: string): OfficialPluginManifest | undefined {
    const manifest = this.manifests.get(id);
    return manifest ? cloneManifest(manifest) : undefined;
  }

  list(): OfficialPluginManifest[] {
    return [...this.manifests.values()].map(cloneManifest).sort((left, right) => left.id.localeCompare(right.id));
  }

  listEnabled(options: Pick<OfficialPluginToolResolutionOptions, 'enabledPluginIds' | 'disabledPluginIds'> = {}): OfficialPluginManifest[] {
    return this.list().filter((manifest) => isPluginEnabled(manifest, options));
  }

  resolveToolContributions(options: OfficialPluginToolResolutionOptions = {}): OfficialPluginToolResolution {
    const allowedPermissions = options.allowedPermissions === undefined ? undefined : new Set(options.allowedPermissions);
    const toolNames: string[] = [];
    const dynamicTools: OfficialPluginToolContribution[] = [];
    const seen = new Set<string>();

    for (const manifest of this.listEnabled(options)) {
      for (const tool of manifest.tools) {
        if (options.readonlyOnly === true && !tool.readonly) continue;
        if (options.maxDangerLevel && dangerRank[tool.dangerLevel] > dangerRank[options.maxDangerLevel]) continue;
        if (allowedPermissions && !tool.permissions.every((permission) => allowedPermissions.has(permission))) continue;

        const cloned = cloneTool(tool);
        if (tool.dynamic) {
          dynamicTools.push(cloned);
          continue;
        }
        if (seen.has(tool.name)) throw new Error(`Duplicate resolved official tool contribution: ${tool.name}`);
        seen.add(tool.name);
        toolNames.push(tool.name);
      }
    }

    return { toolNames, dynamicTools };
  }
}

export function createDefaultOfficialPluginRegistry(): OfficialPluginRegistry {
  return new OfficialPluginRegistry();
}

export const DEFAULT_OFFICIAL_PLUGIN_MANIFESTS: OfficialPluginManifest[] = [
  {
    id: 'official.database-postgres',
    name: 'PostgreSQL 数据库核心工具',
    version: '0.1.0',
    publisher: 'DBAgent',
    source: 'official',
    category: 'database',
    description: '连接、浏览、预审和执行 PostgreSQL SQL 的官方内置工具组。',
    enabledByDefault: true,
    capabilities: ['schema-browse', 'sql-audit', 'sql-query', 'sql-execute'],
    permissions: [
      permission('database.schema.read', '读取数据库结构', '读取 schema、表、字段和关系元数据。', 'safe', true, {
        resourceScopes: ['database.connection'],
        approvalPolicy: 'never',
        networkAccess: 'local',
        processAccess: 'none',
        secretKinds: ['database-password'],
        auditLevel: 'metadata',
      }),
      permission('database.query.read', '执行只读查询', '执行 SELECT、SHOW、VALUES 等只读 SQL。', 'medium', true, {
        resourceScopes: ['database.connection'],
        approvalPolicy: 'mode-dependent',
        networkAccess: 'local',
        processAccess: 'none',
        secretKinds: ['database-password'],
        auditLevel: 'metadata-and-arguments',
      }),
      permission('database.query.write', '执行写入 SQL', '执行 INSERT、UPDATE、DELETE、DDL 或其他可能改变数据库状态的 SQL。', 'high', false, {
        resourceScopes: ['database.connection'],
        approvalPolicy: 'always',
        networkAccess: 'local',
        processAccess: 'none',
        secretKinds: ['database-password'],
        auditLevel: 'metadata-and-arguments',
      }),
    ],
    tools: [
      tool('list_schemas', '列出 Schema', '列出当前连接中的 schema。', 'safe', true, ['database.schema.read']),
      tool('list_tables', '列出表', '列出当前连接中的表和视图。', 'safe', true, ['database.schema.read']),
      tool('describe_table', '描述表', '读取单表字段、主键和注释。', 'safe', true, ['database.schema.read']),
      tool('audit_sql', 'SQL 预审', '在执行前返回 SQL 安全报告。', 'safe', true, ['database.query.read']),
      tool('query_database', '只读查询', '执行单条只读 SQL 并返回结果。', 'medium', true, ['database.query.read']),
      tool('execute_sql', '执行 SQL', '执行需要批准的写入或 DDL SQL。', 'high', false, ['database.query.write']),
    ],
  },
  {
    id: 'official.schema-rag',
    name: 'Schema RAG',
    version: '0.1.0',
    publisher: 'DBAgent',
    source: 'official',
    category: 'rag',
    description: '基于本地索引检索数据库 schema、业务术语和关系上下文。',
    enabledByDefault: true,
    capabilities: ['schema-search', 'relation-context', 'context-builder'],
    permissions: [
      permission('rag.schema.read', '读取本地 Schema 索引', '读取本地 RAG 索引中的 schema 文档和关系上下文。', 'safe', true, {
        resourceScopes: ['rag.index'],
        approvalPolicy: 'never',
        networkAccess: 'none',
        processAccess: 'none',
        secretKinds: ['none'],
        auditLevel: 'metadata',
      }),
    ],
    tools: [
      tool('search_schema', '检索 Schema', '按业务问题检索 schema 文档。', 'safe', true, ['rag.schema.read']),
      tool('get_relations', '读取关系上下文', '读取单表一跳关系上下文。', 'safe', true, ['rag.schema.read']),
      tool('build_schema_context', '构建 Schema 上下文', '构建供 Agent 使用的紧凑 schema 上下文。', 'safe', true, ['rag.schema.read']),
    ],
  },
  {
    id: 'official.workspace-files',
    name: '工作区文件工具',
    version: '0.1.0',
    publisher: 'DBAgent',
    source: 'official',
    category: 'workspace',
    description: '读取、列出和原子写入当前工作区内的文本文件。',
    enabledByDefault: true,
    capabilities: ['workspace-list', 'workspace-read', 'workspace-write'],
    permissions: [
      permission('workspace.file.read', '读取工作区文件', '读取工作区托管目录内的文件和目录列表。', 'safe', true, {
        resourceScopes: ['workspace.root'],
        approvalPolicy: 'never',
        networkAccess: 'none',
        processAccess: 'none',
        secretKinds: ['none'],
        auditLevel: 'metadata-and-arguments',
      }),
      permission('workspace.file.write', '写入工作区文件', '在工作区托管目录内原子写入文本文件。', 'medium', false, {
        resourceScopes: ['workspace.root'],
        approvalPolicy: 'mode-dependent',
        networkAccess: 'none',
        processAccess: 'none',
        secretKinds: ['none'],
        auditLevel: 'metadata-and-arguments',
      }),
    ],
    tools: [
      tool('list_workspace_dir', '列出目录', '列出工作区目录内容。', 'safe', true, ['workspace.file.read']),
      tool('read_workspace_file', '读取文件', '读取 UTF-8 文本文件。', 'safe', true, ['workspace.file.read']),
      tool('write_workspace_file', '写入文件', '原子写入 UTF-8 文本文件。', 'medium', false, ['workspace.file.write']),
    ],
  },
  {
    id: 'official.workspace-python',
    name: '工作区 Python 脚本工具',
    version: '0.1.0',
    publisher: 'DBAgent',
    source: 'official',
    category: 'python',
    description: '把工作区中声明的 Python 脚本注册为可执行 Agent 工具。',
    enabledByDefault: true,
    capabilities: ['python-script-discovery', 'python-script-runner', 'run-archive'],
    permissions: [
      permission('workspace.process.execute', '执行工作区进程', '在当前工作区内启动受控 Python 子进程。', 'medium', false, {
        resourceScopes: ['workspace.process', 'workspace.root'],
        approvalPolicy: 'mode-dependent',
        networkAccess: 'none',
        processAccess: 'managed-child-process',
        secretKinds: ['none'],
        auditLevel: 'metadata-and-arguments',
      }),
    ],
    tools: [
      {
        name: 'workspace_script:*',
        title: '工作区脚本动态工具',
        description: '由工作区脚本声明动态生成的工具名。',
        dangerLevel: 'medium',
        readonly: false,
        permissions: ['workspace.process.execute'],
        dynamic: true,
        namePattern: '工作区脚本声明的工具名',
      },
    ],
  },
  {
    id: 'official.mcp-client',
    name: 'MCP 客户端',
    version: '0.1.0',
    publisher: 'DBAgent',
    source: 'official',
    category: 'mcp',
    description: '管理 MCP server 生命周期，并把 MCP tool 适配到 Agent Tool Registry。',
    enabledByDefault: true,
    capabilities: ['mcp-stdio', 'mcp-tool-adapter', 'mcp-health'],
    permissions: [
      permission('mcp.tool.invoke', '调用 MCP 工具', '调用用户或市场安装的 MCP server 暴露的工具。', 'high', false, {
        resourceScopes: ['mcp.server'],
        approvalPolicy: 'mode-dependent',
        networkAccess: 'remote',
        processAccess: 'managed-child-process',
        secretKinds: ['mcp-env', 'api-key'],
        auditLevel: 'metadata-and-arguments',
      }),
    ],
    tools: [
      {
        name: 'mcp:*',
        title: 'MCP 动态工具',
        description: '由 MCP server list_tools 动态注册的工具。',
        dangerLevel: 'high',
        readonly: false,
        permissions: ['mcp.tool.invoke'],
        dynamic: true,
        namePattern: '<serverId>__<toolName>',
      },
    ],
  },
];

function tool(
  name: string,
  title: string,
  description: string,
  dangerLevel: ToolDangerLevel,
  readonly: boolean,
  permissions: string[],
): OfficialPluginToolContribution {
  return { name, title, description, dangerLevel, readonly, permissions };
}

function permission(
  id: string,
  title: string,
  description: string,
  risk: ToolDangerLevel,
  readonly: boolean,
  policy: Omit<OfficialPluginPermission, 'id' | 'title' | 'description' | 'risk' | 'readonly'>,
): OfficialPluginPermission {
  return {
    id,
    title,
    description,
    risk,
    readonly,
    ...policy,
  };
}

function validateManifest(manifest: OfficialPluginManifest): void {
  if (!manifest.id.trim()) throw new Error('Official plugin id is required.');
  if (!manifest.name.trim()) throw new Error(`Official plugin name is required: ${manifest.id}`);
  if (manifest.source !== 'official') throw new Error(`Official plugin must use source=official: ${manifest.id}`);

  const permissions = new Set<string>();
  for (const permission of manifest.permissions) {
    if (!permission.id.trim()) throw new Error(`Official plugin permission id is required: ${manifest.id}`);
    if (permissions.has(permission.id)) {
      throw new Error(`Duplicate permission in official plugin ${manifest.id}: ${permission.id}`);
    }
    if (permission.secretKinds.length === 0) {
      throw new Error(`Official plugin permission must declare secretKinds: ${permission.id}`);
    }
    if (permission.resourceScopes.length === 0) {
      throw new Error(`Official plugin permission must declare resourceScopes: ${permission.id}`);
    }
    permissions.add(permission.id);
  }

  const toolNames = new Set<string>();
  for (const contribution of manifest.tools) {
    if (!contribution.name.trim()) throw new Error(`Official plugin tool name is required: ${manifest.id}`);
    if (toolNames.has(contribution.name)) {
      throw new Error(`Duplicate tool in official plugin ${manifest.id}: ${contribution.name}`);
    }
    toolNames.add(contribution.name);
    for (const permission of contribution.permissions) {
      if (!permissions.has(permission)) {
        throw new Error(`Tool ${contribution.name} references unknown permission ${permission}.`);
      }
    }
  }
}

function assertNoStaticToolNameConflict(existing: OfficialPluginManifest, next: OfficialPluginManifest): void {
  const existingTools = new Set(existing.tools.filter((tool) => !tool.dynamic).map((tool) => tool.name));
  for (const contribution of next.tools) {
    if (!contribution.dynamic && existingTools.has(contribution.name)) {
      throw new Error(
        `Official plugin tool ${contribution.name} is already contributed by ${existing.id}; cannot register ${next.id}.`,
      );
    }
  }
}

function isPluginEnabled(
  manifest: OfficialPluginManifest,
  options: Pick<OfficialPluginToolResolutionOptions, 'enabledPluginIds' | 'disabledPluginIds'>,
): boolean {
  const disabled = new Set(options.disabledPluginIds ?? []);
  if (disabled.has(manifest.id)) return false;
  const enabled = new Set(options.enabledPluginIds ?? []);
  return manifest.enabledByDefault || enabled.has(manifest.id);
}

function cloneManifest(manifest: OfficialPluginManifest): OfficialPluginManifest {
  return {
    ...manifest,
    capabilities: [...manifest.capabilities],
    permissions: manifest.permissions.map((permission) => ({
      ...permission,
      resourceScopes: [...permission.resourceScopes],
      secretKinds: [...permission.secretKinds],
    })),
    tools: manifest.tools.map(cloneTool),
  };
}

function cloneTool(tool: OfficialPluginToolContribution): OfficialPluginToolContribution {
  return {
    ...tool,
    permissions: [...tool.permissions],
  };
}
