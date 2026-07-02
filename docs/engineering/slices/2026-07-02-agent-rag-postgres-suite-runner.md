# 2026-07-02 Agent/RAG 真实 PostgreSQL 验收接入 Suite Runner

## 背景

默认 fixture 和 SiliconFlow live Agent/RAG 验收已经统一到 `runAgentBehaviorEvaluationSuite()`，但真实 PostgreSQL workflow 仍然直接调用 `agent.run()`。该 workflow 是用户级信心最强的一层：真实建表、真实 catalog 抽取、真实 RAG 索引、真实数据库查询工具链。它也应使用同一套 suite runner，以便后续官方 eval 插件和发布门禁复用。

## 本轮实现

- `packages/core-tools/test/agent-rag-business-scenario.test.ts`
  - 真实 PostgreSQL business fixture workflow 改为通过 `runAgentBehaviorEvaluationSuite()` 执行。
  - 保留真实 PostgreSQL 建表、样例数据、catalog 抽取、RAG 索引和数据库工具执行。
  - suite environment 设置为 `postgres`，报告 metadata 标记 `postgres: true`。
  - 继续验证 `search_schema`、`query_database`、工具结果、最终回答和临时 report store 摘要。

## 边界

- 不触碰前端 UI。
- 不改变 `scripts/run-postgres-tests.mjs` 的数据库准备方式。
- 不新增依赖。
- 不改变真实 SiliconFlow live 入口。

## 验收

本轮已执行并通过：

- `vitest run packages/core-tools/test/agent-rag-business-scenario.test.ts packages/core-tools/test/agent-eval-suite-runner.test.ts`
- `pnpm test:postgres`

## 后续

- 将更多真实 PostgreSQL 业务 case 加入 suite：退款异常、漏斗分析、权限审计、复杂 SQL 修复和失败恢复。
- 支持从官方插件或工作区 manifest 加载 suite 定义，减少测试代码内嵌。
