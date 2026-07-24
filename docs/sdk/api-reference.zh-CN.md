# SchemaNaut SDK API 参考

[English](api-reference.md) · [SDK 指南](README.zh-CN.md) · [项目首页](../../README.zh-CN.md)

- 包名：`@nwlworkshop/schemanaut`
- 模块格式：ESM
- 最低运行环境：Node.js 22.5
- 当前 API 版本：`0.1.0`（Alpha）

本文描述顶层支持的导出，以及通过 `DatabaseAgentRuntime` 可访问的公开对象。

## `DatabaseAgentRuntime`

```ts
new DatabaseAgentRuntime(options?: DatabaseAgentRuntimeOptions)
```

### 构造参数

| 参数 | 类型 | 用途 |
| --- | --- | --- |
| `provider` | `LlmProvider` | 初始模型 Provider；必须和 `model` 一起提供 |
| `gateway` | `LlmGateway` | 注入已有 LLM Gateway |
| `model` | `string` | 初始模型 ID；必须和 `provider` 一起提供 |
| `tenantId` | `string` | 模型遥测和策略上下文租户键；默认 `local-default` |
| `driver` | `IDatabaseDriver` | 兼容数据库 Driver 覆盖 |
| `databaseAccess` | `DatabaseAccessRuntime` | 注入完整统一数据库 Runtime |
| `connectors` | `DatabaseConnector[]` | 添加或替换 Connector |
| `connectorRegistry` | `ConnectorRegistry` | 注入 Connector Registry |
| `resourceRegistry` | `ResourceRegistry` | 注入产品级资源 Registry |
| `credentialResolver` | `CredentialResolver` | 在公开档案之外解析凭据引用 |
| `databaseAuditSink` | `DatabaseAuditSink` | 接收数据库审计事件 |
| `rag` | `SchemaRagEngine` | 注入知识与检索引擎 |
| `retrievalProfile` | `SchemaRagRetrievalProfile` | 配置词法、Embedding、Rerank、图扩展和上下文 |
| `createRunId` | `() => string` | 自定义或确定性 SQL Run ID 工厂 |
| `createConnectionId` | `() => string` | 自定义或确定性快捷连接 ID 工厂 |
| `now` | `() => string` | 用于确定性测试的 ISO 时间工厂 |
| `defaultRowLimit` | `number` | 快捷执行行数，1–1,000；默认 200 |
| `usageTracker` | `UsageTracker` | 注入共享用量统计 |
| `approvalProvider` | `ApprovalProvider` | 处理超出当前 Agent 模式的请求 |
| `agentDependencies` | `AgentRunDependencies` | 注入 Agent Store、时钟、ID、审计和检查点依赖 |
| `sessionStore` | `AgentSessionStore` | 注入持久化或自定义 Session Store |
| `sessionDatabasePath` | `string` | SQLite 路径；默认 `.schemanaut/schemanaut.db` |
| `resultStore` | `AiSqlResultStore` | 注入 Agent 分页结果 Store |

只提供 `provider` 或 `model` 其中一个时，构造函数抛出代码为 `INVALID_INPUT` 的 `DatabaseAgentError`。

### 公开属性

| 属性 | 类型 | 说明 |
| --- | --- | --- |
| `database` | `DatabaseAccessRuntime` | Connector 中立的数据库、数仓和集群 Runtime |
| `resources` | `ResourceRegistry` | 与 `database.resources` 是同一个实例 |
| `sessions` | `AgentSessionStore` | 持久 Session、偏好、导出与上下文检查点 |
| `tools` | `ToolRegistry` | Agent 内置工具 Registry |
| `skills` | `SkillRegistry` | 内置和应用注册的 Skill Registry |
| `results` | `AiSqlResultStore` | Session 隔离、自动过期的 Agent 结果句柄 |

`tools`、`skills` 和 `results` 在 `0.1.x` 中是公开扩展与评测入口；其具体类型尚未作为稳定的顶层包 API 重新导出。

### 配置与生命周期

#### `configureProvider(provider, model): void`

注册 Provider 和当前模型。可在构造后调用，也可替换高层 Runtime 使用的模型选择。

#### `status(): RuntimeStatus`

返回 Provider/模型配置、当前快捷连接、Schema 索引状态、SQL Run 数、已注册模型数和 LLM 指标。

#### `close(): Promise<void>`

关闭快捷连接和统一数据库 Runtime，并清空内存 SQL Run。应用退出时调用一次。

### PostgreSQL 快捷入口

#### `testConnection(input): Promise<ConnectionTestResult>`

测试 PostgreSQL 连接，不保留 Session。

#### `connect(input): Promise<SavedConnection>`

打开当前 PostgreSQL 快捷连接。输入：

