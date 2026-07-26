# SchemaNaut SDK API 参考

[English](api-reference.md) · [SDK 指南](README.zh-CN.md) · [项目首页](../../README.zh-CN.md)

本文记录 `@nwlworkshop/schemanaut` v1 的公开 Node.js/TypeScript 接口和主要本地 REST API。

SchemaNaut v1 提供 AI SQL 与共用 Agent 基础能力，不提供治理运维 Agent，也不是数据库 IDE。

## `DatabaseAgentRuntime`

```ts
import { DatabaseAgentRuntime } from '@nwlworkshop/schemanaut';

const runtime = new DatabaseAgentRuntime(options);
```

### 构造参数

| 参数                   | 类型                                           | 默认值 / 作用                                                   |
| ---------------------- | ---------------------------------------------- | --------------------------------------------------------------- |
| `provider`             | `LlmProvider`                                  | 初始模型 Provider；必须与 `model` 同时提供                      |
| `gateway`              | `LlmGateway`                                   | 注入自定义模型 Gateway                                          |
| `model`                | `string`                                       | 初始模型 ID；必须与 `provider` 同时提供                         |
| `tenantId`             | `string`                                       | `"local-default"`                                               |
| `driver`               | `IDatabaseDriver`                              | PostgreSQL Driver 兼容边界                                      |
| `databaseAccess`       | `DatabaseAccessRuntime`                        | 注入统一数据库 Runtime                                          |
| `connectors`           | `DatabaseConnector[]`                          | 附加数据库 Connector                                            |
| `connectorRegistry`    | `ConnectorRegistry`                            | 注入 Connector Registry                                         |
| `resourceRegistry`     | `ResourceRegistry`                             | 注入 Resource Registry                                          |
| `credentialResolver`   | `CredentialResolver`                           | 解析数据库档案中的凭据引用                                      |
| `databaseAuditSink`    | `DatabaseAuditSink`                            | 接收底层数据库访问审计事件                                      |
| `rag`                  | `SchemaRagEngine`                              | 注入知识与检索引擎                                              |
| `schemaSnapshotDirectory` | `string`                                    | 启用持久 Schema RAG 快照；相对路径基于 Project 根目录           |
| `retrievalProfile`     | `SchemaRagRetrievalProfile`                    | 配置全文、Embedding、Reranker 和图检索                          |
| `createRunId`          | `() => string`                                 | 自定义确定性 SQL Run ID                                         |
| `createConnectionId`   | `() => string`                                 | 自定义快捷连接 ID                                               |
| `now`                  | `() => string`                                 | 自定义 ISO 时间源                                               |
| `defaultRowLimit`      | `number`                                       | `200`，范围 1–1,000                                             |
| `usageTracker`         | `UsageTracker`                                 | 注入模型用量统计                                                |
| `approvalProvider`     | `ApprovalProvider`                             | 自定义单次许可回调；省略时使用内置 Broker                       |
| `agentDependencies`    | `AgentRunDependencies`                         | 注入 Agent 持久化、审计和检查点依赖                             |
| `sessionStore`         | `AgentSessionStore`                            | 注入 Store；Runtime 会在其上创建 Project 绑定视图               |
| `sessionDatabasePath`  | `string`                                       | 默认是 `defaultAgentStateDatabasePath()` 返回的系统用户数据路径 |
| `resultStore`          | `AiSqlResultStore`                             | 注入进程内 Agent 结果句柄 Store                                 |
| `projectDirectory`     | `string`                                       | `process.cwd()`，选定的 Project 根目录                          |
| `userSkillsDirectory`  | `string`                                       | `~/.schemanaut/skills`                                          |
| `sessionSkills`        | `SkillOverlay[]`                               | 复制给新建 Session 的默认模板                                   |
| `webAdapter`           | `AgentWebAdapter`                              | 宿主提供的网络搜索/读取实现                                     |
| `enableShellTool`      | `boolean`                                      | `false`；只有可信宿主才注册 `shell_run`                         |
| `dynamicToolDiscovery` | `boolean`                                      | `true`，先暴露发现工具，再按需激活                              |
| `mcpSecretResolver`    | `(ref) => string \| undefined \| Promise<...>` | 解析 MCP 环境变量/Header 的 Secret 引用                         |
| `autoStartMcp`         | `boolean`                                      | `false`；显式选择启动已审核的 `autoStart` MCP Server            |

### 公开属性

