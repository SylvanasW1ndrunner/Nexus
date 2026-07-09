# BetaV0.1.1 desktop Agent ReAct checkpoint 恢复 IPC

## 变更

- 新增 ReAct checkpoint 恢复 typed IPC：
  - `agent:recoverable-checkpoints`
  - `agent:continue-checkpoint`
  - `agent:restart-checkpoint`
  - `agent:abandon-checkpoint`
- `HeadlessAgentService` 支持列出、继续、重启、放弃 ReAct checkpoint。
- desktop 主进程复用同一份 `AgentCheckpointStore` 注入恢复服务。
- 增加服务级持久化恢复测试。

## 验证

- `tsc -p packages/shared/tsconfig.json --noEmit`
- `tsc -p packages/shared/tsconfig.json`
- `tsc -p apps/desktop/tsconfig.json --noEmit`
- `vitest run apps/desktop/src/main/agent-service.test.ts packages/core-agent/test/recovery.test.ts packages/core-agent/test/recovery-runner.test.ts --passWithNoTests`
- `eslint packages/shared/src/ipc.ts apps/desktop/src/main/agent-service.ts apps/desktop/src/main/main.ts apps/desktop/src/main/agent-service.test.ts`

## 风险

- 本切片不包含 renderer UI。
- 默认测试不调用真实 LLM provider，真实 provider 恢复行为后续放在 gated live eval 中验证。