```ts
type PostgresConnectionInput = {
  id?: string;
  name?: string;
  host: string;
  port?: number; // 默认 5432
  database: string;
  username: string;
  password?: string;
  ssl?: boolean | 'prefer' | 'require' | 'verify-ca' | 'verify-full';
  connectionTimeoutMs?: number; // 默认 10,000
  statementTimeoutMs?: number;  // 默认 30,000
  readOnly?: boolean;
};
```

#### `disconnect(): Promise<void>`

断开当前快捷连接，删除其知识索引，并清空高层 SQL Run。

### 知识索引

#### `indexSchema(options?): Promise<SchemaIndexSnapshot>`

构建或刷新当前连接的知识目录与检索索引。

```ts
type IndexSchemaOptions = { maxTables?: number }; // 1–1,000；默认 200
```

#### `schemaStatus(): SchemaIndexSnapshot`

返回 `not_connected`、`not_indexed` 或 `ready`，以及表、列、关系和文档数量。

### AI SQL Agent

#### `runAgent(input): Promise<AiSqlAgentRun>`

```ts
type RunAiSqlAgentInput = {
  message: string;                    // 1–4,000 字符
  userId?: string;
  mode?: 'read' | 'edit' | 'full';   // 默认 read
  session?: AgentSession;
  sessionId?: string;
  maxIterations?: number;
  maxToolExecutionMs?: number;
  signal?: AbortSignal;
};
```

返回：

```ts
type AiSqlAgentRun = {
  selectedSkill: string;
  result: AgentRunResult;
};
```

`AgentRunResult` 包含状态、完整 Session、最终文本、迭代次数、Tool 执行记录和可选的上下文压缩报告。

#### `compactAgentSession(input): Promise<AgentContextCompactionResult>`

为 Session 手动创建语义检查点。提供 `session` 或 `sessionId`，可附带 `focus` 与 `signal`。

#### `agentContextCheckpoints(sessionId, limit?): Promise<AgentContextCheckpoint[]>`

返回按顺序排列的上下文检查点。Store 接受 1–1,000 的限制。

### SQL 生成与执行

#### `generate(input): Promise<GeneratedSqlRun>`

```ts
type GenerateSqlInput = {
  question: string;         // 1–4,000 字符
  maxContextChars?: number; // 1,000–20,000；默认 8,000
  signal?: AbortSignal;
};
```

返回 SQL、解释、假设、证据、安全报告、时间、可选用量和 `awaiting_execution` 或 `blocked` 状态。

#### `executeGenerated(runId, options?): Promise<ExecutedSqlRun>`

使用 `{ limit?: number }` 执行 `awaiting_execution` Run，行数 1–1,000。确定性快捷入口只执行安全分析器接受的单条只读 `SELECT`、`WITH` 或 `VALUES`。

#### `getRun(runId): SqlRunSnapshot | undefined`

返回当前内存 SQL Run 的副本。

### 直接模型调用

#### `llmChat(request, options?): Promise<LlmChatResponse>`

`request` 是不含 `model` 的 `LlmGatewayChatRequest`；Runtime 自动使用当前模型。

常用选项：

```ts
type LlmRuntimeCallOptions = {
  taskType?: string;
  userId?: string;
  policies?: LlmPolicyLayers;
  budget?: LlmBudgetLimits;
  timeoutMs?: number;
  maxRetries?: number;
  maxFallbacks?: number;
  cache?: { enabled: boolean; ttlMs?: number; namespace?: string };
};
```

#### `llmStream(request, options?): AsyncIterable<LlmChatStreamEvent>`

流式返回文本增量、Tool Call 增量、用量和结束事件。

#### `submitLlmBatch(requests, options?): LlmAsyncJob<LlmGatewayResult>`

提交异步批量任务。选项额外支持 `concurrency`。

#### `getLlmJob(id)` / `cancelLlmJob(id)`

读取或取消异步 LLM Job。

#### `llmModels(): RegisteredLlmModel[]`

返回本地模型 Registry。

#### `discoverLlmModels(): Promise<RegisteredLlmModel[]>`

只查询 Provider 的模型与元数据 API。发现失败会记录为未知健康状态，不发送验证 Prompt。

#### `llmMetrics(): LlmMetricsSnapshot`

返回请求、Token、延迟、失败、重试、缓存等聚合指标。

## `runtime.sessions`