| 属性        | 类型                    | 作用                                                           |
| ----------- | ----------------------- | -------------------------------------------------------------- |
| `database`  | `DatabaseAccessRuntime` | 统一档案、连接、发现、Query Job、结果和事务                    |
| `resources` | `ResourceRegistry`      | 统一资源图与状态                                               |
| `sessions`  | `AgentSessionStore`     | 持久 Session、偏好、导出和上下文检查点                         |
| `tools`     | `ToolRegistry`          | 内置和动态注册的 Agent Tools                                   |
| `skills`    | `SkillRegistry`         | System、User、Project 公共 Skills；Session 视图由 Runtime 管理 |
| `results`   | `AiSqlResultStore`      | Session 隔离、自动过期的 Agent 结果句柄                        |
| `mcpConfig` | `McpConfigStore`        | 管理 Project 的 `.schemanaut/mcp.json`                         |
| `mcp`       | `McpRuntimeManager`     | MCP 生命周期、健康、Tools、Resources 与 Prompts                |

`tools`、`skills`、`results`、`mcpConfig` 和 `mcp` 背后的具体扩展类型在 `0.1.x` 仍可能演进，请依赖文档中的方法，不要依赖内部字段。

`webAdapter` 是结构类型：

```ts
type AgentWebAdapter = {
  search(input: {
    query: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<Array<{ title: string; url: string; snippet?: string }>>;
  fetch(input: { url: string; maxChars: number; signal?: AbortSignal }): Promise<{
    url: string;
    title?: string;
    contentType?: string;
    text: string;
  }>;
};
```

## Runtime 生命周期与状态

### `configureProvider(provider, model): void`

注册或替换当前 Provider 与模型。

### `status(): RuntimeStatus`

```ts
type RuntimeStatus = {
  providerConfigured: boolean;
  providerId?: string;
  model?: string;
  connected: boolean;
  connection?: SavedConnection;
  schema: SchemaIndexSnapshot;
  runCount: number;
  llm: {
    modelCount: number;
    metrics: LlmMetricsSnapshot;
  };
};
```

### `close(): Promise<void>`

拒绝新任务，取消并等待运行中的 Agent/子 Agent，取消 Broker 中待处理的许可，停止运行中的 MCP Server，断开快捷连接并关闭统一数据库 Runtime。

## Project 辅助函数

### `initializeAgentProject(directory?): Promise<AgentProjectContext>`

创建缺失的 Project 目录和默认文件，但不覆盖已有内容：

- `.schemanaut/AGENT.md`
- `.schemanaut/settings.json`
- `.schemanaut/mcp.json`
- `.schemanaut/skills/`
- `sql/`
- `artifacts/`

### `findAgentProject(startPath?): Promise<AgentProjectContext | undefined>`

从 `startPath` 向上查找最近包含 `.schemanaut` 的目录。

### `openAgentProject(startPath?): Promise<AgentProjectContext>`

返回最近的已有 Project；找不到时为选定目录创建内存上下文，但不初始化文件。

### `defaultAgentStateDatabasePath(): string`

返回操作系统用户数据目录中的默认 SQLite 路径。

### `defaultAgentUserSkillsDirectory(): string`

返回 `~/.schemanaut/skills`。

## PostgreSQL 快捷入口

### `testConnection(input): Promise<ConnectionTestResult>`

测试 PostgreSQL 连接，不保留连接。

### `connect(input): Promise<SavedConnection>`

```ts
type PostgresConnectionInput = {
  id?: string;
  name?: string;
  host: string;
  port?: number; // 默认 5432
  database: string;
  username: string;
  password?: string;
  ssl?: boolean | 'require' | 'verify-ca' | 'verify-full';
  connectionTimeoutMs?: number; // 默认 10,000
  statementTimeoutMs?: number; // 默认 30,000
  readOnly?: boolean;
};
```

密码会传给 Connector，但不会进入公开 `SavedConnection`。

### `disconnect(): Promise<void>`

断开当前快捷连接。

## 知识索引

### `indexSchema(options?): Promise<SchemaIndexSnapshot>`

```ts
type IndexSchemaOptions = {
  maxTables?: number; // 默认 200，范围 1–1,000
};
```

```ts
type SchemaIndexSnapshot = {
  connectionId?: string;
  stage: 'not_connected' | 'not_indexed' | 'ready';
  ready: boolean;
  tableCount: number;
  columnCount: number;
  relationCount: number;
  documentCount: number;
  truncated: boolean;
  indexedAt?: string;
};
```

### `schemaStatus(): SchemaIndexSnapshot`

读取当前快捷索引状态，不重新构建。

配置 `schemaSnapshotDirectory` 后，成功索引会按同一连接 ID 在重启后恢复；持久清单会保留索引上限与 `truncated` 语义。默认统一 PostgreSQL 路径会在 `generate()` 和 `runAgent()` 前比较稳定的 Schema 修订值，并自动刷新外部 DDL 变化；自定义兼容 Driver 遇到外部 Schema 变化时仍需调用 `indexSchema()`。

快照目录会以明文保存 Schema 名称、注释、业务 Glossary 文本和派生向量，SchemaNaut 不会加密该目录。嵌入宿主负责文件系统权限、备份、保留和安全删除。

