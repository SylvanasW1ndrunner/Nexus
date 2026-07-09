import type { ToolDangerLevel } from '@dbagent/core-agent';
import {
  parseAgentEvalSuiteManifest,
  type AgentEvalSuiteManifest,
} from './agent-eval-suite-manifest.js';
import type { AgentEvalSuite } from './agent-eval-suite-runner.js';

export type OfficialPluginCategory =
  | 'database'
  | 'rag'
  | 'workspace'
  | 'python'
  | 'mcp'
  | 'skill'
  | 'agent'
  | 'eval';

export type OfficialPluginSource = 'official';

export type OfficialPluginPermissionRisk = ToolDangerLevel;
export type OfficialPluginApprovalPolicy = 'never' | 'mode-dependent' | 'always';
export type OfficialPluginNetworkAccess = 'none' | 'local' | 'remote';
export type OfficialPluginProcessAccess = 'none' | 'managed-child-process' | 'external-service';
export type OfficialPluginAuditLevel = 'none' | 'metadata' | 'metadata-and-arguments';
export type OfficialPluginRuntimeToolSource =
  | 'database'
  | 'schema-rag'
  | 'workspace'
  | 'workspace-script'
  | 'user-mcp'
  | 'market-mcp'
  | 'skill'
  | 'official'
  | 'unknown';
export type OfficialPluginResourceScope =
  | 'database.connection'
  | 'rag.index'
  | 'workspace.root'
  | 'workspace.process'
  | 'mcp.server'
  | 'skill.source'
  | 'agent.checkpoint'
  | 'agent.session'
  | 'agent.plan'
  | 'eval.report';
export type OfficialPluginSecretKind =
  | 'database-password'
  | 'api-key'
  | 'mcp-env'
  | 'ssh-key'
  | 'none';

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
  runtimeSources?: OfficialPluginRuntimeToolSource[];
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
  evalSuites?: AgentEvalSuiteManifest[];
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
  staticTools: OfficialPluginToolContribution[];
  dynamicTools: OfficialPluginToolContribution[];
};

export type OfficialPluginRuntimeToolDescriptor = {
  name: string;
  dangerLevel: ToolDangerLevel;
  readonly?: boolean;
  source?: string;
  sourceId?: string;
  originalName?: string;
};

export type OfficialPluginRuntimeToolResolutionOptions = OfficialPluginToolResolutionOptions & {
  runtimeTools: OfficialPluginRuntimeToolDescriptor[];
};

export type OfficialPluginRuntimeToolResolution = {
  allowedToolNames: string[];
  blockedToolNames: string[];
  staticToolNames: string[];
  dynamicToolNames: string[];
  missingStaticToolNames: string[];
  dynamicContributions: OfficialPluginToolContribution[];
};

export type OfficialPluginEvalSuiteResolutionOptions = Pick<
  OfficialPluginToolResolutionOptions,
  'enabledPluginIds' | 'disabledPluginIds'
> & {
  suiteIds?: string[];
};