| 方法 | 结果 |
| --- | --- |
| `save({ session, now? })` | 新建或更新 Session 并返回摘要 |
| `load(id)` | 加载完整 Session，找不到时返回 `undefined` |
| `list(filter?)` | 按用户、归档状态、文本、limit 和 offset 查询摘要 |
| `update(id, patch, now?)` | 修改标题、模式或 aborted 状态 |
| `archive(id, archived?, now?)` | 归档或恢复 Session |
| `delete(id)` | 删除 Session 并返回其是否存在 |
| `fork({ id, fromMessageIndex, newId?, title?, now? })` | 截止指定消息创建 Session 分支 |
| `export(id, 'json' \| 'markdown')` | 导出完整 Session |
| `upsertPreference(input)` | 新建或更新用户偏好 |
| `listPreferences(userId, limit?)` | 按置信度和更新时间返回偏好 |
| `deletePreference(userId, key)` | 删除一条偏好 |
| `listContextCheckpoints(sessionId, limit?)` | 返回持久化压缩检查点 |

Session 消息以追加方式存入独立 SQLite 表，持久化内容会经过 Secret 脱敏。

## `runtime.tools`

| 方法 | 用途 |
| --- | --- |
| `register(definition, handler)` | 注册唯一 Agent Tool |
| `unregister(name)` | 删除 Tool |
| `get(name)` | 读取已注册 Tool |
| `list()` | 列出 Tool |
| `has(name)` | 检查是否存在 |
| `llmTools(allowedTools?)` | 只投影模型可见的名称、说明和 JSON Schema |

Tool 定义包含 `name`、`description`、`inputSchema`、`dangerLevel`，以及可选的 `readonly`、来源元数据和所需权限。Handler 接收参数、Session、取消信号和批准证据。

## `runtime.skills`

| 方法 | 用途 |
| --- | --- |
| `register(skill)` / `unregister(name)` | 管理 Skill 定义 |
| `get(name)` / `list()` | 读取 Skill |
| `filterToolsForSkill(name, availableTools)` | 应用 Skill Tool 白名单 |
| `createExecutionPlan(name, userInput, availableTools)` | 创建具体执行计划 |
| `findMatchingSkills(options)` | 对匹配 Skill 排序 |
| `createAutoExecutionPlan(options)` | 选择并规划最佳匹配 |

Runtime 注册少量产品级内置流程 Skill。应用 Skill 应明确声明允许使用的 Tool。

## `runtime.results`

| 方法 | 用途 |
| --- | --- |
| `put({ sessionId, connectionId, result })` | 将结果保存为自动过期句柄 |
| `read({ id, sessionId, cursor?, limit? })` | 读取 Session 隔离的分页 |
| `remove(id)` | 删除结果 |
| `clearSession(sessionId)` | 删除一个 Session 的全部结果 |
| `prune()` | 删除过期结果 |

默认结果 TTL 为一小时，其他 Session 无法读取。

## `DatabaseAccessRuntime`

`runtime.database` 提供以下 Connector 中立方法。

### 档案与连接

- `createProfile(profile)`
- `updateProfile(profileId, patch)`
- `deleteProfile(profileId)`
- `getProfile(profileId)`
- `listProfiles()`
- `testProfile(profileId, credential?)`
- `connect(profileId, credential?)`
- `reconnect(profileId, credential?)`
- `disconnect(profileId)`
- `health(profileId)`
- `getSession(sessionId)`
- `getSessionForProfile(profileId)`
- `capabilities(profileId)`

Profile 保存端点、Principal、用途、范围和 Connector 元数据。Secret 应放在调用时 Credential、Credential Reference 或 `CredentialResolver` 中。

### 发现与资源

- `discoverPage(profileId, request?)`
- `discoverAll(profileId, request?)`
- `queryResources(query?)`
- `resourceRelations(resourceId)`
- `snapshotResources()`

### Query Job 与结果

- `submit(submission): Promise<QueryJob>`
- `getJob(jobId): Promise<QueryJob>`
- `cancel(jobId): Promise<QueryJob>`
- `readResult(handleId, { cursor?, limit? }): Promise<ResultBatch>`
- `streamResult(handleId, { batchSize? }): AsyncIterable<ResultBatch>`

`QuerySubmission` 支持同步/异步、参数、事务/Session 绑定、超时、行数/批次限制、Dry Run/确认、成本限制、授权、标签和优先级。

### 事务

- `beginTransaction(profileId, options?)`
- `createSavepoint(transactionId, name)`
- `rollbackToSavepoint(transactionId, name)`
- `commitTransaction(transactionId)`
- `rollbackTransaction(transactionId)`

### 观测、运维和审计

- `observe(request): Promise<ResourceObservation[]>`
- `operate(request): Promise<DatabaseOperationResult>`
- `listAuditEvents({ profileId?, limit? })`
- `metrics(): DatabaseAccessMetrics`
- `close(): Promise<void>`

运维操作是 Connector 声明的原子动作，包含风险级别和所需能力。授权由请求显式携带，不由模型推断。

## `ResourceRegistry`

稳定的资源与状态 API 包括：