## AI SQL Agent

### `runAgent(input): Promise<AiSqlAgentRun>`

```ts
type RunAiSqlAgentInput = {
  message: string;
  userId?: string;
  mode?: 'read' | 'edit' | 'full'; // 默认 read
  session?: AgentSession;
  sessionId?: string;
  sessionSkills?: SkillOverlay[]; // 仅限新建 Session
  maxIterations?: number;
  maxToolExecutionMs?: number;
  onEvent?: (event: AgentUserEvent) => void | Promise<void>;
  signal?: AbortSignal;
};

type AiSqlAgentRun = {
  activatedSkills: string[];
  result: AgentRunResult;
};
```

`session` 与 `sessionId` 只能提供一个。加载的 Session 必须属于当前 Runtime 的 Project。`sessionSkills` 只为一个新 Session 覆盖构造参数中的默认模板，不能与 `session` 或 `sessionId` 同时提供。Overlay 随新 Session 持久化，恢复时不会重新应用后来变更的 Runtime 默认值。

`AgentRunResult`：

```ts
type AgentRunResult = {
  status: 'done' | 'aborted' | 'max_iterations_reached';
  session: AgentSession;
  finalText: string;
  iterations: number;
  toolExecutions: AgentToolExecutionRecord[];
  events?: AgentUserEvent[];
  artifacts?: AgentArtifactReference[];
  completion?: {
    verified: boolean;
    unresolvedTaskIds: string[];
  };
  contextCompression?: AgentContextCompressionReport[];
};
```

`runAgent()` 是可信 SDK 集成入口，其完整结果包含 Tool 执行记录及其他面向宿主的状态。

面向用户输出时，使用 `toAiSqlAgentRunView(run)` 或下文的管理方法。REST Server 会自动应用该投影：

```ts
type AgentSessionView = {
  id: string;
  title: string;
  userId?: string;
  mode: AgentMode;
  messages: Array<{
    role: 'user' | 'assistant';
    content: string;
    createdAt: string;
  }>;
  tokenUsage: LlmUsage;
  project?: { rootPath: string };
  taskPlan?: AgentTaskPlan;
  artifacts?: AgentArtifactReference[];
  activeSkills?: SkillCatalogEntry[];
  aborted: boolean;
};

type AiSqlAgentRunView = {
  activatedSkills: string[];
  result: {
    status: AgentRunStatus;
    session: AgentSessionView;
    finalText: string;
    iterations: number;
    events?: AgentUserEvent[];
    artifacts?: AgentArtifactReference[];
    completion?: {
      verified: boolean;
      unresolvedTaskIds: string[];
    };
  };
};
```

`AgentSessionView` 不包含 Tool 消息/调用、知识 Hash 与树索引、已加载 Skill 正文、上下文压缩内部信息和评测细节。公开任务计划中的证据只保留类型、摘要与创建时间。

不存在让用户选择的策略字段；实际激活的 Skill 名称通过 `activatedSkills` 返回。

### `AgentUserEvent`

```ts
type AgentUserEvent = {
  id: string;
  sessionId: string;
  type:
    | 'goal-understood'
    | 'plan-updated'
    | 'exploring'
    | 'sql-prepared'
    | 'approval-required'
    | 'sql-executed'
    | 'correcting'
    | 'artifact-created'
    | 'completed'
    | 'needs-user-input';
  message: string;
  createdAt: string;
  sql?: string;
  artifact?: AgentArtifactReference;
  metrics?: {
    durationMs?: number;
    rowCount?: number;
    affectedRows?: number;
  };
};
```

这是用户可见语义事件流，不是内部推理或评测轨迹。

### `steerAgentSession(sessionId, message): boolean`

向正在运行的 Session 追加用户要求。该 Session 没有活动 Run 时返回 `false`。

### Session 管理门面

```ts
listAgentSessions(input?: {
  userId?: string;
  archived?: boolean;
  query?: string;
  limit?: number;
  offset?: number;
}): Promise<AgentSessionListItem[]>;

getAgentSession(sessionId: string): Promise<AgentSessionView | undefined>;
deleteAgentSession(sessionId: string): Promise<boolean>;

type AgentSessionListItem = {
  id: string;
  title: string;
  userId?: string;
  mode: AgentMode;
  archived: boolean;
  conversationMessageCount: number;
  tokenUsage: LlmUsage;
  createdAt: string;
  updatedAt: string;
  lastMessageAt?: string;
};
```

`listAgentSessions()` 返回持久、面向用户的摘要。`conversationMessageCount` 只统计用户/助手对话消息，不暴露内部 Tool 消息数量。`getAgentSession()` 返回上面的去内部化视图。`runtime.sessions.load()` 是读取完整 `AgentSession` 的可信底层 API，但仍受当前 Runtime 的 Project 边界约束。

