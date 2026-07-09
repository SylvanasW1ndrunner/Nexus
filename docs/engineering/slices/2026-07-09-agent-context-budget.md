# 2026-07-09 Agent 上下文预算治理切片

## 范围

本切片继续只开发后端 core 能力，不开发前端 UI，不开发多数据库。

完成内容：

- 扩展 `buildAgentContext()` 的压缩报告。
- 新增上下文预算阶段：`healthy`、`warning`、`soft_compressed`、`hard_compressed`、`over_budget`。
- 新增压缩步骤记录：压缩类型、压缩前后 token 估算、影响消息数。
- `ReactAgent.run()` 返回 `contextCompression`，记录每轮上下文构建结果。
- 新增 `context_compression_applied` 审计事件。
- 使用恢复长会话测试验证模型上下文会收到摘要而不是完整大工具结果。

## 验收结果

已通过：

- `tsc -p packages/core-agent/tsconfig.json --noEmit`
- `eslint packages/core-agent`
- `vitest run packages/core-agent/test/context-manager.test.ts packages/core-agent/test/react-agent.test.ts packages/core-agent/test/audit-log-store.test.ts --passWithNoTests`
- `vitest run packages/core-agent/test --passWithNoTests`
- `tsc -p packages/core-tools/tsconfig.json --noEmit`
- `vitest run packages/core-tools/test/agent-eval-suite-runner.test.ts packages/core-tools/test/agent-rag-business-scenario.test.ts --passWithNoTests`

说明：

- 已重建 `packages/core-agent/dist`，避免下游 workspace 包通过包名导入旧运行时。
- 本切片没有新增第三方依赖。
- 未跑真实 PostgreSQL 全量脚本；本切片没有修改数据库连接、SQL 执行或 PG fixture 行为，下游核心业务 Agent/RAG 用例已通过。

## 风险

- token 估算仍是本地启发式。
- `over_budget` 当前仅报告风险，不主动停止运行。
- 后续需要接入 provider-specific tokenizer 和可选 LLM 摘要器。
