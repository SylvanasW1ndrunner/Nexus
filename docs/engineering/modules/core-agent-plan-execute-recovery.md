# core-agent Plan & Execute 持久化恢复

## 目标

Plan & Execute 面向复杂分析任务，执行时间和步骤数都可能明显高于普通 ReAct。为了避免应用退出、进程异常或服务中断后丢失计划进度，本模块为计划执行增加本地快照能力，并支持从已有计划继续执行。

## 代码入口

- `packages/core-agent/src/plan-execute-agent.ts`：在规划、步骤开始、步骤完成、失败、中止和完成时保存快照。
- `packages/core-agent/src/plan-execute-store.ts`：Plan & Execute 快照存储。
- `packages/core-agent/src/types.ts`：`AgentPlanExecutionSnapshot`、`AgentPlanExecutionSnapshotStatus`、`initialPlan` 等恢复合同。
- `packages/core-agent/test/plan-execute-agent.test.ts`：执行器持久化和恢复执行测试。
- `packages/core-agent/test/plan-execute-store.test.ts`：store 原子写入、恢复列表、弃用和脱敏测试。

## 快照合同

`AgentPlanExecutionSnapshot` 按 `planId` 保存最新状态：

- `status`：`running`、`done`、`failed`、`aborted`、`planning_failed`、`abandoned`。
- `plan`：完整计划和步骤状态。
- `session`：如果已有 ReAct session，则保存当前会话快照。
- `finalText`：当前可展示的最终或阶段性文本。
- `executedSteps`：已尝试执行的步骤数。
- `totalIterations`：跨步骤累计 ReAct iteration。
- `toolExecutions`：跨步骤累计工具执行记录。
- `contextCompression`：跨步骤累计上下文压缩报告。
- `errorMessage`：失败或弃用原因。

store 使用 JSON 文件和原子 rename 写入，读文件时会对历史明文内容重新执行脱敏，坏 JSON 会降级为空列表，避免启动恢复流程被单个损坏文件阻断。

## 恢复语义

调用方可以把快照中的 `plan`、`session`、`executedSteps`、`totalIterations` 传回 `PlanExecuteAgent.run()`：

- `initialPlan` 存在时跳过规划模型调用。
- `done` 和 `skipped` 步骤不会重复执行。
- `pending` 或上次中断时仍为 `running` 的步骤会重新进入执行。
- 每个恢复后的步骤仍复用 ReAct runner，因此原有权限、工具白名单、上下文预算、输出安全和 usage 行为保持一致。

当前没有新增单独的 Plan recovery service。原因是 `PlanExecuteAgent` 还没有接入桌面主进程服务入口；本轮先稳定 core 合同和 store，后续服务层可以直接基于 `AgentPlanExecutionStore.listRecoverable()` 构建启动恢复列表。

## 开源方案评估

本切片没有新增第三方依赖。

- LangGraph、Temporal、BullMQ 等方案可以提供工作流状态机或任务持久化，但会引入额外运行时、存储模型、调度语义和打包复杂度。
- 当前需求是本地 beta 阶段的计划快照与恢复，不需要分布式调度、队列 worker 或外部数据库。
- 继续采用 DBAgent 自有 JSON 原子写入模式，可以与现有 checkpoint/session store 保持一致，也避免把第三方 workflow 类型泄漏到 core-agent 公共合同。

后续如果需要 DAG、并行步骤、跨进程调度或长期任务队列，应在 `AgentPlanExecutionSnapshot` 之上做 adapter，而不是替换现有 ReAct/ToolRegistry/PermissionManager 合同。

## 测试覆盖

- 持久化并更新计划快照。
- 按 session 查询和列出 recoverable running 快照。
- abandon running 快照。
- 损坏 JSON 降级为空，启动不崩溃。
- 写入和读取时脱敏 API key、工具结果、finalText、errorMessage、plannerModelText 和 session 消息。
- PlanExecuteAgent 执行过程中保存最终快照。
- 从 `initialPlan` 恢复时不重新规划，不重复已完成步骤，并继续累计 iteration。

## 已知限制

- 当前 plan store 是 JSON 文件，适合 beta 阶段；高并发和大规模历史应迁移到 SQLite WAL。
- 当前恢复入口仍由调用方组装，尚未提供独立 `PlanExecuteRecoveryService`。
- 当前没有把 Plan 快照接入 desktop IPC 或 final UI。
- 当前不支持 DAG 并行或步骤级人工编辑确认。