### `compactAgentSession(input): Promise<AgentContextCompactionResult>`

```ts
type CompactAiSqlAgentSessionInput = {
  session?: AgentSession;
  sessionId?: string;
  focus?: string;
  signal?: AbortSignal;
};
```

在需要时创建语义工作上下文检查点，完整原始 Session 记录仍然保留。

### `agentContextCheckpoints(sessionId, limit?): Promise<AgentContextCheckpoint[]>`

按序列返回持久检查点；Store 的 Limit 范围为 1–1,000。

## 权限回调

```ts
type ApprovalProvider = (request: {
  mode: AgentMode;
  tool: AgentToolDefinition;
  toolCall: LlmToolCall;
  sessionId?: string;
  sessionTitle?: string;
  signal?: AbortSignal;
}) =>
  | boolean
  | Promise<boolean>
  | {
      approved: boolean;
      requestId?: string;
      approvedAt?: string;
      approvedBy?: string;
      reason?: string;
    }
  | Promise<{
      approved: boolean;
      requestId?: string;
      approvedAt?: string;
      approvedBy?: string;
      reason?: string;
    }>;
```

一次许可只应用于一个 Tool Call。拒绝的调用会记录为 Denied，并作为观察结果返回 Agent。

构造 Runtime 时未提供 `approvalProvider`，会创建内置 Broker：

```ts
listAgentApprovals(): AgentApprovalRequest[];

resolveAgentApproval(
  requestId: string,
  approved: boolean,
  options?: { resolvedBy?: string; reason?: string },
): boolean;

type AgentApprovalRequest = {
  id: string;
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';
  mode: AgentMode;
  sessionId?: string;
  sessionTitle?: string;
  toolCallId: string;
  toolName: string;
  dangerLevel: 'safe' | 'medium' | 'high' | 'critical';
  readonly: boolean;
  toolSource?: string;
  toolSourceId?: string;
  argumentPreview: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  reason?: string;
};
```

列表方法只返回待处理请求。默认 Broker 等待五分钟；参数预览会脱敏并限制为 2,000 字符。请求不存在或已经处理时，`resolveAgentApproval()` 返回 `false`。自定义 `approvalProvider` 会替代 Broker，因此该门面不持有回调自己的请求。

## `runtime.sessions`

`runtime.sessions` 是 Project 绑定视图。所有 Session 读取和修改都会在 SQLite 查询中带上规范化 Project Key，不会把缺少 Project 的数据视作全局可见。已有行如果在 `session.project` 中保存了归属，迁移时会回填到该 Project；更早且没有 Project 归属的行只允许通过显式未绑定的 `AgentSessionStore` 基础读取，任何 `DatabaseAgentRuntime` 都不会认领。

| 方法                                                    | 结果                                       |
| ------------------------------------------------------- | ------------------------------------------ |
| `save({ session, now? })`                               | 新建或更新 Session，并返回摘要             |
| `load(id)`                                              | 返回完整 Session，找不到时返回 `undefined` |
| `list({ userId?, archived?, query?, limit?, offset? })` | 搜索 Session 摘要，默认只列未归档项        |
| `update(id, { title?, mode?, aborted? }, now?)`         | 更新指定字段                               |
| `archive(id, archived?, now?)`                          | 归档或恢复 Session                         |
| `delete(id)`                                            | 删除 Session，并返回是否存在               |
| `fork({ id, fromMessageIndex, newId?, title?, now? })`  | 截止指定消息创建隔离分支                   |
| `export(id, 'json' \| 'markdown')`                      | 导出完整 Session                           |
| `upsertPreference(input)`                               | 新建或更新用户长期偏好                     |
| `listPreferences(userId, limit?)`                       | 列出该用户使用的偏好                       |
| `deletePreference(userId, key)`                         | 删除一个偏好                               |
| `listContextCheckpoints(sessionId, limit?)`             | 列出持久上下文检查点                       |

Session 消息以追加方式保存在 SQLite 表中，可识别的 Secret 会在持久化前脱敏。

Session 提供 `userId` 后，明确的偏好表达可以在保存时提炼，并作为独立的用户级上下文层复用；Session 原始对话仍保持隔离。

## `runtime.skills`

