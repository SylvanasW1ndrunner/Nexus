# Agent/RAG PostgreSQL Gate 统一 Run Service 切片

## 背景

SiliconFlow live gate 已迁移到 `AgentEvalSuiteRunService`，但真实 PostgreSQL gate 仍在测试中手工拼接 suite 和 runner。这样会让真实依赖门禁、suite source、catalog 加载路径分散。

本切片把真实 PostgreSQL Agent/RAG gate 迁移到统一 run service，保证真实数据库验收也走 catalog -> run service -> runner 的路径。

## 实现范围

- `packages/core-tools/test/agent-rag-business-scenario.test.ts`
  - PostgreSQL gate 在真实临时工作区写入 `.dbagent/evals/postgres-business.json`。
  - 通过 `AgentEvalSuiteRunService.run()` 选择并执行 `agent-rag-business-postgres`。
  - 显式传入 `allowPostgresSuites: true`。
  - 断言报告写入 workspace suite source。

## 设计边界

- PostgreSQL fixture 创建、schema 抽取、RAG 索引和 Agent 工具链保持不变。
- suite 定义从内联对象迁移为工作区 manifest，模拟用户/团队自定义 eval suite。
- run service 只做 suite 选择、真实依赖门禁和 runner 编排。
- 不修改前端 UI、Electron IPC 或 preload。

## 测试

- 默认 `pnpm test` 不执行真实 PostgreSQL gate。
- `pnpm test:postgres` 设置 `DBAGENT_RUN_POSTGRES_TESTS=1` 后执行真实 PostgreSQL gate。
- PostgreSQL gate 覆盖：
  - 创建生产类电商/流量分析业务表。
  - 从真实 PostgreSQL 抽取 schema catalog。
  - 构建 Schema RAG。
  - 通过 Agent 调用 `search_schema` 和 `query_database`。
  - 通过 run service 记录 workspace suite source 和 `run.postgres=true`。

## 后续

- 后续可把 release CLI 或主进程质量门禁直接接到 `AgentEvalSuiteRunService`。
- 工作区自定义 eval suite 可复用该路径，避免为官方/工作区/真实依赖分别维护执行逻辑。
