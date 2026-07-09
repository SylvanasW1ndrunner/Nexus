# 2026-07-09 core-tools 策略化 Skill Agent Runner 切片

## 范围

本切片只开发后端 core 能力，不开发 renderer UI，不引入多数据库适配。

完成内容：
- `runSkillAgent()` 支持显式 `strategy: "plan-execute"`，可把 Skill 渲染后的任务、工具白名单、权限策略和运行参数传给 `PlanExecuteAgent`。
- `runAutoSkillAgent()` 支持自动匹配 Skill 后继续选择 `react` 或 `plan-execute` 策略。
- 默认不传 `strategy` 时仍走 ReAct，保持旧调用兼容。
- Plan & Execute 路径继续复用官方插件工具策略，Skill 不能扩大工具权限，只能在官方插件和 runtime tool 允许范围内收窄。
- 透传 `maxPlanSteps`、`stopOnStepFailure`、`initialPlan`、`initialExecutedSteps`、`initialTotalIterations`，为后续恢复、checkpoint 和 UI 计划面板接线预留。
- 补充 `taskSafety`、`outputSafety` 透传，避免 Skill runner 绕过 core-agent 的任务安全和输出安全策略。

## 开源评估

本轮目标是 adapter 层接线，不是重建完整 Agent 编排框架，因此不新增依赖。

已复核的成熟方案：
- LangGraph：低层状态化 Agent 编排框架，适合长期状态图、checkpoint 和复杂控制流。来源：https://github.com/langchain-ai/langgraph
- CrewAI：Python 多 Agent/Flow 框架，适合角色化多 Agent 自动化。来源：https://github.com/crewAIInc/crewAI
- Microsoft AutoGen / Agent Framework：多 Agent 应用框架，AutoGen 当前 GitHub 页面标注维护模式，后续方向转向 Microsoft Agent Framework。来源：https://github.com/microsoft/autogen 与 https://github.com/microsoft/agent-framework
- Vercel AI SDK：TypeScript tool calling、多步调用和 MCP 工具接入能力成熟。来源：https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling

决策：
- 当前不引入 LangGraph/CrewAI/AutoGen，原因是它们会带来额外运行时、语言栈或框架抽象，和当前 Electron 桌面包的离线安装、Windows/Linux 打包、core 包无 Electron 依赖边界不匹配。
- 当前继续复用已经落地的 `core-agent` PlanExecuteAgent，并在 `core-tools` 提供轻量 adapter。后续如果需要 DAG、并行子 Agent 或更强持久化工作流，再单独做 adapter 层调研，不把第三方框架类型暴露成 DBAgent 公共接口。

## 接口语义

`runSkillAgent(agent, options)`：
- `strategy` 省略或为 `react`：调用 ReAct 风格 agent，返回 `{ strategy: "react", result, toolPolicy, renderedUserMessage }`。
- `strategy` 为 `plan-execute`：调用 Plan & Execute 风格 agent，返回 `{ strategy: "plan-execute", result, toolPolicy, renderedUserMessage }`。
- 两条路径都先调用 `resolveOfficialPluginAgentTools()`，再把最终 `agentAllowedToolNames` 传给下游 Agent。

`runAutoSkillAgent(agent, options)`：
- 先按当前 runtime tools 和 Skill 元数据选中 `SkillAutoExecutionPlan`。
- 再按 `strategy` 分发到 `runSkillAgent()`。
- 返回结果保留 `autoPlan`、`candidates` 和 `preflightToolPolicy`，方便后续无 UI 服务和 release gate 输出诊断。

## 测试覆盖

新增覆盖：
- Skill runner 默认 ReAct 行为保持兼容。
- Skill runner 在 `plan-execute` 下仍执行官方插件工具白名单过滤。
- Auto Skill runner 自动匹配 Skill 后可以走 Plan & Execute。
- Plan 参数、初始恢复计数、安全策略和工具策略向下传递。

已运行：
- `tsc -p packages/core-tools/tsconfig.json --noEmit`
- `eslint packages/core-tools/src/skill-agent-runner.ts packages/core-tools/src/auto-skill-agent-runner.ts packages/core-tools/test/skill-agent-runner.test.ts packages/core-tools/test/auto-skill-agent-runner.test.ts`
- `vitest run packages/core-tools/test/skill-agent-runner.test.ts packages/core-tools/test/auto-skill-agent-runner.test.ts --passWithNoTests`
- `vitest run packages/core-tools/test --passWithNoTests`
- `tsc -p packages/core-agent/tsconfig.json --noEmit`
- `vitest run packages/core-agent/test/plan-execute-agent.test.ts packages/core-agent/test/plan-execute-recovery.test.ts --passWithNoTests`

补充说明：
- `tsc -p packages/core-tools/test/tsconfig.json --noEmit` 仍存在 3 个既有测试类型债：业务场景测试的 `reportStorePath` 可选值、旧错误码字面量、`official-plugin-tool-policy.test.ts` 的 helper source 类型。它们不由本切片引入，运行测试已通过。
- 本切片没有新增第三方依赖，没有改变 Electron、renderer、PostgreSQL、Python、终端或打包配置。

## 后续工作

- 把策略选择接到 headless agent service，让服务层可按任务复杂度或用户设置选择 ReAct / Plan & Execute。
- 增加 Plan & Execute 的 Agent/RAG live eval 场景，使用真实 PostgreSQL 和 SiliconFlow 门控测试。
- 后续做子 Agent 并行时，应优先在当前策略 runner 外层增加 orchestrator，不把 Skill runner 改成业务编排中心。
