# core-agent Plan & Execute 策略模块

## 目标

Plan & Execute 用于把复杂数据工程任务拆成可执行步骤，再按步骤调用现有 ReAct Agent 执行。当前阶段不开发 UI，不引入多 Agent 调度，也不绕过已有工具权限；目标是先把后端策略边界、结果结构和失败恢复语义稳定下来。

## 代码入口

- `packages/core-agent/src/plan-execute-agent.ts`：Plan & Execute 编排器。
- `packages/core-agent/src/types.ts`：计划、步骤、执行结果和策略类型。
- `packages/core-agent/test/plan-execute-agent.test.ts`：确定性单元测试。

## 执行流程

1. `PlanExecuteAgent.run()` 先调用 `LlmRouter.chat()` 获取结构化计划。
2. 规划器只接受 JSON 对象或 fenced JSON，结构为 `title` + `steps[]`。
3. 每个步骤会被规范化为 `AgentPlanStep`，包含 `id`、`title`、`instruction`、`status`。
4. 执行阶段复用注入的 `ReactAgent.run()`，每一步都传入当前步骤说明、上一轮 session、累计 iteration。
5. 步骤成功后记录 `runStatus`、`iterations`、`toolExecutions` 和摘要。
6. 步骤失败时默认停止，后续步骤标记为 `skipped`，返回 `failed` 或 `aborted`。
7. 规划输出非法或无可执行步骤时返回 `planning_failed`，不会调用工具或执行步骤。

## 边界

- Plan & Execute 不直接执行工具，所有工具调用仍由 ReAct 主循环、`ToolRegistry`、`PermissionManager` 和工具 handler 负责。
- `allowedTools`、`mode`、`usageMode`、上下文预算、输出安全、任务安全、工具超时等选项会透传给每个 ReAct 步骤。
- 规划阶段目前只做一次模型调用，不启用外部 workflow 框架。
- 当前不实现人工确认计划 UI；后续 UI 可读取 `AgentPlan` 并在执行前插入确认步骤。

## 开源方案评估

本切片未新增第三方依赖。

- LangChain / LangGraph、LlamaIndex workflow、Semantic Kernel 等成熟项目具备 Plan & Execute、workflow graph、tool calling 和 checkpoint 能力，但会引入较重运行时、抽象层和打包依赖。
- 当前 DBAgent 已有自有 `ToolRegistry`、权限、usage、checkpoint、session、审计和 ReAct runner。直接引入外部 agent runtime 会导致工具权限和审计语义被拆散，短期风险高于收益。
- 本轮采用轻量自研编排层，隔离在 `plan-execute-agent.ts`，后续如果需要图执行、并行步骤、持久化 plan checkpoint 或可视化追踪，可以再以 adapter 方式接入成熟开源项目。

## 测试覆盖

- 业务任务规划后按顺序执行多个 ReAct 步骤，并复用同一个 session。
- 失败步骤会停止执行并跳过后续步骤。
- 非法规划输出不会触发执行器。
- 验证 `allowedTools`、`mode`、`providerId`、`model` 和累计 iteration 会传递到步骤 runner。

## 已知限制

- 当前计划只保存在返回结果中，尚未持久化到 checkpoint store。
- 当前步骤依赖只记录 `dependsOn`，不做 DAG 调度。
- 当前规划失败只返回通用失败状态，后续可以增加结构化错误原因，便于 UI 或 eval 报告展示。
- 当前未做真实 LLM live eval；本轮先稳定确定性策略骨架，后续 Agent/RAG live 测试会把 Plan & Execute 纳入真实业务库场景。
