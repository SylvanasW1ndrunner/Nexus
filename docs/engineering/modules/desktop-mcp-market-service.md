# desktop MCP Market 服务

## 范围

`apps/desktop/src/main/mcp-market-service.ts` 是桌面主进程的 MCP Market 编排服务。它把 market provider 的安装模板转换为 `DesktopMcpService.upsert()` 请求，复用已有配置、secret 保存、启动和工具注册流程。

本模块不实现 UI，不访问外部市场网络。

## IPC

新增 typed IPC：
- `mcp:market-search`
- `mcp:market-install`

`market-search` 支持：
- `marketId`
- `query`
- `category`
- `limit`

`market-install` 支持：
- `marketId`
- `entryId`
- `serverId`
- `name`
- `envPlain`
- `envSecrets`
- `autoStart`
- `enabled`
- `start`

## 安装流程

1. 根据 `marketId` 找到 provider。
2. 读取 entry install template。
3. 调用 `buildMcpServerInputFromMarketTemplate()` 校验 env 和 secret。
4. 调用 `DesktopMcpService.upsert()`。
5. 若 `start: true`，立即启动 MCP server，执行 `list_tools`，注册到 Agent `ToolRegistry`。

## 测试覆盖

`apps/desktop/src/main/mcp-market-service.test.ts` 覆盖：
- 搜索 provider 条目。
- 安装需要 secret env 的 market entry。
- secret 写入本地 secret store，IPC 返回只显示 ref。
- 启动后 tool 注册到 Agent registry。
- 缺少 required secret 时不写配置。
