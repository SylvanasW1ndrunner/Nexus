# core-agent Plan & Execute 恢复服务

## 目标

`AgentPlanRecoveryService` 是 Plan & Execute 快照之上的恢复编排层。它不执行工具、不接 UI、不绑定 Electron，只负责把 `AgentPlanExecutionStore` 中的 running 快照转换成可恢复计划，并在用户选择继续或放弃时调用上层 runner。

为保持命名稳定，模块同时导出 `PlanExecuteRecoveryService` 作为别名；后续主进程或服务层可以优先使用该别名。

## 代码入口

- `packages/core-agent/src/plan-execute-recovery.ts`
  - `AgentPlanRecoveryService`
  - `PlanExecuteRecoveryService`
  - `AgentPlanRecoveryPlan`
  - `ContinueAgentPlanRecoveryOptions`
- `packages/core-agent/src/plan-execute-store.ts`
  - `AgentPlanExecutionStore`
- `packages/core-agent/test/plan-execute-recovery.test.ts`

## 服务合同

### `listRecoverablePlans()`

读取所有 `running` plan 快照，按 `updatedAt` 倒序输出恢复摘要：

- `planId`、`sessionId`
- 任务标题和目标
- 中断步骤 ID / 标题
- done / failed / skipped / pending 步骤计数
- 已执行步骤数和累计 ReAct iteration
- 最近阶段结果和最近失败工具摘要
- `resumePrompt`
- 可选动作：`continue`、`restart`、`abandon`

其中 `restart` 只是给上层 UI/主进程的动作提示，不代表本服务已经实现 restart 编排。restart 后续应由上层重新发起一次新的 Plan & Execute run。

### `continue(planId, runner, options)`

从 recoverable 快照恢复执行：

- 从快照注入 `initialPlan`
- 从快照注入 `initialSession`
- 从快照注入 `initialExecutedSteps`
- 从快照注入 `initialTotalIterations`
- 如果调用方未指定 `mode`，则继承快照 session 的 mode
- 如果调用方未指定 `userMessage`，则使用服务生成的 `resumePrompt`

当 runner 返回 `done` 时，服务把同一个 plan 快照更新为完成态，`listRecoverablePlans()` 不再返回它。

当 runner 返回 `failed`、`aborted`、`planning_failed` 等非完成状态时，服务刷新原 running 快照的更新时间，但不覆盖原计划进度，确保启动后仍可恢复。

当 runner 抛异常时，服务同样刷新原 running 快照并原样抛出错误，不把异常误写成完成态。

### `abandon(planId, reason, now)`

把 running 快照标记为 `abandoned`，写入原因和完成时间。非 running 或不存在的 plan 返回 `false`。

## 安全边界

- 本服务只处理已脱敏的 store 读写结果。
- `resumePrompt`、`lastResultText`、`lastToolError` 都来自 store 返回值，测试覆盖 API key 不泄露。
- 工具权限、SQL 写入审批、输出安全、上下文预算仍由 `PlanExecuteAgent` 和 ReAct runner 负责。

## 开源方案评估

本切片不新增第三方依赖。

- Temporal、BullMQ、LangGraph checkpoint 等方案适合更复杂的分布式工作流或图执行，但会引入额外运行时、队列/数据库依赖和打包成本。
- 当前 beta 阶段需要的是本地快照恢复服务，沿用 core-agent 自有 store/runner 抽象更轻，并能保证不把外部工作流类型泄漏到稳定合同。

## 测试覆盖

- recoverable 计划摘要倒序输出。
- 继续执行时注入 plan/session/步骤数/iteration/mode/resumePrompt。
- runner 返回 `done` 后清理 recoverable。
- runner 返回 `failed`、`aborted`、`planning_failed` 时保留原 running 快照。
- runner 抛异常时保留原 running 快照。
- abandon running 快照。
- resume prompt 和摘要不泄漏 secret。

## 已知限制

- `restart` 只是动作枚举，尚未有 core 层实现。
- 当前不会保留续跑失败结果的独立历史，只刷新原 running 快照；详细失败证据由 runner 自身 checkpoint/audit 负责。
- 当前未接入 desktop IPC 和最终 UI。
