# 2026-07-09 MCP stdio 退出自动恢复

## 范围

本切片把真实 stdio MCP 子进程的 `error` / `exit` 事件接入 `McpRuntimeManager`，让 MCP server 异常退出后自动移除 Agent 可见工具并进入 health 重启计划。

本次仍不涉及 UI，不新增依赖，不改变 MCP tool 命名和权限策略。

## 变更

- `McpRuntimeClient` 新增可选 `onExit(handler)` 订阅接口。
- `StdioMcpRuntimeClient` 在真实子进程 `error` / `exit` 时发出退出事件，包含 code、signal、stderr tail 和时间。
- `McpRuntimeManager.start()` 在 server 启动成功后订阅 client exit；如果仍是当前运行中的 client，则调用 `recordExit()`。
- `McpRuntimeManager.stop()` 和 `recordExit()` 会取消订阅，避免用户主动停止或旧 client 延迟事件造成误判。
- 补充真实 stdio 进程测试，验证进程退出后 `ToolRegistry` 不再暴露过期工具。

## 验收

- `tsc -p packages/core-tools/tsconfig.json --noEmit`
- `vitest run packages/core-tools/test/mcp-runtime-manager.test.ts packages/core-tools/test/mcp-stdio-launcher.test.ts packages/core-tools/test/mcp-health.test.ts packages/core-tools/test/mcp-tool-registration-manager.test.ts packages/core-tools/test/mcp-tool-adapter.test.ts --passWithNoTests`

## 风险

- `onExit` 是可选能力；非 stdio launcher 如果不实现该接口，仍需上层手动调用 `recordExit()`。
- 当前自动恢复只负责状态收敛和重启计划，真正的定时调度仍由上层调用 `restartDue()`。
- `stderrPreview` 只保留尾部片段，用于诊断，不应包含密钥；后续 desktop 日志接入时仍需要统一脱敏。
