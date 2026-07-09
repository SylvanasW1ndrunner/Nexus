# desktop Agent Plan & Execute 恢复 IPC

## 目标

本模块把 `core-agent` 的 Plan & Execute 持久化恢复能力接入 desktop 主进程，给后续统一前端提供稳定的 typed IPC 合同。用户在长任务中断、应用重启或模型调用失败后，可以查看可恢复计划、继续执行、重新规划执行或放弃过期计划。

## 接口边界

- `packages/core-agent` 负责 checkpoint 存储、恢复摘要、继续、重启和放弃逻辑。
- `apps/desktop/src/main/agent-service.ts` 负责桌面服务编排：生成 runId、绑定 AbortController、解析当前工具权限策略、把 core 结果转换为 shared IPC 类型。
- `packages/shared/src/ipc.ts` 暴露序列化合同，不引入 Electron 或 core-agent 类型。
- `apps/desktop/src/main/main.ts` 复用同一个 `AgentPlanExecutionStore` 同时驱动 `PlanExecuteAgent` 和 `PlanExecuteRecoveryService`，避免恢复服务读取另一份状态。

## IPC 合同

- `agent:recoverable-plans`
  - 请求：`void`
  - 响应：`AgentRecoverablePlansResponse`
  - 用途：列出当前可恢复的 Plan & Execute 快照。
- `agent:continue-plan`
  - 请求：`AgentContinuePlanRequest`
  - 响应：`AgentContinuePlanResponse`
  - 用途：从旧 plan/session/进度继续指定 plan。
- `agent:restart-plan`
  - 请求：`AgentRestartPlanRequest`
  - 响应：`AgentRestartPlanResponse`
  - 用途：基于旧任务目标重新规划并执行一个新 plan。
- `agent:abandon-plan`
  - 请求：`AgentAbandonPlanRequest`
  - 响应：`AgentAbandonPlanResponse`
  - 用途：把可恢复计划标记为 abandoned，后续列表不再显示。

## continue 与 restart 的差异

- `continuePlan` 会注入旧 `initialPlan`、`initialSession`、`initialExecutedSteps` 和 `initialTotalIterations`，适合从中断点继续。
- `restartPlan` 不注入旧 session 或旧执行进度，而是用旧目标和旧执行摘要生成重启 prompt，让 planner 重新生成新计划。
- `restartPlan` 只有在新计划成功完成时才把旧 recoverable 快照标记为 abandoned；如果重启失败、中止或规划失败，旧快照仍保持可恢复。

## 权限策略

恢复执行不信任旧 UI 状态，也不默认继承旧 Skill 的工具交集。`continuePlan` 和 `restartPlan` 都会按当前请求的 `mode`、启停插件、权限上限和 readonly 设置重新计算工具 allowlist，再传入 `PlanExecuteAgent`。

这样可以保证：

- 用户恢复前切换到 readonly 后，恢复运行不会得到写工具。
- 旧 checkpoint 只代表历史执行状态，不代表当前授权。
- 模型即使尝试调用当前未暴露的写工具，也会在运行时被拒绝。

## 生命周期

1. Plan & Execute 运行时通过 `AgentPlanExecutionStore` 写入 running 快照。
2. 应用重启或任务失败后，`agent:recoverable-plans` 返回 running 快照摘要。
3. 用户选择继续时，`agent:continue-plan` 从原始 plan/session/已执行步数恢复执行。
4. 用户选择重启时，`agent:restart-plan` 从原始目标重新规划新 plan。
5. continue 成功时，旧 plan 被最终 done 快照替代，恢复列表清空。
6. restart 成功时，新 plan 被保存为 done，旧 plan 被标记 abandoned，恢复列表清空。
7. continue/restart 失败、中止或被拒绝时，旧 running 快照保持可恢复。
8. 用户选择放弃时，`agent:abandon-plan` 标记 abandoned。

## 测试覆盖

- 列出真实文件系统中的 recoverable plan，并返回 interrupted step、计数、resume prompt 和 actions。
- 继续执行 running 快照，验证不重新规划、接续剩余步骤、成功后清理 recoverable。
- 继续执行时模型调用未暴露写工具，验证工具被拒绝，原始快照仍可恢复。
- 重启 running 快照，验证重新规划新 plan、新 plan 完成、旧快照 abandoned。
- 放弃快照后列表为空，持久化状态为 abandoned。

## 开源与依赖评估

本切片没有新增第三方依赖。恢复能力由 `core-agent` 的 checkpoint/store 服务提供，本次只做 IPC 和 desktop 编排。引入 LangGraph、Temporal 或 BullMQ 会增加状态模型迁移、额外运行时、Electron 打包和类型适配成本，当前收益不足。后续如果引入外部 agent runtime，应放在 adapter 后面，不污染 shared IPC 合同。

## 已知限制

- 恢复入口目前不重新运行 Skill 匹配，因此恢复时使用当前 Agent 工具权限集合，而不是旧 Skill 的工具交集。
- 默认测试使用 fake provider；真实 LLM 恢复 eval 仍应接入现有 gated live test runner。
