# BetaV0.1.1 MCP stdio 启动器

## 范围

本次新增 `packages/core-tools/src/mcp-stdio-launcher.ts`，提供可替换的 stdio MCP runtime launcher。该切片不引入新依赖、不开发前端 UI、不接入远程 SSE/HTTP MCP。

## 新增能力

- `createStdioMcpRuntimeLauncher()`：把 `McpServerConfig` 转换为 `McpRuntimeLauncher`。
- `launchStdioMcpServer()`：启动真实子进程并返回 `McpRuntimeClient`。
- 支持 JSON-RPC 方法：
  - `initialize`
  - `notifications/initialized`
  - `tools/list`
  - `tools/call`
- 支持 request timeout、AbortSignal、stderr 尾部截断和 stop/kill。
- 支持 `env` 中的 keychain ref 解析：`{ ref: "..." }` 必须通过 `resolveSecret` 注入，不能被直接写入子进程环境。

## 安全边界

- 不把 `{ ref }` 当作明文环境变量传给 MCP 子进程。
- `windowsHide: true`，避免 Windows 下启动可见控制台窗口。
- 子进程 stderr 只保留有限尾部用于错误诊断，避免无限内存增长。
- 超时请求会被拒绝，避免 Agent 永久等待卡死 MCP server。

## 测试

新增 `packages/core-tools/test/mcp-stdio-launcher.test.ts`，使用真实 Node 子进程 fixture 覆盖：

- 启动 stdio 子进程、初始化、列出工具、调用工具、停止。
- secret ref 解析后注入环境变量。
- secret ref 缺失时启动失败。
- 卡死子进程请求超时。
- 子进程异常退出时返回包含 exit code 的错误。

## 已知边界

- 当前 fixture 使用 newline JSON-RPC。官方 MCP SDK 接入后，真实协议细节应由 SDK transport 承担；本 launcher 的价值是先固定 DBAgent 内部 runtime client 合同和进程安全边界。
- 当前不做 npm 镜像、npx 首次拉取缓存和资源采样；这些属于后续真实 MCP process manager 切片。
