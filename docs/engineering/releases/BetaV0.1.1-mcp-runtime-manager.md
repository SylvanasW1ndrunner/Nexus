# BetaV0.1.1 MCP 运行时管理器

## 范围

本次新增 MCP 运行时管理器的纯后端合同和测试夹具。该切片不引入 `@modelcontextprotocol/sdk`，不启动真实 MCP 子进程，不开发前端 UI。

## 新增能力

- `packages/core-tools/src/mcp-runtime-manager.ts`
  - `McpRuntimeClient`：抽象 MCP client，提供 `listTools()`、`callTool()`、`stop()`。
  - `McpRuntimeLauncher`：把 `McpServerConfig` 启动为 runtime client 的可替换入口。
  - `McpRuntimeManager.start(serverId)`：读取 `mcp.json` 配置，启动 client，调用 `listTools()`，注册到 ToolRegistry，并更新健康状态。
  - `stop(serverId)`：停止 client、注销该 server 的工具、标记 stopped。
  - `startAutoStart()`：只启动 enabled 且 autoStart 的 server。
- `McpHealthManager.markStopped()`：用于 server stop 后清理健康状态和 CPU 采样状态。

## 用户价值

后续真实 MCP SDK 接入时，主进程只需要提供 launcher，就可以复用这套生命周期逻辑。用户禁用、停止或重启 MCP server 后，Agent 可见工具会同步更新，避免模型继续调用已经不可用的工具。

## 测试

新增 `packages/core-tools/test/mcp-runtime-manager.test.ts`，覆盖：

- 启动 enabled MCP server 后注册工具，并能通过 ToolRegistry 调用。
- 停止 server 后工具从 Agent 暴露列表中移除。
- disabled server 不启动，状态标记为 disabled。
- 启动失败时标记 unhealthy，且不留下半注册工具。
- `startAutoStart()` 只启动 enabled + autoStart 的 server。

## 已知边界

- 当前 launcher 是接口，不负责真实 stdio/SSE/streamable-http 协议。
- 当前不做进程内存和 CPU 采样；该能力已在 `McpHealthManager` 中预留，由后续真实进程管理器接入。
- 当前不做 keychain env 注入；该能力应在真实 launcher 启动进程前读取 secret refs。
