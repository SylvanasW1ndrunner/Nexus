# core-db PostgreSQL 大结果集保护

## 模块边界

本模块说明 `core-db` 本轮新增的 PostgreSQL 大结果集保护。实现仅位于后端核心、typed IPC 和持久化契约，不涉及 renderer UI。

`PostgresDriver.execute()` 对单条只读 `SELECT` / `WITH` / `VALUES` 使用 PostgreSQL server-side cursor 读取 `limit + 1` 行。默认上限为 10000 行，调用方可以通过 `QueryRequest.limit` 指定，最大上限为 100000 行。

## 结果契约

- `returnedRowCount`：实际返回给上层的行数。
- `rowLimit`：本次查询使用的行上限。
- `hasMore`：通过额外探测一行判断后续是否还有更多数据。
- `truncated`：当前结果是否已被截断。

`rowCount` 在游标路径中表示本次 `FETCH limit + 1` 的探测行数，不代表数据库总行数。后续如需精确总数，应由表数据浏览或结果面板提供单独 count 策略。

## 安全规则

以下场景不进入游标分页路径：

- 多语句 SQL。
- 写操作和 DDL。
- 需要用户确认的 SQL。
- rollback preview。
- read-only 安全检查已阻断的 SQL。

这些场景必须保持原有事务、确认和回滚语义，不能为了分页改变安全边界。

## 持久化与导出

查询历史、结果快照、JSON 导出和 Excel 兼容导出都会保留截断元数据。用户后续从历史、快照或导出文件回看结果时，可以明确知道该结果是否为部分结果。
