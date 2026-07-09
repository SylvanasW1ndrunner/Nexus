# 2026-07-09 MCP 运行时退出恢复

## 范围

本切片把 MCP health 的重启计划接到 runtime manager，形成“进程退出 -> 移除 tool -> 标记 restarting -> 到期重启 -> 重新注册 tool”的后端闭环。

本次不涉及 UI，不新增依赖，不改变 MCP tool adapter 的命名规则。

## 变更

- 新增 `McpRuntimeExitResult`。
- 新增 `McpRuntimeManager.recordExit()`。
- 新增 `McpRuntimeManager.restartDue()`。
- 补充 MCP runtime manager 用户级测试，验证异常退出后 Agent 不再暴露旧工具，到期重启后工具恢复。

## 验收

- `tsc -p packages/core-tools/tsconfig.json --noEmit`
- `vitest run packages/core-tools/test/mcp-runtime-manager.test.ts packages/core-tools/test/mcp-health.test.ts packages/core-tools/test/mcp-tool-registration-manager.test.ts packages/core-tools/test/mcp-tool-adapter.test.ts --passWithNoTests`

## 风险

- `restartDue()` 不内建定时器，上层必须主动调用。
- 如果重启到期时配置已删除，当前语义会沿用 `start()` 的 `MCP server not found` 报错；桌面主进程接入时需要捕获并写入诊断。
