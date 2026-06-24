# BetaV0.1.1 官方插件 Agent 工具策略

## 范围

本版本新增后端纯策略能力：从真实 `ToolRegistry`、官方插件 manifest 和可选 Skill `allowedTools` 生成最终 Agent 工具白名单。该能力不涉及前端 UI，也不改变具体 tool handler。

## 变更

- 新增 `packages/core-tools/src/official-plugin-tool-policy.ts`。
- 新增 `runtimeToolsFromToolRegistry()`，把 `ToolRegistry.list()` 转为官方插件策略可消费的 runtime descriptors。
- 新增 `resolveOfficialPluginAgentTools()`，输出：
  - `agentAllowedToolNames`
  - `pluginAllowedToolNames`
  - `blockedByPluginToolNames`
  - `blockedBySkillToolNames`
  - `runtimeResolution`
- `@dbagent/core-tools` 入口导出上述策略函数。

## 用户级意义

后续用户运行某个 Skill 或 Agent 任务时，系统可以先计算“这个任务到底能看到哪些工具”，并解释为什么某些工具不可用。例如：

- MCP 插件被禁用，所以 Skill 中声明的 MCP 工具不会给 Agent。
- 当前是只读模式，所以写 SQL 或执行脚本工具不会给 Agent。
- Skill 未声明 `execute_sql`，即使官方数据库插件启用，也不会暴露写 SQL 工具。

## 安全说明

- Skill 不能越权放大工具集合，只能在官方插件策略允许范围内收窄。
- 官方插件策略只生成白名单，不执行工具。
- 真实执行继续依赖 Agent permission manager、approval provider、approval provenance 和 handler 内部校验。

## 验证记录

- `pnpm exec tsc -p packages/core-tools/tsconfig.json --noEmit`
- `pnpm exec vitest run packages/core-tools/test/official-plugin-tool-policy.test.ts packages/core-tools/test/official-plugin-registry.test.ts`
  - 2 个测试文件通过。
  - 11 个用例通过。

## 已知边界

- 真实桌面端 Agent runner 还没有接入该策略函数。
- UI 重建阶段需要展示 blocked 工具原因和诊断信息。
- 第三方插件签名、安装、升级和沙箱仍未实现。
