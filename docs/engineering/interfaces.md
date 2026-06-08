# 接口文档

## IPC 边界

Renderer 只能通过 `packages/shared/src/ipc.ts` 中定义的类型化 IPC 契约调用主进程能力。

当前 M1/M1.5 通道：

- `connection:list`
- `connection:test`
- `connection:create`
- `connection:update`
- `connection:remove`
- `connection:connect`
- `connection:disconnect`
- `db:execute-query`
- `db:query-history`
- `db:explain-query`
- `db:list-tables`
- `auth:login`
- `auth:logout`
- `auth:status`
- `usage:current-quota`
- `usage:history`
- `app:load-workspace-state`
- `app:save-workspace-state`

所有响应统一使用 `packages/shared/src/result.ts` 中的 `Result<T>`，让 UI 显式处理业务失败，而不是捕获无类型异常。

## 数据库驱动边界

`IDatabaseDriver` 是 M1 阶段的稳定边界。目前只实现 PostgreSQL，但接口刻意保持数据库无关：

- `test(config)`：检查连接可达性。
- `connect(config)`：创建或恢复活动连接池。
- `disconnect(connectionId)`：关闭连接池资源。
- `execute(request, connection)`：执行 SQL，并返回字段、行数据、耗时和安全报告。
- `listTables(connectionId)`：为 M1.5 Schema 树和后续 M2 RAG 提供表/视图列表。

## 工作区状态

M1.5 通过 `app:*workspace-state` IPC 通道持久化当前活动连接和 SQL 编辑器草稿。

状态文件位于 Electron `userData/data/workspace-state.json`，写入方式为临时文件加 rename 的原子写，避免半写入状态。当前只保存最小恢复信息，先覆盖日常 SQL 编辑路径；完整 Session、Tab 和 Agent checkpoint 后续再进入独立存储。

## 结果导出

`packages/shared/src/csv.ts` 中的 `queryResultToCsv(result)` 将查询结果转换为 CSV，供 Excel/WPS 等表格工具导入。

它会保持数据库返回的列顺序，并处理逗号、引号、换行、JSON 值和 `NULL` 等真实业务数据边界。

## SQL 安全

`analyzeSqlSafety(sql, { readOnly })` 会在执行前分类 SQL。

- 只读连接允许 `SELECT`、`WITH`、`SHOW`、`EXPLAIN` 和 `VALUES`。
- 只读连接阻止 `INSERT`、`UPDATE`、`DELETE`、`MERGE`、`CALL` 和 DDL。
- 非只读连接上的写操作和 DDL 需要用户确认。
- 多语句 SQL 需要审查，因为影响范围更大。

安全报告会写入查询历史，并返回给 renderer。

## 凭证处理

连接元数据与密码分开存储。桌面主进程在本地凭证文件中保存密码，并优先使用 Electron `safeStorage` 加密。Renderer 在创建连接后不会再收到已保存密码；删除连接时也会删除对应凭证。

这是 M1 的过渡实现。公开发布前，应将该边界迁移到 OS keychain adapter 后面，分别测试 Windows Credential Manager、macOS Keychain 和 Linux secret storage。
