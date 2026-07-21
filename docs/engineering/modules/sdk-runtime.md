# sdk Headless Runtime 模块

## 代码入口

- `packages/sdk/src/runtime.ts`：连接、索引、生成、审计、显式执行和 run 状态机。
- `packages/sdk/src/types.ts`：可嵌入的公开输入、输出和 adapter 合同。
- `packages/sdk/src/parse-generation.ts`：模型结构化输出解析。
- `packages/sdk/src/errors.ts`：稳定错误码与错误归一化。
- `packages/sdk/src/index.ts`：公共导出入口。

## 模块职责

`@dbagent/sdk` 是当前产品的主入口，也是 REST、CLI、WebUI 和后续 MCP adapter 的唯一业务运行时。它只组合 `core-db`、`core-rag` 与 `core-llm`，不依赖 Electron、HTTP 或任意 UI 框架。

当前唯一闭环为：

```text
配置 Provider → 连接 PostgreSQL → 索引 Schema
→ 自然语言生成 SQL → 本地安全审计
→ 保存 run → 调用方显式执行 → 返回有限结果
```

生成与执行故意拆成两个方法。`executeGenerated(runId)` 不接受任意 SQL，只能执行 Runtime 内保存、状态为 `awaiting_execution` 且再次审计通过的 SQL，避免调用方绕过生成记录和安全边界。

## 状态与错误

run 状态包括：

- `awaiting_execution`：生成 SQL 已通过本地审计，等待调用方明确执行。
- `blocked`：生成 SQL 不符合只读策略，不能执行。
- `executing`：数据库调用进行中。
- `completed`：执行成功并保存结构化结果。
- `failed`：driver 返回失败或抛出异常，run 保留稳定错误码。

连接断开时清理当前连接的内存 Schema 索引和 run，MVP 不做跨进程持久化。Provider、Driver、时钟和 id 生成器可注入，便于宿主应用组合和确定性测试。

## 安全边界

- SDK 强制连接配置 `readOnly: true`，忽略调用方将连接改成可写的可能性。
- 默认连接超时 10 秒、语句超时 30 秒；调用方可在受限范围内覆盖。
- PostgreSQL 会话设置 `default_transaction_read_only=on`。
- 生成后和执行前各运行一次 `analyzeSqlSafety()`。
- 除 `SELECT`、只读 `WITH` 和 `VALUES` 外均不可执行。
- 阻断多语句、可写 CTE、DDL/DML、`SELECT INTO`、行锁子句和已知副作用函数。
- 默认最多返回 200 行，硬上限 1000 行。
- 运行快照不包含 API Key 或数据库密码。

正则与词法审计是纵深防御的一层，不代替数据库权限。生产使用仍应配置专用只读数据库账号。

## 测试覆盖

- `parse-generation.test.ts`：JSON、Markdown code fence、原始只读 SQL 和无效响应。
- `runtime.test.ts`：完整 fake adapter 闭环、执行前不触碰 driver、安全阻断、错误状态、生命周期和默认超时。
- `postgres.integration.test.ts`：真实 PostgreSQL Catalog 索引、Schema 证据、显式执行和只读结果。
- 同一集成文件提供 `DBAGENT_RUN_SDK_MVP_LIVE=1` 门控，验证真实 OpenAI-compatible 模型与真实 PostgreSQL 组合闭环。

## 开源优先结论

本切片没有引入 Vanna、LangChain、LlamaIndex 或新的 Agent 框架。原因是现有 `core-db`、`core-rag` 和 `core-llm` 已覆盖 MVP 所需稳定边界，直接引入框架会扩大依赖、模型下载、存储和许可评估范围。借鉴 Vanna 等产品的 Headless、可嵌入和参考 UI 分层，但 Runtime 合同保持 DBAgent 自有且框架无关。

后续 embedding、向量存储、reranker、评测框架和 MCP SDK 进入 H2 时，分别通过 adapter 接入并重新做许可证、离线、跨平台和数据安全评估。

## 后续扩展

- run 与 Verified Query 持久化。
- 生成反馈与固定 NL2SQL 评测集。
- 取消、SSE 事件和可观测性。
- Python/HTTP 客户端与 MCP adapter。
- MySQL、ClickHouse 与国产数据库 driver。
