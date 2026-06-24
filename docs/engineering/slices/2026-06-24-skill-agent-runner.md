# 2026-06-24 Skill Agent Runner 切片

## 目标

补齐无 UI 的 Skill Agent 执行入口。此前 `core-skills` 可以生成 Skill execution plan，`core-agent` 可以执行 `allowedTools`，`core-tools` 可以根据官方插件策略生成工具白名单；本切片把三者串成一个可测试 adapter，供后续主进程 Agent runner / Skill runner 调用。

## 实现范围

- `packages/core-tools/src/skill-agent-runner.ts`
  - 新增 `SkillAgentPlan`：结构兼容 `core-skills` 的 `SkillExecutionPlan`，但不让 `core-tools` 反向依赖 `core-skills`。
  - 新增 `renderSkillAgentUserMessage()`：把 Skill 名称、说明、系统补充、步骤、输出格式和用户任务渲染为稳定中文任务输入。
  - 新增 `runSkillAgent()`：
    - 调用 `resolveOfficialPluginAgentTools()` 计算最终 `agentAllowedToolNames`。
    - 把渲染后的任务输入和最终工具白名单传给 `agent.run()`。
    - 返回 Agent 结果、工具策略诊断和实际渲染的用户消息。
- `packages/core-tools/src/index.ts`
  - 导出 Skill Agent runner。

## 设计边界

- `core-agent` 不依赖 `core-skills` 或 `core-tools`，避免核心 Agent runtime 被插件/Skill 体系反向污染。
- `core-tools` 不直接依赖 `core-skills` 包。`SkillAgentPlan` 采用结构兼容类型，上层可以直接传入 `SkillRegistry.createExecutionPlan()` 的结果。
- Skill 不能放权，只能收窄工具集合。最终工具列表仍由官方插件策略、runtime tools、readonly / danger filter 和 Skill allowed tools 交集决定。
- `runSkillAgent()` 不捕获 Agent provider / tool / quota 错误，不隐藏失败原因；调用方仍能看到原始失败并结合 `toolPolicy` 做诊断。

## 开源与依赖评估

本切片没有引入外部依赖，也没有引入新的 Agent workflow 框架。原因：

- 当前目标是把已有 `ReactAgent`、`ToolRegistry`、Skill plan 和官方插件策略接线，属于产品内部 contract adapter。
- LangChain / LlamaIndex / Vercel AI SDK 等框架的价值主要在复杂 workflow、provider adapter 和 tracing；本切片不需要这些能力。
- 直接引入框架会增加打包体积、跨平台发布和工具权限边界复杂度，不符合当前“小而完整”的后端切片目标。

后续如果实现 Plan-Execute、子 Agent 或 tracing/eval，可以重新评估成熟开源组件，并通过 adapter 隔离到 DBAgent 公共合同外。

## 测试

- `skill-agent-runner.test.ts`
  - 使用真实 `ToolRegistry` 和官方插件策略计算 Skill Agent 的最终 allowed tools。
  - 验证 MCP 插件禁用、只读模式、动态 workspace script 来源和缺失工具会正确阻断。
  - 验证无进一步限制时，插件允许的 runtime tools 会传给 Agent。
  - 验证 Skill 任务消息渲染稳定。
  - 验证 Agent provider 失败不会被 runner 吞掉。

## 验证记录

- `pnpm exec tsc -p packages/core-tools/tsconfig.json --noEmit`
- `pnpm exec eslint packages/core-tools/src/skill-agent-runner.ts packages/core-tools/test/skill-agent-runner.test.ts`
- `pnpm exec vitest run packages/core-tools/test/skill-agent-runner.test.ts packages/core-tools/test/official-plugin-tool-policy.test.ts packages/core-tools/test/official-plugin-registry.test.ts`
  - 3 个测试文件通过。
  - 15 个用例通过。

## 后续

- 主进程 Agent service 接入 `runSkillAgent()`，把 workspace 启用插件、当前 Skill、当前 Agent mode 和真实 `ToolRegistry` 传入策略。
- 将 `blockedByPluginToolNames` / `blockedBySkillToolNames` 作为后端诊断事件输出，供未来 UI 展示。
- Skill auto-inject 和 slash command 入口后续应复用同一 runner，避免出现多条 Agent 执行路径。
