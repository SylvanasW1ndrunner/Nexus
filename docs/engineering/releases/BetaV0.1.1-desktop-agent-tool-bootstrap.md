# BetaV0.1.1 桌面端 Agent 工具注册

## 范围

本版本增量把 desktop main 的无 UI Agent service 接入真实工具注册。Agent runtime 现在可以看到数据库、Schema RAG 和 workspace 文件工具定义，不再是空 `ToolRegistry`。

## 主要变更

- 新增 `registerDesktopAgentTools()`，集中装配桌面端 Agent 工具。
- 数据库工具通过异步连接读取器获取最新连接状态。
- SQL 工具通过 connection `engine` 路由到 `DatabaseDriverRegistry` 中的真实 driver。
- desktop main 显式依赖 `core-rag` 和 `core-workspace`，用于 RAG 与 workspace 官方工具装配。
- `audit_sql` 适配异步连接读取，保持只读安全预审语义。

## 验证

- `tsc -p packages/core-tools/tsconfig.json --noEmit`
- `tsc -p apps/desktop/tsconfig.json --noEmit`
- `eslint apps/desktop/src/main/agent-tool-bootstrap.ts apps/desktop/src/main/agent-tool-bootstrap.test.ts apps/desktop/src/main/main.ts packages/core-tools/src/db-tools.ts packages/core-tools/test/db-tools.test.ts`
- `vitest run apps/desktop/src/main/agent-tool-bootstrap.test.ts packages/core-tools/test/db-tools.test.ts apps/desktop/src/main/agent-service.test.ts --passWithNoTests`

## 已知边界

- workspace 文件工具已注册，但 active workspace root 尚未接入 desktop Agent runtime，当前返回 `No active workspace.`。
- Python script tools 尚未注册到 desktop Agent runtime。
- 本增量不包含真实 LLM live test；live test 将在 Skill + tool policy 端到端切片中执行。
