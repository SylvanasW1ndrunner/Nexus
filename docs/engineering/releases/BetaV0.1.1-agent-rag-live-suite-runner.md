# BetaV0.1.1 Agent/RAG live 验收接入 Suite Runner

## 范围

本版本把 SiliconFlow live Agent/RAG 验收迁移到 `runAgentBehaviorEvaluationSuite()`：

- 真实模型仍为 `deepseek-ai/DeepSeek-V4-Pro`。
- 验收仍要求模型调用 `search_schema` 和 `query_database`。
- live SQL 参数断言支持局部大小写不敏感匹配，避免真实模型输出 `SELECT` 时误失败。
- 报告继续输出到 `tmp/agent-rag-live-report`。

## 验证

本轮已执行并通过：

- `vitest run packages/core-tools/test/agent-rag-business-scenario.test.ts packages/core-tools/test/agent-eval-suite-runner.test.ts`
- `scripts/run-agent-rag-live-tests.mjs`
- `pnpm --filter @dbagent/core-agent lint`
- `pnpm --filter @dbagent/core-agent typecheck`
- `pnpm --filter @dbagent/core-agent test`
- `pnpm --filter @dbagent/core-tools lint`
- `pnpm --filter @dbagent/core-tools typecheck`
- `pnpm --filter @dbagent/core-tools test`

## 已知限制

- live case 当前只有一个业务用例，后续应扩展到退款、漏斗、权限审计和复杂 SQL 修复场景。
