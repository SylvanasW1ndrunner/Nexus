# 11 - Headless Runtime MVP

> 文档版本：v1.0
> 状态：当前实现与验收基线
> 目标：让首位试用者在本机完成真实 PostgreSQL 自然语言查数。

## 1. MVP 假设

我们要验证的不是“用户是否喜欢一个新数据库 IDE”，而是：

1. 开发者是否愿意通过 SDK/API 接入数据库 Agent。
2. Schema Context 是否能让国内 OpenAI-compatible 模型生成可执行 SQL。
3. 生成、审计、人工执行分离是否足以建立基本信任。
4. 极简 WebUI 是否足以完成试用和收集反馈。

## 2. 唯一核心场景

> 用户配置模型和一个只读 PostgreSQL，输入“昨天每个城市的订单金额是多少？”，查看系统检索到的表字段、生成 SQL、解释和安全结果，确认后执行并得到有限行数的结果。

这条路径未跑通前，不开发更多数据库、复杂运维、插件市场和正式 IDE。

## 3. 功能范围

### 3.1 必须完成

- OpenAI-compatible Provider 配置。
- PostgreSQL 连接测试、连接和断开。
- 连接配置强制只读。
- 抽取表、列、注释、主外键、索引和约束。
- Schema RAG 索引和问题相关上下文。
- 让模型返回 SQL、解释和假设。
- 兼容纯 JSON、JSON code fence 和 SQL code fence 等常见模型输出。
- 本地 SQL 安全审计。
- 生成记录和显式执行。
- 结果行数限制、耗时和结构化错误。
- TypeScript SDK。
- 本地 REST API 和 Server CLI。
- 单页 WebUI。

### 3.2 明确不做

- 写 SQL、DDL、存储过程和多语句执行。
- 自动执行生成 SQL。
- SQL 手工编辑后执行。
- 多连接、多数据库和跨库查询。
- 向量数据库、embedding 下载和 reranker。
- 完整 Agent ReAct、Plan & Execute、子 Agent。
- MCP Server、插件市场和第三方插件安装。
- 用户账号、云同步、支付和团队管理。
- 运行历史持久化和 Verified Query 持久化。
- 正式桌面应用与复杂前端。

## 4. SDK 合同

### 4.1 配置

```ts
type DatabaseAgentRuntimeOptions = {
  provider?: LlmProvider;
  model?: string;
  driver?: IDatabaseDriver;
  createRunId?: () => string;
  now?: () => string;
};
```

Provider 与 Driver 可注入，用于嵌入和确定性测试。Server 使用现有 `OpenAICompatibleProvider` 与 `PostgresDriver`。

### 4.2 生成输入

```ts
type GenerateSqlInput = {
  question: string;
  maxContextChars?: number;
  signal?: AbortSignal;
};
```

### 4.3 生成结果

```ts
type GeneratedSqlRun = {
  runId: string;
  status: 'awaiting_execution' | 'blocked';
  question: string;
  sql: string;
  explanation: string;
  assumptions: string[];
  evidence: Array<{ title: string; kind: string; reasons: string[] }>;
  safety: QuerySafetyReport;
  createdAt: string;
  updatedAt: string;
};
```

### 4.4 执行结果

```ts
type ExecutedSqlRun = GeneratedSqlRun & {
  status: 'completed';
  execution: QueryExecutionResult;
};
```

Runtime 必须以 run id 将生成和执行关联起来。执行接口不接受 SQL 文本。

## 5. Prompt 合同

System Prompt 必须要求：

- 只输出一个 JSON 对象。
- SQL 只允许 PostgreSQL `SELECT`、只读 `WITH` 或 `VALUES`。
- 不使用不存在的表和字段。
- 优先使用提供的 Schema 注释和关系。
- 默认避免 `SELECT *`。
- 需要时间范围或业务口径但上下文不足时，在 `assumptions` 中声明。
- 不得输出写入、DDL、事务控制、会话设置和多条语句。

目标结构：

```json
{
  "sql": "select ...",
  "explanation": "查询逻辑说明",
  "assumptions": ["昨天按数据库时区计算"]
}
```

模型输出永远是不可信输入，解析后仍必须经过本地审计。

## 6. 安全状态机

```text
问题
  → Schema 检索
  → 模型生成
  → 本地解析
  → 本地 SQL 审计
      ├─ unsafe → blocked（不能执行）
      └─ safe   → awaiting_execution
                     → 用户显式执行
                     → 再次本地审计
                     → PostgreSQL readonly connection
                     → completed / failed
```

阻断条件：

