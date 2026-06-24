# 2026-06-24 官方插件 Agent 工具策略切片

## 目标

把官方插件运行时策略接入 Agent / Skill 工具选择流程。此前 `resolveRuntimeTools()` 已能从官方插件 manifest 和 runtime tools 生成插件级白名单；本切片新增上层策略函数，将插件白名单与 Skill `allowedTools` 合并，输出最终可传给 `ReactAgent.run({ allowedTools })` 的工具列表。

## 实现范围

- `packages/core-tools/src/official-plugin-tool-policy.ts`
  - 新增 `runtimeToolsFromToolRegistry()`：从真实 `ToolRegistry.list()` 提取 tool name、风险等级、只读标记和来源元数据。
  - 新增 `resolveOfficialPluginAgentTools()`：合并官方插件策略、运行时工具状态和可选 Skill allowed tools。
  - 输出：
    - `agentAllowedToolNames`：最终传给 Agent 的工具白名单。
    - `pluginAllowedToolNames`：官方插件策略允许的运行时工具。
    - `blockedByPluginToolNames`：Skill 想用但插件策略、风险等级、禁用状态或运行时缺失导致不可用的工具。
    - `blockedBySkillToolNames`：插件允许但当前 Skill 未声明的工具。
    - `runtimeResolution`：底层运行时策略诊断信息。
- `packages/core-tools/src/index.ts`
  - 导出策略函数，供主进程、Agent runner 或后续 Skill runner 使用。

## 策略语义

- 未选择 Skill 时：`agentAllowedToolNames = pluginAllowedToolNames`。
- 选择 Skill 时：最终工具列表按 Skill `allowedTools` 原始顺序输出，但只保留插件策略允许且 runtime 中真实存在的工具。
- 禁用官方插件、只读模式、最大风险等级和动态来源匹配仍由底层 `resolveRuntimeTools()` 统一执行。
- Skill 中重复声明同一工具会报错，避免上层 prompt 和工具列表出现重复语义。
- 必须二选一提供 `runtimeTools` 或 `toolRegistry`，避免调用方同时传入两份不一致的运行时事实源。

## 安全边界

- Skill 文件不能直接放权工具；它只能在官方插件策略允许范围内进一步缩小白名单。
- 官方插件策略也不能绕过 Agent permission manager。最终执行仍受工具风险等级、只读模式、approval provider、approval provenance 和 handler 内部校验约束。
- 第三方 MCP 和 workspace script 必须先进入 `ToolRegistry` 并带有来源元数据，才可能被策略放行。

## 测试

- `official-plugin-tool-policy.test.ts`
  - 从真实 `ToolRegistry` 生成 runtime descriptors。
  - 合并官方插件启用状态、Skill allowed tools 和 runtime tool metadata。
  - MCP 插件禁用时阻断 MCP 动态工具。
  - Skill 未声明的插件可用工具不会进入最终 Agent 工具列表。
  - 无 Skill 时按插件策略直接输出 Agent 工具列表。
  - 同时传 `runtimeTools` 和 `toolRegistry`、或 Skill 重复声明工具时抛错。

## 验证记录

- `pnpm exec tsc -p packages/core-tools/tsconfig.json --noEmit`
- `pnpm exec vitest run packages/core-tools/test/official-plugin-tool-policy.test.ts packages/core-tools/test/official-plugin-registry.test.ts`
  - 2 个测试文件通过。
  - 11 个用例通过。

## 后续

- 在真实 Agent runner / Skill runner 层使用 `resolveOfficialPluginAgentTools()` 生成 run options。
- 主进程后续需要根据 workspace 配置、启用插件、启用 MCP server、当前 Skill 和 Agent mode 组装策略输入。
- 需要在 UI 重建时把 `blockedByPluginToolNames` / `blockedBySkillToolNames` 作为诊断信息暴露给用户，而不是静默隐藏。