export type OfficialPluginEvalSuiteResolution = {
  suites: AgentEvalSuite[];
  manifests: Array<{
    pluginId: string;
    manifest: AgentEvalSuiteManifest;
  }>;
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
    return [...this.manifests.values()]
      .map(cloneManifest)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  listEnabled(
    options: Pick<
      OfficialPluginToolResolutionOptions,
      'enabledPluginIds' | 'disabledPluginIds'
    > = {},
  ): OfficialPluginManifest[] {
    return this.list().filter((manifest) => isPluginEnabled(manifest, options));
  }

  resolveToolContributions(
    options: OfficialPluginToolResolutionOptions = {},
  ): OfficialPluginToolResolution {
    const allowedPermissions =
      options.allowedPermissions === undefined ? undefined : new Set(options.allowedPermissions);
    const toolNames: string[] = [];
    const staticTools: OfficialPluginToolContribution[] = [];
    const dynamicTools: OfficialPluginToolContribution[] = [];
    const seen = new Set<string>();

    for (const manifest of this.listEnabled(options)) {
      for (const tool of manifest.tools) {
        if (options.readonlyOnly === true && !tool.readonly) continue;
        if (
          options.maxDangerLevel &&
          dangerRank[tool.dangerLevel] > dangerRank[options.maxDangerLevel]
        )
          continue;
        if (
          allowedPermissions &&
          !tool.permissions.every((permission) => allowedPermissions.has(permission))
        )
          continue;

        const cloned = cloneTool(tool);
        if (tool.dynamic) {
          dynamicTools.push(cloned);
          continue;
        }
        if (seen.has(tool.name))
          throw new Error(`Duplicate resolved official tool contribution: ${tool.name}`);
        seen.add(tool.name);
        toolNames.push(tool.name);
        staticTools.push(cloned);
      }
    }

    return { toolNames, staticTools, dynamicTools };
  }

  resolveRuntimeTools(
    options: OfficialPluginRuntimeToolResolutionOptions,
  ): OfficialPluginRuntimeToolResolution {
    const resolved = this.resolveToolContributions(options);
    const runtimeToolNames = new Set<string>();
    const allowedToolNames: string[] = [];
    const blockedToolNames: string[] = [];
    const staticToolNames: string[] = [];
    const dynamicToolNames: string[] = [];

    for (const runtimeTool of options.runtimeTools) {
      if (runtimeToolNames.has(runtimeTool.name)) {
        throw new Error(`Duplicate runtime tool descriptor: ${runtimeTool.name}`);
      }
      runtimeToolNames.add(runtimeTool.name);

      const staticAllowed = resolved.staticTools.some((contribution) =>
        staticContributionMatchesRuntimeTool(contribution, runtimeTool),
      );
      const dynamicAllowed =
        !resolved.toolNames.includes(runtimeTool.name) &&
        resolved.dynamicTools.some((contribution) =>
          dynamicContributionMatchesRuntimeTool(contribution, runtimeTool),
        );
      const runtimeAllowed = runtimeToolPassesResolutionOptions(runtimeTool, options);

      if ((staticAllowed || dynamicAllowed) && runtimeAllowed) {
        allowedToolNames.push(runtimeTool.name);
        if (staticAllowed) staticToolNames.push(runtimeTool.name);
        if (dynamicAllowed && !staticAllowed) dynamicToolNames.push(runtimeTool.name);
      } else {
        blockedToolNames.push(runtimeTool.name);
      }
    }

    return {
      allowedToolNames,
      blockedToolNames,
      staticToolNames,
      dynamicToolNames,
      missingStaticToolNames: resolved.toolNames.filter((name) => !staticToolNames.includes(name)),
      dynamicContributions: resolved.dynamicTools,
    };
  }

  resolveEvalSuites(
    options: OfficialPluginEvalSuiteResolutionOptions = {},
  ): OfficialPluginEvalSuiteResolution {
    const suiteFilter = options.suiteIds === undefined ? undefined : new Set(options.suiteIds);
    const suites: AgentEvalSuite[] = [];
    const manifests: OfficialPluginEvalSuiteResolution['manifests'] = [];
    const seenSuiteIds = new Set<string>();

    for (const plugin of this.listEnabled(options)) {
      for (const manifest of plugin.evalSuites ?? []) {
        const suite = parseAgentEvalSuiteManifest(manifest);
        if (suiteFilter && !suiteFilter.has(suite.suiteId)) continue;
        if (seenSuiteIds.has(suite.suiteId)) {
          throw new Error(`Duplicate resolved official eval suite: ${suite.suiteId}`);
        }
        seenSuiteIds.add(suite.suiteId);
        suites.push(suite);
        manifests.push({
          pluginId: plugin.id,
          manifest: cloneEvalSuiteManifest(manifest),
        });
      }
    }

    return { suites, manifests };
  }
}

