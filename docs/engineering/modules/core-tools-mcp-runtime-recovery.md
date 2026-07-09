# core-tools MCP 运行时退出恢复

## 范围

本模块补齐 MCP server 运行时的退出恢复闭环。它位于 `core-tools`，不依赖 Electron，不操作 UI，不直接启动定时器；上层桌面主进程后续可以用自己的调度器轮询 `restartDue()`。

代码入口：
- `packages/core-tools/src/mcp-runtime-manager.ts`
- `packages/core-tools/src/mcp-health.ts`
- `packages/core-tools/src/mcp-tool-registration-manager.ts`
- `packages/core-tools/src/mcp-tool-adapter.ts`

## 行为合同

`McpRuntimeManager.recordExit(serverId, input)` 用于 MCP 子进程异常退出后的同步收敛：
- 从 `ToolRegistry` 移除该 server 贡献的所有 tool。
- 从 runtime client map 中删除该 server。
- 调用 `McpHealthManager.recordExit()` 更新健康状态和指数退避重启计划。
- 返回 `removedTools` 和最新 health，便于上层写日志或诊断报告。

`McpRuntimeManager.restartDue(now)` 用于无 UI 后台调度：
- 扫描 health 中 `status === "restarting"` 且 `nextRestartAt <= now` 的 server。
- 对每个到期 server 调用 `start(serverId)`。
- 重新注册 tool 并恢复 `healthy` 状态；启动失败时沿用既有 `start()` 失败语义，清理半注册工具并标记 unhealthy。

`McpRuntimeClient.onExit(handler)` 是 launcher 可选能力。stdio launcher 已实现该接口；`McpRuntimeManager.start()` 会在启动成功后订阅退出事件。当真实子进程 `error` 或 `exit` 时，如果该 client 仍是当前运行实例，manager 会自动调用 `recordExit()`。用户主动 `stop()` 会先取消订阅，避免把正常停止误记为崩溃。

## 安全边界

进程退出后必须先移除 tool，再进入 restarting。这样 Agent 在 MCP server 不可用时不会继续看到旧 tool，也不会把模型生成的 tool call 发送给已经失效的 client。

`restartDue()` 不绕过配置：
- server 已禁用时，`start()` 会返回 disabled health。
- server 不在配置存储中时，`start()` 仍按当前 `requireServer()` 语义报错，由上层捕获并记录。
- 重新启动后仍通过 `McpToolRegistrationManager` 和 `registerMcpTools()` 做命名空间、source、只读和风险等级适配。

## 测试覆盖

- `packages/core-tools/test/mcp-runtime-manager.test.ts`
  - 启动 MCP server 后注册 tool。
  - stop 后移除 tool。
  - disabled server 不启动。
  - 启动失败不留下半注册工具。
  - autoStart 只启动 enabled server。
  - 异常退出后移除 tool，未到重启时间不启动，到期后重新注册 tool。
  - 真实 stdio 子进程在 `tools/list` 后退出时，runtime manager 自动移除旧 tool 并进入 restarting。
- `packages/core-tools/test/mcp-stdio-launcher.test.ts`
  - 真实 stdio 子进程退出时发出带 code 和 stderr tail 的 exit event。
- `packages/core-tools/test/mcp-health.test.ts`
  - 退出重启计划、重启上限、禁用状态、资源告警、tool timeout 和 abort。
- `packages/core-tools/test/mcp-tool-registration-manager.test.ts`
  - 注册失败回滚。
- `packages/core-tools/test/mcp-tool-adapter.test.ts`
  - MCP tool 命名空间、source 元数据、只读/风险推断和调用边界。

## 后续扩展

桌面主进程接入真实 stdio MCP 子进程时，应使用 `createStdioMcpRuntimeLauncher()`，这样 exit/error 事件会由 runtime manager 自动收敛；同时仍需要一个轻量后台调度器调用 `restartDue()`。后续还可以把 restart 结果接入官方插件策略诊断和 Agent 审计日志。
