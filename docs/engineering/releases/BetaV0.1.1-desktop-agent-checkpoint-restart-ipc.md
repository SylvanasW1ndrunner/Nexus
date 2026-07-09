# BetaV0.1.1 desktop Agent ReAct checkpoint 重启恢复 IPC

## 变更

- 新增 `agent:restart-checkpoint` typed IPC。
- `AgentRecoveryService` 支持 ReAct checkpoint restart。
- `HeadlessAgentService` 支持从旧 checkpoint 摘要重启一个干净 ReAct session。
- 增加 core 和 desktop 持久化恢复测试。

## 验证

- `tsc -p packages/core-agent/tsconfig.json --noEmit`
- `tsc -p packages/shared/tsconfig.json --noEmit`
- `tsc -p packages/core-agent/tsconfig.json`
- `tsc -p packages/shared/tsconfig.json`
- `tsc -p apps/desktop/tsconfig.json --noEmit`
- `vitest run packages/core-agent/test/recovery.test.ts packages/core-agent/test/recovery-runner.test.ts apps/desktop/src/main/agent-service.test.ts --passWithNoTests`

## 风险

- 本切片不包含 renderer UI。
- 默认测试不调用真实 LLM provider，真实 provider restart 行为后续放在 gated live eval 中验证。