export function createDefaultOfficialPluginRegistry(): OfficialPluginRegistry {
  return new OfficialPluginRegistry();
}

export const DEFAULT_AGENT_RAG_EVAL_SUITE_MANIFEST: AgentEvalSuiteManifest = {
  version: 1,
  suite: {
    suiteId: 'official.agent-rag.business-readonly',
    suiteName: '官方 Agent/RAG 业务只读验收',
    environment: 'integration',
    notes: [
      '官方 eval suite 只描述验收合同，不包含 provider、model、API key、数据库密码或连接串。',
      '调用方必须显式提供 baseRun、连接 fixture 和报告输出目录。',
    ],
    cases: [
      {
        id: 'OFFICIAL-AGENT-RAG-001',
        userTask:
          '你是数据分析助手。请先调用 search_schema 查找 GMV、退款率、ROI 相关 schema，再调用 query_database 查询渠道表现，最后用中文简短回答。connectionId 是 business_fixture。',
        expectedStatus: 'done',
        requiredToolCalls: ['search_schema', 'query_database'],
        requiredToolStatuses: [
          { toolName: 'search_schema', status: 'success' },
          { toolName: 'query_database', status: 'success' },
        ],
        toolExpectations: [
          {
            toolName: 'search_schema',
            status: 'success',
            minCalls: 1,
            argumentIncludes: ['GMV'],
            resultIncludes: ['orders'],
          },
          {
            toolName: 'query_database',
            status: 'success',
            minCalls: 1,
            caseSensitive: false,
            argumentIncludes: ['select'],
            resultIncludes: ['paid_search'],
          },
        ],
        finalTextExcludes: ['api_key', 'password', 'secret'],
        minIterations: 2,
        maxIterations: 5,
        run: {
          allowedTools: ['search_schema', 'query_database'],
          mode: 'readonly',
          maxIterations: 5,
        },
      },
    ],
  },
};

