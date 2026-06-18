# BetaV0.1.1 MCP 配置持久化

## 范围

本次新增 `packages/core-tools/src/mcp-config-store.ts`，提供 `mcp.json` 的纯后端配置合同。该切片不启动 MCP 子进程、不接入 MCP SDK、不开发前端 UI。

## 配置格式

配置文件结构：

```json
{
  "version": 1,
  "servers": []
}
```

单个 server 支持：

- `id`：稳定唯一 ID，只允许字母、数字、点、下划线和横线。
- `name`：用户可读名称。
- `source`：`builtin`、`user`、`market`。
- `transport`：`stdio`、`sse`、`streamable-http`。
- `command` / `args`：stdio server 启动命令。
- `url`：远程 MCP endpoint，必须是 `http` 或 `https`。
- `env`：环境变量，敏感变量必须写成 `{ "ref": "mcp:<serverId>:env:<VAR>" }`。
- `autoStart`：应用启动时是否自动启动。
- `enabled`：是否启用。
- `installedAt` / `updatedAt`：安装和更新时间。

## 安全边界

- 不把 DB 密码、API key、token、secret 等明文写入 `mcp.json`。
- `API_KEY`、`TOKEN`、`SECRET`、`PASSWORD`、`PRIVATE` 等环境变量名如果使用明文值会被拒绝。
- 形如 `sk-...` 或 `Bearer ...` 的值即使变量名不敏感，也会被拒绝写入明文配置。
- 删除 server 默认不返回 secret refs，只有显式 `deleteSecrets: true` 时才返回可供 keychain 清理的引用。
- 损坏或缺失的 `mcp.json` 会安全恢复为空配置或默认内置配置，保证应用可启动。

## 默认内置 MCP

默认提供 3 个按需启动的内置 MCP 配置：

- `builtin-memory`
- `builtin-time`
- `builtin-fetch`

这些配置 `autoStart` 默认为 `false`，避免启动阶段额外拉起 npm 子进程和占用内存。真正启动由后续 MCP Client Manager 实现。

## 测试

新增 `packages/core-tools/test/mcp-config-store.test.ts`，覆盖：

- 新用户 profile 加载默认内置 MCP 配置。
- 用户 stdio MCP 配置的原子持久化和 keychain ref 保留。
- 敏感环境变量明文写入被拒绝。
- stdio command、远程 HTTP/S URL 校验。
- 缺失或损坏 `mcp.json` 不阻断应用启动。
- 启用/禁用和 autoStart 切换不影响其他 server。
- 删除 server 时默认保留 secrets，显式要求时返回 secret refs。
- 重复 server id 被拒绝。

## 已知边界

- 当前不负责 keychain 写入和删除，只返回 ref，由主进程凭证层执行。
- 当前不负责 MCP 进程生命周期；后续 `McpClientManager` 将基于该 store、`mcp-health.ts` 和 `mcp-tool-adapter.ts` 实现 start/stop/restart/list_tools。
- 当前未实现备份保留最近 3 个版本，后续配置迁移切片统一补齐。