| 方法                                | 作用                                            |
| ----------------------------------- | ----------------------------------------------- |
| `refresh()`                         | 重新加载已配置目录和 Session Overlay            |
| `list({ scope? })`                  | 返回目录项                                      |
| `catalogForModel()`                 | 只返回模型可见的 `name`、`description`、`scope` |
| `get(nameOrLookup)`                 | 返回选中的目录项                                |
| `inspect(nameOrLookup)`             | 返回仅供宿主诊断的来源元数据                    |
| `load(nameOrLookup)`                | 加载完整 Markdown 指令                          |
| `search(query, { scope?, limit? })` | 搜索目录                                        |
| `invoke('/skill args')`             | 解析并加载显式 Slash 调用                       |
| `issues()` / `conflicts()`          | 返回加载诊断                                    |
| `replaceSessionOverlay(overlays)`   | 替换 Session 级 `SKILL.md` 内容                 |
| `createSessionView(overlays)`       | 从公共快照派生隔离的 Session Overlay 视图       |
| `currentRevision()`                 | 返回当前目录快照版本                            |
| `watch(options)` / `stopWatching()` | 监听 Skill 来源                                 |

作用域优先级为 `session > project > user > system`。

公开管理快捷方法：

```ts
listAgentSkills(input?: { sessionId?: string }): Promise<AgentSkillCatalogEntry[]>;
refreshSkills(): Promise<AgentSkillRefreshResult>;
```

`listAgentSkills()` 不传参数时只返回模型安全的 System/User/Project 公共目录。显式传入 `sessionId` 时，它加载属于同一 Project 的 Session 并返回有效目录；Session 不存在或属于其他 Project 时拒绝。`refreshSkills()` 只刷新公共配置目录并返回 `{ changed, revision, skills, issues, conflicts }`，不会从任何 Session 导入 Overlay。

可信宿主读取的完整 `AgentSession` 包含用于持久化的私有 `sessionSkills`；`AgentSessionView` 与 REST Agent 响应会省略该字段及全部 Skill 正文。v1 REST/CLI 管理面不提供 Session Overlay 导入或替换接口。

## `runtime.mcpConfig`

| 方法                             | 作用                                          |
| -------------------------------- | --------------------------------------------- |
| `load()`                         | 加载 `{ version: 1, servers }`                |
| `list()`                         | 列出规范化 Server 配置                        |
| `upsert(input)`                  | 添加或更新 Server                             |
| `setEnabled(id, enabled)`        | 启用或禁用 Server                             |
| `setAutoStart(id, autoStart)`    | 修改延迟自动启动                              |
| `remove(id, { deleteSecrets? })` | 删除配置，并可返回需要由宿主清理的 Secret Ref |

支持 `stdio`、`streamable-http` 和 `sse`。敏感环境变量与 HTTP Header 必须使用 `{ ref: string }`，敏感明文会被拒绝。

## `runtime.mcp`

| 方法                                                | 作用                                   |
| --------------------------------------------------- | -------------------------------------- |
| `start(serverId)` / `stop(serverId)`                | 启停一个已配置 Server                  |
| `startAutoStart()`                                  | 启动已启用且标记 `autoStart` 的 Server |
| `restartDue(now?)`                                  | 按健康退避状态重启到期 Server          |
| `health(serverId)` / `listHealth()`                 | 读取生命周期健康状态                   |
| `isRunning(serverId)`                               | 检查是否运行                           |
| `describe(serverId)` / `ping(serverId, signal?)`    | 读取 Server 元数据或 Ping              |
| `listResources(serverId, signal?)`                  | 列出 Resources                         |
| `listResourceTemplates(serverId, signal?)`          | 列出 Resource Templates                |
| `readResource(serverId, uri, signal?)`              | 读取 Resource                          |
| `listPrompts(serverId, signal?)`                    | 列出 Prompts                           |
| `getPrompt(serverId, name, args?, signal?)`         | 读取 Prompt                            |
| `onResourcesChanged(...)` / `onPromptsChanged(...)` | 订阅列表变化                           |

MCP Tools 会动态注册到 `runtime.tools`。`startConfiguredMcpServers()` 是启动已配置 `autoStart` Server 的 Runtime 快捷方法。

公开 MCP 管理：

```ts
listMcpServers(): Promise<McpServerSummary[]>;
upsertMcpServer(input: McpServerRegistrationInput): Promise<McpServerSummary>;
removeMcpServer(serverId: string): Promise<boolean>;
startMcpServer(serverId: string): Promise<McpServerStartSummary>;
stopMcpServer(serverId: string): Promise<McpServerStopSummary>;
startConfiguredMcpServers(): Promise<McpRuntimeStartResult[]>;

type McpServerStartSummary = {
  server: McpServerSummary;
  tools: string[];
};

type McpServerStopSummary = {
  serverId: string;
  removedTools: string[];
  status: McpServerStatus;
};

type McpServerSummary = {
  id: string;
  name: string;
  source: McpServerSource;
  transport: 'stdio' | 'sse' | 'streamable-http';
  enabled: boolean;
  autoStart: boolean;
  running: boolean;
  status: McpServerStatus;
  healthy: boolean;
  warnings: string[];
};
```

