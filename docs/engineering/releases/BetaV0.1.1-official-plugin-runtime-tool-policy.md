# BetaV0.1.1 官方插件运行时工具策略

## 范围

本版本新增后端纯策略能力：官方插件 manifest 现在可以根据真实 runtime tools 生成 Agent 可用的工具白名单。该能力服务于后续插件市场、官方插件、Skill allowedTools 和 Agent 权限策略，不涉及前端 UI。

## 变更

- `AgentToolDefinition` 增加可选来源元数据：`source`、`sourceId`、`originalName`。
- workspace Python 脚本工具注册时标记为 `source: "workspace-script"`。
- 官方插件 manifest 的动态工具贡献增加 `runtimeSources`：
  - `workspace_script:*` 匹配 `workspace-script`。
  - `mcp:*` 匹配 `user-mcp` / `market-mcp`。
- `OfficialPluginRegistry.resolveRuntimeTools()` 可输出：
  - 允许工具：`allowedToolNames`
  - 被阻断工具：`blockedToolNames`
  - 命中的静态工具：`staticToolNames`
  - 命中的动态工具：`dynamicToolNames`
  - 当前运行时缺失的静态贡献：`missingStaticToolNames`

## 安全说明

- manifest 仍然不是运行时执行器，不注册 handler。
- 官方插件不会获得特殊放权；执行前仍需经过 `ToolRegistry`、Agent `allowedTools`、权限模式、风险等级和 approval provenance。
- 动态工具必须有来源元数据。未被 MCP adapter 或 workspace script adapter 标记来源的动态工具不会被官方插件贡献自动放行。
- 本切片无新增依赖，无打包影响。

## 验证记录

- `pnpm exec tsc -p packages/core-agent/tsconfig.json --noEmit`
- `pnpm exec tsc -p packages/core-tools/tsconfig.json --noEmit`
- `pnpm exec vitest run packages/core-tools/test/official-plugin-registry.test.ts packages/core-tools/test/workspace-script-tools.test.ts packages/core-tools/test/mcp-tool-adapter.test.ts`
  - 3 个测试文件通过。
  - 24 个用例通过。

## 已知边界

- 当前还没有把 `resolveRuntimeTools()` 接入具体 Agent run options；这是下一切片。
- 当前仍不处理插件下载、签名、升级、卸载、沙箱和 UI。
- 第三方插件 manifest 的 source、签名和安装目录策略仍需后续单独设计。