- 空 SQL。
- 多条语句。
- INSERT、UPDATE、DELETE、MERGE、CALL。
- CREATE、ALTER、DROP、TRUNCATE。
- COPY、DO、GRANT、REVOKE、SET、VACUUM 等需审查语句。
- `WITH` 中包含写操作。
- `SELECT INTO`、`FOR UPDATE/SHARE` 等行锁子句。
- `nextval`、`setval`、advisory lock、backend control、large object 写入等已知副作用函数。
- 未知语句类型。
- 运行记录不存在或不是等待执行状态。

纵深防御还包括：PostgreSQL 会话强制 `default_transaction_read_only=on`、默认 10 秒连接超时、默认 30 秒语句超时和最多 1000 行硬上限。SDK 审计不能替代数据库权限，真实环境仍应使用专用只读账号。

## 7. REST 合同

### `GET /health`

```json
{
  "status": "ok",
  "service": "dbagent-server",
  "version": "0.1.0"
}
```

### `GET /v1/capabilities`

返回支持的数据库、模型协议、最大行数、安全模式和可用入口，不返回配置值。

### `POST /v1/setup`

请求同时包含模型和 PostgreSQL 配置。Server 在内存中构造 Provider，测试数据库并建立只读连接。响应只返回脱敏连接摘要。

### `POST /v1/schema/index`

抽取当前连接 Schema 并建立索引。返回表、字段、关系和文档数量。

### `GET /v1/schema/status`

返回当前连接索引状态。

### `POST /v1/query/generate`

请求：

```json
{ "question": "昨天每个城市的订单金额是多少？" }
```

响应为 `GeneratedSqlRun`，不得自动执行。

### `POST /v1/query/execute`

请求：

```json
{ "runId": "..." }
```

只执行 Runtime 中保存且安全状态为 `awaiting_execution` 的 SQL。

### `GET /v1/runs/{runId}`

返回脱敏运行快照；不存在时返回 `RUN_NOT_FOUND`。

## 8. 统一错误

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

HTTP 映射：

- 400：输入、模型输出或 SQL 不可执行。
- 404：运行不存在。
- 409：状态冲突、未配置或未索引。
- 499/408：用户取消或超时；Node Server 可统一返回 408。
- 502：模型或数据库上游失败。
- 500：未分类内部错误。

## 9. WebUI 验收

- 页面启动即显示健康状态。
- Secret 输入使用密码框，成功配置后立即清空。
- 未完成配置时不能索引和生成。
- 未完成索引时不能提问。
- SQL、解释、假设、证据和风险分区清晰。
- `blocked` 状态不显示执行按钮。
- 执行按钮明确写“执行只读 SQL”。
- 结果表对值做文本转义，不插入任意 HTML。
- 所有失败显示错误码和中文信息。

## 10. 测试矩阵

| 层级        | 场景                                    | 默认 CI  |
| ----------- | --------------------------------------- | -------- |
| SDK 单元    | 状态机、解析、安全、错误、取消          | 是       |
| SDK adapter | fake LLM + fake Driver 完整闭环         | 是       |
| Server      | 路由、JSON、状态码、Secret 脱敏、静态页 | 是       |
| PostgreSQL  | 连接、索引、只读执行、断开              | 独立门控 |
| 真实 LLM    | JSON 生成与 SQL 安全                    | opt-in   |
| 组合 E2E    | 真实 LLM + 真实 PostgreSQL + API        | 发布前   |

## 11. 本地试用目标

开发环境启动：

```powershell
pnpm dev:mvp
```

打包后，试用者只需要安装 Node.js 20.11 或更高版本，并运行下载到本机的 npm tarball：

```powershell
npx --yes .\DBAgent-Headless-MVP-v0.1.0.tgz
```

试用者不需要克隆仓库，也不需要安装 pnpm、Electron 或数据库服务器。

正式 npm 包名为 `@nwlworkshop/dbagent`；发布到 npm registry 后可直接运行 `npx --yes @nwlworkshop/dbagent`。

然后打开：

```text
http://127.0.0.1:3721
```

使用开发 fixture 时，PostgreSQL 默认配置：

- Host：`127.0.0.1`
- Port：`5432`
- Database：`dbagent_demo`
- Username：`postgres`
- Password：`postgres`

LLM 使用任意 OpenAI-compatible Base URL、API Key 和模型名。

## 12. MVP 完成后的用户反馈

试用时只收集以下信息：

1. 第一次配置花了多久，失败在哪里？
2. 问了什么真实问题？
3. SQL 是否直接正确、少量修改还是完全错误？
4. Schema 证据是否包含正确的表和字段？
5. 用户是否愿意点击执行，哪些信息影响了信任？
6. 最希望下一步增加 MCP、Verified Query、诊断工具还是数据库适配？

这些反馈决定 H2，而不是预先恢复旧 IDE 路线。
