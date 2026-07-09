# 2026-07-09 Agent Plan & Execute 重启恢复

## 范围

本切片补齐 Plan & Execute 恢复闭环中的 `restart` 动作，不开发 renderer UI。

改动包括：

- `core-agent` 增加 `AgentPlanRecoveryService.restart()`。
- shared typed IPC 增加 `agent:restart-plan`、`AgentRestartPlanRequest`、`AgentRestartPlanResponse`。
- desktop `HeadlessAgentService` 增加 `restartPlan()` 并注册主进程 IPC handler。
- 服务测试覆盖 core 和 desktop 两层 restart 行为。

## 行为语义

restart 与 continue 不同：

- continue 从旧 plan/session/步骤数继续。
- restart 从旧任务目标和旧执行摘要重新规划，不复用旧 session 或旧步骤进度。
- restart 成功才放弃旧快照。
- restart 失败、中止或规划失败时保留旧快照，避免恢复点丢失。

## 验收结果

- core-agent 恢复测试：11 passed。
- desktop Agent 服务测试：13 passed。
- 类型检查和 ESLint 已在模块门禁中通过。

## 后续

- 把 `restart` 接入最终 Agent 恢复 UI。
- 在 live Agent/RAG eval 中增加真实 provider 的 restart 恢复案例。
