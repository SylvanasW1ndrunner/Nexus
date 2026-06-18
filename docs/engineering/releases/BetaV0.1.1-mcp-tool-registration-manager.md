# BetaV0.1.1 MCP 工具动态注册管理

## 范围

本次新增 MCP 工具动态注册管理能力，不启动真实 MCP 进程、不接入 MCP SDK、不开发前端 UI。

## 新增能力

- `packages/core-agent/src/tool-registry.ts` 新增 `unregister(name)`，用于移除动态工具。
- `packages/core-tools/src/mcp-tool-registration-manager.ts` 新增 `McpToolRegistrationManager`：
  - `registerServerTools()`：按 serverId 成组注册 MCP 工具。
  - `unregisterServerTools()`：server stop/disable 时成组移除工具。
  - `listServerTools()` / `listAll()`：提供非 UI 调用入口观察当前动态 MCP 工具。
  - 注册失败时回滚本次新增工具，避免半注册状态污染 Agent 工具列表。

## 用户价值

MCP server 停止、崩溃、禁用或重启后，Agent 不应继续看到已经不可用的第三方工具。该切片让后续 `McpClientManager` 可以在 server 生命周期变化时同步 ToolRegistry，保证模型工具列表、权限判断和真实可执行能力一致。

## 测试

新增测试：

- `packages/core-agent/test/tool-registry.test.ts`
  - 工具注销后不再出现在 `llmTools()`。
  - 注销不存在工具不会影响已有工具。
- `packages/core-tools/test/mcp-tool-registration-manager.test.ts`
  - MCP server 工具成组注册和成组注销。
  - server 重启后替换工具列表，旧工具不再暴露。
  - malformed tool list 失败时回滚半注册工具。

## 已知边界

- 当前仍不负责 MCP 子进程启动、`list_tools` 协议调用和真实 SDK 集成。
- 当前注销只移除由 `McpToolRegistrationManager` 记录的工具；后续主进程生命周期管理必须统一通过该 manager 接线，避免绕过记录。
