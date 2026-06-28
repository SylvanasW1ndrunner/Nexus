# 2026-06-28 桌面端 Agent 工具注册切片

## 目标

前两个切片已经完成无 UI 的 `HeadlessAgentService` 边界和内置 Skill 注册，但 desktop main 的 `ToolRegistry` 仍然没有真实工具。本切片把已有的 DB、Schema RAG、workspace 文件工具装配到桌面端 Agent runtime，使后续 `agent:run` 不再只是空工具运行。

本切片仍然遵守当前开发路径：不恢复 renderer UI，不做 Agent 右侧面板，不接入真实 LLM live test，只在主进程服务边界验证工具注册和调用链。

## 实现范围

- `apps/desktop/src/main/agent-tool-bootstrap.ts`
  - 新增 `registerDesktopAgentTools()`。
  - 复用 `@dbagent/core-tools` 的 `registerDatabaseTools()` 和 `registerWorkspaceTools()`。
  - 复用 `@dbagent/core-rag` 的 `SchemaRagEngine`。
  - 复用 `@dbagent/core-workspace` 的 `WorkspaceCore`。
  - 新增桌面端 `ConnectionRoutingDatabaseDriver`，按连接的 `engine` 路由到真实 driver registry。
- `apps/desktop/src/main/main.ts`
  - 在创建 `ReactAgent` 前注册 DB/RAG/workspace 工具。
- `packages/core-tools/src/db-tools.ts`
  - `getConnection()` 支持同步或异步返回，适配 desktop main 的异步连接存储。
  - `audit_sql`、`query_database`、`execute_sql` 在执行前等待最新连接状态。
- `apps/desktop/package.json` / `apps/desktop/tsconfig.json`
  - desktop main 显式依赖 `core-rag` 和 `core-workspace`。

## 设计边界

- Agent 工具执行仍然只通过 `ToolRegistry`，不把数据库、RAG、workspace 逻辑写进 renderer。
- 数据库工具只接受当前已连接的 connection。断开、缺失或未激活连接会返回明确错误，不会触达 driver。
- SQL 执行继续复用 `core-db` 的安全分析、只读拦截、确认来源校验和 driver 兜底。
- workspace 文件工具已经注册，但 active workspace 的同步读取边界尚未完成。当前 handler 会返回 `No active workspace.`，这是刻意保守的冻结边界，避免 Agent 在未确认项目根目录时访问文件系统。

## 开源与依赖评估

本切片没有新增第三方依赖。原因是本轮目标是把项目内已经完成的官方工具模块接入 desktop main，而不是引入新的 Agent framework、SQL parser 或 workspace sandbox 库。

后续如果增强 SQL AST、向量检索、插件运行时隔离或 Python sandbox，应先做开源项目评估并封装在 adapter 后面，再进入实现。

## 测试覆盖

- 工具注册完整性：DB、Schema RAG、workspace 工具都进入 desktop `ToolRegistry`。
- 异步连接读取：`query_database` 使用最新 `ConnectionStore.list()` 状态。
- driver 路由：SQL 执行根据连接 `engine` 取对应 driver。
- 断开连接保护：disconnected connection 不会触达 driver。
- workspace 冻结边界：未接 active workspace root 时返回明确错误。
- 既有 DB tool 回归：`audit_sql` 改为异步后保持原有安全报告语义。

## 后续任务

- 将 active workspace root 以安全、可测试的方式接入 workspace tools，避免同步/异步边界不清。
- 为 desktop `HeadlessAgentService` 增加端到端 Skill + tool policy 验收，验证内置 Skill 能拿到真实工具集合。
- 将 Python script tools 注册到 desktop Agent runtime，但必须先完成 Python runtime 权限、环境和输出归档边界。
