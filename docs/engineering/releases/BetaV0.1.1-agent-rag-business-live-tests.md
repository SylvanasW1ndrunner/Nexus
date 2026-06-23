# BetaV0.1.1 - Agent/RAG 业务场景与真实依赖测试

## 背景

Agent 和 Schema RAG 不能只用简单表名样例验证。用户真实使用时会面对电商订单、退款、商品、客户、广告投放、流量会话、页面事件、脏事件表、安全字段和业务指标口径。因此本切片补充无 UI 的业务验收测试，验证 RAG 是否能召回正确 schema，Agent 是否能按工具链完成数据分析任务。

## 实现内容

- 新增 `packages/core-tools/test/business-scenario-fixture.ts`：
  - 电商域：`customers`、`products`、`orders`、`order_items`、`refunds`。
  - 流量分析域：`analytics.traffic_sessions`、`analytics.page_views`、`analytics.campaign_spend`。
  - 脏结构：`analytics.raw_evt`，无主键、字段缩写、JSONB payload。
  - 业务 glossary：GMV、退款率、转化率、ROI。
  - PostgreSQL DDL、comments、indexes 和样例数据。
- 新增 `packages/core-tools/test/agent-rag-business-scenario.test.ts`：
  - 默认确定性测试：RAG 检索业务问题、Agent 调用 `search_schema` + `query_database`、readonly destructive SQL 拦截。
  - PostgreSQL 门控测试：`DBAGENT_RUN_POSTGRES_TESTS=1` 时创建真实表、写入数据、抽取 catalog metadata、索引 RAG、运行 Agent 工具链。
  - SiliconFlow 门控测试：`DBAGENT_RUN_AGENT_RAG_LIVE=1` 且存在 `TEST_SILICONFLOW_API_KEY` 或 `DBAGENT_LLM_API_KEY` 时，使用 `deepseek-ai/DeepSeek-V4-Pro` 真实模型调用 RAG 和查询工具。
- 更新 `scripts/run-postgres-tests.mjs`：
  - 自动重建 `dbagent_core_db_test`、`dbagent_core_auth_test`、`dbagent_core_tools_test` 三个隔离数据库。
  - `core-db` 导入 `scripts/dev-db/init.sql` 标准 fixture。
  - 分文件顺序运行真实 PostgreSQL 集成测试，避免 auth 表污染 core-db/schema fixture。
- 新增 `scripts/run-agent-rag-live-tests.mjs` 和根命令 `test:agent-rag-live`。
- 更新 `docs/engineering/modules/core-tools.md` 和 `docs/engineering/test-strategy.md`。

## 开源评估

- 产品能力：验证 DBAgent Agent/RAG 在真实业务 schema 上的效果，而不是引入新检索框架。
- 候选方案：RAGAS、LangChain eval、LlamaIndex eval 更适合 LLM judge 或文档 RAG 评估，但当前需要 schema ID must-hit、工具调用和权限行为断言。
- 决策：不新增依赖。当前切片优先建立业务夹具和可重复验收矩阵；后续接入 embedding、reranker 或 LLM judge 时再按开源优先规范评估成熟组件。
- 打包影响：无运行时依赖变化；新增内容仅测试和脚本，不进入桌面应用包。
- 安全边界：真实 API key 只从环境变量读取，不写入代码、文档、日志或快照；数据库密码沿用现有 PostgreSQL 测试环境变量。

## 已运行验证

```powershell
node .\node_modules\vitest\vitest.mjs run packages\core-tools\test\agent-rag-business-scenario.test.ts
```

结果：1 个测试文件通过；6 个测试中 4 个通过，2 个真实依赖门控测试在默认环境下跳过。

```powershell
node .\node_modules\vitest\vitest.mjs run packages\core-tools\test
```

结果：12 个测试文件通过；59 个测试通过，2 个真实依赖门控测试跳过。

```powershell
node scripts\run-postgres-tests.mjs
```

结果：真实 PostgreSQL 16 上通过。执行情况：

- `packages/core-db/test/postgres.integration.test.ts`：3 个测试通过。
- `packages/core-auth/test/postgres.integration.test.ts`：2 个测试通过。
- `packages/core-tools/test/agent-rag-business-scenario.test.ts`：6 个测试中 5 个通过，1 个 SiliconFlow live case 在该命令下未启用而跳过。

```powershell
node scripts\run-agent-rag-live-tests.mjs
```

结果：真实 SiliconFlow `deepseek-ai/DeepSeek-V4-Pro` 上通过。测试验证模型真实调用 `search_schema` 和 `query_database`，不是只返回普通文本回答；耗时约 114 秒。

```powershell
node .\node_modules\typescript\bin\tsc -p packages\core-tools\test\tsconfig.json --noEmit
node .\node_modules\typescript\bin\tsc -p packages\core-tools\tsconfig.json --noEmit
```

结果：通过。

## 当前环境状态

当前机器已通过 winget 安装 PostgreSQL 16.14-2，`postgresql-x64-16` 服务运行中，`127.0.0.1:5432` 可达，真实 PostgreSQL 集成测试已执行通过。

本机 `.env` 写入了测试专用 SiliconFlow 环境变量，并已确认 `.env` 在 `.gitignore` 中。密钥不得提交到仓库，也不得写入文档、日志或测试快照。真实 SiliconFlow live case 已执行通过。

复跑方式：

```powershell
pnpm test:postgres

$env:TEST_SILICONFLOW_API_KEY='<本机临时密钥>'
$env:TEST_SILICONFLOW_MODEL='deepseek-ai/DeepSeek-V4-Pro'
pnpm test:agent-rag-live
```
