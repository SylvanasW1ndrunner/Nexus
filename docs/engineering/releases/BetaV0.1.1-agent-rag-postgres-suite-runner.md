# BetaV0.1.1 Agent/RAG 真实 PostgreSQL 验收接入 Suite Runner

## 范围

本版本继续统一 Agent/RAG 验收入口：

- 真实 PostgreSQL business fixture workflow 改为通过 `runAgentBehaviorEvaluationSuite()` 执行。
- 测试仍会真实创建业务表、写入样例数据、抽取 PostgreSQL catalog、索引 RAG，并通过 Agent 调用数据库工具。
- 报告 metadata 标记 `postgres: true`，并验证临时 report store 摘要。

## 验证

本轮已执行并通过：

- `vitest run packages/core-tools/test/agent-rag-business-scenario.test.ts packages/core-tools/test/agent-eval-suite-runner.test.ts`
- `pnpm test:postgres`

## 已知限制

- 当前真实 PostgreSQL suite 仍只有一个 Agent workflow；后续需要扩展更多业务失败和恢复场景。
- suite 定义仍写在测试代码中，后续需要支持官方插件或工作区 manifest 加载。