export const DEFAULT_OFFICIAL_PLUGIN_MANIFESTS: OfficialPluginManifest[] = [
  {
    id: 'official.agent-rag-eval',
    name: 'Agent/RAG 业务评估',
    version: '0.1.0',
    publisher: 'DBAgent',
    source: 'official',
    category: 'eval',
    description: '运行 Agent/RAG 业务验收套件，生成脱敏报告，用于发布前质量门禁。',
    enabledByDefault: false,
    capabilities: ['agent-eval-suite', 'tool-evidence-report', 'release-quality-gate'],
    permissions: [
      permission(
        'eval.report.write',
        '写入评估报告',
        '写入脱敏后的 Agent/RAG 行为评估报告和索引。',
        'safe',
        true,
        {
          resourceScopes: ['agent.session', 'eval.report'],
          approvalPolicy: 'never',
          networkAccess: 'none',
          processAccess: 'none',
          secretKinds: ['none'],
          auditLevel: 'metadata',
        },
      ),
    ],
    tools: [],
    evalSuites: [DEFAULT_AGENT_RAG_EVAL_SUITE_MANIFEST],
  },
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
      permission(
        'database.schema.read',
        '读取数据库结构',
        '读取 schema、表、字段和关系元数据。',
        'safe',
        true,
        {
          resourceScopes: ['database.connection'],
          approvalPolicy: 'never',
          networkAccess: 'local',
          processAccess: 'none',
          secretKinds: ['database-password'],
          auditLevel: 'metadata',
        },
      ),
      permission(
        'database.query.read',
        '执行只读查询',
        '执行 SELECT、SHOW、VALUES 等只读 SQL。',
        'medium',
        true,
        {
          resourceScopes: ['database.connection'],
          approvalPolicy: 'mode-dependent',
          networkAccess: 'local',
          processAccess: 'none',
          secretKinds: ['database-password'],
          auditLevel: 'metadata-and-arguments',
        },
      ),
      permission(
        'database.query.write',
        '执行写入 SQL',
        '执行 INSERT、UPDATE、DELETE、DDL 或其他可能改变数据库状态的 SQL。',
        'high',
        false,
        {
          resourceScopes: ['database.connection'],
          approvalPolicy: 'always',
          networkAccess: 'local',
          processAccess: 'none',
          secretKinds: ['database-password'],
          auditLevel: 'metadata-and-arguments',
        },
      ),
    ],
    tools: [
      tool(
        'list_schemas',
        '列出 Schema',
        '列出当前连接中的 schema。',
        'safe',
        true,
        ['database.schema.read'],
        ['database'],
      ),
      tool(
        'list_tables',
        '列出表',
        '列出当前连接中的表和视图。',
        'safe',
        true,
        ['database.schema.read'],
        ['database'],
      ),
      tool(
        'describe_table',
        '描述表',
        '读取单表字段、主键和注释。',
        'safe',
        true,
        ['database.schema.read'],
        ['database'],
      ),
      tool(
        'audit_sql',
        'SQL 预审',
        '在执行前返回 SQL 安全报告。',
        'safe',
        true,
        ['database.query.read'],
        ['database'],
      ),
      tool(
        'query_database',
        '只读查询',
        '执行单条只读 SQL 并返回结果。',
        'medium',
        true,
        ['database.query.read'],
        ['database'],
      ),
      tool(
        'execute_sql',
        '执行 SQL',
        '执行需要批准的写入或 DDL SQL。',
        'high',
        false,
        ['database.query.write'],
        ['database'],
      ),
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
    capabilities: ['schema-rag-status', 'schema-search', 'relation-context', 'context-builder'],
    permissions: [
      permission(
        'rag.schema.read',
        '读取本地 Schema 索引',
        '读取本地 RAG 索引中的 schema 文档和关系上下文。',
        'safe',
        true,
        {
          resourceScopes: ['rag.index'],
          approvalPolicy: 'never',
          networkAccess: 'none',
          processAccess: 'none',
          secretKinds: ['none'],
          auditLevel: 'metadata',
        },
      ),
    ],
    tools: [
      tool(
        'get_schema_rag_status',
        '读取 Schema RAG 状态',
        '读取本地 Schema RAG 索引阶段、ready 状态和文档计数。',
        'safe',
        true,
        ['rag.schema.read'],
        ['schema-rag'],
      ),
      tool(
        'search_schema',
        '检索 Schema',
        '按业务问题检索 schema 文档。',
        'safe',
        true,
        ['rag.schema.read'],
        ['schema-rag'],
      ),
      tool(
        'get_relations',
        '读取关系上下文',
        '读取单表一跳关系上下文。',
        'safe',
        true,
        ['rag.schema.read'],
        ['schema-rag'],
      ),
      tool(
        'build_schema_context',
        '构建 Schema 上下文',
        '构建供 Agent 使用的紧凑 schema 上下文。',
        'safe',
        true,
        ['rag.schema.read'],
        ['schema-rag'],
      ),
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
      permission(
        'workspace.file.read',
        '读取工作区文件',
        '读取工作区托管目录内的文件和目录列表。',
        'safe',
        true,
        {
          resourceScopes: ['workspace.root'],
          approvalPolicy: 'never',
          networkAccess: 'none',
          processAccess: 'none',
          secretKinds: ['none'],
          auditLevel: 'metadata-and-arguments',
        },
      ),
      permission(
        'workspace.file.write',
        '写入工作区文件',
        '在工作区托管目录内原子写入文本文件。',
        'medium',
        false,
        {
          resourceScopes: ['workspace.root'],
          approvalPolicy: 'mode-dependent',
          networkAccess: 'none',
          processAccess: 'none',
          secretKinds: ['none'],
          auditLevel: 'metadata-and-arguments',
        },
      ),
    ],
    tools: [
      tool(
        'list_workspace_dir',
        '列出目录',
        '列出工作区目录内容。',
        'safe',
        true,
        ['workspace.file.read'],
        ['workspace'],
      ),
      tool(
        'read_workspace_file',
        '读取文件',
        '读取 UTF-8 文本文件。',
        'safe',
        true,
        ['workspace.file.read'],
        ['workspace'],
      ),
      tool(
        'write_workspace_file',
        '写入文件',
        '原子写入 UTF-8 文本文件。',
        'medium',
        false,
        ['workspace.file.write'],
        ['workspace'],
      ),
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
      permission(
        'workspace.process.execute',
        '执行工作区进程',
        '在当前工作区内启动受控 Python 子进程。',
        'medium',
        false,
        {
          resourceScopes: ['workspace.process', 'workspace.root'],
          approvalPolicy: 'mode-dependent',
          networkAccess: 'none',
          processAccess: 'managed-child-process',
          secretKinds: ['none'],
          auditLevel: 'metadata-and-arguments',
        },
      ),
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
        runtimeSources: ['workspace-script'],
        namePattern: '工作区脚本声明的工具名',
      },
    ],
  },
  {
    id: 'official.agent-checkpoint-recovery',
    name: 'Agent Checkpoint Recovery',
    version: '0.1.0',
    publisher: 'DBAgent',
    source: 'official',
    category: 'agent',
    description:
      'Expose persisted ReAct Agent checkpoints as readonly official tools for recovery review and audit.',
    enabledByDefault: true,
    capabilities: ['agent-checkpoint-list', 'agent-checkpoint-read', 'agent-checkpoint-recovery'],
    permissions: [
      permission(
        'agent.checkpoint.read',
        'Read Agent checkpoints',
        'Read redacted local ReAct checkpoint snapshots and recovery metadata.',
        'safe',
        true,
        {
          resourceScopes: ['agent.checkpoint', 'agent.session'],
          approvalPolicy: 'never',
          networkAccess: 'none',
          processAccess: 'none',
          secretKinds: ['none'],
          auditLevel: 'metadata',
        },
      ),
    ],
    tools: [
      tool(
        'list_recoverable_agent_checkpoints',
        'List recoverable Agent checkpoints',
        'List interrupted ReAct Agent checkpoints that can be recovered.',
        'safe',
        true,
        ['agent.checkpoint.read'],
        ['official'],
      ),
      tool(
        'list_agent_checkpoints',
        'List Agent checkpoints',
        'List ReAct Agent iteration checkpoints for one session.',
        'safe',
        true,
        ['agent.checkpoint.read'],
        ['official'],
      ),
      tool(
        'read_agent_checkpoint',
        'Read Agent checkpoint',
        'Read a persisted ReAct Agent checkpoint with bounded evidence.',
        'safe',
        true,
        ['agent.checkpoint.read'],
        ['official'],
      ),
    ],
  },
  {
    id: 'official.agent-plan-recovery',
    name: 'Agent Plan Recovery',
    version: '0.1.0',
    publisher: 'DBAgent',
    source: 'official',
    category: 'agent',
    description:
      'Expose persisted Plan & Execute snapshots as readonly official tools for recovery review and audit.',
    enabledByDefault: true,
    capabilities: ['agent-plan-list', 'agent-plan-read', 'agent-plan-recovery'],
    permissions: [
      permission(
        'agent.plan.read',
        'Read Agent plan history',
        'Read redacted local Plan & Execute snapshots and recovery metadata.',
        'safe',
        true,
        {
          resourceScopes: ['agent.plan', 'agent.session'],
          approvalPolicy: 'never',
          networkAccess: 'none',
          processAccess: 'none',
          secretKinds: ['none'],
          auditLevel: 'metadata',
        },
      ),
    ],
    tools: [
      tool(
        'list_recoverable_agent_plans',
        'List recoverable Agent plans',
        'List interrupted Plan & Execute tasks that can be recovered.',
        'safe',
        true,
        ['agent.plan.read'],
        ['official'],
      ),
      tool(
        'list_agent_plan_executions',
        'List Agent plan executions',
        'List Plan & Execute snapshots for one Agent session.',
        'safe',
        true,
        ['agent.plan.read'],
        ['official'],
      ),
      tool(
        'read_agent_plan_execution',
        'Read Agent plan execution',
        'Read a persisted Plan & Execute snapshot with bounded evidence.',
        'safe',
        true,
        ['agent.plan.read'],
        ['official'],
      ),
    ],
  },
  {
    id: 'official.agent-session-history',
    name: 'Agent Session History',
    version: '0.1.0',
    publisher: 'DBAgent',
    source: 'official',
    category: 'agent',
    description:
      'Expose persisted Agent sessions and stream records as readonly official tools for recovery, handoff, and audit review.',
    enabledByDefault: true,
    capabilities: [
      'agent-session-list',
      'agent-session-read',
      'agent-session-export',
      'agent-stream-read',
      'agent-stream-recovery',
    ],
    permissions: [
      permission(
        'agent.session.read',
        'Read Agent session history',
        'Read redacted local Agent sessions and stream records.',
        'safe',
        true,
        {
          resourceScopes: ['agent.session'],
          approvalPolicy: 'never',
          networkAccess: 'none',
          processAccess: 'none',
          secretKinds: ['none'],
          auditLevel: 'metadata',
        },
      ),
    ],
    tools: [
      tool(
        'list_agent_sessions',
        'List Agent sessions',
        'List persisted Agent session summaries.',
        'safe',
        true,
        ['agent.session.read'],
        ['official'],
      ),
      tool(
        'read_agent_session',
        'Read Agent session',
        'Read a persisted Agent session with recent messages.',
        'safe',
        true,
        ['agent.session.read'],
        ['official'],
      ),
      tool(
        'export_agent_session',
        'Export Agent session',
        'Export a persisted Agent session as markdown or JSON.',
        'safe',
        true,
        ['agent.session.read'],
        ['official'],
      ),
      tool(
        'list_agent_streams',
        'List Agent streams',
        'List persisted Agent stream summaries for a session.',
        'safe',
        true,
        ['agent.session.read'],
        ['official'],
      ),
      tool(
        'list_recoverable_agent_streams',
        'List recoverable Agent streams',
        'List incomplete Agent streams that may need recovery.',
        'safe',
        true,
        ['agent.session.read'],
        ['official'],
      ),
      tool(
        'read_agent_stream',
        'Read Agent stream',
        'Read a persisted Agent stream and optional chunks.',
        'safe',
        true,
        ['agent.session.read'],
        ['official'],
      ),
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
      permission(
        'mcp.tool.invoke',
        '调用 MCP 工具',
        '调用用户或市场安装的 MCP server 暴露的工具。',
        'high',
        false,
        {
          resourceScopes: ['mcp.server'],
          approvalPolicy: 'mode-dependent',
          networkAccess: 'remote',
          processAccess: 'managed-child-process',
          secretKinds: ['mcp-env', 'api-key'],
          auditLevel: 'metadata-and-arguments',
        },
      ),
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
        runtimeSources: ['user-mcp', 'market-mcp'],
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
  runtimeSources?: OfficialPluginRuntimeToolSource[],
): OfficialPluginToolContribution {
  return {
    name,
    title,
    description,
    dangerLevel,
    readonly,
    permissions,
    ...(runtimeSources === undefined ? {} : { runtimeSources }),
  };
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
  if (manifest.source !== 'official')
    throw new Error(`Official plugin must use source=official: ${manifest.id}`);

  const permissions = new Set<string>();
  for (const permission of manifest.permissions) {
    if (!permission.id.trim())
      throw new Error(`Official plugin permission id is required: ${manifest.id}`);
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
    if (!contribution.name.trim())
      throw new Error(`Official plugin tool name is required: ${manifest.id}`);
    if (toolNames.has(contribution.name)) {
      throw new Error(`Duplicate tool in official plugin ${manifest.id}: ${contribution.name}`);
    }
    toolNames.add(contribution.name);
    for (const permission of contribution.permissions) {
      if (!permissions.has(permission)) {
        throw new Error(`Tool ${contribution.name} references unknown permission ${permission}.`);
      }
    }
    if (contribution.dynamic && !contribution.namePattern?.trim()) {
      throw new Error(`Dynamic tool ${contribution.name} must declare namePattern.`);
    }
    for (const runtimeSource of contribution.runtimeSources ?? []) {
      if (!runtimeSource.trim()) {
        throw new Error(`Tool ${contribution.name} declares an empty runtime source.`);
      }
    }
  }

  if (manifest.evalSuites !== undefined) {
    if (manifest.category !== 'eval') {
      throw new Error(`Only eval official plugins can declare eval suites: ${manifest.id}`);
    }
    const suiteIds = new Set<string>();
    for (const evalSuite of manifest.evalSuites) {
      const parsed = parseAgentEvalSuiteManifest(evalSuite);
      if (suiteIds.has(parsed.suiteId)) {
        throw new Error(
          `Duplicate eval suite in official plugin ${manifest.id}: ${parsed.suiteId}`,
        );
      }
      suiteIds.add(parsed.suiteId);
    }
  }
}

function assertNoStaticToolNameConflict(
  existing: OfficialPluginManifest,
  next: OfficialPluginManifest,
): void {
  const existingTools = new Set(
    existing.tools.filter((tool) => !tool.dynamic).map((tool) => tool.name),
  );
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
    ...(manifest.evalSuites === undefined
      ? {}
      : {
          evalSuites: manifest.evalSuites.map(cloneEvalSuiteManifest),
        }),
  };
}