摘要刻意不返回命令、URL、环境变量、Header 和 Secret 引用。`McpServerRegistrationInput` 接收 `id?`、`name`、`source?`、`transport?`、`autoStart?`、`enabled?`、`command?`、`args?`、`cwd?`、`url?`、`env?`、`headers?`、`description?` 和 `packageName?`。

## `runtime.tools`

| 方法                                 | 作用                                   |
| ------------------------------------ | -------------------------------------- |
| `register(definition, handler)`      | 注册 Tool；名称重复时抛错              |
| `unregister(name)`                   | 删除 Tool                              |
| `get(name)` / `list()` / `has(name)` | 读取注册项                             |
| `llmTools(allowedTools?)`            | 投影模型可见的名称、描述与 JSON Schema |

Tool 定义包含危险等级、来源、只读元数据，以及静态或根据参数计算的所需权限。Handler 会接收 Session、取消信号和单次许可凭证。

内置名称与所需模式：

| Tools                                                                             | 所需模式                                  |
| --------------------------------------------------------------------------------- | ----------------------------------------- |
| `resource_list`、`resource_get`、`knowledge_search`、`sql_explain`、`result_read` | `read`                                    |
| `sql_execute`                                                                     | 根据 SQL 计算：`read`、`edit` 或 `full`   |
| `task_plan_create`、`task_update`、`task_list`、`tool_search`、`tool_describe`    | `read`                                    |
| `skill_search`、`skill_load`、`skill_resource_read`                               | `read`                                    |
| `workspace_list`、`workspace_read`、`workspace_search`                            | `read`                                    |
| `workspace_write`、`workspace_edit`                                               | `edit`                                    |
| `shell_run`                                                                       | `full`；只有设置 `enableShellTool` 才注册 |
| `subagent_spawn`、`subagent_list`、`subagent_wait`                                | `read`                                    |
| `subagent_stop`                                                                   | `edit`                                    |
| `web_search`、`web_fetch`                                                         | `read`；只有提供 `webAdapter` 时存在      |

Workspace 文件工具强制 Project 路径边界。启用后的 `shell_run` 会限制工作目录并使用精简环境变量，但不是操作系统沙箱。

宿主提供的 `webAdapter` 负责目标地址策略、凭据、限流和 SSRF 防护。

## `runtime.results`

| 方法                                       | 作用                                  |
| ------------------------------------------ | ------------------------------------- |
| `put({ sessionId, connectionId, result })` | 保存执行结果并返回句柄                |
| `read({ id, sessionId, cursor?, limit? })` | 读取有界分页，默认 20 行，最多 100 行 |
| `remove(id)`                               | 删除一个句柄                          |
| `clearSession(sessionId)`                  | 删除该 Session 的所有句柄             |
| `prune()`                                  | 删除过期句柄                          |

默认 TTL 为一小时。句柄不存在、过期或属于其他 Session 时读取失败。默认 Store 位于内存中。

## 确定性 SQL 生成与执行

### `generate(input): Promise<GeneratedSqlRun>`

```ts
type GenerateSqlInput = {
  question: string;
  maxContextChars?: number; // 默认 8,000，范围 1,000–20,000
  signal?: AbortSignal;
};
```

结果包含 `runId`、`status`、`question`、`sql`、`explanation`、`assumptions`、检索 `evidence`、`safety`、时间戳与可选用量。

只有通过只读安全检查时，状态才是 `awaiting_execution`；否则为 `blocked`。

### `executeGenerated(runId, options?): Promise<ExecutedSqlRun>`

重新检查并执行 `awaiting_execution` Run。`options.limit` 默认为 `defaultRowLimit`，范围 1–1,000。

### `getRun(runId): SqlRunSnapshot | undefined`

返回进程内快照。确定性 Run 快照不会跨 Runtime 重启持久化。

## 模型直调 API

| 方法                                                     | 作用                                             |
| -------------------------------------------------------- | ------------------------------------------------ |
| `llmChat(request, options?)`                             | 一次 Chat 响应                                   |
| `llmStream(request, options?)`                           | Stream Event 异步迭代器                          |
| `submitLlmBatch(requests, { concurrency?, ...options })` | 进程内异步批量 Job                               |
| `getLlmJob(id)` / `cancelLlmJob(id)`                     | 读取或取消批量 Job                               |
| `llmModels()`                                            | 返回已注册模型元数据                             |
| `discoverLlmModels()`                                    | 查询 Provider 元数据/模型列表，不发送测试 Prompt |
| `llmMetrics()`                                           | 返回模型指标                                     |

Runtime 会自动填入当前模型；`llmChat`/`llmStream` 请求不提供 `model`。

## 底层数据库与资源 API

`runtime.database` 提供 Agent 使用的 Connector 中立基础能力：