- 写入：`upsertResource`、`upsertRelation`、`addObservation`、`applyDiscoveryPage`、`applyChangeSet`
- 查询：`getResource`、`getRelation`、`query`、`relationsFor`、`neighbors`、`traverse`
- 状态：`observationsFor`、`resolveFact`、`state`、`events`
- 生命周期：`markResourceDeleted`、`restoreResource`、`markRelationDeleted`、`restoreRelation`
- 身份：`bindResources`
- 持久化：`snapshot`、`restore`、`clear`

公开快照存储：

- `InMemoryResourceSnapshotStore`
- `JsonFileResourceSnapshotStore`

公开身份工具：

- `createStableResourceId`
- `createStableRelationId`
- `createResourceObservation`

## 模型相关导出

### Provider

- `OpenAICompatibleProvider`
- `createSiliconFlowProvider`
- `AnthropicProvider`
- `LLM_PROVIDER_PRESETS`
- `getLlmProviderPreset`
- `createProviderFromPreset`

### Gateway 与基础设施

顶层入口还导出完整 LLM 平台，包括 `LlmGateway`、`LlmRouter`、模型 Registry、任务路由、结构化输出验证、Prompt Runtime、响应缓存、可靠性、遥测、预算、异步 Job 及其公开类型。

除非应用需要多个自定义 Provider/模型或平台级路由，优先使用 `DatabaseAgentRuntime` 包装方法。

## 错误

### `DatabaseAgentError`

字段：`code`、`message`、`retryable`、可选 `detail`。

代码：

- `INVALID_INPUT`
- `NOT_CONFIGURED`
- `CONNECTION_FAILED`
- `SCHEMA_NOT_INDEXED`
- `LLM_REQUEST_FAILED`
- `LLM_RESPONSE_INVALID`
- `SQL_BLOCKED`
- `RUN_NOT_FOUND`
- `RUN_NOT_EXECUTABLE`
- `QUERY_FAILED`
- `ABORTED`
- `INTERNAL_ERROR`

`asDatabaseAgentError(error)` 将未知错误、取消和 LLM Provider 错误转换为该高层错误。

其他公开错误包括 `DatabaseAccessRuntimeError`、`ContractValidationError`、`ResourceConflictError`、`ResourceSnapshotStoreError`，以及 `LlmProviderError` 等 LLM 平台错误。

## 公共合同与传输工具

### 合同版本

- `CURRENT_CONTRACT_VERSION`
- `SUPPORTED_CONTRACT_VERSIONS`
- `createContractEnvelope`
- `assertContractEnvelope`

### 校验器

- `assertConnectionProfile`
- `assertDatabaseAccessError`
- `assertNoSecretMaterial`
- `assertPortableValue`
- `assertQuerySubmission`
- `assertResourceChangeSet`
- `assertResourceDescriptor`
- `assertResourceObservation`
- `assertResourceRegistrySnapshot`
- `assertResourceRelation`

### 无损 JSON

- `toPortableValue`
- `fromPortableValue`
- `stringifyPublicJson`
- `parsePublicJson`

Portable JSON 在公共传输合同中保留 `bigint`、二进制和日期等支持的值，避免静默降级。

### Connector 开发

- `ConnectorRegistry`
- `CapabilityResolver`
- `DATABASE_CAPABILITIES`
- `PostgresConnector`
- `verifyConnectorContract`

公开 Connector 类型包括 `DatabaseConnector`、`ConnectorManifest`、`ConnectorContext`、`DiscoveryRequest`、事务选项、Credential/审计抽象和 Connector 认证报告。

## 公开领域类型

顶层包导出 `packages/sdk/src/types.ts` 的高层 SDK 类型、全部公开 LLM 平台类型，以及以下公共合同族：

- 连接：`ConnectionProfile`、`ConnectionSession`、`ConnectionHealth`、`DatabaseEndpoint`、`DatabaseCredential`
- 能力：`CapabilityProfile`、`CapabilityDescriptor`、`CapabilityRequirement`、`CapabilityConstraint`、`CapabilityCheck`
- 查询：`QuerySubmission`、`QueryJob`、`ResultHandle`、`ResultBatch`、`DatabaseTransaction`
- 运维：`DatabaseObservationRequest`、`DatabaseOperationDescriptor`、`DatabaseOperationRequest`、`DatabaseOperationResult`、`DatabaseAuditEvent`
- 资源：`ResourceDescriptor`、`ResourceRelation`、`ResourceObservation`、`ResourceQuery`、`ResourceTraversalRequest`、`ResourceStateSnapshot`、`ResourceRegistrySnapshot` 以及变更、事件、来源类型
- 传输：`ContractEnvelope`、`PortableValue`、`PortableScalar`、`PortableTaggedValue`、`PublicErrorBase`

安装包内的 TypeScript 声明是所有嵌套字段的权威编译期来源。
