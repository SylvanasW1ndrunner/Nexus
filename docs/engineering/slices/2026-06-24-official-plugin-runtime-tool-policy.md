# 2026-06-24 官方插件运行时工具策略切片

## 目标

把官方插件 manifest 从“能力目录”推进到“运行时工具白名单策略”。本切片仍然不实现插件市场 UI、不下载安装第三方插件、不启动新的运行时；只提供后端纯函数合同，让 Agent / Skill / MCP / Workspace script 后续可以从同一套官方插件权限模型生成 `allowedTools`。

## 实现范围

- `packages/core-agent/src/types.ts`
  - 为 `AgentToolDefinition` 增加可选来源元数据：`source`、`sourceId`、`originalName`。
  - 字段为向后兼容扩展，现有工具不填也不影响 LLM tool schema。
- `packages/core-tools/src/workspace-script-tools.ts`
  - workspace Python 脚本注册为 Agent tool 时写入 `source: "workspace-script"`、脚本路径和原始工具名。
- `packages/core-tools/src/official-plugin-registry.ts`
  - `OfficialPluginToolContribution` 增加 `runtimeSources`。
  - 官方 `workspace_script:*` 动态贡献绑定 `workspace-script` 来源。
  - 官方 `mcp:*` 动态贡献绑定 `user-mcp` / `market-mcp` 来源。
  - 新增 `resolveRuntimeTools()`，根据当前真实 runtime tools 生成：
    - `allowedToolNames`
    - `blockedToolNames`
    - `staticToolNames`
    - `dynamicToolNames`
    - `missingStaticToolNames`
    - `dynamicContributions`

## 策略语义

- 静态工具按名称匹配，例如 `query_database`、`execute_sql`、`read_workspace_file`。
- 动态工具不靠字符串猜测业务语义，而是靠工具适配器写入的来源元数据匹配：
  - MCP 工具：`source` 为 `user-mcp` 或 `market-mcp`。
  - Workspace Python 脚本：`source` 为 `workspace-script`。
- `disabledPluginIds` 会直接移除对应官方插件贡献。
- `readonlyOnly` 和 `maxDangerLevel` 同时约束 manifest 贡献和 runtime tool 自身风险，避免运行时工具实际风险高于 manifest 声明时被放行。
- 重复 runtime tool name 会抛错，避免上层 Agent 得到不确定的工具白名单。

## 安全边界

- 官方插件 manifest 不注册 handler，不绕过 `ToolRegistry`，不绕过 Agent permission manager。
- `resolveRuntimeTools()` 只生成允许名单；真实执行仍由：
  - `ToolRegistry`
  - Agent `allowedTools`
  - `dangerLevel`
  - `readonly`
  - approval provenance
  - 具体 tool handler
  共同兜底。
- 动态工具必须声明 `namePattern`。MCP / workspace script 这类动态来源还必须由 adapter 写入来源元数据，否则不会被动态贡献自动放行。
- 本切片没有新增依赖，不影响打包体积。

## 开源借鉴

- 继续沿用 VS Code Extension Manifest 的声明式 contribution 思路：manifest 负责声明能力，不直接执行能力。
- 继续沿用 MCP Tools 规范中的 tool name / schema / annotation / 用户确认 / 审计思想：动态工具必须先被平台归一化，再进入 Agent 工具策略。
- 当前没有引入现成 marketplace 库。原因是这一层是我们的平台安全合同，依赖第三方实现会增加后续权限、审计和打包边界的不确定性。

## 测试

- `official-plugin-registry.test.ts`
  - 默认官方插件可解析静态和动态贡献。
  - runtime tools 可根据静态工具名和动态来源生成 `allowedToolNames`。
  - disabled plugin、readonly、max danger level 会影响运行时允许名单。
  - 动态工具缺少 `namePattern` 会被拒绝。
  - 重复 runtime tool descriptor 会被拒绝。
- `workspace-script-tools.test.ts`
  - 真实 Python runner 相关用例继续通过。
  - workspace script 注册工具时带有 `source` / `sourceId` / `originalName`。
- `mcp-tool-adapter.test.ts`
  - MCP 工具适配器继续保持来源元数据和风险推断能力。

## 验证记录

- `pnpm exec tsc -p packages/core-agent/tsconfig.json --noEmit`
- `pnpm exec tsc -p packages/core-tools/tsconfig.json --noEmit`
- `pnpm exec vitest run packages/core-tools/test/official-plugin-registry.test.ts packages/core-tools/test/workspace-script-tools.test.ts packages/core-tools/test/mcp-tool-adapter.test.ts`
  - 3 个测试文件通过。
  - 24 个用例通过。

## 后续

- Agent / Skill policy 层接入 `resolveRuntimeTools()`，按启用插件生成 `allowedTools`。
- MCP server 安装 / 启用 / 禁用状态与官方插件策略打通。
- 将官方插件 manifest 扩展到 result schema、health check、配置 schema 和审计字段。
- 后续实现第三方插件时，复用同一策略函数，但 source 必须从 `official` 扩展为可校验的 marketplace / local source。
