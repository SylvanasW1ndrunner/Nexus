# BetaV0.1.1 Agent/RAG 默认业务夹具接入 Suite Runner

## 范围

本版本继续统一 Agent/RAG 验收入口：

- 默认业务 fixture Agent/RAG 用例改为通过 `runAgentBehaviorEvaluationSuite()` 执行。
- 默认测试仍使用 scripted provider 和 fake PostgreSQL driver，不依赖真实网络或真实数据库。
- 验收继续要求 Agent 调用 `search_schema` 和 `query_database`，并校验最终回答、工具证据和实际 SQL 执行记录。
- 报告 store 写入临时目录，验证 runner 持久化摘要。

## 验证

本轮已执行并通过：

- `vitest run packages/core-tools/test/agent-rag-business-scenario.test.ts packages/core-tools/test/agent-eval-suite-runner.test.ts`

## 已知限制

- 真实 PostgreSQL fixture case 尚未迁移到 suite runner。
- 当前 suite 定义仍写在测试代码中，后续需要支持官方插件或工作区 manifest 加载。