- 档案：`createProfile`、`updateProfile`、`deleteProfile`、`getProfile`、`listProfiles`；
- 连接：`testProfile`、`connect`、`reconnect`、`disconnect`、`health`；
- 能力/发现：`capabilities`、`discoverPage`、`discoverAll`；
- 查询：`submit`、`getJob`、`cancel`、`readResult`；
- 事务：`beginTransaction`、Savepoint、Commit、Rollback；
- 资源：`queryResources`、`resourceRelations`、`snapshotResources`；
- 生命周期：`metrics`、`close`。

`runtime.resources` 提供资源新建/更新/查询、关系图与遍历、观测/状态、事件、快照和恢复。

这些是通用基础 API，不是 v1 治理运维 Agent。

`ConnectionProfile.scope` 可把发现资源绑定到 `tenantId`、`organizationId`、`projectId`、`environment` 和/或 `region`。数据库 Runtime 会把档案范围传播到每个发现资源；Connector 若返回冲突范围会被拒绝。SchemaNaut 快捷连接会自动绑定当前 Runtime 租户与选定 Project。

## 本地 REST API

服务默认监听 `127.0.0.1:3721`，并拒绝非回环地址。服务校验 `Host`，浏览器请求必须同源，携带请求体的变更接口必须使用 `application/json`。Agent Run 的 `maxIterations` 范围为 1–64，`maxToolExecutionMs` 范围为 1–300,000。

### 嵌入式 Server 生命周期

公开子路径 `@nwlworkshop/schemanaut/server` 导出 `startDatabaseAgentServer()`：

```ts
import { DatabaseAgentRuntime } from '@nwlworkshop/schemanaut';
import { startDatabaseAgentServer } from '@nwlworkshop/schemanaut/server';

const runtime = new DatabaseAgentRuntime({
  tenantId: 'acme',
  projectDirectory: '/srv/acme-data',
});

const started = await startDatabaseAgentServer({
  runtime,
  host: '127.0.0.1',
  port: 0,
  allowProcessMcpManagement: false,
});

console.log(started.url);
await started.close();
```

`port: 0` 表示由操作系统分配可用的本机端口。返回对象公开 `server`、`runtime`、`host`、`port`、`url`，以及可幂等调用的异步 `close()`。关闭时会停止接收请求、取消活跃请求工作，并等待 Runtime 清理完成。

`allowProcessMcpManagement` 默认为 `false`。只有可信本机嵌入宿主明确允许 REST 客户端启动已配置的 stdio MCP 子进程时才可设为 `true`。这些命令会继承宿主进程的操作系统权限；该选项不适合不可信浏览器、远程客户端或共享网关。

### AI SQL 主链路

| 方法与路径                                               | 请求 / 结果                                                                                              |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `POST /v1/setup`                                         | `{ llm, database }`，配置 Provider 并连接 PostgreSQL                                                     |
| `POST /v1/schema/index`                                  | `{ maxTables? }`，构建知识索引                                                                           |
| `GET /v1/schema/status`                                  | 当前 `SchemaIndexSnapshot`                                                                               |
| `POST /v1/agent/run`                                     | `{ message, userId?, mode?, sessionId?, maxIterations?, maxToolExecutionMs? }`，返回 `AiSqlAgentRunView` |
| `POST /v1/agent/run/stream`                              | 相同请求体；返回语义化 Server-Sent Events，最后发送投影后的 `result`                                     |
| `POST /v1/agent/sessions/:id/compact`                    | `{ focus? }`，手动上下文压缩                                                                             |
| `GET /v1/agent/sessions/:id/context-checkpoints?limit=N` | 上下文检查点历史                                                                                         |

JSON Run 接口和 Stream 最终结果都使用去内部化视图。SDK 的 `runAgent()` 仍是完整的可信集成入口。

### Agent 语义事件流

`POST /v1/agent/run/stream` 响应头为 `Content-Type: text/event-stream`。每个进度帧格式为：

```text
event: <AgentUserEvent.type>
data: <AgentUserEvent JSON>
```

典型事件包括 `plan-updated`、`sql-prepared`、`sql-executed`、`correcting`、`approval-required` 和 `completed`。成功时最后发送：

```text
event: result
data: <AiSqlAgentRunView JSON>
```

失败时发送 `event: error`，数据为 `{ "error": { "code", "message", "retryable" } }`。客户端断开连接会取消当前 Run。

### Agent 管理

