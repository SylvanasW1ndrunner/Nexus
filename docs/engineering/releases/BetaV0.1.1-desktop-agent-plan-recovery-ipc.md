# BetaV0.1.1 desktop Agent Plan & Execute 恢复 IPC

## 本次能力

- 新增 desktop Agent 可恢复计划 IPC：
  - `agent:recoverable-plans`
  - `agent:continue-plan`
  - `agent:restart-plan`
  - `agent:abandon-plan`
- desktop 主进程现在可以列出、继续、重启、放弃 Plan & Execute running 快照。
- 恢复继续和重启时都会按当前工具权限策略重新执行，避免历史状态绕过当前 readonly/插件权限。
- restart 成功时保存新 plan 结果并把旧快照标记为 abandoned；restart 失败时保留旧恢复点。

## 验证

- `tsc -p packages/core-agent/tsconfig.json --noEmit`
- `tsc -p packages/shared/tsconfig.json --noEmit`
- `tsc -p apps/desktop/tsconfig.json --noEmit`
- `vitest run packages/core-agent/test/plan-execute-recovery.test.ts --passWithNoTests`
- `vitest run apps/desktop/src/main/agent-service.test.ts --passWithNoTests`
- `eslint packages/core-agent/src/plan-execute-recovery.ts packages/core-agent/test/plan-execute-recovery.test.ts apps/desktop/src/main/agent-service.ts apps/desktop/src/main/agent-service.test.ts apps/desktop/src/main/main.ts packages/shared/src/ipc.ts`

## 限制

- 本版本不开发正式前端 UI，只提供 core、主进程和 typed IPC 能力。
- 真实 LLM 的 restart 恢复 eval 仍需要通过 gated live test runner 补充。
