# BetaV0.1.1 PostgreSQL 游标分页与大结果保护

## 本轮变更

- PostgreSQL 单条只读查询新增游标分页保护，避免大结果集一次性进入主进程和 IPC。
- `QueryExecutionResult`、`QueryResultSet`、`QueryHistoryItem` 扩展截断元数据。
- JSON / Excel 导出保留 `returnedRowCount`、`rowLimit`、`hasMore`、`truncated`。
- 查询快照保留大结果截断状态，便于后续审计和恢复。
- 真实 PostgreSQL 测试脚本改为按 package 目录运行，解决 Windows 根目录 Vitest 转换超时。

## 用户价值

数据工程师和分析师在没有手动写 `LIMIT` 的情况下执行宽表或明细表查询时，产品会默认保护本地资源，并明确告诉上层“当前只返回部分结果”。这为后续结果表格、导出、Agent 解释和查询历史提供一致的数据边界。

## 验收结论

本轮没有新增运行时依赖，没有修改前端 UI，没有改变多数据库策略。核心回归、共享契约、桌面主进程查询流和真实 PostgreSQL 测试均通过。
