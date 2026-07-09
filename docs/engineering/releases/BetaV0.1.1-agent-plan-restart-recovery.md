# BetaV0.1.1 Agent Plan & Execute 重启恢复

## 本次能力

- `core-agent` 支持从 recoverable Plan & Execute 快照重新开始执行。
- desktop typed IPC 暴露 `agent:restart-plan`。
- restart 成功时保存新 plan 完成结果，并把旧中断快照标记为 abandoned。
- restart 失败时保留旧中断快照，用户仍可继续或再次重启。

## 验证

- `vitest run packages/core-agent/test/plan-execute-recovery.test.ts --passWithNoTests`
- `vitest run apps/desktop/src/main/agent-service.test.ts --passWithNoTests`
- `tsc` 和 `eslint` 针对相关包与文件通过。

## 风险

- 当前默认测试仍使用 fake provider；真实模型行为需要在 live eval 中补充。
