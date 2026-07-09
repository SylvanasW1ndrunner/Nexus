# BetaV0.1.1 desktop Agent Plan & Execute 恢复 IPC

## 本次能力

- 新增 desktop Agent 可恢复计划 IPC：
  - `agent:recoverable-plans`
  - `agent:continue-plan`
  - `agent:abandon-plan`
- desktop 主进程现在可以列出、继续、放弃 Plan & Execute running 快照。
- 恢复继续时会按当前工具权限策略重新执行，避免历史状态绕过当前 readonly/插件权限。

## 验证

- `tsc -p packages/shared/tsconfig.json --noEmit`
- `tsc -p apps/desktop/tsconfig.json --noEmit`
- `vitest run apps/desktop/src/main/agent-service.test.ts --passWithNoTests`
- `eslint apps/desktop/src/main/agent-service.ts apps/desktop/src/main/agent-service.test.ts apps/desktop/src/main/main.ts packages/shared/src/ipc.ts`

## 限制

- 本版本不开发正式前端 UI，只提供主进程和 typed IPC 能力。
- `restart` 仍是恢复摘要中的预留动作，尚未作为 desktop IPC 实现。