function cloneEvalSuiteManifest(manifest: AgentEvalSuiteManifest): AgentEvalSuiteManifest {
  return JSON.parse(JSON.stringify(manifest)) as AgentEvalSuiteManifest;
}

function cloneTool(tool: OfficialPluginToolContribution): OfficialPluginToolContribution {
  return {
    ...tool,
    permissions: [...tool.permissions],
    ...(tool.runtimeSources === undefined ? {} : { runtimeSources: [...tool.runtimeSources] }),
  };
}

function runtimeToolPassesResolutionOptions(
  runtimeTool: OfficialPluginRuntimeToolDescriptor,
  options: Pick<OfficialPluginToolResolutionOptions, 'readonlyOnly' | 'maxDangerLevel'>,
): boolean {
  if (options.readonlyOnly === true && runtimeTool.readonly !== true) return false;
  if (
    options.maxDangerLevel &&
    dangerRank[runtimeTool.dangerLevel] > dangerRank[options.maxDangerLevel]
  )
    return false;
  return true;
}

function staticContributionMatchesRuntimeTool(
  contribution: OfficialPluginToolContribution,
  runtimeTool: OfficialPluginRuntimeToolDescriptor,
): boolean {
  if (contribution.dynamic || contribution.name !== runtimeTool.name) return false;
  if (runtimeTool.source === undefined || runtimeTool.source === 'official') return true;
  return (
    contribution.runtimeSources !== undefined &&
    contribution.runtimeSources.includes(runtimeTool.source as OfficialPluginRuntimeToolSource)
  );
}

function dynamicContributionMatchesRuntimeTool(
  contribution: OfficialPluginToolContribution,
  runtimeTool: OfficialPluginRuntimeToolDescriptor,
): boolean {
  if (!contribution.dynamic) return false;
  if (contribution.runtimeSources && contribution.runtimeSources.length > 0) {
    return (
      runtimeTool.source !== undefined &&
      contribution.runtimeSources.includes(runtimeTool.source as OfficialPluginRuntimeToolSource)
    );
  }
  if (contribution.name.endsWith('*')) {
    return runtimeTool.name.startsWith(contribution.name.slice(0, -1));
  }
  return false;
}
