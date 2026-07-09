# desktop MCP 后端服务

## 范围

`apps/desktop/src/main/mcp-service.ts` 是桌面主进程的 MCP 后端服务。它把 `core-tools` 的 MCP 配置、运行时、健康状态和工具注册组合起来，并通过 typed IPC 暴露给后续 UI、设置页、Agent 调试面板和插件市场流程。

本模块不依赖 renderer，不实现 MCP Market 网络搜索，不实现 UI。

## 代码入口

- `packages/shared/src/ipc.ts`
  - `ipcChannels.mcp.*`
  - `McpServerInput`
  - `McpUpsertServerRequest`
  - `McpServerSummary`
  - `McpServerOperationResult`
  - `McpServerHealthPreview`
- `apps/desktop/src/main/mcp-service.ts`
  - `DesktopMcpService`
- `apps/desktop/src/main/main.ts`
  - 创建 `McpConfigStore`
  - 创建 `McpHealthManager`
  - 创建 `McpToolRegistrationManager`
  - 创建 `McpRuntimeManager`
  - 使用 `createStdioMcpRuntimeLauncher()`
  - 注册 `mcp:*` IPC handlers
  - 应用启动时调用 `startAutoStart()`

## IPC 合同

当前已提供的无 UI 后端入口：

- `mcp:list`：列出 server 配置摘要、health、已注册工具和运行状态。
- `mcp:upsert`：创建或更新 MCP server 配置，可同时保存 env secrets，可选 `start: true` 立即启动。
- `mcp:remove`：停止 server，删除配置；`deleteSecrets: true` 时删除相关 secret refs。
- `mcp:start`：启动指定 server，执行 `list_tools` 并注册到 Agent `ToolRegistry`。
- `mcp:stop`：停止指定 server 并移除该 server 暴露的 Agent tools。
- `mcp:start-autostart`：启动所有 enabled 且 autoStart 的 server。
- `mcp:restart-due`：按 health `nextRestartAt` 重启到期 server。
- `mcp:health`：返回全部已知 server health。

## Secret 边界

`mcp:upsert` 支持 `secrets: Record<string, string>`。调用方必须提供 server `id`，服务会把每个 secret 保存到：

```text
mcp:{serverId}:env:{ENV_NAME}
```

配置文件只保存 `{ ref }`。IPC 返回值中的 env 只暴露：

- `{ kind: "plain" }`
- `{ kind: "secret-ref", ref }`

不会返回明文 env value。`createStdioMcpRuntimeLauncher()` 启动子进程时通过 `DesktopMcpService.resolveSecret()` 从 `CredentialVault` 读取 ref。

## 运行时边界

MCP server 启动后，工具通过 `McpToolRegistrationManager` 注册进同一个 Agent `ToolRegistry`。停止、删除、异常退出或重启失败时，相关工具会从 registry 移除，避免 Agent 看到不可用工具。

当前 desktop 在应用启动时执行一次 `startAutoStart()`。自动重启的调度入口已经通过 `mcp:restart-due` 暴露；后续可以在主进程增加轻量定时器或由后台任务调用。

## 测试覆盖

`apps/desktop/src/main/mcp-service.test.ts` 覆盖：

- 保存 secret env ref，启动 MCP server，IPC 返回值不暴露 secret 明文。
- 启动后工具进入 Agent `ToolRegistry`。
- stop 后工具被移除。
- remove + `deleteSecrets` 删除 secret refs。
- disabled server 不启动，并能返回 disabled health。

相关 core 测试继续覆盖真实 stdio 子进程、timeout、exit 自动恢复、tool adapter 和注册回滚。
