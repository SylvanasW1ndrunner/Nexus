# core-tools 策略化 Skill Agent Runner

## 模块定位

该模块位于 `packages/core-tools`，负责把官方 Skill、自动 Skill 匹配、官方插件工具策略和 core-agent 执行策略连接起来。

它不是业务编排中心，也不直接依赖 Electron、renderer UI、PostgreSQL driver 或 LLM provider。上层服务负责决定使用哪种策略；本模块负责把相同 Skill 执行合同安全地转发给对应 Agent。

## 代码入口

- `packages/core-tools/src/skill-agent-runner.ts`
  - `renderSkillAgentUserMessage()`：把 Skill 计划渲染成稳定任务输入。
  - `runSkillAgent()`：执行手动指定 Skill，支持 `react` 与 `plan-execute`。
- `packages/core-tools/src/auto-skill-agent-runner.ts`
  - `selectAutoSkillPlan()`：根据用户输入、Skill 元数据和当前可用工具选择 Skill。
  - `runAutoSkillAgent()`：自动选择 Skill 后继续按策略执行。

## 策略合同

`react`：
- 默认策略，兼容旧调用。
- 返回 `AgentRunResult`。
- 适合单轮或少量工具调用任务。

`plan-execute`：
- 显式传入 `strategy: "plan-execute"` 才启用。
- 返回 `AgentPlanExecuteResult`。
- 适合复杂分析、分步骤检查、需要 checkpoint/恢复的任务。
- 支持 `maxPlanSteps`、`stopOnStepFailure`、`initialPlan`、`initialExecutedSteps`、`initialTotalIterations`。

## 安全边界

- 两种策略都必须先经过 `resolveOfficialPluginAgentTools()`。
- Skill 的 `allowedTools` 只能收窄权限，不能扩大官方插件或 runtime tool 已允许的工具集合。
- runner 透传 `taskSafety` 和 `outputSafety`，不绕过 core-agent 的任务安全和输出安全策略。
- runner 不吞 provider、tool、quota 或权限错误，调用方可以拿到真实失败原因。

## 开源方案评估

本模块没有新增依赖。当前判断是 adapter 层不应引入完整 Agent 框架。

参考对象：
- LangGraph：适合状态图、checkpoint 和复杂控制流。
- CrewAI：适合 Python 角色化多 Agent。
- Microsoft AutoGen / Agent Framework：适合多 Agent 应用框架化开发。
- Vercel AI SDK：适合 TypeScript tool calling 和 MCP 工具接入。

决策：
- 当前复用 DBAgent 自己的 `core-agent` PlanExecuteAgent。
- 第三方框架可作为后续高级 orchestrator 的 adapter 候选，但不进入 core-tools 公共类型。
- 该决策降低桌面打包、离线安装、跨平台运行和许可证审查成本。

## 测试

- `packages/core-tools/test/skill-agent-runner.test.ts`
- `packages/core-tools/test/auto-skill-agent-runner.test.ts`

关键覆盖：
- ReAct 默认兼容。
- Plan & Execute 显式策略转发。
- 官方插件工具白名单在两种策略下都生效。
- 自动 Skill 匹配后可继续执行 Plan & Execute。
- Plan 参数和安全策略透传。

## 已知边界

- 策略自动选择尚未接入，本模块只接受上层显式策略。
- 真实 LLM + PostgreSQL 组合 eval 不在本切片内运行，后续应在 headless agent service 接线后补齐。
- 当前不支持并行子 Agent；后续应放在 orchestrator 层，而不是让 Skill runner 承担复杂编排。
