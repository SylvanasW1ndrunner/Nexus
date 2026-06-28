# desktop：Agent 工具注册与工作区接线

## 模块职责

`apps/desktop/src/main/agent-tool-bootstrap.ts` 是桌面端 Agent 工具装配层。它把桌面主进程已有能力注册到 `ToolRegistry`，但不实现具体数据库、RAG 或文件系统逻辑。

## 当前装配

- 数据库工具：通过 `ConnectionStore.list()` 读取最新连接状态，再按 `connection.engine` 路由到 `DatabaseDriverRegistry`。
- Schema RAG 工具：复用 `SchemaRagEngine` 和 `registerDatabaseTools()` 的组合注册能力。
- 工作区文件工具：复用 `WorkspaceCore`，并通过 `WorkspaceProjectStore.loadActive()` 在执行时读取当前 active workspace root。

## 工作区接线策略

桌面端不在工具注册时缓存工作区路径。每次 `list_workspace_dir`、`read_workspace_file` 或 `write_workspace_file` 执行时，都会调用 `workspaceProjects.loadActive()` 获取最新项目。

这样做的原因：

- 用户可以在应用运行期间打开、关闭或切换项目。
- Agent session 可能长于一个项目状态快照。
- 文件系统访问必须始终绑定到当前确认过的 workspace root。

## 失败语义

- 没有 active workspace：工具返回 `No active workspace.`。
- 路径越界：由 `WorkspaceCore` 返回路径越界错误。
- 文件不存在或读写失败：由 `WorkspaceCore` 保留底层可诊断错误。

## 测试入口

- `apps/desktop/src/main/agent-tool-bootstrap.test.ts`
  - 工具注册清单。
  - 异步连接状态读取与 SQL driver 路由。
  - 未连接数据库拒绝执行。
  - 未打开项目时 workspace 工具拒绝访问。
  - 注册后再激活项目时，workspace 工具可写入并读取真实临时工作区文件。
