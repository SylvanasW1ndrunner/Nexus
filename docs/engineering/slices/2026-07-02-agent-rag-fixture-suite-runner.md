# 2026-07-02 Agent/RAG 默认业务夹具接入 Suite Runner

## 背景

live Agent/RAG 验收已经迁移到 `runAgentBehaviorEvaluationSuite()`，但默认测试里的 scripted provider 业务夹具仍然是手动 `agent.run()` 后再手动调用 `evaluateAgentBehavior()`。这会让默认回归和 live 回归存在两套入口，后续扩展用例和官方 eval 插件时容易产生漂移。

## 本轮实现

- `packages/core-tools/test/agent-rag-business-scenario.test.ts`
  - 默认业务 Agent/RAG 用例改为通过 `runAgentBehaviorEvaluationSuite()` 执行。
  - 保留真实 `ReactAgent`、`ToolRegistry`、Schema RAG 和数据库工具注册路径。
  - 保留 scripted provider 和 fake PostgreSQL driver，默认测试不依赖网络和真实数据库。
  - 继续断言 `search_schema`、`query_database`、最终回答、工具证据和实际 SQL 执行记录。
  - 报告 store 写入临时目录，用于验证 runner 的持久化摘要。

## 边界

- 不触碰前端 UI。
- 不改变 live SiliconFlow 入口。
- 不新增依赖。
- 不把临时报告写入仓库。

## 验收

- `vitest run packages/core-tools/test/agent-rag-business-scenario.test.ts packages/core-tools/test/agent-eval-suite-runner.test.ts` 通过。

## 后续

- 将真实 PostgreSQL fixture case 也整理成 suite runner 入口，统一默认、PostgreSQL、live 三层验收结构。
- 支持从官方插件或工作区 manifest 加载 suite 定义。
