# BetaV0.1.1 - PostgreSQL 查询取消运行时

## 背景

长 SQL 取消不能只停留在前端按钮或状态记录。远程数据库场景下，用户可能在本地桌面连接服务器 PostgreSQL，执行中的查询需要优先走 PostgreSQL backend cancel；如果拿不到 backend pid 或取消超时，再断开当前连接。

## 变更内容

- `IDatabaseDriver.execute()` 新增可选 `QueryExecutionObserver`，用于报告运行中查询的 PostgreSQL backend pid。
- `PostgresDriver.execute()` 改为通过 `pool.connect()` 获取 client，读取 backend pid 后回调 workflow。
- `QueryCancellationRegistry` 新增 `setBackendPid()`，把运行中 query id 和 backend pid 绑定。
- `PostgresDriver.cancel()` 支持：
  - `cancel-backend`：执行 `select pg_cancel_backend($1) as cancelled`。
  - `disconnect-connection`：调用当前连接的 `disconnect()` 作为 fallback。
- `createQueryCancellationWorkflow()` 在 cancel 决策后调用对应 driver，而不是只返回计划。

## 开源评估

本切片继续使用现有 `pg` 驱动，不新增依赖。PostgreSQL 查询取消是数据库原生命令能力，新增第三方库没有必要，且会增加 Electron 打包、离线安装和维护风险。

## 测试覆盖

- registry 记录 backend pid 后，取消决策从 `disconnect-connection` 转为 `cancel-backend`。
- query workflow 接收 driver backend pid 回调并写入 registry。
- cancel workflow 在 backend pid 已知时调用 driver cancel。
- PostgresDriver 调用 `pg_cancel_backend($1)` 并返回结构化结果。
- core-db 全量测试通过，desktop main 全量测试通过。

## 已知限制

- 当前未新增真实 PostgreSQL 集成取消测试；原因是本机门控 PostgreSQL 集成测试仍跳过。后续在可用测试库上应补 `pg_sleep` + `db:cancel-query` 的端到端验证。
- PostgreSQL 取消成功后，正在执行的查询通常会以数据库错误返回；后续可把 PostgreSQL cancel 错误进一步分类成 `QUERY_CANCELLED`。