| 方法与路径                                  | 请求 / 结果                                                                                        |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `GET /v1/agent/sessions`                    | Query：`userId?`、`query?`、`archived?`、`limit?`、`offset?`；返回 Session 摘要                    |
| `GET /v1/agent/sessions/:id`                | 返回 `AgentSessionView`；不存在时为 `404`                                                          |
| `DELETE /v1/agent/sessions/:id`             | 返回 `{ deleted }`；状态为 `200` 或 `404`                                                          |
| `POST /v1/agent/sessions/:id/steer`         | `{ message }`；返回 `202 { accepted: true }` 或 `409 { accepted: false, reason: "no-active-run" }` |
| `GET /v1/agent/skills`                      | 返回模型安全的 Skill 目录                                                                          |
| `POST /v1/agent/skills/refresh`             | 返回 `{ changed, revision, skills, issueCount, conflictCount }`                                    |
| `GET /v1/agent/approvals`                   | 返回 Broker 持有的待处理许可请求                                                                   |
| `POST /v1/agent/approvals/:id/resolve`      | `{ approved, resolvedBy?, reason? }`；返回 `{ resolved: true, approved }`                          |
| `GET /v1/agent/mcp`                         | 返回 `McpServerSummary[]`，不含命令、环境变量、Header 或 Secret                                    |
| `POST /v1/agent/mcp`                        | 新建或更新 `McpServerRegistrationInput`；返回状态 `201` 与摘要                                     |
| `POST /v1/agent/mcp/:id/start` / `:id/stop` | 启动或停止一个已配置 Server                                                                        |
| `DELETE /v1/agent/mcp/:id`                  | 运行中会先停止，再删除配置，返回 `{ removed }`；状态为 `200` 或 `404`                              |

使用默认 Broker 时，收到 `approval-required` 后可在 Stream 保持连接期间查询待处理许可并提交处理结果，默认等待五分钟。提供自定义 `approvalProvider` 后，许可交付由回调负责，Broker 接口不会出现待处理请求。

REST 默认禁止管理进程型 stdio MCP。可信本地宿主必须在创建 Server 时显式设置 `allowProcessMcpManagement: true`；远程 HTTP/SSE MCP 仍遵循 URL、Secret 引用和传输校验。

### 确定性链路

| 方法与路径                | 作用                             |
| ------------------------- | -------------------------------- |
| `POST /v1/query/generate` | `{ question, maxContextChars? }` |
| `POST /v1/query/execute`  | `{ runId, limit? }`              |
| `GET /v1/runs/:id`        | 读取进程内 Run 快照              |

### 模型与数据库基础接口

- 模型：`/v1/llm/provider-presets`、`/v1/llm/setup`、`/v1/llm/models`、`/v1/llm/chat`、`/v1/llm/chat/stream`、`/v1/llm/jobs`、`/v1/llm/metrics`；
- 数据库：`/v1/database/profiles`、`/v1/database/connectors`、`/v1/database/queries`、`/v1/database/results`、`/v1/database/transactions`；
- 资源：`/v1/resources`、`/v1/resources/traverse`、`/v1/resource-events`；
- 服务：`/health`、`/v1/status`、`/v1/capabilities`。

成功响应为 JSON。错误格式：

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable message",
    "retryable": false
  }
}
```

SchemaNaut 不提供用户账号、注册或登录体系。身份认证和 API 访问控制由嵌入它的宿主应用或网关负责。SchemaNaut 也不提供持久 Secret Vault。

资源读取接口接受同名范围查询参数。共享服务中的宿主必须从已认证身份推导或校验这些参数，不能信任客户端任意声明的租户或 Project ID。

## 错误

`DatabaseAgentError`：

```ts
type DatabaseAgentErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_CONFIGURED'
  | 'CONNECTION_FAILED'
  | 'SCHEMA_NOT_INDEXED'
  | 'LLM_REQUEST_FAILED'
  | 'LLM_RESPONSE_INVALID'
  | 'SQL_BLOCKED'
  | 'RUN_NOT_FOUND'
  | 'RUN_NOT_EXECUTABLE'
  | 'QUERY_FAILED'
  | 'ABORTED'
  | 'INTERNAL_ERROR';
```

属性：

```ts
{
  code: DatabaseAgentErrorCode;
  message: string;
  retryable: boolean;
  detail?: string;
}
```

底层数据库错误使用 `DatabaseAccessRuntimeError`，资源冲突使用 `ResourceConflictError`，公共合同错误使用 `ContractValidationError`。

## 公共合同与导出

顶层导出包括：

- 模型 Provider、Gateway、Registry、Router、用量、缓存、探针和预设 API；
- `DatabaseAccessRuntime`、`ConnectorRegistry`、`PostgresConnector` 和 Connector 合同校验；
- `ResourceRegistry` 与资源快照 Store；
- 版本化合同校验器和无损 Portable JSON 工具；
- 连接、查询、结果、事务、能力、资源和观测领域类型；
- `AgentSession`、`AgentMode`、`AgentUserEvent`、Project 辅助函数和上下文检查点类型；
- 面向用户的 Agent Run/Session 视图，以及 Session、Skill、许可与 MCP 管理合同。

完整结构类型以安装包中的 TypeScript 声明为准。
