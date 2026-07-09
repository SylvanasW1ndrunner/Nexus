# desktop Headless Agent 策略服务

## 模块定位

该模块位于 `apps/desktop/src/main/agent-service.ts`，负责把桌面主进程的无 UI Agent 入口与 `core-agent`、`core-tools`、`core-skills` 组合起来。

当前阶段不开发正式前端 UI。该服务通过 typed IPC 合同提供稳定能力，后续 UI、命令面板、自动化测试和 release gate 都应调用同一服务，而不是各自直接构造 Agent。

## 代码入口

- `HeadlessAgentService.previewToolPolicy()`：预览当前官方插件和 runtime tool 计算后的工具白名单。
- `HeadlessAgentService.matchSkills()`：在不调用模型的情况下匹配 Skill。
- `HeadlessAgentService.run()`：按策略运行自动匹配到的 Skill。
- `HeadlessAgentService.abort()`：通过 runId 取消运行中的任务。

桌面启动入口 `apps/desktop/src/main/main.ts` 现在同时构造：

- `ReactAgent`：默认轻量任务执行策略。
- `PlanExecuteAgent`：复杂分析任务执行策略，内部复用同一个 `ReactAgent` 作为 step runner。
- `AgentPlanExecutionStore`：计划快照落在 `data/agent-plan-executions.json`，用于后续恢复入口。

## 策略选择

IPC 请求支持：

- `strategy: "react"`：强制使用 ReAct。
- `strategy: "plan-execute"`：强制使用 Plan & Execute。
- `strategy: "auto"` 或省略：由服务层根据任务特征选择。

默认自动策略：

- 命中 `requires_multi_step_pipeline` 或 `requires_modeling` 信号时选择 Plan & Execute。
- 请求传入 `maxPlanSteps` 时选择 Plan & Execute。
- 用户任务包含明显复杂分析、根因、步骤、预测、建模、漏斗、归因等词时选择 Plan & Execute。
- 其他普通查询、日报和简单执行继续使用 ReAct。

该策略是轻量启发式，不调用额外模型，不增加成本。后续可替换为独立 strategy selector，但公共 IPC 合同不需要变化。

## 返回合同

`AgentRunResponse` 现在包含：

- `strategy`：实际使用的 `react` 或 `plan-execute`。
- `plan`：Plan & Execute 的可序列化计划摘要。
- `executedSteps` / `totalIterations`：计划执行进度。
- `iterations`：统一指标；ReAct 时为 ReAct 迭代数，Plan & Execute 时为总迭代数。

Plan 摘要只暴露 step id、title、status、resultSummary、failureReason、runStatus 和 iterations，不暴露完整 prompt、工具参数、密钥或底层对象。

## 安全边界

- 运行前仍通过 `runAutoSkillAgent()` 和 `resolveOfficialPluginAgentTools()` 计算工具白名单。
- Skill 只能收窄工具集合，不能扩大官方插件和 runtime tool 的权限。
- Plan & Execute 每个 step 仍由 `ReactAgent` 执行，因此继续复用 permission manager、tool allowlist、任务安全、输出安全和审计日志。
- abort 仍然只通过 runId 触发 AbortController，不暴露 provider、进程或底层对象。

## 开源方案评估

本切片不新增依赖。当前能力是服务层策略分发和状态归一化，直接复用已经实现的 `PlanExecuteAgent` 成本最低。

参考方案：

- LangGraph：适合状态图和复杂持久化工作流，可作为后续 orchestrator adapter 候选。
- Vercel AI SDK：适合 tool calling 和 MCP 工具接入，可继续作为 LLM/tool adapter 参考。
- CrewAI / AutoGen：更偏完整多 Agent 框架，不适合当前桌面主进程服务边界直接引入。

决策：当前保持自有轻量策略服务，不把第三方框架类型引入 shared IPC 或桌面主进程公共合同。

## 测试

主要测试文件：

- `apps/desktop/src/main/agent-service.test.ts`
- `apps/desktop/src/main/agent-tool-bootstrap.test.ts`

关键覆盖：

- 普通 GMV 日报仍走 ReAct。
- 显式 `strategy: "plan-execute"` 返回计划摘要、执行步数和总迭代数。
- `strategy: "auto"` 对复杂根因分析任务升级为 Plan & Execute。
- 无匹配 Skill 时不调用模型。
- 隐藏工具调用仍被拒绝。
- abort 能取消运行中请求。
- 桌面端真实审计日志仍记录 Agent run/model/tool/final 事件。

## 已知限制

- 自动策略仍是启发式，不做额外 LLM router 判断。
- Plan 恢复 IPC 尚未暴露；当前只落地 `AgentPlanExecutionStore` 供后续恢复服务使用。
- 本切片未运行真实 SiliconFlow live test；真实 LLM + PostgreSQL 的 Plan & Execute eval 应作为下一轮业务验收补齐。
