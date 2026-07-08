# 2026-07-08 Agent/RAG live + PostgreSQL 组合验收

## 背景

当前 Agent/RAG 已有两类测试：真实 PostgreSQL + scripted provider，以及真实 SiliconFlow + fake database driver。两者分别覆盖数据库侧真实行为和模型侧 tool-calling 行为，但没有在同一个用例中验证“真实模型读取真实 Schema RAG，并对真实 PostgreSQL 执行只读分析查询”。

本切片补齐发布前强门禁，不改变默认测试和 CI 行为。

## 实现内容

- `packages/core-tools/test/agent-rag-business-scenario.test.ts`
  - 新增 `DBAGENT_RUN_AGENT_RAG_LIVE_POSTGRES=1` 门控用例。
  - 用 `PostgresDriver` 创建电商/流量分析业务 fixture。
  - 用 `indexSchemaCatalogFromReader()` 从真实 PostgreSQL catalog 抽取 schema 并建立 RAG 索引。
  - 注册 `search_schema` 与 `query_database`，并用真实 SiliconFlow provider 运行 `ReactAgent`。
  - 断言 Agent 至少成功调用 `search_schema` 和 `query_database`，最终报告同时包含 `live: true` 和 `postgres: true`。
- `scripts/run-agent-rag-live-tests.mjs`
  - 默认行为保持不变：只设置 `DBAGENT_RUN_AGENT_RAG_LIVE=1`。
  - 当设置 `DBAGENT_RUN_AGENT_RAG_LIVE_POSTGRES=1` 时，先检测 PostgreSQL 端口可达，再重建 `dbagent_core_tools_test`。
  - `tmp/agent-rag-live-report/run.json` 只记录 host/port/database 和模型名，不记录数据库密码或 API key。

## 运行方式

默认真实模型门禁：

```powershell
$env:TEST_SILICONFLOW_API_KEY='<本机临时测试密钥>'
$env:TEST_SILICONFLOW_MODEL='deepseek-ai/DeepSeek-V4-Pro'
pnpm test:agent-rag-live
```

真实模型 + 真实 PostgreSQL 组合门禁：

```powershell
$env:DBAGENT_RUN_AGENT_RAG_LIVE_POSTGRES='1'
$env:TEST_SILICONFLOW_API_KEY='<本机临时测试密钥>'
$env:TEST_SILICONFLOW_MODEL='deepseek-ai/DeepSeek-V4-Pro'
pnpm test:agent-rag-live
```

PostgreSQL 默认连接仍沿用测试变量：

- `DBAGENT_TEST_PG_HOST`
- `DBAGENT_TEST_PG_PORT`
- `DBAGENT_TEST_PG_USER`
- `DBAGENT_TEST_PG_PASSWORD`
- `DBAGENT_TEST_PG_MAINTENANCE_DATABASE`

组合门禁默认重建的数据库是 `dbagent_core_tools_test`。脚本会拒绝重建不符合 `dbagent_*_test` 命名的数据库，避免误删用户库。

## 开源方案评估

本轮没有引入新依赖。

- RAGAS 更适合文档 RAG 的 retrieval/generation 指标，不直接覆盖数据库工具参数、SQL 安全边界和真实查询结果证据。
- LangSmith/LangChain eval 适合云端 trace 和复杂 agent 观测，但会引入外部平台依赖，不适合当前本地优先、密钥不出库的门禁。
- promptfoo 适合 prompt 回归矩阵，但当前要断言的是 Agent tool execution record、Schema RAG 命中和真实 PostgreSQL 查询结果，使用现有 `AgentEvalSuiteRunService` 更直接。

后续如果需要接入这些项目，应放在官方 eval 插件 adapter 层，不能让 core 包直接依赖外部云服务。

## 验收标准

- 默认 `pnpm test` 不需要 API key 或 PostgreSQL。
- `pnpm test:agent-rag-live` 无组合开关时继续只跑真实模型 + fake DB live case。
- 设置 `DBAGENT_RUN_AGENT_RAG_LIVE_POSTGRES=1` 后，脚本必须自动准备测试库。
- 组合用例必须通过真实 PostgreSQL catalog 建 RAG，不能使用静态 fake schema。
- 组合用例必须通过真实 SiliconFlow 模型触发 tool calling，不能用 scripted provider。
- `query_database` 只允许单条只读 SQL，不能因为 fixture 连接可写而放宽。
- 报告、日志和文档不得包含 API key 或数据库密码。

## 已知边界

- live + PostgreSQL 组合门禁受外部网络、模型服务稳定性和模型 tool-calling 行为影响，因此保持 opt-in。
- 当前 suite 的断言仍以工具调用、参数片段、结果证据和最终文本片段为主，未引入 LLM judge。
- 后续可增加多业务域 fixture，例如权限审计、退款风控、库存周转和广告归因，但应继续保持每个 suite 可本地重放。
