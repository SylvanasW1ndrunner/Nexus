# 2026-07-09 desktop MCP 服务与 IPC

## 范围

本切片把 core MCP 能力接入 desktop 主进程，形成无 UI 的 MCP 配置、启动、停止、健康检查和工具注册入口。

本次不涉及 renderer UI，不接入 MCP Market 网络 API，不新增依赖。

## 变更

- shared 新增 `ipcChannels.mcp.*` 和 MCP DTO。
- 新增 `DesktopMcpService`。
- desktop main 创建 MCP store/runtime/health/tool registration，并注册 IPC handlers。
- desktop 启动时执行 `startAutoStart()`，失败只记录日志，不阻断应用启动。
- MCP secret 通过现有 `CredentialVault` 保存，IPC 返回不暴露明文。

## 验收

- `tsc -p packages/shared/tsconfig.json --noEmit`
- `tsc -b apps/desktop/tsconfig.json --pretty false`
- `vitest run apps/desktop/src/main/mcp-service.test.ts --passWithNoTests`

## 风险

- 当前只支持 stdio launcher；SSE/streamable-http 配置可以保存，但 runtime launcher 仍会拒绝非 stdio server。
- 自动重启调度入口已暴露为 `mcp:restart-due`，但主进程尚未内建周期性定时器。
- MCP Market 搜索、安装来源校验和第三方 manifest 信任链仍在后续切片处理。
